// src/components/chat/TabReferenceButton.tsx
// Composer 的「引用标签」入口（U3 认领闭环）。
//
// 点击 → GET /api/browser/tabs?task_id=<当前任务> → 下拉列出打开中的标签
// （title + 域名，active 高亮）→ 点选把 ovolve://claim/tab 引用文本插进输入
// 框光标处（宿主 Composer 的插入手法）。无 taskId / 空列表置灰——诚实空态，
// 不假装有标签可选。任务号来源：宿主显式传入 > agentStore.activeSessionId
// （既有会话状态，Composer 本就读同一个 store）。
//
// 新功能串用组件内中文常量（对齐 AskUserPanel 的手法），不改全局 i18n。
import { useCallback, useState } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '../ui/button'
import { useAgentStore } from '../../store/agentStore'
import {
  fetchBrowserTabs,
  formatClaimRef,
  hostnameOfUrl,
  type TabRefInfo,
} from '../../lib/claimRef'

/** 组件内中文文案常量（不改全局 i18n）。 */
export const TAB_REF_COPY = {
  label: '引用标签',
  noTaskHint: '当前没有进行中的任务会话',
  emptyHint: '当前任务没有打开中的标签',
  loading: '正在读取打开中的标签…',
  activeTag: '当前',
} as const

/**
 * 置灰规则：无任务号 → 置灰；确认拉到过空列表 → 置灰。
 * （列表未知（未打开过）不算空——打开时会拉取。）
 */
export function tabRefButtonDisabled(taskId?: string | null, loaded = false, count = 0): boolean {
  if (!taskId) return true
  return loaded && count === 0
}

interface TabReferenceButtonProps {
  /** 把选中的引用文本插进输入框光标处（宿主 Composer 的 insertAtCursor）。 */
  onInsert: (text: string) => void
  /** 当前任务/会话号；省略时读 agentStore.activeSessionId，传 null 强制置灰。 */
  taskId?: string | null
}

export function TabReferenceButton({ onInsert, taskId: taskIdProp }: TabReferenceButtonProps) {
  const storeTaskId = useAgentStore((s) => s.activeSessionId)
  const taskId = taskIdProp !== undefined ? taskIdProp : (storeTaskId || null)

  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tabs, setTabs] = useState<TabRefInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      setTabs(await fetchBrowserTabs(id))
    } catch (e) {
      // 程序故障（500/网络）如实展示；不是"没有标签"。
      setError(e instanceof Error ? e.message : String(e))
      setTabs([])
    } finally {
      setLoading(false)
    }
  }, [])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    // 每次打开都重拉：标签表是易变对象，缓存会变陈旧引用。
    if (next && taskId) void load(taskId)
  }

  const pick = (tab: TabRefInfo) => {
    onInsert(formatClaimRef(tab))
    setOpen(false)
  }

  const disabled = tabRefButtonDisabled(taskId, tabs !== null, tabs?.length ?? 0)
  const disabledHint = taskId ? TAB_REF_COPY.emptyHint : TAB_REF_COPY.noTaskHint

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="tab-ref-button"
          disabled={disabled}
          aria-label={TAB_REF_COPY.label}
          title={disabled ? disabledHint : TAB_REF_COPY.label}
          className={cn(
            'inline-flex items-center justify-center h-6 w-6 rounded-full text-muted-foreground',
            'hover:text-foreground hover:bg-foreground/10 transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
          )}
        >
          <Globe size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-1">
        <TabReferenceMenu loading={loading} error={error} tabs={tabs} onPick={pick} />
      </PopoverContent>
    </Popover>
  )
}

export interface TabReferenceMenuProps {
  loading: boolean
  error: string | null
  tabs: TabRefInfo[] | null
  onPick: (tab: TabRefInfo) => void
}

/** 下拉菜单本体（从按钮拆出：node 环境测试可直接渲染各状态）。 */
export function TabReferenceMenu({ loading, error, tabs, onPick }: TabReferenceMenuProps) {
  const t = TAB_REF_COPY

  if (loading) {
    return (
      <div data-testid="tab-ref-loading" className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-muted-foreground">
        <Loader2 size={13} className="animate-spin shrink-0" />
        {t.loading}
      </div>
    )
  }
  if (error) {
    return (
      <div data-testid="tab-ref-error" className="px-2.5 py-2 text-[12px] text-rose-500 break-all">
        {error}
      </div>
    )
  }
  if (!tabs || tabs.length === 0) {
    return (
      <div data-testid="tab-ref-empty" className="px-2.5 py-2 text-[12px] text-muted-foreground">
        {t.emptyHint}
      </div>
    )
  }
  return (
    <div className="max-h-64 overflow-auto">
      {tabs.map((tab) => (
        <button
          key={tab.tab_id}
          type="button"
          data-testid={`tab-ref-item-${tab.tab_id}`}
          onClick={() => onPick(tab)}
          className={cn(
            'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-[13px] hover:bg-accent transition-colors cursor-pointer',
            tab.active && 'bg-primary/10',
          )}
          title={tab.url}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full shrink-0',
              tab.active ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-foreground/90">
              {tab.title || tab.url || tab.tab_id}
            </span>
            <span className="block text-[10px] text-muted-foreground truncate font-mono">
              {hostnameOfUrl(tab.url)}
            </span>
          </span>
          {tab.active && (
            <span className="text-[10px] text-primary shrink-0 select-none">{t.activeTag}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export default TabReferenceButton
