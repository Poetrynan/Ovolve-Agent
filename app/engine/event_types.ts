/**
 * event_types.ts — the standard event model and its immutable data structures.
 *
 * Ported from `app/backend/event_types.py` (210 lines).
 *
 * "Model-visible means logged": any data reaching the LLM request must be
 * reconstructable from the stream.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/event_types.py -> app/engine/event_types.ts
 *   §2  `str, Enum` -> a frozen const object plus a union type. The string
 *       VALUES are a wire contract and are preserved byte for byte.
 *   §2  dataclass -> class with explicit fields; `asdict` -> toDict
 *
 * PORT STATUS: confidence=high todos=0
 */

/**
 * RULEBOOK §2: Python's `class EventType(str, Enum)` makes the member compare
 * equal to its string, and `.value` is the string. A frozen object literal plus
 * a union type gives the same values and the same type-safety, without emitting
 * a runtime enum that behaves differently under `==` and JSON.
 *
 * The values are a wire contract: they appear in the append-only ledger, in
 * `transcript.jsonl`, and in the frontend's event switch. Do not rename one.
 */
export const EventType = {
  // Session lifecycle
  SESSION_CREATED: "session.created",
  SESSION_FORKED: "session.forked",
  SESSION_RESUMED: "session.resumed",
  SESSION_CLOSED: "session.closed",

  // User interactions
  USER_MESSAGE_SUBMITTED: "user.message_submitted",
  USER_MESSAGE_STEERED: "user.message_steered",
  USER_ANSWER_PROVIDED: "user.answer_provided",

  // Agent turn state machine
  AGENT_TURN_STARTED: "agent.turn_started",
  AGENT_TURN_COMPLETED: "agent.turn_completed",
  AGENT_TURN_PAUSED: "agent.turn_paused",
  AGENT_TURN_RESUMED: "agent.turn_resumed",
  AGENT_TURN_CANCELLED: "agent.turn_cancelled",

  // LLM request/response lifecycle
  LLM_REQUEST_SENT: "llm.request_sent",
  LLM_RESPONSE_CHUNK: "llm.response_chunk",
  LLM_RESPONSE_COMPLETED: "llm.response_completed",
  LLM_ERROR_ENCOUNTERED: "llm.error_encountered",

  // Tool call pipeline
  TOOL_CALL_REQUESTED: "tool.call_requested",
  TOOL_CALL_APPROVED: "tool.call_approved",
  TOOL_CALL_DENIED: "tool.call_denied",
  TOOL_EXECUTION_STARTED: "tool.execution_started",
  TOOL_EXECUTION_COMPLETED: "tool.execution_completed",
  TOOL_EXECUTION_FAILED: "tool.execution_failed",
  TOOL_EXECUTION_CANCELLED: "tool.execution_cancelled",

  // Context compaction & memory
  CONTEXT_FOLD_STARTED: "context.fold_started",
  CONTEXT_FOLD_COMPLETED: "context.fold_completed",
  CONTEXT_MICROFOLD_APPLIED: "context.microfold_applied",
  FILE_SNAPSHOT_CAPTURED: "file.snapshot_captured",
  MEMORY_EXTRACTED: "memory.extracted",
  MEMORY_INJECTED: "memory.injected",

  // Sub-agent hierarchy
  SUBAGENT_SPAWNED: "subagent.spawned",
  SUBAGENT_COMPLETED: "subagent.completed",
  SUBAGENT_FAILED: "subagent.failed",

  // Skill lifecycle & experience (learning loop)
  SKILL_STARTED: "skill.started",
  SKILL_COMPLETED: "skill.completed",
  SKILL_FAILED: "skill.failed",
  SKILL_EXPERIENCE_RECORDED: "skill.experience_recorded",

  // Validator evidence (Phase 3 AcceptanceContract)
  VALIDATOR_PASSED: "validator.passed",
  VALIDATOR_FAILED: "validator.failed",
  VALIDATOR_SKIPPED: "validator.skipped",
  VALIDATOR_ERRORED: "validator.errored",

  // System & recovery
  SYSTEM_CHECKPOINT_CREATED: "system.checkpoint_created",
  SYSTEM_ERROR_LOGGED: "system.error_logged",
  SYSTEM_RECOVERY_INITIATED: "system.recovery_initiated",

  /**
   * Durable goal execution (checkpoint preflight / Continue-As-New lineage).
   * Emitted after a successful checkpoint preflight, before the resumed
   * worker's first round: names the checkpoint the run was rebuilt from and
   * what its ledger said (dont_redo / verify_before_redo counts).
   */
  GOAL_RESUMED_FROM_CHECKPOINT: "goal.resumed_from_checkpoint",

  /**
   * Goal terminal transitions. These are the events a LearningBundle, an audit
   * query and the history trace all hang off: before them, "this goal ended"
   * existed only as a mutable status column, so a finished run left nothing
   * immutable behind and nothing to anchor idempotency on.
   *
   * stop_timeout is terminal for the *run*, not the goal: it means we stopped
   * asking and could not confirm the worker was gone.
   */
  GOAL_COMPLETED: "goal.completed",
  GOAL_FAILED: "goal.failed",
  GOAL_CANCELLED: "goal.cancelled",
  GOAL_STOP_TIMEOUT: "goal.stop_timeout",
  GOAL_RECOVERY_DECIDED: "goal.recovery_decided",

  // Activity lifecycle (Phase 1)
  ACTIVITY_CREATED: "activity.created",
  ACTIVITY_STARTED: "activity.started",
  ACTIVITY_STOPPING: "activity.stopping",
  ACTIVITY_STOP_TIMEOUT: "activity.stop_timeout",
  ACTIVITY_COMPLETED: "activity.completed",
  ACTIVITY_FAILED: "activity.failed",
  ACTIVITY_CANCELLED: "activity.cancelled",
  ACTIVITY_UNKNOWN_EFFECT: "activity.unknown_effect",

  // Side-effect ledger (Phase 2)
  EFFECT_PLANNED: "effect.planned",
  EFFECT_STARTED: "effect.started",
  EFFECT_LANDED: "effect.landed",
  EFFECT_UNKNOWN: "effect.unknown",
  EFFECT_FAILED: "effect.failed",
  EFFECT_VERIFIED: "effect.verified",

  // ConversationEpisode (Phase 4)
  EPISODE_STARTED: "episode.started",
  EPISODE_SEALED: "episode.sealed",

  // LearningItem lifecycle & receipt (Phase 4 & Phase 8)
  LEARNING_ITEM_CREATED: "learning_item.created",
  LEARNING_ITEM_CLASSIFIED: "learning_item.classified",
  LEARNING_ITEM_DEFERRED: "learning_item.deferred",
  LEARNING_ITEM_PROPOSED: "learning_item.proposed",
  LEARNING_ITEM_PUBLISHED: "learning_item.published",
  LEARNING_ITEM_REJECTED: "learning_item.rejected",
  LEARNING_ITEM_FAILED: "learning_item.failed",
  LEARNING_ITEM_ROLLED_BACK: "learning_item.rolled_back",

  // Channel Gateway events (channel_gateway.ts)
  CHANNEL_MESSAGE_RECEIVED: "channel.message_received",
  CHANNEL_MESSAGE_REJECTED: "channel.message_rejected",
  CHANNEL_MESSAGE_HELD: "channel.message_held",
  CHANNEL_MESSAGE_DISPATCHED: "channel.message_dispatched",
  CHANNEL_REPLY_SENT: "channel.reply_sent",
  CHANNEL_REPLY_FAILED: "channel.reply_failed",
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

/** An immutable single atomic event in the session's append-only ledger. */
export interface AgentEventFields {
  /** Strictly monotonic sequence number (1, 2, 3...). */
  seq: number;
  eventType: string;
  sessionId: string;
  /** Microsecond or millisecond Unix timestamp. */
  timestamp: number;
  /** Structured JSON-serializable payload. */
  payload: Record<string, unknown>;
  /** SHA-256(prev_chain_hash + serialized_event_content). */
  chainHash: string;
  /** UUID or event_id that triggered this event. */
  causationId?: string | null;
  /** SHA-256 of pre-event projected state. */
  stateHash?: string | null;
  /** SHA-256 of post-event projected state. */
  resultingHash?: string | null;

  // Phase 1 (canonical run/trace protocol) — identity & correlation. All
  // optional so existing readers keep working; `seq` remains the stream
  // position and must never be used as an identity.
  /** Stable identity of the FACT (retry-safe). */
  idempotencyKey?: string | null;
  runId?: string | null;
  turnId?: string | null;
  stepId?: string | null;
  toolCallId?: string | null;
  goalId?: string | null;
  branchId?: string | null;
  parentEventId?: string | null;
  /** user|assistant|tool|subagent|system|background */
  actor?: string | null;
  /** model|ui|audit|internal */
  visibility?: string;
  schemaVersion?: number;
}

export class AgentEvent {
  seq: number;
  eventType: string;
  sessionId: string;
  timestamp: number;
  payload: Record<string, unknown>;
  chainHash: string;
  causationId: string | null;
  stateHash: string | null;
  resultingHash: string | null;
  idempotencyKey: string | null;
  runId: string | null;
  turnId: string | null;
  stepId: string | null;
  toolCallId: string | null;
  goalId: string | null;
  branchId: string | null;
  parentEventId: string | null;
  actor: string | null;
  visibility: string;
  schemaVersion: number;

  constructor(f: AgentEventFields) {
    this.seq = f.seq;
    this.eventType = f.eventType;
    this.sessionId = f.sessionId;
    this.timestamp = f.timestamp;
    this.payload = f.payload;
    this.chainHash = f.chainHash;
    this.causationId = f.causationId ?? null;
    this.stateHash = f.stateHash ?? null;
    this.resultingHash = f.resultingHash ?? null;
    this.idempotencyKey = f.idempotencyKey ?? null;
    this.runId = f.runId ?? null;
    this.turnId = f.turnId ?? null;
    this.stepId = f.stepId ?? null;
    this.toolCallId = f.toolCallId ?? null;
    this.goalId = f.goalId ?? null;
    this.branchId = f.branchId ?? null;
    this.parentEventId = f.parentEventId ?? null;
    this.actor = f.actor ?? null;
    this.visibility = f.visibility ?? "audit";
    this.schemaVersion = f.schemaVersion ?? 1;
  }

  /**
   * RULEBOOK §2 (`asdict`): the source serialises every field, including the
   * nulls. Kept — a consumer reading `idempotency_key` expects the key to be
   * present with a null value rather than absent.
   */
  toDict(): Record<string, unknown> {
    return {
      seq: this.seq,
      event_type: this.eventType,
      session_id: this.sessionId,
      timestamp: this.timestamp,
      payload: this.payload,
      chain_hash: this.chainHash,
      causation_id: this.causationId,
      state_hash: this.stateHash,
      resulting_hash: this.resultingHash,
      idempotency_key: this.idempotencyKey,
      run_id: this.runId,
      turn_id: this.turnId,
      step_id: this.stepId,
      tool_call_id: this.toolCallId,
      goal_id: this.goalId,
      branch_id: this.branchId,
      parent_event_id: this.parentEventId,
      actor: this.actor,
      visibility: this.visibility,
      schema_version: this.schemaVersion,
    };
  }

  /**
   * Hydrate from a database row or a plain object.
   *
   * RULEBOOK §2 (nullability): the source's `_opt` swallows every failure and
   * returns None, so a row from an older schema simply lacks the column rather
   * than raising. Preserved — an older ledger must still read.
   */
  static fromRow(row: Record<string, unknown> | unknown): AgentEvent {
    const r = row as Record<string, unknown>;
    const rawPayload = r["payload"];
    let payloadDict: Record<string, unknown>;
    if (typeof rawPayload === "string") {
      try {
        payloadDict = JSON.parse(rawPayload) as Record<string, unknown>;
      } catch {
        // RULEBOOK §2: preserved — unparseable payload becomes {raw: ...}
        // rather than failing the read.
        payloadDict = { raw: rawPayload };
      }
    } else {
      payloadDict = (rawPayload as Record<string, unknown>) ?? {};
    }

    const opt = (name: string): unknown => {
      try {
        return Object.prototype.hasOwnProperty.call(r, name) ? r[name] : null;
      } catch {
        return null;
      }
    };

    return new AgentEvent({
      seq: r["seq"] as number,
      eventType: r["event_type"] as string,
      sessionId: r["session_id"] as string,
      timestamp: r["timestamp"] as number,
      payload: payloadDict,
      chainHash: r["chain_hash"] as string,
      causationId: opt("causation_id") as string | null,
      stateHash: opt("state_hash") as string | null,
      resultingHash: opt("resulting_hash") as string | null,
      idempotencyKey: opt("idempotency_key") as string | null,
      runId: opt("run_id") as string | null,
      turnId: opt("turn_id") as string | null,
      stepId: opt("step_id") as string | null,
      toolCallId: opt("tool_call_id") as string | null,
      goalId: opt("goal_id") as string | null,
      branchId: opt("branch_id") as string | null,
      parentEventId: opt("parent_event_id") as string | null,
      actor: opt("actor") as string | null,
      visibility: (opt("visibility") as string) || "audit",
      schemaVersion: (opt("schema_version") as number) || 1,
    });
  }
}

/** Materialized projection snapshot for O(1) state recovery. */
export class SessionSnapshot {
  sessionId: string;
  atSeq: number;
  state: Record<string, unknown>;
  createdAt: number;
  snapshotHash: string;

  constructor(f: {
    sessionId: string;
    atSeq: number;
    state: Record<string, unknown>;
    createdAt?: number;
    snapshotHash?: string;
  }) {
    this.sessionId = f.sessionId;
    this.atSeq = f.atSeq;
    this.state = f.state;
    // RULEBOOK §2: the source's default_factory reads the clock at construction.
    this.createdAt = f.createdAt ?? Date.now();
    this.snapshotHash = f.snapshotHash ?? "";
  }
}
