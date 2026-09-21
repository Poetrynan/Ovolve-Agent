export interface EvolutionInsight {
  /** evaluating | learned | receipt | actionable | candidate_staged | candidate_active | rolled_back | skill_degraded | published | rejected | deferred | failed | unknown */
  kind: string
  detail: string
  decision?: string | null
  sessionId?: string
  branchId?: string
  episodeId?: string
  bundleId?: string
  itemId?: string
  goalId?: string
  runId?: string
  turnIds?: string[]
  skills?: string[]
  skillName?: string
  candidateId?: string
  proposalId?: string
  status?: string
  lifecycle?: string
  scope?: string
  impact?: string
  notificationPolicy?: string
  title?: string
  summary?: string
  why?: string
  evidenceSummary?: string
  futureEffect?: string
  traceRef?: string
  createdAt?: number
  memoryProposals?: string[]
  skillCandidate?: string
  learningItems?: string[]
  learningItemDetails?: Array<{
    id: string
    version: number
    kind?: string
    content?: string
    status?: string
    why?: string
    scope?: string
  }>
  materialized?: boolean
  materializeReason?: string
  version?: number
  operationId?: string
  idempotencyKey?: string
  lifecycleRevision?: number
}

export interface InlineEvolutionProposal {
  id?: string
  proposal_id?: string
  status?: 'pending' | 'approved' | 'rejected' | string
  signature?: string
  created_at?: number
  target_file?: string
  targetFile?: string
  trigger_type?: string
  confidence?: string
  payload_hash?: string
  content_hash?: string
  reason?: string
  proposed_change?: string
  delivery_mode?: string
  user_title?: string
  user_advice?: string
  user_reason?: string
  category?: string
}

export interface MoaAdvisor {
  model: string
  provider?: string
}

export interface MoaOpinion {
  model: string
  ok: boolean
  elapsed_s?: number
  error?: string
  text?: string
}

export interface MoaCouncil {
  phase: 'asking' | 'answered'
  advisors?: MoaAdvisor[]
  opinions?: MoaOpinion[]
  elapsed_s?: number
}

export interface RedTeamFinding {
  source: string
  sample?: string
  hit?: { category?: string; matched?: string }
}

export interface RedTeamAlert {
  count?: number
  sources?: string[]
  findings?: RedTeamFinding[]
}

export interface ShadowIssue {
  checker: string
  severity: 'error' | 'warning' | 'info' | string
  message: string
  path?: string
  line?: number
  character?: number
}

export interface ShadowValidation {
  ok?: boolean
  pending_apply?: boolean
  mode?: string
  issue_count?: number
  error_count?: number
  warning_count?: number
  issues?: ShadowIssue[]
  changes?: Array<{ rel: string; kind: string; bytes?: number }>
  paths?: string[]
  auto_apply_blocked?: boolean
  applied?: string[]
  deleted?: string[]
}

export interface ConversationEpisode {
  episode_id: string
  session_id: string
  branch_id?: string
  topic?: string
  goal_id?: string
  turn_ids: string[]
  status: 'active' | 'sealed'
  started_at: number
  sealed_at: number
  metadata?: Record<string, any>
}

export interface LearningItem {
  learning_item_id: string
  bundle_id?: string
  episode_id?: string
  session_id?: string
  branch_id?: string
  kind: 'memory_fact' | 'skill_step' | 'failure_guard' | 'strategy_hint' | 'preference' | string
  scope: 'session' | 'workspace' | 'global' | string
  content: string
  preconditions?: string
  applicability?: string
  source_event_ids?: string[]
  source_session_id?: string
  source_goal_id?: string
  source_run_id?: string
  source_turn_id?: string
  confidence: number
  evidence_strength: number
  priority: number
  status: 'discovered' | 'proposed' | 'staged' | 'published' | 'deferred' | 'rejected' | 'rolled_back' | 'archived' | 'failed' | 'unknown'
  notification_policy: 'silent' | 'receipt' | 'actionable'
  why?: string
  evidence_summary?: string
  future_effect?: string
  target_ref?: string
  deferred_reason?: string
  user_verdict?: 'pending' | 'approved' | 'rejected' | 'deferred' | 'revoked' | 'failed'
  version?: number
  created_at: number
  updated_at: number
}

