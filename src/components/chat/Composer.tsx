import React, { useState, useRef, useEffect } from 'react'
import {
  ArrowUp,
  Square,
  Paperclip,
  Sparkles,
  Sliders,
  X,
  FileText,
  Bot,
  Zap,
} from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { MentionPanel } from './MentionPanel'
import { SlashPanel, type SlashCommand } from './SlashPanel'
import { ContextMeter } from './ContextMeter'
import { ThoughtDial } from './ThoughtDial'
import { BorderBeam } from '../ui/BorderBeam'
import { SessionTripartiteCapsule } from './SessionTripartiteCapsule'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { ThoughtLevel } from '../../types/agent'
import { QueuedPromptBar } from './QueuedPromptBar'
// 「引用标签」入口 + 认领失败卡回填通道（U3 指认闭环）
import { TabReferenceButton } from './TabReferenceButton'
import { COMPOSER_INSERT_EVENT } from '../../lib/claimRef'

interface Attachment {
  name: string
  path: string
  isDir?: boolean
}

export const Composer: React.FC<{ isHero?: boolean }> = ({ isHero = false }) => {
  const [input, setInput] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [thoughtLevel, setThoughtLevel] = useState<ThoughtLevel>('high')
  const [thoughtIndex, setThoughtIndex] = useState(2) // 0: off, 1: low, 2: high, 3: max

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isStreaming = useAgentStore((s) => s.isStreaming)
  const isThinking = useAgentStore((s) => s.isThinking)
  const stopGeneration = useAgentStore((s) => s.stopGeneration)
  const modelConfig = useAgentStore((s) => s.modelConfig)
  const setWorkspaceRoot = useAgentStore((s) => s.setWorkspaceRoot)
  const enqueuePrompt = useAgentStore((s) => s.enqueuePrompt)
  const dispatchPrompt = useAgentStore((s) => s.dispatchPrompt)

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`
    }
  }, [input])

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)

    // Check for @ mention trigger
    const mentionMatch = val.match(/@([a-zA-Z0-9_\-\.\/]*)$/)
    if (mentionMatch) {
      setMentionQuery(mentionMatch[1])
      setSlashQuery(null)
    } else {
      setMentionQuery(null)
    }

    // Check for / slash command trigger
    if (val.startsWith('/') && !val.includes(' ')) {
      setSlashQuery(val.slice(1))
      setMentionQuery(null)
    } else {
      setSlashQuery(null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!mentionQuery && !slashQuery) {
        e.preventDefault()
        handleSend()
      }
    }
  }

  const handleSelectMention = (item: any) => {
    const updated = input.replace(/@[a-zA-Z0-9_\-\.\/]*$/, `@${item.name} `)
    setInput(updated)
    setMentionQuery(null)
    textareaRef.current?.focus()
  }

  const handleSelectSlash = (cmd: SlashCommand) => {
    setInput(`${cmd.cmd} `)
    setSlashQuery(null)
    textareaRef.current?.focus()
  }

  /** 把一段文本插进输入框光标处（引用标签/认领失败卡回填共用）。 */
  const insertAtCursor = (text: string) => {
    if (!text) return
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? input.length
    const end = ta?.selectionEnd ?? input.length
    const safeStart = Math.min(Math.max(start, 0), input.length)
    const safeEnd = Math.min(Math.max(end, safeStart), input.length)
    const next = input.slice(0, safeStart) + text + input.slice(safeEnd)
    setInput(next)
    // 渲染后把光标落回插入文本末尾并保持焦点。
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const pos = safeStart + text.length
      try { el.setSelectionRange(pos, pos) } catch { /* 类型不符 → 放弃定位 */ }
    })
  }

  // 认领失败卡「重新指认」成功后经 CustomEvent 回填确认消息（U3 闭环最后一步）。
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent).detail as { text?: unknown } | undefined
      const text = typeof detail?.text === 'string' ? detail.text : ''
      if (text) insertAtCursor(text)
    }
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert)
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert)
  }, [input])

  const handleAttachFile = async () => {
    if (typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.file?.pickFile) {
      const file = await (window as any).ovolveDesktopAPI.file.pickFile()
      if (file) {
        setAttachments((prev) => [...prev, { name: file.split(/[\\/]/).pop() || file, path: file }])
      }
    }
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleThoughtIndexChange = (idx: number) => {
    setThoughtIndex(idx)
    const levels: ThoughtLevel[] = ['off', 'low', 'high', 'max']
    setThoughtLevel(levels[idx] || 'high')
  }

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed) return

    // If currently running, enqueue message cleanly!
    if (isStreaming || isThinking) {
      enqueuePrompt(trimmed)
      setInput('')
      setMentionQuery(null)
      setSlashQuery(null)
      setAttachments([])
      return
    }

    // Normal dispatch
    setInput('')
    setMentionQuery(null)
    setSlashQuery(null)
    setAttachments([])
    dispatchPrompt(trimmed)
  }

  return (
    <div className={`relative w-full ${isHero ? 'max-w-2xl mx-auto' : 'max-w-3xl mx-auto'}`}>
      {/* Queued Prompt Floating Bar */}
      <QueuedPromptBar />

      {/* Mention Popup */}
      {mentionQuery !== null && (
        <MentionPanel
          query={mentionQuery}
          onSelect={handleSelectMention}
          onClose={() => setMentionQuery(null)}
        />
      )}

      {/* Slash Command Menu */}
      {slashQuery !== null && (
        <SlashPanel
          query={slashQuery}
          onSelect={handleSelectSlash}
          onClose={() => setSlashQuery(null)}
        />
      )}

      {/* Hero Mode Top Tripartite Capsule */}
      {isHero && (
        <div className="flex justify-center">
          <SessionTripartiteCapsule variant="hero" />
        </div>
      )}

      {/* Glass Card Container */}
      <div
        className={`relative shadow-xl rounded-2xl bg-card/85 dark:bg-card/50 backdrop-blur-2xl border border-border/80 dark:border-white/15 ring-1 ring-black/[0.03] p-2.5 transition-all focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20 ${
          isStreaming ? 'ring-2 ring-sky-400/30' : ''
        }`}
      >
        {isStreaming && <BorderBeam size={220} duration={8} />}

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-1 pb-2 border-b border-border/60 dark:border-white/5">
            {attachments.map((att, idx) => (
              <div
                key={idx}
                className="glass-pill px-2.5 py-1 rounded-md text-[11px] font-mono flex items-center gap-1.5 text-foreground/90"
              >
                <FileText size={12} className="text-primary" />
                <span className="truncate max-w-[150px]">{att.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(idx)}
                  className="hover:text-destructive cursor-pointer ml-1"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Multi-line Expanding Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask OvolveAgent anything, type @ to mention files, or / for autonomous skills..."
          rows={1}
          className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 resize-none focus:outline-none px-2 py-1.5 leading-relaxed max-h-48 selection:bg-primary/25"
        />

        {/* Controls Action Bar */}
        <div className="flex items-center justify-between pt-2 px-1 border-t border-border/60 dark:border-white/5 mt-1 select-none">
          {/* Left: Attachment + Model + Thought Dial Trigger */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAttachFile}
              className="p-1.5 rounded-lg hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              title="Attach Workspace File"
            >
              <Paperclip size={14} />
            </button>

            {/* 引用标签：把打开中的标签以 ovolve://claim/tab 引用插进光标处 */}
            <TabReferenceButton onInsert={insertAtCursor} />

            {/* Thought Level Capsule */}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`glass-pill px-2 py-0.5 rounded-full text-[10.5px] font-mono flex items-center gap-1 cursor-pointer transition-all ${
                    thoughtLevel === 'max'
                      ? 'border-sky-400 text-sky-400 bg-sky-400/10 shadow-[0_0_10px_rgba(56,189,248,0.3)]'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="Configure Reasoning Depth"
                >
                  <Zap size={11} className={thoughtLevel === 'max' ? 'text-sky-400 animate-pulse' : 'text-primary'} />
                  <span>{thoughtLevel.toUpperCase()}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-3 space-y-2.5" side="top" align="start">
                <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <Sparkles size={13} className="text-primary" />
                  <span>Reasoning Depth Dial</span>
                </div>
                <ThoughtDial index={thoughtIndex} onChange={handleThoughtIndexChange} atMax={thoughtLevel === 'max'} />
              </PopoverContent>
            </Popover>

            {/* Context Token Usage Meter */}
            <ContextMeter />
          </div>

          {/* Right: Send or Stop */}
          <div className="flex items-center gap-1.5">
            {isStreaming || isThinking ? (
              <>
                {input.trim() && (
                  <button
                    type="button"
                    onClick={handleSend}
                    className="px-2.5 h-7 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-medium flex items-center gap-1 shadow-md shadow-sky-500/20 transition-all active:scale-95 cursor-pointer"
                    title="将此指令加入排队队列 (Enter)"
                  >
                    <ArrowUp size={13} />
                    <span>排队</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={stopGeneration}
                  className="w-7 h-7 rounded-lg bg-destructive hover:bg-destructive/90 text-white flex items-center justify-center shadow-md transition-all active:scale-95 cursor-pointer"
                  title="停止当前生成"
                >
                  <Square size={12} className="fill-current" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim()}
                className={`w-7 h-7 rounded-lg flex items-center justify-center text-white shadow-md transition-all active:scale-95 cursor-pointer ${
                  input.trim()
                    ? 'bg-primary hover:bg-primary/90 shadow-primary/20'
                    : 'bg-muted text-muted-foreground/40 cursor-not-allowed'
                }`}
                title="发送指令 (Enter)"
              >
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hero Mode Quick Action Chips */}
      {isHero && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-3 animate-in fade-in zoom-in-95 duration-300 delay-150">
          <button
            type="button"
            onClick={() => setInput('整理工作区文件并生成结构摘要')}
            className="glass-pill px-3 py-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 cursor-pointer"
          >
            📁 整理文件
          </button>
          <button
            type="button"
            onClick={() => setInput('运行系统诊断并检查依赖与性能')}
            className="glass-pill px-3 py-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 cursor-pointer"
          >
            💻 系统诊断
          </button>
          <button
            type="button"
            onClick={() => setInput('/goal 编写自动化单元测试并运行验证')}
            className="glass-pill px-3 py-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 cursor-pointer"
          >
            🎯 目标规划
          </button>
          <button
            type="button"
            onClick={() => setInput('检索最新开源模型与技术路线')}
            className="glass-pill px-3 py-1.5 rounded-full text-xs font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 cursor-pointer"
          >
            🌐 联网搜索
          </button>
        </div>
      )}
    </div>
  )
}

export default Composer
