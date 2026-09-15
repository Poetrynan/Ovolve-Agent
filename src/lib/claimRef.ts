// src/lib/claimRef.ts
// 「指认闭环」（U3）前端纯逻辑层。
//
// 后端契约（只读探查 server/http_server.py 与 browser_sessions.py 尾部认领段，
// 未改动一字；失败文案与 tests/test_browser_claim.py 的逐字断言对齐）：
//   · GET /api/browser/tabs?task_id=<id>
//       → 200 {ok: true, task_id, tabs: [{tab_id, title, url, status, active}]}
//       无会话也是 200 空数组（优雅空态）；程序故障 500 {error}。
//   · POST /api/browser/claim  body {task_id, object_id, title_snapshot, url_snapshot}
//       → 成功 200 {ok: true, tab: {...}, claim: {...}}
//       协议拒绝 200 {ok: false, message: <协议原文>} —— message 前端原样渲染
//       不加工。三类固定失败文案（browser_sessions 生成）：
//         「认领失败: 标签 {id} 不存在（可能已关闭）」
//         「认领失败: 对象已变化（引用时: {旧标题} | {旧url} → 当前: {新标题} | {新url}），请重新引用后再认领」
//         「认领失败: 标签不属于当前任务会话」
//   · agent 侧模型可调动作 cua_action {target_ref: "tab:{task_id}/{tab_id}",
//     action: "claim", params: {title_snapshot, url_snapshot}} —— 失败消息出现
//     在工具输出文本里。
//
// 与 screenshotFeedback 同一纪律：不碰 React、无模块级副作用、node 环境可测。
// fetch 走 api.ts 的 apiFetch（自带 X-Api-Token 鉴权头）+ absolutize（相对
// 端点 → 绝对 URL）；api.ts 不做 JSON 封装，这里补 apiGet/apiPost 两个薄壳，
// 不改 api.ts 本体（分区约束）。

import { apiFetch, absolutize } from './api'

// ── 引用形态 ─────────────────────────────────────────────────────────────────

/** 打开中的标签（GET /api/browser/tabs 的行形状，字段名是后端 wire 原样）。 */
export interface TabRefInfo {
  tab_id: string
  title: string
  url: string
  status: string
  active: boolean
}

/** 一条 ovolve://claim/tab 引用的反解结果。 */
export interface ParsedClaimRef {
  objectId: string
  title: string
  url: string
}

/**
 * 把一个标签格式化成可粘贴进输入框的引用文本：
 * `ovolve://claim/tab/{id}?title=...&url=...`（各段 encodeURIComponent）。
 * agent 拿到这段文本就能以 {title, url} 为快照发起 fail-closed 认领。
 */
export function formatClaimRef(tab: { tab_id: unknown; title?: unknown; url?: unknown }): string {
  const id = String(tab?.tab_id ?? '')
  const title = String(tab?.title ?? '')
  const url = String(tab?.url ?? '')
  return `ovolve://claim/tab/${encodeURIComponent(id)}?title=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`
}

/** 从任意文本里反解一条引用（找不到 → null）。容忍查询串缺省/坏转义。 */
export function parseClaimRef(text: unknown): ParsedClaimRef | null {
  if (typeof text !== 'string') return null
  const m = /ovolve:\/\/claim\/tab\/([^?\s']+)(?:\?([^\s]*))?/.exec(text.trim())
  if (!m) return null
  let objectId = m[1]
  try { objectId = decodeURIComponent(objectId) } catch { /* 保留原样 */ }
  let title = ''
  let url = ''
  const query = m[2] || ''
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq)
    const raw = pair.slice(eq + 1)
    let value = raw
    try { value = decodeURIComponent(raw) } catch { /* 坏转义保留原样 */ }
    if (key === 'title') title = value
    else if (key === 'url') url = value
  }
  return { objectId, title, url }
}

/** URL → 域名（下拉里显示 title + 域名用）。解析不出就退回原串。 */
export function hostnameOfUrl(url: unknown): string {
  const s = String(url ?? '').trim()
  if (!s) return ''
  try { return new URL(s).hostname } catch { /* 非 URL 形态走正则兜底 */ }
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s)
  return m ? m[1] : s
}

