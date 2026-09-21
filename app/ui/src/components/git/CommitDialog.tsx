/**
 * CommitDialog — the commit panel.
 *
 * Deliberately NOT a form with a submit button: the three actions (提交 /
 * 提交并推送 / 推送) are peers, and stacking them as a menu makes the difference
 * between "local" and "goes to the remote" visible at the moment of choosing,
 * instead of hiding a network push behind a generic "OK".
 *
 * Empty message means auto-generate — the backend drafts one from the same tree
 * it is about to commit. That's why the box says 留空将自动生成 rather than
 * making the user press first.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, GitBranch, Loader2, Sparkles, Upload } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useGitStore } from '@store/gitStore'
import { useSessionConfigStore } from '@store/sessionConfigStore'
import { fetchCommitMessage } from '@lib/gitApi'
import { cn } from '@lib/utils'

interface CommitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** One row in the action stack at the bottom of the panel. */
function ActionRow({
  icon, label, hint, disabled, onClick,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-4 py-2.5 text-left text-sm',
        'transition-colors duration-150',
        disabled
          ? 'text-muted-foreground/40 cursor-not-allowed'
          : 'text-foreground hover:bg-foreground/5 press-feedback',
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-muted-foreground/70">{hint}</span>}
    </button>
  )
}

export function CommitDialog({ open, onOpenChange }: CommitDialogProps) {
  const { status, commit, push } = useGitStore()
  const [message, setMessage] = useState('')
  const [includeUnstaged, setIncludeUnstaged] = useState(true)
  const [busy, setBusy] = useState<'' | 'commit' | 'commit-push' | 'push' | 'draft'>('')
  const [err, setErr] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const branch = status?.branch || '…'
  const changeCount = status?.changes?.length ?? 0
  const additions = status?.additions ?? 0
  const deletions = status?.deletions ?? 0
  const ahead = status?.ahead ?? 0
  const working = busy !== ''

  // Reset per-open so a stale draft/error from last time never lingers.
  useEffect(() => {
    if (open) {
      setErr(null)
      setTimeout(() => taRef.current?.focus(), 50)
    }
  }, [open])

  const onDraft = async () => {
    setBusy('draft')
    setErr(null)
    try {
      // Draft with whatever the composer is pointed at — same model the user
      // chats with, since there's no separate commit model in this build.
      const model = useSessionConfigStore.getState().activeModel
      const msg = await fetchCommitMessage(includeUnstaged, model)
      setMessage(msg)
      setTimeout(() => taRef.current?.focus(), 30)
    } catch (e: any) {
      setErr(e?.message || '生成失败')
    } finally {
      setBusy('')
    }
  }

  const runCommit = async (withPush: boolean) => {
    setBusy(withPush ? 'commit-push' : 'commit')
    setErr(null)
    try {
      const model = useSessionConfigStore.getState().activeModel
      const r = await commit({ message: message.trim(), includeUnstaged, push: withPush, model })
      if (withPush && !r.pushed) {
        // Commit landed, push didn't — keep the panel open and say exactly that,
        // so the user doesn't re-commit a change that's already committed.
        setErr(`已提交 ${r.hash}，但推送失败：${r.pushError || '未知错误'}`)
        return
      }
      onOpenChange(false)
      setMessage('')
    } catch (e: any) {
      setErr(e?.message || '提交失败')
    } finally {
      setBusy('')
    }
  }

  const runPush = async () => {
    setBusy('push')
    setErr(null)
    try {
      await push()
      onOpenChange(false)
    } catch (e: any) {
      setErr(e?.message || '推送失败')
    } finally {
      setBusy('')
    }
  }

  const nothingToCommit = changeCount === 0

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(v) => { if (!working) onOpenChange(v) }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[26rem] -translate-x-1/2 -translate-y-1/2',
            'rounded-2xl border border-border/50 bg-card shadow-2xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">提交更改</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            为当前改动填写或自动生成提交信息，然后提交或推送。
          </DialogPrimitive.Description>

          {/* Header: branch + diffstat */}
          <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium text-foreground/90 truncate">{branch}</span>
            <span className="ml-auto tabular-nums text-xs shrink-0">
              <span className="text-success">+{additions}</span>{' '}
              <span className="text-destructive">-{deletions}</span>
            </span>
          </div>

          {/* Message box + */}
          <div className="px-4">
            <div className="relative">
              <textarea
                ref={taRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    if (!working && !nothingToCommit) void runCommit(false)
                  }
                }}
                placeholder="提交信息（留空将自动生成）"
                rows={4}
                className={cn(
                  'w-full resize-none rounded-lg border border-border/50 bg-background',
                  'px-3 py-2.5 pr-9 text-sm outline-none',
                  'focus:border-primary/50 focus:ring-1 focus:ring-primary/30',
                  'placeholder:text-muted-foreground/60',
                )}
              />
              <button
                type="button"
                onClick={() => void onDraft()}
                disabled={working || nothingToCommit}
                title="用 AI 根据改动生成提交信息"
                className={cn(
                  'absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md',
                  'text-muted-foreground hover:text-foreground hover:bg-foreground/10',
                  'transition-colors disabled:opacity-40',
                )}
              >
                {busy === 'draft'
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Sparkles className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {/* Include-unstaged toggle */}
          <label className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeUnstaged}
              onChange={(e) => setIncludeUnstaged(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border/60 accent-primary"
            />
            <span className="text-xs text-foreground/80">包含未暂存的更改</span>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {changeCount} 个文件
            </span>
          </label>

          {err && (
            <p className="px-4 pb-1 text-[11px] leading-snug text-destructive">
              {err}
            </p>
          )}

          {/* Action stack */}
          <div className="border-t border-border/30">
            <ActionRow
              icon={busy === 'commit' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              label="提交"
              hint="Ctrl+↵"
              disabled={working || nothingToCommit}
              onClick={() => void runCommit(false)}
            />
            <ActionRow
              icon={busy === 'commit-push' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              label="提交并推送"
              disabled={working || nothingToCommit}
              onClick={() => void runCommit(true)}
            />
            <ActionRow
              icon={busy === 'push' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              label="推送"
              hint={ahead > 0 ? `↑${ahead}` : undefined}
              disabled={working}
              onClick={() => void runPush()}
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
