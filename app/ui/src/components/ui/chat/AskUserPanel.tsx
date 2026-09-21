/**
 * AskUserPanel — the answer surface for a parked `ask_user` question.
 *
 * Lives next to ToolCallCard's ApprovalBar and follows the same rule: it renders
 * OUTSIDE the collapsible body, because a question you must expand a card to
 * find is a question people miss, and a missed question reads as the agent
 * having silently stalled.
 *
 * What travels back are option INDEXES, never labels. The backend holds the
 * authoritative copy of the questions and renders the user's turn from it, so
 * the transcript never depends on what this client happened to paint.
 *
 * The free-text box is always available and is never one of the options: it is
 * the escape hatch for "none of these", which is exactly the case where an
 * agent guessing costs the most.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@store/agentStore'
import type { ToolCall } from '@apptypes/index'

export function AskUserPanel({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useTranslation()
  const respond = useAgentStore((s) => s.respondQuestion)
  const questions = toolCall.askQuestions ?? []
  const [picked, setPicked] = useState<Record<number, number[]>>({})
  const [notes, setNotes] = useState<Record<number, string>>({})
  const rootRef = useRef<HTMLDivElement>(null)

  // Focus the panel when it appears so the number keys below work without a
  // click, and so a keyboard user lands on the thing that is blocking the turn
  // instead of having to Tab through the whole feed to find it.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])


  // No questions means the frame predates this feature (or a restored history
  // frame lost the meta). Rendering an empty chrome would be worse than nothing.
  if (!questions.length) return null

  // One single-select question is the overwhelmingly common shape, and there is
  // nothing to confirm — the click IS the answer. Anything more needs a submit
  // button, otherwise the first click would send a half-filled form.
  const oneShot = questions.length === 1 && !questions[0].multiSelect

  const send = (answers: { q: number; picked: number[]; text?: string }[]) =>
    respond(toolCall.id, answers)

  const submitAll = () =>
    send(
      questions.map((q) => ({
        q: q.index,
        picked: picked[q.index] ?? [],
        text: notes[q.index]?.trim() || undefined,
      })),
    )

  const toggle = (qIndex: number, optIndex: number, multi?: boolean) => {
    if (oneShot) {
      send([{ q: qIndex, picked: [optIndex], text: notes[qIndex]?.trim() || undefined }])
      return
    }
    setPicked((prev) => {
      const cur = prev[qIndex] ?? []
      if (!multi) return { ...prev, [qIndex]: cur[0] === optIndex ? [] : [optIndex] }
      return {
        ...prev,
        [qIndex]: cur.includes(optIndex)
          ? cur.filter((i) => i !== optIndex)
          : [...cur, optIndex],
      }
    })
  }

  const isPicked = (qIndex: number, optIndex: number) =>
    (picked[qIndex] ?? []).includes(optIndex)

  // Something must be said about every question before the form can go — an
  // answer with holes in it sends the model back to guessing on those.
  const complete = questions.every(
    (q) => (picked[q.index]?.length ?? 0) > 0 || (notes[q.index] ?? '').trim().length > 0,
  )

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="group"
      aria-label={toolCall.askHeader || t('askUser.title')}
      onKeyDown={(e) => {
        // 1-9 picks an option, but only for a single question: with two on
        // screen a bare digit has no unambiguous target. Ignored while typing in
        // the free-text box, otherwise "2" could never be written.
        if (questions.length !== 1) return
        if ((e.target as HTMLElement)?.tagName === 'INPUT') return
        const n = Number(e.key)
        if (!Number.isInteger(n) || n < 1 || n > questions[0].options.length) return
        e.preventDefault()
        toggle(questions[0].index, n - 1, questions[0].multiSelect)
      }}
      className="border-t border-primary/25 bg-primary/[0.04] px-3 py-2.5 space-y-3 outline-none"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageCircleQuestion className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium text-foreground/90">
          {toolCall.askHeader || t('askUser.title')}
        </span>
      </div>

      {questions.map((q) => (
        <div key={q.index} className="space-y-1.5">
          <div className="text-[11px] text-foreground/90">
            {q.question}
            {q.multiSelect && (
              <span className="ml-1 text-muted-foreground">{t('askUser.multi')}</span>
            )}
          </div>
          {/* Two layouts on purpose. When the options carry trade-off text the
              list goes vertical so that text is readable BEFORE the click — a
              trade-off revealed after you choose is worthless, and a tooltip is
              not where a decision input belongs. Bare options stay as compact
              chips, because a wall of one-line rows for "yes / no" is worse. */}
          {q.options.some((o) => o.description) ? (
            <div className="space-y-1">
              {q.options.map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggle(q.index, i, q.multiSelect)}
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded-md border transition-colors',
                    isPicked(q.index, i)
                      ? 'border-primary/60 bg-primary/10'
                      : 'border-border/60 hover:bg-accent',
                  )}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                      {i + 1}
                    </span>
                    <span className="text-[11px] font-medium text-foreground">
                      {opt.label}
                    </span>
                  </div>
                  {opt.description && (
                    <p className="mt-0.5 ml-4 text-[10px] text-muted-foreground leading-relaxed">
                      {opt.description}
                    </p>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggle(q.index, i, q.multiSelect)}
                  className={cn(
                    'h-6 px-2 rounded-md text-[11px] border transition-colors text-left',
                    isPicked(q.index, i)
                      ? 'bg-foreground text-background border-transparent'
                      : 'border-border/60 text-foreground hover:bg-accent',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            value={notes[q.index] ?? ''}
            onChange={(e) => setNotes((p) => ({ ...p, [q.index]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (oneShot) {
                const t = (notes[q.index] ?? '').trim()
                if (t) send([{ q: q.index, picked: [], text: t }])
              } else if (complete) {
                submitAll()
              }
            }}
            placeholder={t('askUser.otherPlaceholder')}
            className="w-full h-6 px-2 rounded-md bg-background/60 border border-border/50 text-[11px] placeholder:text-muted-foreground/70 focus:outline-none focus:border-primary/50"
          />
        </div>
      ))}

      <div className="flex items-center gap-2">
        {/* Skipping is an answer, not a cancel: the backend turns it into "use a
            sensible default and don't ask again". Without it, a user who doesn't
            care has no move except typing something they don't mean. */}
        <button
          type="button"
          onClick={() => respond(toolCall.id, [], true)}
          className="h-6 px-2 rounded-md text-[11px] text-muted-foreground hover:bg-foreground/5 transition-colors"
        >
          {t('askUser.skip')}
        </button>
        {!oneShot && (
          <button
            type="button"
            disabled={!complete}
            onClick={submitAll}
            className={cn(
              'h-6 px-2.5 ml-auto rounded-md text-[11px] font-medium transition-opacity',
              complete
                ? 'bg-foreground text-background hover:opacity-90'
                : 'bg-foreground/30 text-background/70 cursor-not-allowed',
            )}
          >
            {t('askUser.submit')}
          </button>
        )}
      </div>
    </div>
  )
}
