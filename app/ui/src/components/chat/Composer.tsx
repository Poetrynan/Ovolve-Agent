// src/components/chat/Composer.tsx
// Unified composer card. One rounded border contains:
//   [attachment / mention chips]
//   [textarea]
//   [📎] [Mode] [Model] [Thought]        [Ctx] [Send]
// Plus the three "add context" entries from mature agent composers:
//   • 📎 attachment button (+ paste / drag-drop)
//   • @ mention panel  (files / skills / subagents / sessions)
//   • / slash command palette
import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Plus, Paperclip, AtSign, ClipboardPaste, ListPlus, Square, FoldVertical, Zap, Play, ArrowUp } from 'lucide-react'
import { cn } from '@lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@components/ui/popover'
import { PermissionSelector } from './PermissionSelector'
import { ModelSelector } from './ModelSelector'
import { ThoughtLevelSelector } from './ThoughtLevelSelector'
import { ContextMeter } from './ContextMeter'
import { AttachmentBar } from './AttachmentBar'
import { MentionPanel } from './MentionPanel'
import { SlashPanel } from './SlashPanel'
import { BorderBeam } from '@/components/ui/BorderBeam'
import { useSessionConfigStore } from '@store/sessionConfigStore'
import { useModelStore } from '@store/modelStore'
import { useContextUsageStore } from '@store/contextUsageStore'
import { useComposerContextStore, RESOLVABLE_MENTION_KINDS } from '@store/composerContextStore'
import type { ContextRef } from '@store/composerContextStore'
import { useAgentStore } from '@store/agentStore'
import { countTokens, encodingFor } from '@lib/tokens'
import { useResolvedThinkingCapability } from '@hooks/useResolvedThinkingCapability'

const MAX_ATTACHMENTS = 10
const MAX_BYTES = 20 * 1024 * 1024 // 20 MB, a common default guard

