import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@components/ui/button'
import { cn } from '@/lib/utils'

interface MessageInputProps {
  onSend: (message: string) => void
  disabled?: boolean
  placeholder?: string
  className?: string
  /** External value override — set by suggestion chips to prefill the composer. */
  value?: string
  onValueChange?: (v: string) => void
}

/**
 * Message input with send button.
 * Enter to send, Shift+Enter for newline.
 */
export function MessageInput({
  onSend,
  disabled = false,
  placeholder = '输入消息... (Enter 发送)',
  className,
  value,
  onValueChange,
}: MessageInputProps) {
  const [internal, setInternal] = useState('')
  const input = value !== undefined ? value : internal
  const setInput = (v: string) => {
    if (onValueChange) onValueChange(v)
    else setInternal(v)
  }

  const handleSend = () => {
    if (!input.trim() || disabled) return
    onSend(input)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={cn(
      'flex items-end gap-2 rounded-2xl border border-input bg-background/60',
      'pl-4 pr-2 py-2 input-focus shadow-sm',
      className
    )}>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        className={cn(
          'flex-1 resize-none bg-transparent py-2 text-sm',
          'placeholder:text-muted-foreground/70',
          'focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'min-h-[28px] max-h-[120px]'
        )}
      />
      <Button
        onClick={handleSend}
        disabled={!input.trim() || disabled}
        size="icon"
        className="h-9 w-9 rounded-xl shrink-0"
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  )
}
