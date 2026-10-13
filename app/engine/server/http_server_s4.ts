/**
 * http_server_s4.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S4**。
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md` · 死路/seam 约定 `tmp/w218_S0_NOTES.md`。
 * 风格母版：已落地的 S3（`http_server_s3.ts`）——seam 对象 + fail-closed 缺省 + CPython 异常镜像。
 *
 * 覆盖源区间 **3261–3865**（goals CRUD + 反思/课程/技能模式 + 工作区解析 + 进化回退 +
 * 工作流定时 + cron CRUD + bot 与三家 IM webhook）：
 *   3261–3271  handle_goals                        GET    /api/goals
 *   3274–3312  handle_create_goal                  POST   /api/goals                (BARE json)
 *   3315–3394  handle_update_goal                  PATCH  /api/goals/{id}           (BARE json)
 *   3398–3415  handle_delete_goal                  DELETE /api/goals/{id}
 *   3418–3439  handle_run_goal                     POST   /api/goals/{id}/run
 *   3442–3467  handle_pause_goal                   POST   /api/goals/{id}/pause
 *   3470–3496  handle_goal_iterations              GET    /api/goals/{id}/iterations
 *   3499–3526  handle_goal_events                  GET    /api/goals/{id}/events
 *   3529–3536  handle_goal_contract                GET    /api/goals/{id}/contract
 *   3539–3546  handle_reflections                  GET    /api/reflections
 *   3549–3555  handle_curriculum_gaps              GET    /api/curriculum/gaps
 *   3558–3564  handle_skill_patterns               GET    /api/skills/patterns
 *   3567–3574  _resolve_request_workspace          （私有 helper，同步函数；全文件只有 3586/3597 两处调用）
 *   3577–3591  handle_evolution_undo               POST   /api/evolution/undo       (except Exception -> {})
 *   3594–3600  handle_evolution_undo_list          GET    /api/evolution/undo
 *   3605–3611  handle_workflow_schedules_list      GET    /api/workflows/schedules
 *   3614–3639  handle_workflow_schedule_create     POST   /api/workflows/schedules (except Exception -> {})
 *   3642–3650  handle_workflow_schedule_delete     DELETE /api/workflows/schedules/{id}
 *   3655–3659  handle_crons                        GET    /api/crons
 *   3662–3695  handle_create_cron                  POST   /api/crons                (BARE json)
 *   3698–3712  handle_update_cron                  PATCH  /api/crons/{id}           (BARE json)
 *   3715–3720  handle_delete_cron                  DELETE /api/crons/{id}
 *   3725–3731  handle_bot_messages                 GET    /api/bot/messages
 *   3734–3746  handle_bot_send                     POST   /api/bot/send             (BARE json)
 *   3749–3773  handle_bot_config_get               GET    /api/bot/config/{platform}
 *   3776–3791  handle_bot_config_put               PUT    /api/bot/config/{platform} (BARE json)
 *   3794–3798  handle_bot_status                   GET    /api/bot/status
 *   3801–3817  handle_feishu_webhook               POST   /api/bot/webhook/feishu   (raw read)
 *   3820–3835  handle_dingtalk_webhook             POST   /api/bot/webhook/dingtalk (raw read)
 *   3838–3864  handle_wecom_webhook                GET    /api/bot/webhook/wecom    (raw read；#34/#35 两条注册同一个 handler)
 *   3838–3864  handle_wecom_webhook                POST   /api/bot/webhook/wecom
 *
 * **计数**：30 条注册 / 29 个 handler（`handle_wecom_webhook` 挂 GET+POST 两条）+ 1 个私有 helper。
 * 本段**不注册任何路由**（S10 装配）；ROUTE_TABLE 里 `seg: "S4"` 的 30 行 → 就是本文件的导出。
 * 跨段边界（S0 NOTES §末尾冲突表）：`handle_confirm_goal_stopped`（goals 族）按行号在 **S3**，
 * 本段不重复实现；`/api/skills/{name}` 与 skills 族在 **S5**，本段只有 `/api/skills/patterns`（S10 撞名表已记）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 源码自带死路 / 不一致：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）。编号 S4-Bn，全表在
 * `tmp/w218_S4_NOTE.md` §3，这里给一行摘要：
 * S4-B1  3407–3411 handle_delete_goal 丢弃 `pause()` 的 Result（不看 `.ok`），而 3346–3352 的
 *        update_goal 同一调用会看 `.ok` 并 409。两处姿势不一致，端口都不判。
 * S4-B2  3335–3360 status 只在 `== PAUSED` 一支走调度器；把 RUNNING 的目标直接 PATCH 成
 *        completed/cancelled/active 时**不通知调度器**，只改 DB 行（两个真相源）。
 * S4-B3  3346–3356 调度器成功暂停那一条臂 `updates` 保持空 ⇒ 终态事件 `goal_state_change`
 *        不发（3384 只认 CANCELLED/COMPLETED，PAUSED 本来就不在名单里，端口不扩）。
 * S4-B4  3516–3517 `int(request.query.get("limit"))` 在 try **之外**（try 从 3518 才开始）：
 *        `?limit=abc` 的 ValueError 冒出 handler。同族 B10。
 * S4-B5  3544 同型：`int(request.rel_url.query.get("limit", "20") or 20)` 无兜底。
 * S4-B6  3669 的门槛只看 camel 的 `delayMinutes`，而 3679 的取值兼容 `delay_minutes`：
 *        纯 snake_case 的定时请求会被 3670 的 400 挡掉（"expression and taskName required"）。
 * S4-B7  3703–3712 cron 状态机的三个 manager 调用的返回值**全部丢弃**，失败也回 200 + 请求的 status。
 * S4-B8  3719 `manager.delete_cron(cron_id)` 返回值丢弃 ⇒ 删不存在的 id 也回 `{"deleted": id}`。
 * S4-B9  3456–3461 pause_goal 的 try 同时罩住"取调度器"和"调用 pause"，于是 pause() 自己抛的
 *        RuntimeError 也渲染成 503 "not running on this server"；run_goal（3426–3432）的 try
 *        **只**罩 getter。同一文件两种范围。
 * S4-B10 3765–3772 掩码用 `len(v)`（CPython 按**码点**）与 `v[-4:]`；端口按码点复刻（D3）。
 *        非 ASCII secret 在 JS 里按 `.length` 会算错 ⇒ 这里是"为对齐 python 故意偏离 JS 直觉"。
 * S4-B11 3787–3788 config PUT 跳过任何以 `•` 开头的字符串 ⇒ 真值恰好以 `•` 开头的 secret
 *        永远写不进去（无逃逸口）。照抄。
 * S4-B12 3850–3864 wecom：503/403 用 `web.Response(text=...)`（**没有 content_type**），
 *        成功支是 `text/plain` 且**不写 status**（⇒200），500 支把 `str(exc)` 原样进正文。
 *        GET 握手支从不 `request.read()`。全部照抄（= S0 NOTES 的 B8）。
 * S4-B13 3383 `_new_status = str(updates.get("status") or "")`：status 若是**真值非字符串**
 *        （3336 的 `str(...)` 已经把它变成 str，所以这一支其实是恒等），端口仍按两步写。
 * S4-B14 3303 `float(data.get("costCapUsd") or 0)`：`or` 把 `0`/`""`/`False` 都塌成 0，
 *        于是 `costCapUsd: 0` 走的是 else 支（用全局默认 5_000_000），**不是**"预算 0"。
 * S4-B15 3295/3301 的门槛是 `is not None`，而取值又是第二次 `data.get(...)`：同一个键读两遍，
 *        假件若让 `.get` 有副作用（计数/弹出）则两次结果可不同。端口同样读两遍，不合并。
 * S4-B16 3624 `require_promoted = body.get("require_promoted", True)` **不做布尔化**：
 *        传 `"false"`/`0`/`[]` 原样进调度器（python 真值判定发生在下游）。端口不 clamp。
 * S4-B17 3778 `handle_bot_config_put` 里的 `from bot_remote import get_bot_controller` **从未被使用**
 *        （同函数 3779 只 import get_storage）：多一次可能冒出的 ImportError，且没有任何控制器调用。
 *        端口同样只取 `storage_get()`、不碰 `bot_controller_get()`，把这条死 import 原样留在注释里。
 * S4-B18 3682–3690 `manager.create(task_name, prompt, ..., task_name=task_name, ...)`：`cron_manager.py:197`
 *        的第一参数名是 **`title`** ⇒ 同一个值以位置实参（→title）和关键字实参各出现一次（合法、形状怪异），
 *        且 `cron_expr=expression or None` 把空表达式塌成 None。查证后**不是** TypeError 级缺陷，
 *        但"两键同源同值"必须原样交给假件 ⇒ seam 的 opts 同时带 `title` 与 `task_name`。
 *
 * DIVERGENCE(port):
 *  D1 `request.rel_url.query`（源 3543/3544）与 `request.query` 在 aiohttp 里是**同一个**
 *    MultiDict（`rel_url.query` 是 `URL.query` 属性，包装同一个对象）。keys.ts 的 WebRequest
 *    只暴露 `query`，端口统一走 `request.query`，等价性 = 源里这两处只是"写法不同、真相源相同"。
 *    （源里没有 `request.text()/post()/url/remote/content/multipart`，本段一条都没写。）
 *  D2 `request.query.get(name)`（**单参**，源 3516）在 multidict 里缺键返回 `None`，
 *    而 keys.ts 的 `QueryView.get(name, fallback?): string` 把返回型钉成 string（源里 60+ 处
 *    都带默认值）。端口不改 keys.ts，用 `query_get_raw` 做一次**同成员**的调用面适配
 *    （仍然是 `request.query.get`，不是新成员）。契约：装配层/探针的 QueryView 实现必须
 *    在单参且缺键时返回 null/undefined，否则 3517 的 `is not None` 判定会从"默认 500"
 *    漂到 `int("")` 的 ValueError 支——这条已写进 NOTE §2 交给主控。
 *  D3 CPython `len(s)` / `s[-4:]` / `s[:-4]` 按**码点**，JS 按 UTF-16 单元：本段三处
 *    （掩码、`"•"*n`、截断）一律先 `Array.from` 再算，见 `py_len` / `py_tail` / `py_repeat`。
 *    等价性：掩码长度与尾巴内容是探针可观察的响应体，代理对 secret（emoji、部分 CJK 扩展）
 *    两侧必须同结果；星平面字符 python 是 1、JS `.length` 是 2。
 *  D4 `str.lower()` 用 JS `toLowerCase()`：两侧差异只在"小写后跨字符"的极少数码位
 *    （如 `İ`）。本段两处消费点（`enabled_only in ("1","true")`、header 名小写）对这些字符
 *    一律"不命中"，python 与端口结论相同 ⇒ 无可观察差。
 *  D5 `request.headers.items()`（源 3812/3830 的 `{k.lower(): v ...}`）：aiohttp 的
 *    CIMultiDict 保留线序与原始大小写，python 的字典推导对"仅大小写不同的同名头"是**后者覆盖**；
 *    keys.ts 的 HeaderView 已经是大小写不敏感的单值面（`make_headers` 用 lowercase 键），
 *    所以这层折叠发生在接缝之前，端口的 lower() 是幂等操作。差异仅在"同名多值头"上，
 *    而源里 provider 读的是单值（`x-lark-signature` / `timestamp` / `sign`）。探针若要用
 *    多值头驱动，必须从 `headers.items()` 的真身喂进来（已登记为探针注记，不改语义）。
 *  D6 未捕获异常（BARE json、seam 抛出的非兜底类、`int()` 的 ValueError）在端口里是
 *    rejected promise 向上冒，**不在本文件渲染**。装配层 `CreateServerSeams.render_uncaught`
 *    负责最终状态码（S0 NOTES B4：源码推不出，探针钉死）。端口不自创 400/500。
 *  D7 CPython `str(exc)`：异常镜像类自 218 的"镜像层上收"之后分两种来源——
 *    ① **keys.ts §M 的共享层**：`ModuleNotFoundErrorP` / `PyRuntimeErrorP` /
 *    `PyAttributeErrorP`（原来从 S3 借，S3 现在不再导出）；
 *    ② 本文件**仍自带**：`PyValueErrorP`、`PyTypeErrorP`、`PyKeyErrorShim`，以及 §1 的
 *    `py_dict_get`/`py_iter_list`/`py_getattr*`/`py_strip` 等小工具。
 *    ②是 S4 落盘评审的必答题：能删的删（改 import），不能删的必须给出"语义真的不同"的
 *    证据——`py_strip` 那份主控已经用 1114112 个码位全量比对证明与 keys.ts 版本等价
 *    （tmp/lead_fidelity2/ab_report.txt），而 `py_iter_list` 与 keys 的 `py_iter` **不等价**
 *    （前者只收 list/Set，str/dict 直接 TypeError；后者对 str 按码点、对 dict 按键）。
 *    这些类的 `.message` 就是 CPython 文案，`exc_str` 直接取；`except` 的**族判定**用
 *    `py_exc_classes`（看 name 与文案前缀），因此"跨模块副本 / 跨 realm 的同类异常"
 *    仍然被认成同一 python 类——这是刻意的（共享 node-repl 内核与 emit 双份文件的既有风险）。
 *  D8 源里 `storage.update_goal_fields(goal_id, **updates)`（3309/3378）与
 *    `update_goal_fields(goal_id, status=GoalStatus.PAUSED)`（3354）都是**关键字实参展开**：
 *    端口的 seam 声明成 `update_goal_fields(goal_id, fields: JsonDict)`，把 kwargs 收成一只位置
 *    dict。可观察差只在"假件按位置参数计数/参数名反射"时才出现（python 侧 `**updates` 的键集合
 *    就是 updates 的键集合，与端口的 dict 同一份），因此等价；探针若要用 python 形状的签名驱动，
 *    必须按"第二实参 = 待更新字段字典"来断言（S0 NOTES 的 seam 约定：字典序无关，键集合才是语义）。
 */