export interface SessionLearningProjection {
  sessionId: string
  branchId?: string
  episodes: ConversationEpisode[]
  learningItems: LearningItem[]
  activeEpisode?: ConversationEpisode | null
  counts: {
    total: number
    actionable: number
    published: number
    deferred: number
    failed?: number
  }
  crossSessionReused?: any[]
}
// AgentEvent types — the WebSocket event vocabulary the backend streams.
export type AgentEventType =
  | "user_prompt" | "agent_response" | "agent_delta" | "tool_call" | "tool_result"
  | "error" | "risk_check" | "output_guard"
  | "task_started" | "tool_called" | "waiting" | "completed" | "idle" | "pong"
  | "reasoning" | "goal_state_change" | "agent_state"
  | "queue_state" | "folded" | "fold_result" | "reasoning_delta" | "turn_retry_window"
  | "context_precheck" | "tool_call_delta"
  | "image_generating" | "session_truncated" | "steer_queued" | "steer_applied"
  | "session_list" | "session_switched" | "session_forked" | "workspace_list"
  | "subagent_state" | "subagent_activity"
  | "agent_phase" | "tool_output_delta" | "tool_cancelled"
  | "pending_questions" | "model_downgraded" | "context_refs_resolved"
  | "turn_state" | "evolution_proposal" | "evolution_insight" | "learning_item_event"
  | "moa_advisors" | "red_team_alert"
  | "shadow_validation" | "shadow_applied"
  | "subagent_stuck" | "post_edit_verification"
  | "plan_ready" | "plan_approved" | "plan_discarded"

/**
 * The persisted state of a session's turn (2.1).
 *
 * Replaces a bare `isWorking: boolean`, which could not tell these apart:
 *   · `waiting_user` — a question / confirmation card is parked; the turn is
 *     alive but the ball is with the user. Used to be inferred from the shape of
 *     `toolCalls`, which meant the UI guessed.
 *   · `paused`  — the user hit stop. Unlike `error` this is RESUMABLE.
 *   · `error` vs `completed` — a stopped turn and a finished one looked the same.
 *
 * Values are the exact wire strings from `turn_state.TurnStatus`; never rename.
 */
export type TurnStatus =
  | "idle" | "running" | "waiting_user" | "paused" | "completed" | "error"


/**
 * One sub-agent spawned by the `task` tool, as projected from the backend's
 * `SubagentSession.to_public()`. Field names are the backend's camelCase
 * verbatim — this is a mirror, not a re-model, so the six-state machine can
 * never drift between the two halves.
 */
export type SubagentStatus =
  | "spawning" | "running" | "completed" | "error" | "killed" | "timeout" | "stale"
  | "spawn_error" | "lost"

export interface SubagentInfo {
  subagentId: string
  subagentType: string
  label: string
  parentSessionId: string
  childSessionId: string
  status: SubagentStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  elapsedMs: number
  resultChars: number
  error: string
  /** F5 subprocess backend metadata (camelCase wire from backend). */
  execMode?: string
  pid?: number | null
  logPath?: string | null
  idleSince?: number | null
}

/**
 * One tool call made BY a sub-agent, as relayed from its child Router.
 *
 * Deliberately thinner than the top-level `ToolCall`: no `args`, no
 * `reversible`. A sub-agent's tool calls are read-only evidence of what it did —
 * the user cannot withdraw or re-run one from here, and the rollback path acts
 * on the parent turn's snapshots, not per-child. Carrying args would also mean
 * shipping full file contents for every child `write_file` across the socket.
 */
export interface SubagentToolCall {
  toolCallId: string
  toolName: string
  status: 'running' | 'completed' | 'error'
  ok?: boolean
  preview?: string
}

/**
 * One item in a sub-agent's timeline.
 *
 * An ORDERED list rather than parallel `text` / `toolCalls` fields, because the
 * whole point of the drill-down is reading the child's reasoning in sequence:
 * "let me read the asset docs" → `read_file · done` → "now let me count the
 * skills" → `grep · done`. Split into two fields, the narration and the tools it
 * refers to would render as two disconnected columns and the causal link — the
 * only thing that makes the panel worth opening — would be lost.
 */
export type SubagentEntry =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | ({ kind: 'tool' } & SubagentToolCall)

/**
 * The live transcript of ONE sub-agent, accumulated from `subagent_activity`
 * frames. This is what the drill-down panel renders.
 *
 * Bounded (see the SUBAGENT_* caps in agentStore): eight concurrent sub-agents
 * each streaming tokens is eight times the main channel's volume, and nobody
 * scrolls back through 200KB of a child's narration. We keep the TAIL — the
 * useful question about a child is "where did it get to", never "what was its
 * opening sentence".
 */
