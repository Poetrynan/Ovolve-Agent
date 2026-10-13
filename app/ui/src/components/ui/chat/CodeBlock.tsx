/**
 * CodeBlock — the wrapper we put around every fenced ``` block in an assistant
 * message. The `<code>` child inside is already highlighted by rehype-highlight
 * (via lowlight) — this component adds the two things every serious chat UI
 * has and monochrome `<pre>` doesn't:
 *
 *   · a language pill on the top-left, so a user can see at a glance what the
 *     model produced (and, when the model omits the fence language, "text"
 *     tells them highlighting simply wasn't possible for this block)
 *   · a copy button on the top-right, because 90% of code in a chat UI ends
 *     up in another editor
 *
 * The copy button also handles the case where rehype-highlight's output is
 * a nested tree of spans — we walk the React children to reassemble the raw
 * text, so the clipboard gets the code the user sees, not the source markdown
 * (which may have been slightly different after list/quote nesting).
 */
import { isValidElement, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy, ArrowUpRight } from 'lucide-react'
import { OfficialFileIcon } from '@/components/ui/OfficialFileIcon'
import { useSidePanelStore } from '@/store/sidePanelStore'
import { cn } from '@/lib/utils'

interface CodeBlockProps {
  /** The `<code>` element react-markdown handed us (already highlighted). */
  codeNode: ReactNode
  /** Language pulled from `language-xxx` on the code element. */
  language: string
}

/** Depth-first stringifier — the highlighted tree is nested spans of text. */
function extractText(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children)
  return ''
}

export function CodeBlock({ codeNode, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const label = (language || 'text').toLowerCase()
  const displayLang = language ? language.charAt(0).toUpperCase() + language.slice(1) : 'Text'

  const rawText = useMemo(() => {
    return extractText(codeNode).replace(/\n$/, '')
  }, [codeNode])

  const lineCount = useMemo(() => {
    return rawText ? rawText.split('\n').length : 1
  }, [rawText])

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rawText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // ignore
    }
  }, [rawText])

  const onOpenSideEditor = useCallback(() => {
    useSidePanelStore.getState().openEditor({
      filePath: `snippet.${label}`,
      filename: `snippet.${label}`,
      replacementContent: rawText,
      action: 'Snippet',
    })
  }, [rawText, label])

  return (
    <div className="group relative my-3 rounded-xl border border-border/80 dark:border-white/10 bg-card/85 dark:bg-[#14161a] backdrop-blur-xl shadow-xs overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-muted/40 dark:bg-white/[0.03] border-b border-border/70 dark:border-white/10 text-[11px] font-mono select-none">
        <div className="flex items-center gap-1.5 font-medium text-foreground/90">
          <OfficialFileIcon filename={`file.${label}`} size={14} />
          <span className="font-semibold text-foreground/90">{displayLang}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenSideEditor}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background/80 dark:hover:bg-white/10 transition-all shadow-2xs border border-transparent hover:border-border/60 cursor-pointer"
            title="在右侧侧边栏打开完整代码编辑器"
          >
            <ArrowUpRight size={12} />
            <span>侧栏查看</span>
          </button>

          <button
            type="button"
            onClick={onCopy}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background/80 dark:hover:bg-white/10 transition-all shadow-2xs border border-transparent hover:border-border/60 cursor-pointer',
              copied && 'text-emerald-500 font-medium',
            )}
            aria-label={copied ? '已复制' : '复制代码'}
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            <span>{copied ? '已复制' : '复制代码'}</span>
          </button>
        </div>
      </div>

      {/* Code body with line numbers */}
      <div className="flex overflow-x-auto text-[12.5px] leading-relaxed font-mono selection:bg-primary/20">
        {lineCount > 1 && (
          <div className="py-3.5 pl-3 pr-2 select-none text-right text-muted-foreground/40 text-[11px] font-mono border-r border-border/40 dark:border-white/5 shrink-0 tabular-nums">
            {Array.from({ length: lineCount }).map((_, i) => (
              <div key={i} className="leading-relaxed">
                {i + 1}
              </div>
            ))}
          </div>
        )}
        <pre className="p-3.5 flex-1 overflow-x-auto text-[12.5px] leading-relaxed font-mono">
          {codeNode}
        </pre>
      </div>
    </div>
  )
}
export default CodeBlock
