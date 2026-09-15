import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui/dialog'
import { useGitStore } from '@store/gitStore'

interface CreateBranchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateBranchDialog({ open, onOpenChange }: CreateBranchDialogProps) {
  const createAndCheckout = useGitStore(s => s.createAndCheckout)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setErr(null)
    try {
      await createAndCheckout(trimmed)
      setName('')
      onOpenChange(false)
    } catch (e: any) {
      setErr(e?.message || '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!busy) {
        onOpenChange(v)
        if (!v) {
          setErr(null)
          setName('')
        }
      }
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>创建并检出新分支</DialogTitle>
          <DialogDescription>
            基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-1">
          <label htmlFor="branch-name" className="text-sm font-medium">
            分支名
          </label>
          <input
            id="branch-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="例如 feature/git-branch-switcher"
            autoFocus
            className="w-full h-10 rounded-lg border border-border/50 bg-background px-3 text-sm outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
          />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            首版只支持基于当前 HEAD 创建并切换。
          </p>
          {err && <p className="text-[11px] text-destructive leading-snug">{err}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <button
            type="button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            className="h-9 px-4 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => void submit()}
            className="h-9 px-4 rounded-lg text-sm bg-foreground text-background hover:opacity-90 disabled:opacity-50 press-feedback"
          >
            {busy ? '创建中…' : '创建并切换'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
