/**
 * MediaLightbox — full-viewport viewer for a generated image.
 *
 * Exists because generated diagrams and screenshots are routinely unreadable in
 * the timeline's 320px reserved box (see ChatImage's note on why that box is
 * fixed). The lightbox is the escape hatch: same bytes, full screen.
 *
 * Deliberately dependency-free rather than pulling a carousel library — there
 * is exactly one image, no slideshow, no thumbnails. What it DOES need to get
 * right is the accessibility contract a modal owes the user:
 *   · Escape closes
 *   · backdrop click closes, content click does not
 *   · body scroll is locked while open (otherwise the timeline scrolls behind)
 *   · role="dialog" + aria-modal so a screen reader treats it as a layer
 *
 * Rendered through a portal to document.body so the timeline's `overflow`
 * and stacking contexts can't clip it.
 */
import { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Download, X } from 'lucide-react'
import { cn } from '../../lib/utils'

interface MediaLightboxProps {
  src: string
  alt: string
  /** Filename offered by the download button. */
  downloadName?: string
  onClose: () => void
}

export function ImageLightbox({ src, alt, downloadName, onClose }: MediaLightboxProps) {
  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture phase + stopPropagation so Escape closes the lightbox and
        // does NOT also reach the composer (which would clear the draft).
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)

    // Restore the exact previous value rather than hardcoding '' — another
        // layer (a dialog, the settings sheet) may already have locked scroll.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
      className={cn(
        'fixed inset-0 z-[100] flex items-center justify-center p-6',
        'bg-black/80 backdrop-blur-sm animate-in fade-in duration-150',
      )}
    >
      {/* Controls float over the backdrop, not the image, so they never sit on
          top of the content the user opened this to look at. */}
      <div className="absolute top-4 right-4 flex items-center gap-2" onClick={stop}>
        {downloadName && (
          <a
            href={src}
            download={downloadName}
            aria-label="下载图片"
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
          >
            <Download className="w-4 h-4" />
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <img
        src={src}
        alt={alt}
        onClick={stop}
        draggable={false}
        className="max-h-full max-w-full object-contain rounded-lg shadow-2xl"
      />
    </div>,
    document.body,
  )
}

// 消费方（MediaPreviewCard/ScreenshotFeedbackCard）按 MediaLightbox 名引用——别名导出保持两套叫法都能用。
export { ImageLightbox as MediaLightbox }