export interface SubagentActivity {
  entries: SubagentEntry[]
  /** True once a cap dropped earlier content, so the UI can say so. */
  truncated: boolean
}

export interface AgentEvent {
  type: AgentEventType
  timestamp: number
  payload: any
  sessionId?: string
  branchId?: string
  scopeType?: string
}


/**
 * A model-generated image, as persisted by the backend `image_store`.
 *
 * Deliberately carries NO pixel data — the bytes live on disk and are fetched
 * over `GET /api/images/{id}`. Keeping base64 out of the store is what stops a
 * session with a few images from turning every React re-render into a
 * multi-megabyte string copy.
 *
 * `width`/`height` are optional because the backend does not probe image
 * dimensions (documented trade-off in `image_store.py` — it would need a
 * per-format header parser or Pillow). When absent the renderer reserves a
 * square box; see ChatImage.
 */
export interface ImageRef {
  id: string
  /** Server-relative path, e.g. `/api/images/{id}`. */
  url: string
  mime: string
  bytes: number
  ext?: string
  name?: string
  /** Absolute on-disk path — debugging only, never used for display. */
  path?: string
  width?: number
  height?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  metadata?: Record<string, any>
  /**
   * Non-conversational rows the timeline renders specially. `fold` is a fold
   * marker (context was compacted here); absent means an ordinary message.
   */
  kind?: 'fold' | 'evolution' | 'evolution_card' | 'moa' | 'red_team' | 'shadow' | 'verification'
  /** Present on `kind: 'fold'` rows — the fold report from the backend. */
  fold?: FoldReport
  /** Present on `kind: 'evolution'` rows — one learning-loop moment. */
  evolution?: EvolutionInsight
  /** Present on `kind: 'evolution_card'` rows — in-chat approval card. */
  evolutionProposal?: InlineEvolutionProposal
  /** Present on `kind: 'moa'` rows — multi-model council status. */
  moa?: MoaCouncil
  /** Present on `kind: 'red_team'` rows — red team patrol alert. */
  redTeam?: RedTeamAlert
  /** Present on `kind: 'shadow'` rows — shadow workspace validation. */
  shadow?: ShadowValidation
  /** Present on `kind: 'verification'` rows — post-edit verification result. */
  verification?: VerificationReport
  /**
   * Frozen per-turn activity for a completed assistant message. The mid-flight
   * copies live in the store root and get wiped between turns; sealing them
   * into the message here is what makes "history is auditable" work — the user
   * can scroll back to turn 1 and still see what tools ran and what the model
   * was thinking.
   */
  toolCalls?: ToolCall[]
  reasoning?: ReasoningBlock[]
  /** Images the model generated on this turn. Refs only — no pixel data. */
  images?: ImageRef[]
  /**
   * What this turn cost, stamped on the reply when the turn completed:
   * wall-clock duration plus the backend's per-turn accounting (tokens and,
   * when available, money). Renders as a quiet chip under the bubble.
   */
  turnStats?: {
    /** Wall-clock span from send to completed, milliseconds. */
    durationMs: number
    /** Total tokens the turn consumed (input+output+reasoning). */
    tokens?: number
    /** Turn cost in millionths of the pricing currency, from the registry. */
    costMicros?: number
    /**
     * Where `costMicros` came from: `reported` = the provider billed this exact
     * amount; `estimated` = our rate table had this model; `fallback` = it did
     * not and a mid-market rate was used. Anything but `reported` renders with
     * a "≈" so a table lookup is not read as a bill.
     */
    costSource?: string
  }
}

/** Result of one context fold, reported by the backend compactor. */
export interface FoldReport {
  /** Which layer of the fold chain produced the summary. */
  strategy: 'llm-summary' | 'engineering' | 'truncate'
  tokensBefore: number
  estimatedTokensAfter: number
  compressionRatio: number
  /** True when the user asked for it rather than the threshold tripping. */
  manual: boolean
  summary: string
  /** 折叠水位审计（reserve-floor）。旧后端没有这几个字段 → undefined，卡片需容忍。 */
  reserveFloor?: number
  freeTokensAfter?: number
  floorMet?: boolean
  /** 因未达水位而强制升级压缩强度的折叠。 */
  floorEnforced?: boolean
}

