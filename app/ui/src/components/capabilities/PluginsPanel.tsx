/**
 * PluginsPanel — the 插件 tab of the Capabilities page.
 *
 * A plugin is a bundle (a directory + plugin.json) that contributes skills and
 * sub-agents under one identity and one on/off switch. Backend truth lives in
 * `app/backend/plugin_registry.py`, surfaced via `/api/plugins`.
 *
 * There is no marketplace: plugins are installed by pointing at a local
 * directory, the same way skills are. A "browse & install from a store" flow
 * would need a registry to browse, which does not exist — so this offers the
 * honest thing (install from a path) rather than a search box over nothing.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Blocks, Plus, Loader2, AlertTriangle, Trash2, Sparkles, Bot, PackageOpen,
  FolderOpen, FileCode, UploadCloud, ShieldCheck,
} from 'lucide-react'
import { usePluginStore, type Plugin } from '@store/pluginStore'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Switch } from '@components/ui/switch'
import { Badge } from '@components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@components/ui/dialog'
import { cn } from '@/lib/utils'
import { LicenseAttributionBlock } from './LicenseAttributionBlock'

function PluginCard({
  plugin,
  onSelect,
  onDelete,
}: {
  plugin: Plugin
  onSelect: (p: Plugin) => void
  onDelete: (p: Plugin) => void
}) {
  const { t } = useTranslation()
  const { setEnabled } = usePluginStore()
  const enabled = plugin.status !== 'disabled'
  const broken = plugin.status === 'broken'

  return (
    <div
      onClick={() => onSelect(plugin)}
      className={cn(
        'flex flex-col justify-between p-4 rounded-2xl border transition-all duration-200 cursor-pointer group bg-card shadow-2xs hover:shadow-xs min-h-[145px]',
        broken
          ? 'border-destructive/40 bg-destructive/5'
          : enabled
          ? 'border-border hover:border-foreground/30'
          : 'border-border/40 opacity-60 bg-muted/20',
      )}
    >
      <div className="space-y-2">
        {/* Top: Icon + Title + API + Controls */}
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={cn(
                'w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border shadow-2xs',
                enabled
                  ? 'bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400'
                  : 'bg-muted border-border/40 text-muted-foreground',
              )}
            >
              <Blocks className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <h4 className="text-sm font-bold text-foreground truncate group-hover:text-foreground transition-colors">
                {plugin.name}
              </h4>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                {plugin.version && (
                  <span className="text-[10px] font-mono text-muted-foreground/80">
                    v{plugin.version}
                  </span>
                )}
                {plugin.apiVersion && (
                  <span
                    className="text-[9px] font-mono text-muted-foreground/70 px-1 py-px rounded border border-border/40"
                    title={t('capabilitiesPage.plugins.apiVersionHint',
                      '这个插件按宿主接口的 v{{v}} 规范编写', { v: plugin.apiVersion })}
                  >
                    API v{plugin.apiVersion}
                  </span>
                )}
                {broken ? (
                  <Badge variant="outline" className="text-[9px] font-semibold px-1 py-0 rounded bg-destructive/15 text-destructive border-destructive/30">
                    {t('capabilitiesPage.plugins.broken')}
                  </Badge>
                ) : !enabled ? (
                  <Badge variant="outline" className="text-[9px] font-semibold px-1 py-0 rounded bg-muted text-muted-foreground border-border/50">
                    已停用 (不为 AI 所用)
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-1 pt-0.5" onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => setEnabled(plugin.name, v)}
              aria-label={t('capabilitiesPage.plugins.toggle')}
            />
            <button
              onClick={() => onDelete(plugin)}
              aria-label="卸载插件"
              title={enabled ? "停用并从 AI 运行时卸载" : "已停用"}
              className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 min-h-[32px]">
          {plugin.description || '暂无描述'}
        </p>

        {plugin.error && (
          <p className="text-[10.5px] text-destructive/90 flex items-start gap-1 leading-relaxed">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {plugin.error}
          </p>
        )}
      </div>

      {/* Bottom: Bundled Skills / Subagents count & detail link */}
      <div className="pt-2 border-t border-border/30 flex items-center justify-between gap-2 text-[11px] text-muted-foreground font-mono">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
            <Sparkles className="w-3 h-3 text-amber-500 shrink-0" />
            {plugin.skills.length} 技能
          </span>
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
            <Bot className="w-3 h-3 text-sky-500 shrink-0" />
            {plugin.subagents.length} Agent
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground group-hover:text-foreground font-medium shrink-0 font-sans">
          详情 &rarr;
        </span>
      </div>
    </div>
  )
}

