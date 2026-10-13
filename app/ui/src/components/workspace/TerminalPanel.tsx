// src/components/workspace/TerminalPanel.tsx
// Interactive terminal (xterm + node-pty). 业界主流方案相同的架构。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TerminalSquare, RefreshCw, Trash2, Radio, FolderOpen } from 'lucide-react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cn } from '@/lib/utils'
import { useSessionListStore } from '@store/sessionListStore'
import { useTerminalStore } from '@store/terminalStore'
import { Button } from '@components/ui/button'
import { PanelHeader } from './PanelHeader'

/**
 * 从主题 CSS 变量读终端配色。令牌在 index.css 里是 HSL 分量格式
 * （如 `210 20% 98%`），需要包成 `hsl(...)`；选区用主色叠 30% 透明度。
 * 从面板容器上取计算样式——.dark 类挂在祖先上时变量会级联下来，
 * 深浅主题自动跟随，不再写死 #09090b 纯黑跟浅色主题打架。
 */
function readTerminalTheme(el: Element | null): ITheme {
  const css = getComputedStyle(el ?? document.body)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const bg = v('--background', '220 18% 6%')
  const fg = v('--foreground', '0 0% 98%')
  const primary = v('--primary', '222 47% 11%')
  return {
    background: `hsl(${bg})`,
    foreground: `hsl(${fg})`,
    cursor: `hsl(${fg})`,
    cursorAccent: `hsl(${bg})`,
    selectionBackground: `hsl(${primary} / 0.30)`,
  }
}