import {
  exc_str,
  json_response,
  ModuleNotFoundErrorP,
  py_dict_get,
  py_float,
  py_getattr,
  py_getattr_or,
  py_int,
  py_or,
  py_str,
  py_strip,
  py_truth,
  py_type_name,
  PyAttributeErrorP,
  PyRuntimeErrorP,
  ROUTER_KEY,
  text_response,
  type JsonDict,
  type WebRequest,
  type WebResponse
} from "./http_server_keys.js";

/* ──────────────────────────────────────────────────────────────────────────
 * §0 CPython 异常镜像（S4 新增的两类；其余从 S3 复用，保持 instanceof 单一身份）
 * ──────────────────────────────────────────────────────────────────────── */

/** `ValueError`（keys.ts 的 py_int/py_float 把 ValueError 装在 JS TypeError 里，见 §DIVERGENCE 7）。 */
export class PyValueErrorP extends Error {
  constructor(message: string) {
    super(`ValueError: ${message}`);
    this.name = "ValueError";
  }
}

/** `TypeError`（`x in y` 对非容器、下标类型错、`len()` 不适用等）。 */
export class PyTypeErrorP extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeError";
  }
}


/**
 * 一次 except 族判定要用的 python 类名集合。
 * 两条来源：① 镜像类的 `name`（"RuntimeError"/"AttributeError"/...）；
 * ② CPython 文案前缀 `^XxxError:`（keys.ts 的 `py_int` 抛 JS TypeError 装 ValueError 文案）。
 * `PyKeyError`（keys.ts）的文案是 `KeyError: <repr>` → 命中②，判定为 python 的 KeyError。
 */
function py_exc_classes(exc: unknown): string[] {
  const out: string[] = [];
  if (exc instanceof Error) {
    if (exc.name) out.push(exc.name);
    const msg = exc.message ?? "";
    const lead = /^([A-Za-z_]*Error)\b/.exec(msg);
    if (lead && lead[1] !== undefined) out.push(lead[1]);
    if (msg.startsWith("ValueError:")) out.push("ValueError");
    if (msg.startsWith("TypeError:")) out.push("TypeError");
  }
  return out;
}

/** `except (A, B):` —— 族判定按 python 类名（D7，对跨副本异常同样有效）。 */
function catches_classes(exc: unknown, classes: readonly string[]): boolean {
  const got = py_exc_classes(exc);
  return got.some((g) => classes.includes(g));
}

const TYPE_OR_VALUE_ERROR: readonly string[] = ["TypeError", "ValueError"];
const RUNTIME_ERROR: readonly string[] = ["RuntimeError"];

/* ──────────────────────────────────────────────────────────────────────────
 * §1 CPython 语义小工具（dict / in / 下标 / 切片 / 字符串）
 *    注：`py_dict_get`/`py_iter_list`/`py_getattr*` 在 S3 是**文件私有**未导出，
 *    keys.ts 也没有这一层 ⇒ S4 只能自带一份（已登记给主控：建议整体上提到 keys.ts）。
 * ──────────────────────────────────────────────────────────────────────── */

/** 端口侧的"python dict"：非 null 的对象，且不是 list / bytes / set。 */
function is_pydict(v: unknown): v is JsonDict | Map<unknown, unknown> {
  if (v === null || v === undefined) return false;
  if (typeof v !== "object") return false;
  if (Array.isArray(v) || v instanceof Uint8Array || v instanceof Set) return false;
  return true;
}


/** `d[k]`（**下标**读）：dict 缺键 KeyError；list/str 走切片语义（本段只用到 dict 面）。 */
function py_dict_index(target: unknown, key: string): unknown {
  if (is_pydict(target)) {
    if (target instanceof Map) {
      for (const [k, v] of target.entries()) if (k === key) return v;
      throw new PyKeyErrorShim(key);
    }
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new PyKeyErrorShim(key);
    return (target as JsonDict)[key];
  }
  if (typeof target === "string") {
    throw new PyTypeErrorP(`TypeError: string indices must be integers, not 'str'`);
  }
  if (Array.isArray(target)) {
    throw new PyTypeErrorP("TypeError: list indices must be integers or slices, not str");
  }
  throw new PyTypeErrorP(`TypeError: '${py_type_name(target)}' object is not subscriptable`);
}

