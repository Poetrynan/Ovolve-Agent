import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSkillStore } from '@store/skillStore'
import { usePluginStore } from '@store/pluginStore'
import {
  Plus,
  Package,
  ShieldCheck,
  Search,
  ShieldAlert,
  Loader2,
  AlertTriangle,
  XCircle,
  Sparkles,
  FolderOpen,
  RotateCcw,
  FileCode,
  UploadCloud,
  CheckCircle2,
  Store,
  Download,
  Trash2,
  ChevronDown,
  ChevronRight,
  X,
  Plug,
  Blocks,
  Github,
  ExternalLink,
  Archive,
  Scale,
} from 'lucide-react'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Badge } from '@components/ui/badge'
import { Switch } from '@components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@components/ui/dialog'
import { cn } from '@/lib/utils'
import { readGate } from '@/lib/gateReport'
import { API_BASE, apiFetch } from '@lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

interface VetFinding {
  severity: string
  ruleId: string
  line: number
  matched: string
  reasonEn: string
  reasonZh: string
}

interface VetResult {
  level: string
  findings: VetFinding[]
}

interface SkillCandidate {
  id: string
  name: string
  description?: string
  status?: string
  version?: string
  experience_ref?: string
  gate_report?: Record<string, unknown>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 目录条目把上游钉在固定 commit 上，所以链接指向的是那个 commit 而不是 main ——
 * 用户点进去看到的就是我们实际核对过许可证的那份代码，不是上游后来改成什么样。
 */
function sourceUrl(item: any): string | undefined {
  const repo = String(item?.source || '')
  if (!repo) return undefined
  const base = `https://${repo}`
  const sha = String(item?.commitSha || '')
  if (sha && item?.skillPath) return `${base}/tree/${sha}/${item.skillPath}`
  if (sha) return `${base}/tree/${sha}`
  return base
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function SkillsPage({
  embedded = false,
  openImportTrigger = 0,
}: { embedded?: boolean; openImportTrigger?: number }) {
  const { t, i18n } = useTranslation()
  const { skills, fetchSkills, importSkill, enableSkill, disableSkill, uninstallSkill, getSkillDetail } = useSkillStore()
  const { plugins, fetchPlugins } = usePluginStore()

  useEffect(() => {
    void fetchPlugins()
  }, [fetchPlugins])

  // ── Dialog state ──
  const [importOpen, setImportOpen] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [vetResult, setVetResult] = useState<VetResult | null>(null)
  const [vetting, setVetting] = useState(false)
  const [vetError, setVetError] = useState('')
  const [pendingPath, setPendingPath] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  // 能力页顶部的「导入技能」按钮：点击被变成一个自增计数器传进来，
  // 这里翻译成"打开导入对话框"。用计数器而非 boolean，才能连点第二次。
  useEffect(() => {
    if (openImportTrigger > 0) setImportOpen(true)
  }, [openImportTrigger])

  // ── View state ──
  const [activeView, setActiveView] = useState<'installed' | 'marketplace'>('installed')
  const [searchQuery, setSearchQuery] = useState('')
  const [marketCategory, setMarketCategory] = useState<string>('all')
  const [marketType, setMarketType] = useState<string>('all')
  const [marketplaceList, setMarketplaceList] = useState<any[]>([])
  const [marketLoading, setMarketLoading] = useState<boolean>(false)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [marketError, setMarketError] = useState<string | null>(null)
  const [mcpServers, setMcpServers] = useState<any[]>([])

  const fetchMcpServers = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/api/mcp/servers`)
      if (res.ok) {
        const data = await res.json()
        setMcpServers(data.servers || [])
      }
    } catch {}
  }

  useEffect(() => {
    void fetchMcpServers()
  }, [])

  // ── Detail / Delete ──
  const [selectedSkill, setSelectedSkill] = useState<any | null>(null)
  const [loadingDetail, setLoadingDetail] = useState<boolean>(false)
  const [skillToDelete, setSkillToDelete] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState<boolean>(false)

  // ── Data handlers ──

  const handleOpenDetail = async (skill: any) => {
    setSelectedSkill(skill)
    setLoadingDetail(true)
    try {
      const cleanName = (skill.name || skill.id || '').replace(/^#/, '').trim()
      const detail = await getSkillDetail(cleanName)
      if (detail) {
        setSelectedSkill((prev: any) => ({ ...prev, ...detail }))
      }
    } finally {
      setLoadingDetail(false)
    }
  }

  const handleConfirmUninstall = async () => {
    if (!skillToDelete) return
    setUninstalling(true)
    try {
      const ok = await uninstallSkill(skillToDelete)
      if (ok) {
        await fetchSkills()
        if (activeView === 'marketplace') {
          void fetchMarketplace(marketCategory, searchQuery, marketType)
        }
        if (selectedSkill?.name === skillToDelete || selectedSkill?.id === skillToDelete) {
          setSelectedSkill(null)
        }
        setSkillToDelete(null)
      }
    } finally {
      setUninstalling(false)
    }
  }

  const fetchMarketplace = async (cat?: string, q?: string, type?: string) => {
    setMarketLoading(true)
    setMarketError(null)
    try {
      const c = cat !== undefined ? cat : marketCategory
      const query = q !== undefined ? q : searchQuery
      const tFilter = type !== undefined ? type : marketType
      const qs = new URLSearchParams()
      if (c && c !== 'all') qs.set('category', c)
      if (query) qs.set('q', query)
      if (tFilter && tFilter !== 'all') qs.set('type', tFilter)
      const res = await apiFetch(`${API_BASE}/api/skills/marketplace?${qs.toString()}`)
      if (res.ok) {
        const d = await res.json()
        setMarketplaceList(d.catalog || [])
      }
    } catch (e: any) {
      setMarketError(e?.message || '获取扩展市场失败')
    } finally {
      setMarketLoading(false)
    }
  }

  useEffect(() => {
    if (activeView === 'marketplace') {
      void fetchMarketplace(marketCategory, searchQuery, marketType)
    }
  }, [activeView, marketCategory, marketType])

  const handleInstallMarketSkill = async (item: any) => {
    setInstallingId(item.id)
    setMarketError(null)
    try {
      const res = await apiFetch(`${API_BASE}/api/skills/marketplace/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_id: item.id }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        throw new Error(data.error || '安装失败')
      }
      if (item.type === 'plugin') {
        await fetchPlugins()
      } else if (item.type === 'mcp') {
        await fetchMcpServers()
      } else {
        await fetchSkills()
      }
    } catch (e: any) {
      setMarketError(e?.message || '安装扩展失败')
    } finally {
      setInstallingId(null)
    }
  }

  // ── 从 GitHub 直接安装 ──
  // 目录里只收录了我们逐个核对过许可证的条目；用户想装的仓库不在目录里时，
  // 走这条路。它不绕过任何一道闸 —— 后端仍会做同样的合规校验与信任分级。
  const [ghOpen, setGhOpen] = useState(false)
  const [ghRepo, setGhRepo] = useState('')
  const [ghPath, setGhPath] = useState('')
  const [ghBusy, setGhBusy] = useState(false)
  const [ghError, setGhError] = useState('')

  const handleInstallFromGithub = async () => {
    const repo = ghRepo.trim()
    const skillPath = ghPath.trim()
    if (!repo || !skillPath) {
      setGhError('仓库与技能路径都要填')
      return
    }
    setGhBusy(true)
    setGhError('')
    try {
      const res = await apiFetch(`${API_BASE}/api/skills/marketplace/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: repo, skillPath }),
      })
      const data = await res.json()
      if (!res.ok || (!data.ok && !data.installed)) {
        throw new Error(data.error || '安装失败')
      }
      await fetchSkills()
      setGhOpen(false)
      setGhRepo('')
      setGhPath('')
    } catch (e: any) {
      setGhError(e?.message || '从 GitHub 安装失败')
    } finally {
      setGhBusy(false)
    }
  }

  const handlePickDirectory = async () => {
    try {
      const p = await window.electronAPI?.invoke('file:pickDirectory')
      if (p) {
        setImportPath(p)
        setVetError('')
      }
    } catch {
      // ignore
    }
  }

  const handlePickFile = async () => {
    try {
      const p = await window.electronAPI?.invoke('file:pickFile', [
        { name: 'Skills & Plugins (*.md, *.py, *.json, *.yaml)', extensions: ['md', 'py', 'json', 'yaml', 'yml'] },
        { name: 'All Files (*.*)', extensions: ['*'] },
      ])
      if (p) {
        setImportPath(p)
        setVetError('')
      }
    } catch {
      // ignore
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && (file as any).path) {
      setImportPath((file as any).path)
      setVetError('')
    }
  }

  useEffect(() => {
    void fetchSkills()
  }, [fetchSkills])

  const handleImport = async () => {
    const path = importPath.trim()
    if (!path) return
    setVetting(true)
    setVetError('')
    try {
      const r = await apiFetch(`${API_BASE}/api/skills/vet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      if (!r.ok) {
        setVetError(t('skillVetter.scanFailed'))
        setVetting(false)
        return
      }
      const result: VetResult = await r.json()
      setVetting(false)
      if (result.level === 'LOW') {
        await importSkill(path, 'untrusted')
        setImportPath('')
        setImportOpen(false)
        return
      }
      setPendingPath(path)
      setVetResult(result)
      setImportOpen(false)
    } catch {
      setVetError(t('skillVetter.scanFailed'))
      setVetting(false)
    }
  }

  const proceedInstall = async () => {
    if (!pendingPath) return
    await importSkill(pendingPath, 'untrusted')
    setImportPath('')
    setPendingPath('')
    setVetResult(null)
  }

  const cancelInstall = () => {
    setPendingPath('')
    setVetResult(null)
  }

  // ── Derived data ──

  const filteredSkills = skills.filter((s: any) =>
    (s.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (s.description || '').toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const enabledCount = skills.filter((s: any) => s.status !== 'disabled').length

  const handleMarketSearch = () => {
    if (activeView === 'marketplace') {
      void fetchMarketplace(marketCategory, searchQuery)
    }
  }

  // ── Render ──

  return (
    <div className={cn(
      'space-y-4',
      !embedded && 'container mx-auto py-8 px-4 max-w-5xl animate-fade-in',
    )}>
      {/* Standalone header (non-embedded only) */}
      {!embedded && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/40">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-foreground/10 text-foreground border border-border/40 shadow-xs">
                <Sparkles size={22} className="stroke-[2.2]" />
              </div>
              <h1 className="text-2xl sm:text-3xl font-heading font-extrabold tracking-tight text-foreground">
                {t('skillsPage.title')}
              </h1>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 ml-1">
              {t('skillsPage.subtitle')}
            </p>
          </div>
        </div>
      )}

      {/* ── Unified Toolbar: Search + View Toggle + Actions ── */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
        {/* Search input */}
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleMarketSearch()}
            placeholder={activeView === 'installed' ? '按名称或描述搜索已安装技能...' : '搜索技能市场...'}
            className="pl-9 pr-8 rounded-xl bg-card/70 backdrop-blur-md border-border/50 text-xs h-9 shadow-2xs"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* View toggle pill */}
        <div className="flex items-center p-0.5 rounded-xl bg-muted/40 border border-border/40 shrink-0">
          <button
            type="button"
            onClick={() => setActiveView('installed')}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all select-none cursor-pointer whitespace-nowrap',
              activeView === 'installed'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            已安装 ({skills.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveView('marketplace')
              void fetchMarketplace()
            }}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all select-none cursor-pointer whitespace-nowrap flex items-center gap-1.5',
              activeView === 'marketplace'
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Store className="w-3.5 h-3.5" />
            市场
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={() => {
              if (activeView === 'installed') void fetchSkills()
              else void fetchMarketplace(marketCategory, searchQuery)
            }}
            variant="outline"
            size="sm"
            className="rounded-xl px-2.5 h-8 text-xs border-border/50 bg-card/70 hover:bg-card text-muted-foreground hover:text-foreground shadow-2xs"
            title="刷新"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </Button>
          <Button
            onClick={() => {
              setVetError('')
              setImportOpen(true)
            }}
            size="sm"
            className="rounded-xl px-3.5 h-8 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs gap-1.5 select-none"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>导入技能</span>
          </Button>
        </div>
      </div>

      {/* ── Installed View ── */}
      {activeView === 'installed' ? (
        <div className="space-y-3">
          {/* Stats bar */}
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] text-muted-foreground font-mono">
              {t('skillsPage.enabledCount', { enabled: enabledCount, total: skills.length })}
            </span>
          </div>

          {/* Candidates Section (only when candidates exist) */}
          <CandidatesSection />

          {/* Installed Skills — compact row list */}
          {filteredSkills.length === 0 ? (
            <div className="text-center py-16 px-4 rounded-2xl border border-dashed border-border/60 bg-card/30 space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-foreground/5 flex items-center justify-center mx-auto text-foreground">
                <Package className="w-6 h-6" />
              </div>
              <h4 className="text-sm font-bold text-foreground">
                {searchQuery ? t('skillsPage.emptyTitle') : '暂无已加载的技能'}
              </h4>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                {searchQuery
                  ? '尝试更换搜索词，或导入自定义的 Agent 技能插件'
                  : '点击右侧「导入技能」按钮，输入 SKILL.md 或 Python 插件路径即可快速挂载'}
              </p>
              <Button
                onClick={() => {
                  setVetError('')
                  setImportOpen(true)
                }}
                size="sm"
                className="rounded-xl px-4 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs gap-1.5 mt-2"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>导入技能</span>
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(288px,100%),1fr))] gap-3.5">
              {filteredSkills.map((skill: any) => {
                const isEnabled = skill.status !== 'disabled'
                const parentPlugin = plugins.find((p: any) => p.skills?.includes(skill.name))
                return (
                  <SkillCard
                    key={skill.id || skill.name}
                    skill={skill}
                    parentPlugin={parentPlugin}
                    isEnabled={isEnabled}
                    onToggle={(checked) =>
                      checked ? enableSkill(skill.name) : disableSkill(skill.name)
                    }
                    onDetail={() => handleOpenDetail(skill)}
                    onDelete={() => setSkillToDelete(skill.name)}
                  />
                )
              })}
            </div>
          )}
        </div>
      ) : (
        /* ── Marketplace View ── */
        <div className="space-y-3">
          {/* Two-Tier Filters: Level 1 Type Pills + Level 2 Category Chips */}
          <div className="space-y-2.5 p-3 rounded-2xl bg-card/50 border border-border/40 backdrop-blur-md">
            {/* Level 1: Extension Type Segmented Control */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
              <span className="text-[11px] font-medium text-muted-foreground mr-1 shrink-0">扩展类型:</span>
              {[
                { id: 'all', label: '全部生态', icon: Store },
                { id: 'skill', label: '技能 Skills', icon: Sparkles },
                { id: 'plugin', label: '插件 Plugins', icon: Blocks },
                { id: 'mcp', label: '连接器 MCP', icon: Plug },
              ].map(tType => {
                const IconComp = tType.icon
                const active = marketType === tType.id
                return (
                  <button
                    key={tType.id}
                    type="button"
                    onClick={() => setMarketType(tType.id)}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 border transition-all select-none cursor-pointer',
                      active
                        ? 'bg-foreground text-background border-foreground shadow-xs'
                        : 'bg-background/80 border-border/60 text-muted-foreground hover:text-foreground hover:bg-background'
                    )}
                  >
                    <IconComp className="w-3.5 h-3.5" />
                    <span>{tType.label}</span>
                  </button>
                )
              })}

              <button
                type="button"
                onClick={() => { setGhError(''); setGhOpen(true) }}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 border border-border/60 bg-background/80 text-muted-foreground hover:text-foreground hover:bg-background transition-all select-none cursor-pointer"
                title="目录外的开源仓库也能装，安装前同样要做合规校验"
              >
                <Github className="w-3.5 h-3.5" />
                <span>从 GitHub 安装</span>
              </button>
            </div>

            {/* Level 2: Domain Category Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto pt-1 border-t border-border/30 scrollbar-none">
              <span className="text-[10.5px] text-muted-foreground/80 mr-1 shrink-0 font-mono">领域分类:</span>
              {[
                { id: 'all', label: '全部领域' },
                { id: 'development', label: '开发工程' },
                { id: 'architecture', label: '架构与 UI' },
                { id: 'analysis', label: '数据分析' },
                { id: 'content', label: '内容创作' },
                { id: 'system', label: '系统环境' },
              ].map(cat => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setMarketCategory(cat.id)}
                  className={cn(
                    'px-2 py-0.5 rounded-lg text-[10.5px] font-medium shrink-0 border transition-colors select-none cursor-pointer',
                    marketCategory === cat.id
                      ? 'bg-muted text-foreground font-semibold border-border shadow-2xs'
                      : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40'
                  )}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {marketError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{marketError}</span>
            </div>
          )}

          {/* Marketplace list — 288px Grid */}
          {marketLoading ? (
            <div className="py-16 text-center text-muted-foreground flex flex-col items-center justify-center gap-2">
              <Loader2 className="w-6 h-6 animate-spin text-foreground" />
              <span className="text-xs">加载扩展市场...</span>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(288px,100%),1fr))] gap-3.5">
              {marketplaceList.map(item => {
                const itemType = item.type || 'skill'
                const isInstalled = itemType === 'plugin'
                  ? plugins.some((p: any) => p.name === item.name || p.name === item.id)
                  : itemType === 'mcp'
                  ? mcpServers.some((s: any) => s.name === item.name || s.name === item.id)
                  : skills.some((s: any) => s.name === item.name || s.id === item.id)

                const isInstalling = installingId === item.id

                return (
                  <div
                    key={item.id}
                    onClick={() => handleOpenDetail(item)}
                    className="flex flex-col justify-between p-4 rounded-2xl border border-border bg-card shadow-2xs hover:shadow-xs hover:border-foreground/30 transition-all cursor-pointer group min-h-[145px]"
                  >
                    <div className="space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className={cn(
                            'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 shadow-2xs',
                            itemType === 'mcp'
                              ? 'bg-sky-500/10 border-sky-500/25 text-sky-600 dark:text-sky-400'
                              : itemType === 'plugin'
                              ? 'bg-purple-500/10 border-purple-500/25 text-purple-600 dark:text-purple-400'
                              : 'bg-muted border-border text-foreground'
                          )}>
                            {itemType === 'mcp' ? (
                              <Plug className="w-4.5 h-4.5" />
                            ) : itemType === 'plugin' ? (
                              <Blocks className="w-4.5 h-4.5" />
                            ) : (
                              <Package className="w-4.5 h-4.5" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="text-sm font-semibold text-foreground truncate group-hover:text-foreground transition-colors block">
                              {item.title || item.name}
                            </span>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              <Badge variant="outline" className={cn(
                                'text-[9px] px-1.5 py-0 shrink-0 font-semibold',
                                itemType === 'mcp'
                                  ? 'bg-sky-500/10 border-sky-500/25 text-sky-600 dark:text-sky-400'
                                  : itemType === 'plugin'
                                  ? 'bg-purple-500/10 border-purple-500/25 text-purple-600 dark:text-purple-400'
                                  : 'bg-muted border-border text-muted-foreground'
                              )}>
                                {itemType === 'mcp' ? 'MCP 连接器' : itemType === 'plugin' ? '插件' : '技能'}
                              </Badge>
                              {item.category && (
                                <span className="text-[10px] text-muted-foreground/70 font-mono">
                                  {item.category}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                          {isInstalled ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-xl border border-emerald-500/25">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              已安装
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              disabled={isInstalling || item.provenance === 'unknown'}
                              title={item.provenance === 'unknown' ? '来源与许可证未核实，不可安装' : undefined}
                              onClick={() => handleInstallMarketSkill(item)}
                              className="h-7.5 rounded-xl px-3 text-[11px] font-semibold shadow-2xs cursor-pointer bg-foreground text-background hover:bg-foreground/90"
                            >
                              {isInstalling ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                              ) : (
                                <Download className="w-3.5 h-3.5 mr-1" />
                              )}
                              <span>{isInstalling ? '处理中' : itemType === 'mcp' ? '一键接入' : '一键安装'}</span>
                            </Button>
                          )}
                        </div>
                      </div>

                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 min-h-[32px]">
                        {item.description}
                      </p>
                    </div>

                    {/* 卡片底部只放真实信息：许可证、上游是否已归档、钉住的 commit。
                        星数是编不出来的，编出来的那几个数字已经从目录里删掉了。 */}
                    <div className="pt-2 border-t border-border/30 flex items-center justify-between gap-2 text-[10px] font-mono">
                      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                        {item.license ? (
                          <a
                            href={item.licenseSource || undefined}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-muted/60 border border-border/50 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <Scale className="w-3 h-3" />
                            {String(item.license).split(' (')[0]}
                            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                          </a>
                        ) : null}
                        {item.archived ? (
                          <span
                            title="上游仓库已归档：代码还能用，但已经没人维护了"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-400"
                          >
                            <Archive className="w-3 h-3" />
                            已归档
                          </span>
                        ) : null}
                        {item.commitSha ? (
                          <span
                            title={`上游已钉死在 commit ${item.commitSha}`}
                            className="text-muted-foreground/70"
                          >
                            @{String(item.commitSha).slice(0, 7)}
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[10px] text-muted-foreground/70 truncate max-w-[110px] shrink-0">
                        {item.author}
                      </span>
                    </div>
                  </div>
                )
              })}
              {!marketLoading && marketplaceList.length === 0 && (
                <div className="py-12 text-center text-xs text-muted-foreground col-span-full">
                  暂无匹配的扩展内容
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Install from GitHub Dialog ── */}
      <Dialog open={ghOpen} onOpenChange={(open) => { if (!ghBusy) setGhOpen(open) }}>
        <DialogContent className="sm:max-w-lg rounded-2xl p-5">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Github className="w-4 h-4" />
              从 GitHub 仓库安装技能
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              目录之外的开源仓库也能装。后端跑的是同一套合规校验与信任分级，
              不会因为「不在目录里」就放行。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">仓库（owner/repo）</span>
              <Input
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                placeholder="wshobson/agents"
                className="h-9 text-xs font-mono"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                技能路径（仓库内 SKILL.md 所在目录）
              </span>
              <Input
                value={ghPath}
                onChange={(e) => setGhPath(e.target.value)}
                placeholder="skills/academic-search"
                className="h-9 text-xs font-mono"
              />
            </div>
            {ghError ? (
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{ghError}</span>
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={ghBusy}
              onClick={() => setGhOpen(false)}
              className="rounded-xl text-xs"
            >
              取消
            </Button>
            <Button
              size="sm"
              disabled={ghBusy}
              onClick={() => void handleInstallFromGithub()}
              className="rounded-xl text-xs font-semibold"
            >
              {ghBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <Download className="w-3.5 h-3.5 mr-1" />
              )}
              安装
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Import Skill Dialog ── */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-xl rounded-2xl p-6">
          <DialogHeader className="space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <DialogTitle className="text-base font-bold text-foreground">
                {t('skillsPage.importSection')}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground leading-relaxed">
              支持直接浏览选择本地技能文件夹、SKILL.md 文件或 Python 插件。导入前将自动执行 AST 语法分析与沙箱合规审查。
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-4">
            {/* Direct Folder / File Action Cards */}
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handlePickDirectory}
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-dashed border-border hover:border-foreground/40 bg-card hover:bg-muted/40 transition-all group cursor-pointer text-center shadow-2xs"
              >
                <div className="w-10 h-10 rounded-xl bg-muted text-foreground flex items-center justify-center group-hover:scale-105 transition-transform border border-border">
                  <FolderOpen className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-bold text-foreground">选择技能文件夹</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">导入包含 SKILL.md 的目录</div>
                </div>
              </button>

              <button
                type="button"
                onClick={handlePickFile}
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-dashed border-border hover:border-foreground/40 bg-card hover:bg-muted/40 transition-all group cursor-pointer text-center shadow-2xs"
              >
                <div className="w-10 h-10 rounded-xl bg-muted text-foreground flex items-center justify-center group-hover:scale-105 transition-transform border border-border">
                  <FileCode className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-bold text-foreground">选择单文件</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">SKILL.md / .py 插件文件</div>
                </div>
              </button>
            </div>

            {/* Drag & Drop Area / Path preview */}
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={cn(
                'p-3 rounded-xl border transition-all text-xs space-y-1.5',
                isDragging
                  ? 'border-foreground bg-muted/40'
                  : 'border-border bg-muted/25',
              )}
            >
              <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>已选路径（支持直接拖入文件/文件夹，亦可手动修改）：</span>
                </span>
                {importPath && (
                  <button
                    type="button"
                    onClick={() => setImportPath('')}
                    className="text-muted-foreground hover:text-foreground text-[11px] underline cursor-pointer"
                  >
                    清空
                  </button>
                )}
              </div>
              <Input
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                placeholder="点击上方按钮选择，或在此粘贴/输入路径..."
                onKeyDown={(e) => e.key === 'Enter' && handleImport()}
                className="rounded-lg bg-background border-border/60 text-xs h-9 font-mono"
              />
            </div>

            {vetError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-600 dark:text-rose-400 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{vetError}</span>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(false)}
              className="rounded-xl text-xs"
            >
              取消
            </Button>
            <Button
              size="sm"
              onClick={handleImport}
              disabled={!importPath.trim() || vetting}
              className="rounded-xl px-4 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 gap-1.5 shadow-xs"
            >
              {vetting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t('skillVetter.scanning')}</span>
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  <span>导入技能</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Skill Vetter Safety Modal ── */}
      {vetResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col overflow-hidden">
            <div className="p-5 border-b border-border/40 space-y-1">
              <div className="flex items-center gap-2">
                <ShieldAlert className={cn(
                  'w-5 h-5',
                  vetResult.level === 'EXTREME' || vetResult.level === 'HIGH' ? 'text-rose-500' : 'text-amber-500',
                )} />
                <h2 className="text-base font-bold text-foreground">{t('skillVetter.title')}</h2>
                <Badge variant="outline" className={cn(
                  'ml-auto text-[10px] font-bold rounded-lg',
                  vetResult.level === 'EXTREME' || vetResult.level === 'HIGH'
                    ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/40'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40',
                )}>
                  {t(`skillVetter.level.${vetResult.level}`)}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t(`skillVetter.levelDesc.${vetResult.level}`)}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
              {vetResult.findings.map((f, i) => (
                <div key={i} className={cn(
                  'p-3 rounded-xl border text-xs space-y-1',
                  f.severity === 'EXTREME' || f.severity === 'HIGH'
                    ? 'bg-rose-500/5 border-rose-500/30'
                    : 'bg-amber-500/5 border-amber-500/30',
                )}>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <XCircle className={cn(
                      'w-3.5 h-3.5 shrink-0',
                      f.severity === 'EXTREME' || f.severity === 'HIGH' ? 'text-rose-500' : 'text-amber-500',
                    )} />
                    <span className="font-mono text-[10px]">{t('skillVetter.line', { n: f.line })}</span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0">
                      {t(`skillVetter.level.${f.severity}`)}
                    </Badge>
                  </div>
                  <p className="text-foreground/90 leading-relaxed">
                    {i18n.language.startsWith('zh') ? f.reasonZh : f.reasonEn}
                  </p>
                  {f.matched && (
                    <code className="block text-[10px] text-muted-foreground bg-muted/40 rounded-lg p-2 overflow-x-auto whitespace-pre font-mono">
                      {f.matched}
                    </code>
                  )}
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-border/40 flex justify-end gap-2.5">
              <Button variant="outline" size="sm" onClick={cancelInstall} className="rounded-xl text-xs">
                {t('skillVetter.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={proceedInstall}
                className="rounded-xl text-xs font-semibold"
              >
                <ShieldAlert className="w-3.5 h-3.5 mr-1.5" />
                {t('skillVetter.proceedAnyway')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Skill Detail Dialog ── */}
      <Dialog open={!!selectedSkill} onOpenChange={(open) => !open && setSelectedSkill(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col rounded-2xl p-0 overflow-hidden">
          <DialogHeader className="p-5 pb-3 border-b border-border/40">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-muted text-foreground border border-border flex items-center justify-center shrink-0">
                  <Package className="w-5 h-5" />
                </div>
                <div>
                  <DialogTitle className="text-base font-bold text-foreground flex items-center gap-2">
                    <span>{selectedSkill?.title || selectedSkill?.name}</span>
                    <span className="font-mono text-xs font-normal text-muted-foreground">#{selectedSkill?.name}</span>
                  </DialogTitle>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {selectedSkill?.category && (
                      <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground border-border">
                        {selectedSkill.category}
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-[10px] font-mono">
                      {selectedSkill?.declaredVersion || (selectedSkill?.version ? `v${selectedSkill.version.slice(0, 8)}` : 'v1.0.0')}
                    </Badge>
                    {selectedSkill?.author && (
                      <span className="text-[11px] text-muted-foreground">作者: {selectedSkill.author}</span>
                    )}
                    {selectedSkill?.source ? (
                      <a
                        href={sourceUrl(selectedSkill)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground font-mono transition-colors"
                      >
                        <Github className="w-3 h-3" />
                        {selectedSkill.source}
                        <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
            {/* Description */}
            <div className="space-y-1">
              <h5 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">技能简介与应用场景</h5>
              <p className="text-xs text-foreground/90 leading-relaxed bg-muted/30 p-3 rounded-xl border border-border/40">
                {selectedSkill?.description || '暂无详细描述'}
              </p>
            </div>

            {/* 来源与许可 —— 装之前让用户看清这东西是谁写的、什么许可证、钉在哪个 commit */}
            {(selectedSkill?.source || selectedSkill?.license) && (
              <div className="space-y-1.5">
                <h5 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  来源与许可
                </h5>
                <div className="bg-muted/30 p-3 rounded-xl border border-border/40 space-y-2">
                  {selectedSkill?.source ? (
                    <div className="flex items-start gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">上游仓库</span>
                      <a
                        href={sourceUrl(selectedSkill)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-foreground hover:underline break-all inline-flex items-center gap-1"
                      >
                        {selectedSkill.source}
                        {selectedSkill.skillPath ? (
                          <span className="text-muted-foreground">/{selectedSkill.skillPath}</span>
                        ) : null}
                        <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                      </a>
                    </div>
                  ) : null}
                  {selectedSkill?.license ? (
                    <div className="flex items-start gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">许可证</span>
                      {selectedSkill.licenseSource ? (
                        <a
                          href={selectedSkill.licenseSource}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground hover:underline inline-flex items-center gap-1"
                        >
                          {selectedSkill.license}
                          <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                        </a>
                      ) : (
                        <span className="text-foreground">{selectedSkill.license}</span>
                      )}
                    </div>
                  ) : null}
                  {selectedSkill?.commitSha ? (
                    <div className="flex items-start gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">钉住版本</span>
                      <span className="font-mono text-foreground break-all" title="上游再改动也不会自动生效">
                        {selectedSkill.commitSha}
                      </span>
                    </div>
                  ) : null}
                  {selectedSkill?.archived ? (
                    <div className="flex items-start gap-2 pt-1 border-t border-border/30">
                      <Archive className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                      <span className="text-amber-600 dark:text-amber-400 leading-relaxed">
                        上游仓库已归档：代码仍然可用，但已经没有人在维护它，出问题不会有人修。
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {/* Triggers */}
            {selectedSkill?.triggers && selectedSkill.triggers.length > 0 && (
              <div className="space-y-1.5">
                <h5 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">触发关键词 (Triggers)</h5>
                <div className="flex flex-wrap gap-1.5">
                  {selectedSkill.triggers.map((trig: string) => (
                    <span key={trig} className="px-2 py-0.5 rounded-lg bg-card border border-border/60 font-mono text-[10.5px] text-foreground">
                      {trig}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Full Body / Markdown Prompt Instructions */}
            <div className="space-y-1.5">
              <h5 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                指令规范 (SKILL.md 内容)
              </h5>
              {loadingDetail ? (
                <div className="py-8 text-center text-muted-foreground flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-foreground" />
                  <span>加载技能指令文档...</span>
                </div>
              ) : selectedSkill?.body ? (
                <div className="bg-muted/40 rounded-xl p-3.5 border border-border/40 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
                  {selectedSkill.body}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground bg-muted/20 p-3 rounded-xl flex items-center justify-between">
                  <span>{selectedSkill?.path ? '正在从本地磁盘载入 SKILL.md...' : '未载入指令正文'}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px] rounded-lg"
                    onClick={() => void handleOpenDetail(selectedSkill)}
                  >
                    重试加载
                  </Button>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="p-4 border-t border-border/40 flex items-center justify-between sm:justify-between bg-card/40">
            <div className="flex items-center gap-2">
              {skills.some((s: any) => s.name === selectedSkill?.name) ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    const name = selectedSkill?.name
                    setSelectedSkill(null)
                    setSkillToDelete(name)
                  }}
                  className="rounded-xl text-xs gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>卸载此技能</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    void handleInstallMarketSkill(selectedSkill)
                  }}
                  disabled={installingId === selectedSkill?.id}
                  className="rounded-xl text-xs font-semibold gap-1.5 bg-primary text-primary-foreground"
                >
                  {installingId === selectedSkill?.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  <span>{installingId === selectedSkill?.id ? '安装中...' : '一键安装到本地'}</span>
                </Button>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedSkill(null)}
              className="rounded-xl text-xs"
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Dialog ── */}
      <Dialog open={!!skillToDelete} onOpenChange={(open) => !open && setSkillToDelete(null)}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <div className="flex items-center gap-2 text-amber-500">
              <AlertTriangle className="w-5 h-5" />
              <DialogTitle className="text-sm font-bold text-foreground">从 AI 运行时卸载技能</DialogTitle>
            </div>
            <div className="text-xs text-muted-foreground mt-2 leading-relaxed space-y-2">
              <p>
                确定要停用并卸载技能 <span className="font-mono font-bold text-foreground">"{skillToDelete}"</span> 吗？
              </p>
              <div className="p-2.5 rounded-xl bg-muted/40 border border-border/50 text-xs leading-relaxed space-y-1.5">
                <div className="font-semibold text-foreground flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                  <span>安全卸载（不删除卡片）保障：</span>
                </div>
                <p className="text-muted-foreground">
                  此操作将把技能置为停用状态，AI 模型与触发器将完全不再感知与调用它。
                  <strong>该技能卡片仍会保留在列表中</strong>，您可以随时通过开关一键重新启用。
                </p>
              </div>
              {(() => {
                const parent = plugins.find((p: any) => p.skills?.includes(skillToDelete || ''))
                if (parent) {
                  return (
                    <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/25 text-purple-600 dark:text-purple-400 text-[11px] leading-relaxed">
                      提示：此技能随插件 <strong>「{parent.name}」</strong> 分发。
                    </div>
                  )
                }
                return null
              })()}
            </div>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSkillToDelete(null)}
              disabled={uninstalling}
              className="rounded-xl text-xs"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirmUninstall}
              disabled={uninstalling}
              className="rounded-xl text-xs font-semibold gap-1"
            >
              {uninstalling ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Trash2 className="w-3.5 h-3.5 mr-1" />}
              <span>{uninstalling ? '正在卸载...' : '确认卸载（停用）'}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── 288px Responsive Skill Card ───────────────────────────────────
// Self-adapting 288px width, 16px radius, provenance badge, trigger keywords

function SkillCard({
  skill,
  parentPlugin,
  isEnabled,
  onToggle,
  onDetail,
  onDelete,
}: {
  skill: any
  parentPlugin?: any
  isEnabled: boolean
  onToggle: (checked: boolean) => void
  onDetail: () => void
  onDelete: () => void
}) {
  const isBuiltin = skill.trust === 'own'

  return (
    <div
      onClick={onDetail}
      className={cn(
        'flex flex-col justify-between p-4 rounded-2xl border transition-all duration-200 cursor-pointer group bg-card shadow-2xs hover:shadow-xs min-h-[145px]',
        isEnabled
          ? 'border-border hover:border-foreground/30'
          : 'border-border/40 opacity-60 bg-muted/20',
      )}
    >
      <div className="space-y-2">
        {/* Top: Icon + Name + Badges + Toggle */}
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={cn(
                'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border shadow-2xs',
                isEnabled
                  ? 'bg-muted border-border text-foreground'
                  : 'bg-muted border-border/40 text-muted-foreground',
              )}
            >
              <Package className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-bold text-foreground truncate group-hover:text-foreground transition-colors">
                {skill.name}
              </h4>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                {!isEnabled ? (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 rounded-md font-semibold bg-muted text-muted-foreground border-border/50"
                  >
                    已停用 (未接入 AI)
                  </Badge>
                ) : parentPlugin ? (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 rounded-md font-semibold bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/25"
                    title={`此技能随插件 ${parentPlugin.name} 分发`}
                  >
                    由插件提供
                  </Badge>
                ) : isBuiltin ? (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 rounded-md font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25"
                  >
                    Built-in
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1.5 py-0 rounded-md font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25"
                  >
                    Community
                  </Badge>
                )}
                {skill.version && (
                  <span className="text-[10px] font-mono text-muted-foreground/60">
                    v{skill.version.slice(0, 8)}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-1 pt-0.5" onClick={(e) => e.stopPropagation()}>
            <Switch checked={isEnabled} onCheckedChange={onToggle} />
            <button
              type="button"
              onClick={onDelete}
              aria-label="卸载技能"
              title={isEnabled ? "停用并从 AI 运行时卸载" : "已停用"}
              className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 min-h-[32px]">
          {skill.description || '暂无详细描述'}
        </p>
      </div>

      {/* Triggers preview */}
      <div className="pt-2 border-t border-border/30 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        {skill.triggers && skill.triggers.length > 0 ? (
          <div className="flex items-center gap-1 overflow-hidden">
            <span className="text-[10px] text-muted-foreground/60 shrink-0 font-mono">触发:</span>
            {skill.triggers.slice(0, 2).map((trig: string) => (
              <span key={trig} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/60 border border-border/30 truncate max-w-[95px]">
                {trig}
              </span>
            ))}
            {skill.triggers.length > 2 && (
              <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">+{skill.triggers.length - 2}</span>
            )}
          </div>
        ) : (
          <span className="text-[10px] font-mono text-muted-foreground/40">按需提示</span>
        )}
        <span className="text-[11px] text-muted-foreground group-hover:text-foreground font-medium shrink-0">
          详情 &rarr;
        </span>
      </div>
    </div>
  )
}

// ── Candidates Section ───────────────────────────────────────────────────────
// Only renders when candidates exist. Collapsible with amber left-border accent.

function statusBadgeCls(status?: string): string {
  switch (status) {
    case 'active': return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
    case 'staged': return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
    case 'degraded': return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30'
    case 'rejected': case 'archived': return 'bg-muted text-muted-foreground border-border'
    default: return 'bg-card text-muted-foreground border-border'
  }
}

function CandidatesSection() {
  const [rows, setRows] = useState<SkillCandidate[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [expanded, setExpanded] = useState(true)
  const [openGateId, setOpenGateId] = useState('')

  const load = async () => {
    try {
      const r = await apiFetch(`${API_BASE}/api/skills/candidates`)
      const data = await r.json()
      setRows(Array.isArray(data?.candidates) ? data.candidates : [])
    } catch { /* preserve existing list */ }
    setLoaded(true)
  }

  useEffect(() => { void load() }, [])

  const act = async (id: string, action: string) => {
    setBusy(id + action)
    try {
      const r = await apiFetch(`${API_BASE}/api/skills/candidates/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      await r.json()
      await load()
      if (action === 'approve' || action === 'rollback') {
        await useSkillStore.getState().fetchSkills()
      }
    } finally {
      setBusy('')
    }
  }

  // Hide entirely when no candidates
  if (loaded && rows.length === 0) return null

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-amber-500/10 transition-colors cursor-pointer"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        )}
        <Sparkles className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="text-xs font-semibold text-foreground">
          待审批 ({rows.length})
        </span>
        <span className="text-[11px] text-muted-foreground">
          学习环孵出的候选，门禁通过后需你批准才会上线
        </span>
      </button>

      {expanded && (
        <div className="divide-y divide-amber-500/15">
          {rows.map((c) => (
            <div key={c.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={cn('rounded-md text-[10px] font-mono', statusBadgeCls(c.status))}>
                  {c.status ?? 'candidate'}
                </Badge>
                <span className="text-sm font-semibold">{c.name}</span>
                {c.version ? (
                  <span className="text-[10px] font-mono text-muted-foreground">v{c.version.slice(0, 8)}</span>
                ) : null}
                <div className="ml-auto flex items-center gap-1.5">
                  {(c.status === 'candidate' || c.status === 'degraded' || c.status === 'rejected') && (
                    <Button size="sm" variant="outline" disabled={busy !== ''}
                      onClick={() => void act(c.id, 'promote')}
                      className="rounded-lg h-7 px-2.5 text-[11px] gap-1">
                      <ShieldCheck className="w-3 h-3" /> 门禁预检
                    </Button>
                  )}
                  {c.status === 'staged' && (
                    <>
                      <Button size="sm" variant="outline" disabled={busy !== ''}
                        onClick={() => void act(c.id, 'reject')}
                        className="rounded-lg h-7 px-2.5 text-[11px] text-muted-foreground hover:text-destructive">
                        <XCircle className="w-3 h-3" /> 拒绝
                      </Button>
                      <Button size="sm" disabled={busy !== ''}
                        onClick={() => void act(c.id, 'approve')}
                        className="rounded-lg h-7 px-3 text-[11px] font-semibold bg-foreground text-background hover:bg-foreground/90 gap-1">
                        <ShieldCheck className="w-3 h-3" /> 批准上线
                      </Button>
                    </>
                  )}
                  {c.status === 'active' && (
                    <Button size="sm" variant="outline" disabled={busy !== ''}
                      onClick={() => void act(c.id, 'rollback')}
                      className="rounded-lg h-7 px-2.5 text-[11px] text-muted-foreground hover:text-destructive gap-1">
                      <RotateCcw className="w-3 h-3" /> 回滚
                    </Button>
                  )}
                </div>
              </div>
              {c.description ? (
                <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{c.description}</p>
              ) : null}
              {c.gate_report && Object.keys(c.gate_report).length > 0 && (
                <div className="space-y-1">
                  <button type="button"
                    onClick={() => setOpenGateId(openGateId === c.id ? '' : c.id)}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1">
                    {openGateId === c.id ? (
                      <><ChevronDown className="w-3 h-3" /> 收起门禁报告</>
                    ) : (
                      <><ChevronRight className="w-3 h-3" /> 查看门禁报告</>
                    )}
                  </button>
                  {openGateId === c.id && (
                    <div className="rounded-lg border border-border/40 bg-background/40 p-2.5 space-y-1">
                      {Object.entries(c.gate_report).map(([gate, raw]) => {
                        const g = readGate(raw)
                        return (
                          <div key={gate} className="flex items-start gap-2 text-[11px]">
                            <span className={cn('font-mono font-semibold',
                              g.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                              g.tone === 'fail' && 'text-destructive',
                              g.tone === 'info' && 'text-muted-foreground')}>
                              {g.mark} {gate}
                            </span>
                            <span className="text-muted-foreground">{g.detail}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
