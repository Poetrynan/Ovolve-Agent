/**
 * http_server_s1.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S1+S2**：
 * `WebSocketHandler` 整类（源 **40–2795**，S1 = 40–1136 事件面 / S2 = 1137–2795 回合执行与消息分派）。
 *
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md`（§S1 = 1 条注册 / 1 个 handler `handle_websocket`）
 * · 镜像层单一来源 `http_server_keys.ts` §M：本文件对 §M 已 export 的符号**全部 import，零私有副本**
 *   （判定：`node tmp/lead_mirror_single_source_check.mjs s1` 必须 `dup=0`）。
 * 风格母版：已落地的 S3（`app/engine/server/http_server_s3.ts`）与验收过的 S6 草稿——
 *   seam 对象 + fail-closed 缺省 + CPython 异常镜像从 keys.ts import；本段**只带私有异常**（不 export）。
 *
 * ── 覆盖清单（74 个 def + 1 个 class + 6 个嵌套闭包；行号全部来自源文件实测） ──────────
 *  S1（40–1136，事件面）
 *    40        class WebSocketHandler
 *    49        __init__                      （8 个实例字段 + 末尾 _bridge_bus_events()）
 *    83        router                        （@property，主会话 Router）
 *    94        _router_for                   101 _bind_session          108 _turn_running
 *    138       STOP_GRACE_S: float = 3.0     （类属性）
 *    140       _live_turn_tasks_for          163 _hard_cancel_after_grace   198 _spawn_stop_watchdog
 *    213       _bridge_bus_events            （25 条 bus.on，全部 priority=-100）
 *    247 _on_learning_item_event   263 _on_evolution_insight   280 _on_usage   300 _on_subagent_state
 *    320 _on_agent_phase           358 _relay_subagent_activity 392 _event_session 408 _event_branch
 *    424 _on_image_generating      436 _on_model_downgraded     458 _on_moa_advisors
 *    474 _on_red_team_alert        488 _on_shadow_validation    498 _on_shadow_applied
 *    508 _on_context_refs_resolved 532 _on_reasoning_delta      551 _on_context_folded
 *    568 _on_tool_call_delta       598 _on_context_precheck     626 _on_pre_tool_use
 *    665 _on_tool_output           688 _on_tool_result          755 _on_pending_questions
 *    772 _on_goal_state_change     781 _on_evolution_proposal   796 _on_agent_state
 *    805 _on_agent_reasoning       818 _on_agent_delta
 *  S1 连接生命周期与失败宽限（837–1136）
 *    837  handle_websocket          918  _queue_state_event      935  _broadcast_queue_state
 *    946  _broadcast_turn_state     972  _settle_turn_state
 *    1015 _ERROR_COPY（8 组文案）   1048 _friendly_error(@classmethod) 1067 _cancel_pending_error
 *    1082 _schedule_error（含嵌套 1108 _commit_later）
 *  S2 回合执行与分派（1137–2795）
 *    1137 _run_turn  1511 _drain_ui_queue  1526 _handle_message（40 个 event_type 臂 + 5 个嵌套闭包
 *         1590 _run_and_drain / 1642 _run_consent / 1711 _run_approved / 1771 _run_answer / 1932 _run_resume）
 *    2044 _send_session_list  2068 _broadcast_session_list  2079 _send_pending_questions
 *    2102 _workspace_list_event  2123 _send_workspace_list  2132 _broadcast_workspace_list
 *    2148 _handle_workspace_switch  2190 rename  2208 pin  2222 hide  2241 settings_get  2257 settings_set
 *    2285 _apply_workspace_settings  2322 _history_messages  2377 _turn_running_sid  2420 _switch_and_reply
 *    2472 _handle_session_new  2479 switch  2489 fork  2572 delete  2612 rename  2622 pin  2631 truncate
 *    2710 _send_error  2733 _deliver  2740 _broadcast      （2795 = 类尾；2796 起是 S0 的模块级 helper）
 *
 * ── 源码自带死路 / 不一致（逐字复制、只标注不修；RULEBOOK §2 BUG 规则，编号 S1-Bn） ──
 * S1-B1  253 / 269：`logging.getLogger(__name__)` 出现在 **文件从未 import logging** 的模块里
 *        （源 16 行只有 `json, asyncio, os, re, time, urllib.parse`）。⇒ 一旦
 *        `_on_learning_item_event` / `_on_evolution_insight` 真的收到**无 session 作用域**的事件，
 *        处理器抛 `NameError: name 'logging' is not defined`，而这只 try 都没有 ⇒ 冒进
 *        `EventBus.emit`。端口同位抛私有 `PyNameErrorP`（不是"接线缺失"，是源事实）。
 * S1-B2  278–279：`_on_evolution_insight` 之后**两个空行 + 一个额外空行**（源里该文件通篇 1 空行分隔），
 *        纯排版抖动，无语义。
 * S1-B3  342–343：`_on_agent_phase` 的 `await self._broadcast({` 与第一个键之间夹了一个空行（343）。
 *        键序仍是 type,timestamp,sessionId,payload ⇒ 帧字节面不受影响。
 * S1-B4  433 / 449：`payload.get("step", 0)` 有默认，而 543（`_on_reasoning_delta`）同样 `step` 却
 *        `payload.get("step", 0)`、689 起 `_on_tool_result` 用 `.get("status","completed")`、
 *        589/615 用 `.get("step")`（**无默认 → None**）。同名键三种姿势是源事实，端口逐字区分。
 * S1-B5  617：`"tokensBefore": payload.get("before")` —— 前端字段名 `tokensBefore` 读的是源键 `before`，
 *        与 560 行 `_on_context_folded` 的 `payload.get("tokensBefore")`（读同名键）**不对称**。
 * S1-B6  650：`args.get("cwd") or ctx.get("workspace_root")` —— args 缺省时 630 已换成 `{}`，
 *        但 args 是**非 dict**（模型写出 `"args": "…"`）时这里 AttributeError 冒出 bus。
 * S1-B7  729–738：`if isinstance(meta, dict)` 恒真（691 行 `meta = payload.get("meta") or {}` 已保证是 dict），
 *        于是这层类型闸是**死闸**；五个 confirm 键按 `is not None` 选择性塞进帧——与同帧其余 12 个键
 *        无条件塞（值可以是 None）两种姿势并存。
 * S1-B8  753–754：`_on_tool_result` 之后**两个**空行，同类排版抖动（B2 家族）。
 * S1-B9  908–916：`finally` 里只 pop 了 `_session_by_ws / _branch_by_ws / _turn_tasks`，
 *        **不 pop `_turn_tasks_by_sid`**，也不 cancel 在飞的回合任务 ⇒ socket 掉线后
 *        `_turn_tasks_by_sid[sid]` 继续指向活任务（新 socket 连上同 sid 时 `_turn_running_sid` 仍说"在跑"）。
 * S1-B10 1096–1106：`turn_retry_window` 帧的 payload 里 `graceSeconds` 用**模块级常量**
 *        `PENDING_RUN_GRACE`（源 23 行 import），而 1110 的 `asyncio.sleep` 用同一个常量、
 *        1115 的 pop 却**不判 pending 是否已被别的重试取走**。三处共享一个常量、两套生命周期。
 * S1-B11 1117：`_commit_later` 里 `router = self.host.get(session_id)`（1116）取了**从不使用**——
 *        死计算，照抄（它唯一的副作用是"可能触发 host.get 的副作用/异常"，而这一句在 try 之外 ⇒
 *        `host.get` 抛异常时后面的 `_send_error`/`completed` 帧**全部不发**，用户永远等不到终态）。
 * S1-B12 1133：`asyncio.create_task(_commit_later())` 的 task 只存进 `_pending_error_timers`，
 *        `_cancel_pending_error` 从 `(session_id, msg_id)` 取 ⇒ 若 grace 窗口内**同一 msg_id 换 session**，
 *        旧计时器无人取消。
 *
 * ── S2（1137–2795）源码自带死路 / 不一致（同 §2 BUG 规则，编号 S2-Bn） ─────────────
 * S2-B1  1207/1214/1215：`_run_turn` 的 `ctx["approved_plan"]` 一次缩进进死支、一次无条件重复 ⇒
 *        任何**不带 `approved_plan` 键**的 `context_extra` 都在 1215 抛 KeyError，且该句在三只 try
 *        之前 ⇒ user_prompt / respond_permission / respond_question / resume_turn 四条臂全中招
 *        （只有 approve_plan 臂 1717 带键、只有 `source="queue"` 因为 `context_extra=None` 整块跳过而活着）。
 *        详见 `_run_turn` 头注。
 * S2-B2  1604/1659/1722/1787/1943：五只闭包的 `finally` 都是**按 key 无条件 pop**，不校验挂着的
 *        还是不是自己 ⇒ 前手收尾会抹掉后手的登记（此后 `_turn_running` 对该 socket 恒 False）。
 * S2-B3  897–904 + 全部分派臂：`_handle_message` 被包在**只接 `json.JSONDecodeError`** 的 try 里
 *        ⇒ 臂内其它异常（`payload` 是 list、`text` 是 int、`**result.value` 非 mapping、
 *        函数内 import 不可用）直接冒出 `handle_websocket` ⇒ 整条 WS 报废 + 踩 S1-B9 的半截清理。
 * S2-B4  1639：`{"approve":…,"deny":…}[decision]` 的 KeyError 面被 1627 的白名单挡死 ⇒ **死支**，
 *        但源用的是下标不是 `.get` ⇒ 端口同样用下标面（`sub`）。
 * S2-B5  1699–1707：`plan_approved` 广播在 `_turn_running` 闸**之前** ⇒ 回合已在跑时前端看到"已批准"，
 *        artifact 也已被置为 approved，执行轮却被拒 ⇒ 方案停留在"批了没人执行"。
 * S2-B6  1540/1756：外层已取 `router`/`q`，`respond_question` 臂又 `_router_for(ws)` 取一次 sid
 *        ⇒ 两行之间 socket 被重绑时，resolve 用新会话、队列属于旧会话（两套会话同臂混用）。
 * S2-B7  1820：`payload.get("urgent_interrupt", True) or payload.get("immediate", False)` ——
 *        客户端传 JSON `null` 也算真 ⇒ 只有显式 `false` 且 `immediate` 不为真才不硬取消。
 * S2-B8  1840/1858/1985：三处 `asyncio.create_task(self._drain_ui_queue(ws))` **不存句柄**
 *        （对比 1133 存进 `_pending_error_timers`）⇒ `interrupt` 的 `_live_turn_tasks_for` 看不见；
 *        而 1872 的 `queue_resume` 用的是 `await` ⇒ 同一个函数三种排空姿势。
 * S2-B9  1878–1892：`sid` 取自**帧**，`router.cancel()` 打在**本 socket 会话**上，pop 的又是帧 sid
 *        ⇒ 客户端重放别的 sessionId 时，取消动作与登记删除分属两个会话。
 * S2-B10 1899 vs 1921：`transition(帧 sid, PAUSED)` 与 `resume` 判定的 `router.session_id` 不同源
 *        ⇒ 在另一窗口按过停止后，本窗口永远报"没有被暂停的回合可以继续"。
 * S2-B11 1958–1963：`killed = cancel_call(cid) if cid else False` 的返回值**原样**进帧
 *        （`"ok": killed`），非 bool 也照发；前端契约是 bool。
 * S2-B12 1670/1671：`plan_id` 允许空串（`str(payload.get("plan_id") or "").strip()`），无前置校验
 *        ⇒ 空串照样 `get_plan_artifact("")`，用户看到的是 `plan not found: `（尾随空值）。
 * S2-B13 2143–2145：`_broadcast_workspace_list` 的 except 体是 `print(...)` + **`return`**
 *        （对比 2076–2077 的 `_broadcast_session_list` 只 print 后继续）⇒ 一只读不出的 socket
 *        会**中断整轮**工作区广播，后面每个窗口都拿不到新列表。
 * S2-B14 2196–2197：同一臂里 `path` 走 `.strip()` 而 `name = (displayName or display_name or "")`
 *        **不 strip** ⇒ 前后空格原样入库并显示（空 name 也允许 ⇒ 等价于"清掉显示名"）。
 * S2-B15 2202/2216/2235 vs 2246/2272：`rename`/`pin`/`hide` 三臂用 `self.router.storage`
 *        （**主**会话 router），`settings_get`/`settings_set`/`switch` 用 `_router_for(ws).storage`
 *        （**本窗口** router）⇒ 同一个 CRUD 簇两套会话句柄姿势（storage 通常同源，语义不一致仍在）。
 * S2-B16 2300/2312/2319：`_apply_workspace_settings` 的三次 `except Exception: pass` **连 print 都没有**
 *        ⇒ workspace 的 model / permission / reasoning 写不进 live router 时用户零反馈，
 *        而 2277 的调用方随后照样把 `settings` 回帧给前端（"设置成功"的脸 + 没生效的实）。
 * S2-B17 2331：`_history_messages` 用 `self.router.storage`（主 router）读**任意 sid** 的历史
 *        ⇒ 与 `_switch_and_reply` "一切按 socket 的 router" 的设计相反（同 B15 家族，影响面更大：
 *        每一次会话切换的时间线都走主 router 的 storage 句柄）。
 * S2-B18 2481/2485：`bid = payload.get("branchId") or payload.get("branch_id") or ""` 之后
 *        `if bid is not None` **恒真**（`or ""` 已保证不是 None）⇒ 不带 branchId 的 `session_switch`
 *        会把这条 socket 的分支**抹成空串**（本意是"没带就别动"）。逐字复刻。
 *
 * ── DIVERGENCE(port)（§D；每条都是"端口与源的可观察差异"，不是待办） ──
 * D1  `id(ws)`（CPython 内存地址）→ 本文件 `py_object_id()` 单调自增 + WeakMap。差异：CPython 会在对象
 *     回收后**复用**地址（`_session_by_ws` 的脏键可被新 socket 继承），端口不复用 ⇒ 端口比源更严格。
 *     908–916 的 pop 语义两侧一致。
 * D2  `asyncio.Task.done()/cancel()/cancelled()` → seam `PyTask`（三方法必提供）。源的
 *     `asyncio.wait(tasks, timeout=STOP_GRACE_S)` 由 seam `asyncio_wait` 承担（超时不抛，与源一致）。
 * D3  `WSMsgType.TEXT/ERROR` 的**整数值**由 seam 提供（端口只按枚举名比较）。端口**不写死** aiohttp 的
 *     数字枚举值——本轮没有 CPython 现场真值，写死即编造（见 STATE「遗留」L1）。
 * D4  f-string / `str()` / `{exc}` 的文案面一律走 keys 的 `py_str` / `exc_str` / `py_repr`，
 *     保证 `None → "None"`、`True → "True"` 与 CPython 同脸。
 * D5  切片 `clean_msg[7:]`（按码点）→ `String.prototype.slice`（按 UTF-16 单元）。两侧对
 *     `/review`、`/simplify` 等 ASCII 前缀逐字节一致；非 BMP 前缀在本段不可达（前缀字面量全是 ASCII）。
 * D6  `dict` 插入序 = JS 对象字面量键序；`{**payload, "sessionId": …}` = JS 展开（右侧胜、位置保持）。
 * D7  `time.time()` → seam `now()`（秒、浮点）。缺省 `Date.now()/1000` 是端口唯一"合理缺省"的缝，
 *     探针必须覆盖（同 S3 的处理）。
 * D8  `except asyncio.CancelledError: raise`（1362）与 `_commit_later` 的 1111 同款：端口用私有
 *     `PyCancelledErrorP` 作 catch 面，由 seam 的 await 点抛出。
 * D9  `await ws.send_json(...)` 的序列化由 seam 承担；`json.loads(msg.data)` 的失败面镜像为私有
 *     `PyJsonDecodeErrorP`，且**只**被源 903 那一只 try 捕获（与 §S1-B1/S1-B11 的"无 try"分支互不串）。
 * D10 `except Exception`（源 185/1823/1884/847/865/873/891/1362…）在 CPython 3.8+ **不接**
 *     `asyncio.CancelledError`（它是 BaseException）⇒ 端口的每个裸 catch 先过
 *     `swallow_if_exception`（`BaseException` 族 ⇒ 重抛），再执行源的 except 体。
 *     例外：`_schedule_error`/`_commit_later` 的 1111 是**显式**接 CancelledError 的（源语义如此），
 *     该处不调 `swallow_if_exception`。
 * D11 `str(x).strip().lower()` → `py_strip(py_str(x)).toLowerCase()`（臂 1626/1671）。CPython `lower()`
 *     是全 Unicode 映射，JS `toLowerCase()` 在 `İ`/`Σ` 一类标记上不同脸；本段两个取值面只可能取
 *     ASCII 决策词 ⇒ 差异不可达，如实记录不修。
 * D12 `isinstance(ordinal, int)`（源 2507 / 2653）：CPython 的 `json.loads` 把 `2.0` 解析成 **float**
 *     ⇒ 两臂都判 False（回 "needs a non-negative …"）；端口的 `Number.isInteger(2)` 判 True。
 *     差异完全取决于 seam `json_loads` 是否保留原始 token ⇒ 端口**不猜**，落在 `Number.isInteger` 上，
 *     并把"要不要 raw-token 解析器"登记为 STATE 遗留 L4（夹具可一次性定案）。
 * D13 `list(self.clients)` / `self._session_by_ws.items()` 的**迭代快照**→ `[...this.clients]` /
 *     `for (const [w, s] of this._session_by_ws)`：两侧都是"取快照后循环"，所以 `_deliver` 在循环里
 *     `discard(client)`（源 2738）不会影响本轮剩余投递；`dict` 的插入序 = `Map` 的迭代序（同 D6）。
 *     差异只在**并发写**：源的 `async for` 让出点里若有 handler 往 `clients` 加人，本轮不保证看见——
 *     两侧同一（都是快照），故记录为"同构"，端口未额外加锁。
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import {
  exc_str,
  ModuleNotFoundErrorP,
  py_dict_get,
  py_getattr,
  py_getattr_or,
  py_int,
  py_iter,
  py_map_index,
  py_or,
  py_repr,
  py_str,
  py_strip,
  py_strip_or,
  py_truth,
  py_type_name,
  PyAttributeErrorP,
  PyTypeErrorP,
} from "./http_server_keys.js";
import {
  short as util_short,
  subagent_child_session as util_subagent_child_session,
  tool_reversible as util_tool_reversible,
} from "./http_server_util.js";

/* ══════════════════════════════════════════════════════════════════════════
 * §0 私有异常（各段私有 ⇒ **不 export**，§M 里没有同名符号）
 * ═══════════════════════════════════════════════════════════════════════ */

/** `NameError: name 'logging' is not defined`（S1-B1 的执行者）。 */
class PyNameErrorP extends Error {
  readonly name_of_exc = "NameError";
  constructor(m: string) {
    super(m);
    this.name = "NameError";
  }
}

/** `json.JSONDecodeError`（`json.loads` 的失败面，只在源 903 的那一只 try 里被捕获）。 */
class PyJsonDecodeErrorP extends Error {
  readonly name_of_exc = "JSONDecodeError";
  constructor(m: string) {
    super(m);
    this.name = "JSONDecodeError";
  }
}

