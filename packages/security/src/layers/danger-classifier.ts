/**
 * @oa/security — Danger Classifier layer (cross-interpreter)
 * 
 * Classifies commands across 6 interpreter tables:
 * - POSIX (bash/sh/zsh)
 * - PowerShell
 * - CMD (Windows batch)
 * - Python
 * - JavaScript (Node.js)
 * - SQL
 * 
 * Features:
 * - 3 verdict levels (deny, confirm, allow)
 * - Wrapper stripping (sudo, env, nohup, etc.)
 * - Root-gated escalation
 * - Denial cache (5min TTL)
 */

import {
  ToolCall,
  SecurityContext,
  LayerResult,
  SecurityLayer,
  Verdict,
  RiskLevel,
  InterpreterType,
  ClassifierRule,
  DangerClassifierConfig,
} from '../types';

/** Wrapper prefixes that should be stripped before analysis */
const WRAPPER_PREFIXES = [
  'sudo',
  'env',
  'nohup',
  'nice',
  'ionice',
  'timeout',
  'time',
  'watch',
  'xargs',
  'parallel',
  'find', // find ... -exec
  'awk',  // awk ... | sh
  'perl', // perl -e
  'ruby', // ruby -e
  'python', // python -c
  'node',  // node -e
  'deno',  // deno run
  'bun',   // bun run
];