/** Result of post-edit verification, reported by the backend post_edit_verifier. */
export interface VerificationReport {
  session_id: string
  workspace: string
  trigger_tool: string
  trigger_path: string
  success: boolean
  command: string
  kind: 'lint' | 'typecheck' | 'test' | 'build'
  exit_code: number
  output: string
  duration_ms: number
  timestamp: number
  error?: string
}

/**
 * Tool call lifecycle (TOOL_UI_UX.md §1.1-1.2).
 *
 * `denied` is distinct from `failed`: the tool never ran because policy or the
 * user blocked it, which the UI presents differently (shield, not error).
 *
 * `interrupted` is the catch-all that makes a stuck spinner impossible: the turn
 * ended (terminal event, hard error, socket close, or the user hit stop) while
 * this call was still `pending`/`running` and no result will ever arrive. Every
 * terminal path in the store sweeps leftovers into this state — see
 * `settleActivity` in agentStore.
 *
 * `needs_input` is the `ask_user` twin of `needs_confirmation`: the turn stopped
 * on a question, not on a permission gate. Kept separate because they settle
 * differently — a confirmation is answered by re-issuing the same call, a
 * question by sending the choice back as a new user message.
 */
export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'needs_confirmation'
  | 'needs_input'
  | 'interrupted'

/** One option of an `ask_user` question. */
export interface AskOption {
  label: string
  description?: string
}

/**
 * One `ask_user` question, as normalised by the backend.
 *
 * `index` is the key the answer is sent back under. It comes from the backend,
 * not from array position here, so a re-render can never re-key an answer onto
 * a different question.
 */
export interface AskQuestion {
  index: number
  question: string
  options: AskOption[]
  multiSelect?: boolean
}

/**
 * A tool call the model is still writing out, before it becomes a real
 * `ToolCall`. Streamed from `tool_call_delta`.
 *
 * `argsText` is the RAW accumulated JSON string, not an object — partial JSON is
 * invalid JSON, so there is nothing to parse until `final` is true. Render it as
 * text and do not try to key off its fields.
 *
 * `index` is the provider's slot number and the only reliable identity: `callId`
 * can still be empty on the first frames, because a provider may send the id in
 * a later chunk than the first argument fragment.
 */
export interface ToolCallPreview {
  index: number
  callId: string
  toolName: string
  argsText: string
  /** The model has finished this call; args are now complete and parseable. */
  final: boolean
  timestamp: number
}

export interface ToolCall {
  id: string
  toolName: string
  args: Record<string, any>
  result?: any
  status: ToolCallStatus
  timestamp: number
  completedAt?: number
  // `critical` is the tier nothing auto-runs: not 完全访问, not a standing
  // allowlist rule. Only a per-call approval clears it.
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  /** ask_user: title + normalised questions, present only on that tool's card. */
  askHeader?: string
  askQuestions?: AskQuestion[]
  /**
   * The agent answered its own `ask_user` call from the conversation instead of
   * interrupting. Badged on the card because a self-answer the user can't see is
   * the one genuinely dangerous outcome of that mechanism.
   */
  askAutoResolved?: boolean
  /**
   * Can this call be undone from our own state? Writes we snapshot pre-mutation
   * are reversible; shell / git push / git commit are not. Drives the "不可逆"
   * badge and the rollback-confirm dialog's warning list. Undefined = unknown
   * (treat as reversible for messaging).
   *
   * Set twice: optimistically on `tool_call` from the tool-name table, then
   * corrected on `tool_result` once the snapshot has actually run. The second
   * value is the one to trust — a write over a file past the snapshot cap looks
   * reversible by name but has no pre-image behind it.
   */
  reversible?: boolean
  /**
   * What the pre-mutation snapshot managed to store, when one was attempted.
   * `skipped`/`failed` are the paths that will NOT come back on a rollback, so
   * the confirm dialog can name them instead of failing silently mid-restore.
   */
  snapshot?: {
    seq?: number | null
    captured?: number
    skipped?: string[]
    failed?: string[]
  }
  /**
   * Where the command ran. A terminal card that shows `rm -rf build` without a
   * directory is ambiguous — the same command means different things in two
   * repos. `cwd` is what the tool was handed, `workspaceRoot` the session
   * default it fell back to.
   */
  cwd?: string
  workspaceRoot?: string
  /** Permission level in force when the call was made ('auto' | 'plan' | …). */
  permission?: string
  /**
   * 命令内容分级结果（COMMAND 策略层）。旧后端没有此字段 → undefined。
   * 审批卡片据此展示"为什么需要确认"，而不是让用户盲批。
   */
  commandGuard?: {
    tier: 'allow' | 'review' | 'restricted'
    flags: string[]
    matched: string[]
    hosts: string[]
    segments: number
    reasons: string[]
  }
  /**
   * Real process exit code, straight from the backend — NOT scraped out of the
   * message text. `undefined` means "this tool has no exit code", which is a
   * different thing from `0`.
   */
  exitCode?: number | null
  /** Killed by the timeout budget rather than exiting on its own. */
  timedOut?: boolean
  /**
   * Live stdout accumulated from `tool_output_delta` while the call runs. Kept
   * separate from `result`: `result` is the settled preview (one line, capped),
   * this is the raw scrolling transcript.
   */
  output?: string
  /** Live output was dropped at the client cap — the head is gone, not the tail. */
  outputTruncated?: boolean
}

