import { create } from 'zustand'
import { AgentEvent, Message, ReasoningBlock, SubagentActivity, SubagentEntry, SubagentInfo, SubagentToolCall, ToolCall, ToolCallPreview, ToolCallStatus, TurnStatus } from '@apptypes/index'

import { WS_URL, API_BASE, apiFetch, fetchJson, withTokenQuery } from '@lib/api'
import { grantWorkspacesToMain } from '@lib/workspaceGrant'
import { drainStreamThrottle, pushStreamDelta, resetStreamThrottle } from '@lib/streamThrottle'
import { useContextUsageStore } from '@store/contextUsageStore'
import { useSessionConfigStore } from '@store/sessionConfigStore'
import { useQueueStore } from '@store/queueStore'
import { useSessionListStore } from '@store/sessionListStore'
import { useGoalStore } from '@store/goalStore'
import { useEvolutionStore } from '@store/evolutionStore'
import { useNotifyPrefsStore } from '@store/notifyPrefsStore'
import { useSidePanelStore } from '@store/sidePanelStore'
import { isShellTool, useTerminalStore } from '@store/terminalStore'
import type { ContextRef } from '@store/composerContextStore'
import { countTokens, countTokensOf, encodingFor } from '@lib/tokens'
import i18n from '@/i18n'

/**
 * Translate a store-level string. Stores run outside React so they can't use
 * the `useTranslation` hook; the i18next singleton is module-level and safe to
 * call directly. `fallback` is the Chinese copy so a missing key degrades to
 * today's wording instead of a raw key leaking into the timeline.
 */
function t(key: string, fallback: string, vars?: Record<string, unknown>): string {
  try {
    return i18n.t(key, { defaultValue: fallback, ...(vars || {}) }) || fallback
  } catch {
    return fallback
  }
}

/**
 * Why a fold was refused, in words. The backend returns a reason CODE so the
 * copy lives here rather than being hardcoded server-side. Resolved lazily
 * (not at import time) so a runtime language switch is honoured.
 */
const FOLD_REFUSALS: Record<string, { key: string; fallback: string }> = {
  'cooldown': { key: 'store.foldRefusal.cooldown', fallback: '刚折叠过，稍等一会儿再来 —— 连续折叠只会白烧 token。' },
  'under-threshold': { key: 'store.foldRefusal.underThreshold', fallback: '上下文还很宽裕，现在折叠没有收益。' },
  'max-consecutive': { key: 'store.foldRefusal.maxConsecutive', fallback: '连续折叠次数已达上限。先聊一轮，计数会自动清零。' },
  'no-new-content': { key: 'store.foldRefusal.noNewContent', fallback: '上次折叠后还没有新内容可折。' },
  'too-short': { key: 'store.foldRefusal.tooShort', fallback: '对话太短，没什么可折的。' },
  'already-folding': { key: 'store.foldRefusal.alreadyFolding', fallback: '正在折叠中，稍候。' },
}

/** Resolve a fold-refusal code to localized copy (unknown codes included). */
function foldRefusalText(reason: unknown): string {
  const code = typeof reason === 'string' ? reason : ''
  const hit = FOLD_REFUSALS[code]
  if (hit) return t(hit.key, hit.fallback)
  return t('store.foldRefusal.unknown', '暂时无法折叠（{{reason}}）', { reason: code || '未知原因' })
}

/**
 * Fallback wording for why the backend switched models mid-turn, keyed by the
 * recovery DIRECTION (see `llm_errors.RECOVERY`).
 *
 * Only a fallback: the event now carries `failureText`, the precise cause. These
 * strings are deliberately vague about the cause because the direction cannot
 * tell you one — `other_provider` is chosen for exhausted quota, a rejected key,
 * a provider 5xx and a rate limit alike, so naming any single one here would be
 * wrong three times out of four.
 */
const DOWNGRADE_REASONS: Record<string, { key: string; fallback: string }> = {
  'larger_context': { key: 'store.downgrade.largerContext', fallback: '内容超出了原模型的上下文窗口，需要更大窗口的模型' },
  'other_provider': { key: 'store.downgrade.otherProvider', fallback: '原服务商这次没能完成请求' },
  'any_model': { key: 'store.downgrade.anyModel', fallback: '原模型不可用' },
}

/**
 * Idempotency key for one outbound prompt. `crypto.randomUUID` exists in
 * Electron's renderer and every modern browser; the counter suffix on the
 * fallback keeps two sends in the same millisecond distinct.
 */
/**
 * Caps for one sub-agent's drill-down timeline.
 *
 * Eight sub-agents can run at once and each streams tokens at the same rate the
 * main channel does, so an uncapped accumulator is an 8× memory leak that grows
 * for as long as the fan-out runs. We keep the TAIL: the useful question about a
 * child is "where did it get to", never "what was its opening sentence".
 *
 * `ENTRY_CAP` is a count rather than a byte budget because consecutive deltas
 * are MERGED into the tail entry, so entries only accumulate when the child
 * actually alternates between talking and calling tools — which is exactly the
 * thing worth keeping. `CHUNK_CAP` then bounds a single runaway paragraph.
 */
const SUBAGENT_ENTRY_CAP = 400
const SUBAGENT_CHUNK_CAP = 4000

/**
 * How much live command output one tool card keeps. 64KB is roughly 800 lines —
 * past that a human is scrolling, not reading, and the backend already caps its
 * own buffer at 200K. Trimmed from the head so the tail (where the error is)
 * always survives.
 */
const TOOL_OUTPUT_CAP = 64_000

/** Backend grace window before a failed turn becomes terminal. */
export interface TurnRetryWindow {
  error: string
  hint: string
  graceSeconds: number
  msgId: string
  /** Client ms when the window opened — drives the countdown UI. */
  startedAt: number
}

const EMPTY_ACTIVITY: SubagentActivity = { entries: [], truncated: false }

/**
 * Frames that prove a BACKGROUND session's turn is still producing output.
 *
 * Used only to keep the sidebar's liveness dot breathing while the user is
 * looking at a different conversation. Deliberately excludes terminal frames
 * (`agent_response`, `error`) — those settle the badge — and every
 * session/workspace list frame, which says nothing about whether work is
 * happening.
 */
const BACKGROUND_WORKING_EVENTS = new Set<string>([
  'agent_phase', 'task_started', 'agent_delta', 'agent_thinking',
  'reasoning', 'reasoning_delta', 'tool_call', 'tool_call_delta',
  'tool_output_delta', 'tool_result', 'subagent_update', 'subagent_activity',
  'image_generating', 'turn_state', 'subagent_stuck',
])

/** Spurious content tokens (e.g. LongCat leaking "0" before/during CoT). */
export function isCotContentLeak(text: string): boolean {
  const t = String(text).trim()
  if (!t) return true
  if (t.length > 2) return false
  return !/[\p{L}\p{Script=Han}]/u.test(t)
}

function hasMeaningfulAssistantContent(text: string): boolean {
  return !isCotContentLeak(text)
}

/**
 * Fold one `subagent_activity` frame into that sub-agent's timeline.
 *
 * Two ordering rules carry the design:
 *   · consecutive text (or reasoning) deltas merge into the tail entry, so the
 *     timeline is paragraphs-and-tools rather than one entry per token;
 *   · a `tool_result` upgrades the matching `tool` entry IN PLACE by
 *     `toolCallId`, so one tool is one line that goes running → completed. When
 *     no match is found (its `tool_call` frame fell off the cap, or the frames
 *     arrived out of order) the result is appended as its own row — showing a
 *     finished tool with no visible start is honest; dropping it is not.
 */
function foldSubagentActivity(
  prev: SubagentActivity | undefined,
  payload: { kind?: string; text?: string } & Partial<SubagentToolCall>,
): SubagentActivity {
  const base = prev ?? EMPTY_ACTIVITY
  let entries = base.entries
  let truncated = base.truncated

  const appendText = (kind: 'text' | 'reasoning') => {
    const add = payload.text || ''
    if (!add) return
    const tail = entries[entries.length - 1]
    if (tail && tail.kind === kind) {
      let merged = tail.text + add
      if (merged.length > SUBAGENT_CHUNK_CAP) {
        merged = merged.slice(merged.length - SUBAGENT_CHUNK_CAP)
        truncated = true
      }
      entries = [...entries.slice(0, -1), { kind, text: merged }]
    } else {
      entries = [...entries, { kind, text: add } as SubagentEntry]
    }
  }

  switch (payload.kind) {
    case 'text':
      appendText('text')
      break
    case 'reasoning':
      appendText('reasoning')
      break
    case 'tool_call':
      entries = [...entries, {
        kind: 'tool',
        toolCallId: payload.toolCallId || '',
        toolName: payload.toolName || '',
        status: 'running',
      }]
      break
    case 'tool_result': {
      const id = payload.toolCallId || ''
      // Search from the end: a child that calls the same tool twice should
      // resolve the most recent invocation.
      let i = -1
      if (id) {
        for (let k = entries.length - 1; k >= 0; k--) {
          const e = entries[k]
          if (e.kind === 'tool' && e.toolCallId === id) { i = k; break }
        }
      }
      const done: SubagentEntry = {
        kind: 'tool',
        toolCallId: id,
        toolName: payload.toolName
          || (i >= 0 && entries[i].kind === 'tool' ? (entries[i] as SubagentToolCall).toolName : ''),
        status: payload.ok === false ? 'error' : 'completed',
        ok: payload.ok,
        preview: payload.preview,
      }
      if (i === -1) {
        entries = [...entries, done]
      } else {
        entries = entries.slice()
        entries[i] = done
      }
      break
    }
    default:
      return base
  }

  if (entries.length > SUBAGENT_ENTRY_CAP) {
    entries = entries.slice(entries.length - SUBAGENT_ENTRY_CAP)
    truncated = true
  }
  return { entries, truncated }
}

let msgSeq = 0
/** Last outbound user_prompt id — reused for grace-window retries. */
let lastOutboundMsgId = ''
function newMsgId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  msgSeq += 1
  return `m-${Date.now()}-${msgSeq}`
}

/**
 * Recompute the context-window breakdown from the conversation we currently
 * hold, using REAL BPE tokenization (tiktoken via gpt-tokenizer). The encoding
 * is chosen from the active model. Overridden by applyUsage() if the backend
 * ever sends authoritative numbers.
 */
/**
 * recomputeUsage full-scans every message and tool result with real BPE, so
 * calling it on EVERY inbound event made long streaming turns O(n²). Coalesce
 * the hot paths to a trailing-edge timer: at most one scan per interval while
 * tokens stream. Terminal paths and sendMessage still call recomputeUsage
 * directly where an instant gauge matters.
 */
const RECOMPUTE_INTERVAL_MS = 200
let recomputeTimer: ReturnType<typeof setTimeout> | null = null

/** Hard cap on the raw event log kept in the store (see addEvent). */
const MAX_EVENTS = 500

/**
 * Message-derived token total from the last recompute pass. When the store
 * holds a provider-exact figure and this hasn't moved, the exact number is
 * kept instead of being re-clobbered by the estimate (see recomputeUsage).
 */
let lastMessageTokensSeen = -1

function scheduleRecompute(get: () => AgentState) {
  if (recomputeTimer) return
  recomputeTimer = setTimeout(() => {
    recomputeTimer = null
    recomputeUsage(get())
  }, RECOMPUTE_INTERVAL_MS)
}

function recomputeUsage(state: {
  messages: Message[]
  reasoning: ReasoningBlock[]
  toolCalls: ToolCall[]
}) {
  const ctx = useContextUsageStore.getState()

  // Resolve the active model → tokenizer encoding. The tokenizer only affects
  // how good this local estimate is; it never makes the number "exact" in the
  // provider-reported sense, so the byte-exactness of the encoding is no longer
  // read here (see the isEstimated note below).
  const { activeModel } = useSessionConfigStore.getState()
  const [, mid] = activeModel.split(':')
  const enc = encodingFor(mid)

  let userTokens = 0
  let assistantTokens = 0
  for (const m of state.messages) {
    // `system` messages here are local UI errors, not the model's system prompt.
    if (m.role === 'user') userTokens += countTokens(m.content, enc)
    else if (m.role === 'assistant') assistantTokens += countTokens(m.content, enc)
  }

  const reasoningTokens = state.reasoning.reduce((s, r) => s + countTokens(r.text, enc), 0)
  const toolResultTokens = state.toolCalls.reduce(
    (s, tc) => s + countTokensOf(tc.args, enc) + countTokensOf(tc.result, enc),
    0,
  )

  const { systemPromptTokens, toolDefTokens, skillTokens, pendingInputTokens, maxTokens, windowKnown } = ctx.usage
  const messageTokens = userTokens + assistantTokens + reasoningTokens + toolResultTokens
  // System prompt + tool schemas + skills ride on EVERY request — the
  // provider counts them in input_tokens, so the estimate must too. They used
  // to be omitted here, which is why the meter read like the window only
  // contained chat messages.
  const currentTokens =
    systemPromptTokens + toolDefTokens + skillTokens + messageTokens + pendingInputTokens

  // Exact-value stickiness: `applyUsage` writes the provider-reported figure
  // when a `usage` frame lands, but this recompute fires after EVERY frame —
  // including the turn-completed that arrives right after it — so the exact
  // number survived ~200ms before being overwritten. If the store is exact
  // AND the message content this pass would re-measure hasn't changed, keep
  // the exact figure and only refresh the buckets.
  const keepExact = !ctx.usage.isEstimated && messageTokens === lastMessageTokensSeen
  lastMessageTokensSeen = messageTokens

  const max = maxTokens || 200_000
  const turns = state.messages.filter((m) => m.role === 'user').length || 1
  const perTurn = Math.max(Math.ceil(currentTokens / turns), 1)

  if (!keepExact) {
    ctx.update({
      userTokens,
      assistantTokens,
      reasoningTokens,
      toolResultTokens,
      currentTokens,
      usagePercent: (currentTokens / max) * 100,
      estimatedRemainingTurns: Math.max(0, Math.floor((max - currentTokens) / perTurn)),
      // Only claim we're near the limit when the limit is the real model window.
      willExceedLimit: windowKnown ? currentTokens / max > 0.9 : false,
      // `isEstimated` means ONE thing store-wide: "this number is a local guess,
      // not what the provider reported". This path is always a local guess — it
      // counts message text with tiktoken. Whether that tokenizer happens to be
      // the model's own (`exact`) makes the estimate better or worse, but it does
      // not make it a provider-reported figure. Tying the flag to `exact` here
      // while applyUsage/applyAnalytics tied it to "came from the backend" gave
      // the same badge two meanings.
      isEstimated: true,
    })
  } else {
    ctx.update({ userTokens, assistantTokens, reasoningTokens, toolResultTokens })
  }
}

