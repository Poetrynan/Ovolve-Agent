// src/lib/screenshotFeedback.ts
// CUA / 浏览器动作截图反馈的识别层（P1-4 子项四）。
//
// 后端事实（只读探查 app/backend，未改动）：
//   · cua_actions.py：side_effect 动作强制回拍，结果对象带 `screenshot_path`
//     （落盘 ~/.ovolve/cua_shots/<ts>.png），RESULT_KEYS 明确含该键。
//   · browser_sessions.py::capture_tab：截图存到 <workspace>/screenshots/
//     tab_<id>_<ts>.png，browser_agent._tab_screenshot 以文本
//     "Screenshot saved: <path> ..." 形式返回。
//   · app_agent._computer_screenshot / browser snapshot：结果带 `data_uri`
//     （前端旧 PIP 卡只认这一种）。
//
// 本模块把上面三种形态统一归一成 ScreenshotRef，供 ScreenshotFeedbackCard
// 渲染；不碰 React。旧 PIP 卡只覆盖 data_uri，路径形态的截图此前只能看到
// 一行文本——这正是要补的洞。P1-4 子项二接通后端受控文件端点后，path 引用
// 额外带 endpointUrl（GET /api/files?path=…，dev http 源可加载），fileUrl
// 保留为 file:// 直载降级。

import { buildFileEndpointPath } from './mediaPreview'

export interface ScreenshotRef {
  /** data-uri = 自带像素；path = 落盘文件（绝对路径）。 */
  source: 'data-uri' | 'path'
  /** data URI 或本地绝对路径。 */
  src: string
  /** 受控文件端点 URL（相对路径，组件层拼 API_BASE+令牌）；端点拒绝时缺席。 */
  endpointUrl?: string
  /** path 引用的 file:/// URL（prod file:// 源可直接加载，作端点失败降级）。 */
  fileUrl?: string
  width?: number
  height?: number
  label: string
}

/** 结果对象里可能携带截图路径的键（与后端 RESULT_KEYS / 返回形状对齐）。 */
const PATH_KEYS = [
  'screenshot_path',
  'shot_path',
  'image_path',
  'saved_path',
  'output_path',
  'file_path',
  'path',
] as const

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

function isImageUrlish(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_EXT_RE.test(value.trim())
}

function dataUriOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  return /^data:image\//i.test(s) ? s : null
}

/** 从一段文本里抠出 data URI（结果被 JSON 化/截断时仍可提取）。 */
function extractInlineDataUri(text: string): string | null {
  const m = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/i.exec(text)
  return m ? m[0] : null
}

function pathRef(src: string, label: string): ScreenshotRef {
  const clean = src.trim().replace(/^["']|["'],?$/g, '')
  let fileUrl: string | undefined
  try {
    // 动态引 mediaPreview 的 buildFileUrl 会造成循环依赖风险？——不会，
    // mediaPreview 不引本模块。但为了保持本文件零依赖可测，这里内联同规则。
    let p = clean.replace(/^file:\/\//i, '')
    try { p = decodeURIComponent(p) } catch { /* keep */ }
    p = p.replace(/\\/g, '/').replace(/^\/([a-zA-Z]:)/, '$1')
    if (/^[a-zA-Z]:\//.test(p) || p.startsWith('/')) {
      fileUrl = 'file:///' + encodeURI(p).replace(/^\/+/, '')
    }
  } catch { /* fileUrl 缺席 = 组件走降级 */ }
  // 端点 URL 直接复用 mediaPreview 的推导（同一条 /api/files 契约，含 `~/`
  // 与 file:// 形态归一；相对路径后端按 workspace 解析）。mediaPreview 不引
  // 本模块，无环。
  const endpointUrl = buildFileEndpointPath(clean)
  return { source: 'path', src: clean, endpointUrl, fileUrl, label }
}

export interface ScreenshotSource {
  toolName?: string
  result?: unknown
  /** 工具的实时输出流（tool_output_delta 累积），文本形态截图声明在这里兜底。 */
  output?: string
}

/**
 * 从一次工具调用里提取所有可内嵌展示的截图。按确定性排序：对象字段 >
 * data URI > 文本声明；同 src 去重，上限 4 张。
 */
export function extractScreenshotRefs(input: ScreenshotSource): ScreenshotRef[] {
  const out: ScreenshotRef[] = []
  const seen = new Set<string>()
  const push = (ref: ScreenshotRef | null) => {
    if (!ref) return
    if (seen.has(ref.src)) return
    seen.add(ref.src)
    out.push(ref)
  }

  const result = input.result
  const obj = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null

  // 1. 对象结果：data_uri（旧 PIP 路径）+ 路径键（CUA 动作 / tab_screenshot）。
  if (obj) {
    const du = dataUriOf(obj.data_uri) ?? dataUriOf(obj.dataUri)
    if (du) {
      push({
        source: 'data-uri',
        src: du,
        width: typeof obj.width === 'number' ? obj.width : undefined,
        height: typeof obj.height === 'number' ? obj.height : undefined,
        label: input.toolName || '截图',
      })
    }
    for (const key of PATH_KEYS) {
      const v = obj[key]
      if (isImageUrlish(v)) push(pathRef(v, input.toolName || '截图'))
    }
  }

  // 2. 字符串结果：整体就是 data URI（旧实现兼容）。
  if (typeof result === 'string') {
    const whole = dataUriOf(result)
    if (whole) {
      push({ source: 'data-uri', src: whole, label: input.toolName || '截图' })
    } else if (result.includes('data:image/')) {
      const embedded = extractInlineDataUri(result)
      if (embedded) push({ source: 'data-uri', src: embedded, label: input.toolName || '截图' })
    }
  }

  // 3. 文本兜底：result 或 output 中的截图路径声明（"Screenshot saved: <path>"、
  //    "截图已保存到 <path>"），以及任何以图片扩展名结尾的绝对路径段。
  //    扫描段排除空白与 CJK：中文标点后常无空格（"保存到C:\x\a.png"），
  //    CJK 边界即路径边界；`~` 开头的 home 相对路径也收（fileUrl 缺席 →
  //    组件走"外部打开"降级）。
  const IMAGE_EXTS = 'png|jpe?g|gif|webp|bmp|avif'
  const SEG = "[^\\s\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef\"'`]"
  const pathScan = new RegExp(`${SEG}*(?:[\\\\/]|~[\\\\/])${SEG}*\\.(?:${IMAGE_EXTS})`, 'gi')
  const texts = [typeof result === 'string' ? result : '', input.output || ''].filter(Boolean)
  for (const text of texts) {
    // 数据 URI 内嵌在长文本里时先抠走，避免把 base64 当路径扫。
    const scrubbed = text.includes('data:image/') && !dataUriOf(text.trim())
      ? text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '')
      : text
    for (const m of scrubbed.matchAll(pathScan)) {
      const t = m[0].replace(/^[(<\['"`]+|[.,;:>)\]}'"`]+$/g, '')
      if (!/^(?:[a-zA-Z]:[\\/]|\/|~\/|file:\/\/)/i.test(t)) continue
      push(pathRef(t, input.toolName || '截图'))
    }
  }

  return out.slice(0, 4)
}
