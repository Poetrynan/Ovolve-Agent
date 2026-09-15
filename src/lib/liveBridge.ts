// src/lib/liveBridge.ts
// 前端实时桥：后端 aiohttp /ws（app/backend/server/http_server.py）→ 前端 store
// 的唯一入站通路。单例连接 + 指数退避重连 + 帧分发（一个连接，多消费者）。
//
// 侦察结论（后端只读，未改动一字）：
//   · 鉴权：api_auth.auth_middleware 把 /ws 握手当普通 GET 关口；浏览器
//     WebSocket 构造器发不了自定义头，api_auth 的既定呈现方式是 ?token=
//     查询参数——本桥每次建连都经 api.ts 的 withTokenQuery 取同一密钥
//     （回环同一套接字；令牌由 initApiToken 先行取得）。
//   · 入站帧（服务器 → 客户端，_broadcast 形状 {type,timestamp,sessionId,payload}）：
//     tool_call / tool_result / tool_output_delta / tool_call_delta /
//     pending_questions / goal_state_change / evolution_proposal / agent_state /
//     reasoning / agent_delta / turn_state / queue_state …
//   · tool_result 载荷投影（http_server._on_tool_result）：toolCallId / toolName /
//     status（completed | failed | denied | needs_confirmation | needs_input |
//     skipped | unknown —— router._emit_tool_result 的真实枚举）/ ok / preview /
//     exitCode / timedOut / askHeader / askQuestions / askAutoResolved /
//     reversible / snapshot，以及确认停点场景语义的 camelCase 投影
//     confirmReason / scenarioTags / confirmationClass / allowAlways / handoff
//     （meta 不带时整字段缺席——消费端按"缺省=现状"处理）。
//   · 出站帧（客户端 → 服务器，_handle_message）：user_prompt{message,msgId}、
//     respond_permission{decision: approve|approve_always|deny, callId}、
//     respond_question{callId, answers, skipped}、steer{…} 等。确认卡批准/拒绝
//     的回程就是 respond_permission——后端没有对应 REST 端点，回程必须走
//     同一条 WebSocket。
//
// 纪律：后端不在/连接失败 → 静默指数退避重连（不刷控制台、不影响演示驱动）；
// 消费者抛错只烧自己不炸桥；socket 工厂可注入，测试绝不连真后端。

import type { ToolStatus } from '../types/agent'
import { WS_URL, withTokenQuery, initApiToken } from './api'
import { useAgentStore, setLiveTransport, type LiveToolCallPatch } from '../store/agentStore'

// ── 连接状态 ─────────────────────────────────────────────────────────────────

export type LiveConnectionState =
  | 'idle' // 从未启动（或 stop 之后）
  | 'connecting' // 首次建连进行中
  | 'connected' // 在线
  | 'reconnecting' // 掉线，退避计时中
  | 'stopped' // 显式停止（根组件卸载）

/** 一条服务器推送帧（后端封套 {type, timestamp, sessionId, payload}）。 */
export interface LiveFrame {
  type: string
  timestamp?: number
  sessionId?: string
  payload?: unknown
  [key: string]: unknown
}

export type FrameConsumer = (frame: LiveFrame) => void

/** 最小 socket 行为面（浏览器 WebSocket 结构性满足；测试注入假件）。 */
export interface LiveSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type LiveSocketFactory = (url: string) => LiveSocket

export interface LiveBridgeOptions {
  /** 覆盖目标 URL（默认 api.ts 的 WS_URL，逐次建连时再取令牌）。 */
  url?: string
  /** socket 工厂（测试注入假件；默认浏览器 WebSocket）。 */
  socketFactory?: LiveSocketFactory
  /** 首次重连退避（默认 800ms）。 */
  baseDelayMs?: number
  /** 退避上限（默认 15s）。 */
  maxDelayMs?: number
}

// ── 默认 socket 工厂 ─────────────────────────────────────────────────────────

const defaultSocketFactory: LiveSocketFactory = (url) => {
  // node / 无 DOM 环境（测试、SSR）没有 WebSocket：抛给调用方静默重连，
  // 绝不在模块层炸掉。真实环境里浏览器 WebSocket 结构性满足 LiveSocket。
  if (typeof WebSocket === 'undefined') {
    throw new Error('liveBridge: WebSocket unavailable in this environment')
  }
  return new WebSocket(url) as unknown as LiveSocket
}

// ── 运行时 ───────────────────────────────────────────────────────────────────

