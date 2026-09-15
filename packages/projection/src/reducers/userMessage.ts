/**
 * @oa/projection — User Message Reducer
 *
 * Handles MessageCreated events where the message originates from the user.
 * Updates the last user message, message count, and session phase.
 */

import type { AgentEvent, EventType } from '@oa/event-store';
import type { ProjectionState } from '../types';
import { cloneProjectionState } from '../state-builder';

export interface UserMessagePayload {
  content: string;
  role: 'user';
  messageId: string;
  attachments?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Reducer for user message events. Updates the projection state with the
 * user's message content and advances the session phase.
 */
export function userMessageReducer(
  state: ProjectionState,
  event: AgentEvent<UserMessagePayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  // Update message tracking
  next.messageCount++;
  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Store truncated user message for display
  const content = payload.content ?? '';
  next.lastUserMessage = truncate(content, 500);

  // Transition phase: user sent a message, so we're now expecting agent work
  if (next.phase === 'idle' || next.phase === 'awaiting_user') {
    next.phase = 'planning';
  }

  // Update context window estimate (rough token count)
  const estimatedTokens = Math.ceil(content.length / 4);
  next.contextWindow.currentTokens += estimatedTokens;

  return next;
}

/**
 * Reducer for MessageCreated events that may be from any role.
 * Delegates to the appropriate handler based on the role field.
 */
export function messageCreatedReducer(
  state: ProjectionState,
  event: AgentEvent<UserMessagePayload>
): ProjectionState {
  const payload = event.payload;
  if (payload.role === 'user') {
    return userMessageReducer(state, event);
  }
  // For non-user messages, just update counters
  const next = cloneProjectionState(state);
  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;
  return next;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
