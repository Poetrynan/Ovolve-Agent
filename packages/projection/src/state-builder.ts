/**
 * @oa/projection — SessionState Builder
 *
 * Factory and builder for ProjectionState. Provides initial state creation,
 * cloning, and helper methods for constructing state from scratch.
 */

import type {
  ProjectionState,
  ProjectionTokenUsage,
  ActiveToolCallInfo,
  CompletedToolCallInfo,
} from './types';

// ---------------------------------------------------------------------------
// Factory — create a blank ProjectionState
// ---------------------------------------------------------------------------

export function createInitialProjectionState(sessionId: string, timestamp: number): ProjectionState {
  return {
    // Base SessionState fields
    sessionId,
    title: '',
    archived: false,
    deleted: false,
    phase: 'idle',
    lastSeq: 0,
    lastEventTimestamp: timestamp,
    eventCount: 0,
    messageCount: 0,
    taskCounts: createZeroTaskCounts(),
    toolCallCounts: createZeroToolCallCounts(),
    errorCount: 0,
    lastError: undefined,
    filesTouched: [],
    fileSnapshots: [],
    memoryEntryIds: [],
    contextWindow: {
      maxTokens: 128000,
      currentTokens: 0,
      reservedTokens: 0,
    },
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,

    // ProjectionState extension fields
    lastUserMessage: '',
    lastAssistantMessage: '',
    activeToolCalls: [],
    completedToolCalls: [],
    modifiedFiles: [],
    tokenUsage: createZeroTokenUsage(),
    isStreaming: false,
    awaitingUser: false,
    currentTaskSummary: '',
    subagentSessionIds: [],
    injectedMemoryCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Sub-type factories
// ---------------------------------------------------------------------------

export function createZeroTaskCounts() {
  return {
    total: 0,
    pending: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

export function createZeroToolCallCounts() {
  return {
    total: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

export function createZeroTokenUsage(): ProjectionTokenUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    turnInputTokens: 0,
    turnOutputTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// Clone — deep clone a ProjectionState
// ---------------------------------------------------------------------------

export function cloneProjectionState(state: ProjectionState): ProjectionState {
  return {
    ...state,
    taskCounts: { ...state.taskCounts },
    toolCallCounts: { ...state.toolCallCounts },
    filesTouched: [...state.filesTouched],
    fileSnapshots: state.fileSnapshots.map((s) => ({ ...s })),
    memoryEntryIds: [...state.memoryEntryIds],
    contextWindow: { ...state.contextWindow },
    metadata: JSON.parse(JSON.stringify(state.metadata)),
    lastError: state.lastError,
    lastUserMessage: state.lastUserMessage,
    lastAssistantMessage: state.lastAssistantMessage,
    activeToolCalls: state.activeToolCalls.map((t) => ({ ...t })),
    completedToolCalls: state.completedToolCalls.map((t) => ({ ...t })),
    modifiedFiles: [...state.modifiedFiles],
    tokenUsage: { ...state.tokenUsage },
    currentTaskSummary: state.currentTaskSummary,
    subagentSessionIds: [...state.subagentSessionIds],
  };
}

// ---------------------------------------------------------------------------
// StateBuilder — fluent builder for ProjectionState
// ---------------------------------------------------------------------------

export class StateBuilder {
  private state: ProjectionState;

  constructor(sessionId: string, timestamp: number) {
    this.state = createInitialProjectionState(sessionId, timestamp);
  }

  static create(sessionId: string, timestamp: number): StateBuilder {
    return new StateBuilder(sessionId, timestamp);
  }

  static fromExisting(state: ProjectionState): StateBuilder {
    const builder = new StateBuilder(state.sessionId, state.createdAt);
    builder.state = cloneProjectionState(state);
    return builder;
  }

  setTitle(title: string): this {
    this.state.title = title;
    return this;
  }

  setPhase(state: ProjectionState['phase']): this {
    this.state.phase = state;
    return this;
  }

  setLastSeq(seq: number): this {
    this.state.lastSeq = seq;
    return this;
  }

  setLastEventTimestamp(ts: number): this {
    this.state.lastEventTimestamp = ts;
    return this;
  }

  incrementEventCount(): this {
    this.state.eventCount++;
    return this;
  }

  incrementMessageCount(): this {
    this.state.messageCount++;
    return this;
  }

  setLastUserMessage(msg: string): this {
    this.state.lastUserMessage = msg;
    return this;
  }

  setLastAssistantMessage(msg: string): this {
    this.state.lastAssistantMessage = msg;
    return this;
  }

  addActiveToolCall(call: ActiveToolCallInfo): this {
    this.state.activeToolCalls.push(call);
    this.state.toolCallCounts.running++;
    this.state.toolCallCounts.total++;
    return this;
  }

  completeToolCall(callId: string, status: CompletedToolCallInfo['status'], durationMs: number): this {
    const idx = this.state.activeToolCalls.findIndex((c) => c.callId === callId);
    if (idx >= 0) {
      const call = this.state.activeToolCalls[idx];
      this.state.activeToolCalls.splice(idx, 1);
      this.state.toolCallCounts.running--;
      this.state.completedToolCalls.push({
        callId: call.callId,
        toolName: call.toolName,
        status,
        durationMs,
        completedAt: Date.now() * 1000,
      });
      if (status === 'completed') {
        this.state.toolCallCounts.completed++;
      } else if (status === 'failed') {
        this.state.toolCallCounts.failed++;
        this.state.errorCount++;
      } else {
        this.state.toolCallCounts.cancelled++;
      }
    }
    return this;
  }

  addModifiedFile(filePath: string): this {
    if (!this.state.modifiedFiles.includes(filePath)) {
      this.state.modifiedFiles.push(filePath);
    }
    if (!this.state.filesTouched.includes(filePath)) {
      this.state.filesTouched.push(filePath);
    }
    return this;
  }

  updateTokenUsage(usage: Partial<ProjectionTokenUsage>): this {
    this.state.tokenUsage = { ...this.state.tokenUsage, ...usage };
    return this;
  }

  setStreaming(isStreaming: boolean): this {
    this.state.isStreaming = isStreaming;
    return this;
  }

  setAwaitingUser(awaiting: boolean): this {
    this.state.awaitingUser = awaiting;
    return this;
  }

  setCurrentTaskSummary(summary: string): this {
    this.state.currentTaskSummary = summary;
    return this;
  }

  addSubagent(sessionId: string): this {
    if (!this.state.subagentSessionIds.includes(sessionId)) {
      this.state.subagentSessionIds.push(sessionId);
    }
    return this;
  }

  incrementInjectedMemoryCount(): this {
    this.state.injectedMemoryCount++;
    return this;
  }

  setMetadata(metadata: Record<string, unknown>): this {
    this.state.metadata = { ...metadata };
    return this;
  }

  mergeMetadata(partial: Record<string, unknown>): this {
    this.state.metadata = { ...this.state.metadata, ...partial };
    return this;
  }

  touch(timestamp: number): this {
    this.state.updatedAt = timestamp;
    return this;
  }

  build(): ProjectionState {
    return cloneProjectionState(this.state);
  }

  /** Get the current state without cloning (for inspection). */
  inspect(): Readonly<ProjectionState> {
    return this.state;
  }
}
