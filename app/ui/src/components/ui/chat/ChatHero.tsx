import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderSearch, Monitor, Globe, CalendarClock } from 'lucide-react'
import { cn } from '@/lib/utils'

function getDynamicGreeting(lang: string = 'zh'): string {
  const hour = new Date().getHours()
  const isZh = lang.startsWith('zh')

  if (isZh) {
    const zhGreetings = {
      dawn: [
        '清晨好，今天想从哪里开始？',
        '早安，准备好开启新的灵感了吗？',
        '新的一天，探索点什么？',
      ],
      morning: [
        '上午好，今天有什么工作计划？',
        '随时待命，聊聊你的想法吧。',
        '准备好构建些什么了？',
      ],
      afternoon: [
        '下午好，有什么灵感需要落地？',
        '今天想探索些什么？',
        '随时待命，聊聊你的想法吧。',
      ],
      evening: [
        '晚上好，今天进展如何？',
        '夜幕降临，整理一下今天的成果？',
        '有什么可以帮你的？',
      ],
      night: [
        '夜深了，整理一下今天的思路？',
        '夜猫子时间，需要协助些什么？',
        '灵感不打烊，有什么新想法？',
      ],
    }

    let bucket = zhGreetings.afternoon
    if (hour >= 5 && hour < 9) bucket = zhGreetings.dawn
    else if (hour >= 9 && hour < 12) bucket = zhGreetings.morning
    else if (hour >= 12 && hour < 18) bucket = zhGreetings.afternoon
    else if (hour >= 18 && hour < 23) bucket = zhGreetings.evening
    else bucket = zhGreetings.night

    const idx = Math.floor(Math.random() * bucket.length)
    return bucket[idx]
  } else {
    const enGreetings = {
      morning: [
        'Good morning! What are we working on today?',
        'Ready to build something great?',
      ],
      afternoon: [
        'Good afternoon! What ideas do you want to explore?',
        'Ready when you are.',
      ],
      evening: [
        'Good evening! How did things go today?',
        'Need a hand wrapping up?',
      ],
    }
    let bucket = enGreetings.afternoon
    if (hour >= 5 && hour < 12) bucket = enGreetings.morning
    else if (hour >= 12 && hour < 18) bucket = enGreetings.afternoon
    else bucket = enGreetings.evening

    const idx = Math.floor(Math.random() * bucket.length)
    return bucket[idx]
  }
}

export function ChatHeroTitle() {
  const { i18n } = useTranslation()
  const greeting = useMemo(() => getDynamicGreeting(i18n.language), [i18n.language])

  return (
    <div className="flex flex-col items-center justify-center gap-4 text-center select-none animate-fade-in py-2">
      {/* Ovolve Brand App Icon with ambient aura halo */}
      <div className="relative flex items-center justify-center my-1">
        {/* Soft Radial Ambient Aura Glow behind icon */}
        <div
          className="absolute inset-[-20px] rounded-full blur-2xl opacity-45 dark:opacity-35 pointer-events-none"
          style={{
            background: 'radial-gradient(circle, rgba(0, 210, 255, 0.65) 0%, rgba(155, 81, 224, 0.45) 45%, transparent 75%)',
          }}
        />
        <img
          src="/icon.png"
          alt="Ovolve"
          className="w-16 h-16 rounded-[18px] object-cover shadow-xl relative z-10 select-none pointer-events-none transition-transform duration-300 hover:scale-105"
        />
      </div>

      <h1 className="text-2xl sm:text-3xl font-heading font-semibold tracking-tight text-foreground/95 max-w-md leading-snug">
        {greeting}
      </h1>
    </div>
  )
}

const CHIPS = [
  { key: 'files', icon: FolderSearch },
  { key: 'diagnose', icon: Monitor },
  { key: 'search', icon: Globe },
  { key: 'cron', icon: CalendarClock },
] as const

interface ChatHeroChipsProps {
  onPick: (prompt: string) => void
}

export function ChatHeroChips({ onPick }: ChatHeroChipsProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-center gap-2.5 pt-2">
      {CHIPS.map(({ key, icon: Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(t(`chatHero.${key}Prompt`))}
          className={cn(
            'inline-flex items-center gap-2 pl-3.5 pr-4 py-2 rounded-full',
            'glass-pill text-[13px] text-muted-foreground hover:text-foreground font-medium',
            'press-feedback group cursor-pointer select-none',
          )}
        >
          <Icon size={14} className="text-primary/70 group-hover:text-primary transition-colors shrink-0" />
          <span>{t(`chatHero.${key}Label`)}</span>
        </button>
      ))}
    </div>
  )
}