export function TerminalPanel({ sessionId: sessionIdProp, active = true }: { sessionId?: string; active?: boolean }) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [ready, setReady] = useState(false)
  const [ptyAvailable, setPtyAvailable] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // hook 必须无条件调用：是否用 prop 里的 sessionId 在下面决定
  const storeSessionId = useTerminalStore((s) => s.sessionId)
  const sessionId = sessionIdProp || storeSessionId
  const mirrorAgent = useTerminalStore((s) => s.mirrorAgent)
  const setMirrorAgent = useTerminalStore((s) => s.setMirrorAgent)
  const setWorkspaceCwd = useTerminalStore((s) => s.setWorkspaceCwd)

  const workspaceRoot = useSessionListStore((s) => s.activeWorkspace)
  const switchWorkspace = useSessionListStore((s) => s.switchWorkspace)

  // xterm 只能在"至少可见过一次"的容器里 open。常驻挂载后面板可能在后台
  // 先挂载（重启恢复的 tab、打开后切走），display:none 下 xterm 的字符
  // 测量为 0，渲染器初始化失败——之后无论怎么切回来都是纯黑。
  // 所以：PTY 创建与 xterm 初始化都等首次激活；再次激活时强制 fit+重绘。
  const [everActive, setEverActive] = useState(active)
  useEffect(() => {
    if (active) setEverActive(true)
  }, [active])

  const boot = useCallback(async (cwdOverride?: string) => {
    const api = window.electronAPI
    if (!api?.isElectron) {
      setError(t('terminal.webOnly'))
      return
    }
    const cwd = (cwdOverride || workspaceRoot || '').trim()
    if (!cwd) {
      setReady(false)
      setError(null)
      return
    }
    const created = await api.invoke('terminal:create', cwd, sessionId) as {
      ok?: boolean
      pty?: boolean
      error?: string
    }
    if (!created?.ok) {
      setReady(false)
      setError(created?.error || t('terminal.spawnFailed'))
      return
    }
    setPtyAvailable(created.pty !== false)
    setWorkspaceCwd(cwd)
    setError(null)
    setReady(true)
  }, [sessionId, setWorkspaceCwd, t, workspaceRoot])

  const pickWorkspace = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.isElectron) return
    const dir = await api.invoke('file:pickDirectory') as string | null
    if (!dir) return
    switchWorkspace(dir)
    await boot(dir)
  }, [boot, switchWorkspace])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.isElectron || !everActive || !containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: readTerminalTheme(containerRef.current),
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const onData = (data: string) => {
      void api.invoke('terminal:write', sessionId, data)
    }
    term.onData(onData)

    const unsub = api.on('terminal:data', (payload: { sessionId?: string; data?: string }) => {
      if (payload?.sessionId !== sessionId || !payload.data) return
      term.write(payload.data)
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        const dims = fit.proposeDimensions()
        if (dims) {
          void api.invoke('terminal:resize', sessionId, dims.cols, dims.rows)
        }
      } catch { /* ignore */ }
    })
    ro.observe(containerRef.current)

    return () => {
      unsub()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      // 只销毁本 tab 自己的会话。此前调的是 terminalStore.destroySession()，
      // 那个销毁的是遗留全局会话（ovolve-user-terminal），跟这个 tab 无关。
      // 正常关闭路径上 sidePanelStore.closeTab 已发过 terminal:destroy，
      // 这里兜底重复销毁一次（主进程对未知会话幂等处理）。
      void api.invoke('terminal:destroy', sessionId).catch(() => {})
    }
  }, [sessionId, everActive])

  useEffect(() => {
    if (!everActive) return
    if (!workspaceRoot) {
      setReady(false)
      setError(null)
      return
    }
    void boot()
  }, [workspaceRoot, boot, everActive])

  // 常驻挂载下面板用 display 切换显隐：切回激活时强制重算尺寸并重绘，
  // 再聚焦输入区（VS Code 终端同款行为）。顺带重读一次主题——用户切了
  // 深浅色后，画布配色跟随，不必重开 tab。
  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => {
      try {
        const term = termRef.current
        if (term) {
          term.options.theme = readTerminalTheme(containerRef.current)
          fitRef.current?.fit()
          term.refresh(0, Math.max(0, term.rows - 1))
        }
        termRef.current?.focus()
      } catch { /* not mounted yet */ }
    }, 50)
    return () => window.clearTimeout(id)
  }, [active])

  if (!window.electronAPI?.isElectron) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <TerminalSquare className="h-8 w-8 opacity-40" />
        <p>{t('terminal.webOnly')}</p>
      </div>
    )
  }

  return (
    // 面板底色走主题画布色。此前写死 bg-zinc-950 纯黑，浅色主题下整个
    // 面板与"未打开工作区"卡片、头部栏全部被黑色吞掉。
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PanelHeader icon={TerminalSquare} iconClassName="text-emerald-500" title={t('terminal.title')}>
        {!ptyAvailable && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">
            {t('terminal.fallbackMode')}
          </span>
        )}
        <button
          type="button"
          title={t('terminal.mirrorAgentHint')}
          onClick={() => setMirrorAgent(!mirrorAgent)}
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] transition-colors',
            mirrorAgent
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-foreground/5',
          )}
        >
          <Radio size={11} />
          {t('terminal.mirrorAgent')}
        </button>
        <button
          type="button"
          title={t('terminal.reconnect')}
          onClick={() => { void boot() }}
          className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          title={t('terminal.clear')}
          onClick={() => termRef.current?.clear()}
          className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          <Trash2 size={13} />
        </button>
      </PanelHeader>

      {error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {!workspaceRoot && !ready && !error && (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 text-center">
          <div className="w-full max-w-[320px] space-y-3 rounded-2xl border border-dashed border-border/60 bg-muted/20 px-4 py-5 shadow-2xs">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-border/40 bg-muted/60 text-muted-foreground">
              <TerminalSquare size={20} />
            </div>
            <div className="space-y-1">
              <h4 className="text-xs font-bold text-foreground">{t('terminal.noWorkspaceTitle')}</h4>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t('terminal.noWorkspaceHint')}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => { void pickWorkspace() }}
              className="h-9 w-full gap-1.5 rounded-xl bg-foreground text-xs font-semibold text-background shadow-xs hover:bg-foreground/90"
            >
              <FolderOpen size={13} />
              <span>{t('terminal.pickWorkspace')}</span>
            </Button>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className={cn('min-h-0 flex-1 overflow-hidden p-1', !workspaceRoot && !ready && 'hidden')}
      />
    </div>
  )
}
