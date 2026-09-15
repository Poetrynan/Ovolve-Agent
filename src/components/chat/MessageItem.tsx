import React, { useState } from 'react'
import { User, Sparkles, Copy, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { Message } from '../../types/agent'
import { ActivityFeed } from './ActivityFeed'
// 媒体预览条：聊天内容里的本地 PDF/图片/视频内嵌预览。
import { MediaPreviewStrip } from './MediaPreviewCard'

interface MessageItemProps {
  message: Message
}

export const MessageItem: React.FC<MessageItemProps> = ({ message }) => {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className={`group py-4 px-4 flex gap-3.5 transition-colors rounded-xl ${
        isUser
          ? 'bg-muted/20 dark:bg-white/[0.02] border border-border/40 dark:border-white/5'
          : 'bg-card/40 dark:bg-card/20 backdrop-blur-md border border-border/50 dark:border-white/5'
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 shadow-sm ${
          isUser
            ? 'bg-gradient-to-tr from-slate-700 to-slate-600 text-white'
            : 'bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 text-white shadow-blue-500/20'
        }`}
      >
        {isUser ? <User size={14} /> : <Sparkles size={14} />}
      </div>

      {/* Content Body */}
      <div className="flex-1 min-w-0 space-y-2">
        {/* Header */}
        <div className="flex items-center justify-between select-none">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground">
              {isUser ? 'You' : 'OvolveAgent'}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50 cursor-pointer"
            title="Copy message"
          >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
          </button>
        </div>

        {/* Chronological ActivityFeed (Reasoning + Tool calls) */}
        {(message.reasoning || (message.toolCalls && message.toolCalls.length > 0)) && (
          <ActivityFeed
            reasoning={message.reasoning}
            reasoningDuration={message.reasoningDuration}
            toolCalls={message.toolCalls}
          />
        )}

        {/* Message Content Markdown */}
        {message.content && (
          <div className="text-xs text-foreground/95 leading-relaxed font-sans break-words selection:bg-primary/25 prose dark:prose-invert max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeHighlight, rehypeKatex]}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Media Preview Strip: local PDF/image/video paths found in the message text */}
        <MediaPreviewStrip text={message.content} />
      </div>
    </div>
  )
}

export default MessageItem
