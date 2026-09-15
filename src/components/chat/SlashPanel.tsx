import React, { useEffect, useState } from 'react'
import { Target, BookOpen, FileSearch, Terminal, RotateCcw, GitFork, Cpu } from 'lucide-react'

export interface SlashCommand {
  cmd: string
  label: string
  desc: string
  icon: any
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: '/goal', label: 'Goal Mode', desc: 'Autonomous long-horizon goal loop with TeamBoard DAG', icon: Target },
  { cmd: '/plan', label: 'Structured Plan', desc: 'Generate multi-step verifiable engineering plan', icon: BookOpen },
  { cmd: '/research', label: 'Codebase Research', desc: 'Perform fast BM25 & deep file investigation', icon: FileSearch },
  { cmd: '/code', label: 'Direct Code Generation', desc: 'Fast multiline replacement & syntax verification', icon: Terminal },
  { cmd: '/rollback', label: 'Checkpoint Rollback', desc: 'Rollback current turn or git workspace state', icon: RotateCcw },
  { cmd: '/fork', label: 'Fork Session', desc: 'Fork this conversation into a new branching trail', icon: GitFork },
  { cmd: '/diagnose', label: 'Self Diagnostics', desc: 'Run circuit breaker & token usage inspection', icon: Cpu },
]

interface SlashPanelProps {
  query: string
  onSelect: (cmd: SlashCommand) => void
  onClose: () => void
}

export const SlashPanel: React.FC<SlashPanelProps> = ({ query, onSelect, onClose }) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filtered = SLASH_COMMANDS.filter(
    (c) =>
      c.cmd.toLowerCase().includes(query.toLowerCase()) ||
      c.label.toLowerCase().includes(query.toLowerCase()) ||
      c.desc.toLowerCase().includes(query.toLowerCase()),
  )

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => (filtered.length ? (prev + 1) % filtered.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => (filtered.length ? (prev - 1 + filtered.length) % filtered.length : 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered[selectedIndex]) {
          e.preventDefault()
          onSelect(filtered[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [filtered, selectedIndex, onSelect, onClose])

  if (filtered.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 mb-2 w-80 max-h-72 overflow-y-auto rounded-xl border border-border/80 dark:border-white/12 bg-card/95 dark:bg-[#13151b]/95 p-1.5 shadow-2xl backdrop-blur-2xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
      <div className="px-2 py-1 text-[10px] uppercase font-mono text-muted-foreground font-semibold">
        Slash Commands (/)
      </div>
      <div className="space-y-0.5">
        {filtered.map((item, idx) => {
          const Icon = item.icon
          const isSelected = idx === selectedIndex
          return (
            <button
              key={item.cmd}
              type="button"
              onClick={() => onSelect(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2.5 text-left text-xs transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'text-foreground/80 hover:bg-white/5'
              }`}
            >
              <div className="p-1 rounded bg-primary/10 text-primary shrink-0">
                <Icon size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] font-semibold text-foreground">{item.cmd}</span>
                  <span className="text-[10px] text-muted-foreground font-normal">{item.label}</span>
                </div>
                <div className="text-[10.5px] text-muted-foreground/80 truncate">{item.desc}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default SlashPanel
