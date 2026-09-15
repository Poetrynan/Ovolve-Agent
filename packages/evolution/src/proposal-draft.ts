/**
 * @oa/evolution — Proposal Draft Generator
 *
 * Generates human-readable proposal text from signal clusters.
 * Proposals describe the observed pattern and suggest an improvement.
 *
 * Each proposal includes:
 * - Title: Short description of the issue
 * - Description: Detailed explanation with examples
 * - Proposed Change: Concrete suggestion for improvement
 * - Risk Level: Assessment of change impact
 */

import type { SignalKind, ProposalRisk } from './types';
import type { SignatureCluster } from './signature';

// ---------------------------------------------------------------------------
// Proposal draft
// ---------------------------------------------------------------------------

export interface ProposalDraft {
  title: string;
  description: string;
  proposedChange: string;
  riskLevel: ProposalRisk;
}

/**
 * Generate a proposal draft from a signal cluster.
 *
 * Analyzes the cluster's signal kind, tool, and normalized message
 * to produce a targeted improvement proposal.
 *
 * @param cluster The signal cluster to generate a proposal for.
 */
export function draftProposal(cluster: SignatureCluster): ProposalDraft {
  const { kind, toolName, normalizedMessage, count } = cluster;

  switch (kind) {
    case 'tool_failure':
      return draftToolFailureProposal(toolName, normalizedMessage, count);
    case 'invalid_response':
      return draftInvalidResponseProposal(toolName, normalizedMessage, count);
    case 'user_correction':
      return draftUserCorrectionProposal(toolName, normalizedMessage, count);
    case 'partial_success':
      return draftPartialSuccessProposal(toolName, normalizedMessage, count);
    case 'stuck_loop':
      return draftStuckLoopProposal(toolName, normalizedMessage, count);
    case 'timeout':
      return draftTimeoutProposal(toolName, normalizedMessage, count);
    case 'security_trigger':
      return draftSecurityTriggerProposal(toolName, normalizedMessage, count);
    default:
      return draftGenericProposal(kind, toolName, normalizedMessage, count);
  }
}

// ---------------------------------------------------------------------------
// Kind-specific proposal generators
// ---------------------------------------------------------------------------

function draftToolFailureProposal(
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'tool';
  const risk = count >= 5 ? ProposalRisk.LOW : ProposalRisk.MEDIUM;

  return {
    title: `Improve error handling for ${tool} failures`,
    description:
      `Observed ${count} failure(s) from ${tool} with pattern: "${normalizedMessage}". ` +
      `These failures suggest the agent could benefit from better error recovery ` +
      `or pre-validation before calling ${tool}.`,
    proposedChange:
      `Add pre-call validation for ${tool} parameters and implement a retry strategy ` +
      `with exponential backoff. When ${tool} fails with this pattern, the agent should ` +
      `log the specific error context and attempt an alternative approach or escalate ` +
      `to the user with a clear explanation.`,
    riskLevel: risk,
  };
}

function draftInvalidResponseProposal(
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'LLM';
  return {
    title: `Address invalid response pattern from ${tool}`,
    description:
      `Detected ${count} instance(s) of invalid responses matching: "${normalizedMessage}". ` +
      `This pattern indicates the agent is producing output that doesn't meet ` +
      `the expected format or constraints.`,
    proposedChange:
      `Add output validation for ${tool} responses. Implement a retry mechanism ` +
      `that includes the validation error in the follow-up prompt so the model ` +
      `can self-correct. Consider adding explicit format constraints to the prompt.`,
    riskLevel: ProposalRisk.LOW,
  };
}

function draftUserCorrectionProposal(
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'agent';
  return {
    title: `Learn from user corrections: ${normalizedMessage.slice(0, 50)}`,
    description:
      `Users have corrected the agent ${count} time(s) for pattern: "${normalizedMessage}". ` +
      `This indicates a systematic behavior that should be adjusted to match ` +
      `user expectations.`,
    proposedChange:
      `Update the agent's behavior guidelines to avoid the pattern that triggered ` +
      `user corrections. Add the correction pattern to the system prompt as an ` +
      `explicit instruction. Consider creating a memory entry for this preference.`,
    riskLevel: ProposalRisk.LOW,
  };
}

