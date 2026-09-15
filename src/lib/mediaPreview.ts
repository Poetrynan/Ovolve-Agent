
// src/lib/mediaPreview.ts
// 媒体预览的纯逻辑层（P1-4 子项一；子项二接入受控文件端点）。
//
// 职责边界：只做"文本/路径 → 可渲染的媒体引用"的推导，不碰 React、不碰
// fetch。拆成独立模块与 goalNormalize 同理——纯函数才配得上单测，组件层
// （MediaPreviewCard）只消费这里的结论。
//
// 数据源事实（2026-09 探查结论）：
//   · 用户消息的附件以 `@file:<path>` 提示行随文本一起进时间线（Composer 序列化）。
//   · 助手消息常在正文里写出产物路径（workspace 相对路径或绝对路径）。
//   · 渲染进程加载方式：dev = http://localhost（file:// 子资源被 webSecurity 拦），
//     prod = file:// 源。因此本地路径不再直接给 file:// URL，而是指向后端受控
//     文件端点 `/api/files?path=…`（P1-4 子项二）：后端做白名单/鉴权/扩展名
//     校验后按正确 Content-Type 回流字节流，dev/prod 两侧都能内嵌渲染。
//     原 file:/// URL 保留在 fileUrl 字段作降级（端点拒绝时 prod 直载仍可用）；
//     能否预览由 srcType 表达。端点 URL 只做字符串加工——API_BASE 与令牌的
//     拼接由组件层完成，本模块保持零环境依赖。

/** 支持内嵌预览的媒体类别。 */
export type MediaKind = 'pdf' | 'image' | 'video' | 'audio'

export const MEDIA_EXTENSIONS: Record<MediaKind, readonly string[]> = {
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac'],
}

const EXT_TO_KIND: Map<string, MediaKind> = (() => {
  const m = new Map<string, MediaKind>()
  for (const [kind, exts] of Object.entries(MEDIA_EXTENSIONS)) {
    for (const e of exts) m.set(e, kind as MediaKind)
  }
  return m
})()

/** 取路径/URL 的小写扩展名（剥 query 与 hash）。无扩展名返回 ''。 */
export function extensionOf(pathOrUrl: string): string {
  const clean = (pathOrUrl || '').split(/[?#]/)[0]
  const dot = clean.lastIndexOf('.')
  if (dot < 0) return ''
  const ext = clean.slice(dot + 1).toLowerCase()
  // 扩展名段不该再含路径分隔符（如 "D:\a.b\c" 这类怪串按无扩展名处理）。
  if (/[\\/]/.test(ext) || ext.length > 8) return ''
  return ext
}

/** 按扩展名归类媒体；不认识的返回 null。 */
export function mediaKindForExtension(ext: string): MediaKind | null {
  return EXT_TO_KIND.get((ext || '').toLowerCase()) ?? null
}

/** 一段裸文本是不是可预览的媒体文件（pdf/图片/视频/音频）。 */
export function classifyMedia(raw: string): MediaKind | null {
  if (!raw) return null
  // data: URI 按 mime 判断。
  const dm = /^data:([a-z0-9.+-]+)\//i.exec(raw)
  if (dm) {
    const sub = raw.slice(dm[0].length).split(/[;,]/)[0].toLowerCase()
    if (dm[1].toLowerCase() === 'application') return sub === 'pdf' ? 'pdf' : null
    return mediaKindForExtension(sub)
  }
  return mediaKindForExtension(extensionOf(raw))
}

/**
 * 本地绝对路径 → `file:///` URL。
 * 逐段 encodeURI，保留 `/` 与驱动器冒号；反斜杠统一为正斜杠。
 */
export function buildFileUrl(rawPath: string): string {
  let p = (rawPath || '').trim()
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')) } catch { /* keep raw */ }
  }
  p = p.replace(/\\/g, '/')
  // file:///D:/... 形式被 strip 前缀后得到 /D:/... —— 还原成 D:/...
  p = p.replace(/^\/([a-zA-Z]:)/, '$1')
  return 'file:///' + encodeURI(p).replace(/^\/+/, '')
}

/**
 * 本地绝对路径 → 后端受控文件端点的相对 URL（P1-4 子项二）。
 * 后端（GET /api/files?path=…）做白名单/鉴权/扩展名校验后按正确 Content-Type
 * 回流字节流，让 dev http 源绕开 Chromium 对 file:// 子资源的拦截。只做字符串
 * 加工：API_BASE 前缀与 ?token= 由组件层（api.ts 的 withTokenQuery）拼接，
 * 本模块不读 window / 不 import 运行时环境。
 */
export function buildFileEndpointPath(rawPath: string): string {
  let p = (rawPath || '').trim()
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//i, '')) } catch { /* keep raw */ }
  }
  p = p.replace(/\\/g, '/')
  // file:///D:/... 形式被 strip 前缀后得到 /D:/... —— 还原成 D:/...
  p = p.replace(/^\/([a-zA-Z]:)/, '$1')
  return '/api/files?path=' + encodeURIComponent(p)
}

/**
 * 媒体引用的可渲染性结论。
 * `endpoint` = 本地文件走后端受控端点（src 是相对端点 URL，fileUrl 是原
 * file:/// 降级）；`unresolved` 只能渲染 chip，不能内嵌预览。
 */
export type ResolvedMedia =
  | { srcType: 'http'; src: string }
  | { srcType: 'data'; src: string }
  | { srcType: 'endpoint'; src: string; fileUrl: string }
  | { srcType: 'unresolved'; src: string }

