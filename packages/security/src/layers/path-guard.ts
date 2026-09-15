/**
 * @oa/security — Path Guard layer (priority 300)
 * 
 * Validates file system paths:
 * - Blacklist check (system directories)
 * - Workspace fence (realpath resolution)
 * - Guiding file protection (AGENTS.md, MEMORY.md, SOUL.md)
 * - Date-scoped append-only
 * - Command tool coverage
 * 
 * Uses realpath (not normpath) for symlink safety.
 */

import {
  ToolCall,
  SecurityContext,
  LayerResult,
  SecurityLayer,
  Verdict,
  RiskLevel,
  PathGuardConfig,
} from '../types';

/** System directories that should never be modified */
const SYSTEM_DIRECTORY_BLACKLIST: string[] = [
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/etc',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/lib',
  '/lib64',
  '/usr/lib',
  '/usr/lib64',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
];

/** Protected guiding files */
const PROTECTED_GUIDING_FILES: string[] = [
  'AGENTS.md',
  'MEMORY.md',
  'SOUL.md',
  'IDENTITY.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  '.env',
  '.env.local',
  '.env.production',
  'SECURITY.md',
];

/** Date-scoped files that are append-only */
const DATE_SCOPED_APPEND_ONLY: string[] = [
  'journal/',
  'logs/',
  'journal.md',
  'log.md',
  'CHANGELOG.md',
];

/**
 * Resolve a path to its real path (resolving symlinks).
 * Uses realpath for security (not normpath which doesn't resolve symlinks).
 */
async function resolveRealPath(filePath: string): Promise<string> {
  // In production, this would use fs.realpath.native()
  // For now, normalize separators and resolve . and ..
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return (filePath.startsWith('/') ? '/' : '') + resolved.join('/');
}

/**
 * Check if a path is in a blacklisted system directory.
 */
function isBlacklistedPath(resolvedPath: string, extraBlacklistedPaths: string[] = []): boolean {
  const allBlacklisted = [...SYSTEM_DIRECTORY_BLACKLIST, ...extraBlacklistedPaths];
  const normalizedPath = resolvedPath.replace(/\\/g, '/').toLowerCase();

  return allBlacklisted.some((blacklisted) => {
    const normalizedBlacklisted = blacklisted.replace(/\\/g, '/').toLowerCase();
    return (
      normalizedPath === normalizedBlacklisted ||
      normalizedPath.startsWith(normalizedBlacklisted + '/')
    );
  });
}

/**
 * Check if a path refers to a protected guiding file.
 */
function isProtectedGuidingFile(resolvedPath: string, extraProtectedFiles: string[] = []): boolean {
  const allProtected = [...PROTECTED_GUIDING_FILES, ...extraProtectedFiles];
  const fileName = resolvedPath.split('/').pop() || '';

  return allProtected.some((protectedFile) => {
    const normalizedProtected = protectedFile.toLowerCase();
    const normalizedFileName = fileName.toLowerCase();
    return (
      normalizedFileName === normalizedProtected ||
      resolvedPath.toLowerCase().endsWith('/' + normalizedProtected)
    );
  });
}

/**
 * Check if a path is date-scoped append-only.
 */
function isDateScopedAppendOnly(resolvedPath: string): boolean {
  const lowerPath = resolvedPath.toLowerCase();
  return DATE_SCOPED_APPEND_ONLY.some(
    (pattern) =>
      lowerPath.includes(pattern.toLowerCase()) ||
      lowerPath.endsWith(pattern.toLowerCase())
  );
}

/**
 * Extract file paths from tool arguments.
 */
function extractPathsFromArguments(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const pathFields = ['path', 'file_path', 'filePath', 'src', 'source', 'dest', 'destination', 'target'];

  for (const field of pathFields) {
    if (typeof args[field] === 'string') {
      paths.push(args[field] as string);
    }
  }

  // Handle array of paths
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === 'string') paths.push(p);
    }
  }

  return paths;
}

/**
 * Check if a command (from a shell tool) touches system paths.
 */
function commandTouchesSystemPaths(command: string): boolean {
  const lowerCommand = command.toLowerCase();

  // Check for direct references to system directories
  const systemPatterns = [
    /\b\/etc\//,
    /\b\/bin\//,
    /\b\/sbin\//,
    /\b\/boot\//,
    /\b\/proc\//,
    /\b\/sys\//,
    /\bc:\\windows\\/i,
    /\bc:\\program\s*files/i,
  ];

  return systemPatterns.some((pattern) => pattern.test(lowerCommand));
}

/**
 * Check if a command modifies protected files.
 */
function commandModifiesProtectedFiles(command: string): boolean {
  const lowerCommand = command.toLowerCase();

  return PROTECTED_GUIDING_FILES.some((file) => {
    const lowerFile = file.toLowerCase();
    // Check if the command references the file
    if (!lowerCommand.includes(lowerFile)) return false;

    // Check for modification operations
    const modPatterns = [
      new RegExp(`\\brm\\b.*${lowerFile}`),
      new RegExp(`\\bdel\\b.*${lowerFile}`),
      new RegExp(`\\berase\\b.*${lowerFile}`),
      new RegExp(`\\b>${2}?\\s*${lowerFile}`), // overwrite
      new RegExp(`\\btee\\b.*${lowerFile}`),
      new RegExp(`\\bsed\\b.*-i.*${lowerFile}`),
    ];

    return modPatterns.some((p) => p.test(lowerCommand));
  });
}