export function PluginsPanel({ installTrigger = 0 }: { installTrigger?: number } = {}) {
  const { t } = useTranslation()
  const { plugins, loaded, loading, error, fetchPlugins, importPlugin, removePlugin, setEnabled } = usePluginStore()
  const [path, setPath] = useState('')
  const [importing, setImporting] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null)
  const [pluginToDelete, setPluginToDelete] = useState<Plugin | null>(null)
  const [uninstalling, setUninstalling] = useState(false)

  useEffect(() => {
    if (!loaded) void fetchPlugins()
  }, [loaded, fetchPlugins])

  const handlePickDirectory = async () => {
    try {
      const p = await (window as any).electronAPI?.invoke('file:pickDirectory')
      if (p) {
        setPath(p)
      }
    } catch {
      // ignore
    }
  }

  const handlePickFile = async () => {
    try {
      const p = await (window as any).electronAPI?.invoke('file:pickFile', [
        { name: 'Plugin Manifest (plugin.json)', extensions: ['json'] },
        { name: 'All Files (*.*)', extensions: ['*'] },
      ])
      if (p) {
        // 如果选中了 plugin.json，自动提取所在目录
        const dir = p.replace(/[/\\][^/\\]+$/, '')
        setPath(dir || p)
      }
    } catch {
      // ignore
    }
  }

  // 顶部「安装插件」按钮：能力页把点击变成一个自增计数器传进来，
  // 这里只负责把它翻译成"打开目录选择"。用计数器而不是 boolean，
  // 是因为同一个按钮要能连点第二次。
  useEffect(() => {
    if (installTrigger > 0) void handlePickDirectory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installTrigger])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && (file as any).path) {
      let p = (file as any).path
      if (p.endsWith('plugin.json')) {
        p = p.replace(/[/\\][^/\\]+$/, '')
      }
      setPath(p)
    }
  }

  const doImport = async () => {
    if (!path.trim()) return
    setImporting(true)
    const ok = await importPlugin(path.trim())
    setImporting(false)
    if (ok) setPath('')
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('capabilitiesPage.plugins.desc')}
      </p>

      {/* Install-from-path / Folder Picker / Drag-Drop */}
      <div className="p-4 rounded-2xl border border-border bg-card space-y-3.5 shadow-2xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PackageOpen className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-sm font-bold text-foreground">{t('capabilitiesPage.plugins.installTitle')}</h3>
          </div>
          <span className="text-[11px] text-muted-foreground">
            支持点击选择或直接拖入插件目录
          </span>
        </div>

        {/* Action Pick Cards */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={handlePickDirectory}
            className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-border hover:border-foreground/40 bg-muted/20 hover:bg-muted/40 transition-all group cursor-pointer text-left shadow-2xs"
          >
            <div className="w-9 h-9 rounded-lg bg-muted text-foreground flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform border border-border">
              <FolderOpen className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold text-foreground">选择插件目录</div>
              <div className="text-[10.5px] text-muted-foreground truncate">包含 plugin.json 的文件夹</div>
            </div>
          </button>

          <button
            type="button"
            onClick={handlePickFile}
            className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-border hover:border-foreground/40 bg-muted/20 hover:bg-muted/40 transition-all group cursor-pointer text-left shadow-2xs"
          >
            <div className="w-9 h-9 rounded-lg bg-muted text-foreground flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform border border-border">
              <FileCode className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold text-foreground">选择 plugin.json</div>
              <div className="text-[10.5px] text-muted-foreground truncate">自动定位插件所在根目录</div>
            </div>
          </button>
        </div>

        {/* Drag-Drop and Path Input */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            'p-2.5 rounded-xl border transition-all space-y-2',
            isDragging
              ? 'border-foreground bg-muted/40'
              : 'border-border bg-muted/20',
          )}
        >
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground px-1">
            <span className="flex items-center gap-1.5">
              <UploadCloud className="w-3.5 h-3.5 text-muted-foreground" />
              <span>已选路径（支持直接拖入文件/文件夹，亦可粘贴）：</span>
            </span>
            {path && (
              <button
                type="button"
                onClick={() => setPath('')}
                className="text-muted-foreground hover:text-foreground text-[10.5px] hover:underline cursor-pointer"
              >
                清空
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="点击上方按钮选择目录，或拖拽插件目录/文件至此处..."
              onKeyDown={(e) => e.key === 'Enter' && doImport()}
              className="rounded-xl bg-background border-border text-xs h-9 font-mono"
            />
            <Button
              onClick={doImport}
              disabled={!path.trim() || importing}
              className="rounded-xl px-5 font-semibold text-xs bg-foreground hover:bg-foreground/90 text-background shrink-0 h-9"
            >
              {importing
                ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> {t('capabilitiesPage.plugins.installing')}</>
                : <><Plus className="h-3.5 w-3.5 mr-1.5" /> {t('capabilitiesPage.plugins.installBtn')}</>}
            </Button>
          </div>
        </div>

        <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
          {t('capabilitiesPage.plugins.installHint')}
        </p>
        {error && (
          <p className="text-xs text-destructive flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
          </p>
        )}
      </div>

      {loading && plugins.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin text-foreground" />
        </div>
      ) : plugins.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 px-6 py-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center mx-auto text-muted-foreground border border-border">
            <Blocks className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-foreground">{t('capabilitiesPage.plugins.emptyTitle')}</h4>
          <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
            {t('capabilitiesPage.plugins.emptyHint')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(288px,100%),1fr))] gap-3.5">
          {plugins.map((p) => (
            <PluginCard
              key={p.name}
              plugin={p}
              onSelect={setSelectedPlugin}
              onDelete={setPluginToDelete}
            />
          ))}
        </div>
      )}

      {/* Plugin Detail Dialog */}
      <Dialog open={!!selectedPlugin} onOpenChange={(open) => { if (!open) setSelectedPlugin(null) }}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col p-6 overflow-hidden">
          {selectedPlugin && (
            <>
              <DialogHeader className="space-y-2 pb-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30 flex items-center justify-center shrink-0">
                    <Blocks className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="text-base font-bold flex items-center gap-2 flex-wrap">
                      <span>{selectedPlugin.name}</span>
                      {selectedPlugin.version && (
                        <span className="text-xs font-mono font-normal text-muted-foreground">v{selectedPlugin.version}</span>
                      )}
                      {selectedPlugin.apiVersion && (
                        <span className="text-[10px] font-mono text-muted-foreground/70 px-1 py-px rounded border border-border/40">
                          API v{selectedPlugin.apiVersion}
                        </span>
                      )}
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] font-semibold px-2 py-0.5 rounded-full',
                          selectedPlugin.status === 'loaded'
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                            : selectedPlugin.status === 'disabled'
                            ? 'bg-muted text-muted-foreground border-border/40'
                            : 'bg-destructive/10 text-destructive border-destructive/20'
                        )}
                      >
                        {selectedPlugin.status === 'loaded' ? '已启用' : selectedPlugin.status === 'disabled' ? '已禁用' : '异常'}
                      </Badge>
                    </DialogTitle>
                  </div>
                </div>
                <DialogDescription className="text-xs text-muted-foreground leading-relaxed pt-1">
                  {selectedPlugin.description || '暂无描述信息'}
                </DialogDescription>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
                {/* Meta details */}
                <div className="bg-muted/40 rounded-xl p-3 space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">插件路径</span>
                    <span className="font-mono text-[11px] text-foreground/80 truncate max-w-[280px]" title={selectedPlugin.root}>
                      {selectedPlugin.root}
                    </span>
                  </div>
                  {selectedPlugin.author && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">开发者</span>
                      <span className="text-foreground/80 font-medium">{selectedPlugin.author}</span>
                    </div>
                  )}
                  {selectedPlugin.homepage && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">主页</span>
                      <a href={selectedPlugin.homepage} target="_blank" rel="noreferrer" className="text-primary hover:underline text-[11px] truncate max-w-[280px]">
                        {selectedPlugin.homepage}
                      </a>
                    </div>
                  )}
                </div>

                {/* Where this plugin came from. Renders nothing when the plugin
                    declares no licence and ships no licence file. */}
                <LicenseAttributionBlock
                  license={selectedPlugin.license}
                  author={selectedPlugin.author}
                  copyright={selectedPlugin.copyright}
                  upstream={selectedPlugin.upstream || selectedPlugin.homepage}
                  licenseFromFile={selectedPlugin.licenseFromFile}
                />

                {/* Skills section */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                      包含技能 ({selectedPlugin.skills.length})
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      声明: {selectedPlugin.declaredSkills}
                    </span>
                  </div>
                  {selectedPlugin.skills.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 p-2.5 rounded-xl bg-muted/20 border border-border/40">
                      {selectedPlugin.skills.map((s) => (
                        <Badge key={s} variant="secondary" className="text-[11px] font-mono px-2 py-0.5">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground/60 italic p-2">未包含或未加载技能</div>
                  )}
                </div>

                {/* Subagents section */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-foreground">
                    <span className="flex items-center gap-1.5">
                      <Bot className="w-3.5 h-3.5 text-sky-500" />
                      包含子智能体 ({selectedPlugin.subagents.length})
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      声明: {selectedPlugin.declaredSubagents}
                    </span>
                  </div>
                  {selectedPlugin.subagents.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 p-2.5 rounded-xl bg-muted/20 border border-border/40">
                      {selectedPlugin.subagents.map((sub) => (
                        <Badge key={sub} variant="secondary" className="text-[11px] font-mono px-2 py-0.5">
                          {sub}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground/60 italic p-2">未包含或未加载子智能体</div>
                  )}
                </div>

                {/* Errors or unsupported keys */}
                {selectedPlugin.error && (
                  <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs space-y-1">
                    <div className="font-semibold flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> 错误信息
                    </div>
                    <div className="text-[11px] font-mono leading-relaxed">{selectedPlugin.error}</div>
                  </div>
                )}
                {selectedPlugin.unsupported.length > 0 && (
                  <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs">
                    未支持的声明项: {selectedPlugin.unsupported.join(', ')}
                  </div>
                )}
              </div>

              <DialogFooter className="pt-3 border-t border-border/40 flex items-center justify-between sm:justify-between">
                <Button
                  variant="destructive"
                  size="sm"
                  className="rounded-xl text-xs"
                  onClick={() => {
                    const target = selectedPlugin
                    setSelectedPlugin(null)
                    setPluginToDelete(target)
                  }}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  卸载插件
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-xl text-xs"
                    onClick={() => setSelectedPlugin(null)}
                  >
                    关闭
                  </Button>
                  <Button
                    size="sm"
                    className="rounded-xl text-xs"
                    onClick={() => {
                      setEnabled(selectedPlugin.name, selectedPlugin.status === 'disabled')
                      setSelectedPlugin({
                        ...selectedPlugin,
                        status: selectedPlugin.status === 'disabled' ? 'loaded' : 'disabled',
                      })
                    }}
                  >
                    {selectedPlugin.status === 'disabled' ? '启用插件' : '禁用插件'}
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Cascading Uninstall Dialog */}
      <Dialog open={!!pluginToDelete} onOpenChange={(open) => !open && setPluginToDelete(null)}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <div className="flex items-center gap-2 text-amber-500">
              <AlertTriangle className="w-5 h-5" />
              <DialogTitle className="text-sm font-bold text-foreground">从 AI 运行时卸载插件</DialogTitle>
            </div>
            <div className="text-xs text-muted-foreground mt-2 leading-relaxed space-y-2">
              <p>
                确定要停用并卸载插件 <span className="font-mono font-bold text-foreground">"{pluginToDelete?.name}"</span> 吗？
              </p>
              <div className="p-3 rounded-xl bg-muted/40 border border-border/50 text-xs leading-relaxed space-y-1.5">
                <div className="font-semibold text-foreground flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                  <span>安全卸载（不删除卡片）保障：</span>
                </div>
                <p className="text-muted-foreground">
                  卸载该插件将从 AI 运行时中彻底注销其所包含的 <strong>{pluginToDelete?.skills.length || 0} 个技能</strong> 与 <strong>{pluginToDelete?.subagents.length || 0} 个子智能体</strong>，不再为 AI 所用。
                </p>
                <p className="text-muted-foreground">
                  <strong>该插件卡片仍会保留在列表中</strong>，您可以随时通过开关一键重新启用。
                </p>
              </div>
            </div>
          </DialogHeader>
          <DialogFooter className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPluginToDelete(null)}
              disabled={uninstalling}
              className="rounded-xl text-xs"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                if (!pluginToDelete) return
                setUninstalling(true)
                try {
                  await setEnabled(pluginToDelete.name, false)
                  setPluginToDelete(null)
                } finally {
                  setUninstalling(false)
                }
              }}
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
