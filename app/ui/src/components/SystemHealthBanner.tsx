// src/components/SystemHealthBanner.tsx
// 后端自报的"现在能不能完全相信我"，摆到界面上。
//
// # 为什么需要它
//
// `/api/health` 早就诚实地报了两件足以改变用户判断的事：
//   - `migrations.recoveryMode`：某个 schema 升级失败并回滚了，应用**正跑在旧
//     schema 上**。新功能读不到自己的列，行为会莫名其妙地退化。
//   - `instanceLock.held === false`：实例锁不在自己手里，另一个后端可能正在写
//     同一批数据库。
//
// 但在这之前，整个前端**没有任何地方**请求过 `/api/health`。也就是说这两种状态
// 只存在于一个没人看的 JSON 里：用户看到的是一个完全正常的界面，然后开始怀疑
// 自己——"我明明存了这条记忆，怎么没了"。一个没人读的诊断端点等于没有诊断。
//
// # 为什么是常驻条，且不可关闭
//
// 这两种状态都是持续性的，不是一次性事件：toast 会飘走，读成"刚刚出过一个错"。
// 也不给关闭按钮——它不是提醒，是"当前运行状态和你以为的不一样"。修好之后（重启
// 完成迁移、另一个实例退出）下一次轮询自己就消失了。
//
// 后端连不上时**什么都不显示**：那是另一个问题，页头的连接点已经在报了，两处同时
// 喊会让人分不清到底哪个坏了。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { API_BASE, apiFetch } from '@lib/api'

interface HealthBody {
  status?: string
  instanceLock?: { held?: boolean }
  migrations?: { recoveryMode?: string; pending?: string[]; deferred?: string[] }
}

const POLL_MS = 30_000

export function SystemHealthBanner() {
  const { t } = useTranslation()
  const [health, setHealth] = useState<HealthBody | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const r = await apiFetch(`${API_BASE}/api/health`)
        if (!r.ok) throw new Error(String(r.status))
        const d: HealthBody = await r.json()
        if (alive) setHealth(d)
      } catch {
        // 拿不到就当没事：后端不可达有它自己的指示器。
        if (alive) setHealth(null)
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  if (!health || health.status === 'ok') return null

  const recovery = health.migrations?.recoveryMode || ''
  const lockLost = health.instanceLock?.held === false
  // 两种问题可以同时成立。降级的那条更要紧（数据形状不对），排在前面。
  const lines: string[] = []
  if (recovery) {
    lines.push(recovery === 'unrecoverable'
      ? t('systemHealth.migrationUnrecoverable')
      : t('systemHealth.migrationCompat'))
  }
  if (lockLost) lines.push(t('systemHealth.lockLost'))
  if (lines.length === 0) return null

  return (
    <div
      role="status"
      className="flex items-start gap-2 px-4 py-2 text-xs bg-destructive/10
                 border-b border-destructive/25 text-destructive"
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <span className="font-medium">{t('systemHealth.title')}</span>
        {lines.map((l) => (
          <p key={l} className="text-destructive/85">{l}</p>
        ))}
      </div>
    </div>
  )
}
