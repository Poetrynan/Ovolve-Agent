// src/components/ui/chat/MarkdownContent.tsx
// Renders assistant messages as rich Markdown (GFM tables, code blocks, bold,
// lists, etc.) instead of raw `whitespace-pre-wrap` plaintext.
//
// Fenced blocks get special treatment by language:
//   ```diff      → red/green hunk (DiffBlock)
//   ```mermaid   → rendered diagram (MermaidBlock, lazy)
//   everything   → syntax-highlighted (rehype-highlight) + copy button (CodeBlock)
//
// GFM task lists (`- [ ] step`) are routed to PlanBlock — the model emits plans
// that way constantly and a progress header beats bare checkboxes.
//
// Inline `$…$` / block `$$…$$` math renders via remark-math + rehype-katex.
import { isValidElement, memo, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { useSidePanelStore, openReadOnlyFileViewer } from '@/store/sidePanelStore'
import { cn } from '@/lib/utils'
import { Image, FileText } from 'lucide-react'
import { CodeBlock } from './CodeBlock'

import { DiffBlock } from './DiffBlock'
import { MermaidBlock } from './MermaidBlock'
import { PlanBlock, PlanItemRow } from './PlanBlock'

interface Props {
  content: string
  className?: string
}

/** Pull `language-xxx` → `xxx` off the code element's className. */
function langOf(className?: string): string {
  const m = /language-([\w-]+)/.exec(className || '')
  return m ? m[1] : ''
}

/** Flatten a (possibly nested) react node back to text — for diff/mermaid raw source. */
function textOf(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

type MarkdownProps = ComponentProps<typeof ReactMarkdown>

/**
 * Everything below is hoisted to module scope on purpose.
 *
 * These used to be object/array literals written inline in the JSX, which meant
 * a fresh `components` map — 19 brand-new arrow-function component types — on
 * every single render. React compares component types by identity, so a new
 * identity is a DIFFERENT component: it tore down and rebuilt every heading,
 * paragraph, list and code fence in the message instead of updating them. While
 * a reply streams in, that happened once per token, and each rebuild threw away
 * CodeBlock's memoised text extraction and re-ran MermaidBlock's dynamic import.
 * Hoisted once, the identities are stable and React can reconcile in place.
 */
const REMARK_PLUGINS: MarkdownProps['remarkPlugins'] = [remarkGfm, remarkMath]

// `ignoreMissing` so an unknown fence language degrades to plain text instead of
// throwing; katex `throwOnError:false` for the same reason on malformed math (a
// half-typed formula mid-stream must not blow up).
const REHYPE_PLUGINS: MarkdownProps['rehypePlugins'] = [
  [rehypeHighlight, { ignoreMissing: true, detect: true }],
  [rehypeKatex, { throwOnError: false, errorColor: 'hsl(var(--destructive))' }],
]

const FILE_PATH_RE = /^([a-zA-Z]:[\\\/]|\/|\.\.?[\\\/]|~[\\\/])?[a-zA-Z0-9_\-\.\/\\]+\.(png|jpg|jpeg|gif|webp|svg|bmp|ico|py|ts|tsx|js|jsx|json|md|rs|go|css|html|log|txt|yaml|yml|toml|sh|bat|ps1|csv|sql|env|lock)$/i
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i

function isLikelyFilePath(text: string): boolean {
  if (!text || text.length > 260 || text.includes('\n') || text.includes('\r')) return false
  const t = text.trim()
  if (/^[a-zA-Z]:\\/i.test(t)) return true
  return FILE_PATH_RE.test(t)
}

function InlineFileChip({ path, children }: { path: string; children: ReactNode }) {
  const isImage = IMAGE_EXT_RE.test(path)
  const filename = path.split(/[\/\\]/).pop() || path

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (window.electronAPI?.invoke && isImage) {
      try {
        await window.electronAPI.invoke('system:openPath', path)
        return
      } catch {
        try {
          await window.electronAPI.invoke('system:showInFolder', path)
          return
        } catch {}
      }
    }

    await openReadOnlyFileViewer(path, filename, 1, 'Inspected')
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[0.82rem] px-1.5 py-0.5 rounded-md transition-all cursor-pointer align-baseline my-0.5 select-text group',
        isImage
          ? 'bg-sky-500/10 hover:bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-500/30 shadow-2xs'
          : 'bg-primary/5 hover:bg-primary/15 text-primary hover:underline border border-primary/25 shadow-2xs'
      )}
      title={`点击打开: ${path}`}
    >
      <span className="shrink-0 text-[11px] select-none flex items-center">
        {isImage ? <Image size={12} className="shrink-0 text-sky-500" /> : <FileText size={12} className="shrink-0 text-primary" />}
      </span>
      <span className="truncate max-w-[320px] font-medium">{children}</span>
    </button>
  )
}


