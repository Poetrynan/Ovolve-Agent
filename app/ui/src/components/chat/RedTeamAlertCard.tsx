import React from 'react'
import { ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RedTeamAlert } from '@apptypes/index'

export function RedTeamAlertCard({ alert }: { alert: RedTeamAlert }) {
  const { t } = useTranslation()
  const count = alert.count || alert.findings?.length || 0
  if (!count) return null

  return (
    <div className="flex justify-center my-2.5 px-4">
      <div className="max-w-lg w-full rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-xs">
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-semibold mb-1">
          <ShieldAlert className="w-3.5 h-3.5" />
          {t('store.redTeam.title', '红队巡逻发现 {{count}} 处风险', { count })}
        </div>
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {(alert.findings || []).slice(0, 5).map((f, i) => (
            <li key={i} className="truncate">
              · {f.source}: {String(f.hit?.category || f.hit?.matched || 'injection')}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