/** `asyncio.CancelledError`（源 1362 / 1111 两只窄 catch 的匹配面）。 */
class PyCancelledErrorP extends Error {
  readonly name_of_exc = "CancelledError";
  constructor() {
    super("CancelledError");
    this.name = "CancelledError";
  }
}

/** 族过滤器：源 `except json.JSONDecodeError:`。 */
function is_json_decode_error(exc: unknown): boolean {
  return exc instanceof PyJsonDecodeErrorP;
}

/** 族过滤器：源 `except asyncio.CancelledError:`。 */
function is_cancelled_error(exc: unknown): boolean {
  return exc instanceof PyCancelledErrorP;
}

/**
 * 源里 **40 只** `except Exception:` / `except: pass` 的执行者。
 * CPython 的 `asyncio.CancelledError` 继承 `BaseException`（3.8+）⇒ **不被 `except Exception` 吞**，
 * 必须继续往外冒；端口若写成裸 `catch {}` 就会把取消吃掉（假绿面，见 §D10）。
 */
function swallow_if_exception(exc: unknown): void {
  if (is_cancelled_error(exc)) throw exc;
}

/** `exc.__class__.__name__`（源 1055/1056）。端口的异常镜像把 Python 类名钉在 `name` 上。 */
function exc_class_name(exc: unknown): string {
  if (exc instanceof Error) return exc.name;
  return py_type_name(exc);
}

/** `isinstance(exc, BaseException)`（源 1056）：端口所有 Python 异常都是 `Error` 的子类。 */
function is_base_exception(exc: unknown): boolean {
  return exc instanceof Error;
}

/** 源 253/269：`logging.getLogger(__name__).info(msg)` —— 模块从未 import logging（源 16 行）
 *  ⇒ 属性访问 `logging` 本身就抛，`.info` 永不可达（S1-B1）。 */
function logging_getLogger_info(_msg: string): void {
  throw new PyNameErrorP("name 'logging' is not defined");
}

/** `getattr(obj, name, None)`（源 395/411 的信封读法）：收口到 keys 的 `py_getattr_or`，
 *  这里只是把"默认 None"钉成端口的 null，避免 20 处重复字面量。 */
