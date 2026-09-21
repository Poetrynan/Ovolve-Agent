import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Palette, Bot, Shield, Brain, MessageSquare,
  Settings2, Check, Loader2, Bell,
  MonitorDown, Trash2, Gauge, EyeOff, Terminal, ShieldCheck, Layers,
} from 'lucide-react'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@/lib/utils'

import { useNotifyPrefsStore } from '@store/notifyPrefsStore'
import { useTrayPrefsStore } from '@store/trayPrefsStore'

import { SettingsNav, type SettingsNavGroup } from '@components/settings/SettingsNav'
import { SettingRow, SettingGroup, SettingSection } from '@components/settings/SettingRow'
import { Switch } from '@components/ui/switch'
import { Slider } from '@components/ui/slider'
import { Input } from '@components/ui/input'
import { Button } from '@components/ui/button'
import { Badge } from '@components/ui/badge'
import { ThemeSwitcher } from '@components/theme-toggle'
import { LanguageSwitcher } from '@components/LanguageSwitcher'
import { DensitySelector } from '@components/chat/DensitySelector'
import { ProviderSettings } from '@components/settings/ProviderSettings'
import { MemorySettings } from '@components/settings/MemorySettings'
import { MemoryDiagnostics } from '@components/settings/MemoryDiagnostics'
import { WikiClaims } from '@components/settings/WikiClaims'
import { HooksSettings } from '@components/settings/HooksSettings'
import { SandboxProtectionStatus } from '@components/settings/SandboxProtectionStatus'
import { SegmentedControl } from '@components/ui/SegmentedControl'



/** One standing permission rule, as returned by `GET /api/permissions/rules`. */
interface PermissionRule {
  id: string
  toolName: string
  pattern: string
  behavior: 'allow' | 'ask' | 'deny'
  scope: 'session' | 'workspace' | 'global'
  source: string
  note: string
}

const RULE_BEHAVIOR_LABEL: Record<string, string> = {
  allow: '自动放行',
  ask: '每次询问',
  deny: '禁止',
}

const RULE_SCOPE_LABEL: Record<string, string> = {
  session: '本会话',
  workspace: '本项目',
  global: '全局',
}




/**
 * Settings shell.
 *
 * Settings is ONLY settings: things you configure once and leave — appearance,
 * models, permissions, agent behaviour, memory policy. The recurring *features*
 * (skills, cron, bot, usage) are NOT here; they are first-class pages reached
 * from the main sidebar, the way industry peers keep 「能力扩展」/「技能」as their own
 * surfaces rather than burying them under a gear icon. They used to be embedded
 * here as extra nav sections, which made clicking 「机器人」 or 「技能」 throw the
 * user into the settings chrome — the exact complaint this layout now fixes.
 */

type SectionId =
  | 'general' | 'guide' | 'models' | 'permissions' | 'privacy'
  | 'behavior' | 'memory' | 'context' | 'hooks'

/** Feature pages that MOVED out of Settings to their own top-level routes.
 *  A stale `/settings/skills` link (bookmark, old nudge) should land on the
 *  real page now, not silently fall back to the General tab. */
const MOVED_TO_TOPLEVEL: Record<string, string> = {
  skills: '/capabilities/skills',
  mcp: '/capabilities/mcp',
  cron: '/cron',
  bot: '/bot',
  usage: '/usage',
}

/**
 * 上网权限（命令级网络出口策略）。自包含组件：独立加载/保存
 * （PUT /api/permissions/network 热生效），不挂主保存按钮——
 * 网络名单的调整节奏和模型参数不同，混在一起只会让两个按钮互相污染脏状态。
 */
function NetworkEgressGroup() {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'open' | 'closed'>('open')
  const [allowText, setAllowText] = useState('')
  const [denyText, setDenyText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    apiFetch(`${API_BASE}/api/permissions/network`)
      .then((r) => r.json())
      .then((d) => {
        setMode(d.mode === 'closed' ? 'closed' : 'open')
        setAllowText((d.allow || []).join('\n'))
        setDenyText((d.deny || []).join('\n'))
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      const r = await apiFetch(`${API_BASE}/api/permissions/network`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          allow: allowText.split('\n').map((s) => s.trim()).filter(Boolean),
          deny: denyText.split('\n').map((s) => s.trim()).filter(Boolean),
        }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setErr(d.error || t('settingsPage.saveFailed'))
      } else {
        setSavedOk(true)
        setTimeout(() => setSavedOk(false), 2000)
      }
    } catch {
      setErr(t('settingsPage.saveFailedOffline'))
    }
    setSaving(false)
  }

  const dirty = !loaded

  return (
    <SettingGroup title={t('settingsPage.netGroupTitle', '上网权限')}>
      <SettingRow
        title={t('settingsPage.netModeTitle', '访问范围')}
        description={t('settingsPage.netModeHint',
          '控制 AI 在运行命令、访问网页时能去哪些网站。保存后立即生效，无需重启。')}
        control={
          <SegmentedControl
            layoutId="net-mode"
            className="w-[200px]"
            value={mode}
            onChange={(v) => setMode(v as 'open' | 'closed')}
            segments={[
              { id: 'open', label: t('settingsPage.netOpen', '默认放行') },
              { id: 'closed', label: t('settingsPage.netClosed', '仅限白名单') },
            ]}
          />
        }
      />
      <div className="px-4 pb-3 text-[11px] text-muted-foreground leading-relaxed">
        {mode === 'open'
          ? t('settingsPage.netOpenHint',
              '默认放行时，AI 可以访问大多数网站；下方「永不访问」的名单始终生效。')
          : t('settingsPage.netClosedHint',
              '仅限白名单时，访问名单以外的网站前，AI 会先征求你的同意。')}
      </div>
      <SettingRow
        title={t('settingsPage.netAllowTitle', '允许访问')}
        description={t('settingsPage.netAllowHint',
          '每行一个域名（如 example.com），包含它的子域名。仅「仅限白名单」模式生效。')}
        control={
          <textarea
            value={allowText}
            onChange={(e) => setAllowText(e.target.value)}
            placeholder={'docs.example.com\ngithub.com'}
            spellCheck={false}
            rows={3}
            disabled={dirty}
            className="w-56 px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40 resize-y"
          />
        }
      />
      <SettingRow
        title={t('settingsPage.netDenyTitle', '永不访问')}
        description={t('settingsPage.netDenyHint',
          '每行一个域名。名单里的网站连同子域名一起拦截，任何情况下都不放行。')}
        control={
          <textarea
            value={denyText}
            onChange={(e) => setDenyText(e.target.value)}
            placeholder={'tracker.example.com'}
            spellCheck={false}
            rows={3}
            disabled={dirty}
            className="w-56 px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40 resize-y"
          />
        }
      />
      <div className="px-4 py-3 flex items-center justify-end gap-2 border-t border-border/30">
        {err && <span className="text-xs text-destructive mr-auto">{err}</span>}
        {savedOk && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400 mr-auto">
            {t('settingsPage.netSaved', '已保存，立即生效')}
          </span>
        )}
        <Button size="sm" className="h-8 text-xs" onClick={() => void save()} disabled={saving || dirty}>
          {t('settingsPage.netSave', '保存上网权限')}
        </Button>
      </div>
    </SettingGroup>
  )
}

