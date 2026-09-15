import { useTranslation } from 'react-i18next'
import { ImageLoader } from 'generative-loaders'
import { OvolveLoader } from '@/components/ui/OvolveLoader'
import { BubbleAvatar } from './Bubble'

interface TypingIndicatorProps {
  /**
   * The backend watchdog thinks the model is rendering an image (see
   * router._image_hint_watchdog). Swaps the generic dots for an image-shaped
   * placeholder so a 30-second silent render reads as progress, not a hang.
   */
  imageGenerating?: boolean
}

/**
 * Typing indicator — shown while the assistant is generating a response.
 * Uses the official Ovolve Seamless Fluid Loader across the brand color spectrum.
 */
export function TypingIndicator({ imageGenerating = false }: TypingIndicatorProps) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-3 animate-message-in">
      <BubbleAvatar role="assistant" />
      <div className="bg-card/80 border border-border/40 rounded-2xl rounded-bl-md px-4 py-3.5 shadow-sm">
        {imageGenerating ? (
          <div className="flex items-center gap-3 text-foreground">
            <ImageLoader variant="bands" size={44} radius={8} />
            <span className="text-xs text-muted-foreground">{t('chatImage.generating')}</span>
          </div>
        ) : (
          <div className="flex items-center justify-center">
            <OvolveLoader size={28} />
          </div>
        )}
      </div>
    </div>
  )
}
