// src/components/workspace/CodeEditorPanel.tsx
// Right-hand workspace Code / Diff Editor tab (IDE / VSCode standard).
// Displays live file diffs, breadcrumbs, line numbers, syntax highlighting, and copy tools.
import { useState, useMemo, useEffect, useRef } from 'react'
import { Copy, Check, FileCode, ChevronRight, X, Loader2 } from 'lucide-react'
import { useSidePanelStore } from '@store/sidePanelStore'
import { fetchGitDiff } from '@lib/gitApi'
import { OfficialFileIcon } from '@components/ui/OfficialFileIcon'
import { cn } from '@lib/utils'
import hljs from 'highlight.js/lib/core'
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

// Register common languages
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

type DiffLine = {
 type: 'add' | 'remove' | 'context' | 'hunk'
 text: string
 oldLineNo?: number
 newLineNo?: number
}

/** 转义纯文本为 HTML（无语言高亮时的兜底，也修掉代码里的尖括号被当标签吞掉的问题）。 */
function escapeHtml(s: string): string {
 return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 对整段代码做一次语法高亮，再按行切分 HTML。
 * 逐行高亮会把跨行注释/字符串/模板串切开，导致从第二行开始着色错乱；
 * 先高亮全文再切行，切到换行处时把未闭合的 span 闭合、下一行重新打开。
 */
function splitHighlightedLines(code: string, lang?: string): string[] {
 if (!code) return []
 const html = lang
 ? (() => { try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value } catch { return escapeHtml(code) } })()
 : escapeHtml(code)
 const lines: string[] = []
 const stack: string[] = []
 let buf = ''
 let i = 0
 const openTags = () => stack.map((t) => `<${t}>`).join('')
 const closeTags = () => stack.map(() => '</span>').reverse().join('')
 while (i < html.length) {
 const ch = html[i]
 if (ch === '<') {
 const close = html.indexOf('>', i)
 if (close === -1) { buf += html.slice(i); break }
 const tag = html.slice(i, close + 1)
 buf += tag
 const closing = tag.match(/^<\/([\w-]+)/)
 if (closing) {
 const idx = stack.lastIndexOf(closing[1])
 if (idx !== -1) stack.splice(idx, 1)
 } else if (!tag.endsWith('/>')) {
 const opening = tag.match(/^<([\w-]+)/)
 if (opening) stack.push(opening[1])
 }
 i = close + 1
 continue
 }
 if (ch === '\n') {
 lines.push(openTags() + buf + closeTags())
 buf = ''
 i++
 continue
 }
 const nextTag = html.indexOf('<', i)
 const nextNl = html.indexOf('\n', i)
 if (nextTag === -1 && nextNl === -1) { buf += html.slice(i); break }
 const stop = nextTag === -1 ? nextNl : nextNl === -1 ? nextTag : Math.min(nextTag, nextNl)
 buf += html.slice(i, stop)
 i = stop
 }
 lines.push(openTags() + buf + closeTags())
 return lines
}

/** 从 unified diff 里数出精确的增删行数（chip 上的 +N/-N 用）。 */
function countDiffLines(diff: string): { added?: number; removed?: number } {
 let added = 0
 let removed = 0
 for (const row of diff.split('\n')) {
 if (row.startsWith('+') && !row.startsWith('+++')) added++
 else if (row.startsWith('-') && !row.startsWith('---')) removed++
 }
 return {
 added: added > 0 ? added : undefined,
 removed: removed > 0 ? removed : undefined,
 }
}

