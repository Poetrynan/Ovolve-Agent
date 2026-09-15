/**
 * @oa/hooks — External script execution
 *
 * Executes hook scripts as external processes with:
 * - Template variable expansion (${OVOLVE_PROJECT_DIR}, etc.)
 * - Exit code protocol: 0=pass, 2=block, other=error
 * - Output validation (JSON with recognized keys)
 * - Timeout enforcement (default 60s)
 * - Max output bytes (default 64KB)
 */

import { spawn } from 'child_process';
import type { HookScript, HookContext, HookResult, HookOutput } from './types.js';

/** Default timeout in milliseconds */
const DEFAULT_TIMEOUT = 60000;

/** Default max output bytes (64KB) */
const DEFAULT_MAX_OUTPUT_BYTES = 65536;

/** Template variable pattern: ${VAR_NAME} or $VAR_NAME */
const TEMPLATE_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;

/**
 * Expand template variables in a string.
 * Supported variables:
 * - ${PROJECT_DIR} — Project directory
 * - ${HOME_DIR} — User home directory
 * - ${SESSION_ID} — Current session ID
 * - ${TIMESTAMP} — Current timestamp
 * - ${EVENT} — Current event name
 * - Any environment variable
 */
export function expandTemplates(
  input: string,
  context: HookContext,
  env?: Record<string, string>,
): string {
  return input.replace(TEMPLATE_PATTERN, (match, braced, unbraced) => {
    const varName = braced || unbraced;

    // Built-in variables
    switch (varName) {
      case 'PROJECT_DIR':
        return context.projectDir;
      case 'HOME_DIR':
        return context.homeDir;
      case 'SESSION_ID':
        return context.sessionId ?? '';
      case 'TIMESTAMP':
        return String(context.timestamp);
      case 'EVENT':
        return context.event;
    }

    // Custom env vars from hook config
    if (env && varName in env) {
      return env[varName];
    }

    // System environment variables
    return process.env[varName] ?? match;
  });
}

/**
 * Expand templates in all string fields of a hook script.
 */
export function expandScriptTemplates(
  script: HookScript,
  context: HookContext,
): HookScript {
  const expanded: HookScript = {
    command: expandTemplates(script.command, context, script.env),
  };

  if (script.args) {
    expanded.args = script.args.map((arg) => expandTemplates(arg, context, script.env));
  }

  if (script.env) {
    expanded.env = {};
    for (const [key, value] of Object.entries(script.env)) {
      expanded.env[key] = expandTemplates(value, context);
    }
  }

  if (script.cwd) {
    expanded.cwd = expandTemplates(script.cwd, context, script.env);
  }

  if (script.timeout !== undefined) {
    expanded.timeout = script.timeout;
  }

  if (script.maxOutputBytes !== undefined) {
    expanded.maxOutputBytes = script.maxOutputBytes;
  }

  if (script.enabled !== undefined) {
    expanded.enabled = script.enabled;
  }

  return expanded;
}

/**
 * Execute a single hook script.
 *
 * Exit code protocol:
 * - 0: Pass (hook succeeded, continue)
 * - 2: Block (hook wants to block the operation)
 * - Other: Error (hook failed, log but continue)
 */
export async function executeHookScript(
  script: HookScript,
  context: HookContext,
): Promise<HookResult> {
  const startTime = Date.now();

  // Expand template variables
  const expandedScript = expandScriptTemplates(script, context);

  const timeout = expandedScript.timeout ?? DEFAULT_TIMEOUT;
  const maxOutputBytes = expandedScript.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<HookResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    let timedOut = false;

    const child = spawn(expandedScript.command, expandedScript.args ?? [], {
      env: { ...process.env as Record<string, string>, ...expandedScript.env },
      cwd: expandedScript.cwd ?? context.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send context as JSON via stdin
    const contextJson = JSON.stringify(context);
    child.stdin.write(contextJson);
    child.stdin.end();

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill('SIGTERM');

      // Force kill after 5 seconds
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 5000);
    }, timeout);

    // Collect stdout with byte limit
    child.stdout.on('data', (data: Buffer) => {
      const remaining = maxOutputBytes - stdoutBytes;
      if (remaining <= 0) return;

      const chunk = data.slice(0, remaining);
      stdout += chunk.toString('utf-8');
      stdoutBytes += chunk.length;
    });

    // Collect stderr with byte limit
    child.stderr.on('data', (data: Buffer) => {
      const remaining = maxOutputBytes - stderrBytes;
      if (remaining <= 0) return;

      const chunk = data.slice(0, remaining);
      stderr += chunk.toString('utf-8');
      stderrBytes += chunk.length;
    });

    child.on('close', (exitCode: number | null) => {
      clearTimeout(timeoutHandle);
      const duration = Date.now() - startTime;

      const code = exitCode ?? -1;
      const passed = code === 0;
      const blocked = code === 2;

      // Parse JSON output from stdout
      let output: HookOutput | undefined;
      if (stdout.trim()) {
        output = parseHookOutput(stdout.trim());
      }

      const result: HookResult = {
        script,
        exitCode: code,
        passed,
        blocked,
        output,
        stdout: stdout.slice(0, 8192), // Cap stored output
        stderr: stderr.slice(0, 8192),
        duration,
      };

      if (timedOut) {
        result.error = `Hook timed out after ${timeout}ms`;
        result.exitCode = -1;
        result.passed = false;
        result.blocked = false;
      } else if (code !== 0 && code !== 2) {
        result.error = `Hook exited with code ${code}`;
      }

      resolve(result);
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutHandle);
      const duration = Date.now() - startTime;

      resolve({
        script,
        exitCode: -1,
        passed: false,
        blocked: false,
        stdout: stdout.slice(0, 8192),
        stderr: stderr.slice(0, 8192),
        duration,
        error: `Failed to execute hook: ${err.message}`,
      });
    });
  });
}