/** Accepted attachment types, surfaced in the + menu and used as picker filters. */
const ATTACHMENT_FILTERS = [
  { nameKey: 'composer.filterImage', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
  { nameKey: 'composer.filterDoc', extensions: ['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'csv'] },
  { nameKey: 'composer.filterText', extensions: ['txt', 'md', 'json', 'yaml', 'yml', 'xml', 'log', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'css', 'html', 'sh', 'sql', 'toml', 'ini'] },
  { nameKey: 'composer.filterAll', extensions: ['*'] },
]

/** Short human-readable summary of what can be attached. */
const ATTACHMENT_HINT_KEY = 'composer.attachmentHint'

interface ComposerProps {
  value: string
  onValueChange: (v: string) => void
  /** `steer=true` means "jump the queue" — Shift-click or Shift-Enter.
   *  `contextRefs` carries @-references for the backend to resolve (UB2). */
  onSend: (message: string, steer?: boolean, contextRefs?: ContextRef[]) => void
  /** The agent is busy on another turn. Sending is allowed — it enqueues. */
  busy?: boolean
  /** How many prompts are already waiting; controls the send-button copy. */
  queueDepth?: number
  /** Interrupt the in-flight turn. When provided, a stop button replaces send. */
  onStop?: () => void
  /**
   * A previously stopped turn is still sitting there, pickable. Comes from the
   * persisted turn status, so it survives a reload — which is the whole point:
   * before, stopping a turn lost the thread the moment the window closed.
   */
  canResume?: boolean
  /**
   * Pick the paused turn back up. Only reachable while `canResume`. Receives the
   * current draft when there is one, so "type a correction, then resume" works
   * without a separate send.
   */
  onResume?: (text?: string) => void
  placeholder?: string
  className?: string
  /** Actions the `/` palette can trigger in the host page. */
  slashActions?: {
    newTask: () => void
    toggleSidebar: () => void
    toggleBrowserPanel: () => void
    openFilesPanel: () => void
    foldContext?: () => void
  }
  /** Lets the `/` palette inject text (skills, subagents) into the draft. */
  onSlashInsert?: (text: string) => void
}

export function Composer({
  value,
  onValueChange,
  onSend,
  busy = false,
  queueDepth = 0,
  onStop,
  canResume = false,
  onResume,
  placeholder,
  className,
  slashActions,
  onSlashInsert,
}: ComposerProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const { activeModel } = useSessionConfigStore()
  const { providers } = useModelStore()
  const updateUsage = useContextUsageStore((s) => s.update)
  const setPendingInput = useContextUsageStore((s) => s.setPendingInput)
  const { attachments, mentions, addAttachment, updateAttachment, clear } = useComposerContextStore()
  const sendWs = useAgentStore((s) => s.send)

  const [pid, mid] = activeModel.split(':')
  const activeModelDef = providers[pid]?.models?.[mid]
  const thinkingCap = useResolvedThinkingCapability(activeModel, activeModelDef, mid)
  // Can the picked model read images (UB3)? Explicit declaration first, the
  // catalogue's input modalities otherwise — the same order the backend resolves
  // in (#151), so the pre-send warning and the actual behaviour agree.
  const modelSeesImages =
    activeModelDef?.capability?.supportsVision ??
    !!activeModelDef?.modalities?.input?.includes('image')
  // Is there ANY usable model at all? Same source of truth the model picker
  // uses, so 「未配置模型」 in the pill and a blocked send can never disagree.
  const hasUsableModel = useModelStore((s) => s.enabledModels().length > 0)

  const enc = encodingFor(mid)

  // ── Trigger detection: what is immediately before the caret? ──
  const trigger = useMemo(() => {
    const activeCaret = caret || textareaRef.current?.selectionStart || value.length
    const before = value.slice(0, activeCaret)
    // `/` only counts at the very start of the composer.
    const slash = /^\/([^\s]*)$/.exec(before)
    if (slash) return { type: 'slash' as const, query: slash[1], start: 0 }
    // `@` counts at start or after whitespace.
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
    if (at) {
      const start = before.lastIndexOf('@')
      return { type: 'mention' as const, query: at[1], start }
    }
    return null
  }, [value, caret])

  const syncCaret = () => setCaret(textareaRef.current?.selectionStart ?? 0)

  /** Remove the `@foo` / `/foo` token that opened a panel. */
  const stripTrigger = useCallback(() => {
    if (!trigger) return
    const next = value.slice(0, trigger.start) + value.slice(caret)
    onValueChange(next)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.selectionStart = el.selectionEnd = trigger.start
        setCaret(trigger.start)
      }
    })
  }, [trigger, value, caret, onValueChange])

  // Auto-grow the textarea up to a cap.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])

  // Draft + attachment/mention refs all count toward the context gauge.
  useEffect(() => {
    const refsText = mentions.map((m) => m.ref).join('\n')
    setPendingInput(countTokens(value, enc) + countTokens(refsText, enc))
  }, [value, mentions, enc, setPendingInput])

  useEffect(() => {
    if (activeModelDef?.limit?.context) {
      // Set the window AND mark it known — this is the active model's real
      // context size, so percentages drawn from it are honest.
      updateUsage({ maxTokens: activeModelDef.limit.context, windowKnown: true })
    }
  }, [activeModelDef, updateUsage])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // ── Attachments ──
  const ingestFile = useCallback(
    (meta: { fileName: string; mime: string; bytes: number; path?: string; previewUri?: string }) => {
      if (attachments.length >= MAX_ATTACHMENTS) {
        setNotice(t('composer.maxAttachments', { max: MAX_ATTACHMENTS }))
        return
      }
      if (meta.bytes > MAX_BYTES) {
        setNotice(t('composer.sizeLimit', { size: Math.round(MAX_BYTES / 1024 / 1024) }))
        return
      }
      const id = `att-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      addAttachment({ id, state: 'queued', ...meta })
      // Local files need no upload — mark ready on the next tick.
      requestAnimationFrame(() => updateAttachment(id, { state: 'ready' }))
    },
    [attachments.length, addAttachment, updateAttachment, t],
  )

  const pickFile = async (imagesOnly = false) => {
    const resolved = ATTACHMENT_FILTERS.map((f) => ({ name: t(f.nameKey), extensions: f.extensions }))
    const filters = imagesOnly ? [resolved[0]] : resolved
    const p: string | null = await window.electronAPI?.invoke('file:pickFile', filters)
    if (!p) return
    const st = await window.electronAPI?.invoke('file:stat', p)
    const name = p.split(/[\\/]/).pop() ?? p
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = /^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext) ? `image/${ext}` : 'application/octet-stream'
    ingestFile({ fileName: name, mime, bytes: st?.size ?? 0, path: p })
  }

  /** Insert `@` at the caret to open the mention panel from the + menu. */
  const insertMentionTrigger = () => {
    const el = textareaRef.current
    const at = value.slice(0, caret).endsWith(' ') || caret === 0 ? '@' : ' @'
    const next = value.slice(0, caret) + at + value.slice(caret)
    onValueChange(next)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const pos = caret + at.length
      el.selectionStart = el.selectionEnd = pos
      setCaret(pos)
    })
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const image = items.find((i) => i.type.startsWith('image/'))
    if (!image) return // plain text paste falls through to the textarea
    const file = image.getAsFile()
    if (!file) return
    e.preventDefault()
    const reader = new FileReader()
    reader.onload = () =>
      ingestFile({
        fileName: file.name || t('composer.pastedImageName', { ext: file.type.split('/')[1] ?? 'png' }),
        mime: file.type,
        bytes: file.size,
        previewUri: String(reader.result),
      })
    reader.readAsDataURL(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    for (const f of Array.from(e.dataTransfer.files ?? [])) {
      ingestFile({
        fileName: f.name,
        mime: f.type || 'application/octet-stream',
        bytes: f.size,
        path: (f as any).path,
      })
    }
  }

  // ── Send ──
  const hasContent = !!(value.trim() || attachments.length || mentions.length)
  /** Submitting right now would land in the queue rather than start a turn. */
  const willQueue = busy
  const sendLabel = willQueue ? t('composer.queueLabel') : t('composer.sendLabel')
  /** Steerable state: the agent is running and the user typed something — the
   * combination that means "inject guidance right now" instead of "enqueue". */
  const isWorking = useAgentStore((s) => s.isWorking)
  const steer = useAgentStore((s) => s.steer)
  const canSteer = isWorking && hasContent

  // ── Prompt history (⌘↑ / ⌘↓) ──
  // Newest first, deduped: re-sending the same prompt three times shouldn't
  // cost three presses to walk past.
  const storeMessages = useAgentStore((s) => s.messages)
  const history = useMemo(() => {
    const out: string[] = []
    for (let i = storeMessages.length - 1; i >= 0; i--) {
      const m = storeMessages[i]
      if (m.role !== 'user' || !m.content.trim()) continue
      if (out[out.length - 1] === m.content) continue
      out.push(m.content)
    }
    return out
  }, [storeMessages])
  /** -1 = live draft; 0..n = walking back through history. */
  const [histIdx, setHistIdx] = useState(-1)
  /** The half-typed draft as it was when ⌘↑ first left the live slot, so
   * walking back to it restores the user's text instead of blanking it. */
  const stashedDraft = useRef('')

  const recallHistory = (dir: 1 | -1) => {
    const next = histIdx + dir
    if (next < -1 || next >= history.length) return
    if (histIdx === -1 && next !== -1) stashedDraft.current = value
    setHistIdx(next)
    onValueChange(next === -1 ? stashedDraft.current : history[next])
  }

  const handleSend = useCallback((steerIntent = false) => {
    if (!value.trim() && attachments.length === 0 && mentions.length === 0) return
    // No model, no turn. Nothing downstream checked this: the composer only
    // looked at whether there was text, and the backend only falls back to its
    // canned reply when the API KEY is missing — so a saved key plus an unusable
    // model id produced a user bubble followed by an empty assistant bubble and
    // no explanation. Refuse here, keep the text in the box, and say where to go.
    if (!hasUsableModel) {
      setNotice(t('composer.noModelConfigured'))
      return
    }

    // How each attachment can actually reach the backend (UB3).
    //
    // An IMAGE has two possible bodies: a pasted one exists only as a data URL in
    // `previewUri` (its bytes never touched disk), a picked one exists only as a
    // `path` (its bytes never entered the renderer). Both are deliverable — the
    // ref is just a different string, and the backend reads whichever it gets.
    // Before this, only `path` was forwarded, so every pasted screenshot was
    // dropped with a notice; that was honest but useless.
    const isImage = (a: typeof attachments[number]) => a.mime.startsWith('image/')
    const imageRefs = attachments
      .filter((a) => isImage(a) && (a.path || a.previewUri))
      .map((a) => ({ kind: 'image', ref: (a.path || a.previewUri) as string, label: a.fileName }))
    const fileRefs = attachments
      .filter((a) => !isImage(a) && a.path)
      .map((a) => ({ kind: 'file', ref: a.path as string, label: a.fileName }))
    // Still undeliverable: a NON-image with no path (there is nothing to read and
    // no bytes to send). Kept visible rather than dropped silently.
    const undeliverable = attachments.filter((a) => !isImage(a) && !a.path)
    if (undeliverable.length) {
      setNotice(t('composer.attachmentNotSent', { count: undeliverable.length }))
      // If an undeliverable file is the ONLY thing here, don't fire an empty
      // turn that throws it away — leave the composer untouched so the user can
      // react (remove it, or add text) instead of losing it to a no-op send.
      if (!value.trim() && imageRefs.length === 0 && fileRefs.length === 0
          && mentions.length === 0) return
    }
    // Pre-send admission check on the model's vision capability. NOT a block:
    // the backend now tells the model explicitly that images were attached and
    // couldn't be read, so the turn is still useful for whatever text there is.
    // The warning exists so the user learns to switch models instead of
    // wondering why the answer ignored their screenshot.
    if (imageRefs.length > 0 && !modelSeesImages) {
      setNotice(t('composer.visionUnsupported', { model: mid || activeModel }))
    }

    // Two channels, split by what the backend can actually DO with each ref.
    //
    // Resolvable kinds (files, dirs, git diffs, images) go through the structured
    // `contextRefs` channel: the backend reads them and injects the real content.
    // Everything else — skills, subagents, sessions — has no resolver yet, so it
    // stays a text hint, which is strictly better than sending a ref the backend
    // would answer with "unsupported kind".
    const resolvable = (k: string) => (RESOLVABLE_MENTION_KINDS as readonly string[]).includes(k)
    const structuredRefs = [
      ...mentions.filter((m) => resolvable(m.kind))
        .map((m) => ({ kind: m.kind, ref: m.ref, label: m.label })),
      ...fileRefs,
      ...imageRefs,
    ]
    const textMentions = mentions.filter((m) => !resolvable(m.kind))

    // 真Steer: while a turn is live, a steer-intent submit injects into the
    // running loop instead of queueing for after it. Any other case (idle, or
    // just jumping the queue) goes through the normal send path.
    if (steerIntent && isWorking) {
      // A steer is injected mid-loop as bare text — there is no structured slot
      // on that path. Serialize what CAN be named so a file attached to a
      // correction isn't silently lost; a path the model can read is worse than
      // resolved content but far better than nothing. A pasted image has no name
      // to serialize, so it is reported as unsendable instead of vanishing.
      const all = [
        ...mentions.map((m) => `@${m.kind}:${m.ref}`),
        ...attachments.filter((a) => a.path).map((a) => `@file:${a.path}`),
      ]
      const pastedOnly = attachments.filter((a) => !a.path && a.previewUri)
      if (pastedOnly.length) {
        setNotice(t('composer.steerNoImages', { count: pastedOnly.length }))
      }
      steer(all.length ? `${value}\n\n<context>\n${all.join('\n')}\n</context>` : value)
    } else {
      const hints = textMentions.map((m) => `@${m.kind}:${m.ref}`)
      const payload = hints.length
        ? `${value}\n\n<context>\n${hints.join('\n')}\n</context>`
        : value
      onSend(payload, steerIntent, structuredRefs)
    }
    onValueChange('')
    clear()
    setHistIdx(-1)
  }, [value, attachments, mentions, onSend, onValueChange, clear, isWorking, steer, t,
      modelSeesImages, mid, activeModel, hasUsableModel])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Let an open panel own the arrow/enter keys.
    if (trigger && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return

    // Esc = stop generating. The universal convention across agent apps,
    // and we were missing it — the stop button was
    // the ONLY way to interrupt.
    if (e.key === 'Escape' && busy && onStop) {
      e.preventDefault()
      onStop()
      return
    }

    // ⌘↵ / Ctrl+↵ = send NOW regardless of queue state. When a turn is running
    // this is the explicit "don't queue this, steer with it" gesture.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend(willQueue)
      return
    }

    // ⌘↑ / ⌘↓ = walk back through prompts you already sent. Only fires on an
    // empty-or-recalled composer so it can never eat a half-written message.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (history.length === 0) return
      e.preventDefault()
      recallHistory(e.key === 'ArrowUp' ? 1 : -1)
      return
    }

    // Shift+Enter is newline when idle, but "插话/插队" when a turn is already
    // running — there is no other way to express urgency from the keyboard.
    // While the agent is actively working this becomes a live steer.
    if (e.key === 'Enter' && e.shiftKey && willQueue) {
      e.preventDefault()
      handleSend(true)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={cn('relative', className)}>
      {trigger?.type === 'mention' && (
        <MentionPanel query={trigger.query} onPicked={stripTrigger} onClose={stripTrigger} />
      )}
      {trigger?.type === 'slash' && (
        <SlashPanel
          query={trigger.query}
          onPicked={stripTrigger}
          onClose={stripTrigger}
          actions={slashActions || {
            newTask: () => {},
            toggleSidebar: () => {},
            toggleBrowserPanel: () => {},
            openFilesPanel: () => {},
          }}
          onInsert={onSlashInsert || ((text) => onValueChange(text))}
        />
      )}

      {notice && (
        <div className="mb-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          {notice}
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col rounded-3xl border bg-card/70 dark:bg-card/45 border-border/80 dark:border-white/10 shadow-lg dark:shadow-2xl backdrop-blur-2xl ring-1 ring-white/40 dark:ring-white/5',
          'overflow-hidden transition-all duration-200',
          'input-focus',
          dragOver ? 'border-primary ring-2 ring-primary/30' : 'border-border/80 dark:border-white/10',
        )}
      >
        {busy && <BorderBeam size={280} duration={4.5} colorFrom="#38bdf8" colorTo="#c084fc" />}
        <AttachmentBar />

        {dragOver && (
          <div className="px-4 py-2 text-[11px] text-muted-foreground">{t('composer.dropHint')}</div>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { onValueChange(e.target.value); setCaret(e.target.selectionStart ?? 0); setHistIdx(-1) }}
          onFocus={(e) => setCaret(e.target.selectionStart ?? 0)}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onPaste={handlePaste}
          placeholder={willQueue ? (busy ? t('composer.queuePlaceholderShift') : t('composer.queuePlaceholder')) : (placeholder ?? t('composer.placeholder'))}
          rows={1}
          className={cn(
            // Generous padding + a taller floor. The input is the primary
            // surface of the whole app; 44px made it read as an afterthought
            // squeezed between two toolbars. 76px gives the caret room to
            // breathe while still auto-growing for long prompts.
            'w-full resize-none bg-transparent px-4 pt-4 pb-2 text-[0.9375rem] leading-relaxed',
            'placeholder:text-muted-foreground/45 focus:outline-none',
            'min-h-[76px] max-h-[240px]',
          )}
        />

        {/* ─── Action row ─── [+] [Mode│Perm│Model│Thought] ... [Ctx] [Send] ─── */}
        <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
          {/* Single "+" entry — every add-context action lives in this menu
              rather than as separate icons cluttering the toolbar. */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                data-testid="chat-attachment-button"
                className="inline-flex items-center justify-center h-6 w-6 rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors press-feedback"
                aria-label={t('composer.addContext')}
                title={t('composer.addContext')}
              >
                <Plus size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-72 p-1">
              <button
                data-testid="chat-attachment-menu-item"
                onClick={() => pickFile(false)}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-accent transition-colors"
              >
                <Paperclip size={13} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <span>{t('composer.uploadFile')}</span>
                  <span className="ml-1.5 text-[10px] text-muted-foreground">{t(ATTACHMENT_HINT_KEY)}</span>
                </div>
              </button>
              <button
                onClick={insertMentionTrigger}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-accent transition-colors"
              >
                <AtSign size={13} className="shrink-0 text-muted-foreground" />
                {t('composer.refFile')}
              </button>
              <button
                onClick={() => {
                  const el = textareaRef.current
                  const insertion = caret === 0 ? '/' : (value.slice(0, caret).endsWith('\n') ? '/' : '\n/')
                  const next = value.slice(0, caret) + insertion + value.slice(caret)
                  onValueChange(next)
                  requestAnimationFrame(() => {
                    if (!el) return
                    el.focus()
                    const pos = caret + insertion.length
                    el.selectionStart = el.selectionEnd = pos
                    setCaret(pos)
                  })
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-accent transition-colors"
              >
                <ClipboardPaste size={13} className="shrink-0 text-muted-foreground" />
                {t('composer.commandsSkills')}
              </button>
              <div className="my-1 h-px bg-border/40" />
              <button
                onClick={() => {
                  sendWs('fold')
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
              >
                <FoldVertical size={13} className="shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex items-center justify-between flex-1">
                  <span>{t('composer.compactContext')}</span>
                  <span className="text-[10px] text-muted-foreground font-mono">{t('composer.fold')}</span>
                </div>
              </button>
            </PopoverContent>
          </Popover>

          {/* Config pills inline with the "+" button, no dividers.
              Dividers were the thing that made the earlier layout feel walled
              off — the pills already have enough visual identity (icon + text
              + hover surface) that vertical lines between them were noise.
              Timeline density lives in Settings → 通用 instead: it's a standing
              display preference, not something you re-pick per turn. */}
          <PermissionSelector />
          <ModelSelector />
          {thinkingCap.showDial && !thinkingCap.loading && (
            <ThoughtLevelSelector supported variants={thinkingCap.variants} />
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <ContextMeter />
            {/* Button logic (standard chat-app behaviour):
                - generating + nothing typed  → the SOLE action is a solid Stop
                  button. We do NOT also render a greyed-out send button next to
                  it — two faint squares side by side made "stop" undiscoverable.
            {/* Button layout:
                - generating + nothing typed → Stop button (clean square)
                - generating + text typed    → Stop button + Queue button
                - idle                      → Standard Send button (ArrowUp) */}
            {busy && onStop ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onStop}
                  aria-label={t('composer.interrupt')}
                  title={t('composer.interrupt')}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-xl shrink-0 transition-all press-feedback bg-muted/80 hover:bg-muted text-foreground border border-border/50 shadow-2xs"
                >
                  <Square className="h-3 w-3" fill="currentColor" />
                </button>
                {hasContent && (
                  <button
                    type="button"
                    onClick={() => handleSend()}
                    className="inline-flex items-center justify-center gap-1 h-8 px-2.5 rounded-xl shrink-0 transition-all press-feedback bg-foreground text-background hover:bg-foreground/90 shadow-2xs text-xs font-medium"
                    aria-label={t('composer.queueLabel', '加入队列')}
                    title={t('composer.queueLabel', '加入队列')}
                  >
                    <ArrowUp size={13} className="stroke-[2.5]" />
                    <span>{queueDepth > 0 ? `+${queueDepth}` : '排队'}</span>
                  </button>
                )}
              </div>
            ) : (
              <>
                {!busy && canResume && onResume && (
                  <button
                    type="button"
                    onClick={() => {
                      onResume(value.trim() || undefined)
                      if (value.trim()) onValueChange('')
                    }}
                    aria-label={t('composer.resume')}
                    title={t('composer.resumeHint')}
                    className="inline-flex items-center justify-center gap-1 h-8 px-2.5 rounded-xl shrink-0 transition-all press-feedback bg-accent text-foreground hover:bg-foreground/10 border border-primary/25"
                  >
                    <Play className="h-3.5 w-3.5" fill="currentColor" />
                    <span className="text-[11px] font-medium">{t('composer.resume')}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleSend()}
                  disabled={!hasContent}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-xl shrink-0 transition-all press-feedback bg-foreground text-background hover:bg-foreground/90 disabled:opacity-40 disabled:cursor-not-allowed shadow-2xs"
                  aria-label={sendLabel}
                  title={sendLabel}
                >
                  <ArrowUp size={14} className="stroke-[2.5]" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