/** GET /api/permissions/overview 的返回形状。各族都允许缺项：后端任一
 *  族读不到时按 null/缺失上报，前端显示"未知"而不是白屏。 */
interface PermissionsOverview {
  network?: { mode?: string; allow?: string[]; deny?: string[] } | null
  fileOp?: {
    source?: string
    filesystem?: { path: string; access: string; raw?: string }[]
    network?: Record<string, unknown>
  } | null
  commandRules?: { toolName: string; pattern: string; behavior: string; scope: string; note?: string }[] | null
  scheduled?: { activeJobs?: number } | null
}

/** 文件访问徽标三色：rw 绿 / ro 琥珀 / none 红。 */
const FILE_ACCESS_BADGE: Record<string, string> = {
  rw: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  ro: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  none: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
}

const COMMAND_BEHAVIOR_BADGE: Record<string, string> = {
  allow: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  ask: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  deny: 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
}

function OverviewBadge({ label, cls }: { label: string; cls?: string }) {
  return (
    <Badge className={cn(
      'text-[10px] font-bold px-2 py-0.5 rounded-lg border shadow-2xs shrink-0',
      cls || 'bg-muted text-muted-foreground border-border/40',
    )}>
      {label}
    </Badge>
  )
}

/**
 * 权限总览（只读）。一屏看全四个审批相关配置族的现状：网络出口、文件操作
 * 策略、命令规则、定时任务。数据来自聚合接口 /api/permissions/overview，
 * 编辑入口留在各族原有位置——这里刻意不做任何写操作，防止总览页长出
 * 第二套权限语义。任何一族读不到就显示缺项，绝不让整页挂掉。
 */
function PermissionsOverviewGroup() {
  const { t } = useTranslation()
  const [data, setData] = useState<PermissionsOverview | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    apiFetch(`${API_BASE}/api/permissions/overview`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setFailed(true))
  }, [])

  const missing = t('settingsPage.overviewMissing', '未知')

  const net = data?.network
  const fileOp = data?.fileOp
  const cmdRules = data?.commandRules
  const sched = data?.scheduled
  // activeJobs = -1 是后端的"查不到"哨兵，与 0（确实没有）含义不同。
  const schedLabel = !sched || typeof sched.activeJobs !== 'number' || sched.activeJobs < 0
    ? missing
    : String(sched.activeJobs)

  return (
    <SettingGroup title={t('settingsPage.overviewTitle', '权限总览')}>
      <div className="px-4 pt-3 text-[11px] text-muted-foreground leading-relaxed">
        {t('settingsPage.overviewDesc',
          '当前生效的审批与限制一览（只读）。修改请前往上方对应的分组。')}
      </div>

      {/* 网络出口 */}
      <SettingRow
        title={t('settingsPage.overviewNetwork', '网络出口')}
        control={
          <div className="flex items-center gap-2">
            <OverviewBadge
              label={net?.mode
                ? t(`settingsPage.overviewNetMode.${net.mode}`, net.mode)
                : missing}
              cls={net?.mode === 'closed'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'}
            />
            <span className="text-[11px] text-muted-foreground font-mono">
              {net
                ? t('settingsPage.overviewNetCounts', {
                    allow: (net.allow || []).length,
                    deny: (net.deny || []).length,
                    defaultValue: `放行 ${(net.allow || []).length} · 拦截 ${(net.deny || []).length}`,
                  })
                : missing}
            </span>
          </div>
        }
      />

      {/* 文件操作 */}
      <SettingRow
        title={t('settingsPage.overviewFileOp', '文件操作')}
        control={
          <div className="flex flex-wrap items-center gap-1.5 justify-end max-w-[380px]">
            {!fileOp && (
              <span className="text-[11px] text-muted-foreground">{missing}</span>
            )}
            {fileOp?.source && (
              <Badge className="text-[10px] px-2 py-0.5 rounded-lg border border-border/40 bg-muted text-muted-foreground shadow-2xs shrink-0">
                {fileOp.source}
              </Badge>
            )}
            {(fileOp?.filesystem || []).slice(0, 4).map((r) => (
              <span key={r.path} className="flex items-center gap-1 min-w-0">
                <code className="text-[10px] font-mono text-muted-foreground truncate max-w-[160px]">{r.path}</code>
                <OverviewBadge
                  label={r.access}
                  cls={FILE_ACCESS_BADGE[r.access]}
                />
              </span>
            ))}
            {(fileOp?.filesystem?.length || 0) > 4 && (
              <span className="text-[10px] text-muted-foreground">
                {t('settingsPage.overviewFileMore', { n: (fileOp?.filesystem?.length || 0) - 4, defaultValue: `还有 ${(fileOp?.filesystem?.length || 0) - 4} 条` })}
              </span>
            )}
          </div>
        }
      />

      {/* 命令规则 */}
      <SettingRow
        title={t('settingsPage.overviewCommands', '命令规则')}
        control={
          <div className="flex flex-wrap items-center gap-1.5 justify-end max-w-[380px]">
            {!cmdRules?.length && (
              <span className="text-[11px] text-muted-foreground">
                {failed ? missing : t('settingsPage.overviewNoRules', '无自定义规则')}
              </span>
            )}
            {(cmdRules || []).slice(0, 5).map((r, i) => (
              <span key={`${r.toolName}-${r.pattern}-${i}`} className="flex items-center gap-1 min-w-0">
                <code className="text-[10px] font-mono text-muted-foreground truncate max-w-[140px]">{r.pattern || r.toolName}</code>
                <OverviewBadge label={r.behavior} cls={COMMAND_BEHAVIOR_BADGE[r.behavior]} />
              </span>
            ))}
            {(cmdRules?.length || 0) > 5 && (
              <span className="text-[10px] text-muted-foreground">
                {t('settingsPage.overviewRulesMore', { n: (cmdRules?.length || 0) - 5, defaultValue: `还有 ${(cmdRules?.length || 0) - 5} 条` })}
              </span>
            )}
          </div>
        }
      />

      {/* 定时任务 */}
      <SettingRow
        title={t('settingsPage.overviewScheduled', '定时任务')}
        control={
          <span className="text-[11px] text-muted-foreground font-mono">
            {t('settingsPage.overviewScheduledJobs', { n: schedLabel, defaultValue: `活跃任务 ${schedLabel}` })}
          </span>
        }
      />

      {failed && (
        <div className="px-4 pb-3 text-[11px] text-muted-foreground">
          {t('settingsPage.overviewLoadFailed', '总览加载失败——各族的独立设置仍可正常使用。')}
        </div>
      )}
    </SettingGroup>
  )
}

