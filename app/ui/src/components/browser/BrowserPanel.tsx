// src/components/browser/BrowserPanel.tsx
// Embedded live browser, VSCode "Simple Browser" style: an Electron <webview>
// rendered INSIDE the side panel — no separate OS window.
//
// The <webview> is the real page. AI automation drives it through the same
// element (executeJavaScript / capturePage via the webview API), so there is
// only ONE browser rather than a visible one plus a hidden automation one.
import { useCallback, useEffect, useRef, useState, createElement } from 'react'
import {
  Globe, ArrowLeft, ArrowRight, RotateCw, X, Loader2, ExternalLink, Home,
} from 'lucide-react'
import { Input } from '@components/ui/input'

const HOME = 'https://www.bing.com'

/**
 * Turn whatever the user typed into a navigable URL.
 * `百度` → a search; `baidu.com` → https://baidu.com; full URLs pass through.
 */
export function toUrl(input: string): string {
  const raw = input.trim()
  if (!raw) return HOME
  if (/^(https?|file|about):/i.test(raw)) return raw
  // host:port（localhost:3000）→ https。要求主机段含字母，避免把 12:34 这类
  // 时间误判成地址；带点号的 host 走下一条通用规则。
  if (/^[a-z][\w-]*:\d{2,5}(\/\S*)?$/i.test(raw)) return `https://${raw}`
  // Looks like a host (has a dot, no spaces) → assume https.
  if (/^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(raw)) return `https://${raw}`
  // Otherwise treat it as a search query.
  return `https://www.bing.com/search?q=${encodeURIComponent(raw)}`
}

type WebviewEl = HTMLElement & {
  src: string
  getURL: () => string
  getTitle: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
  loadURL: (url: string) => Promise<void>
  executeJavaScript: (code: string) => Promise<any>
  openDevTools: () => void
}