/**
 * Fold a real backend usage payload into the store. Takes precedence over the
 * local estimate whenever the backend actually sends numbers.
 */
function applyUsage(payload: any) {
  if (!payload) return
  const store = useContextUsageStore.getState()
  const tokenCount: number | undefined = payload.tokenCount ?? payload.usage?.total_tokens
  if (typeof tokenCount === 'number') {
    // The frame's overhead breakdown (system prompt / tool schemas / skills)
    // keeps the BETWEEN-turn estimate honest — without it the recompute sums
    // only message text and the meter reads like the window is empty except
    // for chat. Old `system_tokens` key dropped: the backend never sent it.
    const bd = payload.breakdown
    // The backend sends the ACTIVE model's real window (0/absent = unknown).
    // Only ever upgrade unknown→known, mirroring applyAnalytics.
    const frameWindow = typeof payload.contextWindow === 'number' ? payload.contextWindow : 0
    const upgradeWindow = frameWindow > 0 && !store.usage.windowKnown
    const max = upgradeWindow ? frameWindow : (store.usage.maxTokens || 200_000)
    store.update({
      currentTokens: tokenCount,
      ...(upgradeWindow ? { maxTokens: frameWindow, windowKnown: true } : {}),
      usagePercent: (tokenCount / max) * 100,
      ...(bd ? {
        systemPromptTokens: typeof bd.systemPrompt === 'number' ? bd.systemPrompt : store.usage.systemPromptTokens,
        toolDefTokens: typeof bd.tools === 'number' ? bd.tools : store.usage.toolDefTokens,
        skillTokens: typeof bd.skills === 'number' ? bd.skills : store.usage.skillTokens,
      } : {}),
      // Only warn about a limit we actually know.
      willExceedLimit: (upgradeWindow || store.usage.windowKnown) ? tokenCount / max > 0.9 : false,
      isEstimated: false,
    })
  }
  // Cache figures ride the same frame. `cost_source` says whether the money in
  // it is a provider-reported bill or a rate-table estimate; dropping it (as
  // this function used to) left the UI unable to distinguish the two, so a
  // 4-decimal dollar figure looked equally authoritative either way.
  const u = payload.usage
  if (u && (u.cache_read != null || u.cache_creation != null || u.cost_source)) {
    store.updateCache({
      ...(u.cache_read != null ? { cacheReadTokens: u.cache_read } : {}),
      ...(u.cache_creation != null ? { cacheCreationTokens: u.cache_creation } : {}),
      ...(u.cost_source ? { costSource: u.cost_source } : {}),
    })
  }
  if (payload.cacheStats) {
    const cs = payload.cacheStats
    store.updateCache({
      totalMessages: cs.totalMessages ?? 0,
      cachedMessages: cs.cachedMessages ?? 0,
      lastCacheHit: !!cs.lastCacheHit,
      cacheReadTokens: cs.cacheReadTokens,
    })
    if (typeof cs.totalMessages === 'number' && cs.totalMessages > 0) {
      store.update({ cacheHitRate: (cs.cachedMessages ?? 0) / cs.totalMessages })
    }
  }
}

/**
 * A session's live turn, frozen while the user looks at a different one.
 *
 * Exactly the fields a switch would otherwise destroy. `parkedAt` is kept so a
 * buffer can be judged stale if we ever need to (a turn that "finished" while
 * parked is superseded by the history the backend sends on the way back in).
 */
export interface SessionTurnBuffer {
  messages: Message[]
  toolCalls: ToolCall[]
  toolPreviews: ToolCallPreview[]
  reasoning: ReasoningBlock[]
  subagents: SubagentInfo[]
  subagentActivity: Record<string, SubagentActivity>
  streamingMessageId: string | null
  turnStartedAt: number | null
  currentPhase: { phase: string; step?: number; tool?: string; at: number } | null
  parkedAt: number
}

export interface AgentState {
  connected: boolean
  connecting: boolean
  /** True from when the user sends until the assistant's final response arrives.
   *  2.1: now a DERIVED reading of `turnStatus === 'running'`, kept as its own
   *  field because a hundred call sites read it. The authority is `turnStatus`. */
  isWorking: boolean
  /**
   * Persisted turn state (2.1), reconciled from the `turn_state` WS frame on
   * connect / session-switch / every transition. Distinguishes the four things
   * the old boolean could not: running, waiting on the user, paused (resumable),
   * and settled. Survives reload because it lives in the sessions table.
   */
  turnStatus: TurnStatus
  /** Coarse "what's happening now", folded from TurnPhase on the backend. */
  turnSubstatus: string

  /** Id of the in-progress assistant bubble grown by ``agent_delta`` events. */
  streamingMessageId: string | null
  /**
   * The backend's watchdog decided the model is probably rendering an image
   * (token stream went quiet on an image-capable model). Purely a progress
   * hint — it is cleared by the next delta or by the final response, so a false
   * positive costs nothing beyond a briefly-shown label.
   */
  imageGenerating: boolean
  /**
   * Which phase of the turn the backend is in right now — assembling context vs
   * waiting on the model vs running a tool. The backend has emitted `agent_phase`
   * for a while; nothing was listening, so a slow turn showed one
   * undifferentiated spinner and the user could not tell a stuck call from a
   * slow one. Purely observational: never gates anything, cleared when the turn
   * settles. `steps` is total steps when known (shows "第 2/5 步" progress).
   */
  currentPhase: { phase: string; step?: number; steps?: number; tool?: string; at: number } | null
  /**
   * A turn failed but the backend is holding the error for `graceSeconds` so a
   * retry with the same `msgId` can cancel it. Purely observational — the
   * composer stays disabled via `isWorking` until the window closes or a retry
   * lands.
   */
  turnRetryWindow: TurnRetryWindow | null
  /**
   * When the current turn was kicked off (ms, client clock). Stamps
   * `turnStats.durationMs` on the reply when the turn completes. Cleared with
   * the turn; a steer extends the SAME turn so it deliberately keeps the
   * original start.
   */
  turnStartedAt: number | null
  messages: Message[]
  toolCalls: ToolCall[]
  /**
   * Tool calls the model is still WRITING, keyed by the provider's slot index.
   *
   * Deliberately separate from `toolCalls` rather than pre-inserted into it.
   * A previewed call is not a call that will happen: the loop detector, the
   * risk gate, the subagent allowlist and a malformed-arguments bailout can all
   * kill it between generation and execution, and none of them emit a
   * `tool_call`. Parking previews here means a killed one simply disappears
   * instead of leaving a permanent phantom row in the durable list.
   *
   * Ephemeral by construction: an entry is dropped when the real `tool_call`
   * for it arrives, and the whole map is cleared when the turn ends.
   */
  toolPreviews: ToolCallPreview[]
  reasoning: ReasoningBlock[]
  /**
   * Sub-agents spawned by the current turn's `task` calls, newest last.
   *
   * An array rather than a Map because the panel always renders all of them in
   * spawn order, and zustand shallow-compares — swapping one array is cheaper
   * to reason about than mutating a Map and hoping subscribers notice.
   *
   * Terminal entries are KEPT for the rest of the turn (not spliced out) so the
   * user can see that 5 of 6 explorers succeeded and one timed out. The whole
   * list is cleared when a new turn starts, same as `toolCalls`.
   */
  subagents: SubagentInfo[]
  /**
   * Live per-sub-agent activity (text + tool calls), keyed by `subagentId`.
   *
   * A separate map so `subagents` (the roster) doesn't churn on every child
   * token — the roster row is a cheap `Loader2` spinner, but the activity view
   * lives elsewhere and re-renders freely on its slice of state. Cleared on the
   * same triggers as `subagents` (new turn, session switch, disconnect).
   */
  subagentActivity: Record<string, SubagentActivity>
  /**
   * Which sub-agent is currently expanded in the detail view. Null means no
   * drill-down. Kept in the store rather than local state so the chat panel's
   * click can open a detail that the workspace SidePanel tab also reads.
   */
  selectedSubagentId: string | null
  /**
   * Parked live-turn state for sessions the user has navigated AWAY from.
   *
   * The volatile turn fields above (`messages`, `toolCalls`, `reasoning`,
   * `isWorking`, …) describe the session on screen. That is fine while there is
   * one conversation, but a turn keeps running server-side after you leave it,
   * and a switch used to simply blank those fields and reload history from the
   * database. An in-flight reply is not in the database yet, so coming back
   * showed an empty transcript that the still-arriving deltas then rebuilt from
   * scratch — indistinguishable from the agent answering a second time.
   *
   * So a switch now PARKS the outgoing session's turn here and RESTORES the
   * incoming one's if we have it. Switching becomes navigation rather than a
   * teardown, which is the model every multi-chat client uses: each chat keeps
   * its own transcript and you move between them.
   *
   * Only sessions with a live turn are parked — a settled conversation is fully
   * described by the history the backend sends, and buffering those would just
   * be a memory leak that also serves stale text.
   */
  sessionBuffers: Record<string, SessionTurnBuffer>

  sessionId: string
  branchId: string
  isFolding: boolean
  events: AgentEvent[]


  connect: () => void
  disconnect: () => void
  sendMessage: (message: string, contextRefs?: ContextRef[]) => Promise<void>
  /** Re-send the last prompt inside the backend retry grace window. */
  retryTurn: () => boolean
  /** Interrupt the in-flight turn (best-effort) and hand control back. */
  stop: () => void
  /**
   * Pick a paused turn back up where it stopped.
   *
   * Only meaningful when `turnStatus === 'paused'` — the backend refuses
   * anything else, so this is a no-op button rather than a way to start a turn.
   * `text` overrides the default "carry on" nudge when the user wants to add a
   * correction while resuming.
   */
  resumeTurn: (text?: string) => boolean
  /**
   * Pull a user message back for editing: drop it and everything after it from
   * the timeline, and return its text so the caller can refill the composer.
   * Returns null when the id isn't a user message.
   *
   * Everything AFTER it goes too, because an assistant reply to a message that
   * no longer exists reads as a reply to nothing.
   *
   * This is an ATOMIC undo: it also sends `session_truncate` so the backend
   * drops the same span from its session history AND restores the file
   * snapshots that turn captured. Without the server half, the next turn would
   * quietly replay a conversation the user believes they erased.
   */
  editMessage: (id: string) => string | null
  /**
   * Rewind to a timeline checkpoint (UB1): drop the `ordinal`-th user turn and
   * everything after it, and restore the files those turns changed.
   *
   * Same atomic undo as `editMessage`, minus the "refill the composer" part —
   * the user is navigating history here, not rewriting a prompt. Returns false
   * when the ordinal isn't in the current timeline.
   */
  rollbackToOrdinal: (ordinal: number) => boolean
  /**
   * Fork the conversation at a user message (UA1).
   *
   * Additive: the backend copies history up to just before that message into a
   * NEW session and moves this window onto it. Nothing is deleted, so the
   * original line is still there to come back to and compare against.
   *
   * The backend replies with `session_switched`, which repaints the timeline —
   * so this action deliberately does NOT touch `messages`. Returns false when
   * the id isn't a user message in the current timeline.
   */
  forkSession: (id: string) => boolean
  /**
   * The prompt the last fork was taken at, waiting to be dropped into the
   * composer. Read-once: the page consumes it and it clears, so a later
   * re-render can't re-fill a box the user already emptied.
   */
  pendingForkText: string | null
  consumeForkText: () => string | null
  /** Trigger manual context fold/compaction */
  foldContext: () => boolean
  /** Send a raw frame on the live socket. Returns false if not connected. */
  send: (type: string, payload?: Record<string, unknown>) => boolean
  /**
   * Kill ONE running command without stopping the turn — the ✕ on a terminal
   * card. `stop()` aborts everything; this only signals the process tree behind
   * `callId`. The settled result (with whatever it printed before the kill)
   * still arrives as a normal `tool_result`.
   */
  cancelTool: (callId: string) => boolean
  /**
   * Answer a parked tool confirmation by clicking instead of typing 同意.
   *
   * `approve_always` also leaves a standing allowlist rule behind, so the same
   * CLASS of call stops asking — that is the difference between finishing a
   * 30-file refactor and being stopped 30 times. The backend refuses to write
   * such a rule for irreversible steps, so the button is safe to offer here.
   */
  respondPermission: (
    callId: string,
    decision: 'approve' | 'approve_always' | 'deny',
  ) => boolean
  /**
   * Plan 模式方案审批（缺口 B）：后端 plan_ready 事件带来的方案产物，
   * 由用户点「批准执行 / 放弃」后回传 approve_plan 帧；批准后后端以批准时
   * 的权限档自动开执行轮并注入方案合同。
   */
  pendingPlan: { planId: string; preview: string; chars: number } | null
  approvePlan: (decision: 'approve' | 'discard') => boolean
  /** Merge staged shadow overlay into the real workspace. */
  applyShadow: () => Promise<boolean>
  /** Discard staged shadow overlay without merging. */
  discardShadow: () => Promise<boolean>
  /**
   * Answer a parked `ask_user` question by clicking its card.
   *
   * `answers` is keyed by the question's backend `index`, and `picked` holds
   * option indexes — never labels. Sending text back would make the transcript
   * depend on what this client happened to render; the backend owns the wording
   * of the user's own turn.
   *
   * `skipped` is a first-class answer, not a cancel: it tells the model to pick
   * a sensible default and NOT ask again.
   */
  respondQuestion: (
    callId: string,
    answers: { q: number; picked: number[]; text?: string }[],
    skipped?: boolean,
  ) => boolean
  /**
   * 真Steer — inject a fresh user instruction into the running loop so the
   * model course-corrects on the very next step. No-op when nothing is running
   * (fall back to `sendMessage` / normal enqueue). Adds the injected message to
   * the timeline optimistically so the user sees their guidance land instantly.
   */
  steer: (text: string, options?: { immediate?: boolean; urgent_interrupt?: boolean }) => boolean
  /** Open (or, with null, close) the sub-agent drill-down. */
  selectSubagent: (subagentId: string | null) => void
  addEvent: (event: AgentEvent) => void
}

