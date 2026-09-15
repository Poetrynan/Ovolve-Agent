/**
 * @oa/tools — Ask User Tool (built-in)
 *
 * Adapted from the Ovolve pattern. Prompts the user for input
 * during agent execution. Supports free text and multiple choice.
 */

import { ToolDefinitionBuilder } from '../tool-definition';
import { ToolExecutionMode, ToolScope } from '../types';
import { RiskLevel } from '@oa/plugins';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../types';
import { createSuccessResult, createErrorResult, textContent } from '../tool-definition';

/**
 * Arguments for the ask_user tool.
 */
export interface AskUserArgs {
  /** The question to ask the user. */
  question: string;
  /** Optional default value. */
  default_value?: string;
  /** Optional choices for multiple choice. */
  choices?: string[];
  /** Whether a response is required. */
  required?: boolean;
}

/**
 * Create the ask_user tool definition.
 */
export function createAskUserTool(): ToolDefinition {
  return new ToolDefinitionBuilder(
    'ask_user',
    'Ask the user a question and wait for their response. Use when you need clarification, confirmation, or additional information from the user.'
  )
    .addString('question', 'The question to ask the user.', true)
    .addString('default_value', 'Optional default value for the response.', false)
    .addArray(
      'choices',
      'Optional list of choices for multiple choice.',
      false,
      { type: 'string', description: 'A choice option.' }
    )
    .addBoolean('required', 'Whether a response is required.', false)
    .setRiskLevel(RiskLevel.LOW)
    .setExecutionMode(ToolExecutionMode.EXCLUSIVE)
    .setScope(ToolScope.GLOBAL)
    .setTimeout(300000) // 5 minute timeout for user response.
    .setRequiresConfirmation(false)
    .setExecutor(async (args, context): Promise<ToolResult> => {
      const { question, default_value, choices, required } = args as unknown as AskUserArgs;

      try {
        const response = await context.services.askUser(question, {
          question,
          defaultValue: default_value,
          choices,
          required: required ?? true,
        });

        if (!response && required) {
          return createErrorResult(
            'NO_RESPONSE',
            'User did not provide a response and one was required.',
            true,
            {},
            { toolName: 'ask_user' }
          );
        }

        return createSuccessResult(textContent(response || default_value || ''), {
          toolName: 'ask_user',
        });
      } catch (err) {
        return createErrorResult(
          'ASK_USER_FAILED',
          err instanceof Error ? err.message : String(err),
          true,
          {},
          { toolName: 'ask_user' }
        );
      }
    })
    .build();
}
