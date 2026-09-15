// src/components/chat/AttachmentBar.tsx
// Attachment chips shown inside the composer card, above the textarea.
// Upload lifecycle: queued → uploading → ready | failed → retry.
import {
  X, FileText, Image as ImageIcon, Loader2, AlertCircle, RotateCw,
  AtSign, Sparkles, Users, MessageSquare, Folder, GitCompare,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useComposerContextStore, type Attachment, type MentionKind } from '@store/composerContextStore'
import { cn } from '@lib/utils'

function StateIcon({ a }: { a: Attachment }) {
  if (a.state === 'uploading' || a.state === 'queued') {
    return <Loader2 size={11} className="animate-spin text-muted-foreground shrink-0" />
  }
  if (a.state === 'failed') {
    return <AlertCircle size={11} className="text-destructive shrink-0" />
  }
  return a.mime.startsWith('image/')
    ? <ImageIcon size={11} className="text-muted-foreground shrink-0" />
    : <FileText size={11} className="text-muted-foreground shrink-0" />
}

/**
 * E1 — Skill Chip Pill.
 *
 * Every mention used to render as one indistinguishable blue `@` chip, so a
 * user who armed a skill couldn't tell it apart from an attached file at a
 * glance — and "did the skill actually get picked up?" is exactly the question
 * this row exists to answer. Each kind now gets its own icon, tint and shape:
 * skills are fully-rounded pills (they *act*), everything else stays a
 * rounded-rect chip (they're *referenced*).
 */
const MENTION_STYLE: Record<MentionKind, { icon: typeof AtSign; chip: string; hover: string; pill: boolean }> = {
  skill: {
    icon: Sparkles,
    chip: 'border-border/60 bg-foreground/10 text-foreground',
    hover: 'hover:bg-foreground/20',
    pill: true,
  },
  subagent: {
    icon: Users,
    chip: 'border-border/60 bg-foreground/10 text-foreground',
    hover: 'hover:bg-foreground/20',
    pill: false,
  },
  session: {
    icon: MessageSquare,
    chip: 'border-warning/40 bg-warning/10 text-warning dark:text-warning/80',
    hover: 'hover:bg-warning/20',
    pill: false,
  },
  file: {
    icon: AtSign,
    chip: 'border-border/60 bg-foreground/10 text-foreground',
    hover: 'hover:bg-foreground/20',
    pill: false,
  },
  dir: {
    icon: Folder,
    chip: 'border-border/60 bg-foreground/10 text-foreground',
    hover: 'hover:bg-foreground/20',
    pill: false,
  },
  git_diff: {
    icon: GitCompare,
    chip: 'border-border/60 bg-foreground/10 text-foreground',
    hover: 'hover:bg-foreground/20',
    pill: false,
  },
}

interface Props {
  onRetry?: (a: Attachment) => void
}

export function AttachmentBar({ onRetry }: Props) {
  const { t } = useTranslation()
  const { attachments, mentions, removeAttachment, removeMention } = useComposerContextStore()
  const fmtBytes = (n: number): string => {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}${t('attachment.mb')}`
    if (n >= 1024) return `${Math.round(n / 1024)}${t('attachment.kb')}`
    return `${n}${t('attachment.b')}`
  }
  if (attachments.length === 0 && mentions.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
      {attachments.map((a) => {
        // Truth-in-chips: `@file:<path>` is the only channel the backend reads,
        // so an attachment without a path (a pasted image — bytes live in
        // `previewUri`, which nothing uploads) will NOT reach the model. Saying
        // so on the chip beats letting the user find out from a reply that
        // ignores the screenshot they just pasted.
        const undeliverable = !a.path
        return (
        <div
          key={a.id}
          data-testid="v4-attachment"
          className={cn(
            'group inline-flex items-center gap-1.5 h-6 pl-2 pr-1 rounded-md text-[11px] max-w-[220px]',
            'border transition-colors',
            a.state === 'failed'
              ? 'border-destructive/40 bg-destructive/10'
              : undeliverable
                ? 'border-warning/40 bg-warning/10'
                : 'border-border/50 bg-muted/50',
          )}
          title={a.error ?? (undeliverable ? t('attachment.notSentHint') : a.path) ?? a.fileName}
        >
          <StateIcon a={a} />
          <span className="truncate font-medium">{a.fileName}</span>
          {undeliverable && (
            <span className="shrink-0 text-warning">
              {t('attachment.notSent')}
            </span>
          )}
          {a.state === 'uploading' && typeof a.progress === 'number' && (
            <span className="tabular-nums text-muted-foreground shrink-0">{a.progress}%</span>
          )}
          {a.state === 'ready' && !undeliverable && (
            <span className="tabular-nums text-muted-foreground shrink-0">{fmtBytes(a.bytes)}</span>
          )}
          {a.state === 'failed' && onRetry && (
            <button
              data-testid="v4-attachment-upload-retry"
              onClick={() => onRetry(a)}
              className="p-0.5 rounded hover:bg-foreground/10 text-destructive shrink-0"
              aria-label={t('attachment.retry')}
            >
              <RotateCw size={10} />
            </button>
          )}
          <button
            onClick={() => removeAttachment(a.id)}
            className="p-0.5 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground shrink-0"
            aria-label={t('attachment.remove')}
          >
            <X size={10} />
          </button>
        </div>
        )
      })}

      {mentions.map((m) => {
        const style = MENTION_STYLE[m.kind] || MENTION_STYLE.file
        const Icon = style.icon
        return (
          <div
            key={m.id}
            className={cn(
              'group inline-flex items-center gap-1.5 h-6 pl-2 pr-1 text-[11px] max-w-[220px] border transition-colors',
              style.pill ? 'rounded-full' : 'rounded-md',
              style.chip,
            )}
            title={m.ref}
          >
            <Icon size={10} className="shrink-0" />
            <span className="truncate font-medium">{m.label}</span>
            <button
              onClick={() => removeMention(m.id)}
              className={cn('p-0.5 rounded shrink-0', style.hover)}
              aria-label={t('attachment.removeRef')}
            >
              <X size={10} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