function py_getattr_or_null(obj: unknown, name: string): unknown {
  return py_getattr_or(obj, name, null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §1 端口侧类型（seam 契约；全部为**段私有**，跨段公共面归 keys.ts / S0）
 * ═══════════════════════════════════════════════════════════════════════ */

/** `result.Result` 的面（源 `from result import Result`；`.ok/.value/.error`）。 */
export interface ResultApi {
  readonly ok: boolean;
  readonly value: unknown;
  readonly error: unknown;
  readonly meta?: unknown;
}

/** `asyncio.Task` 的可观察面（D2）：`done()/cancel()/cancelled()` 三方法必提供；
 *  `add_done_callback` 是 210 行看门狗摘除面的可选缝（seam 不给则端口不保证"何时摘除"，
 *  见 STATE 遗留 L2）。 */
export interface PyTask {
  done(): boolean;
  cancel(): boolean;
  cancelled(): boolean;
  add_done_callback?(callback: (task: PyTask) => void): void;
}

/** `WSMsgType` 的枚举名面（D3：整数值归 seam，端口只比名字）。 */
export type WsMsgKind =
  | "CONTINUATION"
  | "TEXT"
  | "BINARY"
  | "PING"
  | "PONG"
  | "CLOSE"
  | "CLOSING"
  | "CLOSED"
  | "ERROR";

/** `aiohttp.WSMessage`：`.type` + `.data`。 */
export interface WsMessage {
  readonly type: WsMsgKind;
  readonly data: unknown;
}

/** `web.WebSocketResponse(heartbeat=30)`：本段用到的三个面。 */
export interface WebSocketResponseApi {
  prepare(request: unknown): Promise<void>;
  send_json(data: unknown): Promise<void>;
  /** `async for msg in ws`（源的异步迭代臂）。 */
  messages(): AsyncIterable<WsMessage>;
  /** `ws.exception()`（源 906）。 */
  exception(): unknown;
}

/** `router.bus`：本段只用到 `on(event, handler, priority=…)`。 */
export interface EventBusApi {
  on(event: string, handler: (event: unknown) => Promise<unknown>, priority: number): unknown;
}

/** `router.queue` 的 UI 面（源 927 / 1582 / 1808 / 1837–1872 / 1984 用到的方法）。 */
export interface UiQueueApi {
  ui_snapshot(): unknown;
  readonly ui_pending: number;
  readonly is_paused: boolean;
  ui_enqueue(text: unknown, opts?: {
    requested?: unknown; reason?: unknown; urgent?: unknown;
  }): Promise<unknown>;
  ui_take_next(): Promise<unknown>;
  ui_remove(id: unknown): Promise<unknown>;
  ui_clear(): Promise<unknown>;
  ui_update_text(id: unknown, text: unknown): Promise<unknown>;
  ui_promote(id: unknown): Promise<unknown>;
  ui_reorder(ids: readonly unknown[]): Promise<unknown>;
  ui_pause(reason: unknown): Promise<unknown>;
  ui_resume(): Promise<unknown>;
  send_message(text: unknown, deliver_as: unknown, opts?: { sender?: unknown }): Promise<unknown>;
}

/** `storage` 的读取面（本段用到的 11 个方法）。 */
export interface StorageApi {
  list_sessions(limit?: number): unknown;
  get_session(sid: unknown): unknown;
  get_messages(sid: unknown, opts: { limit: number }): readonly unknown[];
  add_message(sid: unknown, role: unknown, content: unknown): unknown;
  rename_session(sid: unknown, title: unknown): unknown;
  set_session_pinned(sid: unknown, pinned: unknown): unknown;
  autotitle_session(sid: unknown, text: unknown): unknown;
  /** 源 2580 `storage.delete_session(sid)`（**无 try** ⇒ 失败冒出 `_handle_message`，见 S2-B3）。 */
  delete_session(sid: unknown): unknown;
  list_workspaces(opts: { always_include: unknown }): unknown;
  upsert_workspace(path: unknown, opts?: { touch_opened?: boolean }): unknown;
  rename_workspace(path: unknown, name: unknown): unknown;
  set_workspace_pinned(path: unknown, pinned: unknown): unknown;
  set_workspace_hidden(path: unknown, hidden: unknown): unknown;
  get_workspace_settings(path: unknown): unknown;
  set_workspace_settings(path: unknown, patch: unknown): unknown;
  seq_of_nth_user_message(sid: unknown, ordinal: unknown): unknown;
  list_user_turns(sid: unknown): readonly unknown[];
  truncate_after_seq(sid: unknown, seq: unknown): unknown;
  branch(sid: unknown, branch_point: unknown, new_sid: unknown, title: unknown): unknown;
}

/** `router`（Router）在本段暴露的面。`getattr` 族一律可选，缺失由 `py_getattr*` 决定抛不抛。 */
export interface RouterApi {
  readonly session_id: string;
  readonly bus: EventBusApi;
  readonly queue: UiQueueApi;
  readonly storage: StorageApi;
  readonly risk?: { pending_for(sid: unknown): unknown } | null;
  readonly memory?: { dream_consolidate(): Promise<unknown> } | null;
  readonly llm?: { context_limit?: unknown } | null;
  readonly compactor?: { estimate_tokens(v: unknown): unknown } | null;
  readonly workspace?: string | null;
  readonly workspace_dir?: string | null;
  readonly effective_workspace?: string | null;
  readonly default_model?: unknown;
  readonly permission_mode?: unknown;
  permission?: unknown;
  workspace_model?: string;
  workspace_thought_level?: string;
  _turn_seq?: number;
  handle(message: unknown, ctx: JsonLike): Promise<ResultApi>;
  cancel(): unknown;
  cancel_hard?(): unknown;
  switch_workspace(path: unknown): ResultApi;
  switch_session(sid: unknown): ResultApi;
  new_session(title?: unknown): ResultApi;
  fold_context(opts: { manual: boolean }): Promise<ResultApi>;
  get_system_prompt?(): unknown;
  _tool_def_tokens?(): unknown;
  _skill_tokens?(): unknown;
}

/** `session_host.SessionHost` 在本段暴露的面。 */
export interface SessionHostApi {
  get_primary(): RouterApi;
  get_or_create(sid: unknown): RouterApi;
  get(sid: unknown): RouterApi | null;
  close(sid: unknown): unknown;
  rebind(old_sid: unknown, new_sid: unknown): unknown;
  readonly generation_id: unknown;
  is_generation_current(gen: unknown): boolean;
  pending_arm(sid: unknown, msg_id: unknown): unknown;
  pending_take_by_key(sid: unknown, msg_id: unknown): unknown;
  pending_commit(token: unknown): unknown;
  dedupe_seen(sid: unknown, key: unknown, opts: { channel: string; kind?: string }): boolean;
}

/** `turn_state.TurnStatus` 的六个成员（**枚举身份由 seam 给**，端口只比引用，见 D3 同族理由）。 */
export interface TurnStatusTokens {
  readonly RUNNING: unknown;
  readonly IDLE: unknown;
  readonly COMPLETED: unknown;
  readonly ERROR: unknown;
  readonly PAUSED: unknown;
  readonly WAITING_USER: unknown;
}

/** `turn_state.get_turn_state()`。 */
export interface TurnStateApi {
  note_phase(sid: unknown, phase: unknown): unknown;
  snapshot(sid: unknown): unknown;
  current(sid: unknown): unknown;
  transition(sid: unknown, status: unknown, substatus?: unknown, force?: unknown): unknown;
}

/** `ask_user.get_ask_user_store()`。 */
export interface AskUserStoreApi {
  pending_for(sid: unknown): unknown;
  snapshot(sid: unknown): unknown;
  /** 源 1757 `resolve(sid, call_id=…, answers=…, skipped=…)`：首参是**位置参**。 */
  resolve(sid: unknown, opts: {
    call_id: unknown; answers: unknown; skipped: unknown;
  }): unknown;
}

/** `snapshot_store.get_snapshot_store()`。 */
export interface SnapshotStoreApi {
  copy_to_session(src: unknown, dst: unknown, branch_point: unknown): unknown;
  rollback_since(sid: unknown, seq: unknown): unknown;
  discard_since(sid: unknown, seq: unknown): unknown;
}

type JsonLike = Record<string, unknown>;

/* ══════════════════════════════════════════════════════════════════════════
 * §2 seam 表（源的 import/全局副作用逐条对应；缺省 = 未接线安全失败）
 * ═══════════════════════════════════════════════════════════════════════ */

export interface HttpS1Seams {
  /** 源 18 `from aiohttp import web` ⇒ `web.WebSocketResponse(heartbeat=30)`（838）。 */
  websocket_response: (opts: { heartbeat: number }) => WebSocketResponseApi;
  /** 源 16 `import json` ⇒ `json.loads`（901）。失败抛 `PyJsonDecodeErrorP`。 */
  json_loads: (text: unknown) => unknown;
  /** 源 16 `import time` ⇒ `time.time()`（全段 40+ 处；D7）。 */
  now: () => number;
  /** 源 16 `import asyncio` ⇒ `asyncio.get_running_loop()`（841）。 */
  get_running_loop: () => unknown;
  /** 源 16/207 `asyncio.create_task(coro)`（207, 1133, 1608, 1662, 1725, 1790, 1840, 1858, 1946）。 */
  create_task: (coro: Promise<unknown>) => PyTask;
  /** 源 184 `asyncio.wait(tasks, timeout=STOP_GRACE_S)`（超时不抛，D2）。 */
  asyncio_wait: (tasks: readonly PyTask[], timeout: number) => Promise<void>;
  /** 源 1110 `await asyncio.sleep(PENDING_RUN_GRACE)`（取消时抛 `PyCancelledErrorP`）。 */
  asyncio_sleep: (seconds: number) => Promise<void>;
  /** 源 23 `from session_host import … PENDING_RUN_GRACE`（1103/1110 两处共用；§M 上收候选，见 STATE H1）。 */
  pending_run_grace: () => number;
  /** 源 17 `from uuid import uuid4` ⇒ `uuid4().hex[:8]`（2527）。 */
  uuid4_hex8: () => string;
  /** 源 193/906/1077… `print(...)` 的面。 */
  py_print: (text: string) => void;
  /** 源 26 `from executors import cancel_call`（1958）。 */
  cancel_call: (call_id: unknown) => unknown;
  /** 源 338/883/956/984/1919/1998 `from turn_state import get_turn_state`。 */
  get_turn_state: () => TurnStateApi;
  /** 源 956/1000/1919 `from turn_state import TurnStatus`（枚举成员身份，D3 同族）。 */
  turn_status: () => TurnStatusTokens;
  /** 源 987 `from ask_user import get_ask_user_store`（988, 2088, 2092, 1744 共用同一模块）。 */
  get_ask_user_store: () => AskUserStoreApi;
  /** 源 1744 `from ask_user import deliver_answer, has_waiter`。 */
  ask_user_has_waiter: (call_id: unknown) => unknown;
  ask_user_deliver_answer: (call_id: unknown, answers: unknown, skipped: unknown) => unknown;
  /** 源 1675 `from plan_artifact import approve_plan_artifact, discard_plan_artifact, get_plan_artifact`。 */
  get_plan_artifact: (plan_id: unknown) => unknown;
  approve_plan_artifact: (plan_id: unknown, opts: { approved_with: string }) => unknown;
  discard_plan_artifact: (plan_id: unknown) => unknown;
  /** 源 2548 / 2675 / 2685 `from snapshot_store import get_snapshot_store`。 */
  get_snapshot_store: () => SnapshotStoreApi;
  /** 源 2583 `from persistent_terminal import get_terminal_manager`。 */
  get_terminal_manager: () => { close(sid: unknown): unknown };
  /** 源 1814 `from messaging import DeliverAs` ⇒ `DeliverAs.STEER`。 */
  deliver_as_steer: () => unknown;
  /** 源 2448 `from token_analytics import get_token_analytics`。 */
  get_token_analytics: () => { reset_session(opts: JsonLike): unknown };
  /** 源 2310 `from risk_control import coerce_permission`。 */
  coerce_permission: (v: unknown) => unknown;
  /** 源 1367–1368 `import traceback; traceback.print_exc()`。 */
  traceback_print_exc: () => void;
  /** 源 381 `_subagent_child_session(session_id)`（S0 已落地 util.ts，端口 import）。 */
  subagent_child_session: (sid: unknown) => [string, string] | null;
  /** 源 644 `_tool_reversible(tool_name)`（S0 util）。 */
  tool_reversible: (tool_name: unknown) => boolean;
  /** 源 693 `_short(...)`（S0 util）。 */
  short: (v: unknown) => string;
}

/**
 * 未接线 = 安全失败：
 *  · 所有子系统 getter 抛 `ModuleNotFoundError`（对应源里"在 try 内的 import 被吞成降级、
 *    不在 try 内的 import 冒出 handler"两种姿势并存——S1-B1 那一族的端口执行者）；
 *  · `now()` 是唯一合理缺省（`Date.now()/1000`），源里它每帧必调；
 *  · `websocket_response` / `json_loads` 抛错而不是伪造一个 socket：本段红线是**不绑真端口**。
 */
export const HTTP_S1_SEAMS: HttpS1Seams = {
  websocket_response(_opts: { heartbeat: number }): WebSocketResponseApi {
    throw new ModuleNotFoundErrorP("aiohttp");
  },
  json_loads(_text: unknown): unknown {
    throw new ModuleNotFoundErrorP("json");
  },
  now(): number {
    return Date.now() / 1000;
  },
  get_running_loop(): unknown {
    throw new ModuleNotFoundErrorP("asyncio");
  },
  create_task(_coro: Promise<unknown>): PyTask {
    throw new ModuleNotFoundErrorP("asyncio");
  },
  async asyncio_wait(_tasks: readonly PyTask[], _timeout: number): Promise<void> {
    throw new ModuleNotFoundErrorP("asyncio");
  },
  async asyncio_sleep(_seconds: number): Promise<void> {
    throw new ModuleNotFoundErrorP("asyncio");
  },
  pending_run_grace(): number {
    throw new ModuleNotFoundErrorP("session_host");
  },
  uuid4_hex8(): string {
    throw new ModuleNotFoundErrorP("uuid");
  },
  py_print(_text: string): void {
    return;                                            // 源的 print 面无契约；缺省静默丢弃
  },
  cancel_call(_call_id: unknown): unknown {
    throw new ModuleNotFoundErrorP("executors");
  },
  get_turn_state(): TurnStateApi {
    throw new ModuleNotFoundErrorP("turn_state");
  },
  turn_status(): TurnStatusTokens {
    throw new ModuleNotFoundErrorP("turn_state");
  },
  get_ask_user_store(): AskUserStoreApi {
    throw new ModuleNotFoundErrorP("ask_user");
  },
  ask_user_has_waiter(_call_id: unknown): unknown {
    throw new ModuleNotFoundErrorP("ask_user");
  },
  ask_user_deliver_answer(_call_id: unknown, _answers: unknown, _skipped: unknown): unknown {
    throw new ModuleNotFoundErrorP("ask_user");
  },
  get_plan_artifact(_plan_id: unknown): unknown {
    throw new ModuleNotFoundErrorP("plan_artifact");
  },
  approve_plan_artifact(_plan_id: unknown, _opts: { approved_with: string }): unknown {
    throw new ModuleNotFoundErrorP("plan_artifact");
  },
  discard_plan_artifact(_plan_id: unknown): unknown {
    throw new ModuleNotFoundErrorP("plan_artifact");
  },
  get_snapshot_store(): SnapshotStoreApi {
    throw new ModuleNotFoundErrorP("snapshot_store");
  },
  get_terminal_manager(): { close(sid: unknown): unknown } {
    throw new ModuleNotFoundErrorP("persistent_terminal");
  },
  deliver_as_steer(): unknown {
    throw new ModuleNotFoundErrorP("messaging");
  },
  get_token_analytics(): { reset_session(opts: JsonLike): unknown } {
    throw new ModuleNotFoundErrorP("token_analytics");
  },
  coerce_permission(v: unknown): unknown {
    throw new ModuleNotFoundErrorP("risk_control");
  },
  traceback_print_exc(): void {
    throw new ModuleNotFoundErrorP("traceback");
  },
  subagent_child_session(sid: unknown): [string, string] | null {
    return util_subagent_child_session(sid);
  },
  tool_reversible(tool_name: unknown): boolean {
    return util_tool_reversible(tool_name);
  },
  short(v: unknown): string {
    return util_short(v);
  },
};

/* ══════════════════════════════════════════════════════════════════════════
 * §3 私有 helper（§M **未提供**的那部分；每条在 STATE 里给"为什么不上收"）
 * ═══════════════════════════════════════════════════════════════════════ */

/** `id(obj)`（D1）。非对象（源里不会出现）退化为按值的稳定键。 */
const OBJ_ID = new WeakMap<object, number>();
let OBJ_ID_SEQ = 1;
function py_object_id(v: unknown): number {
  if (v === null || v === undefined) {
    throw new PyTypeErrorP("'NoneType' object is not hashable/id()-able");
  }
  if (typeof v !== "object" && typeof v !== "function") {
    throw new PyTypeErrorP(`id() of non-object '${py_type_name(v)}'`);
  }
  const o = v as object;
  let n = OBJ_ID.get(o);
  if (n === undefined) {
    n = OBJ_ID_SEQ++;
    OBJ_ID.set(o, n);
  }
  return n;
}

/** `bool(x)` —— 端口用 keys 的 `py_truth`，这里只是给"真值脸"一个短名。 */
function py_bool(x: unknown): boolean {
  return py_truth(x);
}

/** `x.strip()`（**没有** `or ""` 前导的那一族，源 1836 `if text.strip():`）：接收者非 str ⇒ AttributeError。
 *  §M 只提供 `(x or "").strip()` 的组合面（`py_strip_or`），源里这两种姿势并存 ⇒ 端口分开建模。 */
function py_strip_method(v: unknown): string {
  if (typeof v !== "string") throw new PyAttributeErrorP(v, "strip");
  return py_strip(v);
}

/** `str(x or "").strip().lower()`（源 1626 `decision`、1671 同族）。 */
function py_lower_str_or_empty(v: unknown): string {
  /* §D11：CPython `str.lower()` 是全 Unicode 映射，JS `toLowerCase()` 在 `İ`/`Σ` 这类标记上不同脸；
   *  本段这两个取值面只可能是 ASCII（approve/deny/discard）⇒ 差异在源里不可达，端口如实记录。 */
  return py_strip(py_str(py_or(v, ""))).toLowerCase();
}

/** `dict(tuple_key)` 的键面：`(session_id, msg_id)` 元组 → 稳定字符串键。 */
function tuple_key2(a: unknown, b: unknown): string {
  return py_str(a) + "\u0000" + py_str(b);
}

/** `getattr(event, "payload")`（源到处是 `event.payload or {}`，属性缺失 ⇒ AttributeError，**无默认**）。 */
function bus_payload(event: unknown): JsonLike {
  const p = py_or(py_getattr(event, "payload"), {});
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    throw new PyAttributeErrorP(p, "get");
  }
  return p as JsonLike;
}

/** `d.get(k)` / `d.get(k, dflt)`（收口到 keys 的 py_dict_get，默认 None→null）。 */
function g(d: unknown, k: string): unknown {
  return py_dict_get(d, k, null);
}
function gd(d: unknown, k: string, dflt: unknown): unknown {
  return py_dict_get(d, k, dflt);
}

/** `d[k]`（下标面：缺键 KeyError(repr(k))，源 1214/1215/1390/1639/1758… 一族）。 */
function sub<T extends JsonLike>(d: T, k: string): unknown {
  return py_map_index(d, k);
}

/** `isinstance(x, dict)`。 */
function is_dict(x: unknown): x is JsonLike {
  if (x === null || x === undefined) return false;
  if (typeof x !== "object") return false;
  if (Array.isArray(x) || x instanceof Uint8Array || x instanceof Set || x instanceof Map) return false;
  return true;
}

/** `{**a, k: v}` 的 `a` 非 mapping 面：CPython 抛 TypeError（端口同位抛，见各调用点行号）。 */
function spread_mapping(x: unknown): JsonLike {
  if (!is_dict(x)) {
    throw new PyTypeErrorP(`argument after ** must be a mapping, not ${py_type_name(x)}`);
  }
  return { ...(x as JsonLike) };
}

/** `"k" in d`（源 2294 / 2314 的按键存在性判定）：非容器 ⇒ `TypeError: argument of type 'X' is not iterable`。 */
function py_in_dict(d: unknown, k: string): boolean {
  if (d === null || d === undefined || (typeof d !== "object" && typeof d !== "string")) {
    throw new PyTypeErrorP(`argument of type '${py_type_name(d)}' is not iterable`);
  }
  if (d instanceof Map) return d.has(k);
  if (typeof d === "string") return d.includes(k);
  if (Array.isArray(d)) return (d as unknown[]).some((v) => v === k);
  return Object.prototype.hasOwnProperty.call(d as JsonLike, k);
}

/** `a == "字符串字面量"`：CPython 的 `str.__eq__` 就是逐字符相等，非 str 一律 False（不做隐式转换）。 */
function py_str_eq(a: unknown, b: string): boolean {
  return typeof a === "string" && a === b;
}

/** `a * b`（源 2345 / 2366 `(created_at or 0) * 1000`）：**str × int 在 CPython 是重复**而非报错，
 *  SQLite 的 TEXT `created_at` 会真的生成一个百万字符的字段 —— 端口如实复刻，不"顺手修成"数值。 */
function py_mul(a: unknown, b: unknown): unknown {
  if (typeof a === "string") {
    if (typeof b !== "number" || !Number.isInteger(b)) {
      throw new PyTypeErrorP(
        `can't multiply sequence by non-int of type '${py_type_name(b)}'`,
      );
    }
    return b <= 0 ? "" : a.repeat(b);
  }
  if (typeof a === "number" && typeof b === "number") return a * b;
  throw new PyTypeErrorP(
    `unsupported operand type(s) for *: '${py_type_name(a)}' and '${py_type_name(b)}'`,
  );
}

/** `a - b`（源 2694 `seq - 1`，**没有** `int()` 前导；对比 fork 臂 2523 有）：非数值 ⇒ TypeError。 */
function py_sub(a: unknown, b: number): number {
  if (typeof a !== "number") {
    throw new PyTypeErrorP(
      `unsupported operand type(s) for -: '${py_type_name(a)}' and 'int'`,
    );
  }
  return a - b;
}

/** 源 2336 的 `except (TypeError, ValueError)`：`json.JSONDecodeError` 是 `ValueError` 的子类，
 *  而本段唯一能产出 ValueError 族的语句就是 `json.loads` ⇒ 端口把两者并成一个判定。 */
function is_type_or_value_error(exc: unknown): boolean {
  return exc instanceof PyTypeErrorP || is_json_decode_error(exc);
}

/* ══════════════════════════════════════════════════════════════════════════
 * §4 class WebSocketHandler —— 源 40–2795
 * ═══════════════════════════════════════════════════════════════════════ */

export class WebSocketHandler {
  /** 源 54 `self.host`。 */
  readonly host: SessionHostApi;
  /** 源 55 `self.clients: set = set()`。 */
  readonly clients = new Set<WebSocketResponseApi>();
  /** 源 59 `self._session_by_ws: dict = {}`（键 = `id(ws)`）。 */
  readonly _session_by_ws = new Map<number, unknown>();
  /** 源 61 `self._branch_by_ws: dict = {}`。 */
  readonly _branch_by_ws = new Map<number, unknown>();
  /** 源 62 `self._loop: Optional[asyncio.AbstractEventLoop] = None`。 */
  _loop: unknown = null;
  /** 源 66 `self._turn_tasks: dict = {}`（键 = `id(ws)`）。 */
  readonly _turn_tasks = new Map<number, PyTask>();
  /** 源 68 `self._turn_tasks_by_sid: dict[str, asyncio.Task] = {}`。 */
  readonly _turn_tasks_by_sid = new Map<unknown, PyTask>();
  /** 源 71 `self._pending_error_timers`（键 = `(session_id, msg_id)` 元组 ⇒ tuple_key2）。 */
  readonly _pending_error_timers = new Map<string, PyTask>();
  /** 源 75 `self._stop_watchdogs: set = set()`。 */
  readonly _stop_watchdogs = new Set<PyTask>();
  /** 全部外部依赖的注入点（缺省 = HTTP_S1_SEAMS，未接线即安全失败）。 */
  readonly seams: HttpS1Seams;

  constructor(host: SessionHostApi, seams: HttpS1Seams = HTTP_S1_SEAMS) {
    /* 源 49–76 */
    this.host = host;
    this.seams = seams;
    this._bridge_bus_events();
  }

  /* ------------------------------------------------------------------
   * Session resolution（源 78–106）
   * ---------------------------------------------------------------- */

  /** 源 82–92 `@property def router`：主会话 Router（会话无关的读 + 无 socket 的 HTTP 路由用）。 */
  get router(): RouterApi {
    return this.host.get_primary();
  }

  /** 源 94–99 `_router_for`：这条 socket 属于哪个会话。 */
  _router_for(ws: unknown): RouterApi {
    const sid = this._session_by_ws.get(py_object_id(ws));
    if (py_bool(sid)) {
      return this.host.get_or_create(sid) as RouterApi;
    }
    return this.host.get_primary();
  }

  /** 源 101–106 `_bind_session`。 */
  _bind_session(ws: unknown, session_id: unknown, branch_id: unknown = ""): void {
    if (py_bool(session_id)) {
      this._session_by_ws.set(py_object_id(ws), session_id);
      if (branch_id !== null && branch_id !== undefined) {
        this._branch_by_ws.set(py_object_id(ws), py_strip(py_str(branch_id)));
      }
    }
  }

  /** 源 108–132 `_turn_running`：按**会话**而非 socket 判定。 */
  _turn_running(ws: unknown = null): boolean {
    if (ws !== null && ws !== undefined) {
      const sid = this._session_by_ws.get(py_object_id(ws));
      if (py_bool(sid)) {
        for (const [w, s] of this._session_by_ws) {
          if (!(s === sid)) continue;
          const t = this._turn_tasks.get(w);
          if (t !== null && t !== undefined && !t.done()) return true;
        }
        return false;
      }
      const task = this._turn_tasks.get(py_object_id(ws));
      return task !== null && task !== undefined && !task.done();
    }
    for (const t of this._turn_tasks.values()) {
      if (t !== null && t !== undefined && !t.done()) return true;
    }
    return false;
  }

  /** 源 134–138 类属性 `STOP_GRACE_S: float = 3.0`。 */
  static readonly STOP_GRACE_S: number = 3.0;

  /** 源 140–161 `_live_turn_tasks_for`。 */
  _live_turn_tasks_for(ws: unknown = null, sid: unknown = ""): PyTask[] {
    const target_sid = py_or(
      sid,
      ws !== null && ws !== undefined ? this._session_by_ws.get(py_object_id(ws)) ?? "" : "",
    );
    const tasks: PyTask[] = [];
    if (py_bool(target_sid)) {
      const t_sid = this._turn_tasks_by_sid.get(target_sid);
      if (t_sid !== null && t_sid !== undefined && !t_sid.done()) tasks.push(t_sid);
      for (const [w, s] of this._session_by_ws) {
        if (s === target_sid) {
          const t = this._turn_tasks.get(w);
          if (t !== null && t !== undefined && !t.done() && !tasks.includes(t)) tasks.push(t);
        }
      }
    } else if (ws !== null && ws !== undefined) {
      const t = this._turn_tasks.get(py_object_id(ws));
      if (t !== null && t !== undefined && !t.done()) tasks.push(t);
    }
    return tasks;
  }

  /** 源 163–196 `_hard_cancel_after_grace`。 */
  async _hard_cancel_after_grace(tasks: readonly PyTask[], router: unknown = null): Promise<void> {
    if (tasks.length === 0) return;                    // 源 181 `if not tasks: return`
    try {
      await this.seams.asyncio_wait(tasks, WebSocketHandler.STOP_GRACE_S);
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 185 `except Exception: pass` —— 无族过滤的宽兜
    }
    if (tasks.some((t) => !t.done())) {
      const hard = router === null || router === undefined
        ? null
        : (router as { cancel_hard?: unknown }).cancel_hard;
      if (typeof hard === "function") {
        try {
          (hard as () => unknown).call(router);
        } catch (exc) {
          this.seams.py_print(`[stop] hard cancel failed: ${exc_str(exc)}`);
        }
      }
    }
    for (const t of tasks) {
      if (!t.done()) t.cancel();
    }
  }

  /** 源 198–210 `_spawn_stop_watchdog`。 */
  _spawn_stop_watchdog(ws: unknown, router: unknown = null): void {
    const tasks = this._live_turn_tasks_for(ws);
    if (tasks.length === 0) return;
    const watchdog = this.seams.create_task(
      this._hard_cancel_after_grace(tasks, router),
    );
    this._stop_watchdogs.add(watchdog);
    /* 源 210 `watchdog.add_done_callback(self._stop_watchdogs.discard)`（D2：回调面归 seam）。 */
    watchdog.add_done_callback?.(() => {
      this._stop_watchdogs.delete(watchdog);
    });
  }

  /* ------------------------------------------------------------------
   * 事件总线桥（源 212–835）
   * ---------------------------------------------------------------- */

  /** 源 213–245 `_bridge_bus_events`：25 条订阅，全部 `priority=-100`，顺序 = 源顺序。 */
  _bridge_bus_events(): void {
    const bus = (this.router as unknown as { bus: EventBusApi }).bus;
    const P = -100;
    bus.on("pre_tool_use", (e) => this._on_pre_tool_use(e), P);
    bus.on("tool_result", (e) => this._on_tool_result(e), P);
    bus.on("tool_output", (e) => this._on_tool_output(e), P);
    bus.on("goal_state_change", (e) => this._on_goal_state_change(e), P);
    bus.on("agent_state", (e) => this._on_agent_state(e), P);
    bus.on("agent_reasoning", (e) => this._on_agent_reasoning(e), P);
    bus.on("agent_delta", (e) => this._on_agent_delta(e), P);
    bus.on("tool_call_delta", (e) => this._on_tool_call_delta(e), P);
    bus.on("context_folded", (e) => this._on_context_folded(e), P);
    bus.on("context_precheck", (e) => this._on_context_precheck(e), P);
    bus.on("agent_reasoning_delta", (e) => this._on_reasoning_delta(e), P);
    bus.on("agent_image_generating", (e) => this._on_image_generating(e), P);
    bus.on("model_downgraded", (e) => this._on_model_downgraded(e), P);
    bus.on("context_refs_resolved", (e) => this._on_context_refs_resolved(e), P);
    bus.on("agent_phase", (e) => this._on_agent_phase(e), P);
    bus.on("pending_questions", (e) => this._on_pending_questions(e), P);
    bus.on("subagent_state", (e) => this._on_subagent_state(e), P);
    bus.on("usage", (e) => this._on_usage(e), P);
    bus.on("evolution_proposal", (e) => this._on_evolution_proposal(e), P);
    bus.on("evolution_insight", (e) => this._on_evolution_insight(e), P);
    bus.on("learning_item_event", (e) => this._on_learning_item_event(e), P);
    bus.on("moa_advisors", (e) => this._on_moa_advisors(e), P);
    bus.on("red_team_alert", (e) => this._on_red_team_alert(e), P);
    bus.on("shadow_validation", (e) => this._on_shadow_validation(e), P);
    bus.on("shadow_applied", (e) => this._on_shadow_applied(e), P);
  }

  /** 源 247–261 `_on_learning_item_event`（无 session ⇒ S1-B1 的 NameError 抛点）。 */
  async _on_learning_item_event(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const sid = this._event_session(payload, { event });
    const bid = this._event_branch(payload, { event });
    if (!py_truth(sid)) {
      logging_getLogger_info(
        "Dropping unscoped learning_item_event: no session in envelope/payload",
      );
      return;
    }
    await this._broadcast({
      type: "learning_item_event",
      timestamp: this.seams.now(),
      sessionId: sid,
      branchId: bid,
      payload: { ...spread_mapping(payload), sessionId: sid, branchId: bid },
    });
  }

  /** 源 263–277 `_on_evolution_insight`（同 S1-B1 抛点）。 */
  async _on_evolution_insight(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const sid = this._event_session(payload, { event });
    const bid = this._event_branch(payload, { event });
    if (!py_truth(sid)) {
      logging_getLogger_info(
        "Dropping unscoped evolution_insight: no session in envelope/payload",
      );
      return;
    }
    await this._broadcast({
      type: "evolution_insight",
      timestamp: this.seams.now(),
      sessionId: sid,
      branchId: bid,
      payload: { ...spread_mapping(payload), sessionId: sid, branchId: bid },
    });
  }

  /** 源 280–298 `_on_usage`：payload 原样过缝（字段名真相源在 router）。 */
  async _on_usage(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "usage",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload,
    });
  }

  /** 源 300–318 `_on_subagent_state`：`subagentId` 缺失即整帧不发。 */
  async _on_subagent_state(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    if (!py_truth(g(payload, "subagentId"))) return;
    await this._broadcast({
      type: "subagent_state",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload,
    });
  }

  /** 源 320–355 `_on_agent_phase`（note_phase 的 fail-open 臂在 try 内；S1-B3 空行面）。 */
  async _on_agent_phase(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const phase = g(payload, "phase");
    if (!py_truth(phase)) return;
    try {
      const ts = this.seams.get_turn_state();
      ts.note_phase(this._event_session(payload), phase);
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 340 `except Exception: pass` —— fail-open
    }
    await this._broadcast({
      type: "agent_phase",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        phase,
        step: g(payload, "step"),
        tool: g(payload, "tool"),
        tools: g(payload, "tools"),
        permission: g(payload, "permission"),
        ok: g(payload, "ok"),
      },
    });
  }

  /** 源 358–390 `_relay_subagent_activity`：子会话事件按 parent 重打标为第二帧。 */
  async _relay_subagent_activity(
    session_id: unknown,
    kind: unknown,
    data: unknown,
  ): Promise<void> {
    const child = this.seams.subagent_child_session(session_id);
    if (child === null) return;
    const parent_sid = child[0];
    const sub_id = child[1];
    await this._broadcast({
      type: "subagent_activity",
      timestamp: this.seams.now(),
      sessionId: parent_sid,
      payload: { subagentId: sub_id, kind, ...spread_mapping(data) },
    });
  }

  /** 源 392–406 `_event_session`：**信封优先**于 payload。 */
  _event_session(payload: unknown, opts: { event?: unknown } = {}): string {
    const event = opts.event === undefined ? null : opts.event;
    if (event !== null) {
      const esid = py_or(
        py_getattr_or_null(event, "session_id"),
        py_getattr_or_null(event, "sessionId"),
      );
      if (py_truth(esid)) return py_str(esid);
    }
    const p = py_or(payload, {}) as JsonLike;
    const sid = py_or(g(p, "session_id"), g(p, "sessionId"));
    if (py_truth(sid)) return py_str(sid);
    const ctx = (py_or(g(p, "context"), {}) as JsonLike);
    const sid2 = py_or(g(ctx, "session_id"), g(ctx, "sessionId"));
    if (py_truth(sid2)) return py_str(sid2);
    return "";
  }

  /** 源 408–422 `_event_branch`（与 `_event_session` 同构，键名换 branch）。 */
  _event_branch(payload: unknown, opts: { event?: unknown } = {}): string {
    const event = opts.event === undefined ? null : opts.event;
    if (event !== null) {
      const eb = py_or(
        py_getattr_or_null(event, "branch_id"),
        py_getattr_or_null(event, "branchId"),
      );
      if (py_truth(eb)) return py_str(eb);
    }
    const p = py_or(payload, {}) as JsonLike;
    const bid = py_or(g(p, "branch_id"), g(p, "branchId"));
    if (py_truth(bid)) return py_str(bid);
    const ctx = (py_or(g(p, "context"), {}) as JsonLike);
    const bid2 = py_or(g(ctx, "branch_id"), g(ctx, "branchId"));
    if (py_truth(bid2)) return py_str(bid2);
    return "";
  }

  /** 源 424–434 `_on_image_generating`（`step` 默认 0 —— S1-B4 姿势一）。 */
  async _on_image_generating(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "image_generating",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: { step: gd(payload, "step", 0) },
    });
  }

  /** 源 436–456 `_on_model_downgraded`（六个键全部 `.get(k, "")`）。 */
  async _on_model_downgraded(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "model_downgraded",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        step: gd(payload, "step", 0),
        reason: gd(payload, "reason", ""),
        failure: gd(payload, "failure", ""),
        fromModel: gd(payload, "fromModel", ""),
        toModel: gd(payload, "toModel", ""),
        toProvider: gd(payload, "toProvider", ""),
      },
    });
  }

  /** 源 458–472 `_on_moa_advisors`（`phase` 默认 "asking"、`elapsed_s` **无默认** —— S1-B4）。 */
  async _on_moa_advisors(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "moa_advisors",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        phase: gd(payload, "phase", "asking"),
        advisors: gd(payload, "advisors", []),
        opinions: gd(payload, "opinions", []),
        elapsed_s: g(payload, "elapsed_s"),
        step: gd(payload, "step", 0),
      },
    });
  }

  /** 源 474–486 `_on_red_team_alert`。 */
  async _on_red_team_alert(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "red_team_alert",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        count: gd(payload, "count", 0),
        sources: gd(payload, "sources", []),
        findings: gd(payload, "findings", []),
      },
    });
  }

  /** 源 488–496 `_on_shadow_validation`：payload 原样。 */
  async _on_shadow_validation(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "shadow_validation",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload,
    });
  }

  /** 源 498–506 `_on_shadow_applied`：payload 原样。 */
  async _on_shadow_applied(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "shadow_applied",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload,
    });
  }

  /** 源 508–530 `_on_context_refs_resolved`（UB2 @ 引用落地的六个统计字段）。 */
  async _on_context_refs_resolved(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "context_refs_resolved",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        total: gd(payload, "total", 0),
        resolved: gd(payload, "resolved", 0),
        failed: gd(payload, "failed", 0),
        truncated: gd(payload, "truncated", 0),
        tokens: gd(payload, "tokens", 0),
        items: gd(payload, "items", []),
      },
    });
  }

  /** 源 532–548 `_on_reasoning_delta`：空 text 早退，随后**双发**（主帧 + 子代理转述帧）。 */
  async _on_reasoning_delta(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const text = py_or(g(payload, "text"), "");
    if (!py_truth(text)) return;
    const sid = this._event_session(payload);
    await this._broadcast({
      type: "reasoning_delta",
      timestamp: this.seams.now(),
      sessionId: sid,
      payload: { step: gd(payload, "step", 0), text },
    });
    await this._relay_subagent_activity(sid, "reasoning", { text });
  }

  /** 源 551–566 `_on_context_folded`：六个键**全部无默认**（S1-B4 姿势三）。 */
  async _on_context_folded(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "folded",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        strategy: g(payload, "strategy"),
        tokensBefore: g(payload, "tokensBefore"),
        estimatedTokensAfter: g(payload, "estimatedTokensAfter"),
        compressionRatio: g(payload, "compressionRatio"),
        manual: g(payload, "manual"),
        summary: g(payload, "summary"),
      },
    });
  }

  /** 源 568–596 `_on_tool_call_delta`：`arguments` 是**原始字符串**，`final` 走 `bool()`。 */
  async _on_tool_call_delta(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "tool_call_delta",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        step: g(payload, "step"),
        index: gd(payload, "index", 0),
        callId: py_or(g(payload, "call_id"), ""),
        toolName: py_or(g(payload, "name"), ""),
        argsText: py_or(g(payload, "arguments"), ""),
        final: py_bool(g(payload, "final")),
      },
    });
  }

  /** 源 598–624 `_on_context_precheck`（S1-B5：`tokensBefore` 读的是 `before`）。 */
  async _on_context_precheck(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "context_precheck",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        step: g(payload, "step"),
        pruned: gd(payload, "pruned", 0),
        tokensBefore: g(payload, "before"),
        tokensAfter: g(payload, "after"),
        overheadTokens: g(payload, "overhead"),
        ceiling: g(payload, "ceiling"),
        fits: gd(payload, "fits", true),
        reason: g(payload, "reason"),
      },
    });
  }

  /** 源 626–663 `_on_pre_tool_use`：主帧 + `_relay_subagent_activity` 双发。 */
  async _on_pre_tool_use(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const tool_name = g(payload, "tool_name");
    const ctx = (py_or(g(payload, "context"), {}) as JsonLike);
    const args = (py_or(g(payload, "args"), {}) as JsonLike);
    const sid = this._event_session(payload);
    await this._broadcast({
      type: "tool_call",
      timestamp: this.seams.now(),
      sessionId: sid,
      payload: {
        toolCallId: g(payload, "call_id"),
        toolName: tool_name,
        args,
        riskLevel: g(ctx, "risk_level"),
        reversible: this.seams.tool_reversible(tool_name),
        cwd: py_or(g(args, "cwd"), g(ctx, "workspace_root")),
        workspaceRoot: g(ctx, "workspace_root"),
        permission: g(ctx, "permission"),
        commandGuard: g(ctx, "_command_verdict"),
        status: "running",
      },
    });
    await this._relay_subagent_activity(sid, "tool_call", {
      toolCallId: g(payload, "call_id"),
      toolName: tool_name,
      status: "running",
    });
  }

  /** 源 665–686 `_on_tool_output`：空 chunk 早退（换行**不**过 `_short`，docstring 明说）。 */
  async _on_tool_output(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const chunk = g(payload, "chunk");
    if (!py_truth(chunk)) return;
    await this._broadcast({
      type: "tool_output_delta",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        toolCallId: g(payload, "call_id"),
        toolName: g(payload, "tool_name"),
        chunk,
      },
    });
  }

  /** 源 688–751 `_on_tool_result`：17 键帧（12 无条件 + 5 个 confirm 键走 S1-B7 死闸）。 */
  async _on_tool_result(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const result = (py_or(g(payload, "result"), {}) as JsonLike);
    const meta = (py_or(g(payload, "meta"), {}) as JsonLike);
    const sid = this._event_session(payload);
    const preview = this.seams.short(
      py_truth(g(result, "ok")) ? g(result, "value") : g(result, "error"),
    );
    const frame_payload: JsonLike = {
      toolCallId: g(payload, "call_id"),
      toolName: g(payload, "tool_name"),
      status: gd(payload, "status", "completed"),
      ok: g(result, "ok"),
      preview,
      exitCode: g(meta, "exit_code"),
      timedOut: py_bool(g(meta, "timed_out")),
      askHeader: g(meta, "ask_header"),
      askQuestions: g(meta, "ask_questions"),
      askAutoResolved: py_bool(g(meta, "ask_auto_resolved")),
      reversible: g(meta, "reversible"),
      snapshot: g(meta, "snapshot"),
    };
    if (is_dict(meta)) {
      for (const [_src, _dst] of [
        ["confirm_reason", "confirmReason"],
        ["scenario_tags", "scenarioTags"],
        ["confirmation_class", "confirmationClass"],
        ["allow_always", "allowAlways"],
        ["handoff", "handoff"],
      ] as const) {
        if (g(meta, _src) !== null) frame_payload[_dst] = g(meta, _src);
      }
    }
    await this._broadcast({
      type: "tool_result",
      timestamp: this.seams.now(),
      sessionId: sid,
      payload: frame_payload,
    });
    await this._relay_subagent_activity(sid, "tool_result", {
      toolCallId: g(payload, "call_id"),
      toolName: g(payload, "tool_name"),
      status: gd(payload, "status", "completed"),
      ok: g(result, "ok"),
      preview,
    });
  }

  /** 源 755–770 `_on_pending_questions`：**全量替换帧**（不是 delta）。 */
  async _on_pending_questions(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "pending_questions",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: { items: py_or(g(payload, "items"), []) },
    });
  }

  /** 源 772–779 `_on_goal_state_change`：payload 原样。 */
  async _on_goal_state_change(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "goal_state_change",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload,
    });
  }

  /** 源 781–794 `_on_evolution_proposal`：只发计数，内容留给前端自己拉。 */
  async _on_evolution_proposal(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "evolution_proposal",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload,
    });
  }

  /** 源 796–803 `_on_agent_state`：payload 原样。 */
  async _on_agent_state(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "agent_state",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload,
    });
  }

  /** 源 805–816 `_on_agent_reasoning`（`step` 无默认、`text` 默认 ""、`final` 默认 False）。 */
  async _on_agent_reasoning(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    await this._broadcast({
      type: "reasoning",
      timestamp: this.seams.now(),
      sessionId: this._event_session(payload),
      payload: {
        step: g(payload, "step"),
        text: gd(payload, "text", ""),
        final: gd(payload, "final", false),
      },
    });
  }

  /** 源 818–834 `_on_agent_delta`：空 text 早退，主帧 + 子代理转述帧。 */
  async _on_agent_delta(event: unknown): Promise<void> {
    const payload = bus_payload(event);
    const text = py_or(g(payload, "text"), "");
    if (!py_truth(text)) return;
    const sid = this._event_session(payload);
    await this._broadcast({
      type: "agent_delta",
      timestamp: this.seams.now(),
      sessionId: sid,
      payload: { step: g(payload, "step"), text },
    });
    await this._relay_subagent_activity(sid, "text", { text });
  }

  /* ------------------------------------------------------------------
   * 连接生命周期（源 837–942）
   * ---------------------------------------------------------------- */

  /**
   * 源 837–916 `handle_websocket`。
   * 四个 fail-open 臂（845/861/871/882）各自一只 `except Exception: pass`；读循环的
   * `except json.JSONDecodeError` 是**唯一**的窄兜（坏 JSON 只回一帧 "Invalid JSON"）；
   * `finally`（908–915）只清三张表 —— `_turn_tasks_by_sid` 不在内（S1-B9）。
   */
  async handle_websocket(request: unknown): Promise<WebSocketResponseApi> {
    const ws = this.seams.websocket_response({ heartbeat: 30 });
    await ws.prepare(request);
    this.clients.add(ws);
    this._loop = this.seams.get_running_loop();

    try {
      await ws.send_json(this._queue_state_event({ ws }));
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 847–848 fail-open
    }

    try {
      const boot_sid = this.host.get_primary().session_id;
      if (py_truth(boot_sid)) await this._switch_and_reply(ws, boot_sid);
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 865–866 fail-open
    }

    try {
      await this._send_pending_questions(ws);
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 873–874 fail-open
    }

    try {
      const sid = this._router_for(ws).session_id;
      await this._deliver(ws, {
        type: "turn_state",
        timestamp: this.seams.now(),
        sessionId: sid,
        payload: this.seams.get_turn_state().snapshot(sid),
      });
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 891–892 fail-open
    }

    try {
      for await (const msg of ws.messages()) {
        if (msg.type === "TEXT") {
          try {
            const data = this.seams.json_loads(msg.data);
            await this._handle_message(ws, data);
          } catch (exc) {
            if (is_json_decode_error(exc)) {
              await this._send_error(ws, "Invalid JSON"); // 源 903–904：只兜解码族
            } else {
              throw exc;
            }
          }
        } else if (msg.type === "ERROR") {
          this.seams.py_print(`WebSocket error: ${py_str(ws.exception())}`);
          break;
        }
      }
    } finally {
      this.clients.delete(ws);
      this._session_by_ws.delete(py_object_id(ws));
      this._branch_by_ws.delete(py_object_id(ws));
      this._turn_tasks.delete(py_object_id(ws));
    }
    return ws;
  }

  /** 源 918–933 `_queue_state_event`：队列是**按会话**的，所以要按 socket 造帧。 */
  _queue_state_event(opts: { ws?: unknown } = {}): JsonLike {
    const ws = opts.ws === undefined ? null : opts.ws;
    const router = ws !== null && ws !== undefined ? this._router_for(ws) : this.router;
    const snap = (router.queue as UiQueueApi).ui_snapshot();
    return {
      type: "queue_state",
      timestamp: this.seams.now(),
      sessionId: router.session_id,
      payload: snap,
    };
  }

  /** 源 935–942 `_broadcast_queue_state`：逐 socket 各发**自己**那份快照（无 try ⇒ 一坏全坏）。 */
  async _broadcast_queue_state(): Promise<void> {
    for (const client of [...this.clients]) {
      await this._deliver(client, this._queue_state_event({ ws: client }));
    }
  }

  /* ── 回合状态（2.1）── 源 944–1002 ───────────────────────────────────── */

  /** 源 946–969 `_broadcast_turn_state`：整臂一只 `except Exception: pass`（968）。 */
  async _broadcast_turn_state(sid: unknown): Promise<void> {
    try {
      const ts = this.seams.get_turn_state();
      const st = this.seams.turn_status();
      const is_live = this._turn_running_sid(sid);
      if (!py_truth(is_live) && ts.current(sid) === st.RUNNING) {
        ts.transition(sid, st.IDLE, undefined, true);   // 源 961 `transition(sid, IDLE, force=True)`
      }
      await this._broadcast({
        type: "turn_state",
        timestamp: this.seams.now(),
        sessionId: sid,
        payload: ts.snapshot(sid),
      });
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 968–969「状态播报失败不该影响回合本身」
    }
  }

  /** 源 972–1002 `_settle_turn_state`：两个权威（ask_user 账本 / risk 待确认）决定 waiting_user。 */
  async _settle_turn_state(sid: unknown, terminal: unknown): Promise<void> {
    const st = this.seams.turn_status();
    let waiting = false;
    try {
      waiting = py_bool(this.seams.get_ask_user_store().pending_for(sid));
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 989–990 fail-open
    }
    if (!waiting) {
      try {
        const router = this.host.get(sid);
        const risk = router === null || router === undefined
          ? null
          : py_getattr_or(router, "risk", null);
        if (risk !== null && risk !== undefined) {
          waiting = py_bool((risk as { pending_for(s: unknown): unknown }).pending_for(sid));
        }
      } catch (exc) {
        swallow_if_exception(exc);                      // 源 997–998 fail-open
      }
    }
    /* 源 984 的 import 与 999–1001 的 transition 都在**任何 try 之外** ⇒ turn_state 不可用时
       整个 settle 臂直接冒出调用方（_run_turn 的三个终态分支就是这么炸给 socket 的）。 */
    this.seams.get_turn_state().transition(sid, waiting ? st.WAITING_USER : terminal);
    await this._broadcast_turn_state(sid);
  }

  /* ------------------------------------------------------------------
   * Retry grace（源 1005–1135）
   * ---------------------------------------------------------------- */

  /** 源 1015–1045 `_ERROR_COPY`：8 组 (needles, message, hint)，**顺序即优先级**（首个命中即返回）。 */
  static readonly _ERROR_COPY: ReadonlyArray<
    readonly [readonly string[], string, string]
  > = [
    [
      ["no attribute", "AttributeError", "TypeError", "NameError",
        "KeyError", "IndexError", "not callable"],
      "程序内部出了点问题，这一轮没能完成。",
      "这是系统自身的缺陷，不是你的操作问题。可以重试一次；如果每次都这样，请把这条反馈给我们。",
    ],
    [
      ["api_key", "API key", "Unauthorized", "401", "invalid_api_key",
        "authentication"],
      "AI 模型拒绝了这次请求，看起来是密钥不对或已过期。",
      "去「设置 → 模型」检查 API Key 是否填对、是否还有效。",
    ],
    [
      ["quota", "insufficient", "billing", "429", "rate limit",
        "rate_limit", "too many requests"],
      "AI 模型这会儿忙不过来，或者账户额度用完了。",
      "稍等十几秒再发一次；如果一直这样，去模型服务商后台看看余额和限流。",
    ],
    [
      ["timeout", "timed out", "ConnectionError", "ClientConnector",
        "Connection reset", "getaddrinfo", "SSL", "network"],
      "网络没连上 AI 模型。",
      "检查一下网络或代理，然后重试。",
    ],
    [
      ["context_length", "context length", "maximum context",
        "too many tokens", "context_exceeded"],
      "这轮对话的内容超过了模型能一次读完的长度。",
      "可以手动折叠一下上下文，或者开个新对话继续。",
    ],
    [
      ["database is locked", "sqlite", "OperationalError"],
      "本地数据库正忙，这次写入没成功。",
      "稍等一下重试即可，数据没有丢。",
    ],
    [
      ["permission", "PermissionError", "Access is denied", "EACCES"],
      "系统拒绝了一次文件访问。",
      "看看这个文件是不是被其他程序占用，或者需要管理员权限。",
    ],
    [
      ["No such file", "FileNotFoundError", "cannot find the path"],
      "要找的文件不在了。",
      "确认一下路径有没有写错，或者文件是不是被移动/删除了。",
    ],
  ];

  /** 源 1047–1065 `_friendly_error`（@classmethod）。 */
  static _friendly_error(exc: unknown): JsonLike {
    const raw = py_or(py_str(exc), exc_class_name(exc));
    const probe = is_base_exception(exc) ? `${exc_class_name(exc)}: ${raw}` : raw;
    const low = py_str(probe).toLowerCase();
    for (const [needles, message, hint] of WebSocketHandler._ERROR_COPY) {
      if (needles.some((n) => low.includes(n.toLowerCase()))) {
        return { message, hint, detail: probe };
      }
    }
    return {
      message: "这一轮没能完成。",
      hint: "可以重试一次；如果反复失败，把这条反馈给我们会很有帮助。",
      detail: probe,
    };
  }

  /** 源 1067–1080 `_cancel_pending_error`：返回"确实 parked 过一个失败"⇒ 调用方据此判 RETRY。 */
  _cancel_pending_error(session_id: unknown, msg_id: unknown): boolean {
    if (!py_truth(msg_id)) return false;
    const key = tuple_key2(session_id, msg_id);
    const had = this._pending_error_timers.has(key);
    const task = had ? this._pending_error_timers.get(key) : null;
    if (had) this._pending_error_timers.delete(key);
    const token = this.host.pending_take_by_key(session_id, msg_id);
    if (task !== null && task !== undefined && !task.done()) task.cancel();
    return (task !== null && task !== undefined) || (token !== null && token !== undefined);
  }

  /** 源 1082–1135 `_schedule_error`：先撤旧计时器，再广播宽限窗，最后挂一只 `_commit_later`。 */
  async _schedule_error(
    ws: unknown,
    session_id: unknown,
    msg_id: unknown,
    error: unknown,
  ): Promise<void> {
    this._cancel_pending_error(session_id, msg_id);
    const token = this.host.pending_arm(session_id, msg_id);
    const err_dict: JsonLike = typeof error === "string"
      ? { message: error, hint: "", detail: "" }
      : (error as JsonLike);
    await this._broadcast({
      type: "turn_retry_window",
      timestamp: this.seams.now(),
      sessionId: session_id,
      payload: {
        error: gd(err_dict, "message", ""),
        hint: gd(err_dict, "hint", ""),
        graceSeconds: this.seams.pending_run_grace(),
        msgId: msg_id,
      },
    });

    const commit_later = async (): Promise<void> => {
      try {
        await this.seams.asyncio_sleep(this.seams.pending_run_grace());
      } catch (exc) {
        if (is_cancelled_error(exc)) return;            // 源 1111–1112
        throw exc;
      }
      if (!py_truth(this.host.pending_commit(token))) return;
      this._pending_error_timers.delete(tuple_key2(session_id, msg_id));
      const router = this.host.get(session_id);          // S1-B11：取了不用，且在 try 之外
      await this._send_error(ws, err_dict);
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        payload: {
          result: "error",
          error: gd(err_dict, "message", ""),
          hint: gd(err_dict, "hint", ""),
          detail: gd(err_dict, "detail", ""),
        },
        sessionId: session_id,                          // 键序：payload 在 sessionId **之前**（源 1118–1128）
      });
      if (router !== null && router !== undefined && (router as RouterApi).queue.ui_pending > 0) {
        await (router as RouterApi).queue.ui_pause("error");
        await this._broadcast_queue_state();
      }
    };

    this._pending_error_timers.set(
      tuple_key2(session_id, msg_id),
      this.seams.create_task(commit_later()),
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
   * S2 —— 回合执行引擎（源 1137–1525）
   * ══════════════════════════════════════════════════════════════════════ */

  /**
   * 源 1137–1509 `_run_turn`。
   * 键序铁律：本函数的 `task_started` 与五个终态臂都是 **payload 在 sessionId 之前**，
   * 而 slash-command 早退臂（1260/1266）是 **sessionId 在 payload 之前** —— 源里就是两套姿势，
   * 端口逐字保持（序列化后的帧字节面不同，见 §D6）。
   *
   * S2-B1（本段最大的源 bug，逐字复刻不修）：1207 的 `if isinstance(refs, list) and refs:` 之后，
   * 1214 那行 `ctx["approved_plan"] = context_extra["approved_plan"]` 被缩进进了 if 体（死支），
   * 1215 又在 `if context_extra:` 层**无条件重复一次** ⇒ 任何不带 `approved_plan` 键的
   * `context_extra` 都在 1215 抛 KeyError，而这一句在 1360 那三只 try **之前** ⇒
   * 异常直接冒出 `_run_turn`（`_run_and_drain` 只有 finally）⇒ 回合从没跑过。
   * `_handle_message` 的五个 `context_extra` 字面量里**只有 `approve_plan` 臂（1717）带这个键**
   * （1596–1599 user_prompt / 1646–1654 consent / 1775–1782 answer / 1936–1938 resume 全无）
   * ⇒ user_prompt / respond_permission / respond_question / resume_turn 四条臂全中招；
   * `queue` 臂（1524）因为 `context_extra=None` 整块跳过反而活着。
   */
  async _run_turn(
    ws: unknown,
    message: unknown,
    opts: { source?: unknown; context_extra?: unknown; msg_id?: unknown } = {},
  ): Promise<void> {
    const source = opts.source === undefined ? "user" : opts.source;
    const context_extra = opts.context_extra === undefined ? null : opts.context_extra;
    const msg_id = opts.msg_id === undefined ? "" : opts.msg_id;

    /* 源 1152–1160：回合属于**发起它的那条 socket**；再打上前代际戳。 */
    const router = this._router_for(ws);
    const generation = this.host.generation_id;

    /* 源 1161–1168：idle/completed/error → running 的唯一入口（import 无 try ⇒ 不可用即冒出）。 */
    const st = this.seams.turn_status();
    const turn_state = this.seams.get_turn_state();
    turn_state.transition(router.session_id, st.RUNNING, "preparing");
    await this._broadcast_turn_state(router.session_id);

    const is_silent = py_bool(
      py_truth(context_extra) ? py_dict_get(context_extra, "silent_consent", null) : context_extra,
    );
    await this._broadcast({
      type: "task_started",
      timestamp: this.seams.now(),
      payload: { message: is_silent ? "" : message, source, silent: is_silent },
      sessionId: router.session_id,
    });

    if (!is_silent) {
      try {
        router.storage.autotitle_session(router.session_id, message);
      } catch (exc) {
        swallow_if_exception(exc);                      // 源 1182–1183 `except Exception: pass`（无注释）
      }
      await this._broadcast_session_list();
      await this._broadcast_workspace_list();
    }

    /* 源 1189–1218：把前端的 permission / model / thought_level / @引用 塞进 turn 上下文。 */
    let ctx: JsonLike = {};
    if (py_truth(context_extra)) {
      const ce = context_extra as JsonLike;
      ctx = {
        permission: g(ce, "permission"),
        model: g(ce, "model"),
        thought_level: g(ce, "thought_level"),
      };
      const refs = g(ce, "context_refs");
      if (Array.isArray(refs) && py_truth(refs)) {
        ctx["context_refs"] = refs;
        /* S2-B1 死支（源 1214）：这一行被 1207 的 if 罩住，且与 1215 完全同式。 */
        ctx["approved_plan"] = sub(ce, "approved_plan");
      }
      ctx["approved_plan"] = sub(ce, "approved_plan"); // S2-B1：源 1215 无条件重复 ⇒ KeyError 抛点
      for (const key of ["consent_decision", "consent_call_id", "question_answer", "silent_consent"]) {
        if (g(ce, key) !== null) ctx[key] = g(ce, key);
      }
    }

    /* ── 0-Token 秒级 Slash Commands 拦截（源 1220–1273）──────────────── */
    const clean_msg = py_strip(py_str(message));
    if (clean_msg === "/status" || clean_msg === "/permissions") {
      router.storage.add_message(router.session_id, "user", message);
      let resp_text: string;
      if (clean_msg === "/status") {
        const ws_dir = py_or(
          py_or(py_getattr_or(router, "workspace", ""), py_getattr_or(router, "workspace_dir", "")),
          "Default",
        );
        const active_mod = py_or(g(ctx, "model"), py_getattr_or(router, "default_model", "Default"));
        const perm = py_or(g(ctx, "permission"), py_getattr_or(router, "permission_mode", "auto"));
        const th_lvl = py_or(g(ctx, "thought_level"), "default");
        resp_text = `### 📊 系统运行状态报告

| 核心维度 | 当前状态 | 架构说明 |
|---|---|---|
| **会话标识** | \`${py_str(router.session_id)}\` | SQLite & EventStore 权威会话 |
| **工作区范围** | \`${py_str(ws_dir)}\` | 当前文件与工程上下文根目录 |
| **主模型引擎** | \`${py_str(active_mod)}\` | 主控编排与推理模型 |
| **思考等级** | \`${py_str(th_lvl)}\` | Reasoning Effort 预算 |
| **风控模式** | \`${py_str(perm)}\` | 当前写操作与命令拦截策略 |
| **Subagent 配额** | \`8\` 并发上限 | 按需只读/隔离子代理并发池 |
| **五大能力分身** | 活跃在线 | Chronos / Engine / Matrix / Voyager / Oracle |

> 💡 **提示**：可直接使用 \`/permissions\` 查看权限矩阵，或输入 \`/review\` 对当前工作区改动发起 3-State 严格代码审查。
`;
      } else {
        const perm = py_or(g(ctx, "permission"), py_getattr_or(router, "permission_mode", "auto"));
        resp_text = `### 🛡️ 系统五大能力分身权限与沙箱策略

| 能力分身 | 职责边界 | 运行模式 | 保护策略 |
|---|---|---|---|
| **Chronos** | 文件 / 代码 / Git | \`${py_str(perm)}\` | 工作区内部读写放行；覆盖/删除文件支持 Snapshot 自动快照回滚 |
| **Engine** | 系统 / 终端 / 进程 | 受控沙箱 | 只读探测放行；高危/破坏性 Shell 脚本触发风控拦截与人工确认 |
| **Matrix** | 桌面 / 应用 / 视觉 | UI 自动化 | 窗口交互与截图放行；屏幕数据脱敏 |
| **Voyager** | 浏览器 / 网页采集 | 只读/交互 | 页面导航与 DOM 提取放行；外部表单提交受限 |
| **Oracle** | 全网检索 / 知识库 | 只读 | 聚合搜索与事实交叉比对，不产生环境副作用 |

**沙箱与路径边界**：严格限制在当前工作区路径之内，越权路径自动拦截。
`;
      }
      router.storage.add_message(router.session_id, "assistant", resp_text);
      turn_state.transition(router.session_id, st.IDLE);
      await this._broadcast_turn_state(router.session_id);
      await this._broadcast({
        type: "agent_response",
        timestamp: this.seams.now(),
        sessionId: router.session_id,
        payload: { content: resp_text, generation },
      });
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        sessionId: router.session_id,
        payload: { usage: { tokens: 0, cost_micros: 0 }, generation },
      });
      await this._broadcast_session_list();
      return;
    }

    /* ── 工作流指令预处理与转导（源 1275–1352）────────────────────────── */
    let turn_message: unknown = message;
    if (clean_msg.startsWith("/review")) {
      const extra_arg = py_strip(clean_msg.slice(7));
      const target_desc = py_truth(extra_arg) ? `目标：${extra_arg}` : "当前工作区所有改动 (git diff)";
      turn_message =
        `【/review 指令执行】请以顶级代码审查员（reviewer）身份，对 ${target_desc} 进行 3-State 严格代码审查。\n` +
        "严格按以下标准分类每个潜在缺陷，绝不报无意义的套话建议：\n" +
        "1. CONFIRMED — 指明确切的触发输入/状态及导致的崩溃/错误，精准引用代码行；\n" +
        "2. PLAUSIBLE — 机制真实存在，但触发条件依赖时序/环境/配置，说明确认条件；\n" +
        "3. REFUTED — 事实错误或在其他位置已被防御，引用反证代码行予以否决。\n" +
        "输出格式：严重程度 + 缺陷代码行 + 3-State 状态 + 缺陷机理 + 最小修复方案。";
    } else if (clean_msg.startsWith("/simplify")) {
      const extra_arg = py_strip(clean_msg.slice(9));
      const target_desc = py_truth(extra_arg) ? `目标：${extra_arg}` : "当前工作区修改的代码";
      turn_message =
        `【/simplify 指令执行】请以代码精炼重构专家身份，对 ${target_desc} 从四个维度进行专项精简与净化：\n` +
        "1. 复用性（Reuse）：发现并消除重复实现；\n" +
        "2. 简化（Simplification）：消除多余分支、过早抽象与不必要的 try-catch wrapper；\n" +
        "3. 效率（Efficiency）：优化明显多余的循环或内存拷贝；\n" +
        "4. 设计层级（Altitude）：消除无意义的间接层与过度抽象。\n" +
        "严格保持原有功能与业务逻辑不变，只做代码净化与质量提升。";
    } else if (clean_msg.startsWith("/batch")) {
      const extra_arg = py_strip(clean_msg.slice(6));
      turn_message =
        `【/batch 指令执行】请启动批量并发工作编排：${py_or(extra_arg, "对跨模块改动执行批量处理")}。\n` +
        "1. 先深度分析影响范围，拆解为相互独立、可单独验证的任务单元；\n" +
        "2. 通过 task 工具并发派发 subagents 执行，并实时渲染状态看板表格。";
    } else if (clean_msg.startsWith("/loop")) {
      const extra_arg = py_strip(clean_msg.slice(5));
      turn_message =
        `【/loop 定时任务指令】请解析定时周期并执行任务：${extra_arg}。\n` +
        "1. 提取时间周期并配置定时调度计划；\n" +
        "2. 本轮立即执行一次该任务并汇报执行结果。";
    } else if (clean_msg.startsWith("/doctor")) {
      /* 源 1313：`extra_arg` 算出来却从不使用 —— 死计算照抄（S2-B2）。 */
      const extra_arg = py_strip(clean_msg.slice(7));
      void extra_arg;
      turn_message =
        "【/doctor 环境与项目体检指令】请以环境医生（diagnostician）身份，对当前工作区执行深度体检：\n" +
        "1. 检查运行环境与工具链（Python, Node, Git, 编译器）；\n" +
        "2. 检查依赖包完整性与锁文件健康状态；\n" +
        "3. 检查工作区 Git 状态、冲突与权限配置；\n" +
        "4. 输出结构化状态体检单（✅ PASS / ⚠️ WARN / ❌ FAIL）并附上一键修复方案。";
    } else if (clean_msg.startsWith("/stuck")) {
      const extra_arg = py_strip(clean_msg.slice(6));
      turn_message =
        `【/stuck 陷入卡点自救指令】当前任务遇到阻碍：${py_or(extra_arg, "请分析当前卡点并重新规划突破路径")}。\n` +
        "1. 快速反思过去两轮尝试失败的根本原因（Root Cause）；\n" +
        "2. 主动摒弃无效的机械重试，列出 3 种完全不同的备选解决路径；\n" +
        "3. 评估各路径的成本与风险，推荐最优路径并立即推进验证。";
    } else if (clean_msg === "/dream") {
      let resp_text: string;
      try {
        const mem = py_getattr(router, "memory") as { dream_consolidate(): Promise<unknown> };
        const report = await mem.dream_consolidate();
        resp_text = `### 🌙 梦境记忆整合完成\n\n${py_or(report, "本轮无新增冲突或冗余记忆，记忆库处于最新最优状态。")}`;
      } catch (exc) {
        swallow_if_exception(exc);                      // 源 1333 `except Exception as e`（吞掉取消以外的全部）
        resp_text = `### 🌙 梦境记忆整合\n\n整合过程中未发现待处理冲突项（${exc_str(exc)}）。`;
      }
      router.storage.add_message(router.session_id, "user", message);
      router.storage.add_message(router.session_id, "assistant", resp_text);
      turn_state.transition(router.session_id, st.IDLE);
      await this._broadcast_turn_state(router.session_id);
      await this._broadcast({
        type: "agent_response",
        timestamp: this.seams.now(),
        sessionId: router.session_id,
        payload: { content: resp_text, generation },
      });
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        sessionId: router.session_id,
        payload: { usage: { tokens: 0, cost_micros: 0 }, generation },
      });
      await this._broadcast_session_list();
      return;
    }

    /* ── handle() 的最后一道回合闸（源 1354–1409）─────────────────────── */
    let result: ResultApi;
    try {
      result = await router.handle(turn_message, ctx);
    } catch (exc) {
      if (is_cancelled_error(exc)) throw exc;           // 源 1362–1365：协作式取消 ⇒ 原样 re-raise
      /* 源 1366–1409 `except Exception as exc` —— 最后兜底 */
      this.seams.traceback_print_exc();
      turn_state.transition(router.session_id, st.ERROR);
      await this._broadcast_turn_state(router.session_id);
      if (!py_truth(this.host.is_generation_current(generation))) return;
      const friendly = WebSocketHandler._friendly_error(exc);
      this.seams.py_print(
        `[turn] failed (${py_str(router.session_id)}): ${py_str(sub(friendly, "detail"))}`,
      );
      if (py_truth(msg_id)) {
        await this._schedule_error(ws, router.session_id, msg_id, friendly);
      } else {
        await this._send_error(ws, friendly);
        await this._broadcast({
          type: "completed",
          timestamp: this.seams.now(),
          payload: {
            result: "error",
            error: sub(friendly, "message"),
            hint: sub(friendly, "hint"),
            detail: sub(friendly, "detail"),
          },
          sessionId: router.session_id,
        });
        if (router.queue.ui_pending > 0) {
          await router.queue.ui_pause("internal-error");
          await this._broadcast_queue_state();
        }
      }
      return;
    }

    /* 源 1411–1413：成功路径上的同一道代际闸。 */
    if (!py_truth(this.host.is_generation_current(generation))) return;

    const meta = (py_or(py_getattr_or(result, "meta", null), {}) as JsonLike);
    const turn_outcome = py_or(
      g(meta, "turn_outcome"),
      py_truth((result as ResultApi).ok) ? "completed" : "error",
    );

    if (turn_outcome === "cancelled" || py_truth(g(meta, "cancelled"))) {
      await this._settle_turn_state(router.session_id, st.PAUSED);
      const done_payload: JsonLike = {
        result: "cancelled",
        turnOutcome: "cancelled",
        message: py_or(
          py_or((result as ResultApi).value, (result as ResultApi).error),
          "已中断（用户点击了停止）",
        ),
      };
      const usage = g(meta, "usage");
      if (is_dict(usage) && py_truth(usage)) done_payload["usage"] = usage;
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        payload: done_payload,
        sessionId: router.session_id,
      });
      await this._broadcast_session_list();
      await this._broadcast_workspace_list();
    } else if (turn_outcome === "incomplete" || py_truth(g(meta, "incomplete"))) {
      await this._settle_turn_state(router.session_id, st.COMPLETED);
      const done_payload: JsonLike = {
        result: "incomplete",
        turnOutcome: "incomplete",
        message: py_or((result as ResultApi).value, (result as ResultApi).error),
      };
      const usage = g(meta, "usage");
      if (is_dict(usage) && py_truth(usage)) done_payload["usage"] = usage;
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        payload: done_payload,
        sessionId: router.session_id,
      });
      await this._broadcast_session_list();
      await this._broadcast_workspace_list();
    } else if (turn_outcome === "partial" || py_truth(g(meta, "partial"))) {
      const response_payload: JsonLike = { message: (result as ResultApi).value };
      const images = g(ctx, "generated_images");
      if (py_truth(images)) response_payload["images"] = images;
      if (py_truth((result as ResultApi).value) || py_truth(images)) {
        await this._broadcast({
          type: "agent_response",
          timestamp: this.seams.now(),
          payload: response_payload,
          sessionId: router.session_id,
        });
      }
      await this._settle_turn_state(router.session_id, st.COMPLETED);
      const done_payload: JsonLike = { result: "partial", turnOutcome: "partial" };
      const usage = g(meta, "usage");
      if (is_dict(usage) && py_truth(usage)) done_payload["usage"] = usage;
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        payload: done_payload,
        sessionId: router.session_id,
      });
      await this._broadcast_session_list();
      await this._broadcast_workspace_list();
    } else if (py_truth((result as ResultApi).ok)) {
      const response_payload: JsonLike = { message: (result as ResultApi).value };
      const images = g(ctx, "generated_images");
      if (py_truth(images)) response_payload["images"] = images;
      if (py_truth((result as ResultApi).value) || py_truth(images)) {
        await this._broadcast({
          type: "agent_response",
          timestamp: this.seams.now(),
          payload: response_payload,
          sessionId: router.session_id,
        });
      }
      await this._settle_turn_state(router.session_id, st.COMPLETED);
      const done_payload: JsonLike = { result: "success", turnOutcome: "completed" };
      const usage = g(meta, "usage");
      if (is_dict(usage) && py_truth(usage)) done_payload["usage"] = usage;
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        payload: done_payload,
        sessionId: router.session_id,
      });
      await this._broadcast_session_list();
      await this._broadcast_workspace_list();
    } else {
      await this._send_error(ws, (result as ResultApi).error);
      await this._settle_turn_state(router.session_id, st.ERROR);
      await this._broadcast({
        type: "completed",
        timestamp: this.seams.now(),
        payload: {
          result: "error",
          turnOutcome: "error",
          error: (result as ResultApi).error,
        },
        sessionId: router.session_id,
      });
      await this._broadcast_session_list();
      await this._broadcast_workspace_list();
      if (router.queue.ui_pending > 0) {
        await router.queue.ui_pause("error");
        await this._broadcast_queue_state();
      }
    }
  }

  /** 源 1511–1524 `_drain_ui_queue`：64 次上限的安全阀；`item["text"]` 是**下标**（缺键 KeyError）。 */
  async _drain_ui_queue(ws: unknown): Promise<void> {
    const queue = this._router_for(ws).queue;
    for (let i = 0; i < 64; i++) {
      const item = await queue.ui_take_next();
      if (item === null || item === undefined) break;
      await this._broadcast_queue_state();
      await this._run_turn(ws, sub(item as JsonLike, "text"), { source: "queue" });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * S2 —— 消息分派表（源 1526–2043 `_handle_message`）
   *
   * 40 个 `event_type` 臂 + 5 只嵌套闭包（1590 _run_and_drain / 1642 _run_consent /
   * 1711 _run_approved / 1771 _run_answer / 1932 _run_resume）。
   *
   * 两条贯穿全臂的源事实（逐字复刻）：
   *  · S2-B2：**每一只闭包的 `finally` 都是按 key 无条件 pop**（1604/1659/1722/1787/1943），
   *    不校验"当前挂在 `id(ws)` 上的还是不是我这只 task" ⇒ 同一条 socket 上后手回合登记后，
   *    前手收尾会把后手的登记抹掉（此后 `_turn_running` 对该 socket 恒 False）。
   *  · S2-B3：**没有 per-message 兜底**。本函数由 897–904 那一只 `try` 调用，而它只接
   *    `json.JSONDecodeError` ⇒ 本函数体内任何其它异常（`payload` 是 list ⇒ AttributeError、
   *    `text` 是 int ⇒ AttributeError、`**result.value` 非 mapping ⇒ TypeError）直接冒出
   *    `handle_websocket`，整条 WS 连接报废，并顺带踩到 S1-B9 的半截清理。
   * ══════════════════════════════════════════════════════════════════════ */

  /** 源 1526–2042 `_handle_message`。 */
  async _handle_message(ws: unknown, data: unknown): Promise<void> {
    const event_type = g(data, "type");
    const payload = py_or(gd(data, "payload", {}), {}) as JsonLike;

    /* 源 1529–1535：动态跟踪这条 socket 的会话与分支（四个键名姿势逐字保留）。 */
    const msg_sid = py_or(
      py_or(py_or(g(payload, "sessionId"), g(payload, "session_id")), g(data, "sessionId")),
      g(data, "session_id"),
    );
    const msg_bid = py_or(
      py_or(py_or(g(payload, "branchId"), g(payload, "branch_id")), g(data, "branchId")),
      g(data, "branch_id"),
    );
    if (py_truth(msg_sid)) {
      this._bind_session(ws, py_str(msg_sid), py_str(py_or(msg_bid, "")));
    } else if (msg_bid !== null && msg_bid !== undefined && this._session_by_ws.has(py_object_id(ws))) {
      this._branch_by_ws.set(py_object_id(ws), py_strip(py_str(msg_bid)));
    }

    /* 源 1537–1541：先解析**本 socket** 的 router，队列/回合闸/router 调用全部跟着它走。 */
    const router = this._router_for(ws);
    const q = router.queue;

    if (event_type === "user_prompt") {
      const message_text = gd(payload, "message", "");
      /* 源 1545–1569：入站去重。有 msgId ⇒ 靠 pending-error 表区分"重复"与"重试"；
       * 无 msgId ⇒ 退化成"短文本窗口"猜一次。 */
      const msg_id = py_or(py_or(g(payload, "msgId"), g(payload, "msg_id")), "");
      if (py_truth(msg_id)) {
        const is_retry = this._cancel_pending_error(router.session_id, msg_id);
        if (!is_retry && this.host.dedupe_seen(router.session_id, msg_id, { channel: "ws" })) {
          return;
        }
      } else if (
        this.host.dedupe_seen(router.session_id, message_text, { channel: "ws", kind: "text" })
      ) {
        return;
      }
      /* 源 1570–1587：回合跑在后台 task 里（否则 interrupt/steer 会卡在缓冲区分不到帧）；
       * **按会话**一回合一只，第二只落进该会话的 UI 队列。 */
      if (this._turn_running(ws)) {
        await q.ui_enqueue(message_text, {
          requested: "send",
          reason: "当前回合还在进行，这条已排队，回合结束后自动发送。",
        });
        await this._broadcast_queue_state();
        return;
      }

      const target_sid = router.session_id;
      /* 源 1590–1605 `_run_and_drain`。 */
      const run_and_drain = async (): Promise<void> => {
        try {
          await this._run_turn(ws, message_text, {
            source: "user",
            /* 源 1596–1599：**不带** `approved_plan` ⇒ 踩中 S2-B1 的 KeyError（见 `_run_turn` 头）。 */
            context_extra: {
              permission: g(payload, "permission"),
              model: g(payload, "model"),
              thought_level: g(payload, "thoughtLevel"),
              context_refs: g(payload, "contextRefs"),
            },
            msg_id,
          });
          await this._drain_ui_queue(ws);
        } finally {
          this._turn_tasks.delete(py_object_id(ws));      // S2-B2
          this._turn_tasks_by_sid.delete(target_sid);
        }
      };

      const task = this.seams.create_task(run_and_drain());
      this._turn_tasks.set(py_object_id(ws), task);
      this._turn_tasks_by_sid.set(target_sid, task);

    } else if (event_type === "respond_permission") {
      /* 源 1612–1664：**点按钮**回答挂起的工具确认（带 callId 才能指哪一只）。
       * 刻意复用普通 prompt 的 `_run_turn` 路（1621–1625 的注释：第二条 resume 路=第二处漂移）。 */
      const decision = py_lower_str_or_empty(g(payload, "decision"));
      if (decision !== "approve" && decision !== "approve_always" && decision !== "deny") {
        await this._send_error(ws, `bad permission decision: ${decision}`);
        return;
      }
      if (this._turn_running(ws)) {
        await this._send_error(ws, "a turn is already running");
        return;
      }
      /* 源 1638–1639：字面量下标 ⇒ `decision` 不在三键内会 KeyError；上面的白名单已挡死，
       * 所以这一句的 KeyError 面是**死支**（S2-B4，逐字保留下标姿势而非 `get`）。 */
      const text = sub(
        { approve: "同意", approve_always: "以后都允许", deny: "不用了" } as JsonLike,
        decision,
      );

      const target_sid = router.session_id;
      /* 源 1642–1660 `_run_consent`。 */
      const run_consent = async (): Promise<void> => {
        try {
          await this._run_turn(ws, text, {
            source: "user",
            context_extra: {
              consent_decision: decision,
              consent_call_id: py_str(py_or(py_or(g(payload, "callId"), g(payload, "toolCallId")), "")),
              permission: g(payload, "permission"),
              model: g(payload, "model"),
              thought_level: g(payload, "thoughtLevel"),
              silent_consent: true,
            },
            msg_id: py_or(g(payload, "msgId"), ""),
          });
          await this._drain_ui_queue(ws);
        } finally {
          this._turn_tasks.delete(py_object_id(ws));
          this._turn_tasks_by_sid.delete(target_sid);
        }
      };

      const task = this.seams.create_task(run_consent());
      this._turn_tasks.set(py_object_id(ws), task);
      this._turn_tasks_by_sid.set(target_sid, task);

    } else if (event_type === "approve_plan") {
      /* 源 1666–1727：方案审批卡回执。批准 = 以批准时的权限档立即开执行轮（合同走
       * `context_extra.approved_plan`，是**唯一**带这个键的臂 ⇒ 唯一不踩 S2-B1 的开轮路径）；
       * 放弃 = 只归档 artifact，不发轮次。 */
      const plan_id = py_strip(py_str(py_or(g(payload, "plan_id"), "")));
      const decision = py_lower_str_or_empty(py_or(g(payload, "decision"), "approve"));
      if (decision !== "approve" && decision !== "discard") {
        await this._send_error(ws, `bad plan decision: ${decision}`);
        return;
      }
      /* 源 1675–1677：函数内 import，**不在 try 里** ⇒ 模块不可用直接冒出（S2-B3 家族）。 */
      const art = this.seams.get_plan_artifact(plan_id);
      if (!py_truth(art)) {
        await this._send_error(ws, `plan not found: ${plan_id}`);
        return;
      }
      if (decision === "discard") {
        this.seams.discard_plan_artifact(plan_id);
        await this._broadcast({
          type: "plan_discarded",
          payload: { plan_id },
          sessionId: router.session_id,
          timestamp: this.seams.now(),
        });
        return;
      }
      const approved = this.seams.approve_plan_artifact(plan_id, {
        approved_with: py_str(py_or(g(payload, "approved_with"), "auto")),
      });
      if (!py_truth(approved)) {
        await this._send_error(ws, "plan already processed");
        return;
      }
      /* S2-B5：`plan_approved` 广播在 `_turn_running` 闸**之前** ⇒ 回合已在跑时前端仍会看到
       * "方案已批准"，而执行轮被 1705–1707 拒掉（artifact 已被置为 approved，无人执行）。 */
      await this._broadcast({
        type: "plan_approved",
        payload: { plan_id },
        sessionId: router.session_id,
        timestamp: this.seams.now(),
      });
      if (this._turn_running(ws)) {
        await this._send_error(ws, "a turn is already running");
        return;
      }

      const target_sid = router.session_id;
      /* 源 1711–1723 `_run_approved`。 */
      const run_approved = async (): Promise<void> => {
        try {
          await this._run_turn(ws, "按已批准的方案开始执行。", {
            source: "user",
            context_extra: {
              permission: py_or(gd(approved, "approved_with", null), "auto"),
              approved_plan: plan_id,
            },
          });
          await this._drain_ui_queue(ws);
        } finally {
          this._turn_tasks.delete(py_object_id(ws));
          this._turn_tasks_by_sid.delete(target_sid);
        }
      };

      const task = this.seams.create_task(run_approved());
      this._turn_tasks.set(py_object_id(ws), task);
      this._turn_tasks_by_sid.set(target_sid, task);

    } else if (event_type === "respond_question") {
      /* 源 1728–1792：点卡片回答挂起的 `ask_user`。两条路：
       *  1) 有 waiter ⇒ `deliver_answer` 把答案交给正在 await 的 Future，回合原地继续
       *     （**必须**在 `_turn_running` 闸之前判，那个回合跑的正是这个等待）；
       *  2) 没 waiter ⇒ 回落持久账本，由 store 渲染文本、开一只普通用户回合。 */
      const call_id = py_str(py_or(py_or(g(payload, "callId"), g(payload, "toolCallId")), ""));
      if (py_truth(call_id) && py_truth(this.seams.ask_user_has_waiter(call_id))) {
        if (py_truth(this.seams.ask_user_deliver_answer(
          call_id,
          g(payload, "answers"),
          py_bool(g(payload, "skipped")),
        ))) {
          return;
        }
        /* 源 1751：交付失败只可能是超时/取消抢先 ⇒ 落到第二条路。 */
      }
      if (this._turn_running(ws)) {
        await this._send_error(ws, "a turn is already running");
        return;
      }
      /* S2-B6：1756 重新 `_router_for(ws)` 取 sid，而 1541 的 `q` 还是旧 router 的队列
       * ⇒ 两行之间 socket 若被重绑，则 resolve 用新会话、队列属于旧会话。 */
      const sid = this._router_for(ws).session_id;
      const text = this.seams.get_ask_user_store().resolve(sid, {
        call_id,
        answers: g(payload, "answers"),
        skipped: py_bool(g(payload, "skipped")),
      });
      if (!py_truth(text)) {
        await this._send_error(ws, "这组问题已经不在等待中了（可能已回答或后端重启过）");
        return;
      }

      const target_sid = sid;
      /* 源 1771–1788 `_run_answer`。 */
      const run_answer = async (): Promise<void> => {
        try {
          await this._run_turn(ws, text, {
            source: "user",
            context_extra: {
              permission: g(payload, "permission"),
              model: g(payload, "model"),
              thought_level: g(payload, "thoughtLevel"),
              question_answer: true,
            },
            msg_id: py_or(g(payload, "msgId"), ""),
          });
          await this._drain_ui_queue(ws);
        } finally {
          this._turn_tasks.delete(py_object_id(ws));
          this._turn_tasks_by_sid.delete(target_sid);
        }
      };

      const task = this.seams.create_task(run_answer());
      this._turn_tasks.set(py_object_id(ws), task);
      this._turn_tasks_by_sid.set(target_sid, task);

    } else if (event_type === "steer") {
      /* 源 1795–1832：真 steer —— 把新指令注进**正在跑**的循环，下一步就改航；
       * 没回合可打断时干净降级为"插到队首 + 说明原因"。 */
      const text = py_strip_or(g(payload, "text"));
      if (!py_truth(text)) return;
      if (!this._turn_running(ws)) {
        await router.queue.ui_enqueue(text, {
          urgent: true,
          requested: "steer",
          reason: "当前没有正在进行的回合可以打断，这条已插到队首，下一轮先发它。",
        });
        await this._broadcast_queue_state();
        return;
      }
      await router.queue.send_message(text, this.seams.deliver_as_steer(), { sender: "user" });

      /* S2-B7：`urgent_interrupt` 默认 True ⇒ 客户端传 JSON null 也算真（走 or 链），
       * 只有显式 false 且 `immediate` 不为真才不硬取消。 */
      if (py_truth(py_or(gd(payload, "urgent_interrupt", true), gd(payload, "immediate", false)))) {
        try {
          /* 源 1822：直接 `router.cancel_hard()`，**没有 hasattr** ⇒ Router 缺该属性时
           * AttributeError 被下面的 except 吞成一行 print（与 1880 的 interrupt 臂姿势不同）。 */
          const hard = (router as unknown as { cancel_hard: () => unknown }).cancel_hard;
          if (typeof hard !== "function") throw new PyAttributeErrorP(router, "cancel_hard");
          hard.call(router);
        } catch (exc) {
          swallow_if_exception(exc);                      // 源 1823 `except Exception`（不接 CancelledError）
          this.seams.py_print(`[http_server] steer cancel_hard error: ${exc_str(exc)}`);
        }
      }

      await this._broadcast({
        type: "steer_queued",
        timestamp: this.seams.now(),
        sessionId: router.session_id,
        payload: { text },
      });
      await this._broadcast_queue_state();

    } else if (event_type === "queue_enqueue") {
      /* 源 1834–1840：`text.strip()` **无 or 前导** ⇒ 非 str 直接 AttributeError（S2-B3 的现场之一）；
       * 入队用的仍是**未 strip 的原值**。 */
      const text = gd(payload, "text", "");
      if (py_truth(py_strip_method(text))) {
        await q.ui_enqueue(text, { urgent: py_bool(g(payload, "urgent")) });
        await this._broadcast_queue_state();
        /* S2-B8：这只 task 不登记句柄 ⇒ `interrupt` 的 `_live_turn_tasks_for` 看不见它。 */
        if (!this._turn_running(ws) && !q.is_paused) {
          this.seams.create_task(this._drain_ui_queue(ws));
        }
      }
    } else if (event_type === "queue_remove") {
      await q.ui_remove(gd(payload, "id", ""));
      await this._broadcast_queue_state();
    } else if (event_type === "queue_clear") {
      await q.ui_clear();
      await this._broadcast_queue_state();
    } else if (event_type === "queue_update_text") {
      await q.ui_update_text(gd(payload, "id", ""), gd(payload, "text", ""));
      await this._broadcast_queue_state();
    } else if (event_type === "queue_promote") {
      await q.ui_promote(gd(payload, "id", ""));
      await this._broadcast_queue_state();
      if (!this._turn_running(ws) && !q.is_paused) {       // 源 1857–1858：同 S2-B8
        this.seams.create_task(this._drain_ui_queue(ws));
      }
    } else if (event_type === "queue_reorder") {
      await q.ui_reorder(py_or(gd(payload, "ids", []), []) as readonly unknown[]);
      await this._broadcast_queue_state();
    } else if (event_type === "queue_pause") {
      await q.ui_pause(gd(payload, "reason", "manual"));
      await this._broadcast_queue_state();
    } else if (event_type === "queue_resume") {
      await q.ui_resume();
      await this._broadcast_queue_state();
      await this._drain_ui_queue(ws);                      // 源 1872：恢复即排空（**await**，与 B8 两臂不同）
    } else if (event_type === "interrupt") {
      /* 源 1874–1906：合作式取消 + 队列暂停，外加看门狗与 PAUSED 记账。 */
      const sid = py_or(g(payload, "sessionId"), router.session_id);
      router.cancel();
      const hard = py_getattr_or(router, "cancel_hard", null);
      if (typeof hard === "function") {
        try {
          (hard as () => unknown).call(router);
        } catch (exc) {
          swallow_if_exception(exc);                        // 源 1884–1885
          this.seams.py_print(`[http_server] interrupt cancel_hard error: ${exc_str(exc)}`);
        }
      }
      /* S2-B9：`sid` 取自**帧**，而 `router.cancel()` 打在**本 socket 会话**上 ⇒ 客户端重放
       * 别的 sessionId 时，取消动作与 pop 的键分属两个会话。 */
      const live_tasks = this._live_turn_tasks_for(ws, sid);
      for (const t of live_tasks) {
        if (!t.done()) t.cancel();
      }
      this._turn_tasks_by_sid.delete(sid);
      this._turn_tasks.delete(py_object_id(ws));

      this._spawn_stop_watchdog(ws, router);
      await q.ui_pause("interrupted");
      await this._broadcast_queue_state();
      this.seams.get_turn_state().transition(
        sid,
        this.seams.turn_status().PAUSED,
        undefined,                                        // 源 1899 只给 force= 关键字
        true,
      );
      await this._broadcast_turn_state(sid);
      await this._broadcast({
        type: "idle",
        timestamp: this.seams.now(),
        payload: { reason: "interrupted" },
        sessionId: sid,                                   // 键序：payload 在 sessionId 之前（源 1901–1906）
      });

    } else if (event_type === "resume_turn") {
      /* 源 1909–1948：继续的是**对话**（队列解暂停 + 一只用续写文本开的新回合），
       * 不是被取消的 asyncio 任务 —— 那只任务已经没了。 */
      const ts = this.seams.get_turn_state();
      if (ts.current(router.session_id) !== this.seams.turn_status().PAUSED) {
        await this._send_error(ws, "没有被暂停的回合可以继续");
        return;
      }
      /* S2-B10（与 B9 对偶）：这里的判定用 `router.session_id`（**本 socket 的会话**），
       * 而 1899 的 transition 用帧 sid ⇒ 在另一只窗口按过停止后，本窗口永远"可以继续"不了。 */
      if (this._turn_running(ws)) {
        await this._send_error(ws, "a turn is already running");
        return;
      }
      const text = py_or(py_strip_or(g(payload, "text")), "接着上面没做完的部分继续。");
      await q.ui_resume();
      await this._broadcast_queue_state();

      const target_sid = router.session_id;
      /* 源 1932–1944 `_run_resume`。 */
      const run_resume = async (): Promise<void> => {
        try {
          await this._run_turn(ws, text, {
            source: "user",
            context_extra: {
              permission: g(payload, "permission"),
              model: g(payload, "model"),
              thought_level: g(payload, "thoughtLevel"),
            },
            msg_id: py_or(g(payload, "msgId"), ""),
          });
          await this._drain_ui_queue(ws);
        } finally {
          this._turn_tasks.delete(py_object_id(ws));
          this._turn_tasks_by_sid.delete(target_sid);
        }
      };

      const task = this.seams.create_task(run_resume());
      this._turn_tasks.set(py_object_id(ws), task);
      this._turn_tasks_by_sid.set(target_sid, task);

    } else if (event_type === "cancel_tool") {
      /* 源 1951–1964：杀**一只**在跑的命令，不停回合（✕ 在单张终端卡上）。 */
      const cid = py_str(py_or(py_or(g(payload, "toolCallId"), g(payload, "call_id")), ""));
      const killed = py_truth(cid) ? this.seams.cancel_call(cid) : false;
      await this._broadcast({
        type: "tool_cancelled",
        timestamp: this.seams.now(),
        sessionId: router.session_id,
        payload: { toolCallId: cid, ok: killed },          // S2-B11：`killed` 原样入帧（非 bool 也照发）
      });

    } else if (event_type === "fold") {
      /* 源 1966–1985：手动折叠上下文（/fold 或组合区按钮）。 */
      const result = await router.fold_context({ manual: true });
      if (result.ok) {
        await this._broadcast({
          type: "fold_result",
          timestamp: this.seams.now(),
          sessionId: router.session_id,
          payload: { ok: true, ...spread_mapping(result.value) },  // `**result.value` 非 mapping ⇒ TypeError
        });
      } else {
        await this._broadcast({
          type: "fold_result",
          timestamp: this.seams.now(),
          sessionId: router.session_id,
          payload: { ok: false, reason: result.error },
        });
      }
      /* 源 1983–1985：折叠期间排队的提示也要排干（同 S2-B8：无句柄）。 */
      if (!this._turn_running(ws) && !q.is_paused && q.ui_pending > 0) {
        this.seams.create_task(this._drain_ui_queue(ws));
      }

    } else if (event_type === "session_truncate") {
      await this._handle_session_truncate(ws, payload);
    } else if (event_type === "session_list") {
      await this._send_session_list(ws);
    } else if (event_type === "session_new") {
      await this._handle_session_new(ws, payload);
    } else if (event_type === "session_switch") {
      await this._handle_session_switch(ws, payload);
    } else if (event_type === "session_fork") {
      await this._handle_session_fork(ws, payload);
    } else if (event_type === "session_delete") {
      await this._handle_session_delete(ws, payload);
    } else if (event_type === "session_rename") {
      await this._handle_session_rename(ws, payload);
    } else if (event_type === "session_pin") {
      await this._handle_session_pin(ws, payload);
    } else if (event_type === "workspace_switch") {
      await this._handle_workspace_switch(ws, payload);
    } else if (event_type === "workspace_list") {
      await this._send_workspace_list(ws);
    } else if (event_type === "workspace_rename") {
      await this._handle_workspace_rename(ws, payload);
    } else if (event_type === "workspace_pin") {
      await this._handle_workspace_pin(ws, payload);
    } else if (event_type === "workspace_hide") {
      await this._handle_workspace_hide(ws, payload);
    } else if (event_type === "workspace_settings_get") {
      await this._handle_workspace_settings_get(ws, payload);
    } else if (event_type === "workspace_settings_set") {
      await this._handle_workspace_settings_set(ws, payload);
    } else if (event_type === "queue_request") {
      /* 源 2034–2037：显式重同步 —— 把 `ws` 传进去，这只窗口拿**自己**的队列快照。 */
      await (ws as WebSocketResponseApi).send_json(this._queue_state_event({ ws }));
    } else if (event_type === "ping") {
      await (ws as WebSocketResponseApi).send_json({ type: "pong", timestamp: this.seams.now() });
    } else {
      /* 源 2041–2042：`f"Unknown event type: {event_type}"` —— `event_type` 可以是 None/数字，
       * 脸面走 `py_str`（D4）。 */
      await this._send_error(ws, `Unknown event type: ${py_str(event_type)}`);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * S2 —— 会话 / 工作区面（源 2044–2795，26 个方法）
   *
   * 贯穿本簇的两条源姿势（逐字保留）：
   *  · **storage 句柄的两套取法**：`_send_session_list` / `_handle_workspace_switch` /
   *    `settings_get` / `settings_set` / `_handle_session_delete` / `fork` 用 `_router_for(ws).storage`
   *    （本窗口的 router），而 rename / pin / hide 三臂（2202/2216/2235）与 `_history_messages`
   *    （2331）用 **`self.router.storage`（主会话 router）** ⇒ S2-B15（三臂）+ S2-B17（历史）。
   *  · **广播失败的两套姿势**：`_broadcast_session_list`（2076–2077）失败只 print 并**继续**下一个
   *    client，`_broadcast_workspace_list`（2143–2145）失败 print 后 **`return`** ⇒ 一只坏 socket
   *    会中断整轮工作区广播（S2-B13），而 `_broadcast` 走 `_deliver`（失败 discard 后继续）。
   * ══════════════════════════════════════════════════════════════════════ */

  /** 源 2044–2066 `_send_session_list`：行是全局的，但"哪一条是活的"按 socket 算。 */
  async _send_session_list(ws: unknown): Promise<void> {
    const router = this._router_for(ws);
    const storage = router.storage;
    let sessions: unknown;
    try {
      sessions = storage.list_sessions();
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2054 `except Exception as exc`
      await this._send_error(ws, `list_sessions failed: ${exc_str(exc)}`);
      return;
    }
    await (ws as WebSocketResponseApi).send_json({
      type: "session_list",
      timestamp: this.seams.now(),
      sessionId: router.session_id,
      payload: {
        sessions,
        activeId: router.session_id,
        activeWorkspace: router.effective_workspace ?? null,
      },
    });
  }

  /** 源 2068–2077 `_broadcast_session_list`：逐窗口重造帧（activeId 是各自的）。 */
  async _broadcast_session_list(): Promise<void> {
    for (const client of [...this.clients]) {
      try {
        await this._send_session_list(client);
      } catch (exc) {
        swallow_if_exception(exc);                        // 源 2076：注意是**继续**，不 return
        this.seams.py_print(`[http] broadcast session_list failed: ${exc_str(exc)}`);
      }
    }
  }

  /** 源 2079–2100 `_send_pending_questions`：空也要发（前端靠这帧结算挂着的卡片）。 */
  async _send_pending_questions(ws: unknown, sid: unknown = ""): Promise<void> {
    /* 源 2088：函数内 import，**在 try 之外** ⇒ 模块不可用时整个 handler 抛（S2-B3 家族）。 */
    const store = this.seams.get_ask_user_store();
    const target = py_or(sid, this._router_for(ws).session_id);
    let items: unknown;
    try {
      items = store.snapshot(target);
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2093 `except Exception: return`
      return;                                             // 账本不可读 ⇒ 降级为"没有卡片"，绝不让连接失败
    }
    await (ws as WebSocketResponseApi).send_json({
      type: "pending_questions",
      timestamp: this.seams.now(),
      sessionId: target,
      payload: { items },
    });
  }

  /** 源 2102–2121 `_workspace_list_event`（**同步**，storage 不可读就抛，由调用方兜）。 */
  _workspace_list_event(opts: { ws?: unknown } = {}): JsonLike {
    const ws = opts.ws === undefined ? null : opts.ws;
    const router = ws !== null ? this._router_for(ws) : this.router;
    /* 2109–2111 的注释是语义本体：用 `effective_workspace` 而不是 `workspace`（后者会回落到
     * 后端自身的启动目录，于是那个用户从没打开过的目录会被列成真实工作区并高亮为 active）。 */
    const active = py_getattr(router, "effective_workspace");
    return {
      type: "workspace_list",
      timestamp: this.seams.now(),
      sessionId: router.session_id,
      payload: {
        workspaces: router.storage.list_workspaces({ always_include: active }),
        active,
      },
    };
  }

  /** 源 2123–2130 `_send_workspace_list`。 */
  async _send_workspace_list(ws: unknown): Promise<void> {
    let event: JsonLike | undefined;
    try {
      event = this._workspace_list_event({ ws });
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2127
      await this._send_error(ws, `list_workspaces failed: ${exc_str(exc)}`);
      return;
    }
    await (ws as WebSocketResponseApi).send_json(event);
  }

  /** 源 2132–2146 `_broadcast_workspace_list`：列表共享，`active` 按会话 —— 所以逐窗口造帧。 */
  async _broadcast_workspace_list(): Promise<void> {
    for (const client of [...this.clients]) {
      let event: JsonLike | undefined;
      try {
        event = this._workspace_list_event({ ws: client });
      } catch (exc) {
        swallow_if_exception(exc);
        this.seams.py_print(`[http] broadcast workspace_list failed: ${exc_str(exc)}`);
        return;                                           // S2-B13：源是 return（不是 continue）⇒ 一只坏 socket 中断整轮广播
      }
      await this._deliver(client, event!);
    }
  }

  /** 源 2148–2184 `_handle_workspace_switch`：回合进行中一律拒绝（沙箱边界由工作区推导）。 */
  async _handle_workspace_switch(ws: unknown, payload: JsonLike): Promise<void> {
    const path = py_strip_or(g(payload, "path"));
    if (!py_truth(path)) {
      await this._send_error(ws, "workspace_switch needs a path");
      return;
    }
    if (this._turn_running(ws)) {
      await this._send_error(ws, "Can't switch workspace while a turn is running");
      return;
    }
    const router = this._router_for(ws);
    const result = router.switch_workspace(path);
    if (!result.ok) {
      await this._send_error(ws, result.error);
      return;
    }
    /* 源 2169–2181：登记目录（让用户在侧栏立刻看见）+ 应用该工作区的持久设置。 */
    const resolved = py_or(py_getattr_or(router, "workspace", ""), "");
    if (py_truth(resolved)) {
      try {
        router.storage.upsert_workspace(resolved, { touch_opened: true });
      } catch (exc) {
        swallow_if_exception(exc);                        // 源 2173–2174
        this.seams.py_print(`[http] upsert_workspace on switch failed: ${exc_str(exc)}`);
      }
      try {
        const settings = py_or(router.storage.get_workspace_settings(resolved), {});
        if (py_truth(settings)) this._apply_workspace_settings(settings, router);
      } catch (exc) {
        swallow_if_exception(exc);                        // 源 2180–2181
        this.seams.py_print(`[http] apply_workspace_settings on switch failed: ${exc_str(exc)}`);
      }
    }
    /* 源 2182：`switch_workspace()` 已经为新目录建好了会话。 */
    await this._switch_and_reply(ws, router.session_id);
    await this._broadcast_workspace_list();
  }

  /** 源 2190–2206 `_handle_workspace_rename`：默认工作区（空 path）没有可写的行 ⇒ 直接拒。 */
  async _handle_workspace_rename(ws: unknown, payload: JsonLike): Promise<void> {
    const path = py_strip_or(g(payload, "path"));
    /* S2-B14：`name` **不 strip**（同臂的 path 却 strip）⇒ 前后空格会原样进库并显示。 */
    const name = py_or(py_or(g(payload, "displayName"), g(payload, "display_name")), "");
    if (!py_truth(path)) {
      await this._send_error(ws, "Cannot rename the default workspace");
      return;
    }
    try {
      /* S2-B15：这里是 `self.router.storage`（主 router），不是 `_router_for(ws)`。 */
      (this.router as RouterApi).storage.rename_workspace(path, name);
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2203
      await this._send_error(ws, `rename_workspace failed: ${exc_str(exc)}`);
      return;
    }
    await this._broadcast_workspace_list();
  }

  /** 源 2208–2220 `_handle_workspace_pin`。 */
  async _handle_workspace_pin(ws: unknown, payload: JsonLike): Promise<void> {
    const path = py_strip_or(g(payload, "path"));
    const pinned = py_bool(gd(payload, "pinned", true));
    if (!py_truth(path)) {
      await this._send_error(ws, "workspace_pin needs a path");
      return;
    }
    try {
      (this.router as RouterApi).storage.set_workspace_pinned(path, pinned);   // S2-B15
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2217
      await this._send_error(ws, `set_workspace_pinned failed: ${exc_str(exc)}`);
      return;
    }
    await this._broadcast_workspace_list();
  }

  /** 源 2222–2239 `_handle_workspace_hide`：只从树里消失，会话仍可从搜索/历史到达。 */
  async _handle_workspace_hide(ws: unknown, payload: JsonLike): Promise<void> {
    const path = py_strip_or(g(payload, "path"));
    const hidden = py_bool(gd(payload, "hidden", true));
    if (!py_truth(path)) {
      await this._send_error(ws, "workspace_hide needs a path");
      return;
    }
    try {
      (this.router as RouterApi).storage.set_workspace_hidden(path, hidden);   // S2-B15
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2236
      await this._send_error(ws, `set_workspace_hidden failed: ${exc_str(exc)}`);
      return;
    }
    await this._broadcast_workspace_list();
  }

  /** 源 2241–2255 `_handle_workspace_settings_get`：这一臂**是**按 socket 取 storage。 */
  async _handle_workspace_settings_get(ws: unknown, payload: JsonLike): Promise<void> {
    const path = py_strip_or(g(payload, "path"));
    const router = this._router_for(ws);
    let settings: unknown;
    try {
      settings = router.storage.get_workspace_settings(path);
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2247
      await this._send_error(ws, `get_workspace_settings failed: ${exc_str(exc)}`);
      return;
    }
    await (ws as WebSocketResponseApi).send_json({
      type: "workspace_settings",
      timestamp: this.seams.now(),
      sessionId: router.session_id,
      payload: { path, settings },
    });
  }

  /** 源 2257–2283 `_handle_workspace_settings_set`：写入按工作区隔离；命中当前工作区时顺带活应用。 */
  async _handle_workspace_settings_set(ws: unknown, payload: JsonLike): Promise<void> {
    const path = py_strip_or(g(payload, "path"));
    const patch = py_or(g(payload, "settings"), {});
    if (!py_truth(path)) {
      await this._send_error(ws, "workspace_settings_set needs a path");
      return;
    }
    const router = this._router_for(ws);
    let merged: unknown;
    try {
      merged = router.storage.set_workspace_settings(path, patch);
    } catch (exc) {
      swallow_if_exception(exc);                          // 源 2273
      await this._send_error(ws, `set_workspace_settings failed: ${exc_str(exc)}`);
      return;
    }
    if (py_str_eq(path, py_str(py_or(py_getattr_or(router, "workspace", ""), "")))) {
      this._apply_workspace_settings(py_or(merged, {}), router);
    }
    await (ws as WebSocketResponseApi).send_json({
      type: "workspace_settings",
      timestamp: this.seams.now(),
      sessionId: router.session_id,
      payload: { path, settings: py_or(merged, {}) },      // 源 2282：`merged or {}` 再算一次
    });
  }

  /** 源 2285–2320 `_apply_workspace_settings`：刻意只转发认识的三个字段。 */
  _apply_workspace_settings(settings: unknown, router: RouterApi | null = null): void {
    const target = (py_or(router, this.router) as RouterApi);
    /* S2-B16：下面三段的 `except Exception: pass` 连 print 都没有 ⇒ 写不进去时用户零反馈。 */
    if (py_in_dict(settings, "model") && py_truth(sub(settings as JsonLike, "model"))) {
      try {
        /* 源 2299：Router 上的真属性；`_bind_turn_model` 在回合负载没带选择时回落它（排队回合正是这种）。 */
        target.workspace_model = py_str(sub(settings as JsonLike, "model"));
      } catch (exc) {
        swallow_if_exception(exc);
      }
    }
    /* 源 2302–2307：接受新的 `permission` 键，并把旧 `mode` 映射过来（plan 保持 plan，只读的 ask → readonly）。 */
    let perm = g(settings, "permission");
    if (!py_truth(perm) && (py_str_eq(g(settings, "mode"), "plan") || py_str_eq(g(settings, "mode"), "ask"))) {
      perm = py_str_eq(sub(settings as JsonLike, "mode"), "plan") ? "plan" : "readonly";
    }
    if (py_truth(perm)) {
      try {
        /* 源 2310：函数内 import 在 try **之内** ⇒ 模块不可用时静默丢弃权限档（与 2088 相反的姿势）。 */
        target.permission = this.seams.coerce_permission(perm);
      } catch (exc) {
        swallow_if_exception(exc);
      }
    }
    if (py_in_dict(settings, "reasoning") && py_truth(sub(settings as JsonLike, "reasoning"))) {
      try {
        /* 源 2318：与 model 同一套"真属性"故事 —— 回合启动解析器在负载没带 thought level 时读它。 */
        target.workspace_thought_level = py_str(sub(settings as JsonLike, "reasoning"));
      } catch (exc) {
        swallow_if_exception(exc);
      }
    }
  }

  /** 源 2322–2375 `_history_messages`：DB 行 → 前端时间线形状（同步，且用**主** router 的 storage）。 */
  _history_messages(sid: unknown): JsonLike[] {
    const rows = (this.router as RouterApi).storage.get_messages(sid, { limit: 1000 });   // S2-B17
    const out: JsonLike[] = [];
    for (const r of py_iter(rows)) {
      let meta: JsonLike;
      try {
        /* 源 2335：`json.loads(r.get("metadata") or "{}")` —— 脏 JSON ⇒ ValueError ⇒ 整行 meta 退回 {}。 */
        meta = this.seams.json_loads(py_or(g(r, "metadata"), "{}")) as JsonLike;
      } catch (exc) {
        if (!is_type_or_value_error(exc)) throw exc;       // 源 2336 只接这一族
        meta = {};
      }
      const role = g(r, "role");
      if (py_str_eq(g(r, "msg_type"), "compaction")) {
        out.push({
          id: g(r, "id"),
          role: "system",
          kind: "fold",
          content: py_or(g(r, "content"), ""),
          timestamp: py_mul(py_or(g(r, "created_at"), 0), 1000),   // 见 py_mul 的 TEXT 面
          fold: {
            strategy: "llm-summary",
            summary: py_or(g(r, "content"), ""),
            tokensBefore: g(meta, "tokensBefore"),
            estimatedTokensAfter: g(meta, "estimatedTokensAfter"),
          },
        });
        continue;
      }
      if (!(role === "user" || role === "assistant")) continue;
      const content = py_or(g(r, "content"), "");
      /* 源 2357–2361：一条既无文本又无图片的 assistant 行是"回合没答完就死了"的残渣 ⇒ 丢掉。 */
      if (
        role === "assistant" &&
        !py_truth(py_strip_method(content)) &&
        !py_truth(g(meta, "images"))
      ) {
        continue;
      }
      const msg: JsonLike = {
        id: g(r, "id"),
        role,
        content,
        timestamp: py_mul(py_or(g(r, "created_at"), 0), 1000),
      };
      if (py_truth(g(meta, "images"))) msg["images"] = sub(meta, "images");
      if (py_truth(py_or(g(meta, "tool_calls"), g(meta, "toolCalls")))) {
        msg["toolCalls"] = py_or(g(meta, "tool_calls"), g(meta, "toolCalls"));
      }
      if (py_truth(g(meta, "reasoning"))) msg["reasoning"] = sub(meta, "reasoning");
      out.push(msg);
    }
    return out;
  }

  /** 源 2377–2416 `_turn_running_sid`：**谁在看都算** —— turn_state 是权威，内存任务表是佐证。 */
  _turn_running_sid(sid: unknown): boolean {
    if (!py_truth(sid)) return false;
    /* 1. 权威判定（2389–2396 的整段都在 try 里，连 import 一起兜）。 */
    let status: unknown = null;
    try {
      const ts = this.seams.get_turn_state();
      const st = this.seams.turn_status();
      status = ts.current(sid);
      if (
        status === st.PAUSED ||
        status === st.COMPLETED ||
        status === st.ERROR ||
        status === st.WAITING_USER ||
        status === st.IDLE
      ) {
        return false;
      }
    } catch (exc) {
      swallow_if_exception(exc);                            // fail-open
    }

    /* 2. 内存里这只会话的活任务。 */
    const task = this._turn_tasks_by_sid.get(sid);
    if (task !== null && task !== undefined && !task.done() && !task.cancelled()) return true;
    for (const [w, s] of this._session_by_ws) {
      if (s === sid) {
        const t = this._turn_tasks.get(w);
        if (t !== null && t !== undefined && !t.done() && !t.cancelled()) return true;
      }
    }

    /* 3. turn_state 卡在 RUNNING 但内存里没人 ⇒ 自愈成 IDLE。 */
    try {
      const ts = this.seams.get_turn_state();
      const st = this.seams.turn_status();
      if (status === st.RUNNING) ts.transition(sid, st.IDLE, undefined, true);
    } catch (exc) {
      swallow_if_exception(exc);                            // 源 2414 fail-open
    }
    return false;
  }

  /** 源 2420–2470 `_switch_and_reply`：new / switch 的公共尾巴 —— 只**重指向这条 socket**。 */
  async _switch_and_reply(ws: unknown, sid: unknown): Promise<void> {
    const bid = py_or(this._branch_by_ws.get(py_object_id(ws)), "");
    this._bind_session(ws, sid, bid);

    /* 源 2433–2442：切换**不再改共享 router**，而是将 socket 重绑到该会话自己的 Router
     * （这才是"A 窗口留在原对话、B 窗口走开"的原因）；仍对解析出的 router 调一次
     * `switch_session`，让本来就活着的会话重载 goal 与折叠记账。 */
    const router = this.host.get_or_create(sid);
    const live = this._turn_running_sid(sid);
    if (!live) {
      const result = router.switch_session(sid);
      if (!result.ok) {
        await this._send_error(ws, result.error);
        return;
      }
    } else if (!py_truth(router.storage.get_session(sid))) {
      await this._send_error(ws, `Unknown session: ${py_str(sid)}`);
      return;
    }

    const messages = this._history_messages(sid);

    if (!py_truth(messages)) {
      try {
        /* 源 2447–2458：空历史时把这套基线令牌数交给 analytics（整段 fail-open）。 */
        const analytics = this.seams.get_token_analytics();
        const compactor = py_getattr(router, "compactor");
        const sp_tokens = (py_getattr(compactor, "estimate_tokens") as (v: unknown) => unknown).call(
          compactor,
          (py_getattr(router, "get_system_prompt") as () => unknown).call(router),
        );
        const tool_tokens = (py_getattr(router, "_tool_def_tokens") as () => unknown).call(router);
        const skill_tokens = (py_getattr(router, "_skill_tokens") as () => unknown).call(router);
        const ctx_window = py_int(
          py_or(py_getattr_or(py_getattr(router, "llm"), "context_limit", 200000), 200000),
        );
        analytics.reset_session({
          system_prompt_tokens: sp_tokens,
          tool_def_tokens: tool_tokens,
          skill_tokens,
          context_window: ctx_window,
        });
      } catch (exc) {
        swallow_if_exception(exc);                          // 源 2459 fail-open
      }
    }
    await (ws as WebSocketResponseApi).send_json({
      type: "session_switched",
      timestamp: this.seams.now(),
      sessionId: sid,
      branchId: bid,
      payload: { sessionId: sid, branchId: bid, messages, turnRunning: live },
    });
    await this._broadcast_turn_state(sid);
    await this._send_pending_questions(ws, sid);
    await this._send_session_list(ws);
  }

  /** 源 2472–2477 `_handle_session_new`。 */
  async _handle_session_new(ws: unknown, payload: JsonLike): Promise<void> {
    const result = this._router_for(ws).new_session(gd(payload, "title", ""));
    if (!result.ok) {
      await this._send_error(ws, result.error);
      return;
    }
    await this._switch_and_reply(ws, result.value);
  }

  /** 源 2479–2487 `_handle_session_switch`。 */
  async _handle_session_switch(ws: unknown, payload: JsonLike): Promise<void> {
    const sid = g(payload, "sessionId");
    /* S2-B18：`bid` 经过 `or ""` 之后**永远不是 None** ⇒ 源 2485 的 `if bid is not None` 恒真
     * —— 一条不带 branchId 的 session_switch 会把这条 socket 的分支**抹成空串**。逐字复刻。 */
    const bid = py_or(py_or(g(payload, "branchId"), g(payload, "branch_id")), "");
    if (!py_truth(sid)) {
      await this._send_error(ws, "session_switch needs a sessionId");
      return;
    }
    if (bid !== null && bid !== undefined) {
      this._branch_by_ws.set(py_object_id(ws), py_strip(py_str(bid)));
    }
    await this._switch_and_reply(ws, sid);
  }

  /** 源 2489–2570 `_handle_session_fork`：truncate 的加法对应物（"留着，我换个法子再试一次"）。 */
  async _handle_session_fork(ws: unknown, payload: JsonLike): Promise<void> {
    const router = this._router_for(ws);
    const storage = router.storage;
    const sid = py_or(g(payload, "sessionId"), router.session_id);
    const ordinal = g(payload, "userOrdinal");
    /* §D12：源的 `isinstance(ordinal, int)` 对 JSON `2.0`（CPython 解析成 float）判 False，
     * 端口的 `Number.isInteger` 判 True ⇒ 差异取决于 seam `json_loads` 是否保留原始 token；
     * 本轮无 CPython 现场，端口按 `Number.isInteger` 落，登记为遗留 L4（不写死猜测）。 */
    if (!(typeof ordinal === "number" && Number.isInteger(ordinal)) || (ordinal as number) < 0) {
      await this._send_error(ws, "session_fork needs a non-negative userOrdinal");
      return;
    }
    if (this._turn_running(ws)) {
      await this._send_error(ws, "回合还在跑，先停下来再分叉");
      return;
    }

    const seq = storage.seq_of_nth_user_message(sid, ordinal);
    if (seq === null || seq === undefined) {
      await this._send_error(ws, "找不到那条消息，可能已经被撤回了");
      return;
    }

    /* 源 2519–2523：**严格早于**被分叉那一轮；-1 合法，含义是"从最开头长出一条空分支"。 */
    const branch_point = py_sub(py_int(seq), 1);
    const turns = storage.list_user_turns(sid);
    /* 源 2525 的 `next(genexpr, "")`：`t["ordinal"]` / `t["preview"]` 都是**下标** ⇒ 缺键 KeyError。
     * 与 Python 的 `==` 一致：这里两侧都是 JSON 整数，`===` 即值相等（§M 无 py_eq，见 STATE §3）。 */
    let original: unknown = "";
    for (const t of py_iter(turns)) {
      if (sub(t as JsonLike, "ordinal") === ordinal) {
        original = sub(t as JsonLike, "preview");
        break;
      }
    }

    const new_sid = `${py_str(sid)}-fork-${this.seams.uuid4_hex8()}`;
    let title = py_strip_or(g(payload, "title"));
    if (!py_truth(title)) {
      /* 源 2530–2538：否则 `branch()` 会命名成 "Branch of <uuid>"，在侧栏里读起来像机器残渣。 */
      let parent_row: JsonLike;
      try {
        parent_row = py_or(storage.get_session(sid), {}) as JsonLike;
      } catch (exc) {
        swallow_if_exception(exc);                          // 源 2535–2536
        parent_row = {};
      }
      const base = py_strip(py_str(py_or(g(parent_row, "title"), "")));
      title = py_truth(base) ? `${base} · 分支` : "分支";
    }
    const result = storage.branch(sid, branch_point, new_sid, title);
    if (!py_truth(py_getattr_or(result, "ok", true))) {
      await this._send_error(ws, py_getattr_or(result, "error", "分叉失败"));
      return;
    }

    /* 源 2544–2551：分叉继承被复制历史所引用的 pre-image ⇒ 它自己的时间线也能为那些轮提供退路。 */
    let copied: unknown = 0;
    try {
      copied = this.seams.get_snapshot_store().copy_to_session(sid, new_sid, branch_point);
    } catch (exc) {
      swallow_if_exception(exc);                            // 源 2550
      this.seams.py_print(`[fork] snapshot copy skipped: ${exc_str(exc)}`);
    }

    await (ws as WebSocketResponseApi).send_json({
      type: "session_forked",
      timestamp: this.seams.now(),
      sessionId: new_sid,
      payload: {
        sessionId: new_sid,
        parentId: sid,
        branchPoint: branch_point,
        userOrdinal: ordinal,
        /* 源 2562–2564：让输入框能把原提示再递给用户，而不是要他重打一遍。 */
        originalText: original,
        snapshotsCopied: copied,
      },
    });
    /* 源 2568–2570：把本窗口挪到分叉上并刷新侧栏，否则新分支是一只谁也到不了的会话。 */
    await this._switch_and_reply(ws, new_sid);
  }

  /** 源 2572–2610 `_handle_session_delete`。 */
  async _handle_session_delete(ws: unknown, payload: JsonLike): Promise<void> {
    const sid = g(payload, "sessionId");
    if (!py_truth(sid)) {
      await this._send_error(ws, "session_delete needs a sessionId");
      return;
    }
    const router = this._router_for(ws);
    const storage = router.storage;
    const was_active = sid === router.session_id;
    /* 源 2580：`delete_session` **不在 try 里** ⇒ 失败冒出 handler（S2-B3：整条 WS 报废）。 */
    storage.delete_session(sid);

    try {
      this.seams.get_terminal_manager().close(sid);
    } catch (exc) {
      swallow_if_exception(exc);                            // 源 2585–2586
    }

    if (was_active) {
      /* 源 2589–2604：当前会话没了 —— 把**本窗口**移到最近的一条剩余会话；一条都不剩就在
       * 同一个 Router 实例上造一条新的并在 host 里重键（新建 Router 会让两个实例声称同一段对话）。 */
      const remaining = storage.list_sessions(1);
      if (py_truth(remaining)) {
        this.host.close(sid);
        await this._switch_and_reply(ws, sub(py_iter(remaining)[0] as JsonLike, "id"));
        return;
      }
      const result = router.new_session();
      if (!result.ok) {
        await this._send_error(ws, result.error);
        return;
      }
      this.host.rebind(sid, result.value);
      await this._switch_and_reply(ws, result.value);
      return;
    }

    /* 源 2606–2608：删掉的是后台会话 —— 丢掉它的 Router，免得后续 get_or_create 复活一个
     * 绑在已消失行上的实例。 */
    this.host.close(sid);
    await this._broadcast_session_list();
    await this._broadcast_workspace_list();
  }

  /** 源 2612–2620 `_handle_session_rename`。 */
  async _handle_session_rename(ws: unknown, payload: JsonLike): Promise<void> {
    const sid = g(payload, "sessionId");
    const title = py_strip_or(g(payload, "title"));
    if (!py_truth(sid) || !py_truth(title)) {
      await this._send_error(ws, "session_rename needs sessionId + title");
      return;
    }
    this._router_for(ws).storage.rename_session(sid, title);
    await this._broadcast_session_list();
    await this._broadcast_workspace_list();
  }

  /** 源 2622–2629 `_handle_session_pin`。 */
  async _handle_session_pin(ws: unknown, payload: JsonLike): Promise<void> {
    const sid = g(payload, "sessionId");
    if (!py_truth(sid)) {
      await this._send_error(ws, "session_pin needs a sessionId");
      return;
    }
    this._router_for(ws).storage.set_session_pinned(sid, py_bool(g(payload, "pinned")));
    await this._broadcast_session_list();
    await this._broadcast_workspace_list();
  }

  /** 源 2631–2708 `_handle_session_truncate`：服务端撤回一轮（`rollbackFiles` 让它成为原子撤销）。 */
  async _handle_session_truncate(ws: unknown, payload: JsonLike): Promise<void> {
    /* 源 2638–2645：跨线句柄是**用户轮序号**（前端消息 id 是客户端造的，这里没有意义）。 */
    const ordinal = g(payload, "userOrdinal");
    const rollback_files = py_bool(g(payload, "rollbackFiles"));
    const router = this._router_for(ws);
    const sid = router.session_id;
    const storage = router.storage;

    if (!(typeof ordinal === "number" && Number.isInteger(ordinal)) || (ordinal as number) < 0) {
      await this._send_error(ws, "session_truncate needs a non-negative integer userOrdinal");
      return;
    }

    const seq = storage.seq_of_nth_user_message(sid, ordinal);
    if (seq === null || seq === undefined) {
      /* 源 2658–2668：没东西可切 —— 客户端比服务端超前（那轮从没落库）。上报而不是闹。 */
      await this._broadcast({
        type: "session_truncated",
        timestamp: this.seams.now(),
        sessionId: sid,
        payload: { ok: true, deleted: 0, seq: null, files: null },
      });
      return;
    }

    const deleted = storage.truncate_after_seq(sid, seq);

    let files: unknown = null;
    if (rollback_files) {
      try {
        files = this.seams.get_snapshot_store().rollback_since(sid, seq);
      } catch (exc) {
        swallow_if_exception(exc);                          // 源 2677
        files = { errors: [{ path: "*", error: exc_str(exc) }], count: 0 };
      }
    } else {
      /* 源 2680–2683：只撤聊天 ⇒ 那些轮的快照再也应用不了（检查点已从历史消失），
       * 于是离开活动时间线 —— 是**折叠**不是删除（UB1）：它们改过什么的记录仍值得留着。 */
      try {
        this.seams.get_snapshot_store().discard_since(sid, seq);
      } catch (exc) {
        swallow_if_exception(exc);                          // 源 2687
        this.seams.py_print(`[http_server] operation FAILED: ${exc_str(exc)}`);
      }
    }

    /* 源 2691–2694：router 不缓存历史（每轮重读）⇒ 没有内存态要失效，但**回合检查点**必须
     * 退回，否则下一个快照会被标到切口之后。注意这里没有 `int()`（对比 fork 臂 2523）。 */
    router._turn_seq = py_sub(seq, 1);

    await this._broadcast({
      type: "session_truncated",
      timestamp: this.seams.now(),
      sessionId: sid,
      payload: {
        ok: true,
        seq,
        /* 源 2703：`deleted.value if hasattr(deleted, "value") else deleted` —— 包装对象与裸值两张脸。 */
        deleted: py_getattr_or(deleted, "value", deleted),
        files,
      },
    });
    await this._broadcast_session_list();
    await this._broadcast_workspace_list();
  }

  /** 源 2710–2731 `_send_error`：`message` 可以是裸串（大量旧调用点的兼容面）或三键 dict。 */
  async _send_error(ws: unknown, message: unknown): Promise<void> {
    const payload: JsonLike = is_dict(message)
      ? {
          message: py_or(g(message, "message"), "出错了"),
          hint: py_or(g(message, "hint"), ""),
          detail: py_or(g(message, "detail"), ""),
        }
      : { message: py_str(message) };
    await (ws as WebSocketResponseApi).send_json({
      type: "error",
      timestamp: this.seams.now(),
      payload,                                        // 源 2727–2731：错误帧**没有 sessionId** ⇒ 人人可见
    });
  }

  /** 源 2733–2738 `_deliver`：发给一条 socket，失败就把它丢掉。 */
  async _deliver(client: unknown, event: JsonLike): Promise<void> {
    try {
      await (client as WebSocketResponseApi).send_json(event);
    } catch (exc) {
      swallow_if_exception(exc);                        // 源 2737 `except Exception`
      this.clients.delete(client as WebSocketResponseApi);
    }
  }

  /** 源 2740–2792 `_broadcast`：把事件扇出到**属于它的那些** socket。 */
  async _broadcast(event: JsonLike): Promise<void> {
    /* 源 2751–2762：帧顶层与 payload 内层两套姿势各扫一遍（`isinstance(payload, dict)` 否则 {}）。 */
    const evt_payload = is_dict(g(event, "payload")) ? (g(event, "payload") as JsonLike) : {};
    /* `A or B or C or D` 的左结合面：全假时返回**最后一项**（`py_or` 的链式嵌套即源语义）。 */
    const target_session = py_or(
      py_or(
        py_or(g(event, "sessionId"), g(event, "session_id")),
        py_or(g(evt_payload, "sessionId"), g(evt_payload, "session_id")),
      ),
      g(evt_payload, "session_id"),
    );
    const target_branch = py_or(
      py_or(
        py_or(g(event, "branchId"), g(event, "branch_id")),
        py_or(g(evt_payload, "branchId"), g(evt_payload, "branch_id")),
      ),
      g(evt_payload, "branch_id"),
    );
    const evt_type = g(event, "type");
    const is_lifecycle =
      evt_type === "session_list" ||
      evt_type === "workspace_list" ||
      evt_type === "goal_state_change";
    /* 源 2765–2769：六个具名 + 两个前缀（前缀面走 `str(evt_type or "")`，None ⇒ ""）。 */
    const evt_type_str = py_str(py_or(evt_type, ""));
    const is_scoped_evolution =
      evt_type === "learning_item_event" ||
      evt_type === "evolution_insight" ||
      evt_type === "evolution_notice" ||
      evt_type === "evolution_proposal" ||
      evt_type === "episode_sealed" ||
      evt_type === "episode_started" ||
      evt_type_str.startsWith("learning_item") ||
      evt_type_str.startsWith("evolution_");
    const is_global =
      py_str_eq(g(event, "scopeType"), "global") ||
      py_str_eq(g(evt_payload, "scopeType"), "global") ||
      py_str_eq(g(evt_payload, "scope"), "global");

    for (const client of [...this.clients]) {
      const cid = py_object_id(client);
      const bound_session = this._session_by_ws.get(cid);
      const bound_branch = py_strip(py_str(py_or(this._branch_by_ws.get(cid), "")));

      if (is_scoped_evolution && !is_global) {
        /* 源 2778–2785（P0-1 & P0-2）：作用域内的 evolution 事件必须**会话与分支双精确匹配**；
         * 未绑定（bound_session 为 None）或分支不符的 socket 一律严格拒绝。 */
        if (!py_truth(bound_session) || !(bound_session === target_session)) continue;
        const tgt_b = py_strip(py_str(py_or(target_branch, "")));
        if (bound_branch !== tgt_b) continue;
      } else if (py_truth(target_session) && !is_lifecycle && !is_global) {
        /* 源 2787–2790：只发给匹配的会话 —— 但**没申报会话**的 socket（刚连上的窗口，
         * 几乎总是主窗口）仍会收到，所以这里判的是 `is not None`，不是真值。 */
        if (bound_session !== null && bound_session !== undefined && !(bound_session === target_session)) {
          continue;
        }
      }
      await this._deliver(client, event);
    }
  }
}

// PORT STATUS: 本文件无 TODO(port)。
