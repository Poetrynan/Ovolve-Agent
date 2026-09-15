/**
 * @oa/skills — 4-Layer Security Checker
 *
 * Scans skill bodies for security threats before import/execution.
 * Implements defense-in-depth with four layers:
 *
 * 1. Prompt Injection Detection:
 *    Looks for attempts to override system instructions, leak prompts,
 *    or manipulate the LLM's behavior.
 *
 * 2. XSS / Dangerous Markup:
 *    Detects HTML/script injection, dangerous URLs, and markup exploits.
 *
 * 3. Credential Scanning (warning only):
 *    Detects potential secrets, API keys, or tokens embedded in skill.
 *    This is a warning — not a block — because some skills legitimately
 *    document credential handling.
 *
 * 4. Attack / Ethical Content:
 *    Flags content promoting harmful activities, malware, or attacks.
 *
 * Plus:
 * - Trust Gate: OWN skills get lighter scanning; UNTRUSTED get maximum.
 * - Code Sample Exemption: Code blocks are exempt from XSS/markup checks.
 */

import type { SecurityScanResult, SecurityCheckResult, SecurityRule, TrustLevel } from './types';

// ---------------------------------------------------------------------------
// Layer 1: Prompt Injection Detection
// ---------------------------------------------------------------------------

const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; message: string; severity: 'warning' | 'critical' }> = [
  // Direct instruction override attempts
  { pattern: /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions?/i, message: 'Attempt to override previous instructions', severity: 'critical' },
  { pattern: /you\s+are\s+now\s+(?:a|an)\s+/i, message: 'Role-switching attempt', severity: 'critical' },
  { pattern: /new\s+persona|switch\s+(?:to|into)\s+(?:a\s+)?(?:new\s+)?(?:role|persona|mode)/i, message: 'Persona switching attempt', severity: 'critical' },
  { pattern: /system\s+(?:prompt|instruction|message)\s*(?::|is|overrid)/i, message: 'System prompt reference', severity: 'warning' },
  { pattern: /(?:reveal|show|print|output)\s+(?:your|the)\s+(?:system\s+)?prompt/i, message: 'Prompt extraction attempt', severity: 'critical' },
  { pattern: /DAN|jailbreak|do\s+anything\s+now/i, message: 'Known jailbreak pattern', severity: 'critical' },
  { pattern: /<\/(?:system|instruction|prompt)>/i, message: 'Closing tag injection', severity: 'critical' },
  { pattern: /\[\s*(?:SYSTEM|INSTRUCTION|PROMPT)\s*\]/i, message: 'System directive injection', severity: 'warning' },
  { pattern: /\{\{\s*(?:system|instruction|prompt)\s*\}\}/i, message: 'Template injection attempt', severity: 'warning' },
  { pattern: /___(?:SYSTEM|INSTRUCTION|PROMPT)___/i, message: 'Delimiter injection', severity: 'warning' },
  // Base64 / encoding tricks
  { pattern: /base64|decode\s+(?:this|the\s+following)/i, message: 'Potential encoded payload', severity: 'warning' },
];

// ---------------------------------------------------------------------------
// Layer 2: XSS / Dangerous Markup
// ---------------------------------------------------------------------------