interface LiveRuntime {
  /** 覆盖 URL（测试注入）；缺省时每次建连现取 api.ts 的 WS_URL ——
   * Electron 下后端实际端口由 initApiToken 异步修正，捕获时机太早会永久失联。 */
  opts: {
    url?: string
    socketFactory: LiveSocketFactory
    baseDelayMs: number
    maxDelayMs: number
  }
  socket: LiveSocket | null
  attempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  state: LiveConnectionState
  stopped: boolean
  connectionListeners: Set<(s: LiveConnectionState) => void>
  consumers: Map<string, Set<FrameConsumer>>
  starConsumers: Set<FrameConsumer>
  /** 本桥喂给 store 的后端工具调用号——确认回程只对它们出帧。 */
  liveToolCallIds: Set<string>
  stop: () => void
}

let runtime: LiveRuntime | null = null

/** 桥未启动时到达的消费者注册（goalStore 先于 App 挂载的兜底）。 */
const pendingRegistrations: Array<{ type: string; consumer: FrameConsumer }> = []

function connectionStateOf(rt: LiveRuntime | null): LiveConnectionState {
  return rt ? rt.state : 'idle'
}

function setState(rt: LiveRuntime, next: LiveConnectionState): void {
  if (rt.state === next) return
  rt.state = next
  for (const listener of [...rt.connectionListeners]) {
    try {
      listener(next)
    } catch {
      /* 订阅者故障不影响桥 */
    }
  }
}

// ── 状态映射 ─────────────────────────────────────────────────────────────────

/**
 * 后端 tool_result status（router._emit_tool_result 的真实枚举）→ 前端 ToolStatus。
 * completed/ok/skipped 是终态成功；denied/failed/unknown 是终态失败；
 * needs_confirmation/needs_input 原样透传（确认卡/提问卡的驱动状态）。
 * 未知值一律落 failed——宁可亮红灯也绝不把卡片悬挂在 running 上。
 */