/**
 * 把一个候选字符串解析成可渲染来源。
 * 返回 null 表示它根本不是媒体（调用方直接跳过）。
 */
export function resolveMediaSrc(raw: string): ResolvedMedia | null {
  const kind = classifyMedia(raw)
  if (!kind) return null
  const s = raw.trim()
  if (/^https?:\/\//i.test(s)) return { srcType: 'http', src: s }
  if (/^data:/i.test(s)) return { srcType: 'data', src: s }
  // 本地路径（file:// URL / Windows 绝对 / POSIX 绝对 / ~/ 约定路径）→
  // 受控端点。白名单裁决在后端：workspace 产物与 ~/.ovolve/cua_shots 可读，
  // 其余 403，前端凭 fileUrl 继续降级，不用猜。
  const isLocal =
    /^file:\/\//i.test(s) ||
    /^[a-zA-Z]:[\\/]/.test(s) ||
    /^~[\\/]/.test(s) ||
    (s.startsWith('/') && !s.startsWith('//'))
  if (isLocal) {
    return { srcType: 'endpoint', src: buildFileEndpointPath(s), fileUrl: buildFileUrl(s) }
  }
  // 工作区相对路径：渲染进程拿不到工作区基准，如实标记为 unresolved，
  // 而不是猜一个假地址（裸文件名在 extractMediaRefs 里已被丢弃）。
  return { srcType: 'unresolved', src: s }
}

export interface MediaRef {
  /** 原文里匹配到的原始片段。 */
  raw: string
  kind: MediaKind
  filename: string
  resolved: ResolvedMedia
}

/** token 两端反复剥掉的包裹符：引号、反引号、成对括号、行内标点。 */
const WRAP_CHARS = '\'"`“”‘’「」『』()[]{}<>，。；：！？,.:;!?'

function unwrapToken(token: string): string {
  let t = token
  for (;;) {
    const before = t
    while (t.length > 0 && WRAP_CHARS.includes(t[0])) t = t.slice(1)
    while (t.length > 0 && WRAP_CHARS.includes(t[t.length - 1])) t = t.slice(0, -1)
    if (t === before) return t
  }
}

function toRef(raw: string): MediaRef | null {
  const clean = raw.trim()
  if (!clean) return null
  const kind = classifyMedia(clean)
  if (!kind) return null
  const resolved = resolveMediaSrc(clean)
  if (!resolved || resolved.srcType === 'unresolved') return null
  const filename = clean.split(/[\\/]/).pop() || clean
  return { raw: clean, kind, filename, resolved }
}

/**
 * 从消息文本里提取可预览的媒体引用。识别四类形态：
 *   1. `@file:<path>` / `@image:<path>` 提及（Composer 序列化格式，逐行一个，
 *      路径可含空格）
 *   2. 绝对路径（D:\x.png、D:/x.png、/home/u/x.png、~/x.png——`~/` 是
 *      cua_shots 约定，后端经 user_dirs 解析）
 *   3. `file:///` URL
 *   4. http(s) 直链
 * 本地形态统一解析为受控端点 URL（含 fileUrl 降级字段）；工作区相对路径
 * 仍被丢弃——渲染进程拿不到工作区基准，宁缺毋滥。裸文件名（没有分隔符）
 * 同样丢弃。结果按解析后的 src 去重（同一路径的不同写法归一），保持出现
 * 顺序，上限 8 条。
 */
export function extractMediaRefs(text: string): MediaRef[] {
  if (!text || text.length > 200_000) return []
  const out: MediaRef[] = []
  const seen = new Set<string>()
  const push = (candidate: string | undefined | null) => {
    if (!candidate) return
    const ref = toRef(candidate)
    if (!ref) return
    const key = ref.resolved.src
    if (seen.has(key)) return
    seen.add(key)
    out.push(ref)
  }

  // 1. 提及行：@file: / @image: 后面到行尾都是路径（可含空格）。
  for (const line of text.split('\n')) {
    const m = /^\s*@(?:file|image):(.+?)\s*$/i.exec(line)
    if (m) push(m[1].replace(/^["'`]+|["'`]+$/g, ''))
  }

  // 2/3/4. 通用扫描：一段不含空白/CJK/引号的连续字符里带路径分隔符、且以
  // 媒体扩展名结尾（Windows 反斜杠、POSIX 斜杠、file://、http(s) 全覆盖）。
  // 排除 CJK 是刻意的：中文标点后常无空格，"保存到C:\x\a.png"必须能截出
  // 路径；代价是中文文件名的路径不自动预览（chip 仍在正文里）——宁缺毋滥。
  const CJK_STOP = "[^\\s\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef\"'`]"
  const scanRe = new RegExp(`${CJK_STOP}*[\\\\/]${CJK_STOP}*\\.(?:${Object.values(MEDIA_EXTENSIONS).flat().join('|')})`, 'gi')
  for (const m of text.matchAll(scanRe)) {
    // unwrapToken 会把行首的 `.` 当标点剥掉："./tmp/x.png" 被截成
    // "/tmp/x.png" 伪装成 POSIX 绝对路径。相对形态（./ ../ …/）维持
    // "不收"——渲染进程没有工作区基准，交给端点只会得到一次必然的 403。
    if (/^\s*\.+[\\/]/.test(m[0])) continue
    push(unwrapToken(m[0]))
  }
  return out.slice(0, 8)
}
