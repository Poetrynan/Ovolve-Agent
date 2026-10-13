// src/components/ui/chat/MessageErrorBoundary.tsx
// A per-message crash barrier.
//
// The app already has an ErrorBoundary, but only at the root — so one malformed
// markdown table, one broken image ref, one Mermaid diagram that throws while
// parsing takes down the WHOLE conversation view. The user loses a session they
// can still scroll in the database, over a single bad row.
//
// Scope is the point: this wraps one message. When it catches, that row degrades
// to plain text and everything above and below keeps rendering. The raw content
// is shown verbatim (not through markdown — the markdown path is the suspect)
// with a copy button, so the message is still usable even when it is unstylable.
import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Copy, Check, RotateCw } from 'lucide-react'

interface Props {
  children: React.ReactNode
  /** The message's raw text, shown verbatim if rendering blows up. */
  raw?: string
}

interface State {
  error: Error | null
}

/**
 * The fallback is a separate function component so it can use hooks — an error
 * boundary has to be a class, and classes cannot call `useTranslation`.
 */
function MessageErrorFallback({ raw, error, onRetry }: {
  raw?: string
  error: Error | null
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw || '')
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard can be denied; the text is on screen and selectable anyway.
    }
  }

  return (
    <div className="flex justify-start animate-message-in">
      <div className="max-w-[78%] rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5 space-y-2">
        <div className="flex items-center gap-1.5 text-warning text-xs font-medium">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('errorBoundary.messageFailed')}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t('errorBoundary.messageFailedHint')}
        </p>
        {raw ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2.5 py-2 text-xs text-foreground/90 font-mono">
            {raw}
          </pre>
        ) : null}
        <div className="flex items-center gap-1.5">
          {raw ? (
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
            {t('errorBoundary.retry')}
          </button>
        </div>
        {/* The message itself, for a bug report. Not translated on purpose. */}
        {error ? (
          <p className="text-[10px] text-muted-foreground/70 font-mono break-all">
            {error.name}: {error.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export class MessageErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[message] render failed:', error, info)
  }

  /**
   * Clear the error when the content changes.
   *
   * Without this a streaming message that threw on a half-written code fence
   * would stay broken for the rest of the turn — the fence closes a token later
   * and would render fine, but React keeps a boundary latched until something
   * resets it. Comparing `raw` is enough: it is the only input that can turn an
   * unrenderable message into a renderable one.
   */
  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.raw !== this.props.raw) {
      this.setState({ error: null })
    }
  }

  private retry = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <MessageErrorFallback
          raw={this.props.raw}
          error={this.state.error}
          onRetry={this.retry}
        />
      )
    }
    return this.props.children
  }
}
