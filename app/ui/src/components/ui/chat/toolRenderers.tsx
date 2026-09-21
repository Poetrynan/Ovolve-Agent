// src/components/ui/chat/toolRenderers.tsx
// Per-tool result bodies. A generic key-value dump makes every tool look the
// same, which throws away the one thing the user actually wants to know at a
// glance: did the command pass, which file changed by how much, what did the
// search find.
//
// Each renderer degrades to the generic body if the payload isn't the shape it
// expects — a specialized view must never be the reason something is invisible.
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, FileCode2, FolderOpen, TerminalSquare, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/store/agentStore'
import type { ToolCall } from '@apptypes/index'

/** Which specialized body (if any) fits this tool. */
export type ToolKind = 'terminal' | 'file' | 'search' | 'generic'

const TERMINAL_TOOLS = /^(shell_executor|run_command|bash|shell|exec|terminal)$/i
const FILE_TOOLS = /^(write_file|edit_file|read_file|read_text|create_file|apply_patch|multi_edit)$/i
const SEARCH_TOOLS = /^(web_search|academic_search|semantic_search|search|grep|glob)$/i

export function toolKindOf(name: string): ToolKind {
  if (TERMINAL_TOOLS.test(name)) return 'terminal'
  if (FILE_TOOLS.test(name)) return 'file'
  if (SEARCH_TOOLS.test(name)) return 'search'
  return 'generic'
}

/** Small copy-to-clipboard button that confirms itself for a moment. */
function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch { /* clipboard denied — nothing useful to say */ }
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors"
      aria-label={label}
    >
      {done ? <Check size={10} className="text-success" /> : <Copy size={10} />}
      {done ? '已复制' : label}
    </button>
  )
}

// ── Terminal ────────────────────────────────────────────────────────────────

/** The real exit code if the backend sent one, else scraped from the text. */
function exitCodeOf(toolCall: ToolCall): number | null {
  // Prefer the field: it comes from `proc.returncode`, so `0` is trustworthy and
  // distinguishable from "no exit code". The regex below only ever worked when
  // the message happened to spell the number out.
  if (typeof toolCall.exitCode === 'number') return toolCall.exitCode
  const result = toolCall.result
  if (result == null) return null
  const m = String(result).match(/exit(?:\s+code)?[:=\s]+(-?\d+)/i)
  return m ? Number(m[1]) : null
}

/** Last two path segments — enough to identify a repo without eating the row. */
function shortDir(dir?: string): string {
  if (!dir) return ''
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/')
}

// Keys mirror `risk_control.PermissionMode`. The legacy spellings stay as
// aliases: a session restored from history still carries `ask`/`yolo` on its
// tool frames, and falling through to the raw token would show "yolo" in the UI.
const PERMISSION_LABEL: Record<string, string> = {
  plan: '只出方案',
  readonly: '只看不动',
  confirm: '每步问我',
  auto: '小事放手',
  full: '全权代理',
  ask: '每步问我',
  yolo: '全权代理',
  deny: '只看不动',
}