export function BrowserPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<WebviewEl | null>(null)
  const [address, setAddress] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [ready, setReady] = useState(false)

  const isElectron = !!window.electronAPI?.isElectron

  // Grab the <webview> element from the DOM manually — React refs on custom
  // elements via createElement are unreliable. We poll until it shows up.
  // 此前的 2 秒超时放弃是死路：放弃后 ready 永远不会置 true，事件监听
  // effect 依赖 [ready] 也就永远不再执行，地址栏/前进后退从此失联。
  // webview 挂载只晚一两帧，低频轮询直到拿到为止，成本可忽略。
  useEffect(() => {
    if (!isElectron) return
    let cancelled = false

    const timer = setInterval(() => {
      if (cancelled) return
      const el = containerRef.current?.querySelector('webview') as unknown as WebviewEl | null
      if (el) {
        viewRef.current = el
        setReady(true)
        clearInterval(timer)
      }
    }, 200)

    return () => { cancelled = true; clearInterval(timer) }
  }, [isElectron])

  // Wire webview lifecycle events once the element is acquired.
  useEffect(() => {
    const el = viewRef.current
    if (!el || !ready) return

    const syncLocation = () => {
      try {
        setCurrentUrl(el.getURL())
        setAddress(el.getURL())
        setTitle(el.getTitle())
        setCanBack(el.canGoBack())
        setCanFwd(el.canGoForward())
      } catch { /* element not ready */ }
    }
    const onStart = () => { setLoading(true); setError(null) }
    const onStop = () => {
      setLoading(false)
      syncLocation()
    }
    const onFail = (e: any) => {
      setLoading(false)
      // -3 is ERR_ABORTED, fired for ordinary in-page navigations too.
      if (e?.errorCode === -3) return
      setError(`${e?.errorCode ?? ''} ${e?.errorDescription ?? '加载失败'}`.trim())
    }

    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-fail-load', onFail as EventListener)
    // SPA 路由跳转不触发 did-stop-loading（页面本身不重载），
    // 不监听 in-page 导航的话地址栏会停在进入 SPA 前的旧地址。
    el.addEventListener('did-navigate', syncLocation as EventListener)
    el.addEventListener('did-navigate-in-page', syncLocation as EventListener)
    return () => {
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-fail-load', onFail as EventListener)
      el.removeEventListener('did-navigate', syncLocation as EventListener)
      el.removeEventListener('did-navigate-in-page', syncLocation as EventListener)
    }
  }, [ready])

  const navigate = useCallback((input: string) => {
    const url = toUrl(input)
    setAddress(url)
    setError(null)

    // Re-acquire lazily in case the ref was never set (HMR, late mount).
    const el =
      viewRef.current ??
      (containerRef.current?.querySelector('webview') as unknown as WebviewEl | null)
    if (!el) {
      setError('内嵌浏览器尚未就绪，请稍候重试')
      return
    }
    viewRef.current = el

    try {
      // loadURL returns a promise in Electron >= 5; older shapes return nothing,
      // so normalise before attaching the fallback — `Promise.resolve(undefined)`
      // simply never rejects there.
      void Promise.resolve(el.loadURL(url)).catch((e: any) => {
        // Fall back to setting src directly — works before the guest attaches.
        try { el.src = url } catch { setError(e?.message ?? '导航失败') }
      })
    } catch {
      try { el.src = url } catch { setError('导航失败') }
    }
  }, [])

  // 监听 Agent 或全局分发的网页导航事件
  useEffect(() => {
    const handleNavEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ url?: string; input?: string }>
      const target = customEvent.detail?.url || customEvent.detail?.input
      if (target && typeof target === 'string') {
        navigate(target)
      }
    }

    window.addEventListener('ovolve:browser-navigate', handleNavEvent)
    window.addEventListener('ovolve:browser-navigate', handleNavEvent)

    let removeIpc: (() => void) | undefined
    if (isElectron && window.electronAPI?.on) {
      removeIpc = window.electronAPI.on('browser:navigate', (url: string) => {
        if (url && typeof url === 'string') {
          navigate(url)
        }
      })
    }

    return () => {
      window.removeEventListener('ovolve:browser-navigate', handleNavEvent)
      window.removeEventListener('ovolve:browser-navigate', handleNavEvent)
      if (removeIpc) removeIpc()
    }
  }, [navigate, isElectron])

  if (!isElectron) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
        <Globe size={28} className="text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground">
          内嵌浏览器需要在 Electron 桌面端运行。
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Address bar */}
      {/* 头部即地址栏（导航按钮 + 输入框），不是"标题 + 操作"结构，
          不套 PanelHeader——窄列里塞一个"浏览器"标题纯属浪费宽度。 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/10 shrink-0">
        <button
          onClick={() => viewRef.current?.goBack()}
          disabled={!canBack}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 transition-colors"
          aria-label="后退"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={() => viewRef.current?.goForward()}
          disabled={!canFwd}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 transition-colors"
          aria-label="前进"
        >
          <ArrowRight size={14} />
        </button>
        <button
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label={loading ? '停止' : '刷新'}
        >
          {loading ? <X size={14} /> : <RotateCw size={14} />}
        </button>
        <button
          onClick={() => navigate(HOME)}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="主页"
        >
          <Home size={14} />
        </button>

        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && navigate(address)}
          placeholder="搜索或输入网址"
          className="h-7 text-xs flex-1 min-w-0"
        />

        {loading && <Loader2 size={13} className="animate-spin text-muted-foreground shrink-0" />}
        <button
          onClick={() => currentUrl && window.electronAPI?.invoke('system:openExternal', currentUrl)}
          disabled={!currentUrl}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 transition-colors"
          aria-label="在系统浏览器中打开"
          title="在系统浏览器中打开"
        >
          <ExternalLink size={13} />
        </button>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-destructive bg-destructive/10 border-b border-destructive/20 shrink-0">
          {error}
        </div>
      )}

      {/* Live page — this IS the browser, embedded in the panel. Created via
          React.createElement so we don't need JSX typings for <webview>. */}
      <div ref={containerRef} className="flex-1 min-h-0 relative bg-white">
        {createElement('webview', {
          src: HOME,
          class: 'absolute inset-0 w-full h-full',
          allowpopups: 'true',
        })}
      </div>

      {/* Slim status bar — page title + URL. The AI drives the page itself, so
          there is no manual selector/click/fill tooling here on purpose. */}
      <div className="border-t border-border/10 shrink-0 px-2.5 py-1.5 bg-muted/30">
        <div className="text-[10px] text-muted-foreground truncate" title={currentUrl}>
          {title ? `${title} · ` : ''}{currentUrl || '—'}
        </div>
      </div>
    </div>
  )
}