// ── 认领失败文案解析 ─────────────────────────────────────────────────────────

export type ClaimFailureKind = 'missing' | 'changed' | 'foreign'

export interface ClaimFailureInfo {
  kind: ClaimFailureKind
  /** 仅 missing 带对象号——changed 文案里不含 id，需从调用参数 target_ref 解析。 */
  objectId?: string
  oldTitle?: string
  oldUrl?: string
  newTitle?: string
  newUrl?: string
  /** 命中的协议原文（原样渲染，不加工）。 */
  raw: string
}

/**
 * 三类固定失败前缀的统一识别。changed 分支吃下
 * 「引用时: X | Y → 当前: A | B」的竖线分隔形态（各段懒惰匹配）。
 */
export const CLAIM_FAIL_RE = new RegExp(
  '认领失败[:：]\\s*(?:' +
    '标签\\s*(?<missing>\\S+?)\\s*不存在（可能已关闭）' +
    '|' +
    '对象已变化（引用时:\\s*(?<oldTitle>.*?)\\s*\\|\\s*(?<oldUrl>.*?)' +
    '\\s*→\\s*当前:\\s*(?<newTitle>.*?)\\s*\\|\\s*(?<newUrl>.*?)\\s*），请重新引用后再认领' +
    '|' +
    '标签不属于当前任务会话' +
    ')',
)

/** 从一段工具输出文本解析认领失败（不命中 → null）。 */
export function parseClaimFailure(text: unknown): ClaimFailureInfo | null {
  if (typeof text !== 'string' || !text) return null
  const m = CLAIM_FAIL_RE.exec(text)
  if (!m || !m.groups) return null
  const g = m.groups
  if (g.missing !== undefined) {
    return { kind: 'missing', objectId: g.missing, raw: m[0] }
  }
  if (g.oldTitle !== undefined) {
    return {
      kind: 'changed',
      oldTitle: g.oldTitle,
      oldUrl: g.oldUrl,
      newTitle: g.newTitle,
      newUrl: g.newUrl,
      raw: m[0],
    }
  }
  return { kind: 'foreign', raw: m[0] }
}

/** 一次工具调用的输出候选文本（output 流 + result 串 + result 对象 JSON）。 */
export function claimFailureFromToolCall(
  call: { output?: unknown; result?: unknown },
): ClaimFailureInfo | null {
  const texts: string[] = []
  if (typeof call?.output === 'string' && call.output) texts.push(call.output)
  if (typeof call?.result === 'string' && call.result) texts.push(call.result)
  else if (call?.result && typeof call.result === 'object') {
    try { texts.push(JSON.stringify(call.result)) } catch { /* 循环引用等 → 跳过 */ }
  }
  for (const text of texts) {
    const fail = parseClaimFailure(text)
    if (fail) return fail
  }
  return null
}

// ── target_ref 解析（任务/对象号的唯一诚实来源）──────────────────────────────

/**
 * 解析 agent 动作的 target_ref `tab:{task_id}/{tab_id}`。
 * 认领失败文案里只有 missing 带对象号；changed/foreign 的重试都靠这里拿
 * taskId/objectId。解析不出返回 null —— 上层绝不硬造。
 */
export function parseTabTargetRef(targetRef: unknown): { taskId: string; objectId: string } | null {
  if (typeof targetRef !== 'string') return null
  const m = /^tab:([^/]+)\/(.+)$/.exec(targetRef.trim())
  if (!m) return null
  const taskId = m[1].trim()
  const objectId = m[2].trim()
  if (!taskId || !objectId) return null
  return { taskId, objectId }
}

// ── API 封装（对齐 api.ts 的 apiFetch/absolutize 手法）───────────────────────

