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
  FolderOpen, FileCode, UploadCloud,
} from 'lucide-react'
import { usePluginStore, type Plugin } from '@store/pluginStore'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Switch } from '@components/ui/switch'
import { Badge } from '@components/ui/badge'
import { cn } from '@/lib/utils'

function PluginCard({ plugin }: { plugin: Plugin }) {
  const { t } = useTranslation()
  const { setEnabled, removePlugin } = usePluginStore()
  const enabled = plugin.status !== 'disabled'
  const broken = plugin.status === 'broken'

  return (
    <div className={cn(
      'rounded-2xl border bg-card/60 p-4 space-y-2.5',
      broken ? 'border-destructive/40' : 'border-border/60',
    )}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-foreground/10 border border-border/40 flex items-center justify-center shrink-0 text-foreground">
          <Blocks className="w-4.5 h-4.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-bold text-foreground truncate">{plugin.name}</h4>
            {plugin.version && (
              <span className="text-[10px] font-mono text-muted-foreground">v{plugin.version}</span>
            )}
            {/* 适配的宿主 API 版本（旧后端缺省不显示）。给「为什么装不上」一个可预判的信号。 */}
            {plugin.apiVersion && (
              <span
                className="text-[10px] font-mono text-muted-foreground/70 px-1 py-px rounded border border-border/40"
                title={t('capabilitiesPage.plugins.apiVersionHint',
                  '这个插件按宿主接口的 v{{v}} 规范编写', { v: plugin.apiVersion })}
              >
                API v{plugin.apiVersion}
              </span>
            )}
            {broken && (
              <Badge variant="outline" className="text-[10px] font-semibold px-1.5 py-0 rounded bg-destructive/15 text-destructive border-destructive/30">
                {t('capabilitiesPage.plugins.broken')}
              </Badge>
            )}
          </div>
          {plugin.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{plugin.description}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1.5 pt-0.5">
          <Switch
            checked={enabled}
            onCheckedChange={(v) => setEnabled(plugin.name, v)}
            aria-label={t('capabilitiesPage.plugins.toggle')}
          />
          <button
            onClick={() => removePlugin(plugin.name)}
            aria-label={t('capabilitiesPage.plugins.remove')}
            title={t('capabilitiesPage.plugins.remove')}
            className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap pl-12">
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
          <Sparkles className="w-3 h-3 shrink-0" />
          {t('capabilitiesPage.plugins.skillCount', { n: plugin.skills.length, total: plugin.declaredSkills })}
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
          <Bot className="w-3 h-3 shrink-0" />
          {t('capabilitiesPage.plugins.subagentCount', { n: plugin.subagents.length, total: plugin.declaredSubagents })}
        </span>
      </div>

      {plugin.error && (
        <p className="text-[11px] text-destructive/90 flex items-start gap-1.5 pl-12 leading-relaxed">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {plugin.error}
        </p>
      )}
      {plugin.unsupported.length > 0 && (
        <p className="text-[10px] text-muted-foreground/70 pl-12">
          {t('capabilitiesPage.plugins.unsupported', { keys: plugin.unsupported.join(', ') })}
        </p>
      )}
    </div>
  )
}

export function PluginsPanel() {
  const { t } = useTranslation()
  const { plugins, loaded, loading, error, fetchPlugins, importPlugin } = usePluginStore()
  const [path, setPath] = useState('')
  const [importing, setImporting] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (!loaded) void fetchPlugins()
  }, [loaded, fetchPlugins])

  const handlePickDirectory = async () => {
    try {
      const p = await window.electronAPI?.invoke('file:pickDirectory')
      if (p) {
        setPath(p)
      }
    } catch {
      // ignore
    }
  }

  const handlePickFile = async () => {
    try {
      const p = await window.electronAPI?.invoke('file:pickFile', [
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
      <div className="p-4 rounded-2xl border border-border/50 bg-card/70 space-y-3.5">
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
            className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-border/80 hover:border-primary/60 bg-background/50 hover:bg-primary/5 transition-all group cursor-pointer text-left shadow-2xs"
          >
            <div className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform border border-amber-500/25">
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
            className="flex items-center gap-3 p-3 rounded-xl border border-dashed border-border/80 hover:border-primary/60 bg-background/50 hover:bg-primary/5 transition-all group cursor-pointer text-left shadow-2xs"
          >
            <div className="w-9 h-9 rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform border border-blue-500/25">
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
              ? 'border-primary bg-primary/10'
              : 'border-border/60 bg-muted/20',
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
              className="rounded-xl bg-background border-border/60 text-xs h-9 font-mono"
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
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : plugins.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-card/30 px-6 py-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center mx-auto text-muted-foreground">
            <Blocks className="w-6 h-6" />
          </div>
          <h4 className="text-sm font-bold text-foreground">{t('capabilitiesPage.plugins.emptyTitle')}</h4>
          <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
            {t('capabilitiesPage.plugins.emptyHint')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {plugins.map((p) => <PluginCard key={p.name} plugin={p} />)}
        </div>
      )}
    </div>
  )
}
