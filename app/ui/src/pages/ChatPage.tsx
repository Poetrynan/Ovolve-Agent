import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'


import { useTranslation } from 'react-i18next'
import { useAgentStore, isCotContentLeak, type AgentState } from '@store/agentStore'
import type { ContextRef } from '@store/composerContextStore'
import { useQueueStore } from '@store/queueStore'
import { useCheckpointStore } from '@store/checkpointStore'
import { useGitStore } from '@store/gitStore'
import { useSessionListStore } from '@store/sessionListStore'
import { useShallow } from 'zustand/react/shallow'
import { PanelLeftOpen, PanelLeftClose, PanelRightOpen, PanelRightClose, Download, AlertTriangle, Folder } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@components/ui/tooltip'
import { MessageScroller, Bubble, BubbleAvatar, TypingIndicator, ChatImages, ChatHeroTitle, ChatHeroChips, TimelineRail, MessageErrorBoundary, ChatSkeleton } from '@components/ui/chat'


import { GitStatusPill } from '@components/git/GitStatusPill'
import { GitChangeSummary } from '@components/git/GitChangeSummary'
import { SessionTripartiteCapsule } from '@components/chat/SessionTripartiteCapsule'
import { Composer } from '@components/chat/Composer'
import { QueuePanel } from '@components/chat/QueuePanel'
import { FoldMarker } from '@components/chat/FoldMarker'
import { EvolutionNotice } from '@components/chat/EvolutionNotice'
import { EvolutionProposalCard } from '@components/chat/EvolutionProposalCard'
import { MoaCouncilCard } from '@components/chat/MoaCouncilCard'
import { RedTeamAlertCard } from '@components/chat/RedTeamAlertCard'
import { ShadowValidationCard } from '@components/chat/ShadowValidationCard'
import { VerificationCard } from '@components/chat/VerificationCard'
import { StepProgress } from '@components/chat/StepProgress'
import { ActivityFeed } from '@components/chat/ActivityFeed'
import PlanReviewCard from '@components/chat/PlanReviewCard'
import { SubagentPanel } from '@components/chat/SubagentPanel'
import { ModelReadyBanner } from '@components/chat/ModelReadyBanner'
import { TurnRetryBanner } from '@components/chat/TurnRetryBanner'
import { PendingEvolutionBanner } from '@components/chat/PendingEvolutionBanner'
import { RollbackConfirmDialog, assessWithdraw, shouldConfirmWithdraw, type WithdrawImpact } from '@components/chat/RollbackConfirmDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@components/ui/alert-dialog'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  useStoredLayout,
  type PanelImperativeHandle,
} from '@components/ui/resizable'
import { SidePanel } from '@components/workspace/SidePanel'
import { useSidePanelStore } from '@store/sidePanelStore'


import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { cn } from '@/lib/utils'

interface ChatPageProps {
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
}