/** api.ts 只供字节流/裸 fetch；这里补 JSON 薄壳。非 2xx 一律抛错（含原文）。 */
async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(absolutize(path))
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(absolutize(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`POST ${path} failed: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

/** GET /api/browser/tabs → 打开中的标签清单（含挂起；closed 后端已过滤）。 */
export async function fetchBrowserTabs(taskId: string): Promise<TabRefInfo[]> {
  const data = await apiGet<{ ok?: boolean; task_id?: string; tabs?: TabRefInfo[] }>(
    `/api/browser/tabs?task_id=${encodeURIComponent(taskId)}`,
  )
  return Array.isArray(data?.tabs) ? data.tabs : []
}

/** POST /api/browser/claim 的原样回执：协议拒绝时 {ok:false, message}。 */
export interface ClaimResult {
  ok: boolean
  message?: string
  error?: string
  tab?: Partial<TabRefInfo>
  claim?: Record<string, unknown>
}

/** POST /api/browser/claim —— 回执原样透传，不吞协议拒绝（那是业务结果）。 */
export async function claimTab(
  taskId: string,
  ref: { object_id: string; title_snapshot?: string; url_snapshot?: string },
): Promise<ClaimResult> {
  return apiPost<ClaimResult>('/api/browser/claim', {
    task_id: taskId,
    object_id: ref.object_id,
    title_snapshot: ref.title_snapshot ?? '',
    url_snapshot: ref.url_snapshot ?? '',
  })
}

// ── 一键重新指认（可注入 deps 的纯编排，卡片与测试共用）──────────────────────

export type ClaimRetryOutcome =
  | { outcome: 'claimed'; tab: TabRefInfo; message: string }
  | { outcome: 'tab-gone'; tabs: TabRefInfo[] }
  | { outcome: 'rejected'; message: string }
  | { outcome: 'error'; message: string }

/** 第二次认领被拒且后端没给 message 时的兜底文案（诚实降级，不冒充成功）。 */
const RETRY_REJECTED_FALLBACK = '认领再次被拒绝，请重新引用后再试'

/**
 * 重试流程：拉当前标签表 → 找 objectId → 用最新 {title, url} 重新认领。
 * 每一步的失败都返回可解释的 outcome，绝不假装成功。
 * deps 可注入（测试）；默认走真实 API 封装。
 */
export async function requoteAndClaim(
  taskId: string,
  objectId: string,
  deps?: {
    fetchTabs?: typeof fetchBrowserTabs
    claim?: typeof claimTab
  },
): Promise<ClaimRetryOutcome> {
  const fetchTabs = deps?.fetchTabs ?? fetchBrowserTabs
  const claim = deps?.claim ?? claimTab
  let tabs: TabRefInfo[]
  try {
    tabs = await fetchTabs(taskId)
  } catch (e) {
    return { outcome: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  const current = tabs.find((t) => t && t.tab_id === objectId)
  if (!current) {
    return { outcome: 'tab-gone', tabs }
  }
  try {
    const res = await claim(taskId, {
      object_id: objectId,
      title_snapshot: current.title,
      url_snapshot: current.url,
    })
    if (res.ok) {
      const tab: TabRefInfo = {
        tab_id: current.tab_id,
        title: current.title,
        url: current.url,
        status: res.tab?.status ?? current.status ?? 'active',
        active: res.tab?.active ?? true,
      }
      return { outcome: 'claimed', tab, message: claimRetryMessage(tab) }
    }
    return { outcome: 'rejected', message: res.message || res.error || RETRY_REJECTED_FALLBACK }
  } catch (e) {
    return { outcome: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** 重新指认成功后回填 Composer 的确认消息。 */
export function claimRetryMessage(tab: { tab_id: unknown; title?: unknown; url?: unknown }): string {
  const title = String(tab?.title ?? '').trim() || String(tab?.tab_id ?? '')
  return `已重新指认标签「${title}」，请继续。\n${formatClaimRef(tab)}`
}

// ── Composer 回填通道（CustomEvent）─────────────────────────────────────────

/** ClaimFailureCard 认领成功后广播，Composer 监听并插到输入框光标处。 */
export const COMPOSER_INSERT_EVENT = 'ovolve:composer-insert'

/** 请求把一段文本插进 Composer 光标处（node/无 window 环境安全空转）。 */
export function requestComposerInsert(text: string): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  let event: Event
  if (typeof CustomEvent === 'function') {
    event = new CustomEvent(COMPOSER_INSERT_EVENT, { detail: { text } })
  } else {
    event = new Event(COMPOSER_INSERT_EVENT)
    try { (event as { detail?: unknown }).detail = { text } } catch { /* 只读 → 放弃 */ }
  }
  window.dispatchEvent(event)
}