/**
 * Parse and validate hook output from stdout.
 * Expects JSON with recognized keys.
 */
export function parseHookOutput(stdout: string): HookOutput | undefined {
  // Try to find JSON in the output (may be mixed with other text)
  const jsonStart = stdout.indexOf('{');
  const jsonEnd = stdout.lastIndexOf('}');

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return undefined;
  }

  const jsonStr = stdout.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    // Validate and construct HookOutput
    const output: HookOutput = {};

    if (typeof parsed.continue === 'boolean') output.continue = parsed.continue;
    if (typeof parsed.suppress === 'boolean') output.suppress = parsed.suppress;
    if (typeof parsed.block === 'boolean') output.block = parsed.block;
    if (typeof parsed.blockReason === 'string') output.blockReason = parsed.blockReason;
    if (typeof parsed.overridePrompt === 'string') output.overridePrompt = parsed.overridePrompt;
    if (typeof parsed.overrideSystemPrompt === 'string') output.overrideSystemPrompt = parsed.overrideSystemPrompt;
    if (typeof parsed.additionalContext === 'string') output.additionalContext = parsed.additionalContext;
    if (typeof parsed.suppressToolOutput === 'boolean') output.suppressToolOutput = parsed.suppressToolOutput;
    if (typeof parsed.suppressMessage === 'boolean') output.suppressMessage = parsed.suppressMessage;
    if (typeof parsed.userMessage === 'string') output.userMessage = parsed.userMessage;
    if (typeof parsed.systemMessage === 'string') output.systemMessage = parsed.systemMessage;
    if (typeof parsed.decisionReason === 'string') output.decisionReason = parsed.decisionReason;

    // Preserve any additional keys
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in output)) {
        output[key] = value;
      }
    }

    return output;
  } catch {
    return undefined;
  }
}

/**
 * Validate hook output against the expected schema.
 * Returns an array of validation errors (empty if valid).
 */
export function validateHookOutput(output: HookOutput): string[] {
  const errors: string[] = [];

  if (output.overridePrompt !== undefined && typeof output.overridePrompt !== 'string') {
    errors.push('overridePrompt must be a string');
  }

  if (output.overrideSystemPrompt !== undefined && typeof output.overrideSystemPrompt !== 'string') {
    errors.push('overrideSystemPrompt must be a string');
  }

  if (output.blockReason !== undefined && typeof output.blockReason !== 'string') {
    errors.push('blockReason must be a string');
  }

  if (output.additionalContext !== undefined && typeof output.additionalContext !== 'string') {
    errors.push('additionalContext must be a string');
  }

  if (output.userMessage !== undefined && typeof output.userMessage !== 'string') {
    errors.push('userMessage must be a string');
  }

  if (output.systemMessage !== undefined && typeof output.systemMessage !== 'string') {
    errors.push('systemMessage must be a string');
  }

  return errors;
}

/**
 * Execute multiple hook scripts sequentially.
 * Stops early if any hook blocks.
 */
export async function executeHookScripts(
  scripts: HookScript[],
  context: HookContext,
): Promise<HookResult[]> {
  const results: HookResult[] = [];

  for (const script of scripts) {
    if (script.enabled === false) continue;

    const result = await executeHookScript(script, context);
    results.push(result);

    // Stop on block
    if (result.blocked) {
      break;
    }
  }

  return results;
}