const XSS_PATTERNS: Array<{ pattern: RegExp; message: string; severity: 'warning' | 'critical' }> = [
  { pattern: /<script[\s>]/i, message: 'Inline script tag', severity: 'critical' },
  { pattern: /javascript\s*:/i, message: 'JavaScript protocol URL', severity: 'critical' },
  { pattern: /on(?:error|load|click|mouseover|focus|blur|submit)\s*=/i, message: 'Event handler injection', severity: 'critical' },
  { pattern: /<iframe[\s>]/i, message: 'Iframe injection', severity: 'critical' },
  { pattern: /<object[\s>]/i, message: 'Object tag injection', severity: 'critical' },
  { pattern: /<embed[\s>]/i, message: 'Embed tag injection', severity: 'critical' },
  { pattern: /data\s*:\s*text\/html/i, message: 'Data URL with HTML', severity: 'warning' },
  { pattern: /expression\s*\(/i, message: 'CSS expression', severity: 'warning' },
  { pattern: /url\s*\(\s*['"]?\s*javascript/i, message: 'CSS JavaScript URL', severity: 'critical' },
  { pattern: /<svg[\s>][\s\S]*?(?:onload|onerror)/i, message: 'SVG with event handler', severity: 'critical' },
];

// ---------------------------------------------------------------------------
// Layer 3: Credential Scanning (warning only)
// ---------------------------------------------------------------------------

const CREDENTIAL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/i, message: 'Potential API key' },
  { pattern: /(?:secret[_-]?key|secretkey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/i, message: 'Potential secret key' },
  { pattern: /(?:access[_-]?token|accesstoken)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{20,}['"]?/i, message: 'Potential access token' },
  { pattern: /(?:private[_-]?key|privatekey)[\s\S]*?-----BEGIN/, message: 'Potential private key block' },
  { pattern: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/i, message: 'Potential bearer token' },
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i, message: 'Potential password' },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, message: 'PEM private key' },
  { pattern: /sk-[A-Za-z0-9]{48,}/, message: 'Potential secret key prefix (sk-...)' },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/, message: 'Potential GitHub token' },
  { pattern: /xox[abprs]-[A-Za-z0-9\-]+/, message: 'Potential Slack token' },
];

// ---------------------------------------------------------------------------
// Layer 4: Attack / Ethical Content
// ---------------------------------------------------------------------------

const ATTACK_PATTERNS: Array<{ pattern: RegExp; message: string; severity: 'warning' | 'critical' }> = [
  { pattern: /(?:rm\s+-rf\s+\/|format\s+[a-z]:|del\s+\/f\s+\/s)/i, message: 'Destructive command', severity: 'critical' },
  { pattern: /(?:drop\s+table|drop\s+database|truncate\s+table)\s/i, message: 'Destructive database command', severity: 'warning' },
  { pattern: /(?:exploit|payload|backdoor|rootkit|keylogger)/i, message: 'Attack tooling reference', severity: 'critical' },
  { pattern: /(?:sql\s+inject|xss|csrf|xxe|ssrf|command\s+inject)/i, message: 'Attack technique reference', severity: 'warning' },
  { pattern: /(?:\/etc\/passwd|\/etc\/shadow|\.\.\/|\.\.\\)/i, message: 'Path traversal attempt', severity: 'warning' },
  { pattern: /(?:wget\s+http|curl\s+.*\|\s*sh|curl\s+.*\|\s*bash)/i, message: 'Download-and-execute pattern', severity: 'critical' },
  { pattern: /(?:reverse\s+shell|bind\s+shell|netcat\s+-l)/i, message: 'Shell injection pattern', severity: 'critical' },
];

// ---------------------------------------------------------------------------
// Code sample extraction
// ---------------------------------------------------------------------------

/**
 * Extract code blocks from markdown content.
 * Returns the content with code blocks replaced by placeholders,
 * plus the extracted code for separate analysis.
 */
function extractCodeBlocks(content: string): { cleaned: string; codeBlocks: string[] } {
  const codeBlocks: string[] = [];

  // Fenced code blocks (```...```)
  const fencedRegex = /```[\s\S]*?```/g;
  let cleaned = content.replace(fencedRegex, (match) => {
    codeBlocks.push(match);
    return `[CODE_BLOCK_${codeBlocks.length - 1}]`;
  });

  // Indented code blocks (4+ spaces)
  const indentedRegex = /(?:^(?: {4}|\t).*$)+/gm;
  cleaned = cleaned.replace(indentedRegex, (match) => {
    codeBlocks.push(match);
    return `[CODE_BLOCK_${codeBlocks.length - 1}]`;
  });

  return { cleaned, codeBlocks };
}

// ---------------------------------------------------------------------------
// Security scan implementation
// ---------------------------------------------------------------------------

/**
 * Run all four security layers on a skill body.
 *
 * @param body The skill body content to scan.
 * @param trustLevel The trust level affecting scan intensity.
 * @param customRules Optional additional security rules.
 */
export function runSecurityScan(
  body: string,
  trustLevel: TrustLevel,
  customRules: SecurityRule[] = []
): SecurityScanResult {
  const startTime = Date.now();
  const checks: SecurityCheckResult[] = [];

  // Extract code blocks — these are exempt from XSS checks
  const { cleaned, codeBlocks } = extractCodeBlocks(body);

  // Layer 1: Prompt Injection (always checked)
  checks.push(checkPromptInjection(cleaned, codeBlocks, trustLevel));

  // Layer 2: XSS / Dangerous Markup (skip for OWN trust)
  if (trustLevel !== TrustLevel.OWN) {
    checks.push(checkXss(cleaned, trustLevel));
  }

  // Layer 3: Credential Scanning (warning only, all levels)
  checks.push(checkCredentials(body)); // Scan full body including code

  // Layer 4: Attack / Ethical Content (always checked)
  checks.push(checkAttackContent(cleaned, codeBlocks, trustLevel));

  // Custom rules
  for (const rule of customRules) {
    checks.push(checkCustomRule(cleaned, rule));
  }

  // Determine overall result
  const criticalFailures = checks.filter(
    (c) => !c.passed && c.severity === 'critical'
  );
  const passed = criticalFailures.length === 0;

  // Determine highest severity
  let highestSeverity: 'info' | 'warning' | 'critical' = 'info';
  for (const check of checks) {
    if (!check.passed) {
      if (check.severity === 'critical') {
        highestSeverity = 'critical';
        break;
      }
      if (check.severity === 'warning' && highestSeverity !== 'critical') {
        highestSeverity = 'warning';
      }
    }
  }

  return {
    passed,
    checks,
    highestSeverity,
    scannedAt: Date.now(),
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Layer implementations
// ---------------------------------------------------------------------------

function checkPromptInjection(
  cleanedContent: string,
  codeBlocks: string[],
  trustLevel: TrustLevel
): SecurityCheckResult {
  const matches: string[] = [];

  // Check cleaned content (non-code)
  for (const { pattern, message } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(cleanedContent)) {
      matches.push(message);
    }
  }

  // For non-OWN trust, also check code blocks for injection
  if (trustLevel !== TrustLevel.OWN) {
    for (const block of codeBlocks) {
      for (const { pattern, message } of PROMPT_INJECTION_PATTERNS) {
        if (pattern.test(block)) {
          matches.push(`In code: ${message}`);
        }
      }
    }
  }

  // Filter: OWN trust level only flags critical patterns
  const effectiveMatches = trustLevel === TrustLevel.OWN
    ? matches.filter((_, i) => PROMPT_INJECTION_PATTERNS[i]?.severity === 'critical')
    : matches;

  return {
    name: 'Prompt Injection Detection',
    passed: trustLevel === TrustLevel.OWN ? !matches.some((_, i) =>
      PROMPT_INJECTION_PATTERNS[i]?.severity === 'critical'
    ) : matches.length === 0,
    severity: matches.length > 0 ? 'critical' : 'info',
    message: matches.length > 0
      ? `Found ${matches.length} potential prompt injection pattern(s)`
      : 'No prompt injection patterns detected',
    details: matches.length > 0 ? Array.from(new Set(matches)) : undefined,
  };
}

function checkXss(cleanedContent: string, trustLevel: TrustLevel): SecurityCheckResult {
  const matches: string[] = [];

  for (const { pattern, message } of XSS_PATTERNS) {
    if (pattern.test(cleanedContent)) {
      matches.push(message);
    }
  }

  // UNTRUSTED: flag even warnings as failures
  // COMMUNITY: only flag critical as failures
  const failed = trustLevel === TrustLevel.UNTRUSTED
    ? matches.length > 0
    : matches.some((_, i) => XSS_PATTERNS[i]?.severity === 'critical');

  return {
    name: 'XSS / Dangerous Markup',
    passed: !failed,
    severity: failed ? (trustLevel === TrustLevel.UNTRUSTED ? 'critical' : 'warning') : 'info',
    message: matches.length > 0
      ? `Found ${matches.length} potential XSS/markup pattern(s)`
      : 'No dangerous markup detected',
    details: matches.length > 0 ? Array.from(new Set(matches)) : undefined,
  };
}

function checkCredentials(body: string): SecurityCheckResult {
  const matches: string[] = [];

  for (const { pattern, message } of CREDENTIAL_PATTERNS) {
    if (pattern.test(body)) {
      matches.push(message);
    }
  }

  return {
    name: 'Credential Scanning',
    passed: true, // Always passes — this is a warning only
    severity: matches.length > 0 ? 'warning' : 'info',
    message: matches.length > 0
      ? `Warning: Found ${matches.length} potential credential pattern(s) (review recommended)`
      : 'No credential patterns detected',
    details: matches.length > 0 ? Array.from(new Set(matches)) : undefined,
  };
}

function checkAttackContent(
  cleanedContent: string,
  codeBlocks: string[],
  trustLevel: TrustLevel
): SecurityCheckResult {
  const matches: string[] = [];

  // Check cleaned content
  for (const { pattern, message } of ATTACK_PATTERNS) {
    if (pattern.test(cleanedContent)) {
      matches.push(message);
    }
  }

  // For UNTRUSTED, also check code blocks
  if (trustLevel === TrustLevel.UNTRUSTED) {
    for (const block of codeBlocks) {
      for (const { pattern, message } of ATTACK_PATTERNS) {
        if (pattern.test(block)) {
          matches.push(`In code: ${message}`);
        }
      }
    }
  }

  const criticalMatches = matches.filter((_, i) =>
    ATTACK_PATTERNS[i]?.severity === 'critical'
  );

  return {
    name: 'Attack / Ethical Content',
    passed: criticalMatches.length === 0,
    severity: criticalMatches.length > 0 ? 'critical' : (matches.length > 0 ? 'warning' : 'info'),
    message: matches.length > 0
      ? `Found ${matches.length} potential attack/ethical concern(s)`
      : 'No attack content detected',
    details: matches.length > 0 ? Array.from(new Set(matches)) : undefined,
  };
}

function checkCustomRule(content: string, rule: SecurityRule): SecurityCheckResult {
  const matches: string[] = [];
  const regex = new RegExp(rule.pattern);
  if (regex.test(content)) {
    matches.push(rule.message);
  }

  return {
    name: `Custom: ${rule.name}`,
    passed: rule.severity === 'critical' ? matches.length === 0 : true,
    severity: matches.length > 0 ? rule.severity : 'info',
    message: matches.length > 0
      ? `Custom rule "${rule.name}" matched`
      : `Custom rule "${rule.name}" passed`,
    details: matches.length > 0 ? matches : undefined,
  };
}

// ---------------------------------------------------------------------------
// Trust gate
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a skill passes the trust gate.
 *
 * The trust gate enforces different acceptance criteria based on trust level:
 * - OWN: Only critical failures are blocking.
 * - COMMUNITY: Critical and warning failures are blocking.
 * - UNTRUSTED: Any finding (including info) requires user approval.
 *
 * @param scanResult The security scan result.
 * @param trustLevel The skill's trust level.
 */
export function evaluateTrustGate(
  scanResult: SecurityScanResult,
  trustLevel: TrustLevel
): { allowed: boolean; reason: string; requiresApproval: boolean } {
  const failedChecks = scanResult.checks.filter((c) => !c.passed);

  switch (trustLevel) {
    case TrustLevel.OWN: {
      const critical = failedChecks.filter((c) => c.severity === 'critical');
      if (critical.length > 0) {
        return {
          allowed: false,
          reason: `OWN skill failed critical checks: ${critical.map((c) => c.name).join(', ')}`,
          requiresApproval: false,
        };
      }
      return { allowed: true, reason: 'OWN skill passed all critical checks', requiresApproval: false };
    }

    case TrustLevel.COMMUNITY: {
      if (failedChecks.length > 0) {
        return {
          allowed: false,
          reason: `COMMUNITY skill failed checks: ${failedChecks.map((c) => c.name).join(', ')}`,
          requiresApproval: false,
        };
      }
      return { allowed: true, reason: 'COMMUNITY skill passed all checks', requiresApproval: false };
    }

    case TrustLevel.UNTRUSTED: {
      // Any finding requires explicit user approval
      if (scanResult.checks.some((c) => c.details && c.details.length > 0)) {
        return {
          allowed: false,
          reason: 'UNTRUSTED skill has findings — requires user approval',
          requiresApproval: true,
        };
      }
      return { allowed: true, reason: 'UNTRUSTED skill passed all checks', requiresApproval: false };
    }

    default:
      return { allowed: false, reason: 'Unknown trust level', requiresApproval: true };
  }
}