/** `d[k] = v`（下标写）：非 dict → TypeError。 */
function py_dict_setitem(target: unknown, key: string, value: unknown): void {
  if (!is_pydict(target)) {
    throw new PyTypeErrorP(`TypeError: '${py_type_name(target)}' object does not support item assignment`);
  }
  if (target instanceof Map) { target.set(key, value); return; }
  (target as JsonDict)[key] = value;
}

/** `key in container`：dict→键、list→成员、str→子串；其余 TypeError（源 3335/3362/3368 的 `in data`）。 */
function py_contains(container: unknown, key: unknown): boolean {
  if (is_pydict(container)) {
    return py_dict_has(container, String(key));
  }
  if (Array.isArray(container)) return container.some((el) => el === key);
  if (typeof container === "string") {
    if (typeof key !== "string") {
      throw new PyTypeErrorP(`TypeError: 'in <string>' requires string as left operand, not ${py_type_name(key)}`);
    }
    return container.includes(key);
  }
  if (container instanceof Set) return [...(container as Set<unknown>)].some((el) => el === key);
  throw new PyTypeErrorP(`TypeError: argument of type '${py_type_name(container)}' is not iterable`);
}

function py_dict_has(target: JsonDict | Map<unknown, unknown>, key: string): boolean {
  if (target instanceof Map) {
    for (const k of target.keys()) if (k === key) return true;
    return false;
  }
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** `d.items()`：非 dict → AttributeError（文案里是 'items'）。 */
function py_dict_items(target: unknown): Array<[string, unknown]> {
  if (!is_pydict(target)) throw new PyAttributeErrorP(target, "items");
  if (target instanceof Map) return [...target.entries()].map(([k, v]) => [String(k), v] as [string, unknown]);
  const out: Array<[string, unknown]> = [];
  for (const k of Object.keys(target)) out.push([k, (target as JsonDict)[k]]);
  return out;
}

/** `{k.lower(): v ...}` 的目标（保序、后写覆盖前写）。 */
function py_dict_from_pairs(pairs: Array<[string, unknown]>): JsonDict {
  const out: JsonDict = {};
  for (const [k, v] of pairs) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) Object.defineProperty(out, k, { value: undefined, writable: true, enumerable: true, configurable: true });
    (out as JsonDict)[k] = v;
  }
  return out;
}

/** `for x in seq`：必须是 list（python 里对 None 迭代抛 TypeError）。 */
function py_iter_list(v: unknown): readonly unknown[] {
  if (Array.isArray(v)) return v;
  if (v instanceof Set) return [...(v as Set<unknown>)];
  throw new PyTypeErrorP(`TypeError: '${py_type_name(v)}' object is not iterable`);
}



/** python `len(x)`：str 按码点、list/dict 按项，其余 TypeError。 */
function py_len(v: unknown): number {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (is_pydict(v)) return Object.keys(v as JsonDict).length;
  if (v instanceof Uint8Array) return v.length;
  throw new PyTypeErrorP(`TypeError: object of type '${py_type_name(v)}' has no len()`);
}

/** `s[-n:]`（按码点）。 */
function py_tail(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.slice(Math.max(0, cps.length - n)).join("");
}

/** `"•" * n`（n<=0 → ""，与 python 一致）。 */
function py_repeat(unit: string, n: number): string {
  return n > 0 ? unit.repeat(n) : "";
}


/** python `sorted(iterable_of_str)`：按码点序列比较（与 `<` on str 一致）。 */
function py_sorted_strings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => {
    const xs = Array.from(a);
    const ys = Array.from(b);
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
      const ca = (xs[i] as string).codePointAt(0) as number;
      const cb = (ys[i] as string).codePointAt(0) as number;
      if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return xs.length === ys.length ? 0 : xs.length < ys.length ? -1 : 1;
  });
}

/** `v.startswith("•")`（**码点 0** 判定，与 python 同）。 */
function py_startswith(s: unknown, prefix: string): boolean {
  return typeof s === "string" && Array.from(s).join("").startsWith(prefix);
}

/** `isinstance(v, str)`。 */
function py_isinstance_str(v: unknown): v is string {
  return typeof v === "string";
}

/** 与 keys.ts `PyKeyError` 同文案的**下标**版（`d[k]` 缺键：CPython 渲染 `KeyError: 'k'`）。 */
class PyKeyErrorShim extends Error {
  readonly keyText: string;
  constructor(key: string) {
    super(`KeyError: ${py_repr_str(key)}`);
    this.name = "KeyError";
    this.keyText = py_repr_str(key);
  }
}

/** python `repr('x')`（单引号优先，与 keys.ts py_repr 同规则；这里只需要 str 面）。 */
function py_repr_str(s: string): string {
  const hasS = s.includes("'");
  const hasD = s.includes('"');
  const q = hasS && !hasD ? '"' : "'";
  const esc = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return q + esc.split(q).join("\\" + q) + q;
}

/**
 * `request.query.get(name)`（**单参**）的缺键 None 面（§DIVERGENCE 2）。
 * 仍然是 `request.query.get` 这一个成员，只是把返回型放开到 unknown 以便表达 None。
 */
function query_get_raw(request: WebRequest, name: string): unknown {
  const raw = request.query as unknown as { get(n: string): unknown };
  return raw.get(name);
}