export function TerminalBody({ toolCall }: { toolCall: ToolCall }) {
  const cmd =
    toolCall.args?.command ??
    toolCall.args?.cmd ??
    toolCall.args?.script ??
    ''
  const running = toolCall.status === 'running' || toolCall.status === 'pending'
  // While streaming, `output` is the raw transcript; `result` is the settled
  // one-line preview the backend caps at 220 chars. Prefer the transcript even
  // after completion — it is the same text, unflattened.
  const out = toolCall.output || (toolCall.result != null ? String(toolCall.result) : '')
  const code = exitCodeOf(toolCall)
  const failed = toolCall.status === 'failed' || (code != null && code !== 0)
  const dir = shortDir(toolCall.cwd || toolCall.workspaceRoot)
  const perm = toolCall.permission
    ? PERMISSION_LABEL[toolCall.permission] ?? toolCall.permission
    : ''

  // Follow the tail while it streams, but stop fighting the user: once they
  // scroll up to read something, leave the viewport where they put it.
  const paneRef = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = paneRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [out])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <TerminalSquare size={11} className="text-muted-foreground shrink-0" />
        <span className="text-[10px] text-muted-foreground">终端</span>
        {dir && (
          <span
            className="inline-flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground"
            title={toolCall.cwd || toolCall.workspaceRoot}
          >
            <FolderOpen size={10} className="shrink-0" />
            <code className="truncate">{dir}</code>
          </span>
        )}
        {perm && (
          <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[9px] text-muted-foreground">
            {perm}
          </span>
        )}
        {toolCall.timedOut && (
          <span className="shrink-0 rounded bg-warning/15 px-1 py-px text-[9px] font-medium text-warning">
            超时终止
          </span>
        )}
        {code != null && (
          <span
            className={cn(
              'shrink-0 rounded px-1 py-px text-[9px] font-medium tabular-nums',
              failed ? 'bg-destructive/15 text-destructive' : 'bg-success/15 text-success',
            )}
          >
            Exit {code}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {cmd && <CopyButton text={String(cmd)} label="复制命令" />}
          {running && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                useAgentStore.getState().cancelTool(toolCall.id)
              }}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="终止这条命令（不会中断整个任务）"
            >
              <X size={10} />
              终止
            </button>
          )}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/90 shadow-md">
        {/* macOS Terminal Window Header */}
        <div className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/60 px-3 py-1.5 select-none">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70 inline-block" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70 inline-block" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70 inline-block" />
            <span className="ml-2 font-mono text-[10.5px] text-zinc-400 font-medium">Terminal</span>
            {dir && (
              <span className="font-mono text-[10px] text-zinc-500">
                ~/{dir}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {code != null && (
              <span
                className={cn(
                  'rounded px-1.5 py-0.2 text-[9.5px] font-mono font-medium',
                  failed ? 'bg-rose-500/20 text-rose-400' : 'bg-emerald-500/20 text-emerald-400',
                )}
              >
                Exit {code}
              </span>
            )}
            {cmd && <CopyButton text={String(cmd)} label="复制" />}
          </div>
        </div>

        {cmd ? (
          <div className="flex items-center gap-2 border-b border-zinc-800/40 bg-zinc-900/30 px-3 py-1.5 font-mono text-[11px]">
            <span className="shrink-0 select-none text-emerald-400 font-semibold">$</span>
            <code className="whitespace-pre-wrap break-all text-zinc-200">
              {String(cmd)}
            </code>
          </div>
        ) : null}

        {out ? (
          <pre
            ref={paneRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
            className={cn(
              'max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed',
              failed ? 'text-rose-300' : 'text-zinc-300',
            )}
          >
            {toolCall.outputTruncated && (
              <span className="text-zinc-500">[前面的输出过长已省略]{'\n'}</span>
            )}
            {out}
            {running && <span className="ml-1 inline-block h-3.5 w-1.5 bg-emerald-400 animate-pulse align-middle" />}
          </pre>
        ) : running ? (
          <div className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] text-zinc-400">
            <span className="inline-block h-3.5 w-1.5 bg-emerald-400 animate-pulse" />
            正在执行命令…
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── File change ─────────────────────────────────────────────────────────────

/** Count +/- lines from a unified-diff-ish payload, if there is one. */
function diffStat(text: string): { added: number; removed: number } | null {
  if (!text || !/^[+-]/m.test(text)) return null
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return added || removed ? { added, removed } : null
}

export function FileBody({ toolCall }: { toolCall: ToolCall }) {
  const path =
    toolCall.args?.path ??
    toolCall.args?.file_path ??
    toolCall.args?.filePath ??
    toolCall.args?.target ??
    ''
  const body = toolCall.result != null ? String(toolCall.result) : ''
  const stat = diffStat(body)
  // Fall back to counting the written payload's lines when there's no diff.
  const written = toolCall.args?.content ?? toolCall.args?.new_string
  const writtenLines =
    !stat && typeof written === 'string' ? written.split('\n').length : null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 min-w-0">
        <FileCode2 size={11} className="text-muted-foreground shrink-0" />
        {path ? (
          <code className="truncate text-[11px] text-foreground/80" title={String(path)}>
            {String(path)}
          </code>
        ) : (
          <span className="text-[10px] text-muted-foreground">文件操作</span>
        )}
        {stat && (
          <span className="shrink-0 tabular-nums text-[10px]">
            <span className="text-success">+{stat.added}</span>
            {' '}
            <span className="text-destructive">-{stat.removed}</span>
          </span>
        )}
        {writtenLines != null && (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {writtenLines} 行
          </span>
        )}
        {path && <span className="ml-auto shrink-0"><CopyButton text={String(path)} label="复制路径" /></span>}
      </div>

      {body && (
        <pre className="rounded bg-muted/40 px-2 py-1.5 whitespace-pre-wrap break-words text-[11px] text-foreground/80 max-h-40 overflow-auto">
          {stat
            ? body.split('\n').map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    line.startsWith('+') && !line.startsWith('+++') && 'text-success',
                    line.startsWith('-') && !line.startsWith('---') && 'text-destructive',
                  )}
                >
                  {line}
                </div>
              ))
            : body}
        </pre>
      )}
    </div>
  )
}

