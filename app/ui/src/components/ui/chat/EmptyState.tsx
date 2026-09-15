import { Sparkles, FolderSearch, Monitor, Globe, CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Suggestion {
  icon: React.ReactNode
  label: string
  prompt: string
}

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: React.ReactNode
  /** Called when a suggestion chip is tapped — fills the composer. */
  onSuggestion?: (prompt: string) => void
}

const SUGGESTIONS: Suggestion[] = [
  { icon: <FolderSearch size={15} />, label: '整理文件', prompt: '帮我把工作区里杂乱的文件整理一下，按类型归类。' },
  { icon: <Monitor size={15} />, label: '系统诊断', prompt: '检查一下系统状态和资源占用情况。' },
  { icon: <Globe size={15} />, label: '联网搜索', prompt: '帮我搜索最新的相关资讯。' },
  { icon: <CalendarClock size={15} />, label: '定时任务', prompt: '帮我创建一个每小时自动备份的定时任务。' },
]

/**
 * Empty state shown when no messages exist.
 * AI-native: brand hero + suggestion chips to lower the blank-page barrier.
 */
export function EmptyState({
  title = '你好！',
  description = '有什么我可以帮助你的吗？',
  icon,
  onSuggestion,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16 text-muted-foreground">
      <div
        className={cn(
          'w-20 h-20 rounded-3xl bg-secondary/10 border border-border/50',
          'flex items-center justify-center mb-5',
          'animate-icon-pop'
        )}
      >
        <div className="text-muted-foreground">
          {icon || <Sparkles className="h-9 w-9" />}
        </div>
      </div>
      <p className="text-2xl font-heading font-semibold tracking-tight text-foreground animate-stagger-1">
        {title}
      </p>
      <p className="mt-2 text-sm text-muted-foreground animate-stagger-2 max-w-sm">
        {description}
      </p>

      {onSuggestion && (
        <div className="mt-8 grid grid-cols-2 gap-2 w-full max-w-md">
          {SUGGESTIONS.map((s, i) => (
            <button
              key={s.label}
              onClick={() => onSuggestion(s.prompt)}
              className={cn(
                'group flex items-center gap-2.5 px-4 py-3 rounded-xl text-left',
                'border border-border/50 bg-card text-sm text-foreground/80',
                'hover:border-border hover:bg-muted/60 hover:text-foreground',
                'transition-colors duration-150 ease-out press-feedback',
                `animate-stagger-${Math.min(i + 3, 5)}`
              )}
            >
              <span className="text-muted-foreground group-hover:text-foreground transition-colors">
                {s.icon}
              </span>
              <span className="font-medium">{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