/** `to_dict()` 面的 list comp：`[x.to_dict() for x in seq]`。 */
function py_call_to_dict(seq: readonly unknown[]): unknown[] {
  return seq.map((x) => {
    const fn = py_getattr(x, "to_dict");
    if (typeof fn !== "function") {
      throw new PyTypeErrorP(`TypeError: 'NoneType' object is not callable`);
    }
    return (fn as () => unknown).call(x);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §2 接缝表（红线 5：本段唯一的对外触碰面；探针在此插假件）
 *    缺省一律 fail-closed：模块面抛 ModuleNotFoundError（对应源里"函数级 import 不在 try"
 *    → 冒出 handler；或在 try 里 → 被同一臂吞成降级/500），调度器面抛 PyRuntimeErrorP 会
 *    被 handler **显式捕获**成 503 —— 因此默认值必须选 ModuleNotFound，未接线时绝不静默成功。
 * ──────────────────────────────────────────────────────────────────────── */

/** python `Result` 的鸭子面（源里 `.ok` / `.value` / `.error` 三字段；goal/cron/workflow/undo 共用）。 */
export interface ResultLike {
  readonly ok: unknown;
  readonly value: unknown;
  readonly error: unknown;
}

/** 有 `to_dict()` 的返回值（AgentEvent / Reflection / SkillGap / Pattern / CronJob）。 */
export interface ToDictLike {
  to_dict(): unknown;
}

/** `goal_manager.Goal`（源 3309/3311 读 `goal.id`）。 */
export interface GoalObjectLike {
  readonly id: unknown;
}

/** storage 的 goals 面（源 3278 `manager.storage`，3309/3311/3483/3519 消费）。 */
export interface GoalStorageLike {
  get_goal(goal_id: string): unknown | null;
  update_goal_fields(goal_id: string, fields: JsonDict): void;
  list_goal_iterations(goal_id: string): readonly unknown[];
  get_event_store(): EventStoreLike;
}

/** `storage.get_event_store().read_by_dimension("goal_id", gid, limit=...)`（源 3519）。 */
export interface EventStoreLike {
  read_by_dimension(dimension: string, value: string, opts: { limit: number }): readonly ToDictLike[];
}

/** `get_goal_manager()`（源 3262/3275/3323/3325、3400/3402、3421/3423、3451/3453、3478/3480、3511/3513）。 */
export interface GoalManagerLike {
  readonly storage: GoalStorageLike;
  list_goals(): readonly unknown[];
  create_goal(description: string, brief: unknown): GoalObjectLike;
  set_brief(goal_id: string, brief: unknown): ResultLike;
  delete_goal(goal_id: string): ResultLike;
}

/** `get_goal_scheduler()`（源 3427/3448/3457/3348/3409）——pause 是 async，enqueue 是 sync。 */
export interface GoalSchedulerLike {
  pause(goal_id: string): Promise<ResultLike>;
  enqueue(goal_id: string): ResultLike;
}

/** `goal_manager.GoalStatus` 的**本段用到的**五个成员（源 3338–3339/3346/3357/3384；它们是普通类属性字符串）。 */
export interface GoalStatusClass {
  readonly ACTIVE: string;
  readonly STARTED: string;
  readonly PAUSED: string;
  readonly COMPLETED: string;
  readonly CANCELLED: string;
}

/** `goal_scheduler.RUNNING` / `goal_scheduler.QUEUED`（源 119–120 别名到 GoalStatus 的同名字符串）。 */
export interface SchedulerStates {
  readonly RUNNING: string;
  readonly QUEUED: string;
}

/** `storage.get_storage()` 的本段消费面（源 3534/3552/3561/3754/3782）。 */
export interface AppStorageLike {
  get_bot_state(key: string, dflt: unknown): unknown;
  save_bot_state(key: string, value: unknown): void;
}

export interface ReflectionStoreLike {
  retrieve_reflections(opts: { query: string; limit: number }): readonly unknown[];
}
export interface CurriculumEngineLike {
  identify_skill_gaps(): readonly unknown[];
}
export interface SkillComposerLike {
  mine_patterns(): readonly unknown[];
}

/** `workflow_scheduler.get_workflow_scheduler()`（源 3607/3629/3645）。 */
export interface WorkflowSchedulerLike {
  list_schedules(opts: { enabled_only: boolean }): readonly unknown[];
  create_schedule(opts: {
    workflow_id: string;
    cron_expr: string;
    session_id: string;
    require_promoted: unknown;
  }): ResultLike;
  delete_schedule(schedule_id: string): ResultLike;
}

/** `cron_manager.get_cron_manager()`（源 3656/3663/3699/3716）——注意 create 的**双份** task_name（位置 title + 关键字 task_name）。 */
export interface CronManagerLike {
  list_crons(): readonly unknown[];
  create(args: {
    title: string;
    prompt: unknown;
    cron_expr: string | null;
    delay_minutes: unknown;
    max_runs: unknown;
    task_name: string;
    task_data: unknown;
    session_id: unknown;
  }): ResultLike;
  create_cron(expression: unknown, task_name: unknown, task_data: unknown): ToDictLike;
  pause_cron(cron_id: string): ResultLike;
  resume_cron(cron_id: string): ResultLike;
  stop_cron(cron_id: string): ResultLike;
  delete_cron(cron_id: string): ResultLike;
}

/** `bot_remote.get_bot_remote()`（源 3726）。 */
export interface BotRemoteLike {
  get_recent_messages(platform: unknown, user_id: unknown): readonly unknown[];
}

/** provider 的两个入口（feishu/dingtalk 用 headers 版，wecom 用 query 版；都是同一个 seam 面）。 */
export interface BotProviderLike {
  handle_webhook?(payload: Uint8Array, arg: JsonDict): Promise<unknown>;
  verify_url?(query: JsonDict): unknown;
}

/** `bot_remote.get_bot_controller()`（源 3735/3751/3770/3796/3803/3822/3847）。 */
export interface BotControllerLike {
  send_message(platform: unknown, user_id: unknown, content: unknown): Promise<ResultLike>;
  provider_status(): readonly unknown[];
  get_provider(platform: string): BotProviderLike | null;
}

export interface HttpS4Seams {
  /** 源 3262 等 `from goal_manager import get_goal_manager`。 */
  goal_manager_get(): GoalManagerLike;
  /** 源 3323 `from goal_manager import GoalStatus`（本段用到 5 个成员）。 */
  goal_status_class(): GoalStatusClass;
  /** 源 3324 `from goal_scheduler import RUNNING, QUEUED`。 */
  goal_scheduler_states(): SchedulerStates;
  /** 源 3263/3276/… `from goal_scheduler import goal_view`。 */
  goal_view(row: unknown): unknown;
  /** 源 3276 `from goal_scheduler import DEFAULT_MAX_ITERATIONS`（模块常量，端口不写死）。 */
  goal_scheduler_default_max_iterations(): number;
  /** 源 3276 `from goal_scheduler import DEFAULT_COST_CAP_MICROS`。 */
  goal_scheduler_default_cost_cap_micros(): number;
  /** 源 3427/3448/3457/3348/3409 `get_goal_scheduler()`；未运行源里抛 RuntimeError，未接线端口抛 ModuleNotFound。 */
  goal_scheduler_get(): GoalSchedulerLike;
  /** 源 3386–3387 `from event_bus import get_event_bus` + `await emit(topic, payload)`。 */
  event_bus_emit(topic: string, payload: JsonDict): Promise<void>;
  /** 源 3531/3552/3561/3752/3779 `from storage import get_storage`。 */
  storage_get(): AppStorageLike;
  /** 源 3532/3535 `from acceptance_contract import get_goal_contract`。 */
  acceptance_contract_get(storage: unknown, goal_id: string): unknown;
  /** 源 3541/3542 `from reflection_engine import get_reflection_store`。 */
  reflection_store_get(): ReflectionStoreLike;
  /** 源 3551/3553 `from curriculum_engine import CurriculumEngine` + `CurriculumEngine(get_storage())`。 */
  curriculum_engine_ctor(storage: unknown): CurriculumEngineLike;
  /** 源 3560/3562 `from skill_composition import SkillComposer` + `SkillComposer(get_storage())`。 */
  skill_composer_ctor(storage: unknown): SkillComposerLike;
  /** 源 3585/3588 `from evolution_undo import undo` + `undo(workspace_root=…, proposal_id=…)`。 */
  evolution_undo_undo(opts: { workspace_root: unknown; proposal_id: string | null }): ResultLike;
  /** 源 3596/3599 `from evolution_undo import list_undo` + `list_undo(ws)`。 */
  evolution_undo_list_undo(workspace_root: unknown): readonly unknown[];
  /** 源 3607/3629/3645 `from workflow_scheduler import get_workflow_scheduler`。 */
  workflow_scheduler_get(): WorkflowSchedulerLike;
  /** 源 3656/3663/3699/3716 `from cron_manager import get_cron_manager`。 */
  cron_manager_get(): CronManagerLike;
  /** 源 3726 `from bot_remote import get_bot_remote`。 */
  bot_remote_get(): BotRemoteLike;
  /** 源 3735/3751/3770/3796/3803/3822/3847 `from bot_remote import get_bot_controller`。 */
  bot_controller_get(): BotControllerLike;
  /** 源 3574 `os.environ.get("OVOLVE_WORKSPACE")`（缺键 → "" → 假值 → 走 getcwd，与 python `or` 同结论）。 */
  environ_get(name: string, fallback?: string): string;
  /** 源 3574 `os.getcwd()`。 */
  getcwd(): string;
  /** 源 3393 `print(f"[api] goal_state_change emit failed: {exc}")`——print 是本段唯一的旁路面。 */
  print_sink(line: string): void;
}

/** 源里每个函数级 import 的模块名（缺省臂的文案来源；探针可逐模块驱动 ModuleNotFound）。 */
const MOD = {
  goal_manager: "goal_manager",
  goal_scheduler: "goal_scheduler",
  event_bus: "event_bus",
  storage: "storage",
  acceptance_contract: "acceptance_contract",
  reflection_engine: "reflection_engine",
  curriculum_engine: "curriculum_engine",
  skill_composition: "skill_composition",
  evolution_undo: "evolution_undo",
  workflow_scheduler: "workflow_scheduler",
  cron_manager: "cron_manager",
  bot_remote: "bot_remote",
} as const;

function module_not_found(name: string): ModuleNotFoundErrorP {
  return new ModuleNotFoundErrorP(name);
}

/**
 * 缺省 = 未接线 = 什么都不许悄悄成功：
 *  - 模块面：抛 CPython 的 ModuleNotFoundError（源里那些**不在 try** 的函数级 import 会直接冒出 handler；
 *    源里在 try 里的那些（3386、3813/3831/3862）被同一个 except 吞成降级响应/500——**逐点姿势不统一，端口也不统一**）。
 *  - 时钟/目录：`getcwd` 抛（源 3574 的 or 链第二支就是它，缺件时绝不能返回一个像样的工作区）。
 *  - `environ_get` 读 `process.env`（S0 util.ts 同规则；探针必须逐用例钉死，因为它是 `_resolve_request_workspace` 的第一支）。
 *  - `print_sink` 抛：源里 print 只在 except 臂里出现，未接线时让它响，而不是静默全绿。
 */
export const HTTP_S4_SEAMS: HttpS4Seams = {
  goal_manager_get(): GoalManagerLike {
    throw module_not_found(MOD.goal_manager);
  },
  goal_status_class(): GoalStatusClass {
    throw module_not_found(MOD.goal_manager);
  },
  goal_scheduler_states(): SchedulerStates {
    throw module_not_found(MOD.goal_scheduler);
  },
  goal_view(row: unknown): unknown {
    void row;
    throw module_not_found(MOD.goal_scheduler);
  },
  goal_scheduler_default_max_iterations(): number {
    throw module_not_found(MOD.goal_scheduler);
  },
  goal_scheduler_default_cost_cap_micros(): number {
    throw module_not_found(MOD.goal_scheduler);
  },
  goal_scheduler_get(): GoalSchedulerLike {
    throw module_not_found(MOD.goal_scheduler);
  },
  async event_bus_emit(_topic: string, _payload: JsonDict): Promise<void> {
    throw module_not_found(MOD.event_bus);
  },
  storage_get(): AppStorageLike {
    throw module_not_found(MOD.storage);
  },
  acceptance_contract_get(_storage: unknown, _goal_id: string): unknown {
    throw module_not_found(MOD.acceptance_contract);
  },
  reflection_store_get(): ReflectionStoreLike {
    throw module_not_found(MOD.reflection_engine);
  },
  curriculum_engine_ctor(_storage: unknown): CurriculumEngineLike {
    throw module_not_found(MOD.curriculum_engine);
  },
  skill_composer_ctor(_storage: unknown): SkillComposerLike {
    throw module_not_found(MOD.skill_composition);
  },
  evolution_undo_undo(_opts: { workspace_root: unknown; proposal_id: string | null }): ResultLike {
    throw module_not_found(MOD.evolution_undo);
  },
  evolution_undo_list_undo(_workspace_root: unknown): readonly unknown[] {
    throw module_not_found(MOD.evolution_undo);
  },
  workflow_scheduler_get(): WorkflowSchedulerLike {
    throw module_not_found(MOD.workflow_scheduler);
  },
  cron_manager_get(): CronManagerLike {
    throw module_not_found(MOD.cron_manager);
  },
  bot_remote_get(): BotRemoteLike {
    throw module_not_found(MOD.bot_remote);
  },
  bot_controller_get(): BotControllerLike {
    throw module_not_found(MOD.bot_remote);
  },
  environ_get(name: string, fallback = ""): string {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    const v = env[name];
    return v === undefined ? fallback : v;
  },
  getcwd(): string {
    throw new PyRuntimeErrorP("S4 seam getcwd() is not wired (fail closed)");
  },
  print_sink(line: string): void {
    void line;
    throw new PyRuntimeErrorP("S4 seam print_sink is not wired (fail closed)");
  },
};

/** 本段全部接缝名（S10/探针核对"少接一臂"用；顺序 = 接口字段名字典序，与源行号无关）。 */
export const HTTP_S4_SEAM_KEYS: readonly string[] = Object.keys(HTTP_S4_SEAMS).sort();

/* ──────────────────────────────────────────────────────────────────────────
 * §3 goals CRUD（源 3261–3467）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/goals（源 3261–3271）。
 * 两只函数级 import 都**不在 try**（3262/3263）⇒ 未接线冒出 handler。
 * 过滤在 `goal_view` **之前**（3267–3270 的 list comp 顺序：先 `if` 再 `goal_view(g)`）——
 * 一个 cancelled 的目标**不会**被 goal_view 看过一眼，端口同样不调。
 * `g.get("status")`：行是 dict；假件给非 dict 行 → AttributeError 冒出（端口 py_dict_get 抛同类）。
 */
export async function handle_goals(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  void request;
  const manager = seams.goal_manager_get();
  const goals: unknown[] = [];
  for (const g of py_iter_list(manager.list_goals())) {
    if (py_dict_get(g, "status") !== "cancelled") {
      goals.push(seams.goal_view(g));
    }
  }
  return json_response({ goals });
}

/**
 * POST /api/goals（源 3274–3312）。
 * `data = await request.json()` 是 **BARE**（3279，B4/S0 NOTES）：异常冒出 handler，端口不兜。
 * 顺序即语义：404 前置检查没有——**先**解析 body、**先**判 description（3280–3282），
 * 再 `create_goal`（3285），再预算种子（3294–3309），再 `update_goal_fields`（3309），
 * 最后**重新读一次**行（3311）再 view。
 * S4-B14/S4-B15：`costCapUsd: 0` 走 else 支（用全局默认帽），且 `is not None` 与取值是两次 `.get`。
 */
export async function handle_create_goal(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const manager = seams.goal_manager_get();
  const storage = manager.storage;
  const data: unknown = await request.json();                        // BARE（3279）
  const description = py_strip(py_str(py_or(py_dict_get(data, "description"), "")));
  if (!py_truth(description)) {
    return json_response({ error: "description required" }, 400);
  }
  const goal = manager.create_goal(description, py_dict_get(data, "brief"));

  const updates: JsonDict = {};
  if (py_dict_get(data, "maxIterations") !== null) {                 // `is not None`（3295）
    let max_iter: number;
    try {
      max_iter = py_int(py_dict_get(data, "maxIterations"));         // 第二次 .get（S4-B15）
    } catch (exc) {
      if (!catches_classes(exc, TYPE_OR_VALUE_ERROR)) throw exc;
      max_iter = seams.goal_scheduler_default_max_iterations();
    }
    updates["max_iterations"] = Math.max(1, Math.min(max_iter, 50));
  }
  if (py_dict_get(data, "costCapUsd") !== null) {                    // `is not None`（3301）
    let cap_usd: number;
    try {
      cap_usd = py_float(py_or(py_dict_get(data, "costCapUsd"), 0)); // `or 0` 在 float() 之前（3303）
    } catch (exc) {
      if (!catches_classes(exc, TYPE_OR_VALUE_ERROR)) throw exc;
      cap_usd = 0;
    }
    const cap_micros = cap_usd > 0
      ? py_int(cap_usd * 1_000_000)
      : seams.goal_scheduler_default_cost_cap_micros();
    updates["cost_cap_micros"] = Math.max(1, Math.min(cap_micros, seams.goal_scheduler_default_cost_cap_micros()));
  }
  if (py_truth(Object.keys(updates).length)) {                       // `if updates:`
    storage.update_goal_fields(py_getattr(goal, "id") as string, updates); // goal.id 裸属性（3309）
  }
  const row = storage.get_goal(py_getattr(goal, "id") as string);    // **第二次** 读 goal.id（3311）
  return json_response(seams.goal_view(row));
}

/**
 * PATCH /api/goals/{id}（源 3315–3394）——本段最大的一只，**行序即语义**：
 *   1. 404 预检在 body 解析**之前**（3328–3330）：坏 id + 坏 JSON ⇒ 404，不是 BARE 逃逸。
 *   2. `data = await request.json()` BARE（3332）。
 *   3. status 支（3335–3360）：白名单 → PAUSED+RUNNING/QUEUED 走调度器（409 / RuntimeError 兜底直写），
 *      否则写 updates["status"]，COMPLETED 顺带清 last_error。
 *   4. maxIterations 支（3362–3366）：`except (TypeError, ValueError): pass`（fail-open）。
 *   5. brief 支（3368–3375）：**走 manager.set_brief**，不 ok 直接 400 早退（此时 updates 里的
 *      status/maxIterations **还没写盘**——早退顺序是源事实）。
 *   6. updates 非空才 update（3377–3378），随后终态事件（3383–3393）**在同一个 if 里**。
 *   7. 返回值是**重新读**的行（3394）。
 * S4-B2：只有 PAUSED 一支通知调度器；S4-B3：调度器成功暂停时 updates 为空 ⇒ 不发事件。
 */
export async function handle_update_goal(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const manager = seams.goal_manager_get();
  const storage = manager.storage;
  const goal_id = request.match_info.get("id", "");
  const row = storage.get_goal(goal_id);
  if (row === null) {
    return json_response({ error: "Goal not found" }, 404);
  }

  const data: unknown = await request.json();                        // BARE（3332）
  const updates: JsonDict = {};
  const gs = seams.goal_status_class();
  const states = seams.goal_scheduler_states();

  if (py_contains(data, "status")) {
    const status = py_str(py_or(py_dict_get(data, "status"), ""));
    const allowed = new Set<string>([gs.ACTIVE, gs.STARTED, gs.PAUSED, gs.COMPLETED, gs.CANCELLED]);
    if (!allowed.has(status)) {
      return json_response(
        { error: `Invalid status: ${status}`, allowed: py_sorted_strings(allowed) },
        400,
      );
    }
    const row_status = py_dict_get(row, "status");
    if (status === gs.PAUSED && (row_status === states.RUNNING || row_status === states.QUEUED)) {
      try {
        const pr = await seams.goal_scheduler_get().pause(goal_id);
        if (!py_truth(pr.ok)) {
          return json_response({ error: pr.error }, 409);
        }
      } catch (exc) {
        if (!catches_classes(exc, RUNTIME_ERROR)) throw exc;
        storage.update_goal_fields(goal_id, { status: gs.PAUSED });
      }
    } else {
      updates["status"] = status;
      if (status === gs.COMPLETED) {
        updates["last_error"] = "";
      }
    }
  }

  if (py_contains(data, "maxIterations")) {
    try {
      updates["max_iterations"] = Math.max(1, Math.min(py_int(py_dict_index(data, "maxIterations")), 50));
    } catch (exc) {
      if (!catches_classes(exc, TYPE_OR_VALUE_ERROR)) throw exc;
      // pass —— fail-open（3365–3366），连日志都不留
    }
  }

  if (py_contains(data, "brief") && py_dict_index(data, "brief") !== null) {
    const r = manager.set_brief(goal_id, py_dict_index(data, "brief"));
    if (!py_truth(r.ok)) {
      return json_response({ error: r.error }, 400);
    }
  }

  if (py_truth(Object.keys(updates).length)) {
    storage.update_goal_fields(goal_id, updates);
    const new_status = py_str(py_or(py_dict_get(updates, "status"), ""));
    if (new_status === gs.CANCELLED || new_status === gs.COMPLETED) {
      try {
        await seams.event_bus_emit("goal_state_change", {
          goal_id: goal_id,
          status: new_status,
          session_id: py_dict_get(row, "session_id", ""),
          source: "user_update",
        });
      } catch (exc) {
        seams.print_sink(`[api] goal_state_change emit failed: ${exc_str(exc)}`);
      }
    }
  }
  return json_response(seams.goal_view(storage.get_goal(goal_id)));
}

/**
 * DELETE /api/goals/{id}（源 3398–3415）——软删 + 取消在飞的回合。
 * S4-B1：`pause()` 的 Result **整个丢弃**（3409），与 update_goal 的 `.ok` 判定不一致；
 * 只有 RuntimeError 被兜（3410–3411 `pass`）。
 */
export async function handle_delete_goal(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const manager = seams.goal_manager_get();
  const goal_id = request.match_info.get("id", "");
  const row = manager.storage.get_goal(goal_id);
  if (row === null) {
    return json_response({ error: "Goal not found" }, 404);
  }
  const states = seams.goal_scheduler_states();
  const row_status = py_dict_get(row, "status");
  if (row_status === states.RUNNING || row_status === states.QUEUED) {
    try {
      await seams.goal_scheduler_get().pause(goal_id);
    } catch (exc) {
      if (!catches_classes(exc, RUNTIME_ERROR)) throw exc;
      // pass —— fail-open（3410–3411）
    }
  }
  const result = manager.delete_goal(goal_id);
  if (!py_truth(result.ok)) {
    return json_response({ error: result.error }, 400);
  }
  return json_response({ ok: true, id: goal_id });
}

/**
 * POST /api/goals/{id}/run（源 3418–3439）。
 * S4-B9 的另一半：try **只**罩 `get_goal_scheduler()`（3426–3431），`enqueue` 在外面——
 * 所以 enqueue 抛的 RuntimeError **不**变成 503，而是冒出 handler。
 * `result = scheduler.enqueue(goal_id)` 是**同步**调用（源里没有 await）。
 */
export async function handle_run_goal(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const goal_id = request.match_info.get("id", "");
  const storage = seams.goal_manager_get().storage;
  if (storage.get_goal(goal_id) === null) {
    return json_response({ error: "Goal not found" }, 404);
  }
  let scheduler: GoalSchedulerLike;
  try {
    scheduler = seams.goal_scheduler_get();
  } catch (exc) {
    if (!catches_classes(exc, RUNTIME_ERROR)) throw exc;
    return json_response({ error: "Goal scheduler is not running on this server" }, 503);
  }
  const result = scheduler.enqueue(goal_id);
  if (!py_truth(result.ok)) {
    return json_response({ error: result.error }, 409);
  }
  return json_response({
    ok: true,
    queue: result.value,
    goal: seams.goal_view(storage.get_goal(goal_id)),
  });
}

/**
 * POST /api/goals/{id}/pause（源 3442–3467）。
 * try 罩住"取调度器 + 调用 pause"两步（S4-B9）：pause() 自己抛的 RuntimeError 也是 503。
 * 失败支的 body 带**重新读**的 status：`(storage.get_goal(...) or {}).get("status")`——
 * 这一支的 `or {}` 是源里明写的兜底（3465），端口两步都保留。
 */
export async function handle_pause_goal(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const goal_id = request.match_info.get("id", "");
  const storage = seams.goal_manager_get().storage;
  if (storage.get_goal(goal_id) === null) {
    return json_response({ error: "Goal not found" }, 404);
  }
  let result: ResultLike;
  try {
    result = await seams.goal_scheduler_get().pause(goal_id);
  } catch (exc) {
    if (!catches_classes(exc, RUNTIME_ERROR)) throw exc;
    return json_response({ error: "Goal scheduler is not running on this server" }, 503);
  }
  if (!py_truth(result.ok)) {
    return json_response({
      error: result.error,
      status: py_dict_get(py_or(storage.get_goal(goal_id), {}), "status"),
    }, 409);
  }
  return json_response({ ok: true, goal: seams.goal_view(storage.get_goal(goal_id)) });
}

/**
 * GET /api/goals/{id}/iterations（源 3470–3496）。八键映射，每键都是 `r.get(k) or 默认`——
 * 所以 `cost_micros: 0` 与 `None` 渲染结果相同（0），端口照抄这个"或默认"的形状，不区分 None/0。
 */
export async function handle_goal_iterations(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const goal_id = request.match_info.get("id", "");
  const storage = seams.goal_manager_get().storage;
  if (storage.get_goal(goal_id) === null) {
    return json_response({ error: "Goal not found" }, 404);
  }
  const rows = storage.list_goal_iterations(goal_id);
  const iterations = py_iter_list(rows).map((r) => ({
    ordinal: py_or(py_dict_get(r, "ordinal"), 0),
    startedAt: py_or(py_dict_get(r, "started_at"), 0),
    endedAt: py_or(py_dict_get(r, "ended_at"), 0),
    verdict: py_or(py_dict_get(r, "verdict"), ""),
    reason: py_or(py_dict_get(r, "verdict_reason"), ""),
    evidence: py_or(py_dict_get(r, "evidence_digest"), ""),
    costMicros: py_or(py_dict_get(r, "cost_micros"), 0),
    tokens: py_or(py_dict_get(r, "tokens"), 0),
  }));
  return json_response({ iterations });
}

/**
 * GET /api/goals/{id}/events（源 3499–3526）。
 * `verifiable: False` 是**故意的**（docstring 3507–3510：跨会话子集天然缺链，标 verified 是撒谎）。
 * S4-B4：`int(limit_str)`（3517）在 try **之外**，`?limit=abc` → ValueError 冒出 handler；
 * 而 try（3518–3521）只兜读盘，兜到就 500 `f"event query failed: {exc}"`。
 * `limit_str is not None`（3517）走的是 §DIVERGENCE 2 的单参 query 面。
 */
export async function handle_goal_events(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const goal_id = request.match_info.get("id", "");
  const storage = seams.goal_manager_get().storage;
  if (storage.get_goal(goal_id) === null) {
    return json_response({ error: "Goal not found" }, 404);
  }
  const limit_str = query_get_raw(request, "limit");
  const limit = limit_str !== null && limit_str !== undefined ? py_int(limit_str) : 500;
  let events: readonly ToDictLike[];
  try {
    events = storage.get_event_store().read_by_dimension("goal_id", goal_id, { limit });
  } catch (exc) {
    return json_response({ error: `event query failed: ${exc_str(exc)}` }, 500);
  }
  return json_response({
    goalId: goal_id,
    verifiable: false,
    events: py_call_to_dict(events),
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §4 契约 / 反思 / 课程 / 技能模式（源 3529–3564）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/goals/{id}/contract（源 3529–3536）。两只 import 都不在 try；
 * `get_goal_contract` 的返回可能是 None（源类型 `Dict|None`），端口原样塞进 body。
 */
export async function handle_goal_contract(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const gid = request.match_info.get("id", "");
  const st = seams.storage_get();
  const contract = seams.acceptance_contract_get(st, gid);
  return json_response({ goalId: gid, contract });
}

/**
 * GET /api/reflections（源 3539–3546）。
 * 3543/3544 用的是 `request.rel_url.query`（= 同一个 MultiDict，§DIVERGENCE 1）。
 * S4-B5：`int(... or 20)` 无兜底 ⇒ `?limit=abc` 的 ValueError 冒出 handler。
 */
export async function handle_reflections(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const store = seams.reflection_store_get();
  const query = request.query.get("q", "");
  const limit = py_int(py_or(request.query.get("limit", "20"), 20));
  const refs = store.retrieve_reflections({ query, limit });
  return json_response({ reflections: py_call_to_dict(py_iter_list(refs)) });
}

/** GET /api/curriculum/gaps（源 3549–3555）——**每请求现构造**引擎（`CurriculumEngine(get_storage())`）。 */
export async function handle_curriculum_gaps(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  void request;
  const engine = seams.curriculum_engine_ctor(seams.storage_get());
  const gaps = engine.identify_skill_gaps();
  return json_response({ gaps: py_call_to_dict(py_iter_list(gaps)) });
}

/** GET /api/skills/patterns（源 3558–3564）——同上，per-request 构造 composer。 */
export async function handle_skill_patterns(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  void request;
  const composer = seams.skill_composer_ctor(seams.storage_get());
  const patterns = composer.mine_patterns();
  return json_response({ patterns: py_call_to_dict(py_iter_list(patterns)) });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §5 工作区解析 + 进化回退（源 3567–3600）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 源 3567–3574 `_resolve_request_workspace`（**同步** def，全文件只被 3586/3597 调用）。
 * 三只臂：app 里的 router.workspace（**整段在 try 里**：`app.get` 缺键返回 null 不抛，
 * 但 `router.workspace` 裸属性可能 AttributeError → 被同一 except 吞）→ 环境变量
 * → `os.getcwd()`。注解写 `-> str` 但**没有任何转换**：router.workspace 是 Path 就还 Path，
 * 因此端口返回型是 `unknown`（python 的注解不是断言，端口不加 `str()` 也不加 `py_str`）。
 */
export function _resolve_request_workspace(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): unknown {
  try {
    const router = request.app.state.get(ROUTER_KEY);
    if (py_truth(router) && py_truth(py_getattr_or(router, "workspace", null))) {
      return py_getattr(router, "workspace");
    }
  } catch {
    // except Exception: pass（3572–3573）
  }
  return py_or(seams.environ_get("OVOLVE_WORKSPACE", ""), seams.getcwd());
}

/**
 * POST /api/evolution/undo（源 3577–3591）。
 * `body = {}` + `except Exception: pass`（3579–3583）= **坏 JSON 退化成 {}**（B4 的第二种姿势）。
 * 但 `body.get` 在 try **之外**（3584）：body 是 JSON 数组/字符串 → AttributeError 冒出 handler。
 * `from evolution_undo import undo` 在 3584 **之后**（3585）——import 失败时那句 .get 已经跑过了。
 * `proposal_id or None`（3588）：空串转 None，让下游按"最近一次"处理。
 */
export async function handle_evolution_undo(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // except Exception: pass（3582–3583）
  }
  const proposal_id = py_strip(py_str(py_or(py_dict_get(body, "proposal_id"), "")));
  const ws = _resolve_request_workspace(request, seams);
  const res = seams.evolution_undo_undo({ workspace_root: ws, proposal_id: py_truth(proposal_id) ? proposal_id : null });
  if (!py_truth(res.ok)) {
    return json_response({ ok: false, error: res.error }, 400);
  }
  return json_response({ ok: true, data: res.value });
}

/** GET /api/evolution/undo（源 3594–3600）——无 try，`list_undo` 自己吞异常（下游事实，不是本段）。 */
export async function handle_evolution_undo_list(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const ws = _resolve_request_workspace(request, seams);
  const entries = seams.evolution_undo_list_undo(ws);
  return json_response({ ok: true, snapshots: entries });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §6 工作流定时（源 3603–3650）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/workflows/schedules（源 3605–3611）。
 * `enabled_only`：`""→strip→lower` 后**元组成员**判定，只认 `"1"`/`"true"`（"yes"/"True " 之外都行不通）。
 * `count: len(schedules)`。
 */
export async function handle_workflow_schedules_list(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const scheduler = seams.workflow_scheduler_get();
  const enabled_only = ["1", "true"].includes(py_strip(request.query.get("enabled_only", "")).toLowerCase());
  const schedules = scheduler.list_schedules({ enabled_only });
  return json_response({ ok: true, schedules, count: py_len(schedules) });
}

/**
 * POST /api/workflows/schedules（源 3614–3639）。
 * **body 解析在 import 之前**（3616–3624 vs 3629）⇒ 校验不过时压根不碰调度器模块。
 * S4-B16：`require_promoted` 原样传（`body.get(key, True)`，无布尔化）。
 * 失败 → 400 `{ok:false,error}`；成功 → `{ok:true, schedule: res.value}`。
 */
export async function handle_workflow_schedule_create(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // except Exception: pass（3619–3620）
  }
  const workflow_id = py_strip(py_str(py_or(py_dict_get(body, "workflow_id"), "")));
  const cron_expr = py_strip(py_str(py_or(py_dict_get(body, "cron_expr"), "")));
  const session_id = py_strip(py_str(py_or(py_dict_get(body, "session_id"), "")));
  const require_promoted = py_dict_get(body, "require_promoted", true);

  if (!py_truth(workflow_id) || !py_truth(cron_expr)) {
    return json_response({ ok: false, error: "workflow_id and cron_expr are required" }, 400);
  }
  const scheduler = seams.workflow_scheduler_get();
  const res = scheduler.create_schedule({ workflow_id, cron_expr, session_id, require_promoted });
  if (!py_truth(res.ok)) {
    return json_response({ ok: false, error: res.error }, 400);
  }
  return json_response({ ok: true, schedule: res.value });
}

/**
 * DELETE /api/workflows/schedules/{id}（源 3642–3650）。
 * 失败是 **404**（create 才是 400）；`match_info.get("id","")` 与 `{platform}` 的方括号取值不同族。
 */
export async function handle_workflow_schedule_delete(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const schedule_id = request.match_info.get("id", "");
  const scheduler = seams.workflow_scheduler_get();
  const res = scheduler.delete_schedule(schedule_id);
  if (!py_truth(res.ok)) {
    return json_response({ ok: false, error: res.error }, 404);
  }
  return json_response({ ok: true, deleted: true, schedule_id });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §7 cron CRUD（源 3653–3720）
 * ──────────────────────────────────────────────────────────────────────── */

/** GET /api/crons（源 3655–3659）——无 try、无分页、原样吐 manager 的 list。 */
export async function handle_crons(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  void request;
  const manager = seams.cron_manager_get();
  const crons = manager.list_crons();
  return json_response({ crons });
}

/**
 * POST /api/crons（源 3662–3695）——一只 handler 两条**互斥**创建路径。
 * BARE json（3665）。取值顺序即语义（3666–3668）：camel 优先、snake 兜底、内层默认**先算**。
 * S4-B6：门槛只看 `delayMinutes`（camel），取值却兼容 `delay_minutes`。
 * `manager.create(task_name, prompt, ..., task_name=task_name, ...)` 在 python 里合法
 * （第一参数叫 `title`），端口把它折成一个 opts 对象、**同时**带上 title 与 task_name——
 * 这是源事实，不是笔误（cron_manager.py:197 的签名可证）。
 */
export async function handle_create_cron(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const manager = seams.cron_manager_get();
  const data: unknown = await request.json();                        // BARE（3665）
  const expression = py_dict_get(data, "expression", "");
  const task_name = py_dict_get(data, "taskName", py_dict_get(data, "task_name", ""));
  const task_data = py_dict_get(data, "taskData", py_dict_get(data, "task_data", {}));
  if (!py_truth(expression) && py_dict_get(data, "delayMinutes") === null) {
    return json_response({ error: "expression and taskName required" }, 400);
  }
  if (!py_truth(task_name)) {
    return json_response({ error: "expression and taskName required" }, 400);
  }
  const prompt = py_dict_get(data, "prompt");
  const session_id = py_dict_get(data, "sessionId", py_dict_get(data, "session_id"));
  const delay_minutes = py_dict_get(data, "delayMinutes", py_dict_get(data, "delay_minutes"));
  const max_runs = py_dict_get(data, "maxRuns", py_dict_get(data, "max_runs"));
  if (py_truth(prompt) || py_truth(session_id) || delay_minutes !== null) {
    const r = manager.create({
      title: task_name as string,
      prompt,
      cron_expr: py_truth(expression) ? (expression as string) : null,
      delay_minutes,
      max_runs,
      task_name: task_name as string,
      task_data,
      session_id,
    });
    if (!py_truth(r.ok)) {
      return json_response({ error: r.error }, 400);
    }
    return json_response(r.value);
  }
  const job = manager.create_cron(expression, task_name, task_data);
  return json_response(py_call_to_dict([job])[0]);
}

/**
 * PATCH /api/crons/{id}（源 3698–3712）——三态 + else 400。
 * S4-B7：`pause_cron/resume_cron/stop_cron` 的 Result **全部丢弃**，失败也回 200，
 * 且 body 里的 status 是**请求值**而不是回读值。BARE json（3702）。
 */
export async function handle_update_cron(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const manager = seams.cron_manager_get();
  const cron_id = request.match_info.get("id", "");
  const data: unknown = await request.json();                        // BARE（3702）
  const status = py_dict_get(data, "status", "");
  if (status === "paused") {
    manager.pause_cron(cron_id);
  } else if (status === "active") {
    manager.resume_cron(cron_id);
  } else if (status === "stopped") {
    manager.stop_cron(cron_id);
  } else {
    return json_response({ error: "Invalid status" }, 400);
  }
  return json_response({ id: cron_id, status });
}

/** DELETE /api/crons/{id}（源 3715–3720）——S4-B8：返回值丢弃，幂等假象。 */
export async function handle_delete_cron(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const manager = seams.cron_manager_get();
  const cron_id = request.match_info.get("id", "");
  manager.delete_cron(cron_id);
  return json_response({ deleted: cron_id });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §8 bot（源 3723–3798）
 * ──────────────────────────────────────────────────────────────────────── */

/** GET /api/bot/messages（源 3725–3731）——query 面，两个默认值 "telegram"/"default"。 */
export async function handle_bot_messages(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const bot = seams.bot_remote_get();
  const platform = request.query.get("platform", "telegram");
  const user_id = request.query.get("user_id", "default");
  const messages = bot.get_recent_messages(platform, user_id);
  return json_response({ messages });
}

/**
 * POST /api/bot/send（源 3734–3746）——注意用的是 `get_bot_controller`，
 * 而 messages 那支用 `get_bot_remote`（两个不同单例工厂，源事实）。
 * BARE json（3737）。成功 `{"success": True, "message": value}`，失败 **500**（不是 400）。
 */
export async function handle_bot_send(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const ctrl = seams.bot_controller_get();
  const data: unknown = await request.json();                        // BARE（3737）
  const platform = py_dict_get(data, "platform", "telegram");
  const user_id = py_dict_get(data, "userId", py_dict_get(data, "user_id", "default"));
  const content = py_dict_get(data, "content", "");
  if (!py_truth(content)) {
    return json_response({ error: "content required" }, 400);
  }
  const result = await ctrl.send_message(platform, user_id, content);
  if (py_truth(result.ok)) {
    return json_response({ success: true, message: result.value });
  }
  return json_response({ error: result.error }, 500);
}

/** 源 3759–3763 的 secret 键集合（11 个成员；`webhook` 在列的理由见 docstring 3756–3758：URL 本身就是凭据）。 */
const SECRET_KEYS: ReadonlySet<string> = new Set<string>([
  "bot_token", "app_token", "app_secret", "client_secret", "secret",
  "encrypt_key", "encoding_aes_key", "callback_token", "webhook_key",
  "webhook", "verification_token",
]);

/**
 * GET /api/bot/config/{platform}（源 3749–3773）。
 * `match_info["platform"]` 是**方括号**取值（源 3753；keys.ts 登记的五处之一）⇒ 缺键 KeyError。
 * 掩码规则：`k in secret_keys and isinstance(v, str) and len(v) > 4` → `"•"*(len-4) + v[-4:]`
 * （S4-B10：len/尾巴都按**码点**，见 §DIVERGENCE 3）。
 * `plat_status = next((s for s in status if s["platform"] == platform), None)`：
 *   ① `s["platform"]` 是**下标**（缺键 KeyError、非 dict TypeError）；
 *   ② `next` 惰性求值 ⇒ **命中即停**，后面那些坏元素根本不会被读——端口的循环同样 break，
 *     这是探针可观察的差别（列表里第一个就命中、第二个是字符串 → 不抛）。
 */
export async function handle_bot_config_get(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const platform = request.match_info.index("platform");
  const storage = seams.storage_get();
  const state = py_or(storage.get_bot_state(`${platform}:config`, {}), {});
  const safe: JsonDict = {};
  for (const [k, v] of py_dict_items(state)) {
    if (SECRET_KEYS.has(k) && py_isinstance_str(v) && py_len(v) > 4) {
      safe[k] = py_repeat("•", py_len(v) - 4) + py_tail(v, 4);
    } else {
      safe[k] = v;
    }
  }
  const ctrl = seams.bot_controller_get();
  const status = ctrl.provider_status();
  let plat_status: unknown = null;
  let found = false;
  for (const s of py_iter_list(status)) {
    if (py_dict_index(s, "platform") === platform) {
      plat_status = s;
      found = true;
      break;
    }
  }
  void found;
  return json_response({ platform, config: safe, status: plat_status });
}

/**
 * PUT /api/bot/config/{platform}（源 3776–3791）。
 * 同样是方括号 `match_info["platform"]`（3780）+ **BARE json**（3781）。
 * 合并语义：**就地 mutate** `get_bot_state` 返回的那个 dict 再存回去。
 * S4-B11：以 `•` 开头的字符串一律跳过 ⇒ 真值以 `•` 开头的 secret 写不进去。
 */
export async function handle_bot_config_put(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const platform = request.match_info.index("platform");
  const data: unknown = await request.json();                        // BARE（3781）
  const storage = seams.storage_get();
  const existing = py_or(storage.get_bot_state(`${platform}:config`, {}), {});
  for (const [k, v] of py_dict_items(data)) {
    if (py_isinstance_str(v) && py_startswith(v, "•")) {
      continue;
    }
    py_dict_setitem(existing, k, v);
  }
  storage.save_bot_state(`${platform}:config`, existing);
  return json_response({ ok: true, platform });
}

/** GET /api/bot/status（源 3794–3798）——`provider_status()` 原样进 body，不掩码（掩码只在 config GET）。 */
export async function handle_bot_status(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  void request;
  const ctrl = seams.bot_controller_get();
  return json_response({ platforms: ctrl.provider_status() });
}

/* ──────────────────────────────────────────────────────────────────────────
 * §9 IM webhook（源 3801–3864）
 * ──────────────────────────────────────────────────────────────────────── */

/** provider 的方法取值：缺方法 → `TypeError: 'NoneType' object is not callable` / AttributeError。 */
function provider_method(provider: BotProviderLike, name: "handle_webhook" | "verify_url"): Function {
  const fn = py_getattr(provider, name);
  if (typeof fn !== "function") {
    throw new PyTypeErrorP(`TypeError: '${py_type_name(fn)}' object is not callable`);
  }
  return fn as Function;
}

/** `{k.lower(): v for k, v in request.headers.items()}`（源 3812/3830 两处同形；§DIVERGENCE 5）。 */
function lowercased_headers(request: WebRequest): JsonDict {
  return py_dict_from_pairs(request.headers.items().map(([k, v]) => [k.toLowerCase(), v] as [string, unknown]));
}

/**
 * POST /api/bot/webhook/feishu（源 3801–3817）。
 * 未注册 → **JSON 面**的 `{"code": 503, "msg": ...}` + status 503（与 wecom 的 text 面不同，见 S4-B12）。
 * `body = await request.read()` **不在 try**（3808）⇒ 读失败冒出 handler。
 * try 只罩 `provider.handle_webhook`（3813–3816）⇒ except Exception → `{"code":500,"msg":str(exc)}` 500。
 */
export async function handle_feishu_webhook(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const ctrl = seams.bot_controller_get();
  const provider = ctrl.get_provider("feishu");
  if (provider === null) {
    return json_response({ code: 503, msg: "feishu provider not registered" }, 503);
  }
  const body = await request.read();
  const headers = lowercased_headers(request);
  try {
    const result = await (provider_method(provider, "handle_webhook").call(provider, body, headers) as Promise<unknown>);
    return json_response(result);
  } catch (exc) {
    return json_response({ code: 500, msg: exc_str(exc) }, 500);
  }
}

/**
 * POST /api/bot/webhook/dingtalk（源 3820–3835）——与 feishu 同构，只有两处字面差：
 * 取 provider 写在**一行**里（`get_bot_controller().get_provider(...)`）、键名是 errcode/errmsg。
 */
export async function handle_dingtalk_webhook(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const provider = seams.bot_controller_get().get_provider("dingtalk");
  if (provider === null) {
    return json_response({ errcode: 503, errmsg: "dingtalk provider not registered" }, 503);
  }
  const body = await request.read();
  const headers = lowercased_headers(request);
  try {
    const result = await (provider_method(provider, "handle_webhook").call(provider, body, headers) as Promise<unknown>);
    return json_response(result);
  } catch (exc) {
    return json_response({ errcode: 500, errmsg: exc_str(exc) }, 500);
  }
}

/**
 * GET|POST /api/bot/webhook/wecom（源 3838–3864）——**一个 handler 两条注册**（#34/#35），
 * 内部按 `request.method` 分叉（3853）。S0 NOTES B8 的落点，逐字保留四条：
 *   · provider 未注册 → `web.Response(status=503, text=...)`：**text 面、没有 content_type**。
 *   · `query = dict(request.query)`（3851，全文件唯一一处）在分叉**之前**，GET/POST 都要。
 *   · GET 握手：`verify_url` 是**同步**调用；空/None → `status=403, text="verification failed"`；
 *     成功 → `web.Response(text=echo, content_type="text/plain")`，**不写 status** ⇒ 200。
 *     GET 支**从不** `request.read()`。
 *   · POST：`body = await request.read()` 在 try **之外**；try 只罩 `handle_webhook`，
 *     except → `Response(status=500, text=str(exc))`（异常原文进正文）；
 *     成功 → `text=reply or ""`（None/空串都塌成空 body）+ text/plain。
 */
export async function handle_wecom_webhook(
  request: WebRequest,
  seams: HttpS4Seams = HTTP_S4_SEAMS,
): Promise<WebResponse> {
  const provider = seams.bot_controller_get().get_provider("wecom");
  if (provider === null) {
    return text_response({ status: 503, text: "wecom provider not registered" });
  }
  const query = request.query.toDict();

  if (request.method === "GET") {
    const echo = provider_method(provider, "verify_url").call(provider, query) as unknown;
    if (!py_truth(echo)) {
      return text_response({ status: 403, text: "verification failed" });
    }
    return text_response({ text: py_str(echo), contentType: "text/plain" });
  }

  const body = await request.read();
  try {
    const reply = await (provider_method(provider, "handle_webhook").call(provider, body, query) as Promise<unknown>);
    return text_response({ text: py_truth(reply) ? py_str(reply) : "", contentType: "text/plain" });
  } catch (exc) {
    return text_response({ status: 500, text: exc_str(exc) });
  }
}

// PORT STATUS: 本文件无 TODO(port)。