// ── Search ──────────────────────────────────────────────────────────────────

interface Hit { title: string; url: string }

/** Best-effort extraction of {title, url} pairs from whatever the tool returned. */
function extractHits(result: unknown): Hit[] {
  if (result == null) return []
  if (Array.isArray(result)) {
    return result
      .map((r: any) => ({
        title: String(r?.title ?? r?.name ?? r?.url ?? ''),
        url: String(r?.url ?? r?.link ?? ''),
      }))
      .filter((h) => h.url)
      .slice(0, 8)
  }
  const text = String(result)
  const urls = text.match(/https?:\/\/[^\s)"'<>\]]+/g) || []
  const seen = new Set<string>()
  const hits: Hit[] = []
  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    // Grab the nearest preceding non-empty line as a rough title.
    const before = text.slice(0, text.indexOf(url)).split('\n').filter(Boolean).pop() || ''
    hits.push({ title: before.replace(/^[-*\d.\s]+/, '').slice(0, 80) || url, url })
    if (hits.length >= 8) break
  }
  return hits
}

export function SearchBody({ toolCall }: { toolCall: ToolCall }) {
  const query = toolCall.args?.query ?? toolCall.args?.q ?? toolCall.args?.pattern ?? ''
  const hits = extractHits(toolCall.result)
  const raw = toolCall.result != null ? String(toolCall.result) : ''

  return (
    <div className="space-y-1.5">
      {query ? (
        <div className="text-[11px]">
          <span className="text-muted-foreground">查询 </span>
          <code className="text-foreground/80">{String(query)}</code>
          {hits.length > 0 && (
            <span className="ml-1.5 text-[10px] text-muted-foreground tabular-nums">
              {hits.length} 条结果
            </span>
          )}
        </div>
      ) : null}

      {hits.length > 0 ? (
        <ul className="space-y-1">
          {hits.map((h) => (
            <li key={h.url}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void window.electronAPI?.invoke('system:openExternal', h.url)
                }}
                className="group flex w-full items-start gap-1.5 rounded-md border border-border/40 px-2 py-1.5 text-left hover:border-border hover:bg-accent/50 transition-colors"
              >
                <ExternalLink size={10} className="mt-0.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-[11px] text-foreground/85">{h.title}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{h.url}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : raw ? (
        <pre className="rounded bg-muted/40 px-2 py-1.5 whitespace-pre-wrap break-words text-[11px] text-foreground/80 max-h-40 overflow-auto">
          {raw}
        </pre>
      ) : null}
    </div>
  )
}