export function mapToolStatus(status: unknown): ToolStatus {
  switch (status) {
    case 'completed':
    case 'ok':
    case 'skipped':
      return 'done'
    case 'needs_confirmation':
      return 'needs_confirmation'
    case 'needs_input':
      return 'needs_input'
    case 'denied':
    case 'failed':
    default:
      return 'failed'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function payloadOf(frame: LiveFrame): Record<string, unknown> {
  return isPlainObject(frame.payload) ? frame.payload : {}
}

// ── 内建消费者：tool 帧 → agentStore ─────────────────────────────────────────

function handleToolCallFrame(rt: LiveRuntime, frame: LiveFrame): void {
  const p = payloadOf(frame)
  if (p.toolCallId == null) return
  const id = String(p.toolCallId)
  rt.liveToolCallIds.add(id)
  useAgentStore.getState().upsertLiveToolCall({
    id,
    tool: typeof p.toolName === 'string' ? p.toolName : '',
    args: isPlainObject(p.args) ? (p.args as Record<string, any>) : {},
    status: 'running',
  })
}

function handleToolResultFrame(rt: LiveRuntime, frame: LiveFrame): void {
  const p = payloadOf(frame)
  if (p.toolCallId == null) return
  const id = String(p.toolCallId)
  rt.liveToolCallIds.add(id)
  const patch: LiveToolCallPatch = { id, status: mapToolStatus(p.status) }
  if (typeof p.toolName === 'string') patch.tool = p.toolName
  const preview = typeof p.preview === 'string' ? p.preview : undefined
  if (preview !== undefined) {
    // ok=false 时 preview 是错误原文 → 落 error；否则是结果摘录 → 落 output。
    if (p.ok === false) patch.error = preview
    else patch.output = preview
  }
  // 场景语义投影：只透传后端真正带来的字段（缺省=现状，undefined 绝不覆盖）。
  if (typeof p.confirmReason === 'string') patch.confirmReason = p.confirmReason
  if (Array.isArray(p.scenarioTags)) {
    patch.scenarioTags = p.scenarioTags.filter((t): t is string => typeof t === 'string')
  }
  if (typeof p.confirmationClass === 'string') patch.confirmationClass = p.confirmationClass
  if (typeof p.allowAlways === 'boolean') patch.allowAlways = p.allowAlways
  if (typeof p.handoff === 'boolean') patch.handoff = p.handoff
  useAgentStore.getState().upsertLiveToolCall(patch)
}

// ── 帧分发 ───────────────────────────────────────────────────────────────────

function safeConsume(consumer: FrameConsumer, frame: LiveFrame): void {
  try {
    consumer(frame)
  } catch {
    /* 消费者故障不炸桥 */
  }
}

function dispatchRaw(rt: LiveRuntime, raw: unknown): void {
  if (typeof raw !== 'string') return
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  dispatchFrame(rt, data)
}

function dispatchFrame(rt: LiveRuntime, data: unknown): void {
  if (!isPlainObject(data)) return
  const type = data.type ?? data.event
  if (typeof type !== 'string' || !type) return
  const frame = data as LiveFrame
  const exact = rt.consumers.get(type)
  if (exact) for (const c of [...exact]) safeConsume(c, frame)
  for (const c of [...rt.starConsumers]) safeConsume(c, frame)
}

// ── 建连 / 重连 ──────────────────────────────────────────────────────────────

function scheduleReconnect(rt: LiveRuntime): void {
  if (rt.stopped || rt.reconnectTimer) return
  // 指数退避：800ms → 1.6s → 3.2s → … → 上限（默认 15s）。永不放弃，但也
  // 绝不密打；成功建连后 attempt 归零。全程无控制台输出（静默降级）。
  const delay = Math.min(rt.opts.maxDelayMs, rt.opts.baseDelayMs * Math.pow(2, rt.attempt))
  rt.attempt += 1
  setState(rt, 'reconnecting')
  rt.reconnectTimer = setTimeout(() => {
    rt.reconnectTimer = undefined
    if (rt.stopped) return
    openSocket(rt)
  }, delay)
}

function openSocket(rt: LiveRuntime): void {
  if (rt.stopped || rt.socket) return
  // URL 逐次建连时现取：api.ts 的 WS_URL 可能被 initApiToken 异步修正成
  // 后端实际端口，令牌也是此时才查（withTokenQuery）。
  const url = withTokenQuery(rt.opts.url ?? WS_URL)
  setState(rt, rt.attempt === 0 ? 'connecting' : 'reconnecting')
  let sock: LiveSocket
  try {
    sock = rt.opts.socketFactory(url)
  } catch {
    // 环境无 WebSocket / 工厂故障：静默退避，演示模式照旧。
    scheduleReconnect(rt)
    return
  }
  rt.socket = sock
  sock.onopen = () => {
    rt.attempt = 0
    setState(rt, 'connected')
  }
  sock.onmessage = (ev) => {
    dispatchRaw(rt, ev.data)
  }
  sock.onclose = () => {
    if (rt.socket !== sock) return
    rt.socket = null
    sock.onopen = null
    sock.onmessage = null
    sock.onclose = null
    sock.onerror = null
    if (rt.stopped) {
      setState(rt, 'stopped')
      return
    }
    scheduleReconnect(rt)
  }
  sock.onerror = () => {
    // 浏览器里 error 后必跟 close；假件只发其一也要能走通。
    try {
      sock.close()
    } catch {
      /* onclose 会跟进 */
    }
  }
}

function createRuntime(opts: LiveBridgeOptions): LiveRuntime {
  const rt: LiveRuntime = {
    opts: {
      url: opts.url,
      socketFactory: opts.socketFactory ?? defaultSocketFactory,
      baseDelayMs: opts.baseDelayMs ?? 800,
      maxDelayMs: opts.maxDelayMs ?? 15000,
    },
    socket: null,
    attempt: 0,
    reconnectTimer: undefined,
    state: 'idle',
    stopped: false,
    connectionListeners: new Set(),
    consumers: new Map(),
    starConsumers: new Set(),
    liveToolCallIds: new Set(),
    stop: () => {
      if (runtime !== rt) return
      rt.stopped = true
      if (rt.reconnectTimer) {
        clearTimeout(rt.reconnectTimer)
        rt.reconnectTimer = undefined
      }
      const sock = rt.socket
      rt.socket = null
      if (sock) {
        sock.onopen = null
        sock.onmessage = null
        sock.onclose = null
        sock.onerror = null
        try {
          sock.close()
        } catch {
          /* 已关 */
        }
      }
      rt.consumers.clear()
      rt.starConsumers.clear()
      setLiveTransport(null)
      setState(rt, 'stopped')
      runtime = null
    },
  }

  // 消化桥启动前积压的消费者注册（goalStore 先于根挂载的场景）。
  for (const reg of pendingRegistrations.splice(0)) {
    registerOn(rt, reg.type, reg.consumer)
  }

  // 回程通道（依赖倒置：agentStore 只认 LiveTransport 接口，不 import 桥）。
  setLiveTransport({
    isConnected: () => runtime === rt && rt.state === 'connected' && rt.socket !== null,
    sendUserPrompt: (content) =>
      sendLiveFrame({
        type: 'user_prompt',
        payload: {
          message: content,
          msgId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
      }),
    sendApproval: (toolCallId, approved, feedback) => {
      // 只对本桥见过的 live 卡片出帧——演示卡（dispatchPrompt 的假 git:status）
      // 一律不外发，后端也绝不会为它们跑回合。
      if (!rt.liveToolCallIds.has(toolCallId)) return
      const decision = !approved
        ? 'deny'
        : feedback === '以后都允许'
          ? 'approve_always'
          : 'approve'
      sendLiveFrame({ type: 'respond_permission', payload: { decision, callId: toolCallId } })
    },
  })

  // 内建消费者：工具调用生命周期（创建/更新）。
  registerOn(rt, 'tool_call', (frame) => handleToolCallFrame(rt, frame))
  registerOn(rt, 'tool_result', (frame) => handleToolResultFrame(rt, frame))

  // 首连等令牌：initApiToken 极快（Electron IPC / 非 Electron 立即返回），
  // 先取凭据再握手，避免必然失败的首连 401。
  void initApiToken().then(
    () => {
      if (!rt.stopped && !rt.socket && !rt.reconnectTimer) openSocket(rt)
    },
    () => {
      if (!rt.stopped && !rt.socket && !rt.reconnectTimer) openSocket(rt)
    },
  )

  return rt
}

function registerOn(rt: LiveRuntime, type: string, consumer: FrameConsumer): () => void {
  if (type === '*') {
    rt.starConsumers.add(consumer)
    return () => {
      rt.starConsumers.delete(consumer)
    }
  }
  let set = rt.consumers.get(type)
  if (!set) {
    set = new Set()
    rt.consumers.set(type, set)
  }
  set.add(consumer)
  return () => {
    set!.delete(consumer)
    if (set!.size === 0) rt.consumers.delete(type)
  }
}

// ── 公共 API ─────────────────────────────────────────────────────────────────

/**
 * 启动实时桥（幂等单例）：返回停止函数。重复启动返回同一个停止函数——
 * App 根组件与 goalStore.connectGoalEvents 共用一条连接，绝不双连。
 * StrictMode 双挂载下 stop → 再 start 会重建运行时，自愈。
 */
export function startLiveBridge(opts: LiveBridgeOptions = {}): () => void {
  if (runtime) return runtime.stop
  runtime = createRuntime(opts)
  return runtime.stop
}

/** 当前连接状态（桥未启动 → 'idle'）。 */
export function getLiveConnectionState(): LiveConnectionState {
  return connectionStateOf(runtime)
}

/** 订阅连接状态变化；返回退订函数。只收订阅之后的迁移（现值走 getLiveConnectionState）。 */
export function subscribeConnectionState(listener: (s: LiveConnectionState) => void): () => void {
  const rt = runtime
  if (!rt) return () => {}
  rt.connectionListeners.add(listener)
  return () => {
    rt.connectionListeners.delete(listener)
  }
}

/**
 * 注册帧消费者：精确 type（如 'goal_state_change'）或 '*' 透传所有帧
 * （后续消费者的扩展点）。返回退订函数；桥未启动时注册挂起，启动即生效
 * ——退订函数在调用时动态解析当前运行时，挂起注册被桥消化后退订依然有效。
 */
export function registerFrameConsumer(type: string, consumer: FrameConsumer): () => void {
  const rt = runtime
  if (!rt) {
    const reg = { type, consumer }
    pendingRegistrations.push(reg)
    return () => {
      const i = pendingRegistrations.indexOf(reg)
      if (i >= 0) {
        pendingRegistrations.splice(i, 1)
        return
      }
      // 已被启动中的桥消化 → 在当前运行时里退订（按函数引用匹配）。
      const active = runtime
      if (!active) return
      if (type === '*') {
        active.starConsumers.delete(consumer)
        return
      }
      const set = active.consumers.get(type)
      if (set) {
        set.delete(consumer)
        if (set.size === 0) active.consumers.delete(type)
      }
    }
  }
  return registerOn(rt, type, consumer)
}

/**
 * 客户端 → 服务器出站帧（user_prompt / respond_permission / respond_question…）。
 * 仅在已连接时发送；未连接或发送失败返回 false（调用方自行降级）。
 */
export function sendLiveFrame(frame: Record<string, unknown>): boolean {
  const rt = runtime
  if (!rt || rt.state !== 'connected' || !rt.socket) return false
  try {
    rt.socket.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}
