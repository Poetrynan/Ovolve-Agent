import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Blocks, BookOpen, Plug, Bot, Wrench, RotateCcw, Plus,
} from 'lucide-react'
import { useSkillStore } from '@store/skillStore'
import { usePluginStore } from '@store/pluginStore'
import { useSubagentStore } from '@store/subagentStore'
import { McpSettings } from '@components/settings/McpSettings'
import { PluginsPanel } from '@components/capabilities/PluginsPanel'
import { SubagentsPanel } from '@components/capabilities/SubagentsPanel'
import { ToolsPanel } from '@components/capabilities/ToolsPanel'
import SkillsPage from '@pages/SkillsPage'
import { fetchJson, API_BASE } from '@lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@components/ui/button'

interface McpServerSummary {
  disabled?: boolean
  status?: string
  toolCount?: number
}

/** 「能力」是一扇门后面五类东西：插件 / 技能 / 连接器 / 子 Agent / 工具。
 *  它们回答的是同一个问题（这玩意儿会啥），而且需要互相比较，
 *  所以合成一页带标签，而不是在侧边栏摊开五行。 */
const TABS = [
  { id: 'plugins', label: '插件', icon: Blocks },
  { id: 'skills', label: '技能', icon: BookOpen },
  { id: 'mcp', label: '连接器', icon: Plug },
  { id: 'subagents', label: '子 Agent', icon: Bot },
  { id: 'tools', label: '工具', icon: Wrench },
] as const

type TabId = (typeof TABS)[number]['id']
const TAB_IDS = TABS.map((x) => x.id) as readonly string[]
const DEFAULT_TAB: TabId = 'plugins'

/** 每个标签一句话说明它管的是什么 —— 换标签时这行字跟着换，
 *  省得用户点进「连接器」还要猜这页是干什么的。 */
const TAB_DESCRIPTIONS: Record<TabId, string> = {
  plugins: '把一组技能、命令与资源打包成一个可开关的单元，安装即用、停用即卸。',
  skills: '某个专业领域的工程规范，按任务意图按需索引加载，不占常驻上下文。',
  mcp: '按 Model Context Protocol 接入外部工具与服务，可逐个停用其中的工具。',
  subagents: '独立运行的专家智能体，由主 Agent 分派专项任务并回收结果。',
  tools: '运行时已注册的全部执行工具，标注了各自的安全模式与基线风险等级。',
}

