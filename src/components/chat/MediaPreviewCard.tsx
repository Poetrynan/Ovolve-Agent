// src/components/chat/MediaPreviewCard.tsx
// 聊天消息媒体预览卡（P1-4 子项一，G9；子项二接入受控文件端点）。
//
// 此前 ui/src 对 pdf/视频零处理：pdf 路径只是一枚可点击 chip，视频完全没有
// 视觉呈现，图片要靠附件栏的临时预览（随发送即焚）。现在消息正文里出现的
// 媒体文件按类型内嵌渲染：
//   · pdf   → pdfjs-dist（MIT 许可，按许可证正常引用）首页缩略 + 翻页/缩放
//   · image → 直接预览 + 点击进入 ImageLightbox 放大
//   · video → <video> 原生控件
//   · audio → <audio> 原生控件
//
// 本地文件加载链（P1-4 子项二点亮）：受控端点 /api/files 优先——后端做
// 白名单/鉴权/扩展名校验并按正确 Content-Type 回流，dev http 源与 prod
// file:// 源下都可用（dev 经 Vite 代理注入令牌；prod 以 ?token= 携带，
// <img>/<video>/pdfjs 无法设置请求头，走 api_auth 的 query-token 通道）。
// 端点失败（白名单外 403 / 文件消失 404 / 后端未起）→ 降级原 file:/// URL
// （prod 直载仍可用）→ 再失败才落到"外部打开"降级行。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, FileText, FolderOpen, ImageOff,
  Loader2, Maximize2, ZoomIn, ZoomOut,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { API_BASE, absolutize, withTokenQuery } from '../../lib/api'
import { MediaLightbox as ImageLightbox } from './MediaLightbox'
import { extractMediaRefs, type MediaRef } from '../../lib/mediaPreview'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

const ZOOM_STEPS = [0.75, 1, 1.4, 1.9]
const BASE_SCALE = 1.35

/** 一个引用可用的候选加载 URL（按顺序降级，去空去重）。 */
function candidateUrls(media: MediaRef): string[] {
  const r = media.resolved
  if (r.srcType === 'endpoint') {
    // 端点 URL 拼 API_BASE + ?token=（query-token 是 <img>/<video>/pdfjs
    // 唯一能带的鉴权方式，见 api.ts / api_auth 的分工注释）。
    const viaEndpoint = absolutize(withTokenQuery(`${API_BASE}${r.src}`))
    return [viaEndpoint, r.fileUrl].filter((u, i, a) => u && a.indexOf(u) === i)
  }
  return [r.src]
}

/**
 * 候选 URL 依次尝试的加载状态：onError 推进到下一个候选，全部失败置
 * failed（调用方渲染"外部打开"降级行）。
 */
function useCandidateSrc(media: MediaRef): { src: string; onFail: () => void; failed: boolean; hasMore: boolean } {
  const candidates = useMemo(() => candidateUrls(media), [media])
  const [idx, setIdx] = useState(0)
  // 不同消息复用同一组件实例时重置降级进度。
  useEffect(() => { setIdx(0) }, [candidates])
  const failed = idx >= candidates.length
  const onFail = useCallback(() => setIdx((i) => i + 1), [])
  return {
    src: candidates[Math.min(idx, candidates.length - 1)] ?? '',
    onFail,
    failed,
    hasMore: idx < candidates.length - 1,
  }
}

function useExternalOpen() {
  return async (p: string, mode: 'open' | 'folder') => {
    const api = (window as any).electronAPI
    if (!api?.invoke) return
    try {
      await api.invoke('system:openPath', p)
      return
    } catch { /* fall through */ }
    if (mode === 'folder') {
      try { await api.invoke('system:showInFolder', p) } catch { /* ignore */ }
    }
  }
}