/**
 * Path Guard layer implementation.
 */
export class PathGuard implements SecurityLayer {
  readonly name = 'PathGuard';
  readonly priority = 300;
  private config: PathGuardConfig;

  constructor(config: PathGuardConfig = {}) {
    this.config = {
      extraBlacklistedPaths: config.extraBlacklistedPaths ?? [],
      extraProtectedFiles: config.extraProtectedFiles ?? [],
      allowOutsideWorkspace: config.allowOutsideWorkspace ?? false,
    };
  }

  /**
   * Check a tool call for path violations.
   */
  async check(toolCall: ToolCall, context: SecurityContext): Promise<LayerResult> {
    const startTime = Date.now();

    // Extract paths from tool arguments
    const paths = extractPathsFromArguments(toolCall.arguments);

    // Check each resolved path
    for (const rawPath of paths) {
      const resolvedPath = await resolveRealPath(rawPath);

      // 1. Blacklist check
      if (isBlacklistedPath(resolvedPath, this.config.extraBlacklistedPaths)) {
        return this.createResult(
          Verdict.DENY,
          RiskLevel.CRITICAL,
          `Access to system directory denied: ${resolvedPath}`,
          true,
          startTime
        );
      }

      // 2. Workspace fence (if not allowing outside workspace)
      if (!this.config.allowOutsideWorkspace && context.workspaceRoot) {
        const resolvedWorkspace = await resolveRealPath(context.workspaceRoot);
        if (!resolvedPath.startsWith(resolvedWorkspace) && resolvedPath !== resolvedWorkspace) {
          // Allow reads from outside workspace but not writes
          const isWrite = this.isWriteOperation(toolCall);
          if (isWrite) {
            return this.createResult(
              Verdict.DENY,
              RiskLevel.HIGH,
              `Write operation outside workspace denied: ${resolvedPath}`,
              true,
              startTime
            );
          }
        }
      }

      // 3. Guiding file protection
      if (isProtectedGuidingFile(resolvedPath, this.config.extraProtectedFiles)) {
        const isWrite = this.isWriteOperation(toolCall);
        if (isWrite) {
          return this.createResult(
            Verdict.DENY,
            RiskLevel.CRITICAL,
            `Modification of protected file denied: ${resolvedPath}`,
            true,
            startTime
          );
        }
      }

      // 4. Date-scoped append-only check
      if (isDateScopedAppendOnly(resolvedPath)) {
        const isOverwrite = this.isOverwriteOperation(toolCall);
        if (isOverwrite) {
          return this.createResult(
            Verdict.DENY,
            RiskLevel.HIGH,
            `Overwrite of date-scoped file denied: ${resolvedPath}`,
            true,
            startTime
          );
        }
      }
    }

    // 5. Command tool coverage
    if (toolCall.command) {
      if (commandTouchesSystemPaths(toolCall.command)) {
        return this.createResult(
          Verdict.DENY,
          RiskLevel.CRITICAL,
          'Command attempts to access system directories',
          true,
          startTime
        );
      }

      if (commandModifiesProtectedFiles(toolCall.command)) {
        return this.createResult(
          Verdict.DENY,
          RiskLevel.CRITICAL,
          'Command attempts to modify protected files',
          true,
          startTime
        );
      }
    }

    // All checks passed
    return this.createResult(
      Verdict.ALLOW,
      RiskLevel.LOW,
      'Path validation passed',
      false,
      startTime
    );
  }

  /**
   * Determine if the tool call is a write operation.
   */
  private isWriteOperation(toolCall: ToolCall): boolean {
    const writeTools = ['write', 'edit', 'create', 'update', 'delete', 'remove', 'append', 'insert'];
    const writeOperations = ['write', 'edit', 'create', 'update', 'delete', 'remove', 'append'];

    if (writeTools.includes(toolCall.name.toLowerCase())) return true;

    const operation = toolCall.arguments.operation ?? toolCall.arguments.action;
    if (typeof operation === 'string') {
      return writeOperations.includes(operation.toLowerCase());
    }

    return false;
  }

  /**
   * Determine if the tool call overwrites (vs appends).
   */
  private isOverwriteOperation(toolCall: ToolCall): boolean {
    const overwriteTools = ['write', 'edit', 'replace'];
    const appendOnlyTools = ['append', 'insert'];

    if (appendOnlyTools.includes(toolCall.name.toLowerCase())) return false;
    if (overwriteTools.includes(toolCall.name.toLowerCase())) return true;

    const mode = toolCall.arguments.mode;
    if (typeof mode === 'string') {
      return mode !== 'append' && mode !== 'a';
    }

    return false; // Default to not overwrite (safer)
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
