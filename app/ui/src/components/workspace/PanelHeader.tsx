// src/components/workspace/PanelHeader.tsx
// 统一的侧栏面板头：固定 36px 高、同一条底部分隔线、图标 + 标题靠左、
// 操作按钮靠右。此前九个面板各自起头（py-2 / py-3 / h-12 / 无头），
// 切换 tab 时头部高度跳动，观感上像"每个板块一个应用"。
// Files / Editor / Learning 这三个头部信息密度更高（工具栏、面包屑、指标条），
// 保留各自定制；其余简单标题头统一走这里。
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@lib/utils'

export function PanelHeader({
  icon: Icon,
  iconClassName,
  title,
  children,
  className,
}: {
  icon?: LucideIcon
  iconClassName?: string
  title: ReactNode
  /** 右侧操作区（按钮/开关等），可选。 */
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-3 select-none',
        className,
      )}
    >
      {Icon && <Icon size={14} strokeWidth={1.75} className={cn('shrink-0 text-muted-foreground', iconClassName)} />}
      <span className="min-w-0 truncate text-xs font-medium text-foreground/90">{title}</span>
      <div className="ml-auto flex shrink-0 items-center gap-1">{children}</div>
    </div>
  )
}