/** A reasoning ("thinking") block emitted by a reasoning-capable model. */
export interface ReasoningBlock {
  id: string
  step: number
  text: string
  final: boolean
  timestamp: number
  /** True while CoT deltas are still arriving for this step. */
  streaming?: boolean
  /** Epoch ms when the block started (first delta). */
  startedAt?: number
  /** Epoch ms when it finished (final block arrived). */
  endedAt?: number
}

/**
 * A long-running goal the scheduler can execute autonomously.
 *
 * Progress is deliberately expressed as two counters plus an optional ratio
 * rather than a single percentage. When the backend has no decomposed plan,
 * `progressRatio` is null and the UI shows a status label instead of a bar —
 * a made-up percentage is worse than no percentage.
 */
export type GoalStatus =
  | 'started' | 'active' | 'queued' | 'running'
  | 'stopping' | 'stop_timeout'
  | 'paused' | 'completed' | 'failed' | 'ovolve_failed_final' | 'cancelled'

export interface GoalSubtask {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
}

export interface Goal {
  id: string
  description: string
  status: GoalStatus
  /** Continuation rounds consumed so far. */
  iteration: number
  /** Hard ceiling on continuation rounds (circuit breaker). */
  maxIterations: number
  /**
   * False when `maxIterations` is the client-side default rather than a value the
   * backend actually sent. Never render the ceiling — or anything divided by it —
   * when this is false.
   */
  maxIterationsKnown: boolean
  subtasksCompleted: number
  subtasksTotal: number
  /** null when there is no plan to count against. */
  progressRatio: number | null
  plan: GoalSubtask[]
  costUsd: number
  costCapUsd: number
  tokensUsed: number
  /** Why the last run stopped. Empty when it stopped cleanly. */
  lastError: string
  verification: { passed: boolean; reason: string; suggestions: string[] } | null
  sessionId: string
  createdAt: number
  updatedAt: number
  startedAt: number
}

export interface CronJob {
  id: string
  expression: string
  task_name: string
  task_data: Record<string, any>
  status: 'active' | 'paused' | 'stopped'
  created_at: number
  last_run: number
  next_run: number
  run_count: number
}

export interface Memory {
  id: string
  content: string
  type: 'fact' | 'preference' | 'context' | 'procedure'
  importance: number
  tags: string[]
  created_at: number
}

// Git panel (GIT_INTEGRATION.md §1.1)
export type GitChangeKind =
  | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'

export interface GitChange {
  path: string
  kind: GitChangeKind
  staged: boolean
  additions?: number
  deletions?: number
}

export interface GitStatus {
  isGitRepository: boolean
  /**
   * False when no project folder is open at all. Distinct from
   * `isGitRepository: false`, which means a folder IS open but isn't a repo —
   * two different problems with two different ways out, so the header capsule
   * needs to tell them apart.
   */
  workspaceOpen?: boolean
  branch?: string

  user?: string
  ahead?: number
  behind?: number
  status?: 'clean' | 'dirty'
  changes?: GitChange[]
  /** Aggregate line stats for the +N -M bar. */
  additions?: number
  deletions?: number
  recentCommits?: string[]
}

export interface CommitMessageDraft {
  message: string
  type: string
  generated_by: 'llm' | 'heuristic'
}

/** One row in the Git Graph dialog. */
export interface GitCommitRow {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
  refs: string[]
  isHead: boolean
}

/** Sub-agent identities the tool router dispatches to. */
export type AgentRole = 'pilot' | 'file_agent' | 'computer_agent' | 'app_agent' | 'search_agent' | 'browser_agent'