export function CodeEditorPanel() {
 const activeEditor = useSidePanelStore((s) => s.activeEditor)
 const closeTab = useSidePanelStore((s) => s.closeTab)
 const [copied, setCopied] = useState(false)
 const [switching, setSwitching] = useState<string | null>(null)
 const [switchError, setSwitchError] = useState<string | null>(null)
 const bodyRef = useRef<HTMLDivElement | null>(null)
 const scrolledRef = useRef('')

 const filename = activeEditor?.filename || 'Untitled'
 const filePath = activeEditor?.filePath || filename
 const targetContent = activeEditor?.targetContent || ''
 const replacementContent = activeEditor?.replacementContent || ''
 const startLine = activeEditor?.startLine || 1
 const added = activeEditor?.added
 const removed = activeEditor?.removed

 // Compute breadcrumbs: e.g. "src > pages > Component.tsx"
 const breadcrumbs = useMemo(() => {
 const clean = filePath.replace(/\\/g, '/')
 const parts = clean.split('/').filter(Boolean)
 if (parts.length <= 1) return [filename]
 // Return last 3 components for compact breadcrumb
 return parts.slice(-3)
 }, [filePath, filename])

  // Compute Diff / Code Viewer Lines
  const { lines, lang, fullRawCode } = useMemo(() => {
    const detectedLang = detectLang(filename)
    const diffLines: DiffLine[] = []

    if (activeEditor?.diff) {
      const rawDiff = activeEditor.diff
      const diffRows = rawDiff.split('\n')
      let oldCounter = 1
      let newCounter = 1
      let inHunk = false
      for (const row of diffRows) {
        if (row.startsWith('@@')) {
          inHunk = true
          const match = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
          if (match) {
            oldCounter = parseInt(match[1], 10)
            newCounter = parseInt(match[2], 10)
          }
          diffLines.push({ type: 'hunk', text: row })
        } else if (inHunk) {
          if (row.startsWith('+') && !row.startsWith('+++')) {
            diffLines.push({ type: 'add', text: row.slice(1), newLineNo: newCounter++ })
          } else if (row.startsWith('-') && !row.startsWith('---')) {
            diffLines.push({ type: 'remove', text: row.slice(1), oldLineNo: oldCounter++ })
          } else if (row.startsWith(' ')) {
            diffLines.push({ type: 'context', text: row.slice(1), oldLineNo: oldCounter++, newLineNo: newCounter++ })
          } else if (row.startsWith('\\')) {
            continue
          }
        }
      }
    } else if (activeEditor?.content !== undefined) {
      // Pure viewer mode (e.g. read_file, search result jump, or exploring codebase)
      const rawText = activeEditor.content || ''
      const rawLines = rawText.split('\n')
      let counter = startLine
      for (const l of rawLines) {
        diffLines.push({ type: 'context', text: l, newLineNo: counter })
        counter++
      }
    } else if (targetContent && replacementContent) {
      // Replace operation: old lines then new lines
      const oldLines = targetContent.split('\n')
      const newLines = replacementContent.split('\n')

      let oldCounter = startLine
      let newCounter = startLine

      for (const l of oldLines) {
        diffLines.push({ type: 'remove', text: l, oldLineNo: oldCounter })
        oldCounter++
      }
      for (const l of newLines) {
        diffLines.push({ type: 'add', text: l, newLineNo: newCounter })
        newCounter++
      }
    } else if (replacementContent) {
      // New file or overwrite: all added lines
      const newLines = replacementContent.split('\n')
      let counter = startLine
      for (const l of newLines) {
        diffLines.push({ type: 'add', text: l, newLineNo: counter })
        counter++
      }
    } else if (targetContent) {
      // Deletion
      const oldLines = targetContent.split('\n')
      let counter = startLine
      for (const l of oldLines) {
        diffLines.push({ type: 'remove', text: l, oldLineNo: counter })
        counter++
      }
    }

    const fullCode = activeEditor?.content ?? (replacementContent || targetContent || activeEditor?.diff || '')
    return { lines: diffLines, lang: detectedLang, fullRawCode: fullCode }
  }, [filename, targetContent, replacementContent, activeEditor?.content, activeEditor?.diff, startLine])

  const isDiffMode = Boolean(activeEditor?.diff || targetContent || replacementContent || (!activeEditor?.readOnly && (added !== undefined || removed !== undefined)))

 // 整段高亮一次后按行切分（见 splitHighlightedLines 注释）；hunk 行不是代码，
 // 不参与高亮文本流，按原位置跳过。
 const highlightedLines = useMemo(() => {
 const codeText = lines.filter((l) => l.type !== 'hunk').map((l) => l.text).join('\n')
 const parts = splitHighlightedLines(codeText, lang)
 let idx = 0
 return lines.map((l) => (l.type === 'hunk' ? '' : (parts[idx++] ?? escapeHtml(l.text))))
 }, [lines, lang])

 // 搜索/对话跳转带的 startLine：渲染完成后滚到对应行。
 // 此前这个字段只被拿去当行号基数，面板永远停在文件顶部。
 useEffect(() => {
 if (!activeEditor) return
 const key = `${activeEditor.filePath}:${startLine}`
 if (scrolledRef.current === key) return
 scrolledRef.current = key
 if (!startLine || startLine <= 1) return
 const id = window.setTimeout(() => {
 const row = bodyRef.current?.querySelector(`[data-line-no="${startLine}"]`)
 row?.scrollIntoView({ block: 'center' })
 }, 80)
 return () => window.clearTimeout(id)
 }, [activeEditor, startLine])

  const displayAdded = useMemo(() => {
    if (!isDiffMode) return undefined
    if (added !== undefined) return added
    const computed = lines.filter(l => l.type === 'add').length
    return computed > 0 ? computed : undefined
  }, [lines, added, isDiffMode])

  const displayRemoved = useMemo(() => {
    if (!isDiffMode) return undefined
    if (removed !== undefined) return removed
    const computed = lines.filter(l => l.type === 'remove').length
    return computed > 0 ? computed : undefined
  }, [lines, removed, isDiffMode])

 const handleCopy = () => {
 if (!fullRawCode) return
 navigator.clipboard.writeText(fullRawCode)
 setCopied(true)
 setTimeout(() => setCopied(false), 2000)
 }

 if (!activeEditor) {
 return (
 <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-6 select-none">
 <FileCode size={32} strokeWidth={1.5} className="text-muted-foreground/40" />
 <div className="text-[13px] font-medium text-foreground/80">代码与差异编辑器</div>
 <div className="text-xs text-muted-foreground/80 max-w-[240px] leading-relaxed">
 点击对话流中的文件编辑卡片，或打开工作区文件即可在此查看实时代码变更与源码。
 </div>
 </div>
 )
 }

 return (
 <div className="flex flex-col h-full bg-background select-text overflow-hidden">
 {/* ── 1. Top Breadcrumb & Actions Bar (IDE / VSCode standard) ── */}
 <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-card/50 backdrop-blur-md shrink-0 select-none">
 {/* Breadcrumb path */}
 <div className="flex items-center gap-1 text-[11.5px] text-muted-foreground/80 truncate min-w-0 pr-2">
 {breadcrumbs.map((part, idx) => {
 const isLast = idx === breadcrumbs.length - 1
 return (
 <div key={idx} className="flex items-center gap-1 truncate shrink-0">
 {idx > 0 && <ChevronRight size={11} className="text-muted-foreground/40 shrink-0" />}
 {isLast ? (
 <div className="flex items-center gap-1.5 font-semibold text-foreground shrink-0">
 <OfficialFileIcon filename={filename} size={14} />
 <span className="truncate">{part}</span>
 </div>
 ) : (
 <span className="truncate">{part}</span>
 )}
 </div>
 )
 })}
 </div>

 {/* Action Controls */}
 <div className="flex items-center gap-1 shrink-0">
 {isDiffMode ? (
 (displayAdded !== undefined || displayRemoved !== undefined) && (
 <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-muted/60 text-[10px] font-mono font-medium border border-border/30 mr-1">
 {displayAdded !== undefined && displayAdded > 0 && <span className="text-emerald-500 font-semibold">+{displayAdded}</span>}
 {displayRemoved !== undefined && displayRemoved > 0 && <span className="text-rose-500 font-semibold">-{displayRemoved}</span>}
 </div>
 )
 ) : (
 !activeEditor.fileNotFound && (
 <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-muted/60 text-[10px] font-mono text-muted-foreground border border-border/30 mr-1">
 <span>源码视图</span>
 <span>({lines.length} 行)</span>
 </div>
 )
 )}

 <button
 type="button"
 onClick={handleCopy}
 disabled={!fullRawCode}
 className="p-1 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-40"
 title={isDiffMode ? '复制 Diff 原文' : '复制代码'}
 >
 {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
 </button>

 <button
 type="button"
 onClick={() => closeTab('editor')}
 className="p-1 rounded-lg hover:bg-card text-muted-foreground hover:text-foreground transition-colors ml-0.5 cursor-pointer"
 title="关闭面板"
 >
 <X size={13} />
 </button>
 </div>
 </div>

 {/* ── Multi-File Review Switcher (IDE standard) ── */}
 {activeEditor.allFiles && activeEditor.allFiles.length > 1 && (
 <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-1.5 border-b border-border/40 bg-muted/30 select-none no-scrollbar shrink-0">
 <span className="text-[10px] text-muted-foreground/70 font-sans shrink-0 uppercase tracking-wider font-semibold">
 {activeEditor.allFiles.length} 个变更:
 </span>
 {activeEditor.allFiles.map((f, i) => {
 const isSelected = f.filePath === filePath || f.filename === filename
 // +N/-N 优先级：显式 added/removed > 从 diff 精确计数 > 按内容行数估算。
 // 此前把"整文件行数"排在前面，与头部精确值对不上。
 const counted = f.diff ? countDiffLines(f.diff) : {}
 const fAdded = f.added ?? counted.added ?? (f.replacementContent !== undefined && f.replacementContent !== '' ? f.replacementContent.split('\n').length : undefined)
 const fRemoved = f.removed ?? counted.removed ?? (f.targetContent !== undefined && f.targetContent !== '' ? f.targetContent.split('\n').length : undefined)
 return (
            <button
              key={i}
              type="button"
              disabled={switching !== null}
              onClick={async () => {
                if (f.diff !== undefined || f.targetContent || f.replacementContent || f.content) {
                  useSidePanelStore.getState().openEditor({ ...f, allFiles: activeEditor.allFiles })
                  return
                }
                setSwitching(f.filePath)
                setSwitchError(null)
                try {
                  const res = await fetchGitDiff(f.filePath)
                  useSidePanelStore.getState().openEditor({
                    filename: f.filename,
                    filePath: f.filePath,
                    diff: res.diff,
                    targetContent: res.targetContent,
                    replacementContent: res.replacementContent,
                    added: res.additions,
                    removed: res.deletions,
                    allFiles: activeEditor.allFiles,
                  })
                } catch {
                  // 静默回退会打开一个空 payload，用户只看到白屏不知所以然
                  setSwitchError(`无法读取「${f.filename}」的差异，已保留当前内容`)
                } finally {
                  setSwitching(null)
                }
              }}
              className={cn(
                'flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-mono transition-all shrink-0 cursor-pointer border disabled:opacity-60',
                isSelected
                  ? 'bg-card shadow-xs text-foreground font-semibold border-border/80 text-primary'
                  : 'bg-transparent text-muted-foreground hover:text-foreground border-transparent hover:bg-muted/50'
              )}
            >
 {switching === f.filePath && <Loader2 size={11} className="animate-spin shrink-0" />}
 <OfficialFileIcon filename={f.filename} size={12} />
 <span className="truncate max-w-[120px]">{f.filename}</span>
 {(fAdded !== undefined || fRemoved !== undefined) && (
 <span className="text-[9.5px] tabular-nums font-mono">
 {fAdded ? <span className="text-emerald-500 font-semibold">+{fAdded}</span> : null}
 {fRemoved ? <span className="text-rose-500 font-semibold">-{fRemoved}</span> : null}
 </span>
 )}
 </button>
 )
 })}
 </div>
 )}

 {/* 切换失败提示（可关闭） */}
 {switchError && (
 <div className="flex items-center gap-2 px-3 py-1.5 border-b border-destructive/20 bg-destructive/10 text-[11px] text-destructive shrink-0">
 <span className="truncate flex-1">{switchError}</span>
 <button type="button" onClick={() => setSwitchError(null)} className="shrink-0 hover:text-foreground" aria-label="关闭">
 <X size={12} />
 </button>
 </div>
 )}

 {/* ── 2. Full-height Code / Diff View Body (Theme-Adaptive) ── */}
 <div ref={bodyRef} className="flex-1 overflow-auto bg-card/40 dark:bg-[#121417] text-foreground dark:text-[#d4d4d4] font-mono text-[12px] leading-[1.65]">
 {activeEditor.fileNotFound ? (
 <div className="flex flex-col items-center justify-center h-full min-h-[280px] text-center gap-3 px-6 py-10 select-none">
 <div className="p-3 rounded-2xl bg-muted/50 border border-border/50 text-muted-foreground/60">
 <FileCode size={30} strokeWidth={1.5} />
 </div>
 <div className="space-y-1.5 max-w-sm">
 <div className="text-sm font-semibold text-foreground">文件在工作区中不存在</div>
 <div className="text-xs text-muted-foreground leading-relaxed">
 未在工作区找到路径 <code className="font-mono text-[11px] bg-muted/80 px-1.5 py-0.5 rounded border border-border/50 text-foreground/90">{filePath}</code>
 </div>
 <p className="text-[11px] text-muted-foreground/70">
 该文件尚未创建，或位于其他目录。您可以在对话中让 Agent 帮您新建此文件。
 </p>
 </div>
 </div>
 ) : lines.length === 0 ? (
 <div className="p-4 text-xs text-muted-foreground/60">
 {fullRawCode ? (
 <pre className="whitespace-pre font-mono p-3 text-foreground">{fullRawCode}</pre>
 ) : (
 <table className="w-full border-collapse select-text">
 <tbody>
 <tr className="hover:bg-muted/40 transition-colors">
 <td className="w-10 pl-2 pr-2 text-right text-[11px] text-muted-foreground/50 select-none shrink-0 border-r border-border/50 font-mono tabular-nums">
 1
 </td>
 <td className="w-5 text-center text-[11.5px] select-none shrink-0 text-transparent">
 &nbsp;
 </td>
 <td className="px-2 py-0 whitespace-pre font-mono text-muted-foreground/40 italic">
 (空文件)
 </td>
 </tr>
 </tbody>
 </table>
 )}
 </div>
 ) : (
 <table className="w-full border-collapse select-text">
 <tbody>
        {lines.map((line, idx) => {
          if (line.type === 'hunk') {
            return (
              <tr
                key={idx}
                className="bg-muted/40 dark:bg-white/[0.04] text-muted-foreground border-y border-border/30 font-mono text-[11px] select-none"
              >
                <td colSpan={3} className="px-3 py-1 font-semibold tracking-wide text-primary/80">
                  {line.text}
                </td>
              </tr>
            )
          }

          const isAdd = line.type === 'add'
          const isRemove = line.type === 'remove'
          const displayLineNo = isAdd ? line.newLineNo : (line.newLineNo ?? line.oldLineNo)
          const highlighted = highlightedLines[idx] ?? escapeHtml(line.text)

 return (
 <tr
 key={idx}
 data-line-no={displayLineNo !== undefined ? displayLineNo : undefined}
 className={cn(
 'hover:bg-muted/40 dark:hover:bg-white/[0.04] transition-colors',
 isAdd && 'bg-emerald-500/10 dark:bg-emerald-500/15 text-emerald-950 dark:text-emerald-200 font-medium',
 isRemove && 'bg-rose-500/10 dark:bg-rose-500/15 text-rose-950 dark:text-rose-200 opacity-80'
 )}
 >
 {/* Line number gutter */}
 <td className="w-10 pl-2 pr-2 text-right text-[11px] text-muted-foreground/50 select-none shrink-0 border-r border-border/50 dark:border-white/5 font-mono tabular-nums">
 {displayLineNo ?? ''}
 </td>

 {/* Diff indicator (+/-) */}
 <td
 className={cn(
 'w-5 text-center text-[11.5px] font-bold select-none shrink-0',
 isAdd ? 'text-emerald-600 dark:text-emerald-400' : isRemove ? 'text-rose-600 dark:text-rose-400' : 'text-transparent'
 )}
 >
 {isAdd ? '+' : isRemove ? '-' : ' '}
 </td>

 {/* Code line */}
 <td className="px-2 py-0 whitespace-pre overflow-x-visible font-mono">
 <span className="hljs" dangerouslySetInnerHTML={{ __html: highlighted || '&nbsp;' }} />
 </td>
 </tr>
 )
 })}
 </tbody>
 </table>
 )}
 </div>
 </div>
 )
}
export default CodeEditorPanel
