import React, { useState } from 'react'
import { Terminal, FileCode2, Search, CheckCircle2, XCircle, Loader2, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react'
import type { ToolCall } from '../../types/agent'

interface ToolCallCardProps {
  toolCall: ToolCall
}

export const ToolCallCard: React.FC<ToolCallCardProps> = ({ toolCall }) => {
  const [copied, setCopied] = useState(false)
  const [isExpanded, setIsExpanded] = useState(true)

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const getToolIcon = () => {
    switch (toolCall.tool) {
      case 'run_command':
      case 'terminal':
      case 'bash':
      case 'pwsh':
        return <Terminal className="w-3.5 h-3.5 text-emerald-400" />
      case 'write_to_file':
      case 'replace_file_content':
      case 'edit_file':
        return <FileCode2 className="w-3.5 h-3.5 text-blue-400" />
      case 'grep_search':
      case 'find_by_name':
      case 'search_web':
        return <Search className="w-3.5 h-3.5 text-amber-400" />
      default:
        return <Terminal className="w-3.5 h-3.5 text-purple-400" />
    }
  }

  const getStatusBadge = () => {
    switch (toolCall.status) {
      case 'running':
        return (
          <span className="flex items-center gap-1 text-[10px] text-amber-400 font-mono">
            <Loader2 className="w-3 h-3 animate-spin" />
            running
          </span>
        )
      case 'done':
        return (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-mono">
            <CheckCircle2 className="w-3 h-3" />
            completed
          </span>
        )
      case 'failed':
        return (
          <span className="flex items-center gap-1 text-[10px] text-red-400 font-mono">
            <XCircle className="w-3 h-3" />
            failed
          </span>
        )
      default:
        return null
    }
  }

  const command = toolCall.args?.CommandLine || toolCall.args?.command || toolCall.args?.query || ''
  const targetFile = toolCall.args?.TargetFile || toolCall.args?.path || toolCall.args?.target_file || ''

  return (
    <div className="my-2 rounded-xl bg-black/40 border border-white/10 overflow-hidden text-xs transition-all shadow-sm">
      {/* Header */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        className="px-3 py-2 flex items-center justify-between bg-white/5 hover:bg-white/10 cursor-pointer select-none transition-colors"
      >
        <div className="flex items-center gap-2 font-mono text-[11px] text-white/90">
          {getToolIcon()}
          <span className="font-semibold text-white/90">{toolCall.tool}</span>
          {targetFile && <span className="text-white/40 truncate max-w-[200px]">{targetFile}</span>}
        </div>

        <div className="flex items-center gap-2">
          {getStatusBadge()}
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-white/40" /> : <ChevronRight className="w-3.5 h-3.5 text-white/40" />}
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="p-3 space-y-2 border-t border-white/5">
          {/* Command or main args */}
          {command && (
            <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-black/60 font-mono text-[11px] text-emerald-300 border border-emerald-500/20">
              <span className="truncate mr-2">$ {command}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleCopy(command)
                }}
                className="text-white/40 hover:text-white transition-colors"
                title="Copy command"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}

          {/* Execution Output */}
          {toolCall.output && (
            <div className="p-2.5 rounded-lg bg-black/50 font-mono text-[11px] text-white/80 max-h-56 overflow-y-auto whitespace-pre-wrap border border-white/5">
              {toolCall.output}
            </div>
          )}

          {/* Error Output */}
          {toolCall.error && (
            <div className="p-2.5 rounded-lg bg-red-950/30 font-mono text-[11px] text-red-300 border border-red-500/20">
              {toolCall.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
