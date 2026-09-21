// src/components/chat/CodeDiffView.tsx
// Inline syntax-highlighted code diff preview (IDE / IDE style)
// Uses highlight.js (already bundled via rehype-highlight) for syntax coloring.

import { useMemo } from 'react'
import { cn } from '@lib/utils'
import hljs from 'highlight.js/lib/core'
// Register only the languages we're likely to see in tool calls
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import xml from 'highlight.js/lib/languages/xml'
import markdown from 'highlight.js/lib/languages/markdown'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('css', css)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('sql', sql)

// ── Language detection from filename extension ──
function detectLang(filename: string): string | undefined {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyw: 'python',
    css: 'css', scss: 'css', less: 'css',
    json: 'json', jsonc: 'json',
    sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'bash', ps1: 'bash',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    md: 'markdown', mdx: 'markdown',
    rs: 'rust',
    go: 'go',
    yaml: 'yaml', yml: 'yaml',
    sql: 'sql',
    toml: 'yaml',
  }
  return ext ? map[ext] : undefined
}

// ── Line type for diff rendering ──
type DiffLine = {
  type: 'add' | 'remove' | 'context'
  text: string
  lineNo: number | null  // line number in the relevant side
}

interface CodeDiffViewProps {
  /** Old code being replaced (TargetContent). Omit for write_to_file (all additions). */
  targetContent?: string
  /** New code (ReplacementContent / CodeContent). */
  replacementContent?: string
  /** Filename for language detection. */
  filename?: string
  /** Starting line number in the file (args.StartLine). */
  startLine?: number
  /** Max visible height before scrolling. */
  maxHeight?: string
}

export function CodeDiffView({
  targetContent,
  replacementContent,
  filename = '',
  startLine = 1,
  maxHeight = '320px',
}: CodeDiffViewProps) {
  const { lines, lang } = useMemo(() => {
    const detectedLang = detectLang(filename)

    const diffLines: DiffLine[] = []

    // Build diff lines
    if (targetContent && replacementContent) {
      // Replace operation: show removed lines then added lines
      const oldLines = targetContent.split('\n')
      const newLines = replacementContent.split('\n')

      let lineCounter = startLine

      // Removed lines (from old)
      for (const line of oldLines) {
        diffLines.push({ type: 'remove', text: line, lineNo: lineCounter })
        lineCounter++
      }

      // Reset counter for new lines (they replace at the same position)
      lineCounter = startLine
      for (const line of newLines) {
        diffLines.push({ type: 'add', text: line, lineNo: lineCounter })
        lineCounter++
      }
    } else if (replacementContent) {
      // Write / create: all lines are additions
      const newLines = replacementContent.split('\n')
      let lineCounter = startLine
      for (const line of newLines) {
        diffLines.push({ type: 'add', text: line, lineNo: lineCounter })
        lineCounter++
      }
    } else if (targetContent) {
      // Delete only (rare)
      const oldLines = targetContent.split('\n')
      let lineCounter = startLine
      for (const line of oldLines) {
        diffLines.push({ type: 'remove', text: line, lineNo: lineCounter })
        lineCounter++
      }
    }

    return { lines: diffLines, lang: detectedLang }
  }, [targetContent, replacementContent, filename, startLine])

  // Highlight each line individually so diff coloring applies per-line
  const highlightedLines = useMemo(() => {
    return lines.map((dl) => {
      let html: string
      try {
        if (lang) {
          html = hljs.highlight(dl.text, { language: lang, ignoreIllegals: true }).value
        } else {
          html = hljs.highlightAuto(dl.text).value
        }
      } catch {
        // Fallback: escape HTML
        html = dl.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
      }
      return { ...dl, html }
    })
  }, [lines, lang])

  if (highlightedLines.length === 0) return null

  // Gutter width based on max line number digits
  const maxLineNo = Math.max(...highlightedLines.map(l => l.lineNo ?? 0), 1)
  const gutterWidth = String(maxLineNo).length

  return (
    <div
      className="rounded-xl border border-border/80 dark:border-white/10 overflow-hidden my-2 bg-card/75 dark:bg-card/45 backdrop-blur-xl shadow-2xs"
      style={{ maxHeight }}
    >
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
          <tbody>
            {highlightedLines.map((line, i) => (
              <tr
                key={i}
                className={cn(
                  'transition-colors',
                  line.type === 'add'
                    ? 'bg-emerald-500/12 dark:bg-emerald-500/10'
                    : line.type === 'remove'
                      ? 'bg-rose-500/12 dark:bg-rose-500/10'
                      : 'hover:bg-muted/30',
                )}
              >
                {/* Line number gutter */}
                <td
                  className="select-none text-right pr-2.5 pl-2.5 text-muted-foreground/50 align-top shrink-0 border-r border-border/50 text-[11px]"
                  style={{ width: `${gutterWidth + 2}ch`, minWidth: `${gutterWidth + 2}ch` }}
                >
                  {line.lineNo ?? ''}
                </td>
                {/* Diff marker: + / - */}
                <td
                  className={`select-none w-5 text-center align-top font-bold text-xs ${
                    line.type === 'add'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : line.type === 'remove'
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-transparent'
                  }`}
                >
                  {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
                </td>
                {/* Code content with syntax highlighting */}
                <td className="pr-3 pl-1 align-top">
                  <span
                    className={`hljs ${line.type === 'remove' ? 'line-through opacity-75' : ''}`}
                    dangerouslySetInnerHTML={{ __html: line.html || '&nbsp;' }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
