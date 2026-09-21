import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, RotateCcw, Pencil, Undo2 } from 'lucide-react'
import { Button } from '@components/ui/button'
import { cn } from '@/lib/utils'

export interface MessageActionProps {
  /** The message text (used by the copy action). */
  content: string
  /** Whether this is a user message (only user messages can be withdrawn). */
  isUser?: boolean
  onRetry?: () => void
  onEdit?: () => void
  /** Withdraw: message text goes back to input, message marked as withdrawn. */
  onWithdraw?: () => void
  className?: string
}

export function MessageAction({
  content,
  isUser = false,
  onRetry,
  onEdit,
  onWithdraw,
  className,
}: MessageActionProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can fail in insecure contexts; degrade silently.
    }
  }, [content])

  return (
    <div
      className={cn(
        'flex items-center gap-1',
        'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
        'motion-reduce:opacity-100',
        className,
      )}
    >
      {/* Copy */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={handleCopy}
        aria-label={t('common.copy')}
        title={t('common.copy')}
      >
        {copied ? (
          <Check className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>

      {/* Withdraw — only for user messages */}
      {isUser && onWithdraw && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onWithdraw}
          aria-label="Withdraw message"
          title="Withdraw"
        >
          <Undo2 className="h-3 w-3" />
        </Button>
      )}

      {/* Retry */}
      {onRetry && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onRetry}
          aria-label="Retry message"
          title="Retry"
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
      )}

      {/* Edit */}
      {onEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onEdit}
          aria-label="Edit message"
          title="Edit"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      )}
    </div>
  )
}