function draftPartialSuccessProposal(
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'agent';
  return {
    title: `Improve completion rate for ${tool} tasks`,
    description:
      `Observed ${count} partial success(es) where ${tool} completed its task ` +
      `but with errors. Pattern: "${normalizedMessage}".`,
    proposedChange:
      `Add post-execution validation to verify task completeness before reporting ` +
      `success. Implement a self-review step that checks for the specific error ` +
      `pattern and attempts remediation.`,
    riskLevel: ProposalRisk.MEDIUM,
  };
}

function draftStuckLoopProposal(
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'agent';
  return {
    title: `Break stuck loop pattern in ${tool}`,
    description:
      `Detected ${count} instance(s) of the agent getting stuck in a loop. ` +
      `Pattern: "${normalizedMessage}". The agent is repeating the same action ` +
      `without making progress.`,
    proposedChange:
      `Implement stronger loop detection that triggers earlier. When a loop is ` +
      `detected, force a strategy change: try a different tool, ask the user for ` +
      `guidance, or break the task into smaller sub-tasks. Add the loop pattern ` +
      `to a blocklist to prevent recurrence.`,
    riskLevel: ProposalRisk.MEDIUM,
  };
}

function draftTimeoutProposal(
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'operation';
  return {
    title: `Address timeout issues in ${tool}`,
    description:
      `Observed ${count} timeout(s) for ${tool}. Pattern: "${normalizedMessage}". ` +
      `Timeouts suggest the operation is either too complex or the timeout ` +
      `threshold is too short.`,
    proposedChange:
      `Increase the timeout threshold for ${tool} or implement chunking to break ` +
      `the operation into smaller pieces. Add progress reporting so the user ` +
      `can see the operation is still running. Consider making the operation ` +
      `asynchronous with a callback.`,
    riskLevel: ProposalRisk.LOW,
  };
}

function draftSecurityTriggerProposal(
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'agent';
  return {
    title: `Address security trigger pattern in ${tool}`,
    description:
      `Security checks triggered ${count} time(s) for ${tool}. ` +
      `Pattern: "${normalizedMessage}". This indicates the agent is attempting ` +
      `operations that violate security policies.`,
    proposedChange:
      `Add explicit security constraints to the agent's system prompt for ${tool}. ` +
      `Implement pre-execution checks that block the flagged pattern before it ` +
      `reaches the security layer. Review and update the security rules to ` +
      `cover this pattern.`,
    riskLevel: ProposalRisk.HIGH,
  };
}

function draftGenericProposal(
  kind: SignalKind,
  toolName: string | undefined,
  normalizedMessage: string,
  count: number
): ProposalDraft {
  const tool = toolName ?? 'agent';
  return {
    title: `Address recurring ${kind} pattern in ${tool}`,
    description:
      `Observed ${count} instance(s) of ${kind} for ${tool}. ` +
      `Pattern: "${normalizedMessage}".`,
    proposedChange:
      `Review the ${kind} pattern and implement preventive measures. ` +
      `Add detection for this pattern to trigger early intervention. ` +
      `Consider updating the agent's behavior guidelines.`,
    riskLevel: ProposalRisk.MEDIUM,
  };
}

// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------

/**
 * Assess the risk level of a proposal based on signal characteristics.
 */
export function assessRisk(
  cluster: SignatureCluster,
  draft: ProposalDraft
): ProposalRisk {
  // Security-related proposals are always HIGH risk
  if (cluster.kind === 'security_trigger') {
    return ProposalRisk.HIGH;
  }

  // High-frequency patterns are lower risk (well-understood)
  if (cluster.count >= 10) {
    return ProposalRisk.LOW;
  }

  // Medium frequency
  if (cluster.count >= 5) {
    return ProposalRisk.LOW;
  }

  // Low frequency patterns are higher risk (less data to base decision on)
  if (cluster.count <= 2) {
    return ProposalRisk.MEDIUM;
  }

  return draft.riskLevel;
}