/** 加载/预览失败时的降级行：文件 chip + 外部打开按钮。 */
function MediaFallbackRow({ path, filename, reason }: { path: string; filename: string; reason?: string }) {
  const openExternal = useExternalOpen()
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border/50 bg-muted/30 text-xs">
      <ImageOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span className="font-mono text-[11px] text-foreground/80 truncate min-w-0">{filename}</span>
      {reason && <span className="text-[10px] text-muted-foreground/70 truncate hidden sm:inline">{reason}</span>}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => void openExternal(path, 'open')}
          className="px-2 py-0.5 rounded-md text-[10.5px] text-primary hover:bg-primary/10 transition-colors border border-border/40"
        >
          {'打开'}
        </button>
        <button
          type="button"
          onClick={() => void openExternal(path, 'folder')}
          aria-label={'打开所在文件夹'}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors border border-border/40"
        >
          <FolderOpen className="h-3 w-3" />
        </button>
      </div>
    </div>
  )
}

/** 图片直显 + 点击放大。端点失败先降级 file://，再落"外部打开"行。 */
function ImagePreviewCard({ media }: { media: MediaRef }) {
  const [zoom, setZoom] = useState(false)
  const { src, onFail, failed } = useCandidateSrc(media)
  if (failed) return <MediaFallbackRow path={media.raw} filename={media.filename} reason={'无法内嵌加载'} />
  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        className="relative group block w-fit max-w-full rounded-xl overflow-hidden border border-border/50 bg-black/30 cursor-zoom-in"
        title={'点击放大'}
      >
        <img
          src={src}
          alt={media.filename}
          onError={onFail}
          draggable={false}
          className="max-h-72 max-w-full w-auto object-contain"
        />
        <span className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md bg-black/50 text-white/90 pointer-events-none">
          <Maximize2 className="h-3 w-3" />
        </span>
      </button>
      {zoom && (
        <ImageLightbox
          src={src}
          alt={media.filename}
          downloadName={media.filename}
          onClose={() => setZoom(false)}
        />
      )}
    </>
  )
}

/** 视频原生播放器。 */
function VideoPreviewCard({ media }: { media: MediaRef }) {
  const { src, onFail, failed } = useCandidateSrc(media)
  if (failed) return <MediaFallbackRow path={media.raw} filename={media.filename} />
  return (
    <video
      controls
      preload="metadata"
      src={src}
      onError={onFail}
      className="w-full max-h-72 rounded-xl border border-border/50 bg-black/40"
    />
  )
}

/** 音频原生播放器。 */
function AudioPreviewCard({ media }: { media: MediaRef }) {
  const { src, onFail, failed } = useCandidateSrc(media)
  if (failed) return <MediaFallbackRow path={media.raw} filename={media.filename} />
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/50 bg-muted/30 px-2.5 py-1.5 max-w-md">
      <FileText className="h-3.5 w-3.5 shrink-0 text-primary/80" />
      <span className="text-[11px] text-foreground/80 truncate min-w-0">{media.filename}</span>
      <audio controls preload="metadata" src={src} onError={onFail} className="h-8 flex-1 min-w-0" />
    </div>
  )
}

/**
 * PDF 预览：pdfjs-dist 渲染（首页缩略起步，◀ ▶ 翻页，缩放步进）。
 * pdfjs 是重依赖 —— 动态 import，首条 pdf 消息出现才拉包；worker 走 Vite
 * 的 `?url` 产物路径。加载链与图/视/音频一致：受控端点优先（pdfjs 靠 fetch
 * 拿字节流，dev http 源下 file:// 本就不可行），失败降级 file:// URL，再失败
 * 才落"外部打开"行（降级也如实写原因，不静默）。
 */
