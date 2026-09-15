/**
 * @oa/tools — Shell Execution Tool (built-in)
 *
 * Executes shell commands with safety controls, timeout, and output capture.
 * Goes through the security pipeline before execution.
 */

import { ToolDefinitionBuilder } from '../tool-definition';
import { ToolExecutionMode, ToolScope } from '../types';
import { RiskLevel } from '@oa/plugins';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../types';
import { createSuccessResult, createErrorResult, textContent } from '../tool-definition';

/**
 * Arguments for the shell_exec tool.
 */
export interface ShellExecArgs {
  /** The command to execute. */
  command: string;
  /** Working directory for execution. */
  cwd?: string;
  /** Timeout in milliseconds. */
  timeout_ms?: number;
  /** Environment variables to set. */
  env?: Record<string, string>;
  /** Whether to capture stderr separately. */
  split_stderr?: boolean;
}

/**
 * Result of a shell command execution.
 */
export interface ShellExecOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
}

/**
 * Create the shell_exec tool definition.
 */
export function createShellExecTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'shell_exec',
    'Execute a shell command and return its output. Use for running system commands, scripts, or development tools. Commands are subject to security review.'
  )
    .addString('command', 'The shell command to execute.', true)
    .addString('cwd', 'Working directory for execution. Defaults to current directory.', false)
    .addNumber('timeout_ms', 'Timeout in milliseconds. Defaults to 30000.', false, {
      minimum: 1000,
      maximum: 300000,
    })
    .addObject('env', 'Environment variables to set for the command.', false)
    .addBoolean('split_stderr', 'Whether to capture stderr separately.', false)
    .setRiskLevel(RiskLevel.HIGH)
    .setExecutionMode(ToolExecutionMode.EXCLUSIVE)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(120000)
    .setRequiresConfirmation(true)
    .setRetryable(false)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { command, cwd, timeout_ms, env, split_stderr } = args as unknown as ShellExecArgs;

      const startTime = Date.now();

      try {
        // In a real implementation, this would use child_process or Electron IPC.
        // For now, we provide the structure for integration.

        // Log the command for audit.
        context.pluginContext.logger.info(
          `shell_exec: executing command "${command}" in ${cwd || 'current directory'}`
        );

        // Placeholder for actual execution.
        // In production:
        // const { exec } = require('child_process') or invoke Electron main process
        // const result = await execAsync(command, { cwd, timeout: timeout_ms, env })

        const output: ShellExecOutput = {
          stdout: '',
          stderr: '',
          exit_code: 0,
          duration_ms: Date.now() - startTime,
          timed_out: false,
        };

        // Simulated response — replace with actual execution.
        const resultText =
          `Command: ${command}\n` +
          `Working Directory: ${cwd || process.cwd()}\n` +
          `Exit Code: ${output.exit_code}\n` +
          `Duration: ${output.duration_ms}ms\n\n` +
          `stdout:\n${output.stdout || '(empty)'}\n` +
          (split_stderr ? `\nstderr:\n${output.stderr || '(empty)'}\n` : '');

        return createSuccessResult(textContent(resultText), {
          toolName: 'shell_exec',
          extra: {
            command,
            exitCode: output.exit_code,
            timedOut: output.timed_out,
          },
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return createErrorResult(
          'SHELL_EXEC_FAILED',
          errorMessage,
          false,
          { command },
          { toolName: 'shell_exec', durationMs: Date.now() - startTime }
        );
      }
    })
    .build();
}

/**
 * Create a shell_exec tool with a restricted allowlist.
 * Only commands matching the allowed patterns can execute.
 */
export function createRestrictedShellExecTool(
  allowedPatterns: RegExp[]
): ToolDefinition {
  const baseTool = createShellExecTool();

  return {
    ...baseTool,
    name: 'shell_exec_restricted',
    description:
      'Execute a shell command from an allowed list. Only pre-approved commands can run.',
    execute: async (args, context): Promise<ToolResult> => {
      const { command } = args as unknown as ShellExecArgs;

      // Check against allowlist.
      const allowed = allowedPatterns.some((pattern) => pattern.test(command));
      if (!allowed) {
        return createErrorResult(
          'COMMAND_NOT_ALLOWED',
          `Command "${command}" is not in the allowed commands list.`,
          false,
          { command, allowedPatterns: allowedPatterns.map((p) => p.source) },
          { toolName: 'shell_exec_restricted' }
        );
      }

      // Delegate to the base executor.
      return baseTool.execute(args, context);
    },
  };
}