/**
 * Stall watchdog — the last line of defence against a turn that never ends.
 *
 * The backend calls `router.handle()` unguarded (no try/except around it), so an
 * unhandled exception there emits NO terminal event. Today the socket teardown
 * happens to rescue us via `onclose`, but that is luck, not design. If anything
 * ever swallows that exception while keeping the socket alive, the composer
 * would be pinned in "working" forever with no way out but a reload.
 *
 * So: if `isWorking` is true and NOT ONE event arrives for this long, give the
 * user control back and say so. Deliberately generous — a reasoning model plus
 * the provider retry backoff can legitimately go quiet for tens of seconds, and
 * a false trip is worse than a slow rescue.
 */
const STALL_TIMEOUT_MS = 90_000
let stallTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Auto-reconnect for the backend socket. A dropped backend (restart, sleep/
 * wake, network blip) used to leave the UI "未连接" forever — every send then
 * failed and the queue went stale until the user reloaded the window. Retry
 * with capped exponential backoff instead. `disconnect()` opts out (window
 * close, explicit teardown); a successful open resets the attempt counter.
 */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let intentionalClose = false
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

function scheduleReconnect(get: () => AgentState) {
  if (intentionalClose || reconnectTimer) return
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    get().connect()
  }, delay)
}

function clearStallTimer() {
  if (stallTimer) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

/**
 * True when a tool call is parked waiting on the user (`ask_user`). The turn is
 * deliberately suspended server-side, so silence here means "your move", not
 * "something died".
 */
function isAwaitingUser(state: AgentState): boolean {
  // `needs_input` = an ask_user card is open; `needs_confirmation` = an
  // approval bar is open. Both park the turn server-side on purpose, so
  // silence means "your move", not "something died". Only checking the first
  // made the watchdog kill turns parked on a permission prompt after 90s.
  return state.toolCalls.some(
    (tc) => tc.status === 'needs_input' || tc.status === 'needs_confirmation',
  )
}

/**
 * (Re)start the silence countdown. Called on every inbound event while a turn is
 * live, so it only fires after genuine total silence — not merely a slow turn.
 *
 * Note: the message is hardcoded rather than i18n'd because stores can't call
 * hooks, matching the existing "backend not connected" string in `sendMessage`.
 */
function armStallTimer(set: any, get: () => AgentState) {
  clearStallTimer()
  stallTimer = setTimeout(() => {
    stallTimer = null
    if (!get().isWorking) return
    // A question on screen is the one legitimate reason for a long silence:
    // the backend is holding that tool call open. Killing the turn here would
    // throw away the answer's only destination.
    if (isAwaitingUser(get())) return
    set((state: AgentState) => ({
      messages: [...state.messages, {
        id: `stall-${Date.now()}`,
        role: 'system' as const,
        content: t('store.stallTimeout', '这一轮超过 90 秒没有任何响应，已自动结束。请检查后端日志，或到「设置 → 模型与服务商」确认 API Key 与接口地址。'),
        timestamp: Date.now() / 1000,
      }],
      isWorking: false,
      // The watchdog firing IS a failure, so keep the two axes telling the same
      // story locally. Not `idle`: idle would read as "nothing ever happened",
      // and it would also make the resume button look legitimate. If the backend
      // is actually alive, its next `turn_state` frame overrides this anyway.
      turnStatus: 'error' as const,
      turnSubstatus: '',
      streamingMessageId: null,
      ...settleActivity(state),
    }))
  }, STALL_TIMEOUT_MS)
}

/** Map a backend tool_result status onto the UI lifecycle. */
function toStatus(payload: any): ToolCallStatus {
  const raw = payload?.status
  if (raw === 'denied' || raw === 'needs_confirmation' || raw === 'needs_input') return raw
  return payload?.ok === false ? 'failed' : 'completed'
}

/**
 * Settle any in-flight activity that will NEVER receive a completion event.
 *
 * Called on every terminal path: `completed/idle/waiting`, `error`, `ws.onclose`,
 * `ws.onerror`, and `stop()`. Without this, tool rows stay `running` forever
 * and reasoning blocks keep their live spinner after the turn is dead.
 *
 * This is the single fix for the "thinking chain / tool call UI looks broken"
 * symptom when a turn ends abnormally (API key error, stream abort, user stop).
 *
 * Sub-agents are settled here too. They used to be left out: `ws.onclose` reset
 * the connection flags and called this function, but the returned object only
 * carried `toolCalls`/`reasoning`/`imageGenerating`/`currentPhase`, so
 * `subagents` and `subagentActivity` survived untouched and every child stayed
 * pinned at `running` forever — a spinner for work that stopped existing when
 * the socket did, and one that no later frame can clear because the child's
 * completion event was on the socket that died.
 */
function settleActivity(
  state: Pick<AgentState, 'toolCalls' | 'reasoning' | 'subagents' | 'subagentActivity'>
) {
  const toolCalls = state.toolCalls.map(tc =>
    tc.status === 'running' || tc.status === 'pending'
      ? { ...tc, status: 'interrupted' as const, completedAt: Date.now() / 1000 }
      : tc
  )
  const reasoning = state.reasoning.map(r =>
    r.streaming ? { ...r, streaming: false } : r
  )
  // `stale` (not `error`) is the honest label: we never learned the outcome.
  const now = Date.now()
  const subagents = state.subagents.map(sa =>
    sa.status === 'spawning' || sa.status === 'running'
      ? {
          ...sa,
          status: 'stale' as const,
          finishedAt: sa.finishedAt ?? now / 1000,
          elapsedMs: sa.elapsedMs || (sa.startedAt ? now - sa.startedAt * 1000 : 0),
        }
      : sa
  )
  // Same for the child transcripts: a tool row inside the drill-down spins on
  // `running`, and its result frame is gone with the socket.
  let activityChanged = false
  const subagentActivity: typeof state.subagentActivity = {}
  for (const [id, act] of Object.entries(state.subagentActivity)) {
    let touched = false
    const entries = act.entries.map(e => {
      if (e.kind === 'tool' && e.status === 'running') {
        touched = true
        return { ...e, status: 'error' as const, preview: e.preview || '连接中断，结果未知' }
      }
      return e
    })
    activityChanged = activityChanged || touched
    subagentActivity[id] = touched ? { ...act, entries } : act
  }
  return {
    toolCalls,
    reasoning,
    subagents,
    ...(activityChanged ? { subagentActivity } : {}),
    // A half-written tool call has no meaning once the turn is over. Any preview
    // still here either became a real `toolCall` (and was already dropped) or was
    // killed before execution — leaving it on screen would claim something ran.
    toolPreviews: [],
    imageGenerating: false,
    currentPhase: null,
  }
}


/** Lazily-remembered permission so we only prompt once per app run. */
let notifyPermissionAsked = false

/**
 * Fire a Windows/OS notification when a session finishes.
 *
 * Two transports, in order of preference:
 *  1. `system:notify` IPC → main process `new Notification()` from `electron`.
 *     This is the real native path: it carries the app icon, is grouped under
 *     our AppUserModelId in the Action Center, and its click handler can focus
 *     the window AND jump to the session that finished.
 *  2. Web `Notification` in the renderer — the fallback for `pnpm dev` in a
 *     plain browser, where there is no IPC bridge at all.
 *
 * Intentionally silent when:
 *  - the settled session IS the one the user is looking at AND the window is
 *    focused — they can already see the result, a toast would be noise;
 *  - permission was denied (web path only; the native path needs none).
 */
function notifyTurnDone(sessionId: string, ok: boolean, title: string) {
  try {
    const prefs = useNotifyPrefsStore.getState()
    if (!prefs.enabled) return
    if (prefs.failuresOnly && ok) return

    const isActive = sessionId === useSessionListStore.getState().activeId
    const focused = typeof document !== 'undefined' && document.hasFocus()
    // Nothing to alert about if the user is already watching this session —
    // unless they explicitly asked to be pinged either way.
    if (isActive && focused && !prefs.whenFocused) return


    const label = title?.trim() || t('store.notify.untitled', '未命名对话')
    const heading = ok ? t('store.notify.doneHeading', '任务已完成，可以验收了') : t('store.notify.failHeading', '任务失败，请查看')
    const body = ok
      ? t('store.notify.doneBody', '「{{label}}」已处理完毕', { label })
      : t('store.notify.failBody', '「{{label}}」执行时出错', { label })

    // ── Preferred: native OS toast via the main process ──
    const api = (window as any)?.electronAPI
    if (api?.isElectron && typeof api.invoke === 'function') {
      api.invoke('system:notify', { title: heading, body, sessionId }).catch(() => {})
      return
    }

    // ── Fallback: web Notification (browser dev, no Electron bridge) ──
    if (typeof window === 'undefined' || !('Notification' in window)) return
    const show = () => {
      if (Notification.permission !== 'granted') return
      new Notification(heading, { body, tag: `ovolve-turn-${sessionId}` })
    }
    if (Notification.permission === 'granted') {
      show()
    } else if (Notification.permission === 'default' && !notifyPermissionAsked) {
      notifyPermissionAsked = true
      Notification.requestPermission().then(() => show()).catch(() => {})
    }
  } catch {
    // A denied/blocked notification must never break the turn lifecycle.
  }
}

/** Resolve which session an event refers to, falling back to the active one. */
function eventSessionId(data: any, get: () => AgentState): string {
  return data.sessionId || data.payload?.sessionId || get().sessionId || ''
}



export const useAgentStore = create<AgentState>((set, get) => ({
  pendingPlan: null,
  connected: false,
  connecting: false,
  isWorking: false,
  turnStatus: 'idle',
  turnSubstatus: '',
  streamingMessageId: null,
  imageGenerating: false,
  currentPhase: null,
  turnRetryWindow: null,
  turnStartedAt: null,
  messages: [],
  toolCalls: [],
  toolPreviews: [],
  reasoning: [],
  subagents: [],
  subagentActivity: {},
  selectedSubagentId: null,
  sessionBuffers: {},
  sessionId: '',
  branchId: '',
  isFolding: false,
  events: [],



  connect: () => {
    // A reconnect firing while a healthy socket exists (or one is still
    // connecting) must not stack a second WebSocket.
    if (get().connected || get().connecting) return
    intentionalClose = false
    set({ connecting: true })
    // The token rides in the query string because the browser's WebSocket
    // constructor cannot set headers. Same secret, same loopback socket — the
    // only difference is that a query string is more likely to reach a log.
    const ws = new WebSocket(withTokenQuery(WS_URL))
    ;(get() as any)._ws = ws

    ws.onopen = () => {
      reconnectAttempts = 0
      set({ connected: true, connecting: false })
      // Immediately ask for session + workspace lists so the sidebar populates
      // on connect rather than waiting for the first user action.
      try {
        ws.send(JSON.stringify({ type: 'session_list', payload: {}, timestamp: Date.now() }))
        ws.send(JSON.stringify({ type: 'workspace_list', payload: {}, timestamp: Date.now() }))
        // Handoff from Electron: main.ts loads new windows with `?workspace=…`
        // to say "this window is for that folder". Fire an explicit switch so
        // the router (shared across windows) actually points at it. The
        // workspaces_list broadcast keeps the other windows in sync.
        if (typeof window !== 'undefined') {
          try {
            const hinted = new URL(window.location.href).searchParams.get('workspace')
            if (hinted) {
              grantWorkspacesToMain(hinted)
              ws.send(JSON.stringify({ type: 'workspace_switch', payload: { path: hinted }, timestamp: Date.now() }))
            }
          } catch {}
        }
      } catch {}
    }

    ws.onmessage = (event) => {
      try {
        const data: AgentEvent = JSON.parse(event.data)
        get().addEvent(data)
        const p = (data.payload || {}) as Record<string, any>
        const eventSid = data.sessionId || (data as any).session_id || p.sessionId || p.session_id || ''
        const activeSid = get().sessionId || ''
        const isCurrentSession = !eventSid || !activeSid || eventSid === activeSid

        // If this event belongs to a background session (not the currently viewed one):
        // Update sidebar liveness badges and exit, avoiding pollution of foreground messages/tools.
        if (!isCurrentSession) {
          if (data.type === 'agent_response') {
            const ok = (data.payload?.result ?? 'success') !== 'error'
            useSessionListStore.getState().markSettled(eventSid, ok)
            useSessionListStore.getState().refresh()
            const title = useSessionListStore.getState().sessions.find(s => s.id === eventSid)?.title || ''
            notifyTurnDone(eventSid, ok, title)
          } else if (data.type === 'error') {
            useSessionListStore.getState().markSettled(eventSid, false)
          } else if (BACKGROUND_WORKING_EVENTS.has(data.type)) {
            // Any frame that means "a turn is producing output" keeps the sidebar
            // dot breathing. Scoping this to `agent_phase`/`task_started` alone
            // was the gap: a session grinding through one long tool call emits
            // `tool_call` / `tool_output_delta` / `agent_delta` for minutes
            // without a fresh phase, so its dot went dark while it was busiest.
            useSessionListStore.getState().markWorking(eventSid)
          }
          // Navigation events (session_switched, session_forked, etc.) must always pass through
          // because they carry the NEW session's ID which doesn't match the OLD activeSid yet.
          // Global list sync events also continue through.
          const passthrough = [
            'session_list', 'workspace_list', 'goal_state_change', 'evolution_proposal',
            'evolution_insight',
            'session_switched', 'session_forked', 'session_truncated', 'pending_questions',
          ]
          if (!passthrough.includes(data.type)) {
            return
          }
        }

        // Every inbound event resets the stall watchdog — only TOTAL silence
        // (no events at all for 90s) triggers the rescue. Individual slow paths
        // (provider retry, reasoning model thinking 30s) still emit SOMETHING
        // (tool_call, reasoning_delta, even pong), keeping the timer happy.
        if (get().isWorking) {
          armStallTimer(set, get as () => AgentState)
        }

        if (data.type === 'folded') {
          // Drop a fold marker into the timeline. An auto-fold is otherwise
          // invisible, which reads as "the agent silently forgot things".
          const p = data.payload || {}
          set(state => ({
            isFolding: false,
            messages: [...state.messages, {
              id: `fold-${data.timestamp}`,
              role: 'system' as const,
              content: '',
              timestamp: data.timestamp,
              kind: 'fold' as const,
              fold: {
                strategy: p.strategy ?? 'engineering',
                tokensBefore: p.tokensBefore ?? 0,
                estimatedTokensAfter: p.estimatedTokensAfter ?? 0,
                compressionRatio: p.compressionRatio ?? 1,
                manual: !!p.manual,
                summary: p.summary ?? '',
                // 折叠水位审计字段（reserve-floor）；旧后端缺省 undefined
                ...(typeof p.freeTokensAfter === 'number' ? { freeTokensAfter: p.freeTokensAfter } : {}),
                ...(typeof p.reserveFloor === 'number' ? { reserveFloor: p.reserveFloor } : {}),
                ...(typeof p.floorMet === 'boolean' ? { floorMet: p.floorMet } : {}),
                ...(typeof p.floorEnforced === 'boolean' ? { floorEnforced: p.floorEnforced } : {}),
              },
            }],
          }))
          recomputeUsage(get())
          // 实时触发 token 仪表盘重新统计刷新
          try {
            const sid = get().sessionId
            const qs = sid ? `?session_id=${encodeURIComponent(sid)}` : ''
            void fetchJson<any>(`${API_BASE}/api/token-analytics${qs}`).then((snap: any) => {
              if (snap && snap.breakdown) useContextUsageStore.getState().applyAnalytics(snap)
            }).catch(() => {})
          } catch {}
          return
        }

        if (data.type === 'context_precheck') {
          // The pre-send window fit check. Two things worth telling the user, and
          // the backend only emits when one of them is true:
          //   pruned > 0   → old tool output was trimmed out from under the model
          //   fits = false → it is STILL over the line, so a length error is
          //                  coming and it is not something they did wrong.
          // Silence here is what used to make both look like the agent randomly
          // forgetting things, or randomly failing.
          const p = data.payload || {}
          const pruned = typeof p.pruned === 'number' ? p.pruned : 0
          const fits = p.fits !== false
          if (pruned > 0 || !fits) {
            const content = !fits
              ? t('store.precheck.overflow',
                  '这一步的上下文（约 {{after}} tokens，含系统提示与工具定义 {{overhead}}）超过了本模型可用窗口 {{ceiling}}，已尽量剪短仍未装下。建议换一个窗口更大的模型，或手动折叠后重试。',
                  { after: p.tokensAfter ?? 0, overhead: p.overheadTokens ?? 0, ceiling: p.ceiling ?? 0 })
              : t('store.precheck.pruned',
                  '为了装进模型窗口，已就地剪短 {{count}} 条较早的工具输出（{{before}} → {{after}} tokens）。完整内容仍保留在会话记录里。',
                  { count: pruned, before: p.tokensBefore ?? 0, after: p.tokensAfter ?? 0 })
            set(state => ({
              messages: [...state.messages, {
                id: `precheck-${data.timestamp}-${p.step ?? 0}`,
                role: 'system' as const,
                content,
                timestamp: data.timestamp,
              }],
            }))
          }
          return
        }

        if (data.type === 'fold_result') {
          set({ isFolding: false })
          // Only surface the REFUSAL here — a successful fold already arrived as
          // a `folded` event, and showing both would double-report it.
          const p = data.payload || {}
          if (!p.ok) {
            set(state => ({
              messages: [...state.messages, {
                id: `foldfail-${data.timestamp}`,
                role: 'system' as const,
                content: foldRefusalText(p.reason),
                timestamp: data.timestamp,
              }],
            }))
          }
          return
        }

        if (data.type === 'queue_state') {
          // Server is the source of truth for the pending-prompts queue.
          useQueueStore.getState().applySnapshot(data.payload || {})
          return
        }

        if (data.type === 'plan_ready') {
          // 方案产物就绪：弹审批卡（缺口 B）。plan_approved/plan_discarded
          // 是回执——无论哪个窗口点的，全端清掉挂起的卡。
          const p = data.payload || {}
          set({ pendingPlan: { planId: p.planId || '', preview: p.preview || '', chars: p.chars || 0 } })
          return
        }
        if (data.type === 'plan_approved' || data.type === 'plan_discarded') {
          set({ pendingPlan: null })
          return
        }

        if (data.type === 'steer_applied') {
          if (data.payload?.queue) {
            useQueueStore.getState().applySnapshot(data.payload.queue)
          }
          return
        }

        if (data.type === 'task_started') {
          // Turns the SERVER started on its own (draining the queue) have no
          // local sendMessage() to render the user bubble or reset the per-turn
          // activity feed — do it here. User-initiated turns already did it
          // optimistically, so skip those to avoid a duplicate bubble.
          if (data.payload?.source === 'queue') {
            const text = data.payload?.message ?? ''
            set(state => ({
              messages: text.trim()
                ? [...state.messages, {
                    id: `q-${data.timestamp}`,
                    role: 'user' as const,
                    content: text,
                    timestamp: data.timestamp,
                  }]
                : state.messages,
              isWorking: true,
            streamingMessageId: null,
            toolCalls: [],
            toolPreviews: [],
              reasoning: [],
              subagents: [],
              subagentActivity: {},
              selectedSubagentId: null,
              currentPhase: null,
            }))
          }
          // Sidebar liveness: this session is now working. Also flags OTHER
          // windows watching the sidebar so they see the animated dot.
          const sid = data.sessionId || data.payload?.sessionId || ''
          if (sid) useSessionListStore.getState().markWorking(sid)
          scheduleRecompute(get)
          return
        }

        if (data.type === 'image_generating') {
          // Backend watchdog hint: the stream went quiet on an image-capable
          // model. Only a progress label — cleared by the next delta or the
          // final response below, so a false positive is self-healing.
          set({ imageGenerating: true })
          scheduleRecompute(get)
          return
        }

        if (data.type === 'model_downgraded') {
          const p = data.payload || {}
          // If the model identity is identical (silent provider/key failover), do NOT pollute the chat UI with a scary alert banner.
          if (p.fromModel && p.toModel && p.fromModel === p.toModel) {
            return
          }
          // The model the user picked failed, and the backend recovered by
          // switching to a different one (UD2). Surface it in the timeline.
          const reasonText =
            (typeof p.failureText === 'string' && p.failureText.trim())
              || (DOWNGRADE_REASONS[p.reason] && t(DOWNGRADE_REASONS[p.reason].key, DOWNGRADE_REASONS[p.reason].fallback))
              || t('store.downgrade.unavailable', '当前模型不可用')
          const from = p.fromModel ? `${p.fromModel} → ` : ''
          const to = p.toProvider ? `${p.toModel}（${p.toProvider}）` : p.toModel
          const content = t('store.downgrade.switched', '{{reason}}，已切换：{{from}}{{to}}', { reason: reasonText, from, to })
          set(state => {
            // Coalesce a run of identical notices. A single turn can retry the
            // same failing model across several agent steps, and each attempt
            // emits its own event; without this guard the transcript fills with
            // the same "switched provider" line. Same text back-to-back = one row.
            const last = state.messages[state.messages.length - 1]
            if (last && last.role === 'system' && last.content === content) {
              return state
            }
            return {
              messages: [...state.messages, {
                id: `downgrade-${data.timestamp}`,
                role: 'system' as const,
                content,
                timestamp: data.timestamp,
              }],
            }
          })
          recomputeUsage(get())
          return
        }

        if (data.type === 'moa_advisors') {
          const p = data.payload || {}
          const phase = String(p.phase || 'asking') as 'asking' | 'answered'
          const moaPayload = {
            phase,
            advisors: p.advisors || [],
            opinions: p.opinions || [],
            elapsed_s: p.elapsed_s,
          }
          set(state => {
            const existingIdx = state.messages.findIndex(
              m => m.kind === 'moa' && m.moa?.phase === 'asking' && phase === 'answered'
            )
            if (existingIdx >= 0 && phase === 'answered') {
              const updated = [...state.messages]
              updated[existingIdx] = {
                ...updated[existingIdx],
                id: `moa-answered-${data.timestamp}`,
                moa: moaPayload,
                timestamp: data.timestamp,
              }
              return { messages: updated }
            }
            return {
              messages: [...state.messages, {
                id: `moa-${phase}-${data.timestamp}`,
                role: 'system' as const,
                content: '',
                kind: 'moa' as const,
                moa: moaPayload,
                timestamp: data.timestamp,
              }],
            }
          })
          return
        }

        if (data.type === 'red_team_alert') {
          const p = data.payload || {}
          const count = Number(p.count || 0)
          if (!count) return
          set(state => ({
            messages: [...state.messages, {
              id: `redteam-${data.timestamp}`,
              role: 'system' as const,
              content: '',
              kind: 'red_team' as const,
              redTeam: {
                count,
                sources: p.sources || [],
                findings: p.findings || [],
              },
              timestamp: data.timestamp,
            }],
          }))
          return
        }

        if (data.type === 'shadow_validation' || data.type === 'shadow_applied') {
          const p = data.payload || {}
          const shadowPayload = data.type === 'shadow_applied'
            ? {
                ok: true,
                pending_apply: false,
                applied: p.applied || [],
                deleted: p.deleted || [],
                changes: [],
              }
            : {
                ok: p.ok,
                pending_apply: p.pending_apply,
                mode: p.mode,
                issue_count: p.issue_count,
                error_count: p.error_count,
                warning_count: p.warning_count,
                issues: p.issues || [],
                changes: p.changes || [],
                paths: p.paths || [],
                auto_apply_blocked: p.auto_apply_blocked,
              }
          set(state => ({
            messages: [...state.messages, {
              id: `shadow-${data.timestamp}`,
              role: 'system' as const,
              content: '',
              kind: 'shadow' as const,
              shadow: shadowPayload,
              timestamp: data.timestamp,
            }],
          }))
          return
        }

        if (data.type === 'context_refs_resolved') {
          // What the backend actually managed to read from this turn's @ refs
          // (UB2). Reported in the timeline rather than on the chip because the
          // chips are cleared the moment the message is sent — by the time this
          // arrives there is no chip left to annotate. And it has to be reported
          // SOMEWHERE: a file that silently failed to resolve produces a reply
          // that quietly ignores it, which reads as the model being unhelpful
          // rather than as the attachment being broken.
          const p = data.payload || {}
          const total = Number(p.total || 0)
          if (total === 0) return
          const resolved = Number(p.resolved || 0)
          const failed = Number(p.failed || 0)
          const tokens = Number(p.tokens || 0)
          const truncated = Number(p.truncated || 0)
          const bits = [t('store.refs.loaded', '已读取 {{resolved}}/{{total}} 项引用', { resolved, total })]
          if (tokens) bits.push(`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`)
          if (truncated) bits.push(t('store.refs.truncated', '{{count}} 项因预算被截断', { count: truncated }))
          const items: any[] = Array.isArray(p.items) ? p.items : []
          const misses = items.filter((it) => !it?.ok)
            .map((it) => `${it?.label || it?.ref}（${it?.error || t('store.refs.unknownReason', '未知原因')}）`)
          if (failed && misses.length) bits.push(t('store.refs.unread', '未读取：{{list}}', { list: misses.join('、') }))
          set(state => ({
            messages: [...state.messages, {
              id: `refs-${data.timestamp}`,
              role: 'system' as const,
              content: bits.join(' · '),
              timestamp: data.timestamp,
            }],
          }))
          scheduleRecompute(get)
          return
        }

        if (data.type === 'agent_delta') {
          const piece = data.payload?.text ?? ''
          const sid = get().streamingMessageId
          if (!piece.trim() && !sid) return
          if (!piece) return
          // 修复：在推入 throttle 前过滤 CoT 泄露 token（如 "0" / 标点）
          if (isCotContentLeak(piece) && !sid) return

          const applyDelta = (text: string) => {
            if (!text) return
            set(state => {
              const currentSid = state.streamingMessageId
              let existing = ''
              if (currentSid) {
                const idx = state.messages.findIndex(m => m.id === currentSid)
                if (idx >= 0) existing = state.messages[idx].content
              }
              // 如果已有内容不是实质内容，或者刚开始输出，过滤纯数字/标点残留
              if (!hasMeaningfulAssistantContent(existing)) {
                if (isCotContentLeak(text)) return state
                // 去除可能粘连的孤立数字前缀（如 "0你好" -> "你好"）
                const cleaned = text.replace(/^[0-9\s，。、！？.,!?:;；：]+/, '')
                if (!cleaned || isCotContentLeak(cleaned)) return state
                text = cleaned
                existing = ''
              }
              const currentSid2 = state.streamingMessageId
              if (currentSid2) {
                const idx = state.messages.findIndex(m => m.id === currentSid2)
                if (idx >= 0) {
                  const next = [...state.messages]
                  next[idx] = {
                    ...next[idx],
                    content: existing + text,
                  }
                  return { messages: next, isWorking: true, imageGenerating: false }
                }
              }
              const id = `stream-${Date.now()}`
              return {
                messages: [...state.messages, {
                  id,
                  role: 'assistant' as const,
                  content: existing + text,
                  timestamp: data.timestamp,
                }],
                streamingMessageId: id,
                isWorking: true,
              }
            })
          }

          pushStreamDelta(piece, applyDelta)
          return
        } else if (data.type === 'agent_response') {
          drainStreamThrottle()
          resetStreamThrottle()
          useSessionListStore.getState().refresh()
          // Final answer: finalize the streaming bubble if present, else append.
          // Also SEAL this turn's activity (tool calls + reasoning) into the
          // message, because the store-root copies get wiped on the next send.
          const finalText = data.payload?.message ?? ''
          // Generated images travel as lightweight refs (id/url/mime/bytes/name).
          // The bytes stay on disk — an ImageRef never carries the pixels, so
          // attaching this to the message costs almost nothing per re-render.
          const finalImages = Array.isArray(data.payload?.images) ? data.payload.images : undefined
          // An image-only turn is legitimate ("here's the picture"), so the
          // "no text ⇒ drop" guard below must relax when images landed.
          const hasImages = !!(finalImages && finalImages.length)
          set(state => {
            const sealed = {
              toolCalls: state.toolCalls.length ? [...state.toolCalls] : undefined,
              reasoning: state.reasoning.length
                ? state.reasoning.map(r => ({ ...r, streaming: false }))
                : undefined,
              ...(hasImages ? { images: finalImages } : {}),
            }
            const sid = state.streamingMessageId
            if (sid) {
              const idx = state.messages.findIndex(m => m.id === sid)
              if (idx >= 0) {
                let resolved = finalText || state.messages[idx].content
                if (state.reasoning.length && isCotContentLeak(resolved)) {
                  resolved = ''
                }
                // A turn that produced no text at all (e.g. the model only
                // asked a clarifying question through another channel) must not
                // leave an empty bubble behind — drop it instead. An image-only
                // turn keeps its bubble because the image IS the content.
                if (!resolved.trim() && !hasImages) {
                  return {
                    messages: state.messages.filter((_, i) => i !== idx),
                    streamingMessageId: null,
                    isWorking: false,
                    imageGenerating: false,
                  }
                }
                const next = [...state.messages]
                // Prefer the presented final text (may differ slightly from
                // raw streamed tokens after output guards).
                next[idx] = {
                  ...next[idx],
                  content: resolved,
                  timestamp: data.timestamp,
                  ...sealed,
                }
                return {
                  messages: next,
                  streamingMessageId: null,
                  isWorking: false,
                }
              }
            }
            // No streaming bubble. Only append if there is actually something
            // to show; an empty final response just ends the turn — unless the
            // model produced images this turn.
            if (!finalText.trim() && !hasImages) {
              return { streamingMessageId: null, isWorking: false }
            }
            return {
              messages: [...state.messages, {
                id: Date.now().toString(),
                role: 'assistant' as const,
                content: finalText,
                timestamp: data.timestamp,
                ...sealed,
              }],
              streamingMessageId: null,
              isWorking: false,
            }
          })
        } else if (
          data.type === 'completed' ||
          data.type === 'idle' ||
          data.type === 'waiting'
        ) {
          // Terminal / hand-back-to-user states. Without these the composer
          // stays disabled forever if the backend ends a turn without sending
          // an `agent_response` (e.g. it stopped to ask the user something).
          set(state => {
            const sid = state.streamingMessageId
            const idx = sid ? state.messages.findIndex(m => m.id === sid) : -1
            const stale = idx >= 0 && !state.messages[idx].content.trim()
            let messages = stale ? state.messages.filter((_, i) => i !== idx) : state.messages
            // Badge the reply with what the turn cost. Only on a real
            // `completed` (not idle/waiting): the backend attaches its per-turn
            // accounting — tokens and money, already priced — to that frame.
            if (data.type === 'completed') {
              const u = data.payload?.usage || {}
              const startedAt = state.turnStartedAt
              const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
              if (lastAssistant && !lastAssistant.turnStats) {
                const stats: Message['turnStats'] = {
                  durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
                  tokens: typeof u.tokens === 'number' ? u.tokens : undefined,
                  costMicros: typeof u.cost_micros === 'number' ? u.cost_micros : undefined,
                  // Carried so the bubble can say whether that dollar figure is
                  // a bill or a rate-table estimate. The backend has always sent
                  // it; this line used to drop it, leaving a 4-decimal number
                  // with no way to tell the two apart.
                  costSource: typeof u.cost_source === 'string' ? u.cost_source : undefined,
                }
                messages = messages.map(m =>
                  m.id === lastAssistant.id ? { ...m, turnStats: stats } : m,
                )
              }
            }
            return {
              isWorking: false,
              turnStartedAt: null,
              streamingMessageId: null,
              turnRetryWindow: null,
              messages,
              ...settleActivity(state),
            }
          })
          // Sidebar dot + OS notification. `ok` mirrors the error-side check
          // at line 233 (payload.ok === false ⇒ failed). For plain `idle`/
          // `waiting` we treat it as done, since no error was reported.
          const settledSid = eventSessionId(data, get)
          // The backend reports the outcome as `payload.result: 'success' | 'error'`.
          // This read `payload.ok`, a field nothing ever sends, so it was always
          // undefined and `!== false` was always true — every failed turn got a
          // green "done" in the sidebar and a success notification.
          const ok = (data.payload?.result ?? 'success') !== 'error'
          if (settledSid) {
            useSessionListStore.getState().markSettled(settledSid, ok)
            useSessionListStore.getState().refresh()
            const title =
              useSessionListStore.getState().sessions.find(s => s.id === settledSid)?.title || ''
            notifyTurnDone(settledSid, ok, title)
          }
        } else if (data.type === 'turn_retry_window') {
          const p = data.payload || {}
          const grace = Number(p.graceSeconds) || 15
          set({
            turnRetryWindow: {
              error: String(p.error || ''),
              hint: String(p.hint || ''),
              graceSeconds: grace,
              msgId: String(p.msgId || lastOutboundMsgId || ''),
              startedAt: Date.now(),
            },
          })
        } else if (data.type === 'reasoning_delta') {
          // Live CoT. Grow the block for this step so the UI can type it out
          // instead of showing nothing for 30s while a reasoning model thinks.
          const piece = data.payload?.text ?? ''
          if (!piece) return
          const step = data.payload?.step ?? 0
          set(state => {
            const idx = state.reasoning.findIndex(r => r.step === step && r.streaming)
            if (idx >= 0) {
              const next = [...state.reasoning]
              next[idx] = { ...next[idx], text: next[idx].text + piece }
              return { reasoning: next }
            }
            return {
              reasoning: [...state.reasoning, {
                id: `r-${step}-${data.timestamp}`,
                step,
                text: piece,
                final: false,
                timestamp: data.timestamp,
                streaming: true,
                startedAt: data.timestamp,
              }],
            }
          })
        } else if (data.type === 'reasoning') {
          // Consolidated block at the end of the step. If we were already
          // streaming this step, close that block out (keeping its startedAt so
          // the duration read-out is real) rather than appending a duplicate.
          set(state => {
            const idx = state.reasoning.findIndex(r => r.step === (data.payload.step ?? 0) && r.streaming)
            const full = data.payload.text ?? ''
            if (idx >= 0) {
              const next = [...state.reasoning]
              next[idx] = {
                ...next[idx],
                // Prefer the consolidated text — deltas can drop pieces on a
                // reconnect, the final payload is authoritative.
                text: full || next[idx].text,
                final: !!data.payload.final,
                streaming: false,
                endedAt: data.timestamp,
              }
              return { reasoning: next }
            }
            return {
              reasoning: [...state.reasoning, {
                id: `r-${data.payload.step}-${data.timestamp}`,
                step: data.payload.step ?? 0,
                text: full,
                final: !!data.payload.final,
                timestamp: data.timestamp,
                streaming: false,
              }],
            }
          })
        } else if (data.type === 'tool_call_delta') {
          // The model is writing this call out. Any in-progress text is intermediate
          // step rationale for this tool call, so clear the bottom message bubble.
          const p = data.payload
          const idx = typeof p.index === 'number' ? p.index : 0
          set(state => {
            const sid = state.streamingMessageId
            const nextMessages = sid ? state.messages.filter(m => m.id !== sid) : state.messages
            const next = [...state.toolPreviews]
            const at = next.findIndex(tp => tp.index === idx)
            const entry: ToolCallPreview = {
              index: idx,
              callId: p.callId || (at >= 0 ? next[at].callId : ''),
              toolName: p.toolName || (at >= 0 ? next[at].toolName : ''),
              argsText: typeof p.argsText === 'string' ? p.argsText : (at >= 0 ? next[at].argsText : ''),
              final: !!p.final,
              timestamp: data.timestamp,
            }
            if (at >= 0) next[at] = entry
            else next.push(entry)
            return {
              messages: nextMessages,
              streamingMessageId: null,
              toolPreviews: next,
            }
          })
        } else if (data.type === 'tool_call') {
          const shellName = data.payload.toolName
          if (isShellTool(shellName)) {
            const args = (data.payload.args || {}) as Record<string, unknown>
            const cmd = String(args.command ?? args.CommandLine ?? args.cmd ?? '')
            useTerminalStore.getState().mirrorCommand(
              data.payload.cwd || data.payload.workspaceRoot,
              cmd,
            )
            // 如果执行了 start/open/explorer 打开 HTTP(S) 网址，联动右侧内置浏览器同步打开
            const matchHttp = cmd.match(/(?:start|open|explorer(?:\.exe)?)\s+(https?:\/\/[^\s]+)/i)
            if (matchHttp && matchHttp[1] && data.payload.status !== 'needs_confirmation') {
              const targetUrl = matchHttp[1]
              useSidePanelStore.getState().openAndRevealSidePanel('browser')
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('ovolve:browser-navigate', { detail: { url: targetUrl } }))
                window.dispatchEvent(new CustomEvent('ovolve:browser-navigate', { detail: { url: targetUrl } }))
              }
            }
          } else if (shellName === 'navigate' || shellName === 'tab_open') {
            const isPendingConfirm = data.payload.status === 'needs_confirmation' ||
              Boolean((data.payload as any).needsConfirmation) ||
              Boolean((data.payload.args as any)?.needs_confirmation)
            if (!isPendingConfirm) {
              const args = (data.payload.args || {}) as Record<string, unknown>
              const targetUrl = String(args.url ?? args.target ?? args.address ?? '').trim()
              if (targetUrl) {
                useSidePanelStore.getState().openAndRevealSidePanel('browser')
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('ovolve:browser-navigate', { detail: { url: targetUrl } }))
                  window.dispatchEvent(new CustomEvent('ovolve:browser-navigate', { detail: { url: targetUrl } }))
                }
              }
            }
          }
          set(state => {
            const sid = state.streamingMessageId
            const nextMessages = sid ? state.messages.filter(m => m.id !== sid) : state.messages
            return {
              messages: nextMessages,
              streamingMessageId: null,
              // The call is now real. Drop its preview so the card doesn't render twice.
              // Correlating on callId alone was not enough: providers may send the id
              // in a later chunk than the first argument fragment, so a preview can
              // reach commit time with `callId: ''` and never match — which left the
              // pulsing `Calling …` row on screen next to the real one. Fall back to
              // the tool name whenever either side is missing an id.
              toolPreviews: state.toolPreviews.filter(tp => {
                const id = data.payload.toolCallId
                if (id && tp.callId) return tp.callId !== id
                return tp.toolName !== data.payload.toolName
              }),

              toolCalls: [...state.toolCalls, {
                id: data.payload.toolCallId || `${data.payload.toolName}-${data.timestamp}`,
                toolName: data.payload.toolName,
                args: data.payload.args,
                status: 'running',
                timestamp: data.timestamp,
                riskLevel: data.payload.riskLevel,
                reversible: data.payload.reversible,
                cwd: data.payload.cwd,
                workspaceRoot: data.payload.workspaceRoot,
                permission: data.payload.permission,
                // 命令内容分级结果（COMMAND 策略层）；旧后端缺省 undefined
                commandGuard: data.payload.commandGuard,
              }]
            }
          })
        } else if (data.type === 'tool_output_delta') {
          const chunk = String(data.payload.chunk ?? '')
          if (chunk) {
            const callId = data.payload.toolCallId
            const tc = get().toolCalls.find((t) => t.id === callId)
            if (tc && isShellTool(tc.toolName)) {
              useTerminalStore.getState().mirrorChunk(chunk)
            }
          }
          // Live stdout of a still-running command. Appended to `output`, which
          // is deliberately NOT `result`: result is the settled one-line preview,
          // this is the raw scrolling transcript the terminal card renders.
          set(state => {
            const idx = state.toolCalls.findIndex(tc => tc.id === data.payload.toolCallId)
            if (idx < 0) return {}
            const chunk = String(data.payload.chunk ?? '')
            if (!chunk) return {}
            let output = (state.toolCalls[idx].output || '') + chunk
            let outputTruncated = state.toolCalls[idx].outputTruncated
            // Drop from the HEAD, not the tail: a build log's last lines are the
            // ones that say what broke. An unbounded string here would let one
            // `npm install` grow the store without limit.
            if (output.length > TOOL_OUTPUT_CAP) {
              output = output.slice(output.length - TOOL_OUTPUT_CAP)
              outputTruncated = true
            }
            const next = [...state.toolCalls]
            next[idx] = { ...next[idx], output, outputTruncated }
            return { toolCalls: next }
          })
        } else if (data.type === 'tool_cancelled') {
          // Only an acknowledgement that the kill signal landed. The real
          // terminal state still arrives as `tool_result` with the partial
          // output, so don't settle the card here.
          if (data.payload.ok === false) {
            set(state => {
              const idx = state.toolCalls.findIndex(tc => tc.id === data.payload.toolCallId)
              if (idx < 0) return {}
              const next = [...state.toolCalls]
              next[idx] = { ...next[idx], output: (next[idx].output || '') + '\n' + t('store.toolCancelFailed', '[无法终止：进程已结束或不可取消]') + '\n' }
              return { toolCalls: next }
            })
          }
        } else if (data.type === 'tool_result') {
          const resToolName = data.payload.toolName
          const isOk = (data.payload as any).ok !== false && data.payload.status !== 'failed'
          if (isOk && (resToolName === 'navigate' || resToolName === 'tab_open')) {
            const rawUrl = data.payload.result?.url || data.payload.url || data.payload.preview
            let targetUrl = ''
            if (typeof rawUrl === 'string') {
              const m = rawUrl.match(/https?:\/\/[^\s),"]+/)
              if (m) targetUrl = m[0]
            }
            if (targetUrl) {
              useSidePanelStore.getState().openAndRevealSidePanel('browser')
              if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('ovolve:browser-navigate', { detail: { url: targetUrl } }))
                window.dispatchEvent(new CustomEvent('ovolve:browser-navigate', { detail: { url: targetUrl } }))
              }
            }
          }
          // Correlate on toolCallId when the backend supplies one. Fall back to
          // "most recent still-running call with this name" for older payloads,
          // which avoids mislabeling earlier calls that reuse the same tool.
          set(state => {
            const byId = data.payload.toolCallId
              ? state.toolCalls.findIndex(tc => tc.id === data.payload.toolCallId)
              : -1
            const idx = byId >= 0 ? byId : state.toolCalls.reduce<number>(
              (found, tc, i) =>
                tc.toolName === data.payload.toolName && tc.status === 'running' ? i : found,
              -1,
            )
            if (idx < 0) return {}
            const next = [...state.toolCalls]
            next[idx] = {
              ...next[idx],
              result: data.payload.preview,
              status: toStatus(data.payload),
              completedAt: data.timestamp,
              exitCode: data.payload.exitCode,
              timedOut: data.payload.timedOut,
              // Only ask_user sends these. Spread-with-undefined would wipe the
              // questions off a card that got a second result frame, so keep the
              // previous value when the frame is silent about them.
              askHeader: data.payload.askHeader ?? next[idx].askHeader,
              askQuestions: data.payload.askQuestions ?? next[idx].askQuestions,
              askAutoResolved: data.payload.askAutoResolved || next[idx].askAutoResolved,
              // The tool_call frame set an optimistic reversible from the
              // tool-name table; the settled frame carries the verdict after the
              // snapshot ran. `undefined` = backend stayed silent (older payload
              // or read tool), so keep whatever the card already had rather than
              // wiping the badge to undefined.
              reversible: data.payload.reversible ?? next[idx].reversible,
              snapshot: data.payload.snapshot ?? next[idx].snapshot,
            }
            return { toolCalls: next }
          })
          // A parked question suspends the turn server-side: the tool call stays
          // open and nothing more will arrive until the user clicks. Disarm the
          // watchdog now rather than relying on it to bail 90s later.
          if (toStatus(data.payload) === 'needs_input') clearStallTimer()
        } else if (data.type === 'error') {
          // The backend pauses the queue itself on a failed turn and broadcasts
          // the new queue_state — nothing to do locally. But we DO have to
          // settle in-flight activity so the thinking chain and any running
          // tool card don't stay animated after a hard error.
          //
          // The row must carry the REASON. Two things were wrong before: the
          // `Error: ` prefix is an internal label in front of an otherwise
          // human sentence, and `hint` — the actionable half of the payload,
          // e.g. "去设置里填一个密钥" — was thrown away, so the user got the
          // symptom with no next step. A turn that dies must never leave the
          // reader looking at a blank bubble wondering what happened.
          const errPayload = data.payload || {}
          const errMain = String(errPayload.message || t('store.error.incomplete', '这次请求没有完成')).trim()
          const errHint = String(errPayload.hint || '').trim()
          const errText = errHint ? `${errMain}（${errHint}）` : errMain
          set(state => {
            // Drop the placeholder assistant bubble this turn had opened. It has
            // no content and never will, and an empty bubble next to an error row
            // reads as a second, silent failure.
            const sid = state.streamingMessageId
            const idx = sid ? state.messages.findIndex(m => m.id === sid) : -1
            const kept = idx >= 0 && !state.messages[idx].content.trim()
              ? state.messages.filter((_, i) => i !== idx)
              : state.messages
            return {
              messages: [...kept, {
                id: Date.now().toString(),
                role: 'system' as const,
                content: errText,
                timestamp: data.timestamp,
              }],
              isWorking: false,
              streamingMessageId: null,
              ...settleActivity(state),
            }
          })
          // Red dot in the sidebar + a notification, so a failure in a
          // background session isn't discovered only when the user clicks in.
          const failedSid = eventSessionId(data, get)
          if (failedSid) {
            useSessionListStore.getState().markSettled(failedSid, false)
            const title =
              useSessionListStore.getState().sessions.find(s => s.id === failedSid)?.title || ''
            notifyTurnDone(failedSid, false, title)
          }
        } else if (data.type === 'agent_phase') {
          // Narration only. The backend has emitted this all along; nothing was
          // listening, so every slow turn looked identical. Latest wins — there
          // is no history to keep, just "where are we right now".
          const phase = String(data.payload.phase || '')
          if (phase) {
            set({
              currentPhase: {
                phase,
                step: data.payload.step,
                steps: data.payload.steps,
                tool: data.payload.tool
                  || (Array.isArray(data.payload.tools) ? data.payload.tools.join('、') : undefined),
                at: data.timestamp,
              },
            })
          }
        } else if (data.type === 'post_edit_verification') {
          // Post-edit verification result. Insert as a system message so it
          // persists in the chat history and the user can scroll back to it.
          const p = data.payload || {}
          if (p.command) {
            set(state => ({
              messages: [...state.messages, {
                id: `verification-${data.timestamp}`,
                role: 'system' as const,
                content: '',
                kind: 'verification' as const,
                verification: {
                  session_id: p.session_id || '',
                  workspace: p.workspace || '',
                  trigger_tool: p.trigger_tool || '',
                  trigger_path: p.trigger_path || '',
                  success: !!p.success,
                  command: p.command || '',
                  kind: p.kind || 'check',
                  exit_code: p.exit_code ?? 0,
                  output: p.output || '',
                  duration_ms: p.duration_ms ?? 0,
                  timestamp: data.timestamp,
                  error: p.error || undefined,
                },
                timestamp: data.timestamp,
              }],
            }))
          }
        } else if (data.type === 'turn_state') {
          // 2.1 The authoritative turn state, straight from the sessions table.
          //
          // Why this frame exists when we already flip `isWorking` on a dozen
          // events: those events only reach a window that was CONNECTED when
          // they fired. Reload the page, open a second window on the same
          // conversation, or restart the backend, and the local boolean starts
          // at false while the truth may be `running` (another window's turn),
          // `waiting_user` (a parked question) or `paused` (a stop the user can
          // resume). The old symptom was a composer that looked ready and then
          // answered "a turn is already running".
          //
          // So this reconciles rather than competes: the event-driven sets keep
          // the UI instant, and every arriving frame corrects them against the
          // row. `isWorking` is now a derived reading of `status`, not an
          // independent truth.
          const status = String(data.payload?.status || '')
          if (status) {
            set({
              turnStatus: status as TurnStatus,
              turnSubstatus: String(data.payload?.substatus || ''),
              isWorking: status === 'running',
              // Not running → there is no "where are we now"; a stale phase line
              // under a settled turn reads as a hang.
              ...(status === 'running' ? {} : { currentPhase: null }),
            })
          }
        } else if (data.type === 'session_truncated') {

          // The backend has always reported which files it could NOT put back —
          // `skipped` (over the snapshot size ceiling, so no pre-image exists)
          // and `errors` (the restore itself threw). Nothing consumed this frame,
          // so a rollback that silently left a large file modified looked
          // identical to a clean one. That is real data loss presented as
          // success, which is worse than refusing to roll back at all.
          //
          // Hardcoded copy for the same reason as armStallTimer: stores can't
          // call hooks.
          const files = data.payload?.files
          const skipped: string[] = Array.isArray(files?.skipped) ? files.skipped : []
          const errored: { path?: string; error?: string }[] =
            Array.isArray(files?.errors) ? files.errors : []
          if (skipped.length || errored.length) {
            const lines: string[] = [t('store.rollbackGap.title', '已撤回，但下面这些文件没有恢复到之前的内容：')]
            for (const p of skipped.slice(0, 10)) {
              lines.push(t('store.rollbackGap.skipped', '· {{path}} —— 文件太大，当时没有留快照', { path: p }))
            }
            for (const e of errored.slice(0, 10)) {
              lines.push(t('store.rollbackGap.errored', '· {{path}} —— 恢复失败：{{error}}', {
                path: e.path ?? t('store.rollbackGap.unknownPath', '(未知路径)'),
                error: e.error ?? t('store.refs.unknownReason', '未知原因'),
              }))
            }
            const extra = skipped.length + errored.length - 20
            if (extra > 0) lines.push(t('store.rollbackGap.extra', '· 还有 {{count}} 个未列出', { count: extra }))
            lines.push(t('store.rollbackGap.footer', '这些文件仍是改动后的状态，需要手动处理。'))
            set(state => ({
              messages: [...state.messages, {
                id: `rollback-gap-${Date.now()}`,
                role: 'system' as const,
                content: lines.join('\n'),
                timestamp: data.timestamp,
              }],
            }))
          }
        } else if (data.type === 'pending_questions') {
          // Full replacement, not a delta — the backend's ledger is the truth.
          //
          // Three jobs in one frame: rebuild cards this client never saw (a
          // reload or session switch clears `toolCalls`, and a question parked
          // before that would be both invisible and unanswerable while the turn
          // sits stopped), refresh the ones it has, and settle any `needs_input`
          // card the backend no longer knows about — which is what happens when
          // the user answered by typing instead of clicking, or the ask expired.
          const items: any[] = data.payload.items ?? []
          const byId = new Map(items.map((it: any) => [String(it.callId), it]))
          set(state => {
            const next = state.toolCalls.map(tc => {
              const it = byId.get(tc.id)
              if (it) {
                byId.delete(tc.id)
                return {
                  ...tc,
                  status: 'needs_input' as ToolCallStatus,
                  askHeader: it.header,
                  askQuestions: it.questions,
                }
              }
              return tc.status === 'needs_input'
                ? { ...tc, status: 'completed' as ToolCallStatus }
                : tc
            })
            for (const it of byId.values()) {
              next.push({
                id: String(it.callId),
                toolName: String(it.toolName || 'ask_user'),
                args: {},
                status: 'needs_input',
                timestamp: it.createdAt ?? Date.now() / 1000,
                askHeader: it.header,
                askQuestions: it.questions,
              })
            }
            return { toolCalls: next }
          })
        } else if (data.type === 'session_list') {
          // Mirror the backend's session list into sessionListStore so the
          // sidebar updates. Cross-store call is safe despite the import cycle:
          // both sides only touch each other inside function bodies, never at
          // module evaluation time.
          const sessions = data.payload.sessions ?? []
          const activeWorkspace = data.payload.activeWorkspace as string | undefined
          grantWorkspacesToMain(
            activeWorkspace,
            ...sessions.map((s: { workspace?: string }) => s.workspace),
          )
          useSessionListStore.getState().applyList(
            sessions,
            data.payload.activeId ?? get().sessionId,
            activeWorkspace,
          )
        } else if (data.type === 'workspace_list') {
          const workspaces = data.payload.workspaces ?? []
          const active = data.payload.active ?? ''
          grantWorkspacesToMain(active, ...workspaces.map((w: { path?: string }) => w.path))
          useSessionListStore.getState().applyWorkspaces(workspaces, active)
        } else if (data.type === 'goal_state_change') {
          // Autonomous goal execution progress. Push into goalStore so the
          // Goals page updates without a manual refresh.
          const p = data.payload || {}
          if (p.goal_id) {
            useGoalStore.getState().applyStateChange(
              p.goal_id, p.status ?? 'running', p,
            )
          }
        } else if (data.type === 'evolution_proposal') {
          // The backend mined a new self-improvement proposal mid-conversation.
          // Without this frame the review queue is invisible until the user
          // happens to open the page, which is the difference between a feature
          // that gets used and one that doesn't.
          const p = data.payload || {}
          useEvolutionStore.getState().onProposalEvent(Number(p.openCount ?? 0))
        } else if (data.type === 'evolution_insight' || data.type === 'learning_item_event') {
          // 学习环与 LearningItem 进化时刻落进时间线（Phase 24）
          const ep = data.payload || {}
          const targetSessionId = ep.sessionId || ep.session_id || data.sessionId
          const targetBranchId = ep.branchId || ep.branch_id || data.branchId || ''
          const currentSessionId = get().sessionId
          const currentBranchId = get().branchId || ''

          // §13.4/13.5 & Scope Guard: Background session/branch events must NOT pollute active chat
          if (!targetSessionId || targetSessionId !== currentSessionId) {
            return
          }
          const isGlobal = ep.scopeType === 'global' || data.scopeType === 'global' || ep.scope === 'global'
          if (!isGlobal) {
            if (currentBranchId && targetBranchId !== currentBranchId) {
              return
            }
            if (!currentBranchId && targetBranchId) {
              return
            }
          }

          const notificationPolicy = ep.notificationPolicy || ep.notification_policy || 'receipt'
          if (notificationPolicy === 'silent' && ep.kind !== 'learned') {
            return
          }

          try {
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('ovolve:learning_item_updated', {
                detail: { ...ep, sessionId: targetSessionId, branchId: targetBranchId }
              }))
            }
          } catch {
            // Ignore in non-browser env
          }

          const dedupeKey = `evo-${ep.itemId || ep.item_id || ep.bundleId || ep.bundle_id || ep.kind || 'insight'}`
          const newMsg = {
            id: dedupeKey,
            role: 'system' as const,
            content: '',
            timestamp: Date.now(),
            kind: 'evolution' as const,
            evolution: {
              kind: ep.lifecycle || ep.kind || 'learned',
              detail: ep.detail || ep.why || ep.summary || '',
              decision: ep.decision ?? null,
              sessionId: targetSessionId,
              branchId: targetBranchId,
              episodeId: ep.episodeId || ep.episode_id,
              bundleId: ep.bundleId || ep.bundle_id,
              itemId: ep.itemId || ep.item_id,
              goalId: ep.goalId || ep.goal_id,
              runId: ep.runId || ep.run_id,
              turnIds: ep.turnIds || ep.turn_ids,
              skills: ep.skills,
              skillName: ep.skillName || ep.skill_name,
              candidateId: ep.candidateId || ep.candidate_id,
              proposalId: ep.proposalId || ep.proposal_id,
              status: ep.status,
              scope: ep.scope,
              impact: ep.impact,
              notificationPolicy,
              title: ep.title,
              summary: ep.summary,
              why: ep.why,
              evidenceSummary: ep.evidenceSummary || ep.evidence_summary,
              futureEffect: ep.futureEffect || ep.future_effect,
              traceRef: ep.traceRef || ep.trace_ref,
              createdAt: ep.createdAt || ep.created_at || Date.now(),
              memoryProposals: ep.memoryProposals,
              skillCandidate: ep.skillCandidate,
              learningItems: ep.learningItems || (ep.itemId ? [ep.itemId] : []),
              learningItemDetails: ep.learningItemDetails || ep.learning_item_details || [],
              materialized: ep.materialized ?? Boolean(ep.itemId || ep.memoryProposals?.length || ep.skillCandidate),
              materializeReason: ep.materializeReason,
            },
          }

          set(state => {
            const existingIdx = state.messages.findIndex(
              m => m.id === dedupeKey || (ep.itemId && m.evolution?.itemId === ep.itemId)
            )
            if (existingIdx >= 0) {
              const updated = [...state.messages]
              updated[existingIdx] = newMsg
              return { messages: updated }
            }
            return { messages: [...state.messages, newMsg] }
          })

        } else if (data.type === 'subagent_state') {
          // One sub-agent moved through its lifecycle. Upsert by id: the backend
          // sends the FULL record on every transition, so a late-arriving frame
          // can't leave us with a half-populated row.
          const p = (data.payload || {}) as SubagentInfo
          if (p.subagentId) {
            set((state) => {
              const i = state.subagents.findIndex((s) => s.subagentId === p.subagentId)
              if (i === -1) return { subagents: [...state.subagents, p] }
              // Replace in place so spawn order — which is the order the model
              // asked for the work — stays the render order.
              const next = state.subagents.slice()
              next[i] = p
              return { subagents: next }
            })
          }
        } else if (data.type === 'subagent_activity') {
          // A child Router did something, re-tagged onto this window by
          // `_relay_subagent_activity`. Accumulate per sub-agent; this is the
          // only source for the drill-down view.
          const p = data.payload || {}
          if (p.subagentId) {
            set((state) => ({
              subagentActivity: {
                ...state.subagentActivity,
                [p.subagentId]: foldSubagentActivity(state.subagentActivity[p.subagentId], p),
              },
            }))
          }
        } else if (data.type === 'subagent_stuck') {
          // 子代理长时间未收尾的预警（看门狗 WARN 线）。落成一条系统行，
          // 让"它在干什么/会不会被杀"在时间线上可见，而不是等被杀后考古。
          const p = data.payload || {}
          set(state => ({
            messages: [...state.messages, {
              id: `subagent-stuck-${p.subagentId || data.timestamp}`,
              role: 'system' as const,
              content: t('store.subagentStuck.warn',
                '子任务「{{label}}」已经运行了 {{minutes}} 分钟还没收尾，'
                + '{{abortMinutes}} 分钟后会被自动结束。',
                { label: String(p.label || p.subagentId || ''),
                  minutes: Math.max(1, Math.round((p.elapsedS || 0) / 60)),
                  abortMinutes: Math.round((p.abortAtS || 900) / 60) }),
              timestamp: data.timestamp,
            }],
          }))
        } else if (data.type === 'session_forked') {
          // Arrives just BEFORE the `session_switched` that repaints the
          // timeline, so only stash the prompt here. Doing anything to
          // `messages` would be overwritten a frame later anyway.
          set({ pendingForkText: String(data.payload?.originalText || '') || null })
        } else if (data.type === 'session_switched') {
          // Navigation, not teardown. Park the turn we're leaving if it is still
          // running, and restore the one we're entering if we parked it earlier.
          // Blanking the volatile fields and reloading history (what this used to
          // do unconditionally) loses an in-flight reply — it isn't in the
          // database yet — so the continuing deltas rebuilt it from empty and it
          // read as the agent answering a second time.
          clearStallTimer()
          const nextSid = data.payload.sessionId || data.sessionId
          useSidePanelStore.getState().switchSession(nextSid)
          // Whether the session we're entering still has a turn on the wire.
          // The backend knows; guessing is what broke the working indicator.
          const incomingLive = !!data.payload.turnRunning
          const history = (data.payload.messages ?? []).map((m: any) => ({
            id: m.id || `hist-${Math.random().toString(36).slice(2)}`,
            role: m.role,
            content: m.content ?? '',
            timestamp: m.timestamp ?? Date.now(),
            kind: m.kind,
            fold: m.fold,
            images: m.images,
            toolCalls: m.toolCalls,
            reasoning: m.reasoning,
          }))

          // Decided before `set` so the updater stays pure — a store setter run
          // inside a zustand reducer fires twice under StrictMode.
          const leavingSid = get().sessionId
          const parkLeaving = !!leavingSid && leavingSid !== nextSid && get().isWorking

          set(state => {
            const prevSid = state.sessionId
            const buffers = { ...state.sessionBuffers }

            // Only a LIVE turn is worth parking: a settled conversation is fully
            // described by the history the backend hands back on the way in, and
            // buffering those would leak memory while serving stale text.
            if (parkLeaving && prevSid) {
              buffers[prevSid] = {
                messages: state.messages,
                toolCalls: state.toolCalls,
                toolPreviews: state.toolPreviews,
                reasoning: state.reasoning,
                subagents: state.subagents,
                subagentActivity: state.subagentActivity,
                streamingMessageId: state.streamingMessageId,
                turnStartedAt: state.turnStartedAt,
                currentPhase: state.currentPhase,
                parkedAt: Date.now(),
              }
            }

            // A parked turn that settled while we were away is superseded by the
            // history in this frame.
            const parked = nextSid ? buffers[nextSid] : undefined
            const restore = parked && incomingLive ? parked : null
            if (nextSid && parked) delete buffers[nextSid]

            return {
              sessionBuffers: buffers,
              sessionId: nextSid,
              messages: restore ? restore.messages : history,
              toolCalls: restore ? restore.toolCalls : [],
              toolPreviews: restore ? restore.toolPreviews : [],
              reasoning: restore ? restore.reasoning : [],
              subagents: restore ? restore.subagents : [],
              subagentActivity: restore ? restore.subagentActivity : {},
              streamingMessageId: restore ? restore.streamingMessageId : null,
              turnStartedAt: restore ? restore.turnStartedAt : null,
              currentPhase: restore ? restore.currentPhase : null,
              selectedSubagentId: null,
              turnRetryWindow: null,
              isFolding: false,
              isWorking: incomingLive,
              turnStatus: incomingLive ? 'running' : 'idle',
            }
          })
          // Running and no longer on screen — precisely what the sidebar's
          // breathing dot exists to say. Nothing else seeds it: the
          // background-event branch only fires on frames that arrive AFTER the
          // switch, and a session busy inside one long tool call may not send
          // another for minutes.
          if (parkLeaving) useSessionListStore.getState().markWorking(leavingSid)
          recomputeUsage(get())
        }
      } catch (e) {
        console.error('Failed to parse event:', e)
      }

      // After any event that mutates messages/reasoning/toolCalls, recompute the
      // context-window estimate so the gauge stays up-to-date. Throttled: this
      // fires per inbound frame (every streamed token included) and a full BPE
      // rescan per token made long turns O(n²).
      scheduleRecompute(get)

      // If a terminal branch above flipped the turn off, the watchdog re-armed at
      // the top of this handler is now stale — cancel it.
      if (!get().isWorking) clearStallTimer()
    }

    ws.onclose = () => {
      // If this is a stale socket that has already been replaced by a newer connect(), ignore it
      if ((get() as any)._ws !== ws) return
      clearStallTimer()
      // A drop mid-turn (backend restart, Vite HMR reload, network blip) would
      // otherwise leave the composer disabled and a blank bubble on screen. The
      // queue is server-owned; the next successful WS `open` will re-hydrate it
      // via the initial `queue_state` snapshot.
      // We also settle in-flight tool/reasoning activity so nothing keeps
      // spinning after the socket is gone — no terminal event will ever arrive.
      set(state => {
        const sid = state.streamingMessageId
        const idx = sid ? state.messages.findIndex(m => m.id === sid) : -1
        const stale = idx >= 0 && !state.messages[idx].content.trim()
        return {
          connected: false,
          connecting: false,
          isWorking: false,
          streamingMessageId: null,
          messages: stale ? state.messages.filter((_, i) => i !== idx) : state.messages,
          ...settleActivity(state),
        }
      })
      // The socket died without being asked to — try the backend again on a
      // backoff so a restarted backend heals the UI by itself.
      scheduleReconnect(get)
    }

    ws.onerror = () => {
      if ((get() as any)._ws !== ws) return
      clearStallTimer()
      set(state => ({
        connected: false,
        connecting: false,
        isWorking: false,
        ...settleActivity(state),
      }))
    }

    // Store ws instance for sending messages
    ;(get() as any)._ws = ws
  },

  disconnect: () => {
    // Explicit teardown — suppress the auto-reconnect and drop any pending one.
    intentionalClose = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    const ws = (get() as any)._ws
    if (ws) {
      ws.close()
      set({ connected: false })
    }
  },

  sendMessage: async (message: string, contextRefs: ContextRef[] = []) => {
    resetStreamThrottle()
    const ws = (get() as any)._ws
    // Optimistic: show the user's message immediately, mark the turn as working,
    // and clear last turn's tool/reasoning activity so the feed is per-turn.
    set(state => ({
      messages: [...state.messages, {
        id: Date.now().toString(),
        role: 'user',
        content: message,
        // Seconds, like every backend frame (`time.time()`). The rollback
        // dialog correlates tool calls against this timestamp on the same
        // scale; a ms value here made that comparison always false and the
        // "irreversible tools will run" confirmation never fired.
        timestamp: Date.now() / 1000,
      }],
      isWorking: true,
      turnStartedAt: Date.now(),
      streamingMessageId: null,
      imageGenerating: false,
      toolCalls: [],
      toolPreviews: [],
      reasoning: [],
      subagents: [],
      subagentActivity: {},
      selectedSubagentId: null,
      currentPhase: null,
      turnRetryWindow: null,
    }))

    // Arm the stall watchdog so the user is never stuck forever even if the
    // backend never replies (crashed, unhandled exception, etc.).
    armStallTimer(set, get as () => AgentState)

    // Optimistically update the session list & sidebar so the new conversation
    // appears immediately with its title and working dot in 0ms (matching typical IDE agent UX).
    const sid = get().sessionId
    const firstLine = message.trim().split('\n')[0] || ''
    const optTitle = firstLine.slice(0, 30)
    useSessionListStore.getState().touchOrAddSession(
      sid,
      optTitle,
      useSessionListStore.getState().activeWorkspace,
    )

    // Fold the new user message into the running token estimate immediately.
    recomputeUsage(get())

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      clearStallTimer()
      set(state => ({
        messages: [...state.messages, {
          id: `err-${Date.now()}`,
          role: 'system',
          content: t('store.notConnected', '未连接到后端服务。请确认 Python 后端已启动（端口 8765）后重试。'),
          timestamp: Date.now() / 1000,
        }],
        isWorking: false,
      }))
      return
    }

    // The permission level is read at SEND time, not at connect time — the user
    // may change it between turns and each turn must run under whatever was
    // selected when they hit send. Read straight from the store rather than
    // taking it as a param so every call site stays in sync automatically.
    const permission = useSessionConfigStore.getState().permission
    // Same reasoning for the model: it rides along with the request. Before
    // this, the picker only changed a label — the backend never learned about
    // the choice and answered every turn with config.json's model. Empty means
    // "no explicit pick", and the backend falls back to that same default.
    const model = useSessionConfigStore.getState().activeModel
    // Thinking budget, same per-send treatment (UD4). The backend translates the
    // level into whichever field the chosen provider understands, and drops it
    // entirely for models that have no such dial — so sending it unconditionally
    // is safe even when the current model can't use it.
    const thoughtLevel = useSessionConfigStore.getState().thoughtLevel

    // Per-send idempotency key. The backend dedupes on it, so a reconnect
    // replay or a double-click can't run the same turn (and the same tools)
    // twice. It doubles as the retry handle: re-sending the SAME msgId inside
    // the backend's grace window is understood as "retry that failed turn"
    // rather than "here's a new prompt".
    const msgId = newMsgId()
    lastOutboundMsgId = msgId
    ws.send(JSON.stringify({
      type: 'user_prompt',
      payload: {
        message, permission, model, thoughtLevel, msgId,
        // @ references travel as STRUCTURE, not as text inside `message`. The
        // backend reads each one and injects the content as its own message, so
        // the model receives the file instead of a path it has to go fetch.
        // Omitted entirely when empty so the frame stays identical to before for
        // the common case.
        ...(contextRefs.length > 0 ? { contextRefs } : {}),
      },
      timestamp: Date.now(),
    }))
  },

  retryTurn: () => {
    const { turnRetryWindow } = get()
    const ws = (get() as any)._ws
    if (!turnRetryWindow?.msgId || !ws || ws.readyState !== WebSocket.OPEN) return false

    const permission = useSessionConfigStore.getState().permission
    const model = useSessionConfigStore.getState().activeModel
    const thoughtLevel = useSessionConfigStore.getState().thoughtLevel

    // Find the user message tied to this turn (last user bubble is the usual case).
    const msgs = get().messages
    let message = ''
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        message = msgs[i].content
        break
      }
    }
    if (!message.trim()) return false

    lastOutboundMsgId = turnRetryWindow.msgId
    set({
      isWorking: true,
      turnRetryWindow: null,
      streamingMessageId: null,
      imageGenerating: false,
      toolCalls: [],
      toolPreviews: [],
      reasoning: [],
      currentPhase: null,
    })
    armStallTimer(set, get as () => AgentState)

    ws.send(JSON.stringify({
      type: 'user_prompt',
      payload: {
        message,
        permission,
        model,
        thoughtLevel,
        msgId: turnRetryWindow.msgId,
      },
      timestamp: Date.now(),
    }))
    return true
  },

  steer: (text: string, options?: { immediate?: boolean; urgent_interrupt?: boolean }) => {
    const trimmed = text.trim()
    if (!trimmed) return false
    const ok = get().send('steer', {
      text: trimmed,
      immediate: options?.immediate ?? true,
      urgent_interrupt: options?.urgent_interrupt ?? true,
    })
    if (!ok) return false
    // Optimistic, same as sendMessage: the guidance appears the moment it is
    // sent, not when the loop happens to reach its next step boundary.
    // Deliberately does NOT reset toolCalls/reasoning — a steer joins the
    // CURRENT turn, so wiping its activity feed would erase the very context
    // the user is reacting to.
    set(state => ({
      messages: [...state.messages, {
        id: `steer-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: Date.now() / 1000,
      }],
    }))
    // Fresh input extends the turn — restart the watchdog so a long steered
    // turn isn't killed by a timer armed before the steer landed.
    armStallTimer(set, get as () => AgentState)
    scheduleRecompute(get)
    return true
  },

  selectSubagent: (subagentId: string | null) => {
    set({ selectedSubagentId: subagentId })
  },

  addEvent: (event: AgentEvent) => {
    set(state => {
      // Cap the raw event log: it used to grow without bound, so a long-lived
      // session (or a sub-agent fan-out) was a straight memory leak. Keep the
      // TAIL — nothing in the UI reads events older than the current view.
      const events = state.events.length >= MAX_EVENTS
        ? state.events.slice(state.events.length - MAX_EVENTS + 1)
        : state.events
      return { events: [...events, event] }
    })
  },

  foldContext: () => {
    const sid = get().sessionId
    set({ isFolding: true })
    const ok = get().send('fold', { sessionId: sid })
    if (!ok) {
      set({ isFolding: false })
    }
    return ok
  },

  send: (type: string, payload: Record<string, unknown> = {}) => {
    const ws = (get() as any)._ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      const sid = get().sessionId
      const bid = get().branchId
      const outPayload = {
        ...(sid ? { sessionId: sid } : {}),
        ...(bid ? { branchId: bid } : {}),
        ...payload,
      }
      ws.send(JSON.stringify({ type, payload: outPayload, sessionId: sid, timestamp: Date.now() }))
      return true
    } catch {
      return false
    }
  },

  cancelTool: (callId: string) => {
    if (!callId) return false
    return get().send('cancel_tool', { toolCallId: callId })
  },

  approvePlan: (decision) => {
    const { pendingPlan, send } = get() as AgentState & { pendingPlan: { planId: string; preview: string; chars: number } | null }
    if (!pendingPlan) return false
    const ok = send('approve_plan', { planId: pendingPlan.planId, decision })
    set({ pendingPlan: null })
    return ok
  },

  respondPermission: (callId, decision) => {
    const permission = useSessionConfigStore.getState().permission
    const model = useSessionConfigStore.getState().activeModel
    const thoughtLevel = useSessionConfigStore.getState().thoughtLevel
    const ok = get().send('respond_permission', {
      callId,
      decision,
      permission,
      model,
      thoughtLevel,
    })
    if (!ok) return false
    set((state) => ({
      toolCalls: state.toolCalls.map((tc) =>
        tc.id === callId
          ? { ...tc, status: decision === 'deny' ? 'denied' : 'running' }
          : tc,
      ),
    }))
    return true
  },

  respondQuestion: (callId, answers, skipped = false) => {
    const ok = get().send('respond_question', { callId, answers, skipped })
    if (!ok) return false
    // The answer settles the card either way — whether it resumed the suspended
    // turn in place or started a fresh one — so don't leave live radio buttons
    // sitting under a running turn.
    set((state) => ({
      toolCalls: state.toolCalls.map((tc) =>
        tc.id === callId ? { ...tc, status: 'completed' } : tc,
      ),
    }))
    // The turn is moving again, so the silence watchdog has to come back: it was
    // disarmed while the question was parked.
    if (get().isWorking) armStallTimer(set, get as () => AgentState)
    return true
  },

  stop: () => {
    clearStallTimer()
    const sid = get().sessionId
    get().send('interrupt', { sessionId: sid })
    set(state => {
      const streamingSid = state.streamingMessageId
      const idx = streamingSid ? state.messages.findIndex(m => m.id === streamingSid) : -1
      const stale = idx >= 0 && !state.messages[idx].content.trim()
      const buffers = { ...state.sessionBuffers }
      if (state.sessionId) delete buffers[state.sessionId]
      if (sid) delete buffers[sid]
      return {
        sessionBuffers: buffers,
        isWorking: false,
        turnStatus: 'paused',
        streamingMessageId: null,
        turnRetryWindow: null,
        messages: stale ? state.messages.filter((_, i) => i !== idx) : state.messages,
        ...settleActivity(state),
      }
    })
  },



  resumeTurn: (text?: string) => {
    // The backend is the authority on whether a resume is legal (it only accepts
    // this when the persisted status is `paused` and no turn is live). We still
    // gate on the local reading so a stray click on a fresh session doesn't fire
    // a frame the server will just reject — the button should be inert unless a
    // paused turn is actually sitting there.
    if (get().turnStatus !== 'paused') return false

    // Config rides along per-send, exactly like sendMessage/steer: the user may
    // have switched model or permission while the turn was parked, and the
    // resumed turn must honour whatever is selected now.
    const permission = useSessionConfigStore.getState().permission
    const model = useSessionConfigStore.getState().activeModel
    const thoughtLevel = useSessionConfigStore.getState().thoughtLevel

    const trimmed = (text || '').trim()
    const ok = get().send('resume_turn', {
      permission, model, thoughtLevel, msgId: newMsgId(),
      // Omit `text` when empty so the backend applies its own default nudge
      // rather than resuming on a blank string.
      ...(trimmed ? { text: trimmed } : {}),
    })
    if (!ok) return false

    // Optimistic: the turn is moving again. `turn_state` will confirm `running`
    // on the round trip, but flip the local reading now so the composer doesn't
    // sit looking idle for a beat. Surface the nudge as a user bubble only when
    // the user actually typed one — a bare resume adds no visible message.
    set(state => ({
      isWorking: true,
      turnStartedAt: Date.now(),
      messages: trimmed
        ? [...state.messages, {
            id: `resume-${Date.now()}`,
            role: 'user' as const,
            content: trimmed,
            timestamp: Date.now() / 1000,
          }]
        : state.messages,
    }))
    armStallTimer(set, get as () => AgentState)
    return true
  },

  editMessage: (id: string) => {
    const { messages } = get()
    const idx = messages.findIndex(m => m.id === id)
    if (idx < 0) return null
    const msg = messages[idx]
    if (msg.role !== 'user') return null
    const text = msg.content

    // Compute the user-turn ordinal: which user bubble is this (0-based)?
    // This is the shared handle with the backend's session_truncate frame.
    const userOrdinal = messages.slice(0, idx).filter(m => m.role === 'user').length

    // Tell the backend FIRST (`rollbackFiles: true` triggers the atomic undo:
    // snapshots captured during that turn are restored in the same round trip).
    // If the socket is down the frame goes nowhere, and slicing local state
    // anyway would desync the two histories — the next send would replay the
    // "deleted" span. Fail loudly and change nothing instead.
    if (!get().send('session_truncate', { userOrdinal, rollbackFiles: true })) {
      set(state => ({
        messages: [...state.messages, {
          id: `err-${Date.now()}`,
          role: 'system' as const,
          content: t('store.withdrawFailed', '未连接到后端，撤回失败：本地与后端历史均未改动。'),
          timestamp: Date.now() / 1000,
        }],
      }))
      return null
    }

    // The frame is on the wire — safe to drop this message and everything
    // after it locally.
    set({ messages: messages.slice(0, idx) })

    return text
  },

  rollbackToOrdinal: (ordinal: number) => {
    const { messages } = get()
    // Find the Nth user bubble. Counting here rather than trusting an index
    // from the caller keeps the ordinal meaning identical on both sides of the
    // wire — it is the same count the backend runs over `role='user'` rows.
    let seen = 0
    let idx = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'user') continue
      if (seen === ordinal) { idx = i; break }
      seen++
    }
    if (idx < 0) return false

    // Same deal as editMessage: backend first, local state only once the frame
    // is actually on the wire, so a dropped socket cannot split the histories.
    if (!get().send('session_truncate', { userOrdinal: ordinal, rollbackFiles: true })) {
      set(state => ({
        messages: [...state.messages, {
          id: `err-${Date.now()}`,
          role: 'system' as const,
          content: t('store.withdrawFailed', '未连接到后端，撤回失败：本地与后端历史均未改动。'),
          timestamp: Date.now() / 1000,
        }],
      }))
      return false
    }
    set({ messages: messages.slice(0, idx), ...settleActivity(get()) })
    return true
  },

  forkSession: (id: string) => {
    const { messages } = get()
    const idx = messages.findIndex(m => m.id === id)
    if (idx < 0 || messages[idx].role !== 'user') return false
    // Same ordinal the backend counts: which user bubble is this.
    const ordinal = messages.slice(0, idx).filter(m => m.role === 'user').length
    // No optimistic mutation. The fork is a backend copy + switch; the
    // authoritative `session_switched` frame repaints the timeline, and jumping
    // the gun here would flash a half-built branch that the frame then replaces.
    return get().send('session_fork', { userOrdinal: ordinal })
  },

  pendingForkText: null,
  consumeForkText: () => {
    const t = get().pendingForkText
    if (t !== null) set({ pendingForkText: null })
    return t
  },

  applyShadow: async () => {
    const sid = get().sessionId
    if (!sid) return false
    try {
      const res = await apiFetch(`${API_BASE}/api/shadow/${encodeURIComponent(sid)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      return res.ok
    } catch {
      return false
    }
  },

  discardShadow: async () => {
    const sid = get().sessionId
    if (!sid) return false
    try {
      const res = await apiFetch(`${API_BASE}/api/shadow/${encodeURIComponent(sid)}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      return res.ok
    } catch {
      return false
    }
  },
}))
