// src/components/settings/SettingsNav.tsx
// Grouped vertical nav for the settings shell.
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'

export interface SettingsNavItem {
  id: string
  labelKey: string
  icon: any
}

export interface SettingsNavGroup {
  labelKey: string
  items: SettingsNavItem[]
}

export function SettingsNav({
  groups, active, onSelect,
}: {
  groups: SettingsNavGroup[]
  active: string
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="w-[220px] shrink-0 border-r border-border/40 bg-sidebar/20 backdrop-blur-md select-none">
      <nav className="sticky top-0 max-h-screen overflow-y-auto flex flex-col py-2">
        {/* Back to Workspace button */}
        <div className="px-3 pb-2">
          <button
            onClick={() => navigate('/chat')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <ArrowLeft size={14} />
            <span>{t('settingsPage.backToWorkspace')}</span>
          </button>
        </div>

        <div className="px-3 space-y-4">
          {groups.map((group) => (
            <div key={group.labelKey} className="space-y-1">
              <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
                {t(group.labelKey)}
              </div>
              <div className="space-y-0.5">
                {group.items.map(({ id, labelKey, icon: Icon }) => {
                  const isActive = id === active
                  return (
                    <button
                      key={id}
                      onClick={() => onSelect(id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-left transition-colors duration-150',
                        isActive
                          ? 'bg-card text-foreground shadow-2xs border border-border/50 font-bold'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
                      )}
                    >
                      <Icon
                        size={15}
                        className={cn(
                          'shrink-0 transition-colors',
                          isActive ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground',
                        )}
                      />
                      <span className="truncate">{t(labelKey)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>
    </div>
  )
}