const ALL_SECTIONS = ['general', 'models', 'permissions', 'privacy', 'behavior', 'memory', 'context', 'hooks']

/**
 * 搜索与出站（Handoff 后续批）：工具内置 HTTP 请求（搜索/网页抓取）的
 * 代理与 Tavily key。自包含组件、独立保存、立即生效——与 NetworkEgressGroup
 * 同款纪律。Tavily key 是凭据：GET 永远只回掩码，输入框留空 = 不改动，
 * 输入空串并保存 = 清除。
 */
interface OutboundSettings {
  proxyUrl: string
  tavilyConfigured: boolean
  tavilyKeyMasked: string
}

function OutboundSettingsGroup() {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [tavilyKey, setTavilyKey] = useState('')
  const [configured, setConfigured] = useState(false)
  const [masked, setMasked] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedOk, setSavedOk] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 「清除密钥」走的是同一条保存路径，但要在 body 里显式带上空 tavilyKey；
  // 普通保存（只改代理）不动密钥——用 ref 区分这两种意图。
  const clearKeyRef = useRef(false)

  useEffect(() => {
    apiFetch(`${API_BASE}/api/network/outbound`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: OutboundSettings) => {
        setProxyUrl(d.proxyUrl || '')
        setConfigured(Boolean(d.tavilyConfigured))
        setMasked(d.tavilyKeyMasked || '')
      })
      .catch(() => {})
      .finally(() => setLoaded(true))
  }, [])

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      // tavilyKey 只在用户输入了内容或显式清空（点"清除"）时才提交；
      // 普通保存不动密钥，避免把掩码误当新 key 写回去。
      const body: Record<string, string> = { proxyUrl }
      if (tavilyKey.trim() || clearKeyRef.current) body.tavilyKey = tavilyKey.trim()
      const r = await apiFetch(`${API_BASE}/api/network/outbound`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setErr(d.error || t('settingsPage.saveFailed'))
      } else {
        const d = await r.json()
        setConfigured(Boolean(d.tavilyConfigured))
        setMasked(d.tavilyKeyMasked || '')
        setTavilyKey('')
        clearKeyRef.current = false
        setSavedOk(true)
        setTimeout(() => setSavedOk(false), 2000)
      }
    } catch {
      setErr(t('settingsPage.saveFailedOffline'))
    }
    setSaving(false)
  }

  return (
    <SettingGroup title={t('settingsPage.outboundGroupTitle', '搜索与出站')}>
      <SettingRow
        title={t('settingsPage.outboundProxyTitle', '出站代理')}
        description={t('settingsPage.outboundProxyDesc',
          '工具内置的搜索与网页抓取走这个代理（如 http://127.0.0.1:7890）。留空则跟随系统/环境变量代理。')}
        control={
          <input
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            placeholder="http://127.0.0.1:7890"
            spellCheck={false}
            disabled={!loaded}
            className="w-56 px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40"
          />
        }
      />
      <SettingRow
        title={t('settingsPage.outboundTavilyTitle', 'Tavily API Key')}
        description={configured
          ? t('settingsPage.outboundTavilyConfigured', { masked, defaultValue: `已配置（${masked}）。输入新值可更换，点击「清除密钥」可删除。` })
          : t('settingsPage.outboundTavilyDesc',
              '可选。配置后联网搜索走 Tavily API（结构化结果，无需抓取网页）；未配置时使用 DuckDuckGo。密钥加密保存在本机。')}
        control={
          <input
            type="password"
            value={tavilyKey}
            onChange={(e) => { setTavilyKey(e.target.value); clearKeyRef.current = false }}
            placeholder={configured ? masked || '••••' : 'tvly-…'}
            spellCheck={false}
            disabled={!loaded}
            className="w-56 px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40"
          />
        }
      />
      <div className="px-4 py-3 flex items-center justify-end gap-2 border-t border-border/30">
        {err && <span className="text-xs text-destructive mr-auto">{err}</span>}
        {savedOk && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400 mr-auto">
            {t('settingsPage.outboundSaved', '已保存，立即生效')}
          </span>
        )}
        {configured && (
          <Button
            size="sm" variant="ghost"
            className="h-8 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => { clearKeyRef.current = true; setTavilyKey(''); void save() }}
            disabled={saving}
          >
            {t('settingsPage.outboundClearKey', '清除密钥')}
          </Button>
        )}
        <Button size="sm" className="h-8 text-xs" onClick={() => void save()} disabled={saving || !loaded}>
          {t('settingsPage.outboundSave', '保存出站设置')}
        </Button>
      </div>
    </SettingGroup>
  )
}const NAV_GROUPS: SettingsNavGroup[] = [
  {
    labelKey: 'settingsPage.groups.basics',
    items: [
      { id: 'general', labelKey: 'settingsPage.tabs.general', icon: Palette },
      { id: 'models', labelKey: 'settingsPage.tabs.models', icon: Bot },
      { id: 'permissions', labelKey: 'settingsPage.tabs.permissions', icon: Shield },
      { id: 'privacy', labelKey: 'settingsPage.tabs.privacy', icon: EyeOff },
    ],
  },
  {
    labelKey: 'settingsPage.groups.agent',
    items: [
      { id: 'behavior', labelKey: 'settingsPage.tabs.behavior', icon: Gauge },
      { id: 'memory', labelKey: 'settingsPage.tabs.memory', icon: Brain },
      { id: 'context', labelKey: 'settingsPage.tabs.context', icon: Layers },
    ],
  },
  {
    // Hooks is infrastructure, not a sub-feature of "agent behaviour" —
    // first-class peers keep it on its own the way the major clients do.
    labelKey: 'settingsPage.groups.extensions',
    items: [
      { id: 'hooks', labelKey: 'settingsPage.tabs.hooks', icon: Terminal },
    ],
  },
]