export default function CapabilitiesPage() {
  const navigate = useNavigate()
  const { tab } = useParams<{ tab?: string }>()

  const { skills, fetchSkills } = useSkillStore()
  const { plugins, fetchPlugins } = usePluginStore()
  const { types: subagents, fetchTypes } = useSubagentStore()

  const [toolsCount, setToolsCount] = useState<number | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([])
  const [refreshing, setRefreshing] = useState(false)

  // 右上角那个按钮随当前标签变化，但它不直接执行动作 —— 只把点击变成
  // 一个自增计数器传下去，由子面板自己决定"安装/导入/添加"具体是什么。
  const [pluginInstallTrigger, setPluginInstallTrigger] = useState(0)
  const [skillImportTrigger, setSkillImportTrigger] = useState(0)
  const [mcpAddTrigger, setMcpAddTrigger] = useState(0)

  const fetchToolsData = () => {
    fetchJson<{ count?: number; tools?: unknown[] }>(`${API_BASE}/api/tools`)
      .then((d) => setToolsCount(d.count ?? d.tools?.length ?? 0))
      .catch(() => {})
  }

  const fetchMcpData = () => {
    fetchJson<{ servers?: McpServerSummary[] }>(`${API_BASE}/api/mcp/servers`)
      .then((d) => setMcpServers(d.servers ?? []))
      .catch(() => {})
  }

  useEffect(() => {
    void fetchSkills()
    void fetchPlugins()
    void fetchTypes()
    fetchToolsData()
    fetchMcpData()
  }, [fetchSkills, fetchPlugins, fetchTypes])

  const handleRefresh = async () => {
    setRefreshing(true)
    await Promise.allSettled([
      fetchSkills(),
      fetchPlugins(),
      fetchTypes(),
      fetchToolsData(),
      fetchMcpData(),
    ])
    setRefreshing(false)
  }

  const active: TabId = (tab && TAB_IDS.includes(tab) ? tab : DEFAULT_TAB) as TabId

  const renderTopRightAction = () => {
    switch (active) {
      case 'plugins':
        return (
          <Button
            size="sm"
            onClick={() => setPluginInstallTrigger((n) => n + 1)}
            className="bg-foreground text-background hover:bg-foreground/90 font-medium px-3.5 py-1.5 rounded-xl text-xs flex items-center gap-1.5 shadow-none cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>安装插件</span>
          </Button>
        )
      case 'skills':
        return (
          <Button
            size="sm"
            onClick={() => setSkillImportTrigger((n) => n + 1)}
            className="bg-foreground text-background hover:bg-foreground/90 font-medium px-3.5 py-1.5 rounded-xl text-xs flex items-center gap-1.5 shadow-none cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>导入技能</span>
          </Button>
        )
      case 'mcp':
        return (
          <Button
            size="sm"
            onClick={() => setMcpAddTrigger((n) => n + 1)}
            className="bg-foreground text-background hover:bg-foreground/90 font-medium px-3.5 py-1.5 rounded-xl text-xs flex items-center gap-1.5 shadow-none cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加连接器</span>
          </Button>
        )
      case 'subagents':
        return (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void fetchTypes()}
            className="font-medium px-3.5 py-1.5 rounded-xl text-xs flex items-center gap-1.5 border-border hover:bg-muted cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>刷新智能体</span>
          </Button>
        )
      case 'tools':
        return (
          <Button
            size="sm"
            variant="outline"
            onClick={fetchToolsData}
            className="font-medium px-3.5 py-1.5 rounded-xl text-xs flex items-center gap-1.5 border-border hover:bg-muted cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>刷新工具池</span>
          </Button>
        )
    }
  }

  const tabCount: Record<TabId, number> = {
    plugins: plugins.length,
    skills: skills.length,
    mcp: mcpServers.length,
    subagents: subagents.length,
    tools: toolsCount ?? 0,
  }

  return (
    <div className="h-full w-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="max-w-5xl mx-auto py-6 px-6 sm:px-8 space-y-6 animate-fade-in">
        {/* Sticky Header: 标题块 + 全局刷新 + 随标签变化的上下文操作 */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-md pb-4 pt-1 border-b border-border/60 space-y-3.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary border border-primary/20 shadow-2xs">
                <Blocks size={18} className="stroke-[2.2]" />
              </div>
              <div>
                <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground">
                  能力中心
                </h1>
                <p className="text-[11px] text-muted-foreground">
                  {TAB_DESCRIPTIONS[active]}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 self-start sm:self-auto select-none">
              <button
                type="button"
                onClick={handleRefresh}
                title="全局刷新"
                className="h-8 w-8 rounded-lg border border-border/80 bg-card shadow-2xs flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
              >
                <RotateCcw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
              </button>

              {renderTopRightAction()}
            </div>
          </div>

          {/* 导航标签：胶囊条，带图标与真实计数 */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-muted/50 border border-border/60 select-none">
            {TABS.map(({ id, label, icon: Icon }) => {
              const isCurrent = id === active
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => navigate(`/capabilities/${id}`, { replace: true })}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all select-none cursor-pointer shrink-0',
                    isCurrent
                      ? 'bg-card text-foreground font-semibold shadow-2xs border border-border/70'
                      : 'text-muted-foreground hover:text-foreground hover:bg-background/40 border border-transparent'
                  )}
                >
                  <Icon className={cn('w-3.5 h-3.5', isCurrent ? 'text-primary' : 'text-muted-foreground/80')} />
                  <span>{label}</span>
                  <span className={cn(
                    'text-[10px] font-mono px-1.5 py-0.5 rounded-full tabular-nums',
                    isCurrent ? 'bg-primary/10 text-primary font-semibold' : 'bg-muted text-muted-foreground'
                  )}>
                    {tabCount[id]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Active Tab Content */}
        <div className="pt-1">
          {active === 'plugins' && (
            <PluginsPanel installTrigger={pluginInstallTrigger} />
          )}

          {active === 'skills' && (
            <SkillsPage embedded openImportTrigger={skillImportTrigger} />
          )}

          {active === 'mcp' && (
            <div className="space-y-4">
              <McpSettings openAddTrigger={mcpAddTrigger} />
            </div>
          )}

          {active === 'subagents' && <SubagentsPanel />}

          {active === 'tools' && <ToolsPanel />}
        </div>
      </div>
    </div>
  )
}
