// src/components/ui/chat/ChatImage.tsx
// Renders model-generated images inside the chat timeline.
//
// # Why a fixed reserved box instead of the image's real aspect ratio
//
// The backend deliberately does not probe image dimensions (see image_store.py
// — it would need a per-format header parser or Pillow), so an ImageRef has no
// width/height. Without known dimensions there are only two honest options:
// reserve a box and letterbox inside it, or let the image resize the layout the
// moment it decodes.
//
// We reserve. The box is the same size on the first paint and every paint after,
// so Cumulative Layout Shift is exactly zero and — just as important — the
// message list never grows under the user's cursor while they are reading.
// Non-square images letterbox via `object-contain`, which is what ChatGPT and
// Gemini do too.
//
// # Why only opacity animates
//
// Animating width/height/top would trigger layout on every frame and count
// toward CLS. Opacity and transform are compositor-only, so the fade costs
// nothing on the main thread.
//
// # Why decoding="async"
//
// A 1024x1024 PNG decodes in tens of milliseconds. On the main thread that is a
// dropped frame mid-scroll; `decoding="async"` moves it off-thread.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageOff, Download } from 'lucide-react'
import { ImageLoader } from 'generative-loaders'
import { API_BASE, withTokenQuery } from '@lib/api'
import type { ImageRef } from '@apptypes/index'
import { cn } from '@/lib/utils'
import { ImageLightbox } from './ImageLightbox'

/** Absolute URL for an image ref. `ref.url` is server-relative (`/api/images/x`). */
function srcFor(ref: ImageRef): string {
  if (!ref.url) return ''
  if (/^https?:\/\//i.test(ref.url)) return ref.url
  // `<img>` cannot send an Authorization header, so /api/images needs the token
  // in the query string — otherwise every generated image renders as broken.
  return withTokenQuery(`${API_BASE}${ref.url}`)
}

function humanBytes(n: number): string {
  if (!n) return ''
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

interface ChatImageProps {
  image: ImageRef
  /** Fired once the bitmap is painted — lets the scroller re-anchor. */
  onSettled?: () => void
}

export function ChatImage({ image, onSettled }: ChatImageProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [zoomed, setZoomed] = useState(false)
  const src = srcFor(image)
  const label = image.name || t('chatImage.defaultAlt')
  const fileName = image.name || `${image.id}.${image.ext || 'png'}`

  const settle = (next: 'ready' | 'error') => {
    setState(next)
    onSettled?.()
  }

  return (
    <>
    <div
      className={cn(
        // The reserved box. Its size is independent of the image, so it is
        // stable from the very first paint.
        'group relative w-full max-w-[320px] aspect-square shrink-0',
        'rounded-xl overflow-hidden border border-border/40 bg-muted/30',
      )}
    >
      {state === 'error' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-muted-foreground px-3 text-center">
          <ImageOff className="w-5 h-5" />
          <span className="text-[11px] leading-snug">{t('chatImage.failed')}</span>
          <span className="text-[10px] opacity-60 truncate max-w-full">{label}</span>
        </div>
      ) : (
        <>
          {/* Placeholder sits behind the bitmap and fades out — it never moves
              or resizes anything, so it cannot cause a shift. */}
          <div
            aria-hidden={state === 'ready'}
            className={cn(
              'absolute inset-0 flex items-center justify-center text-muted-foreground',
              'transition-opacity duration-300',
              state === 'ready' ? 'opacity-0' : 'opacity-100',
            )}
          >
            <ImageLoader variant="skeleton" size="100%" radius={0} />
          </div>

          <img
            src={src}
            alt={label}
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => settle('ready')}
            onError={() => settle('error')}
            onClick={() => state === 'ready' && setZoomed(true)}
            className={cn(
              'absolute inset-0 w-full h-full object-contain',
              'transition-opacity duration-300 ease-out',
              state === 'ready' ? 'opacity-100 cursor-zoom-in' : 'opacity-0',
            )}
          />

          {/* Save affordance — the on-disk copy is the source of truth, this
              just hands the user the same bytes without a right-click hunt. */}
          {state === 'ready' && (
            <a
              href={src}
              download={image.name || `${image.id}.${image.ext || 'png'}`}
              title={`${label}${image.bytes ? ` · ${humanBytes(image.bytes)}` : ''}`}
              aria-label={t('chatImage.download')}
              className={cn(
                'absolute bottom-1.5 right-1.5 inline-flex items-center justify-center h-7 w-7 rounded-lg',
                'bg-background/80 backdrop-blur-sm border border-border/40 text-muted-foreground',
                'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity duration-150',
                'hover:text-foreground motion-reduce:opacity-100',
              )}
            >
              <Download className="w-3.5 h-3.5" />
            </a>
          )}
        </>
      )}
    </div>
    {zoomed && (
      <ImageLightbox
        src={src}
        alt={label}
        downloadName={fileName}
        onClose={() => setZoomed(false)}
      />
    )}
    </>
  )
}

interface ChatImagesProps {
  images?: ImageRef[]
  onSettled?: () => void
  className?: string
}

/** Grid of generated images for one assistant turn. Renders nothing when empty. */
export function ChatImages({ images, onSettled, className }: ChatImagesProps) {
  if (!images?.length) return null
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {images.map((img) => (
        <ChatImage key={img.id} image={img} onSettled={onSettled} />
      ))}
    </div>
  )
}
