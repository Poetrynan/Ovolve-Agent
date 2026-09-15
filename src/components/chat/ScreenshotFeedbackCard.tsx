// src/components/chat/ScreenshotFeedbackCard.tsx
// CUA / 浏览器动作的截图反馈内嵌面板（P1-4 子项四）。
//
// 旧实现只认结果里的 data_uri（PIP Live View 一张小图，且不能放大）。落盘
// 形态的截图——CUA side_effect 动作回拍的 ~/.ovolve/cua_shots/*.png、浏览器
// capture_tab 存的 <workspace>/screenshots/tab_*.png——此前只有一行
// "Screenshot saved: <path>" 文本，用户根本看不到 AI 到底看到了什么。
//
// 本面板消费 lib/screenshotFeedback.ts 归一出的 ScreenshotRef：
//   · data-uri → 直接内嵌，点击进 ImageLightbox 全屏放大
//   · path     → 受控端点 /api/files 优先（P1-4 子项二：dev http 源可加载，
//                home 相对 ~/ 路径由后端 user_dirs 解析），端点失败降级
//                file:/// 直载（prod 可用），再失败走"打开 / 所在文件夹"
//                降级行（Electron 既有 system:openPath / system:showInFolder）
import { useEffect, useMemo, useState } from 'react'
import { Camera, FolderOpen, ImageOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { API_BASE, withTokenQuery } from '../../lib/api'
import { MediaLightbox as ImageLightbox } from './MediaLightbox'
import type { ScreenshotRef } from '../../lib/screenshotFeedback'

/** path 引用可用的候选加载 URL：受控端点优先，file:/// 降级（去空去重）。 */
function shotSrcCandidates(r: ScreenshotRef): string[] {
  if (r.source === 'data-uri') return [r.src]
  const primary = r.endpointUrl
    ? withTokenQuery(`${API_BASE}${r.endpointUrl}`)
    : ''
  return [primary, r.fileUrl].filter((u, i, a): u is string => !!u && a.indexOf(u) === i)
}

function FallbackShot({ refItem }: { refItem: ScreenshotRef }) {
  const openExternal = async (folder: boolean) => {
    const api = (window as any).electronAPI
    if (!api?.invoke) return
    try {
      await api.invoke('system:openPath', refItem.src)
      return
    } catch { /* fall through */ }
    if (folder) {
      try { await api.invoke('system:showInFolder', refItem.src) } catch { /* ignore */ }
    }
  }
  const filename = refItem.src.split(/[\\/]/).pop() || refItem.src
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border/50 bg-muted/30 text-xs">
      <ImageOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span className="font-mono text-[11px] text-foreground/80 truncate min-w-0" title={refItem.src}>{filename}</span>
      <span className="text-[10px] text-muted-foreground/60 shrink-0 hidden sm:inline">
        {'无法内嵌显示'}
      </span>
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => void openExternal(false)}
          className="px-2 py-0.5 rounded-md text-[10.5px] text-primary hover:bg-primary/10 transition-colors border border-border/40"
        >
          {'打开'}
        </button>
        <button
          type="button"
          onClick={() => void openExternal(true)}
          aria-label={'打开所在文件夹'}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors border border-border/40"
        >
          <FolderOpen className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

function FeedbackShot({ refItem, onZoom }: { refItem: ScreenshotRef; onZoom: (r: ScreenshotRef, src: string) => void }) {
  const candidates = useMemo(() => shotSrcCandidates(refItem), [refItem])
  const [idx, setIdx] = useState(0)
  useEffect(() => { setIdx(0) }, [candidates])
  const failed = idx >= candidates.length
  if (failed) return <FallbackShot refItem={refItem} />
  const src = candidates[Math.min(idx, candidates.length - 1)]
  return (
    <button
      type="button"
      onClick={() => onZoom(refItem, src)}
      className="block w-fit max-w-full rounded-lg overflow-hidden border border-border/40 bg-black/40 cursor-zoom-in"
      title={refItem.src}
    >
      <img
        src={src}
        alt={refItem.label}
        onError={() => setIdx((i) => i + 1)}
        draggable={false}
        className="max-h-64 max-w-full w-auto object-contain"
      />
    </button>
  )
}

/**
 * 截图反馈面板：一次工具调用产出的 0..N 张截图，横排内嵌；点击任意一张
 * 进入全屏 lightbox。refs 为空时渲染 null，调用方无需判断。
 */
export function ScreenshotFeedbackPanel({ refs, tool }: { refs: ScreenshotRef[]; tool?: string }) {
  const [active, setActive] = useState<{ ref: ScreenshotRef; src: string } | null>(null)
  if (!refs || refs.length === 0) return null
  return (
    <div className="my-2 rounded-xl border border-border/50 bg-card/60 dark:bg-card/30 backdrop-blur-md max-w-md overflow-hidden shadow-xs">
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/40 border-b border-border/30 text-[10px] text-muted-foreground">
        <span className="font-semibold text-primary flex items-center gap-1">
          <Camera className="h-3 w-3" />
          {'截图反馈'}
          {tool ? <span className="font-mono opacity-70 normal-case">· {tool}</span> : null}
        </span>
        <span className="font-mono text-[9px] opacity-70">
          {refs[0].width && refs[0].height ? `${refs[0].width}×${refs[0].height}` : refs.length + ' 张'}
        </span>
      </div>
      <div className={cn('p-1.5', refs.length > 1 ? 'grid grid-cols-2 gap-1.5' : '')}>
        {refs.map((r, i) => (
          <FeedbackShot key={`${r.source}:${r.src.slice(0, 80)}:${i}`} refItem={r} onZoom={(ref, src) => setActive({ ref, src })} />
        ))}
      </div>
      {active && (
        <ImageLightbox
          src={active.src}
          alt={active.ref.label}
          downloadName={active.ref.source === 'path' ? active.ref.src.split(/[\\/]/).pop() : undefined}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  )
}
