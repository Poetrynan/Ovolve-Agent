import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { Blocks, Sparkles, Plug, Bot, Wrench } from 'lucide-react'
import { Badge } from '@components/ui/badge'
import { McpSettings } from '@components/settings/McpSettings'
import { PluginsPanel } from '@components/capabilities/PluginsPanel'
import { SubagentsPanel } from '@components/capabilities/SubagentsPanel'
import { ToolsPanel } from '@components/capabilities/ToolsPanel'
import SkillsPage from '@pages/SkillsPage'
import { cn } from '@/lib/utils'

const TABS = [
  { id: 'skills', icon: Sparkles },
  { id: 'mcp', icon: Plug },
  { id: 'subagents', icon: Bot },
  { id: 'tools', icon: Wrench },
  { id: 'plugins', icon: Blocks },
] as const

type TabId = (typeof TABS)[number]['id']

const TAB_IDS = TABS.map((x) => x.id) as readonly string[]
const DEFAULT_TAB: TabId = 'skills'

export default function CapabilitiesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { tab } = useParams<{ tab?: string }>()

  const active: TabId = (tab && TAB_IDS.includes(tab) ? tab : DEFAULT_TAB) as TabId

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-8 animate-fade-in">
      {/* Standard Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/40">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-foreground/10 text-foreground border border-border/40 shadow-xs">
              <Blocks size={22} className="stroke-[2.2]" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-heading font-extrabold tracking-tight text-foreground">
              {t('capabilitiesPage.title')}
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 ml-1">
            {t('capabilitiesPage.subtitle')}
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(({ id, icon: Icon }) => {
          const isCurrent = id === active
          return (
            <button
              key={id}
              type="button"
              onClick={() => navigate(`/capabilities/${id}`, { replace: true })}
              className={cn(
                'px-4 py-2 rounded-xl text-xs font-bold border shrink-0 whitespace-nowrap flex items-center gap-2.5 transition-all shadow-2xs select-none',
                isCurrent
                  ? 'bg-primary/10 border-primary text-primary shadow-xs'
                  : 'bg-card/70 text-muted-foreground border-border/50 hover:bg-card hover:text-foreground',
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{t(`capabilitiesPage.tabs.${id}`)}</span>
            </button>
          )
        })}
      </div>

      {/* Panel container */}
      <div className="pt-1">
        {active === 'plugins' && <PluginsPanel />}
        {active === 'skills' && <SkillsPage embedded />}
        {active === 'mcp' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('capabilitiesPage.mcp.desc')}
            </p>
            <McpSettings />
          </div>
        )}
        {active === 'subagents' && <SubagentsPanel />}
        {active === 'tools' && <ToolsPanel />}
      </div>
    </div>
  )
}