function PdfPreviewCard({ media }: { media: MediaRef }) {
  const [doc, setDoc] = useState<any>(null)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState(1)
  const [zoomIdx, setZoomIdx] = useState(1)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const docRef = useRef<any>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)
  const { src, onFail, failed, hasMore } = useCandidateSrc(media)

  // 打开文档（src 变化才重建；卸载时销毁文档释放 worker 内存）。
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        const { GlobalWorkerOptions, getDocument } = pdfjs
        GlobalWorkerOptions.workerSrc = workerUrl
        let pdf: any
        if (src.startsWith('data:')) {
          const b64 = src.split(',')[1] || ''
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          pdf = await getDocument({ data: bytes }).promise
        } else {
          pdf = await getDocument({ url: src }).promise
        }
        if (cancelled) { void pdf.destroy(); return }
        docRef.current = pdf
        setDoc(pdf)
        setNumPages(pdf.numPages)
        setPage(1)
        setStatus('ready')
      } catch (e) {
        if (cancelled) return
        // 还有候选（file:// 直载）就先降级重试；全链失败才认输。
        if (hasMore) { onFail(); return }
        setErrMsg(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      docRef.current?.destroy?.()
      docRef.current = null
      setDoc(null)
    }
  }, [src, hasMore, onFail])

  // 渲染当前页。
  useEffect(() => {
    if (!doc || status !== 'ready') return
    let cancelled = false
    void (async () => {
      try {
        renderTaskRef.current?.cancel()
        const p = await doc.getPage(page)
        const viewport = p.getViewport({ scale: BASE_SCALE * ZOOM_STEPS[zoomIdx] })
        const canvas = canvasRef.current
        if (!canvas || cancelled) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        const task = p.render({ canvasContext: ctx, viewport })
        renderTaskRef.current = task
        await task.promise
      } catch (e: any) {
        // RenderingCancelledException 属正常翻页竞态，不算错误。
        if (!cancelled && e?.name !== 'RenderingCancelledException' && !String(e?.message || '').includes('cancel')) {
          setErrMsg(e instanceof Error ? e.message : String(e))
          setStatus('error')
        }
      }
    })()
    return () => { cancelled = true }
  }, [doc, page, zoomIdx, status])

  if (failed || status === 'error') {
    return <MediaFallbackRow path={media.raw} filename={media.filename} reason={errMsg || '本地 PDF 需经文件服务才能内嵌预览'} />
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card/60 dark:bg-card/30 overflow-hidden max-w-md">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-muted/40 border-b border-border/30">
        <FileText className="h-3.5 w-3.5 shrink-0 text-rose-500" />
        <span className="text-[11px] font-medium text-foreground/90 truncate min-w-0">{media.filename}</span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <button
            type="button"
            aria-label={'缩小'}
            disabled={zoomIdx === 0}
            onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ZoomOut className="h-3 w-3" />
          </button>
          <button
            type="button"
            aria-label={'放大'}
            disabled={zoomIdx === ZOOM_STEPS.length - 1}
            onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ZoomIn className="h-3 w-3" />
          </button>
        </span>
      </div>
      <div className="bg-muted/30 dark:bg-black/50 flex items-center justify-center p-2 min-h-40">
        {status === 'loading' && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        <canvas ref={canvasRef} className={cn('max-w-full h-auto rounded-md shadow-md', status !== 'ready' && 'hidden')} />
      </div>
      {status === 'ready' && numPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-2.5 py-1.5 border-t border-border/30 text-[11px] text-muted-foreground">
          <button
            type="button"
            aria-label={'上一页'}
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="p-0.5 rounded hover:bg-muted/60 disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="tabular-nums font-mono">{page} / {numPages}</span>
          <button
            type="button"
            aria-label={'下一页'}
            disabled={page >= numPages}
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
            className="p-0.5 rounded hover:bg-muted/60 disabled:opacity-30"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

/** 按媒体类型分发渲染；不可解析的引用返回 null（正文里已有 chip）。 */
export function MediaPreviewCard({ media }: { media: MediaRef }) {
  if (media.resolved.srcType === 'unresolved') return null
  switch (media.kind) {
    case 'image': return <ImagePreviewCard media={media} />
    case 'video': return <VideoPreviewCard media={media} />
    case 'audio': return <AudioPreviewCard media={media} />
    case 'pdf': return <PdfPreviewCard media={media} />
    default: return null
  }
}

/**
 * 消息正文下的媒体预览条：扫描文本 → 去重 → 逐条渲染预览卡。
 * 无媒体引用时渲染 null（分词扫描开销，气泡场景可常驻）。
 */
export function MediaPreviewStrip({ text }: { text: string }) {
  const refs = useMemo(() => extractMediaRefs(text), [text])
  if (refs.length === 0) return null
  return (
    <div className="mt-2 w-full space-y-2">
      {refs.map((r) => <MediaPreviewCard key={r.resolved.src} media={r} />)}
    </div>
  )
}