/**
 * Last fetched settings, at module scope. Navigating away unmounts this page,
 * so every re-entry used to refetch and gate the whole pane behind a spinner —
 * a flash on every single visit. With the cache the first paint is the real UI
 * (seeded from the last known values) and the fetch refreshes in place.
 */
let CACHED_SETTINGS: {
  maxTokens: number; temperature: number; streamTimeout: number; permMode: string
  memoryEnabled: boolean; telemetryOn: boolean; autoConfirmLowRisk: boolean
  foldThreshold: number; foldEmergency: number; foldCooldown: number
  /** 折叠水位地板（千 tokens）；用户未设置过时 undefined。 */
  foldFloorK?: number
  gitTrustEnabled: boolean
  shadowMode: 'off' | 'validate' | 'staged'
  shadowPrecheck: boolean
} | null = null

export default function SettingsPage() {
  const { t } = useTranslation()
  const { section } = useParams<{ section?: string }>()
  const navigate = useNavigate()
  const {
    enabled: notifyEnabled, whenFocused: notifyWhenFocused, failuresOnly: notifyFailuresOnly,
    setEnabled: setNotifyEnabled, setWhenFocused: setNotifyWhenFocused,
    setFailuresOnly: setNotifyFailuresOnly,
  } = useNotifyPrefsStore()
  const { closeToTray, setCloseToTray } = useTrayPrefsStore()

  // Derive initial section from URL param, or default.
  const initialSection: SectionId = (
    section && ALL_SECTIONS.includes(section)
      ? section as SectionId : 'general'
  )
  const [active, setActive] = useState<SectionId>(initialSection)
  const [loading, setLoading] = useState(() => !CACHED_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [maxTokens, setMaxTokens] = useState(() => CACHED_SETTINGS?.maxTokens ?? 8192)
  const [temperature, setTemperature] = useState(() => CACHED_SETTINGS?.temperature ?? 0.7)
  const [streamTimeout, setStreamTimeout] = useState(() => CACHED_SETTINGS?.streamTimeout ?? 120)
  const [permMode, setPermMode] = useState(() => CACHED_SETTINGS?.permMode ?? 'auto')
  const [memoryEnabled, setMemoryEnabled] = useState(() => CACHED_SETTINGS?.memoryEnabled ?? true)
  const [telemetryOn, setTelemetryOn] = useState(() => CACHED_SETTINGS?.telemetryOn ?? true)
  const [autoConfirmLowRisk, setAutoConfirmLowRisk] = useState(() => CACHED_SETTINGS?.autoConfirmLowRisk ?? true)
  // Fold knobs. Slider-native integers / percents.
  const [foldThreshold, setFoldThreshold] = useState(() => CACHED_SETTINGS?.foldThreshold ?? 80)
  const [foldEmergency, setFoldEmergency] = useState(() => CACHED_SETTINGS?.foldEmergency ?? 90)
  const [foldCooldown, setFoldCooldown] = useState(() => CACHED_SETTINGS?.foldCooldown ?? 15)
  // 折叠水位地板（千 tokens）：折叠后必须保留的空闲空间。undefined = 未手动设置。
  const [foldFloorK, setFoldFloorK] = useState<number | undefined>(
    () => CACHED_SETTINGS?.foldFloorK)
  const [gitTrustEnabled, setGitTrustEnabled] = useState(() => CACHED_SETTINGS?.gitTrustEnabled ?? true)
  const [shadowMode, setShadowMode] = useState<'off' | 'validate' | 'staged'>(
    () => CACHED_SETTINGS?.shadowMode ?? 'staged',
  )
  const [shadowPrecheck, setShadowPrecheck] = useState(() => CACHED_SETTINGS?.shadowPrecheck ?? true)
  // The loaded snapshot, for dirty tracking — a save button that is always
  // enabled teaches the user it does nothing half the time.
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(
    () => (CACHED_SETTINGS ? { ...CACHED_SETTINGS } : null))
  // Standing permission rules. Kept here rather than in a store because nothing
  // outside this panel reads them — the backend is the only consumer.
  const [rules, setRules] = useState<PermissionRule[]>([])
  // Which protection layers actually fire. Shipped by the same endpoint as the
  // rules: the SANDBOX layer is registered in the policy pipeline but has no
  // writer for its flag, so it can never deny anything. Showing that here is
  // the point — a layer users believe in but which never runs is worse than an
  // absent one. Disappears by itself once the backend reports it effective.
  const [sandbox, setSandbox] = useState<{ effective: boolean; note: string } | null>(null)
  const [confinement, setConfinement] = useState<{
    effective: boolean
    level?: string
    backend?: string
    note?: string
    policy_source?: string
  } | null>(null)

  const loadRules = useCallback(() => {
    apiFetch(`${API_BASE}/api/permissions/rules`)
      .then((r) => r.json())
      .then((d) => {
        setRules(Array.isArray(d.rules) ? d.rules : [])
        setSandbox(d.sandbox && typeof d.sandbox === 'object' ? d.sandbox : null)
        setConfinement(d.confinement && typeof d.confinement === 'object' ? d.confinement : null)
      })
      .catch(() => {})
  }, [])


  useEffect(() => {
    if (active === 'permissions') loadRules()
  }, [active, loadRules])

  const deleteRule = useCallback(
    (id: string) => {
      apiFetch(`${API_BASE}/api/permissions/rules/${id}`, { method: 'DELETE' })
        .then(() => setRules((rs) => rs.filter((r) => r.id !== id)))
        .catch(() => {})
    },
    [],
  )

  // A stale `/settings/skills` (bookmark, old link) must land on the real page.
  useEffect(() => {
    const moved = section ? MOVED_TO_TOPLEVEL[section] : undefined
    if (moved) navigate(moved, { replace: true })
  }, [section, navigate])

  useEffect(() => {
    apiFetch(`${API_BASE}/api/settings`)
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings || {}
        const m = s.model || {}
        // A config.json from before the merge may still say `deny` (its old
        // spelling for a write ban). Map it onto the read-only option we now
        // surface here so the card highlights instead of showing nothing.
        const rawPermRaw = (s.permissions || {}).mode || 'auto'
        const rawPerm = rawPermRaw === 'deny' || rawPermRaw === 'readonly' ? 'plan' : rawPermRaw
        const a = s.agent || {}
        const c = s.compaction || {}
        const sh = s.shadow || {}
        const rawShadow = String(sh.mode || 'staged').toLowerCase()
        const shadowModeVal = (['off', 'validate', 'staged'].includes(rawShadow)
          ? rawShadow : 'staged') as 'off' | 'validate' | 'staged'
        const next = {
          maxTokens: m.max_tokens || 8192,
          temperature: m.temperature ?? 0.7,
          streamTimeout: m.stream_timeout_s || 120,
          permMode: rawPerm,
          memoryEnabled: (s.memory || {}).enabled !== false,
          telemetryOn: (s.telemetry || {}).enabled !== false,
          autoConfirmLowRisk: (s.permissions || {}).auto_confirm_low_risk !== false,
          foldThreshold: Math.round((c.threshold ?? 0.80) * 100),
          foldEmergency: Math.round((c.emergency_threshold ?? 0.90) * 100),
          foldCooldown: c.cooldown_s || 15,
          // 水位地板：config 里没写过就不显示滑杆值（undefined → 输入框留空）
          foldFloorK: typeof c.reserve_tokens_floor === 'number' ? Math.round(c.reserve_tokens_floor / 1000) : undefined,
          gitTrustEnabled: (s.workspace || {}).git_trust_enabled !== false,
          shadowMode: shadowModeVal,
          shadowPrecheck: sh.precheck !== false,
        }
        setMaxTokens(next.maxTokens)
        setTemperature(next.temperature)
        setStreamTimeout(next.streamTimeout)
        setPermMode(next.permMode)
        setAutoConfirmLowRisk(next.autoConfirmLowRisk)
        setMemoryEnabled(next.memoryEnabled)
        setTelemetryOn(next.telemetryOn)
        setFoldThreshold(next.foldThreshold)
        setFoldEmergency(next.foldEmergency)
        setFoldCooldown(next.foldCooldown)
        setFoldFloorK(next.foldFloorK)
        setGitTrustEnabled(next.gitTrustEnabled)
        setShadowMode(next.shadowMode)
        setShadowPrecheck(next.shadowPrecheck)
        setSnapshot({ ...next })
        CACHED_SETTINGS = next
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const save = useCallback(async () => {
    setSaving(true); setSaved(false); setSaveError(null)
    try {
      const r = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: {
            max_tokens: maxTokens,
            temperature,
            stream_timeout_s: streamTimeout,
          },
          permissions: { mode: permMode },
          workspace: { git_trust_enabled: gitTrustEnabled },
          agent: { max_steps_per_turn: 0 },
          compaction: {
            threshold: foldThreshold / 100,
            emergency_threshold: foldEmergency / 100,
            cooldown_s: foldCooldown,
            // 水位地板：只在用户填过值时下发——空值不该把后端默认顶掉
            ...(typeof foldFloorK === 'number'
              ? { reserve_tokens_floor: Math.max(0, foldFloorK) * 1000 }
              : {}),
          },
        }),
      })
      if (r.ok) {
        setSaved(true)
        const next = {
          maxTokens, temperature, streamTimeout, permMode,
          memoryEnabled, telemetryOn, autoConfirmLowRisk,
          foldThreshold, foldEmergency, foldCooldown,
          foldFloorK, gitTrustEnabled,
          shadowMode, shadowPrecheck,
        }
        setSnapshot({ ...next })
        CACHED_SETTINGS = next
        setTimeout(() => setSaved(false), 2000)
      } else {
        // A silent catch used to swallow this: the button span ✓ while the
        // backend had rejected the patch, and the user only found out when the
        // value snapped back on reload.
        const d = await r.json().catch(() => ({}))
        setSaveError(d.error || t('settingsPage.saveFailed'))
      }
    } catch {
      setSaveError(t('settingsPage.saveFailedOffline'))
    }
    setSaving(false)
  }, [maxTokens, temperature, streamTimeout, permMode, memoryEnabled, telemetryOn, autoConfirmLowRisk, foldThreshold, foldEmergency, foldCooldown, foldFloorK, gitTrustEnabled, t])

  /**
   * Instant-save patch for a single switch. Switches that take effect
   * immediately must not sit behind a save button — a toggle that needs a
   * separate "save" click reads as broken ("I turned it off and nothing
   * happened"). On failure the local value reverts and the error surfaces.
   */
  const patchNow = useCallback(async (body: Record<string, unknown>, onFail: () => void) => {
    setSaveError(null)
    try {
      const r = await apiFetch(`${API_BASE}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        onFail()
        const d = await r.json().catch(() => ({}))
        setSaveError(d.error || t('settingsPage.saveFailed'))
      }
    } catch {
      onFail()
      setSaveError(t('settingsPage.saveFailedOffline'))
    }
  }, [t])

  const toggleMemory = useCallback((v: boolean) => {
    const prev = memoryEnabled
    setMemoryEnabled(v)
    void patchNow({ memory: { enabled: v } }, () => setMemoryEnabled(prev))
  }, [memoryEnabled, patchNow])

  const toggleTelemetry = useCallback((v: boolean) => {
    const prev = telemetryOn
    setTelemetryOn(v)
    void patchNow({ telemetry: { enabled: v } }, () => setTelemetryOn(prev))
  }, [telemetryOn, patchNow])

  const toggleAutoConfirm = useCallback((v: boolean) => {
    const prev = autoConfirmLowRisk
    setAutoConfirmLowRisk(v)
    void patchNow({ permissions: { auto_confirm_low_risk: v } }, () => setAutoConfirmLowRisk(prev))
  }, [autoConfirmLowRisk, patchNow])

  const patchShadow = useCallback((mode: 'off' | 'validate' | 'staged') => {
    const prev = shadowMode
    setShadowMode(mode)
    void patchNow({ shadow: { mode } }, () => setShadowMode(prev))
  }, [shadowMode, patchNow])

  const toggleShadowPrecheck = useCallback((v: boolean) => {
    const prev = shadowPrecheck
    setShadowPrecheck(v)
    void patchNow({ shadow: { precheck: v } }, () => setShadowPrecheck(prev))
  }, [shadowPrecheck, patchNow])

  // Selecting a section also updates the URL (shallow, replace) so the address
  // stays shareable and the back button behaves, without a full remount.
  const selectSection = useCallback((id: SectionId) => {
    setActive(id)
    navigate(`/settings/${id}`, { replace: true })
  }, [navigate])

  // Fire a test toast so the user can verify the OS actually shows it before
  // relying on it for real turn-completed pings. Uses the same IPC path as the
  // production notifier, falling back to the web Notification API in the
  // browser-dev harness.
  const sendTestNotification = useCallback(() => {
    const heading = t('settingsPage.notifyTitle')
    const body = t('settingsPage.notifyDesc')
    const api = (window as any)?.electronAPI
    if (api?.isElectron && typeof api.invoke === 'function') {
      api.invoke('system:notify', { title: heading, body }).catch(() => {})
      return
    }
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const show = () => new Notification(heading, { body })
      if (Notification.permission === 'granted') show()
      else if (Notification.permission === 'default') {
        Notification.requestPermission().then((p) => { if (p === 'granted') show() }).catch(() => {})
      }
    }
  }, [t])

  // Only the sections backed by the batched `/api/settings` save get a button.
  const needsSave = active === 'models' || active === 'permissions' || active === 'behavior'

  const dirty = useMemo(() => {
    if (!snapshot) return false
    return (
      snapshot.maxTokens !== maxTokens
      || snapshot.temperature !== temperature
      || snapshot.streamTimeout !== streamTimeout
      || snapshot.permMode !== permMode
      || snapshot.foldThreshold !== foldThreshold
      || snapshot.foldEmergency !== foldEmergency
      || snapshot.foldCooldown !== foldCooldown
      || snapshot.gitTrustEnabled !== gitTrustEnabled
    )
  }, [snapshot, maxTokens, temperature, streamTimeout, permMode, foldThreshold, foldEmergency, foldCooldown, gitTrustEnabled])

  const saveButton = needsSave ? (
    <div className="flex items-center gap-3">
      {saveError && (
        <span className="text-xs text-destructive max-w-[220px] truncate" title={saveError}>
          {saveError}
        </span>
      )}
      <Button
        onClick={save}
        disabled={saving || (!dirty && !saveError)}
        size="sm"
        className={cn(
          'rounded-xl h-9 px-4 text-xs font-semibold shadow-xs transition-colors',
          saved ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-primary hover:bg-primary/90 text-primary-foreground',
        )}
      >
        {saving ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />{t('settingsPage.saving')}</>
          : saved ? <><Check className="h-3.5 w-3.5 mr-1.5" />{t('settingsPage.saved')}</>
          : <><Settings2 className="h-3.5 w-3.5 mr-1.5" />{dirty ? t('settingsPage.save') : t('settingsPage.savedIdle')}</>}
      </Button>
    </div>
  ) : null

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[400px]">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)]">
      <SettingsNav groups={NAV_GROUPS} active={active} onSelect={(id) => selectSection(id as SectionId)} />

      <div className="flex-1 min-w-0">
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-8 space-y-8 animate-fade-in">
          {active === 'general' && (
            <SettingSection title={t('settingsPage.tabs.general')} description={t('settingsPage.appearanceDesc')}>
              <SettingGroup>
                <SettingRow
                  icon={Palette}
                  title={t('settingsPage.themeTitle')}
                  description={t('settingsPage.themeDesc')}
                  control={<ThemeSwitcher />}
                />
                <SettingRow
                  title={t('settingsPage.languageTitle')}
                  description={t('settingsPage.languageDesc')}
                  control={<LanguageSwitcher />}
                />
                <SettingRow
                  icon={MessageSquare}
                  title={t('density.header')}
                  description={t('density.hint')}
                  control={<DensitySelector />}
                />
              </SettingGroup>

              <SettingGroup title={t('settingsPage.notifyGroupTitle')}>
                <SettingRow
                  htmlFor="notify-enabled"
                  icon={Bell}
                  title={t('settingsPage.notifyTitle')}
                  description={t('settingsPage.notifyDesc')}
                  control={
                    <Switch
                      id="notify-enabled"
                      checked={notifyEnabled}
                      onCheckedChange={setNotifyEnabled}
                      aria-label={t('settingsPage.notifyAria')}
                    />
                  }
                />
                <div className={cn('transition-opacity', !notifyEnabled && 'opacity-40 pointer-events-none')}>
                  <SettingRow
                    htmlFor="notify-when-focused"
                    title={t('settingsPage.notifyWhenFocusedTitle')}
                    description={t('settingsPage.notifyWhenFocusedDesc')}
                    control={
                      <Switch
                        id="notify-when-focused"
                        checked={notifyWhenFocused}
                        onCheckedChange={setNotifyWhenFocused}
                        disabled={!notifyEnabled}
                        aria-label={t('settingsPage.notifyWhenFocusedAria')}
                      />
                    }
                  />
                  <SettingRow
                    htmlFor="notify-failures-only"
                    title={t('settingsPage.notifyFailuresOnlyTitle')}
                    description={t('settingsPage.notifyFailuresOnlyDesc')}
                    control={
                      <Switch
                        id="notify-failures-only"
                        checked={notifyFailuresOnly}
                        onCheckedChange={setNotifyFailuresOnly}
                        disabled={!notifyEnabled}
                        aria-label={t('settingsPage.notifyFailuresOnlyAria')}
                      />
                    }
                  />
                  <SettingRow
                    title={t('settingsPage.notifyTest')}
                    description={t('settingsPage.notifyTestDesc')}
                    control={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={sendTestNotification}
                        disabled={!notifyEnabled}
                        className="rounded-xl h-8 px-3 text-xs border-border/50 bg-background/60 shadow-2xs"
                      >
                        <Bell className="w-3.5 h-3.5 mr-1.5" />
                        {t('settingsPage.notifyTest')}
                      </Button>
                    }
                  />
                </div>
              </SettingGroup>

              <SettingGroup
                title={t('settingsPage.trayGroupTitle')}
                description={t('settingsPage.trayHint')}
              >
                <SettingRow
                  htmlFor="close-to-tray"
                  icon={MonitorDown}
                  title={t('settingsPage.closeToTrayTitle')}
                  description={t('settingsPage.closeToTrayDesc')}
                  control={
                    <Switch
                      id="close-to-tray"
                      checked={closeToTray}
                      onCheckedChange={setCloseToTray}
                      aria-label={t('settingsPage.closeToTrayAria')}
                    />
                  }
                />
              </SettingGroup>
            </SettingSection>
          )}

          {active === 'models' && (
            <SettingSection
              title={t('settingsPage.tabs.models')}
              description={t('settingsPage.subtitle')}
              action={saveButton}
            >
              <ProviderSettings />
              <SettingGroup title={t('settingsPage.advancedTitle')}>
                <SettingRow
                  htmlFor="max-tokens"
                  title={t('settingsPage.maxTokensLabel')}
                  description={t('settingsPage.maxTokensHint')}
                  control={
                    <Input
                      id="max-tokens"
                      type="number"
                      min={256}
                      max={65536}
                      placeholder="8192"
                      value={maxTokens}
                      onChange={(e) => {
                        const n = Number(e.target.value)
                        setMaxTokens(Number.isFinite(n) && n > 0 ? Math.min(65536, Math.max(256, Math.round(n))) : 8192)
                      }}
                      className="w-28 h-8 rounded-xl text-xs font-mono"
                    />
                  }
                />
                <SettingRow
                  title={t('settingsPage.temperatureLabel', { temp: temperature })}
                  description={t('settingsPage.temperatureHint')}
                  control={
                    <div className="flex items-center gap-3 w-44">
                      <Slider
                        id="temperature"
                        value={[temperature]}
                        min={0}
                        max={1.5}
                        step={0.05}
                        onValueChange={([v]) => setTemperature(v)}
                        className="flex-1"
                        aria-label={t('settingsPage.temperatureLabel', { temp: temperature })}
                      />
                      <span className="text-xs font-mono text-muted-foreground w-8 text-right tabular-nums">
                        {temperature.toFixed(2)}
                      </span>
                    </div>
                  }
                />
                <SettingRow
                  title={t('settingsPage.streamTimeoutLabel', { s: streamTimeout })}
                  description={t('settingsPage.streamTimeoutHint')}
                  control={
                    <div className="flex items-center gap-3 w-44">
                      <Slider
                        id="stream-timeout"
                        value={[streamTimeout]}
                        min={30}
                        max={600}
                        step={10}
                        onValueChange={([v]) => setStreamTimeout(v)}
                        className="flex-1"
                        aria-label={t('settingsPage.streamTimeoutLabel', { s: streamTimeout })}
                      />
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right tabular-nums">
                        {streamTimeout}s
                      </span>
                    </div>
                  }
                />
              </SettingGroup>
            </SettingSection>
          )}

          {active === 'permissions' && (
            <SettingSection
              title={t('settingsPage.permTitle')}
              description={t('settingsPage.permDesc')}
              action={saveButton}
            >
              <SandboxProtectionStatus confinement={confinement} sandbox={sandbox} />
              <SettingGroup title={t('settingsPage.gitTrustGroupTitle')}>
                <SettingRow
                  htmlFor="git-trust-enabled"
                  icon={ShieldCheck}
                  title={t('settingsPage.gitTrustTitle')}
                  description={t('settingsPage.gitTrustDesc')}
                  control={
                    <Switch
                      id="git-trust-enabled"
                      checked={gitTrustEnabled}
                      onCheckedChange={setGitTrustEnabled}
                      aria-label={t('settingsPage.gitTrustTitle')}
                    />
                  }
                />
              </SettingGroup>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {[
                  { id: 'plan', title: t('permission.plan'), desc: t('permission.planDesc') },
                  { id: 'confirm', title: t('permission.confirm'), desc: t('permission.confirmDesc') },
                  { id: 'auto', title: t('permission.auto'), desc: t('permission.autoDesc') },
                  { id: 'full', title: t('permission.full'), desc: t('permission.fullDesc') },
                ].map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setPermMode(m.id)}
                    className={cn(
                      'p-5 rounded-2xl border text-left transition-colors duration-150 space-y-2 select-none',
                      permMode === m.id
                        ? 'bg-card border-primary/60 ring-2 ring-primary/20 shadow-xs'
                        : 'bg-card/60 border-border/50 hover:bg-card text-muted-foreground',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold text-foreground">{m.title}</span>
                      {permMode === m.id && (
                        <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                          <Check className="w-3.5 h-3.5 stroke-[3]" />
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{m.desc}</p>
                  </button>
                ))}
              </div>

              <SettingGroup title={t('settingsPage.permFineTuneTitle')} className="mt-6">
                <SettingRow
                  htmlFor="auto-confirm-low"
                  icon={ShieldCheck}
                  title={t('settingsPage.autoConfirmTitle')}
                  description={t('settingsPage.autoConfirmDesc')}
                  control={
                    <Switch
                      id="auto-confirm-low"
                      checked={autoConfirmLowRisk}
                      onCheckedChange={toggleAutoConfirm}
                      aria-label={t('settingsPage.autoConfirmTitle')}
                    />
                  }
                />
              </SettingGroup>

              {/* Standing rules */}
              <div className="mt-6 space-y-3">
                <div className="flex items-baseline justify-between px-1">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t('settingsPage.rulesTitle')}</h3>
                  <span className="text-xs text-muted-foreground font-mono">
                    {rules.length ? t('settingsPage.rulesCount', { n: rules.length }) : t('settingsPage.rulesEmpty')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground px-1 leading-relaxed">
                  {t('settingsPage.rulesDesc')}
                </p>
                <div className="space-y-2">
                  {rules.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-border/50 bg-card/60 shadow-2xs"
                    >
                      <Badge
                        className={cn(
                          'text-[10px] font-bold px-2 py-0.5 rounded-lg border shadow-2xs shrink-0',
                          r.behavior === 'deny'
                            ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30'
                            : r.behavior === 'ask'
                              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                              : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
                        )}
                      >
                        {t(`settingsPage.ruleBehavior.${r.behavior}`, RULE_BEHAVIOR_LABEL[r.behavior] ?? r.behavior)}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <code className="text-xs font-mono text-foreground font-semibold block truncate">
                          {r.pattern || t('settingsPage.ruleAllCalls', { tool: r.toolName })}
                        </code>
                        <span className="text-[11px] text-muted-foreground">
                          {r.toolName} · {t(`settingsPage.ruleScope.${r.scope}`, RULE_SCOPE_LABEL[r.scope] ?? r.scope)}
                          {r.source === 'builtin' ? ` · ${t('settingsPage.ruleBuiltin')}` : ''}
                          {r.note ? ` · ${r.note}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => deleteRule(r.id)}
                        title={t('settingsPage.ruleDelete')}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* 上网权限：命令级网络出口名单（独立保存，热生效） */}
              <NetworkEgressGroup />

              {/* 权限总览：四族现状只读聚合（Handoff 1.2a） */}
              <div className="mt-6">
                <PermissionsOverviewGroup />
              </div>

              {/* 搜索与出站：工具内置 HTTP 的代理与 Tavily key */}
              <div className="mt-6">
                <OutboundSettingsGroup />
              </div>
            </SettingSection>
          )}

          {active === 'privacy' && (
            <SettingSection
              title={t('settingsPage.tabs.privacy')}
              description={t('settingsPage.privacyDesc')}
            >
              {saveError && (
                <div className="mb-2 text-xs text-destructive">{saveError}</div>
              )}
              <SettingGroup title={t('settingsPage.telemetryGroupTitle')}>
                <SettingRow
                  htmlFor="telemetry-enabled"
                  icon={EyeOff}
                  title={t('settingsPage.telemetryTitle')}
                  description={t('settingsPage.telemetryDesc')}
                  control={
                    <Switch
                      id="telemetry-enabled"
                      checked={telemetryOn}
                      onCheckedChange={toggleTelemetry}
                      aria-label={t('settingsPage.telemetryTitle')}
                    />
                  }
                />
              </SettingGroup>
            </SettingSection>
          )}

          {active === 'behavior' && (
            <SettingSection
              title={t('settingsPage.tabs.behavior')}
              description={t('settingsPage.behaviorDesc')}
              action={saveButton}
            >

              <SettingGroup title={t('settingsPage.behaviorFoldTitle')}>
                <SettingRow
                  title={t('settingsPage.foldThresholdLabel', { n: foldThreshold })}
                  description={t('settingsPage.foldThresholdHint')}
                  control={
                    <div className="flex items-center gap-3 w-44">
                      <Slider
                        id="fold-threshold"
                        value={[foldThreshold]}
                        min={50}
                        max={95}
                        step={1}
                        onValueChange={([v]) => setFoldThreshold(v)}
                        className="flex-1"
                        aria-label={t('settingsPage.foldThresholdLabel', { n: foldThreshold })}
                      />
                      <span className="text-xs font-mono text-muted-foreground w-9 text-right tabular-nums">
                        {foldThreshold}%
                      </span>
                    </div>
                  }
                />
                <SettingRow
                  title={t('settingsPage.foldEmergencyLabel', { n: foldEmergency })}
                  description={t('settingsPage.foldEmergencyHint')}
                  control={
                    <div className="flex items-center gap-3 w-44">
                      <Slider
                        id="fold-emergency"
                        value={[foldEmergency]}
                        min={60}
                        max={98}
                        step={1}
                        onValueChange={([v]) => setFoldEmergency(Math.max(v, foldThreshold))}
                        className="flex-1"
                        aria-label={t('settingsPage.foldEmergencyLabel', { n: foldEmergency })}
                      />
                      <span className="text-xs font-mono text-muted-foreground w-9 text-right tabular-nums">
                        {foldEmergency}%
                      </span>
                    </div>
                  }
                />
                <SettingRow
                  title={t('settingsPage.foldCooldownLabel', { s: foldCooldown })}
                  description={t('settingsPage.foldCooldownHint')}
                  control={
                    <div className="flex items-center gap-3 w-44">
                      <Slider
                        id="fold-cooldown"
                        value={[foldCooldown]}
                        min={5}
                        max={120}
                        step={5}
                        onValueChange={([v]) => setFoldCooldown(v)}
                        className="flex-1"
                        aria-label={t('settingsPage.foldCooldownLabel', { s: foldCooldown })}
                      />
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right tabular-nums">
                        {foldCooldown}s
                      </span>
                    </div>
                  }
                />
                <SettingRow
                  htmlFor="fold-floor"
                  title={t('settingsPage.foldFloorTitle', '压缩后预留空间')}
                  description={t(
                    'settingsPage.foldFloorHint',
                    '每次折叠后至少保留这么多对话空间，保证 AI 还有足够的余量回答。'
                    + '数值越大，压缩越彻底、越早收进摘要。留空使用默认值。',
                  )}
                  control={
                    <div className="flex items-center gap-2 w-44 justify-end">
                      <Input
                        id="fold-floor"
                        type="number"
                        min={0}
                        step={1}
                        value={foldFloorK ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value.trim()
                          setFoldFloorK(raw === '' ? undefined : Math.max(0, Number(raw) || 0))
                        }}
                        placeholder="默认"
                        className="h-8 w-24 text-xs text-right tabular-nums"
                      />
                      <span className="text-xs font-mono text-muted-foreground w-12">
                        {t('settingsPage.foldFloorUnit', 'k tokens')}
                      </span>
                    </div>
                  }
                />
              </SettingGroup>

              <SettingGroup title={t('settingsPage.shadowGroupTitle', '影子工作区')}>
                <SettingRow
                  title={t('settingsPage.shadowModeTitle', '写入模式')}
                  description={t('settingsPage.shadowModeDesc', 'staged：先写入隔离层，校验通过后再合并；validate：直写但强校验；off：关闭')}
                  control={
                    <SegmentedControl
                      layoutId="shadow-mode"
                      className="w-[220px]"
                      value={shadowMode}
                      onChange={patchShadow}
                      segments={[
                        { id: 'off', label: t('settingsPage.shadowOff', '关') },
                        { id: 'validate', label: t('settingsPage.shadowValidate', '校验') },
                        { id: 'staged', label: t('settingsPage.shadowStaged', '暂存') },
                      ]}
                    />
                  }
                />
                <SettingRow
                  htmlFor="shadow-precheck"
                  title={t('settingsPage.shadowPrecheckTitle', '落盘前语法预检')}
                  description={t('settingsPage.shadowPrecheckDesc', '写入前跑 py_compile / JSON / LSP 等本地检查；关闭则与旧行为一致')}
                  control={
                    <Switch
                      id="shadow-precheck"
                      checked={shadowPrecheck}
                      onCheckedChange={toggleShadowPrecheck}
                      disabled={shadowMode === 'off'}
                    />
                  }
                />
              </SettingGroup>
            </SettingSection>
          )}

          {active === 'memory' && (
            <SettingSection
              title={t('settingsPage.tabs.memory')}
              description={t('settingsPage.memorySectionDesc')}
            >
              {saveError && (
                <div className="mb-2 text-xs text-destructive">{saveError}</div>
              )}
              <SettingGroup>
                <SettingRow
                  htmlFor="memory-enabled"
                  icon={Brain}
                  title={t('settingsPage.memoryToggleTitle')}
                  description={t('settingsPage.memoryToggleDesc')}
                  control={
                    <Switch
                      id="memory-enabled"
                      checked={memoryEnabled}
                      onCheckedChange={toggleMemory}
                      aria-label={t('settingsPage.memoryToggleAria')}
                    />
                  }
                />
              </SettingGroup>
              <MemorySettings />
              <MemoryDiagnostics view="memory" />
            </SettingSection>
          )}

          {active === 'context' && (
            <SettingSection
              title={t('settingsPage.tabs.context')}
              description={t('settingsPage.contextSectionDesc')}
            >
              <MemoryDiagnostics view="context" />
              <WikiClaims />
            </SettingSection>
          )}

          {active === 'hooks' && (
            <SettingSection
              title={t('settingsPage.tabs.hooks')}
              description={t('settingsPage.hooks.desc', 'Extend agent behaviour with lifecycle hooks — inject context, deny tool calls, or react to events. Configured via hooks.json.')}
            >
              <HooksSettings />
            </SettingSection>
          )}
        </div>
      </div>
    </div>
  )
}
