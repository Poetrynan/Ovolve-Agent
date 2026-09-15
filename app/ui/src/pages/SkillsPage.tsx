import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSkillStore } from '@store/skillStore'
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
  Brain,
  FileCode,
  UploadCloud,
  CheckCircle2,
} from 'lucide-react'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Card, CardContent } from '@components/ui/card'
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

export default function SkillsPage({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation()
  const { skills, fetchSkills, importSkill, enableSkill, disableSkill } = useSkillStore()
  const [importOpen, setImportOpen] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [vetResult, setVetResult] = useState<VetResult | null>(null)
  const [vetting, setVetting] = useState(false)
  const [vetError, setVetError] = useState('')
  const [pendingPath, setPendingPath] = useState('')
  const [isDragging, setIsDragging] = useState(false)

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

  const filteredSkills = skills.filter((s: any) =>
    (s.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (s.description || '').toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const enabledCount = skills.filter((s: any) => s.status !== 'disabled').length

  return (
    <div className={cn(
      'space-y-6',
      !embedded && 'container mx-auto py-8 px-4 max-w-5xl animate-fade-in',
    )}>
      {/* Header */}
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

          <div className="flex items-center gap-2.5 shrink-0">
            <Button
              onClick={() => {
                setVetError('')
                setImportOpen(true)
              }}
              size="sm"
              className="rounded-xl px-4 h-9 font-semibold text-xs bg-foreground text-background hover:bg-foreground/90 shadow-xs gap-1.5 select-none"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('skillsPage.importBtn')}</span>
            </Button>
          </div>
        </div>
      )}

      {/* Skill 候选生命周期（Step E/G）：门禁 → 审批 → 上线/回滚 */}
      <CandidatesSection />

      {/* Filter & Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('skillsPage.searchPlaceholder')}
            className="pl-9.5 rounded-xl bg-card/70 backdrop-blur-md border-border/50 text-xs h-9.5 shadow-2xs"
          />
        </div>
        <div className="flex items-center justify-between sm:justify-end gap-2.5">
          <Button
            onClick={() => void fetchSkills()}
            variant="outline"
            size="sm"
            className="rounded-xl px-2.5 h-8 text-xs font-semibold border-border/50 bg-card/70 hover:bg-card text-muted-foreground hover:text-foreground shadow-2xs gap-1.5"
            title="Refresh skills"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>刷新</span>
          </Button>
          <span className="px-3 py-1.5 rounded-xl bg-card/70 border border-border/40 text-xs text-muted-foreground font-mono font-semibold shadow-2xs">
            {t('skillsPage.enabledCount', { enabled: enabledCount, total: skills.length })}
          </span>
          {embedded && (
            <Button
              onClick={() => {
                setVetError('')
                setImportOpen(true)
              }}
              size="sm"
              className="rounded-xl px-3 h-8 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('skillsPage.importBtn')}</span>
            </Button>
          )}
        </div>
      </div>


      {/* Import Skill Dialog */}
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
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-dashed border-border/80 hover:border-primary/60 bg-card/50 hover:bg-primary/5 transition-all group cursor-pointer text-center shadow-2xs"
              >
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center group-hover:scale-110 transition-transform border border-amber-500/25">
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
                className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-dashed border-border/80 hover:border-primary/60 bg-card/50 hover:bg-primary/5 transition-all group cursor-pointer text-center shadow-2xs"
              >
                <div className="w-10 h-10 rounded-xl bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center group-hover:scale-110 transition-transform border border-blue-500/25">
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
                  ? 'border-primary bg-primary/10'
                  : 'border-border/60 bg-muted/25',
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
                    className="text-muted-foreground hover:text-foreground text-[11px] underline"
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
                  <span>{t('skillsPage.importBtn')}</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Skill Vetter Safety Modal */}
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

      {/* Skills Grid */}
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
              : '点击右上角「导入技能」按钮，输入 SKILL.md 或 Python 插件路径即可快速挂载'}
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
            <span>{t('skillsPage.importBtn')}</span>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredSkills.map((skill: any) => {
            const isEnabled = skill.status !== 'disabled'

            return (
              <Card
                key={skill.id || skill.name}
                className={cn(
                  'rounded-2xl border transition-all duration-200 bg-card/70 backdrop-blur-md overflow-hidden shadow-xs hover:shadow-md',
                  isEnabled
                    ? 'border-border/50 hover:border-primary/40'
                    : 'border-border/30 opacity-60 bg-card/30',
                )}
              >
                <CardContent className="p-4 sm:p-5 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3.5 flex-1 min-w-0">
                    <div
                      className={cn(
                        'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border shadow-2xs',
                        isEnabled
                          ? 'bg-primary/10 border-primary/20 text-primary'
                          : 'bg-muted border-border/40 text-muted-foreground',
                      )}
                    >
                      <Package className="w-5 h-5" />
                    </div>

                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-sm font-bold text-foreground truncate">
                          {skill.name}
                        </h4>
                        <Badge
                          className={cn(
                            'text-[10px] font-bold px-2 py-0.5 rounded-lg border shadow-2xs',
                            skill.trust === 'own'
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                              : skill.trust === 'verified'
                              ? 'bg-primary/15 text-primary border-primary/30'
                              : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
                          )}
                        >
                          {skill.trust === 'own'
                            ? t('skillsPage.coreBadge')
                            : skill.trust === 'verified'
                            ? t('skillsPage.officialBadge')
                            : t('skillsPage.communityBadge')}
                        </Badge>
                      </div>

                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                        {skill.description || t('skillsPage.noDescription')}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0 pt-1">
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) =>
                        checked ? enableSkill(skill.name) : disableSkill(skill.name)
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Skill 候选生命周期区（Step E/G）────────────────────────────────────────
// 学习环孵出的候选在这里走完 candidate → staged → active；staged 是唯一需要
// 用户点头的关卡。文案沿用页面既有中文直出风格。

interface SkillCandidate {
  id: string
  name: string
  description?: string
  status?: string
  version?: string
  experience_ref?: string
  // 门禁条目不都是 {ok, detail}：verification_run 记录的是"跑了没有 / 有没有
  // 机器验证"，没有 ok 字段。readGate 负责把这两种形状分开读。
  gate_report?: Record<string, unknown>
}

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
  const [openId, setOpenId] = useState('')

  const load = async () => {
    try {
      const r = await apiFetch(`${API_BASE}/api/skills/candidates`)
      const data = await r.json()
      setRows(Array.isArray(data?.candidates) ? data.candidates : [])
    } catch { /* 保留旧列表 */ }
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
      // approve / rollback 会改变磁盘技能清单本身
      if (action === 'approve' || action === 'rollback') {
        await useSkillStore.getState().fetchSkills()
      }
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <Sparkles className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">技能候选</h3>
        <span className="text-xs text-muted-foreground">学习环孵出的候选：门禁通过后需你批准才会上线</span>
      </div>
      {rows.map((c) => (
        <Card key={c.id} className="rounded-2xl border-border/50 bg-card/50">
          <CardContent className="p-4 space-y-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={cn('rounded-lg text-[10px] font-mono', statusBadgeCls(c.status))}>
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
                    className="rounded-xl h-8 px-3 text-xs gap-1">
                    <ShieldCheck className="w-3.5 h-3.5" /> 门禁预检
                  </Button>
                )}
                {c.status === 'staged' && (
                  <>
                    <Button size="sm" variant="outline" disabled={busy !== ''}
                      onClick={() => void act(c.id, 'reject')}
                      className="rounded-xl h-8 px-3 text-xs text-muted-foreground hover:text-destructive">
                      <XCircle className="w-3.5 h-3.5" /> 拒绝
                    </Button>
                    <Button size="sm" disabled={busy !== ''}
                      onClick={() => void act(c.id, 'approve')}
                      className="rounded-xl h-8 px-3.5 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 gap-1">
                      <ShieldCheck className="w-3.5 h-3.5" /> 批准上线
                    </Button>
                  </>
                )}
                {c.status === 'active' && (
                  <Button size="sm" variant="outline" disabled={busy !== ''}
                    onClick={() => void act(c.id, 'rollback')}
                    className="rounded-xl h-8 px-3 text-xs text-muted-foreground hover:text-destructive gap-1">
                    <RotateCcw className="w-3.5 h-3.5" /> 回滚
                  </Button>
                )}
              </div>
            </div>
            {c.description ? (
              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{c.description}</p>
            ) : null}
            {c.gate_report && Object.keys(c.gate_report).length > 0 && (
              <div className="space-y-1">
                <button type="button"
                  onClick={() => setOpenId(openId === c.id ? '' : c.id)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                  {openId === c.id ? '收起门禁报告 ▲' : '查看门禁报告 ▼'}
                </button>
                {openId === c.id && (
                  <div className="rounded-xl border border-border/40 bg-background/40 p-2.5 space-y-1">
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
          </CardContent>
        </Card>
      ))}
      {loaded && rows.length === 0 && (
        <p className="text-xs text-muted-foreground px-1 py-2">
          暂无候选——技能被真实使用并成功后，学习环才会孵化候选。
        </p>
      )}
    </div>
  )
}