const MD_COMPONENTS: MarkdownProps['components'] = {
  h1: ({ children }) => <h1 className="text-base font-bold mt-4 mb-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[0.95rem] font-bold mt-3 mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[0.9rem] font-semibold mt-2.5 mb-1">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  // A GFM task list (`- [ ] …`) is a plan, not a bullet list — remark-gfm
  // marks it with `contains-task-list`. Route it to the progress card.
  ul: ({ children, className: ulClassName, node }) => {
    if (/contains-task-list/.test(ulClassName || '')) {
      return <PlanBlock node={node as never}>{children}</PlanBlock>
    }
    return <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>
  },
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  // PlanItemRow detects the checkbox itself and falls back to a plain row
  // when there isn't one, so it is safe as the single `li` renderer.
  li: ({ children, node }) => <PlanItemRow node={node as never}>{children}</PlanItemRow>,
  // Suppress remark-gfm's disabled checkbox — PlanItemRow draws its own
  // icon. Markdown only ever produces task-list checkboxes here, so a
  // blanket null is safe and avoids a double control.
  input: () => null,

  // Inline code only — block code is handled by the `pre` override so we
  // can wrap it with a header + copy button. rehype-highlight has already
  // added the hljs token classes to this element's children.
  code: ({ children, className: codeClassName }) => {
    const isBlock = /language-/.test(codeClassName || '') || /\bhljs\b/.test(codeClassName || '')
    if (isBlock) {
      // Return the code element as-is; CodeBlock (via `pre`) wraps it.
      return <code className={codeClassName}>{children}</code>
    }
    const rawText = textOf(children).trim()
    if (isLikelyFilePath(rawText)) {
      return <InlineFileChip path={rawText}>{children}</InlineFileChip>
    }
    return (
      <code className="bg-foreground/[0.07] dark:bg-white/[0.12] border border-foreground/15 dark:border-white/20 rounded-md px-1.5 py-0.5 text-[0.82rem] font-mono text-foreground font-medium shadow-2xs select-text">
        {children}
      </code>
    )
  },
  // Block code. The single child is the <code> element above.
  pre: ({ children }) => {
    const codeEl = Array.isArray(children) ? children[0] : children
    const codeClassName = isValidElement(codeEl)
      ? ((codeEl.props as { className?: string }).className)
      : ''
    const language = langOf(codeClassName)

    if (language === 'diff') {
      return <DiffBlock source={textOf(codeEl)} />
    }
    if (language === 'mermaid') {
      return <MermaidBlock source={textOf(codeEl)} />
    }
    return <CodeBlock codeNode={codeEl} language={language} />
  },
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border/60">{children}</thead>,
  th: ({ children }) => <th className="text-left px-2 py-1.5 font-semibold text-muted-foreground">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1.5 border-t border-border/30">{children}</td>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-primary/40 pl-3 my-2 text-muted-foreground italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border/40 my-3" />,
  a: ({ href, children }) => {
    const isFileLink = href?.startsWith('file://') || href?.includes('#L') || /\.(rs|ts|tsx|js|jsx|py|go|json|md|css|html)(#|$)/i.test(href || '')
    if (isFileLink && href) {
      let cleanHref = href.trim()
      if (cleanHref.startsWith('file://')) cleanHref = cleanHref.replace(/^file:\/\//, '')
      const [pathOnlyRaw, hash] = cleanHref.split('#')
      let pathOnly = pathOnlyRaw
      try { pathOnly = decodeURIComponent(pathOnly) } catch {}
      pathOnly = pathOnly.replace(/^\/([a-zA-Z]:)/, '$1')

      const filename = pathOnly.split(/[\/\\]/).pop() || pathOnly
      const lineMatch = hash?.match(/L(\d+)/)
      const startLine = lineMatch ? parseInt(lineMatch[1], 10) : 1

      return (
        <button
          type="button"
          onClick={async (e) => {
            e.preventDefault()
            await openReadOnlyFileViewer(pathOnly, filename, startLine, 'Linked')
          }}
          className="inline-flex items-center gap-1 font-mono text-[0.82rem] px-1.5 py-0.5 rounded-md bg-muted/60 hover:bg-muted text-primary hover:underline transition-colors border border-border/40 cursor-pointer align-baseline my-0.5 select-text"
          title={`在编辑器中查看 ${pathOnly}`}
        >
          <span>{children}</span>
        </button>
      )
    }

    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
      >
        {children}
      </a>
    )
  },
}

/**
 * Prose-styled markdown renderer. Used inside <Bubble> for assistant messages.
 * Tailwind Typography-like inline styles without pulling in @tailwindcss/typography.
 *
 * `memo` is what stops the whole remark → rehype → highlight → katex pipeline
 * from re-running on messages that did not change. Parsing is by far the most
 * expensive thing a chat transcript does, and it used to happen for EVERY
 * message on every render of the page — including all the settled history, which
 * cannot possibly have changed. Both props are primitives, so the default
 * shallow compare is exactly the right check: same text, same output, skip.
 */
export const MarkdownContent = memo(function MarkdownContent({ content, className }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      className={cn('prose-chat select-text', className)}
      components={MD_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  )
})
