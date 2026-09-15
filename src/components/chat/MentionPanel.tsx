import React, { useEffect, useState } from 'react'
import { File, Folder, Sparkles, Bot, Code } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'

interface MentionItem {
  id: string
  name: string
  path: string
  type: 'file' | 'folder' | 'skill' | 'agent'
}

interface MentionPanelProps {
  query: string
  onSelect: (item: MentionItem) => void
  onClose: () => void
}

export const MentionPanel: React.FC<MentionPanelProps> = ({ query, onSelect, onClose }) => {
  const [items, setItems] = useState<MentionItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const workspaceRoot = useAgentStore((s) => s.workspaceRoot)

  useEffect(() => {
    let active = true
    const search = async () => {
      const results: MentionItem[] = []
      
      // Default skills & agents
      const defaultOptions: MentionItem[] = [
        { id: 'agent-coder', name: 'coder', path: 'Built-in Coder Agent', type: 'agent' },
        { id: 'agent-reviewer', name: 'reviewer', path: 'Code Reviewer Agent', type: 'agent' },
        { id: 'agent-planner', name: 'planner', path: 'Architecture Planner', type: 'agent' },
        { id: 'skill-reverse', name: 'reverse-engineering', path: 'Skill: Reverse Engineering', type: 'skill' },
        { id: 'skill-glass', name: 'agent-glass-ui', path: 'Skill: DSH Glass UI Design', type: 'skill' },
      ]

      const q = query.toLowerCase()
      const filteredDefaults = defaultOptions.filter(
        (o) => o.name.toLowerCase().includes(q) || o.path.toLowerCase().includes(q),
      )
      results.push(...filteredDefaults)

      // Search filesystem via IPC if workspace selected
      if (workspaceRoot && typeof window !== 'undefined' && (window as any).ovolveDesktopAPI?.file?.search) {
        try {
          const files = await (window as any).ovolveDesktopAPI.file.search(workspaceRoot, query, 15)
          if (Array.isArray(files) && active) {
            for (const f of files) {
              results.push({
                id: f.path,
                name: f.name,
                path: f.path.replace(workspaceRoot, '').replace(/^[\\/]/, ''),
                type: f.isDir ? 'folder' : 'file',
              })
            }
          }
        } catch (_) {}
      }

      if (active) {
        setItems(results.slice(0, 10))
        setSelectedIndex(0)
      }
    }

    search()
    return () => {
      active = false
    }
  }, [query, workspaceRoot])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => (items.length ? (prev + 1) % items.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => (items.length ? (prev - 1 + items.length) % items.length : 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (items[selectedIndex]) {
          e.preventDefault()
          onSelect(items[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [items, selectedIndex, onSelect, onClose])

  if (items.length === 0) return null

  return (
    <div className="absolute bottom-full left-0 mb-2 w-80 max-h-64 overflow-y-auto rounded-xl border border-border/80 dark:border-white/12 bg-card/95 dark:bg-[#13151b]/95 p-1.5 shadow-2xl backdrop-blur-2xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
      <div className="px-2 py-1 text-[10px] uppercase font-mono text-muted-foreground font-semibold">
        Mentions (@files, @agents, @skills)
      </div>
      <div className="space-y-0.5">
        {items.map((item, idx) => {
          const isSelected = idx === selectedIndex
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-left text-xs transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'text-foreground/80 hover:bg-white/5'
              }`}
            >
              {item.type === 'agent' && <Bot size={13} className="text-indigo-400 shrink-0" />}
              {item.type === 'skill' && <Sparkles size={13} className="text-amber-400 shrink-0" />}
              {item.type === 'folder' && <Folder size={13} className="text-sky-400 shrink-0" />}
              {item.type === 'file' && <File size={13} className="text-slate-400 shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] font-medium truncate">{item.name}</div>
                <div className="text-[10px] text-muted-foreground truncate">{item.path}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default MentionPanel