export default function ChatPage({
  sidebarOpen = true,
  onToggleSidebar,
}: ChatPageProps) {
  const { t } = useTranslation()
  // Shallow-picked subscriptions. The old whole-store subscribe re-rendered
  // this entire page on EVERY state change — including the `events` log, which
  // gets a new array identity on every inbound frame — so streaming a reply
  // re-rendered the full chat surface per token. Selecting exactly what the
  // render needs keeps the re-render set to "the data that actually changed".
  const {
    messages, connected, isWorking, turnStatus, sessionId, streamingMessageId,
    imageGenerating, reasoning, toolCalls, toolPreviews, subagents, currentPhase,
    connect, disconnect, sendMessage, stop, resumeTurn, rollbackToOrdinal,
    forkSession, pendingForkText, consumeForkText, send, editMessage, pendingPlan,
  } = useAgentStore(useShallow((s: AgentState) => ({
    messages: s.messages, connected: s.connected, isWorking: s.isWorking,
    turnStatus: s.turnStatus, sessionId: s.sessionId, streamingMessageId: s.streamingMessageId,
    imageGenerating: s.imageGenerating, reasoning: s.reasoning, toolCalls: s.toolCalls,
    toolPreviews: s.toolPreviews,
    subagents: s.subagents, currentPhase: s.currentPhase,
    connect: s.connect, disconnect: s.disconnect, sendMessage: s.sendMessage, stop: s.stop,
    resumeTurn: s.resumeTurn, rollbackToOrdinal: s.rollbackToOrdinal, forkSession: s.forkSession,
    pendingForkText: s.pendingForkText, consumeForkText: s.consumeForkText, send: s.send,
    editMessage: s.editMessage,
    pendingPlan: s.pendingPlan,
  })))
  const queueItems = useQueueStore(s => s.items)
  const queuePaused = useQueueStore(s => s.paused)
  const checkpoints = useCheckpointStore(s => s.nodes)
  const refreshCheckpoints = useCheckpointStore(s => s.refresh)
  const resetCheckpoints = useCheckpointStore(s => s.reset)
  const refreshGit = useGitStore(s => s.refresh)
  const sessionList = useSessionListStore(s => s.sessions)
  const activeSessionId = useSessionListStore(s => s.activeId)
  const activeWorkspace = useSessionListStore(s => s.activeWorkspace)
  const isSwitchingSession = Boolean(activeSessionId && sessionId && activeSessionId !== sessionId)
  const [draft, setDraft] = useState('')

  const [agentPanelOpen, setAgentPanelOpen] = useState(true)
  // Which panels the right column holds now lives in `sidePanelStore` — it is
  // persisted, and `SidePanel` owns the strip that switches between them.

  // NOTE: no `now` ticker here any more. The queue's wait labels own their own
  // one-second clock inside QueuePanel — hosting it here re-rendered the whole
  // chat surface every second while anything was queued.
  // A withdraw waiting on the user's OK. Null when nothing is pending.
  // `mode` records WHY we're withdrawing, so the confirm handler knows whether
  // to refill the composer (edit) or immediately re-send (regenerate).
  const [pendingWithdraw, setPendingWithdraw] = useState<{
    id: string
    impact: WithdrawImpact
    mode: 'edit' | 'regenerate'
  } | null>(null)
  // Rollback confirmation modal state (holds the userOrdinal to rollback to)
  const [pendingRollbackOrdinal, setPendingRollbackOrdinal] = useState<number | null>(null)
  // Viewport ref shared with TurnRail for IntersectionObserver + scrollIntoView.
  const scrollerViewportRef = useRef<HTMLDivElement | null>(null)
  // Total user turns — the per-bubble "rollback to here" control is hidden on
  // the last one (nothing after it to drop).
  const totalUserTurns = useMemo(
    () => messages.filter((m) => m.role === 'user').length,
    [messages],
  )

  // Latest user message id — used as forceScrollKey so that MessageScroller
  // ONLY forcibly snaps to bottom when the user sends a new turn, NEVER when
  // the assistant replies or finishes streaming while the user is reading history.
  const lastUserMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id
    }
    return null
  }, [messages])

  // ─── Which bubbles get the drop-in entrance ───
  // The entrance is a CSS keyframe (`animate-message-in`): it fires once per DOM
  // node creation and can't tell a brand-new reply from a session that just
  // loaded. Opening a 30-message conversation therefore slid all 30 bubbles up
  // from 10px at once while the scroller jumped to the bottom — the twitch the
  // user sees on switching sessions. Fix: the FIRST time we see a session, every
  // message it arrives with is "history" and renders in place; anything that
  // appears later in that same session is a live reply and animates.
  const historyIdsRef = useRef<Set<string>>(new Set())
  const lastSessionRef = useRef<string | null>(null)
  const prevCountRef = useRef(messages.length)
  if (lastSessionRef.current !== sessionId) {
    lastSessionRef.current = sessionId
    historyIdsRef.current = new Set(
      messages.map((m) => m.id).filter((id): id is string => Boolean(id)),
    )
  } else if (!isWorking && !streamingMessageId) {
    // Settled session: all existing messages are historical, no entrance animation
    for (const m of messages) if (m.id) historyIdsRef.current.add(m.id)
  } else if (prevCountRef.current === 0 && messages.length > 0) {
    for (const m of messages) if (m.id) historyIdsRef.current.add(m.id)
  }
  prevCountRef.current = messages.length

  // Imperative handle for the right resizable panel — toggling via the
  // header buttons calls collapse()/expand() rather than conditionally
  // mounting, which matches the sash-driven collapse behaviour.
  const rightPanelRef = useRef<PanelImperativeHandle | null>(null)
  const { defaultLayout, onLayoutChanged } = useStoredLayout('ovolve-chat-layout')

  const revealSignal = useSidePanelStore((s) => s.revealSignal)

  useEffect(() => {
    const panel = rightPanelRef.current
    if (!panel) return
    if (agentPanelOpen) {
      if (panel.isCollapsed()) panel.expand()
    } else {
      if (!panel.isCollapsed()) panel.collapse()
    }
  }, [agentPanelOpen])

  useEffect(() => {
    if (revealSignal > 0) {
      setAgentPanelOpen(true)
      const panel = rightPanelRef.current
      if (panel && panel.isCollapsed()) {
        panel.expand()
      }
    }
  }, [revealSignal])

  useEffect(() => {
    connect()
  }, [connect])

  // (The queue wait-label ticker used to live here; QueuePanel owns it now.)

  // One read on mount, so the header capsule has something to show before the
  // first tool runs. Until now the only triggers were "a tool settled" and "the
  // session changed", which left `status` null through a whole fresh session —
  // and a null status renders no capsule at all.
  useEffect(() => {
    void refreshGit()
  }, [refreshGit])


  // Refresh git snapshot when a tool finishes (writes / git ops change the tree).
  // Depends on the COUNT of settled tools, not the toolCalls array itself: the
  // array gets a new identity on every streamed delta, which used to re-fire
  // refreshGit() on every token of output — a refresh storm mid-turn.
  const settledToolCount = useMemo(
    () => toolCalls.filter(t => t.status === 'completed' || t.status === 'failed').length,
    [toolCalls],
  )
  useEffect(() => {
    if (settledToolCount > 0) {
      void refreshGit()
    }
  }, [settledToolCount, refreshGit])

  // Timeline (UB1). Re-read whenever the session changes or a turn settles: a
  // finished turn is exactly when a new checkpoint appears, and a truncation is
  // when old ones disappear. Deliberately NOT polled — the nodes only move on
  // those two events, and the rail is allowed to be one turn stale rather than
  // hitting the DB on a timer.
  useEffect(() => {
    resetCheckpoints()
  }, [sessionId, resetCheckpoints])

  useEffect(() => {
    if (isWorking) return
    void refreshCheckpoints(sessionId || undefined)
  }, [sessionId, isWorking, messages.length, refreshCheckpoints])

  // A fork just landed: put the prompt it was taken at back in the composer, so
  // the user can rephrase instead of retyping. Read-once — if they clear the box
  // it stays cleared.
  useEffect(() => {
    if (pendingForkText === null) return
    const text = consumeForkText()
    if (text) setDraft(text)
  }, [pendingForkText, consumeForkText])



  // Send now if idle, otherwise hand it to the backend queue. Draining is the
  // server's job (it runs queued prompts back-to-back after each turn), so the
  // queue survives a renderer reload. `steer` jumps the line.
  const handleSend = async (content: string, steer = false, contextRefs: ContextRef[] = []) => {
    // An attachment with no typed text is a legitimate turn ("here, look at
    // this"), so emptiness is only a reason to bail when there are no refs either.
    if (!content.trim() && contextRefs.length === 0) return
    if (isWorking || queueItems.length > 0 || queuePaused) {
      // The queue carries text only — a queued prompt is replayed later with no
      // per-turn context. Serialize the refs back into the text so they degrade
      // to path hints instead of disappearing between enqueue and replay.
      const hints = contextRefs.map((r) => `@${r.kind}:${r.ref}`)
      const text = hints.length
        ? `${content}\n\n<context>\n${hints.join('\n')}\n</context>`
        : content
      send('queue_enqueue', { text, urgent: steer })
      return
    }
    await sendMessage(content, contextRefs)
    // Instantly scroll down to the bottom on sending a new turn
    requestAnimationFrame(() => {
      if (scrollerViewportRef.current) {
        scrollerViewportRef.current.scrollTop = scrollerViewportRef.current.scrollHeight
      }
    })
  }

  // Actions the `/` command palette can trigger inside this page.
  const slashActions = {
    // "Start fresh" = a new session, exactly like the sidebar's 新对话 button
    // (backend `session_new` + the authoritative repaint on session_switched).
    // This used to be an empty stub while the palette still advertised it.
    newTask: () => { useSessionListStore.getState().newSession() },
    toggleSidebar: () => onToggleSidebar?.(),
    // These are deep links: they open the panel *and* the specific tab, adding
    // it to the strip if it wasn't there. `openTab` is idempotent, so invoking
    // the same command twice focuses the existing tab rather than duplicating it.
    toggleBrowserPanel: () => {
      useSidePanelStore.getState().openTab('browser')
      setAgentPanelOpen(true)
    },
    openFilesPanel: () => {
      useSidePanelStore.getState().openTab('files')
      setAgentPanelOpen(true)
    },

    foldContext: () => useAgentStore.getState().foldContext(),
  }

  /**
   * Export the visible conversation as a Markdown file. Rendered in the
   * renderer only — fold markers become blockquotes, system rows become
   * notes, and the filename carries the session title so exports from
   * different sessions never collide in the downloads folder.
   */
  const handleExportMarkdown = () => {
    if (messages.length === 0) return
    const lines: string[] = [`# ${t('chatPage.exportTitle')}`, '']
    for (const m of messages) {
      if (m.fold) {
        lines.push(`> [${m.fold.strategy ?? 'fold'}]`, '')
        continue
      }

      const statsSuffix = m.turnStats
        ? ` _(${t('chatPage.exportStats', {
            duration: m.turnStats.durationMs >= 1000
              ? `${Math.round(m.turnStats.durationMs / 100) / 10}s`
              : `${m.turnStats.durationMs}ms`,
            tokens: m.turnStats.tokens ?? '—',
          })})_`
        : ''
      lines.push(`### ${m.role === 'system' ? t('chatPage.exportSystem') : m.role === 'user' ? t('chatPage.exportUser') : t('chatPage.exportAssistant')}${statsSuffix}`, '')

      lines.push(m.content.trim() || '—', '')
    }
    const title = useSessionListStore.getState().sessions.find(s => s.id === sessionId)?.title
      || t('chatPage.exportFallbackTitle')
    const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60).trim() || 'chat'
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safe}-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Allows the slash panel to inject text (e.g. `$skillName`) into the composer.
  const handleSlashInsert = (text: string) => setDraft((d) => d + text)

  /**
   * Edit a sent prompt: pull its text back into the composer and drop it (plus
   * everything after) from the timeline, so the user can reword and resend.
   *
   * This is now an ATOMIC withdraw — `editMessage` also truncates the backend's
   * session history and restores the file snapshots that span captured. Because
   * disk state is in scope, anything that actually touched a tool goes through a
   * confirmation that spells out what comes back and what doesn't.
   */
  const handleEditMessage = (id: string) => {
    const target = messages.find((m) => m.id === id)
    if (!target) return
    const impact = assessWithdraw(toolCalls, target.timestamp)
    if (shouldConfirmWithdraw(impact)) {
      setPendingWithdraw({ id, impact, mode: 'edit' })
      return
    }
    applyWithdraw(id, 'edit')
  }

  /**
   * Regenerate an assistant reply: withdraw the user turn that produced it and
   * immediately re-send the same text.
   *
   * Implemented on top of the SAME withdraw path as edit, not as a bare re-send,
   * because a regenerated turn must not stack on top of the previous attempt's
   * side effects — if the first attempt wrote files, replaying the prompt over
   * those writes gives the model a workspace that no longer matches the prompt.
   * Going through `editMessage` truncates the backend history and restores the
   * snapshots first, so the retry starts from the same state the original did.
   * That also means it inherits the confirmation gate for irreversible tools.
   */
  const handleRegenerate = (assistantId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantId)
    if (idx < 0) return
    // Walk back to the user prompt that owns this reply.
    let userIdx = -1
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { userIdx = i; break }
    }
    if (userIdx < 0) return
    const target = messages[userIdx]
    const impact = assessWithdraw(toolCalls, target.timestamp)
    if (shouldConfirmWithdraw(impact)) {
      setPendingWithdraw({ id: target.id, impact, mode: 'regenerate' })
      return
    }
    applyWithdraw(target.id, 'regenerate')
  }

  const handleSaveEdit = async (id: string, newContent: string) => {
    const target = messages.find((m) => m.id === id)
    if (!target || !newContent.trim()) return

    const idx = messages.findIndex((m) => m.id === id)
    if (idx < 0) return
    const userOrdinal = messages.slice(0, idx).filter((m) => m.role === 'user').length

    // Truncate backend session history and rollback files from this turn onwards
    useAgentStore.getState().send('session_truncate', { userOrdinal, rollbackFiles: true })

    // Slice local messages to before this turn
    useAgentStore.setState({
      messages: messages.slice(0, idx),
    })

    // Re-send the edited message as a fresh prompt from this point
    void sendMessage(newContent.trim())
  }

  const applyWithdraw = (id: string, mode: 'edit' | 'regenerate' = 'edit') => {
    const text = editMessage(id)
    setPendingWithdraw(null)
    if (text === null) return
    if (mode === 'regenerate') {
      // Fire-and-forget: sendMessage owns its own error surfacing.
      void sendMessage(text)
    } else {
      setDraft(text)
    }
  }

  // The activity feed (thinking + tool calls) belongs to the CURRENT turn, and
  // is only non-null mid-turn (sendMessage clears it each turn). If this turn's
  // assistant reply already exists it is the very last message, so we splice the
  // feed just above it. Until the reply arrives, the feed is the timeline tail.
  const assistantIsLast = messages.length > 0 && messages[messages.length - 1].role === 'assistant'
  const spliceIdx = assistantIsLast ? messages.length - 1 : -1

  const liveActivityFeed = (isWorking || reasoning.length > 0 || toolCalls.length > 0 || toolPreviews.length > 0 || subagents.length > 0) ? (
    <div className="w-full pl-0 space-y-1">
      {subagents.length > 0 && <SubagentPanel />}
      <ActivityFeed
        reasoning={reasoning}
        toolCalls={toolCalls}
        toolPreviews={toolPreviews}
        working={isWorking}
        phase={currentPhase}
        withAvatar={false}
      />
    </div>
  ) : null

  return (
    /* `reducedMotion="user"` honours the OS "reduce motion" setting for every
       motion element below: transforms and layout animations are dropped, opacity
       still cross-fades. Without it the composer's dock glide would keep flying
       across the column for users who asked the system not to do that. */
    <MotionConfig reducedMotion="user">
    <ResizablePanelGroup
      orientation="horizontal"
      id="ovolve-chat"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      // `overflow-hidden` is not cosmetic. This group's panels only get their
      // pixel sizes after the library's first ResizeObserver pass, so on the
      // frame we mount, `flex-1 min-h-0` below has no definite height to
      // resolve against and the whole transcript lays out at natural height.
      // `h-full` bounds the BOX but not the painted overflow, which spills to
      // the nearest scroll container — WorkspaceShell's `<main>` — long enough
      // for its scrollbar thumb to appear and then vanish once measurement
      // lands. That one-frame flash is what read as 滑动条闪一下. Clipping here
      // keeps `<main>` from ever seeing overflow; every scrollable region
      // inside (MessageScroller, the side panel) owns its own overflow anyway.
      className="h-full relative overflow-hidden"
    >
      {/* `defaultSize` is REQUIRED here, not decorative. A panel without one is
          the "remainder" panel, and this build computes the remainder in JS after
          the group's first measurement pass. Until that lands, the center panel has
          no flex-basis and takes greedy/natural width, which shoves `chat-right`
          past the window edge — the right panel paints at the wrong width with its
          content clipped off-screen, and the seam between the two shows a scrollbar
          track for a frame before everything snaps into place. Stating 76% (100% −
          the right panel's 24%) makes the FIRST paint already correct from CSS
          alone, so there is nothing to snap. Keep it in sync with `chat-right`.
          `overflow-hidden min-h-0` is the belt to that braces: even if a child
          momentarily overflows during measurement, it clips here instead of
          producing a transient scrollbar. MessageScroller still scrolls normally —
          it owns its own `overflow-y-auto` under a `flex-1 min-h-0`. */}
      <ResizablePanel id="chat-center" defaultSize="76%" minSize="35%" className="overflow-hidden min-h-0">
        {/* `relative` is required by the two `mode="popLayout"` groups below:
            popLayout takes an exiting child out of flow with `position:absolute`,
            which needs a positioned ancestor to resolve against — otherwise the
            leaving element snaps to some outer origin as it fades. */}
        <div className="relative flex flex-col w-full min-w-0 min-h-0 h-full overflow-hidden">
        {/* Header — session title + workspace pill + git branch + side panel toggle */}
        <header className="flex items-center gap-2.5 px-4 py-2 border-b border-border/30 bg-card/40 backdrop-blur-2xl min-h-[44px]">
          {onToggleSidebar && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onToggleSidebar}
                  aria-label={sidebarOpen ? t('chatPage.collapseSidebar') : t('chatPage.expandSidebar')}
                  className="flex items-center justify-center h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors duration-150 ease-out press-feedback shrink-0"
                >
                  {sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{sidebarOpen ? t('chatPage.collapseSidebar') : t('chatPage.expandSidebar')}</p>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Dual-posture Tripartite Capsule (when conversation has messages) */}
          {messages.length > 0 && (
            <SessionTripartiteCapsule variant="header" className="hidden sm:inline-flex ml-1" />
          )}

          {/* Connection status dot */}
          <span
            className={`w-1.5 h-1.5 rounded-full animate-status-breathe shrink-0 ${connected ? 'bg-success' : 'bg-destructive'}`}
            title={connected ? t('chatPage.assistantConnected') : t('chatPage.assistantDisconnected')}
          />

          {/* Everything after this point is right-aligned */}
          <div className="ml-auto flex items-center gap-2">
            <GitStatusPill
              onOpenPanel={() => {
                useSidePanelStore.getState().openTab('git')
                setAgentPanelOpen(true)
              }}
              onOpenFiles={() => {
                useSidePanelStore.getState().openTab('files')
                setAgentPanelOpen(true)
              }}
            />



            {/* Export the visible conversation as Markdown */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleExportMarkdown}
                  disabled={messages.length === 0}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
                  aria-label={t('chatPage.exportChat')}
                >
                  <Download size={15} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom"><p>{t('chatPage.exportChat')}</p></TooltipContent>
            </Tooltip>

            {/* The turn navigator is no longer a header popover — it now lives
                as a right-edge sticky timeline inside the message area. */}

            {/* The panel used to be preceded by a Git / 文件 / 🌐 segmented
                control here, which was the outer of two nested tab rows — the
                inner one lived inside `SidePanel` and truncated its labels to
                one character each. The whole inventory now lives in the panel's
                own strip and picker, so this header keeps only the show/hide
                toggle. */}
            <Tooltip>

              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setAgentPanelOpen(v => !v)}
                  aria-label={agentPanelOpen ? t('chatPage.closeToolPanel') : t('chatPage.openToolPanel')}
                  className="flex items-center justify-center h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors duration-150 press-feedback shrink-0"
                >
                  {agentPanelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>{t('chatPage.toolPanelTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </header>

        {/* Degraded-mode strip. Renders nothing when a key is configured, so it
            costs no space in the normal case. Sits directly under the header so
            it stays visible in BOTH the hero and conversation layouts. */}
        <ModelReadyBanner />
        <TurnRetryBanner />
        {/* 待你确认的记忆提案 / 技能草稿 / 问题卡。与 EvolutionNotice 的分工：
            chip 说"这一回合发生了什么"（实时、只在内存里），这条说"现在还欠着
            什么"，来自后端投影，刷新和切会话都还在。 */}
        <PendingEvolutionBanner />


        {/* ─── Two-state layout: Hero (empty) → Conversation (has messages) ───
            The Composer wrapper below is ONE motion element that stays mounted
            across both states. When `messages.length` flips 0→1 the surrounding
            flex layout changes, framer-motion measures the composer's box
            before/after via FLIP, and animates the transform (compositor-only,
            no layout thrash) so the input glides down to its docked position.

            Splitting into two branches with two Composer instances — which is
            what we had before — unmounts and remounts the element on each side,
            defeating `layout` and producing an instant teleport. Keep it single. */}

        {/* `mode="popLayout"` is the whole fix for the 新建对话 jank. Without it,
            when messages → [] the scroller and the incoming hero are BOTH flex-1
            in the column for the exit's duration, so the dying message list gets
            squeezed to half height while it fades — the "抽搐/变形" the user saw.
            popLayout yanks the exiting scroller out of flow the instant it starts
            leaving, so the hero and composer settle into their final positions
            immediately while the old bubbles fade out on top of them. */}
        <AnimatePresence initial={false} mode="popLayout">
          {messages.length === 0 ? (
            <motion.div
              key="hero-top"
              // Opacity ONLY. A `y` here fought the same `y` that ChatHeroTitle
              // used to apply to itself (they compounded on enter and pulled
              // opposite ways on exit); with the child now inert, a slide would
              // still be a second motion competing with the composer's glide for
              // attention. The decoration's job is to get out of the way fast —
              // 140ms, done well before the 320ms dock lands.
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: 'linear' }}
              className="flex-1 flex flex-col items-center justify-end px-6 pb-4"
            >
              <ChatHeroTitle />
            </motion.div>
          ) : (
            <motion.div
              key="chat"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="flex-1 min-h-0 flex flex-col relative"
            >
              <MessageScroller
                resetKey={sessionId}
                viewportRef={scrollerViewportRef}
                forceScrollKey={lastUserMsgId}
              >
                {messages.map((msg, i) => {


                  if (msg.kind === 'fold' && msg.fold) {
                    return <FoldMarker key={msg.id || i} fold={msg.fold} />
                  }
                  if (msg.kind === 'evolution' && msg.evolution) {
                    return <EvolutionNotice key={msg.id || i} insight={msg.evolution} />
                  }
                  if (msg.kind === 'evolution_card' && msg.evolutionProposal) {
                    return <EvolutionProposalCard key={msg.id || i} proposal={msg.evolutionProposal} />
                  }
                  if (msg.kind === 'moa' && msg.moa) {
                    return <MoaCouncilCard key={msg.id || i} council={msg.moa} />
                  }
                  if (msg.kind === 'red_team' && msg.redTeam) {
                    return <RedTeamAlertCard key={msg.id || i} alert={msg.redTeam} />
                  }
                  if (msg.kind === 'shadow' && msg.shadow) {
                    return <ShadowValidationCard key={msg.id || i} report={msg.shadow} />
                  }
                  if (msg.kind === 'verification' && msg.verification) {
                    return <VerificationCard key={msg.id || i} report={msg.verification} />
                  }
                  if (msg.role === 'system') {
                    if (
                      msg.content?.startsWith('Confirmation required:') ||
                      msg.content?.includes('[系统] 用户已确认') ||
                      msg.content?.includes('接下来有一步操作需要你点头')
                    ) {
                      return null
                    }
                    const animateRow = !(msg.id && historyIdsRef.current.has(msg.id))
                    return (
                      <div key={msg.id || i} className={cn('flex justify-center', animateRow && 'animate-message-in')}>
                        <div className="px-3.5 py-2 rounded-lg bg-destructive/10 border border-destructive/25 text-destructive text-xs font-medium">
                          {msg.content}
                        </div>
                      </div>
                    )
                  }
                  const isUser = msg.role === 'user'
                  // Turn index = this user message's ordinal among all user
                  // messages. Used as the scroll anchor id the TurnRail targets.
                  const turnIndex = isUser
                    ? messages.slice(0, i).filter((m) => m.role === 'user').length
                    : -1
                  // Rollback-to-here lives on the bubble itself (IDE
                  // style). Truncates from this user turn onwards (drops this turn and any assistant reply after it).
                  const rollbackHere = isUser
                    ? () => setPendingRollbackOrdinal(turnIndex)
                    : undefined
                  const isStreamingTail = !isUser && msg.id === streamingMessageId
                  const isContentLeak = isCotContentLeak(msg.content)
                  const isEmptyAssistant = !isUser && (!msg.content.trim() || (isContentLeak && Boolean(liveActivityFeed || msg.reasoning?.length)))
                    && !msg.images?.length && (!isStreamingTail || isContentLeak)

                  // Only treat as live current turn if liveActivityFeed is active and index matches spliceIdx
                  const isCurrentTurn = Boolean(liveActivityFeed) && i === spliceIdx
                  const feedToRender = isCurrentTurn
                    ? liveActivityFeed
                    : (!isUser && Boolean(msg.toolCalls?.length || msg.reasoning?.length)
                        ? <ActivityFeed reasoning={msg.reasoning || []} toolCalls={msg.toolCalls || []} withAvatar={false} />
                        : null)

                  const showBubble = isUser || (!isEmptyAssistant && Boolean(msg.content.trim()))
                  const showRow = isUser || Boolean(feedToRender) || showBubble || Boolean(msg.images && msg.images.length > 0)

                  if (!showRow) return null

                  const bubble = (
                    <div
                      key={msg.id || i}
                      className={cn(
                        'w-full flex items-start',
                        isUser ? 'justify-end' : 'justify-start'
                      )}
                      {...(isUser ? { 'data-role': 'user', 'data-turn-index': turnIndex } : {})}
                    >
                      <div className={cn('flex flex-col gap-1', isUser ? 'w-full items-end' : 'w-full items-start')}>
                        {feedToRender}
                        {showBubble && (
                          <Bubble
                            role={isUser ? 'user' : 'assistant'}
                            messageId={msg.id}
                            streaming={!isUser && msg.id === streamingMessageId}
                            animate={!(msg.id && historyIdsRef.current.has(msg.id))}
                            timestamp={msg.timestamp}
                            turnStats={msg.turnStats}
                            onEdit={isUser ? handleEditMessage : undefined}
                            onSaveEdit={isUser ? handleSaveEdit : undefined}
                            onFork={isUser ? forkSession : undefined}
                            onRegenerate={!isUser ? handleRegenerate : undefined}
                            onRollbackTurn={rollbackHere}
                          >
                            {msg.content}
                          </Bubble>
                        )}
                        {msg.images && msg.images.length > 0 && (
                          <ChatImages images={msg.images} />
                        )}
                      </div>
                    </div>
                  )

                  const rowKey = `msg-${msg.id || i}`
                  const wrap = (node: ReactNode) => (
                    <MessageErrorBoundary key={rowKey} raw={msg.content}>
                      {node}
                    </MessageErrorBoundary>
                  )

                  return bubble ? wrap(bubble) : null
                })}

                {spliceIdx === -1 && liveActivityFeed && (
                  <div className="w-full flex items-start justify-start">
                    <div className="flex flex-col gap-1 w-full items-start">
                      {liveActivityFeed}
                    </div>
                  </div>
                )}

                {/* Step progress — shows current step for multi-step tasks.
                    Reads from currentPhase in the store (transient, not a message).
                    Only renders when the backend reports step + steps. */}
                {Boolean(currentPhase && typeof currentPhase.step === 'number' && currentPhase.step > 0 && typeof currentPhase.steps === 'number' && currentPhase.steps > 1) && (
                  <StepProgress
                    steps={currentPhase!.steps!}
                    current={Math.min(currentPhase!.step!, currentPhase!.steps!)}
                    phase={currentPhase!.phase}
                    tool={currentPhase!.tool}
                  />
                )}

                {pendingPlan && (
                  <PlanReviewCard
                    planId={pendingPlan.planId}
                    preview={pendingPlan.preview}
                    chars={pendingPlan.chars}
                    onSend={send}
                    onClose={() => useAgentStore.setState({ pendingPlan: null })}
                  />
                )}              </MessageScroller>

              {/* Sticky turn timeline — right edge of the message area.
                  Collapsed: dots only; hover expands a glass panel with each
                  turn's first line; click scrolls to that turn. Pure
                  navigation — rollback lives on the user bubbles now. */}
              <TimelineRail
                key={sessionId || 'timeline-rail'}
                sessionId={sessionId}
                messages={messages}
                scrollerRef={scrollerViewportRef}
                checkpoints={checkpoints}
                working={isWorking}
              />
            </motion.div>


          )}
        </AnimatePresence>

        {/* THE composer band — a SINGLE always-mounted motion element. Its
            `layout` prop is what makes the transition smooth: framer measures
            the box before and after the surrounding layout flips, then animates
            the transform delta with a spring. Two className branches change the
            *frame* (centered wide row vs. bottom bar with glass + border), but
            the inner DOM is identical, so React never remounts it and `draft`
            state, caret, and focus survive the transition. */}
        <motion.div
          layout
          // ONE deterministic curve for the dock glide, not a spring. A spring's
          // settle time is open-ended, so nothing else in the transition could be
          // timed against it — the hero fade, the chip collapse and this glide all
          // finished at different moments, which read as the stutter. A fixed
          // 320ms easeOutExpo lands predictably and everything can share it.
          transition={{ layout: { duration: 0.32, ease: [0.16, 1, 0.3, 1] } }}
          className="px-6 pb-4 pt-2 shrink-0 bg-transparent"
        >
          <motion.div layout className="max-w-3xl mx-auto">
            {messages.length === 0 && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="flex justify-center -mb-[1px] relative z-10"
              >
                <SessionTripartiteCapsule variant="hero" />
              </motion.div>
            )}
            <GitChangeSummary compact />
            <QueuePanel />
            <Composer
              value={draft}
              onValueChange={setDraft}
              onSend={handleSend}
              busy={isWorking}
              queueDepth={queueItems.length}
              onStop={stop}
              canResume={turnStatus === 'paused'}
              onResume={resumeTurn}
              slashActions={slashActions}
              onSlashInsert={handleSlashInsert}
            />
          </motion.div>
        </motion.div>

        {/* The suggestion chips under the composer, and — just as importantly —
            the bottom half of the empty state's vertical centring. Together with
            the `flex-1` region above, this `flex-1` band is what puts the composer
            in the middle of the column; when it goes away the composer's docked
            position at the bottom is what's left.
            NO `AnimatePresence` on purpose, so there is no exit: on the first send
            this band unmounts in the SAME frame the message list appears. That is
            the whole point. While it was fading out over 220ms it still held
            `flex-1` worth of space below the composer, so the composer's docked
            target was itself still moving — it glided toward a position that only
            settled once the chips finally unmounted. Two-stage motion, which is
            the 停顿 you felt. Unmounting instantly means the final layout is
            correct on frame one and the glide above has a fixed target to animate
            to. `animate-fade-in` (opacity only, no transform) covers the reverse
            direction, when the empty state comes back. */}
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-start px-6 pt-4 pb-6 animate-fade-in">
            <ChatHeroChips onPick={(prompt) => setDraft(prompt)} />
          </div>
        )}
        </div>
      </ResizablePanel>

      {/* Right panel — contextual depending on active tab.
          Wrapped in a resizable Panel so the user can grab the sash between
          center and right to reshape the workspace. `collapsible + collapsedSize=0`
          keeps the existing "toggle to hide" flow: the toggle button calls
          collapse()/expand() via the ref, and dragging the sash to the minimum
          also collapses. */}

      <ResizableHandle
        className="hover:bg-border/70 transition-colors data-[panel-collapsed=true]:hidden"
        title="拖拽调整宽度 · 双击恢复默认"
      />

      <ResizablePanel
        panelRef={rightPanelRef}
        id="chat-right"
        defaultSize="24%"
        minSize="16%"
        maxSize="45%"
        collapsible
        collapsedSize={0}
        className="overflow-hidden border-l border-border/30 bg-card/45 backdrop-blur-2xl data-[panel-collapsed=true]:border-l-0"
      >
        <SidePanel onCollapse={() => setAgentPanelOpen(false)} />
      </ResizablePanel>


      {/* Atomic-withdraw confirmation. Mounted once at the page root so it
          overlays everything; state lives in `pendingWithdraw`. */}
      <RollbackConfirmDialog
        open={pendingWithdraw !== null}
        onOpenChange={(open) => { if (!open) setPendingWithdraw(null) }}
        impact={pendingWithdraw?.impact ?? { reversible: [], irreversible: [] }}
        onConfirm={() => {
          // Pass the mode through: a confirmed *regenerate* must re-send the
          // prompt, not merely refill the composer the way an edit does.
          if (pendingWithdraw) applyWithdraw(pendingWithdraw.id, pendingWithdraw.mode)
        }}
      />

      {/* Turn Rollback Confirmation Modal (minimal IDE style) */}
      <AlertDialog
        open={pendingRollbackOrdinal !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRollbackOrdinal(null)
        }}
      >
        <AlertDialogContent className="max-w-[380px] p-5 gap-3.5 rounded-xl border border-border bg-card shadow-xl">
          <AlertDialogHeader className="space-y-1.5 text-left">
            <AlertDialogTitle className="text-sm font-semibold text-foreground tracking-tight">
              {pendingRollbackOrdinal === 0 ? '撤回至初始状态？' : `撤回第 ${(pendingRollbackOrdinal ?? 0) + 1} 轮消息？`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground leading-relaxed">
              此操作将撤回此轮提问及后续所有回复，并将工作区文件恢复至当时的状态。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter className="flex-row items-center justify-end gap-2 sm:space-x-0 pt-1">
            <AlertDialogCancel
              onClick={() => setPendingRollbackOrdinal(null)}
              className="h-8 px-3 text-xs rounded-lg border-border/60 hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRollbackOrdinal !== null) {
                  rollbackToOrdinal(pendingRollbackOrdinal)
                  setPendingRollbackOrdinal(null)
                }
              }}
              className="h-8 px-3 text-xs font-medium rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              确认回滚
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ResizablePanelGroup>
    </MotionConfig>
  )
}
