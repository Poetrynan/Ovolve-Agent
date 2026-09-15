/**
 * @oa/projection — Session Lifecycle Reducer
 *
 * Handles session lifecycle events: created, updated, deleted, archived,
 * restored. Updates the session state to reflect lifecycle changes.
 */

import type { AgentEvent } from '@oa/event-store';
import type { ProjectionState } from '../types';
import { cloneProjectionState } from '../state-builder';

export interface SessionCreatedPayload {
  title: string;
  workspace: string;
  tags: string[];
  forkedFrom: string | null;
  forkPointSeq: number | null;
  metadata: Record<string, unknown>;
}

export interface SessionUpdatedPayload {
  title?: string;
  phase?: string;
  metadata?: Record<string, unknown>;
  forkedFrom?: string;
  forkPointSeq?: number;
  sourceSessionId?: string;
  sourceTitle?: string;
  oldTitle?: string;
  newTitle?: string;
  oldWorkspace?: string;
  newWorkspace?: string;
  added?: string[];
  removed?: string[];
}

export interface SessionDeletedPayload {
  hardDelete: boolean;
}

export interface SessionArchivedPayload {
  reason?: string;
}

export interface SessionRestoredPayload {
  reason?: string;
}

/**
 * Reducer for session created events. Initializes the session state with
 * the creation payload data.
 */
export function sessionCreatedReducer(
  state: ProjectionState,
  event: AgentEvent<SessionCreatedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Set creation fields
  next.title = payload.title;
  next.metadata = {
    ...next.metadata,
    workspace: payload.workspace,
    tags: payload.tags,
    forkedFrom: payload.forkedFrom,
    forkPointSeq: payload.forkPointSeq,
    ...payload.metadata,
  };

  return next;
}

/**
 * Reducer for session updated events. Handles title changes, workspace
 * changes, tag changes, and fork metadata.
 */
export function sessionUpdatedReducer(
  state: ProjectionState,
  event: AgentEvent<SessionUpdatedPayload>
): ProjectionState {
  const payload = event.payload;
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;

  // Title change
  if (payload.newTitle !== undefined) {
    next.title = payload.newTitle;
  } else if (payload.title !== undefined) {
    next.title = payload.title;
  }

  // Phase change
  if (payload.phase !== undefined) {
    next.phase = payload.phase as ProjectionState['phase'];
  }

  // Workspace change
  if (payload.newWorkspace !== undefined) {
    next.metadata['workspace'] = payload.newWorkspace;
  }

  // Fork metadata
  if (payload.forkedFrom !== undefined) {
    next.metadata['forkedFrom'] = payload.forkedFrom;
  }
  if (payload.forkPointSeq !== undefined) {
    next.metadata['forkPointSeq'] = payload.forkPointSeq;
  }

  // Tag changes
  if (payload.added || payload.removed) {
    const currentTags = (next.metadata['tags'] as string[]) ?? [];
    const newTags = currentTags.filter((t) => !(payload.removed ?? []).includes(t));
    for (const t of payload.added ?? []) {
      if (!newTags.includes(t)) newTags.push(t);
    }
    next.metadata['tags'] = newTags;
  }

  // Merge any additional metadata
  if (payload.metadata) {
    next.metadata = { ...next.metadata, ...payload.metadata };
  }

  return next;
}

/**
 * Reducer for session deleted events. Marks the session as deleted.
 */
export function sessionDeletedReducer(
  state: ProjectionState,
  event: AgentEvent<SessionDeletedPayload>
): ProjectionState {
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;
  next.deleted = true;
  next.phase = 'cancelled';

  return next;
}

/**
 * Reducer for session archived events. Marks the session as archived.
 */
export function sessionArchivedReducer(
  state: ProjectionState,
  event: AgentEvent<SessionArchivedPayload>
): ProjectionState {
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;
  next.archived = true;

  return next;
}

/**
 * Reducer for session restored events. Un-archives/un-deletes the session.
 */
export function sessionRestoredReducer(
  state: ProjectionState,
  event: AgentEvent<SessionRestoredPayload>
): ProjectionState {
  const next = cloneProjectionState(state);

  next.eventCount++;
  next.lastSeq = event.seq;
  next.lastEventTimestamp = event.timestamp;
  next.updatedAt = event.timestamp;
  next.archived = false;
  next.deleted = false;
  next.phase = 'idle';

  return next;
}
