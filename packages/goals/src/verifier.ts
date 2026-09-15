/**
 * @oa/goals — LLM-Based Completion Verification
 *
 * Uses an LLM to verify whether a goal has been completed successfully.
 * The verifier reviews the goal's success criteria against the execution
 * results and provides a confidence score.
 *
 * Verification process:
 * 1. Collect all step results from goal execution.
 * 2. Send to LLM with the goal's success criteria.
 * 3. LLM evaluates each criterion and provides reasoning.
 * 4. Result includes pass/fail, confidence, and missing criteria.
 */

import type { LlmMessage } from '@oa/llm';
import type { Goal, GoalStep, GoalVerificationResult } from './types';

// ---------------------------------------------------------------------------
// Verification prompt
// ---------------------------------------------------------------------------

const VERIFICATION_SYSTEM_PROMPT = `You are a goal completion verifier. Your task is to evaluate whether a goal has been successfully completed based on its success criteria and the execution steps taken.

For each success criterion, determine if it has been met based on the evidence from the execution steps.

Respond in the following JSON format:
{
  "verified": boolean,
  "confidence": number (0-1),
  "reasoning": "explanation of your assessment",
  "missingCriteria": ["criteria that were not met"]
}

Be rigorous — only mark as verified if ALL success criteria are clearly met.
Be specific in your reasoning, referencing the relevant steps.`;

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export interface VerifierConfig {
  /** LLM client for verification. */
  llmClient: import('@oa/llm').LlmClient;
  /** Model to use for verification. */
  model: string;
  /** Minimum confidence threshold for verification. */
  minConfidence: number;
}

/**
 * Verify whether a goal has been completed.
 *
 * @param goal The goal to verify.
 * @param config The verifier configuration.
 */
export async function verifyGoalCompletion(
  goal: Goal,
  config: VerifierConfig
): Promise<GoalVerificationResult> {
  const startTime = Date.now();

  // Build the verification prompt
  const userMessage = buildVerificationPrompt(goal);

  const messages: LlmMessage[] = [
    { role: 'system', content: VERIFICATION_SYSTEM_PROMPT } as LlmMessage,
    { role: 'user', content: userMessage } as LlmMessage,
  ];

  try {
    const response = await config.llmClient.chat({
      model: config.model,
      messages,
      max_tokens: 1024,
      temperature: 0.2,
    });

    // Parse the response
    const result = parseVerificationResponse(response.content, config.model);

    return {
      ...result,
      timestamp: Date.now(),
      modelUsed: config.model,
    };
  } catch (error) {
    // Verification failed — return uncertain result
    return {
      verified: false,
      confidence: 0,
      reasoning: `Verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      missingCriteria: goal.brief.successCriteria,
      timestamp: Date.now(),
      modelUsed: config.model,
    };
  }
}

/**
 * Build the verification prompt from goal data.
 */
function buildVerificationPrompt(goal: Goal): string {
  const parts: string[] = [];

  parts.push(`## Goal Objective\n${goal.brief.objective}\n`);

  if (goal.brief.context) {
    parts.push(`## Context\n${goal.brief.context}\n`);
  }

  parts.push(`## Success Criteria\n${goal.brief.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`);

  if (goal.brief.constraints.length > 0) {
    parts.push(`## Constraints\n${goal.brief.constraints.map((c) => `- ${c}`).join('\n')}\n`);
  }

  parts.push(`## Execution Steps\n`);

  if (goal.steps.length === 0) {
    parts.push('(No execution steps recorded)\n');
  } else {
    for (const step of goal.steps) {
      const status = step.success ? 'SUCCESS' : 'FAILED';
      parts.push(`### Step ${step.index + 1} [${status}] (${step.durationMs}ms)`);
      parts.push(`Action: ${step.action}`);
      if (step.toolName) {
        parts.push(`Tool: ${step.toolName}`);
      }
      parts.push(`Result: ${step.result.slice(0, 500)}${step.result.length > 500 ? '...' : ''}`);
      parts.push('');
    }
  }

  parts.push(`## Task\nBased on the execution steps above, evaluate whether each success criterion has been met. Provide your assessment in the specified JSON format.`);

  return parts.join('\n');
}

/**
 * Parse the LLM response into a verification result.
 */
function parseVerificationResponse(
  content: string,
  model: string
): Omit<GoalVerificationResult, 'timestamp' | 'modelUsed'> {
  // Try to extract JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        verified: Boolean(parsed.verified),
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        missingCriteria: Array.isArray(parsed.missingCriteria)
          ? parsed.missingCriteria
          : [],
      };
    } catch {
      // JSON parse failed — fall through to text analysis
    }
  }

  // Fallback: analyze the text for verification signals
  return analyzeTextForVerification(content, model);
}

/**
 * Analyze free-text response for verification signals.
 */
function analyzeTextForVerification(
  content: string,
  model: string
): Omit<GoalVerificationResult, 'timestamp' | 'modelUsed'> {
  const lower = content.toLowerCase();

  // Look for positive signals
  const positiveSignals = [
    'all criteria met',
    'successfully completed',
    'goal is complete',
    'verified',
    'all success criteria',
    'fully met',
    'completed successfully',
  ];

  // Look for negative signals
  const negativeSignals = [
    'not met',
    'not completed',
    'incomplete',
    'missing',
    'failed',
    'not verified',
    'criteria not',
    'insufficient',
  ];

  let positiveCount = 0;
  let negativeCount = 0;

  for (const signal of positiveSignals) {
    if (lower.includes(signal)) positiveCount++;
  }
  for (const signal of negativeSignals) {
    if (lower.includes(signal)) negativeCount++;
  }

  const verified = positiveCount > negativeCount;
  const total = positiveCount + negativeCount;
  const confidence = total > 0 ? positiveCount / total : 0.5;

  return {
    verified,
    confidence,
    reasoning: content.slice(0, 500),
    missingCriteria: verified ? [] : ['(Could not determine specific missing criteria)'],
  };
}

/**
 * Quick verification check — returns true if the goal appears complete
 * based on simple heuristics (no LLM call).
 */
export function quickVerify(goal: Goal): boolean {
  // Must have at least one step
  if (goal.steps.length === 0) return false;

  // Last step must be successful
  const lastStep = goal.steps[goal.steps.length - 1];
  if (!lastStep.success) return false;

  // Most steps should be successful (>70%)
  const successRate = goal.steps.filter((s) => s.success).length / goal.steps.length;
  if (successRate < 0.7) return false;

  // Must not have exceeded cost cap
  if (goal.costIncurredUsd > goal.brief.costCapUsd) return false;

  return true;
}
