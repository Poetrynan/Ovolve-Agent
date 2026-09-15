// src/components/ui/chat/ChatSkeleton.tsx
// High-fidelity skeleton placeholder shown while switching sessions or loading history.
// Pinned to the bottom so the user's focus naturally rests on the latest turn.
import { Skeleton } from '@/components/ui/skeleton'

export function ChatSkeleton() {
  return (
    <div className="flex-1 flex flex-col justify-end max-w-3xl mx-auto w-full px-6 py-6 space-y-6 select-none animate-fade-in">
      {/* ── User Turn Skeleton (Right-aligned) ── */}
      <div className="flex justify-end items-end gap-2.5 pl-12">
        <div className="space-y-2 flex flex-col items-end">
          <Skeleton className="h-4 w-28 rounded-md bg-muted/60" />
          <div className="rounded-2xl rounded-tr-xs bg-primary/10 border border-primary/20 p-3.5 space-y-2 shadow-2xs max-w-md w-full">
            <Skeleton className="h-3.5 w-64 rounded bg-primary/20" />
            <Skeleton className="h-3.5 w-40 rounded bg-primary/15" />
          </div>
        </div>
        <Skeleton className="w-8 h-8 rounded-full bg-muted/80 shrink-0 mb-0.5" />
      </div>

      {/* ── Assistant Response Skeleton (Left-aligned) ── */}
      <div className="flex items-start gap-3 pr-12">
        <Skeleton className="w-8 h-8 rounded-xl bg-primary/15 shrink-0 mt-1" />
        <div className="space-y-3 flex-1">
          {/* Header */}
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-20 rounded bg-muted/70" />
            <Skeleton className="h-3 w-12 rounded bg-muted/40" />
          </div>

          {/* Thinking / Process capsule */}
          <div className="rounded-xl border border-border/50 bg-muted/30 p-3 space-y-2 max-w-lg">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-3 rounded-full bg-primary/30" />
              <Skeleton className="h-3 w-32 rounded bg-muted/60" />
            </div>
            <Skeleton className="h-2.5 w-full rounded bg-muted/40" />
          </div>

          {/* Content bubble */}
          <div className="rounded-2xl rounded-tl-xs bg-card border border-border/60 p-4 space-y-2.5 shadow-2xs">
            <Skeleton className="h-3.5 w-5/6 rounded bg-muted/80" />
            <Skeleton className="h-3.5 w-full rounded bg-muted/70" />
            <Skeleton className="h-3.5 w-3/4 rounded bg-muted/60" />

            {/* Code / Artifact block placeholder */}
            <div className="rounded-xl border border-border/40 bg-muted/40 p-3 my-2 space-y-2">
              <div className="flex items-center justify-between border-b border-border/30 pb-2">
                <Skeleton className="h-3 w-24 rounded bg-muted/60" />
                <Skeleton className="h-3 w-10 rounded bg-muted/50" />
              </div>
              <Skeleton className="h-3 w-4/5 rounded bg-muted/40 font-mono" />
              <Skeleton className="h-3 w-2/3 rounded bg-muted/35 font-mono" />
            </div>

            <Skeleton className="h-3.5 w-1/2 rounded bg-muted/70" />
          </div>
        </div>
      </div>
    </div>
  )
}
export default ChatSkeleton