/** POSIX dangerous commands */
const POSIX_RULES: ClassifierRule[] = [
  { pattern: '\\brm\\s+(-[rfRF]+\\s+)?(/|\\$)', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Recursive deletion at root' },
  { pattern: '\\brm\\s+.*\\s+/dev/', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Deletion of device files' },
  { pattern: '\\bmkfs\\.', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Filesystem formatting' },
  { pattern: '\\bdd\\s+if=', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Direct disk writing' },
  { pattern: ':(){ :|:& };:', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Fork bomb' },
  { pattern: '\\bchmod\\s+(-[R+-]+\\s+)?777', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Overly permissive chmod' },
  { pattern: '\\bchown\\s+-R\\s+root', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Recursive root ownership change' },
  { pattern: '\\bsudo\\s+.*\\brm\\b', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Sudo deletion' },
  { pattern: '\\bcurl\\s+.*\\|\\s*sh', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Remote code execution via pipe' },
  { pattern: '\\bwget\\s+.*\\|\\s*sh', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Remote code execution via pipe' },
  { pattern: '\\bnc\\s+-[lve]', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Netcat listener/backdoor' },
  { pattern: '\\bnohup\\s+.*&', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'Background persistence' },
  { pattern: '\\bsystemctl\\s+(stop|disable)\\s+', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'System service manipulation' },
  { pattern: '\\biptables\\s+-F', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Firewall flush' },
  { pattern: '\\bcrontab\\s+-[er]', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Cron manipulation' },
  { pattern: '\\bpasswd\\b', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Password change' },
  { pattern: '\\buseradd\\b|\\buserdel\\b', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'User management' },
  { pattern: '\\bvisudo\\b', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Sudoers modification' },
  { pattern: '\\bshutdown\\b|\\breboot\\b', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'System shutdown/reboot' },
  { pattern: '\\bmount\\b|\\bumount\\b', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'Mount operations' },
];

/** PowerShell dangerous commands */
const POWERSHELL_RULES: ClassifierRule[] = [
  { pattern: 'Remove-Item\\s+.*-Recurse\\s+.*-Force', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Forced recursive deletion' },
  { pattern: 'Invoke-Expression', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Expression evaluation (IEX)' },
  { pattern: 'DownloadString|DownloadFile', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Remote download' },
  { pattern: 'Start-Process\\s+.*-Verb\\s+RunAs', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'UAC elevation' },
  { pattern: 'Set-ExecutionPolicy', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Execution policy bypass' },
  { pattern: 'New-ScheduledTask', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Scheduled task creation' },
  { pattern: 'Net.WebClient', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Web client usage' },
  { pattern: 'FromBase64String', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Base64 decoding (potential obfuscation)' },
  { pattern: 'Reflection.Assembly', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Assembly loading' },
  { pattern: 'System.Net.Sockets', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Raw socket access' },
];

/** CMD (Windows batch) dangerous commands */
const CMD_RULES: ClassifierRule[] = [
  { pattern: 'del\\s+/[fq]\\s+.*\\\\Windows', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Windows directory deletion' },
  { pattern: 'rd\\s+/[sq]\\s+.*\\\\', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Recursive directory removal' },
  { pattern: 'format\\s+[a-zA-Z]:', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Drive formatting' },
  { pattern: 'reg\\s+(delete|add)\\s+', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Registry modification' },
  { pattern: 'net\\s+user\\s+.*\\s+/add', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'User creation' },
  { pattern: 'net\\s+localgroup\\s+administrators', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Admin group modification' },
  { pattern: 'schtasks\\s+/create', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Scheduled task creation' },
  { pattern: 'sc\\s+(create|delete|config)', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Service control' },
  { pattern: 'powershell\\s+-[eE][nN][cC]', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Encoded PowerShell command' },
  { pattern: 'bitsadmin\\s+/transfer', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'BITS transfer' },
];

/** Python dangerous patterns */
const PYTHON_RULES: ClassifierRule[] = [
  { pattern: 'os\\.system\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'OS command execution' },
  { pattern: 'subprocess\\.(call|run|Popen)\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Subprocess execution' },
  { pattern: 'eval\\s*\\(', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Code evaluation' },
  { pattern: 'exec\\s*\\(', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Code execution' },
  { pattern: '__import__\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'Dynamic import' },
  { pattern: 'compile\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'Code compilation' },
  { pattern: 'ctypes\\.windll|ctypes\\.cdll', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Native library loading' },
  { pattern: 'socket\\.socket\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'Socket creation' },
  { pattern: 'shutil\\.rmtree\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Recursive tree removal' },
  { pattern: 'os\\.remove\\s*\\(|os\\.unlink\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'File deletion' },
];

/** JavaScript (Node.js) dangerous patterns */
const JAVASCRIPT_RULES: ClassifierRule[] = [
  { pattern: 'child_process', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Child process module' },
  { pattern: 'exec\\s*\\(|execSync\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Command execution' },
  { pattern: 'eval\\s*\\(', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Code evaluation' },
  { pattern: 'Function\\s*\\(\\s*["\']return', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Dynamic function construction' },
  { pattern: 'require\\s*\\(\s*["\']child_process', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Child process require' },
  { pattern: 'fs\\.(unlink|rm|rmdir|writeFile)', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'File system modification' },
  { pattern: 'process\\.binding', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Process binding access' },
  { pattern: 'vm\\.runInNewContext', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'VM context execution' },
  { pattern: 'Worker\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.MEDIUM, description: 'Worker thread creation' },
];

/** SQL dangerous patterns */
const SQL_RULES: ClassifierRule[] = [
  { pattern: 'DROP\\s+(TABLE|DATABASE|SCHEMA)', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Database/table deletion' },
  { pattern: 'DELETE\\s+FROM\\s+.*WHERE\\s+1\\s*=\\s*1', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'Unconditional deletion' },
  { pattern: 'TRUNCATE\\s+TABLE', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Table truncation' },
  { pattern: 'ALTER\\s+TABLE.*DROP', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Column drop' },
  { pattern: 'GRANT\\s+ALL', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Privilege grant' },
  { pattern: 'REVOKE\\s+ALL', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Privilege revocation' },
  { pattern: 'INTO\\s+OUTFILE', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'File write via SQL' },
  { pattern: 'LOAD_FILE\\s*\\(', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'File read via SQL' },
  { pattern: 'xp_cmdshell', verdict: Verdict.DENY, riskLevel: RiskLevel.CRITICAL, description: 'SQL Server command shell' },
  { pattern: 'BULK\\s+INSERT', verdict: Verdict.CONFIRM, riskLevel: RiskLevel.HIGH, description: 'Bulk data insertion' },
];

/** Map of interpreter types to their rules */
const INTERPRETER_RULES: Record<InterpreterType, ClassifierRule[]> = {
  [InterpreterType.POSIX]: POSIX_RULES,
  [InterpreterType.POWERSHELL]: POWERSHELL_RULES,
  [InterpreterType.CMD]: CMD_RULES,
  [InterpreterType.PYTHON]: PYTHON_RULES,
  [InterpreterType.JAVASCRIPT]: JAVASCRIPT_RULES,
  [InterpreterType.SQL]: SQL_RULES,
};

/** Denial cache entry */
interface DenialCacheEntry {
  verdict: Verdict;
  reason: string;
  expiresAt: number;
}

/**
 * Danger Classifier layer implementation.
 */
export class DangerClassifier implements SecurityLayer {
  readonly name = 'DangerClassifier';
  readonly priority = 250;
  private config: DangerClassifierConfig;
  private denialCache: Map<string, DenialCacheEntry> = new Map();

  constructor(config: DangerClassifierConfig = {}) {
    this.config = {
      allowRootEscalation: config.allowRootEscalation ?? false,
      customRules: config.customRules ?? {},
      denialCacheTtlMs: config.denialCacheTtlMs ?? 5 * 60 * 1000, // 5 minutes
    };
  }

  /**
   * Check a tool call for dangerous patterns.
   */
  async check(toolCall: ToolCall, context: SecurityContext): Promise<LayerResult> {
    const startTime = Date.now();

    // Get the command to analyze
    const command = toolCall.command ?? this.buildCommandFromArgs(toolCall);
    if (!command) {
      return this.createResult(Verdict.ALLOW, RiskLevel.LOW, 'No command to classify', false, startTime);
    }

    // Check denial cache
    const cacheKey = this.hashCommand(command);
    const cached = this.denialCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return this.createResult(
        cached.verified,
        cached.verified === Verdict.DENY ? RiskLevel.CRITICAL : RiskLevel.HIGH,
        `[Cached] ${cached.reason}`,
        cached.verified === Verdict.DENY,
        startTime
      );
    }

    // Strip wrapper prefixes
    const strippedCommand = this.stripWrappers(command);

    // Detect interpreter type
    const interpreter = this.detectInterpreter(toolCall, strippedCommand);

    // Get rules for this interpreter
    const rules = [
      ...INTERPRETER_RULES[interpreter],
      ...(this.config.customRules[interpreter] ?? []),
    ];

    // Check each rule
    for (const rule of rules) {
      const regex = new RegExp(rule.pattern, 'i');
      if (regex.test(strippedCommand)) {
        // Root-gated escalation check
        if (rule.riskLevel === RiskLevel.CRITICAL && context.isRoot && !this.config.allowRootEscalation) {
          const result = this.createResult(
            Verdict.DENY,
            RiskLevel.CRITICAL,
            `Root escalation blocked: ${rule.description}`,
            true,
            startTime
          );
          this.cacheDenial(cacheKey, result);
          return result;
        }

        const result = this.createResult(
          rule.verified,
          rule.riskLevel,
          rule.description,
          rule.verified === Verdict.DENY,
          startTime
        );

        if (rule.verified === Verdict.DENY) {
          this.cacheDenial(cacheKey, result);
        }

        return result;
      }
    }

    // No rules matched — allow
    return this.createResult(Verdict.ALLOW, RiskLevel.LOW, 'No dangerous patterns detected', false, startTime);
  }

  /**
   * Strip wrapper prefixes from a command.
   */
  private stripWrappers(command: string): string {
    let stripped = command.trim();

    let changed = true;
    while (changed) {
      changed = false;
      for (const wrapper of WRAPPER_PREFIXES) {
        const regex = new RegExp(`^${wrapper}\\s+`, 'i');
        if (regex.test(stripped)) {
          stripped = stripped.replace(regex, '');
          changed = true;
        }
      }
    }

    return stripped.trim();
  }

  /**
   * Detect the interpreter type for a command.
   */
  private detectInterpreter(toolCall: ToolCall, command: string): InterpreterType {
    const toolName = toolCall.name.toLowerCase();
    const cmdLower = command.toLowerCase();

    // Check tool name hints
    if (toolName.includes('powershell') || toolName.includes('ps1')) {
      return InterpreterType.POWERSHELL;
    }
    if (toolName.includes('cmd') || toolName.includes('batch')) {
      return InterpreterType.CMD;
    }
    if (toolName.includes('python') || toolName.includes('py')) {
      return InterpreterType.PYTHON;
    }
    if (toolName.includes('node') || toolName.includes('js') || toolName.includes('javascript')) {
      return InterpreterType.JAVASCRIPT;
    }
    if (toolName.includes('sql') || toolName.includes('database') || toolName.includes('db')) {
      return InterpreterType.SQL;
    }

    // Check command content hints
    if (cmdLower.startsWith('powershell ') || cmdLower.includes('get-') || cmdLower.includes('set-')) {
      return InterpreterType.POWERSHELL;
    }
    if (cmdLower.includes('reg ') || cmdLower.includes('schtasks ') || cmdLower.includes('net ')) {
      return InterpreterType.CMD;
    }
    if (cmdLower.includes('import ') && (cmdLower.includes('os') || cmdLower.includes('subprocess'))) {
      return InterpreterType.PYTHON;
    }
    if (cmdLower.includes('require(') || cmdLower.includes('console.log')) {
      return InterpreterType.JAVASCRIPT;
    }
    if (cmdLower.includes('select ') || cmdLower.includes('insert ') || cmdLower.includes('update ')) {
      return InterpreterType.SQL;
    }

    // Default to POSIX
    return InterpreterType.POSIX;
  }

  /**
   * Build a command string from tool arguments.
   */
  private buildCommandFromArgs(toolCall: ToolCall): string | null {
    if (toolCall.command) return toolCall.command;

    const args = toolCall.arguments;
    if (typeof args.command === 'string') return args.command;
    if (typeof args.cmd === 'string') return args.cmd;
    if (typeof args.script === 'string') return args.script;

    return null;
  }

  /**
   * Hash a command for cache lookup.
   */
  private hashCommand(command: string): string {
    let hash = 0;
    for (let i = 0; i < command.length; i++) {
      const char = command.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return hash.toString(16);
  }

  /**
   * Cache a denial result.
   */
  private cacheDenial(cacheKey: string, result: LayerResult): void {
    this.denialCache.set(cacheKey, {
      verdict: result.verified,
      reason: result.reason,
      expiresAt: Date.now() + (this.config.denialCacheTtlMs ?? 5 * 60 * 1000),
    });

    // Clean up expired entries periodically
    if (this.denialCache.size > 1000) {
      this.cleanupCache();
    }
  }

  /**
   * Clean up expired cache entries.
   */
  private cleanupCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.denialCache) {
      if (entry.expiresAt <= now) {
        this.denialCache.delete(key);
      }
    }
  }

  /**
   * Create a layer result.
   */
  private createResult(
    verdict: Verdict,
    riskLevel: RiskLevel,
    reason: string,
    blocked: boolean,
    startTime: number
  ): LayerResult {
    return {
      name: this.name,
      priority: this.priority,
      verdict,
      riskLevel,
      reason,
      blocked,
      elapsedMs: Date.now() - startTime,
    };
  }
}
