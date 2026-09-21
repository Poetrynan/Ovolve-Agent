/**
 * MermaidBlock — renders a ```mermaid fenced block as an actual diagram.
 *
 * Two deliberate choices:
 *
 * 1. **Lazy `import()`.** Mermaid is ~500 KB parsed. Loading it eagerly would
 *    tax every cold start for a feature most turns never use. The import fires
 *    the first time a mermaid fence actually appears.
 *
 * 2. **Render-to-string, not render-in-place.** `mermaid.render()` returns SVG
 *    markup which we inject once. Letting mermaid own a live DOM node fights
 *    React's reconciler — mermaid mutates the node, React later reuses it, and
 *    you get duplicated or blanked diagrams on re-render.
 *
 * A model that emits invalid mermaid is the common case, not the exception, so
 * a parse failure degrades to the raw source in a bordered box rather than
 * throwing — a broken diagram must never take the whole message down.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useThemeStore } from '@store/themeStore'

let seq = 0

export function MermaidBlock({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)
  // Guards against a late resolve landing after unmount / after the source
  // changed — otherwise a slow first-load render can overwrite a newer diagram.
  const tokenRef = useRef(0)

  useEffect(() => {
    const myToken = ++tokenRef.current
    let cancelled = false
    setFailed(false)
    setSvg(null)

    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          // Match the app chrome; a light diagram on an OLED background is the
          // single most jarring thing this feature can do.
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
          securityLevel: 'strict',
          fontFamily: 'inherit',
        })
        const id = `mb-${++seq}`
        const { svg: out } = await mermaid.render(id, source)
        if (!cancelled && tokenRef.current === myToken) setSvg(out)
      } catch {
        if (!cancelled && tokenRef.current === myToken) setFailed(true)
      }
    })()

    return () => { cancelled = true }
  }, [source, resolvedTheme])

  if (failed) {
    return (
      <div className="my-2 rounded-lg border border-border/40 bg-muted/20 overflow-hidden">
        <div className="px-3 py-1 bg-muted/30 border-b border-border/40 text-[10.5px] text-muted-foreground/80">
          mermaid · 无法渲染，显示源码
        </div>
        <pre className="p-3 overflow-x-auto text-[0.8rem] leading-relaxed font-mono whitespace-pre">
          {source}
        </pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border/40 bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
        <Loader2 size={13} className="animate-spin" />
        正在渲染图表…
      </div>
    )
  }

  return (
    <div
      className="my-2 rounded-lg border border-border/40 bg-muted/10 p-3 overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
      // Safe: mermaid runs with securityLevel 'strict', which strips script
      // tags and inline handlers from the generated SVG.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
