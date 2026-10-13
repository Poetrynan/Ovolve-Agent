/**
 * failure_taxonomy.ts — Provider 失败分类学（Phase 9 首切片）。
 *
 * Ported from `app/backend/failure_taxonomy.py` (142 lines).
 *
 * 总指令 §12：失败分类必须可恢复，每类的重试/fallback 策略不同，且"不得
 * 为了成功率隐瞒昂贵重试或把失败变成假成功"。分类只看证据（错误文本/状态
 * 码/异常类型），不猜意图。
 *
 * RULEBOOK CITATIONS
 *   §1/§M 镜像单源律：CPython 面语义（真值/str/repr/类型名/TypeError 文案）
 *        一律 import `./server/http_server_keys.js`，不开私有镜像副本；
 *        本文件独有的 `_py_round2`（round(x,2) 半偶回真实二进制值）经 grep
 *        确认 §M 无 `py_round` 导出，故留本地并注明。
 *   §2  Python re 转换：`re.I` → `i` flag；`{0,12}` / `\b` 语义一致；
 *        **`.` 差异已修**：Python `.` 只排除 `\n`（包含 `\r`、`\u2028`、
 *        `\u2029`），JS `.` 还排除行/段分隔符 ⇒ 端口全部改用 `[^\n]`。
 *   §2  dataclass(frozen) → readonly interface + as const 表。
 *   §2  `getattr(error, "message", "")` → 仅对引擎 seam 对象（非 dict 脸、
 *        带 message 属性）生效；dict/list 在 CPython 里**没有** message
 *        属性，走 `str(error)` repr 脸（见 DIVERGENCE 1）。
 *   §4  naming: failure_taxonomy.py → failure_taxonomy.ts
 *
 * DIVERGENCE（端口曾与源真实分歧，全部以 CPython 现场打印为证修复端口；
 * 证据文件：`tmp/failtx_oracle_facts.json`（re-run: `python -B
 * tmp/failtx_oracle_py.py`，见 `tmp/failtx_STATE.md`））
 *   1) dict/list 错误脸：源 `str(getattr(error,"message","") or error or "")`
 *      对 dict **从不读 message 键**，取的是 repr 脸文本
 *      （`{'detail': 'invalid tool'}` → invalid_tool；
 *      `{'message':'ok','code':429}` → rate_limit 走的是 repr 里的 "429"）。
 *      旧端口把对象强转成 `[object Object]`/读 message 键 ⇒ 分类错位。
 *      脸：er#*、ertxt#*、pr#10-11。
 *   2) 状态码查表是 dict 语义：`"429" in code_map` 为假（键是 int）⇒ 落到
 *      文本臂；`429.0 in code_map` 为真（== 且同哈希）；list/dict 码抛
 *      `TypeError: unhashable type: 'list'/'dict'`。旧端口用 JS 属性访问，
 *      字符串 "429" 也命中。脸：st#19、st#22-23、st#29-30。
 *   3) `RETRY_POLICY.get` / `explain` 查表：源只认自有键，`"constructor"`、
 *      `"toString"`、`"__proto__"`、`"hasOwnProperty"` 全部走默认档；旧端口
 *      `??` 链在 JS 上会命中原型成员。脸：pol#12-15、exp#11-13；未哈希脸
 *      （list/dict 作 cls）抛 TypeError。
 *   4) `round(x, 2)` 是**半偶舍入且按真实二进制值**：0.125→0.12、
 *      0.625→0.62、-0.004→-0.0（保负零）；旧端口 `Math.round(…*100)/100`
 *      是半进位 ⇒ 平局档错位（如 rate_limit attempt -4 应得 0.12 非 0.13）。
 *      脸：rnd#*、bak#*#负索引网格。
 *   5) `attempt >= p.max_retries` 比较门在 `max_retries == 0` 短路**之后**：
 *      quota/context/auth/policy 对任意 attempt 脸（str/None/list/dict）都
 *      先回 0.0 不抛；可重试类遇 str/None/list/dict 抛
 *      `TypeError: '>=' not supported between instances of 'str' and 'int'`；
 *      bool attempt 按 int 脸（True≙1、False≙0）；nan 透传 nan；
 *      inf/-inf/1e6/-1e6 → 0.0（2**-1000000 下溢为 0.0）。
 *      脸：cmp# 系列、bak#rate_limit# 与 bak#network# 负索引网格。
 *   6) `policy_for_failure` 先 `str(failure_code or "")` 再查表：
 *      `['quota']`/`{'a':1}` 不抛（str 脸 `"['quota']"` 无键 ⇒ unknown）。
 *      脸：pf#*。
 *   7) PROVIDER 无文本模式：'provider exploded internally' 等 → unknown；
 *      分类按 _PATTERNS **行序**不按文本位置（'network ECONNRESET invalid
 *      tool' → invalid_tool）。脸：pt#63、pt#68-70。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { py_truth, py_str, py_type_name, PyTypeErrorP } from "./server/http_server_keys.js";

export const QUOTA = "quota";
export const RATE_LIMIT = "rate_limit";
export const CONTEXT_OVERFLOW = "context_overflow";
export const AUTH = "auth";
export const INVALID_TOOL = "invalid_tool";
export const NETWORK = "network";
export const PROVIDER = "provider";
export const POLICY = "policy";
export const UNKNOWN = "unknown";

const _CLASSES = [
  QUOTA, RATE_LIMIT, CONTEXT_OVERFLOW, AUTH, INVALID_TOOL,
  NETWORK, PROVIDER, POLICY, UNKNOWN,
] as const;
export type FailureClass = (typeof _CLASSES)[number];
void _CLASSES;

interface PatternRow {
  cls: string;
  rx: RegExp;
}

// `.` 在 Python 里只排除 `\n`（见头部 DIVERGENCE §2 引用），JS 侧用 `[^\n]` 对齐。
const _PATTERNS: PatternRow[] = [
  {
    cls: CONTEXT_OVERFLOW,
    rx: /context[^\n]{0,12}(length|window|overflow)|maximum context|too many tokens|prompt is too long|max_tokens[^\n]*exceed/i,
  },
  { cls: RATE_LIMIT, rx: /\b429\b|rate[^\n]?limit|too many requests|TPD|RPM/i },
  {
    cls: QUOTA,
    rx: /\b402\b|quota|billing|insufficient[^\n]*(balance|credit)|exceeded[^\n]*budget/i,
  },
  { cls: AUTH, rx: /\b401\b|\b403\b|unauthorized|invalid api key|authentication/i },
  { cls: POLICY, rx: /\b451\b|content[^\n]?policy|safety system|blocked by policy/i },
  {
    cls: INVALID_TOOL,
    rx: /invalid tool|no such tool|tool_use_failed|schema validation/i,
  },
  {
    cls: NETWORK,
    rx: /ECONNRESET|ETIMEDOUT|ECONNREFUSED|getaddrinfo|network|connection (reset|refused|timed out)/i,
  },
];

export interface RetryPolicy {
  readonly max_retries: number; // 0 = 不重试
  readonly backoff_base_s: number; // 指数退避基数：base * 2^attempt
  readonly allow_fallback: boolean; // 允许切换到 fallback group 里的其他 provider
}

/** §12 失败分类 → 可恢复策略。policy/auth 不重试是纪律不是懒惰。 */
export const RETRY_POLICY: Readonly<Record<string, RetryPolicy>> = Object.freeze({
  [QUOTA]: Object.freeze({ max_retries: 0, backoff_base_s: 0.0, allow_fallback: false }),
  [RATE_LIMIT]: Object.freeze({ max_retries: 3, backoff_base_s: 2.0, allow_fallback: true }),
  [CONTEXT_OVERFLOW]: Object.freeze({ max_retries: 0, backoff_base_s: 0.0, allow_fallback: true }), // 走 compaction / 大窗模型
  [AUTH]: Object.freeze({ max_retries: 0, backoff_base_s: 0.0, allow_fallback: false }),
  [INVALID_TOOL]: Object.freeze({ max_retries: 1, backoff_base_s: 0.5, allow_fallback: false }), // 修正 schema/参数，限一次
  [NETWORK]: Object.freeze({ max_retries: 3, backoff_base_s: 1.0, allow_fallback: true }),
  [PROVIDER]: Object.freeze({ max_retries: 1, backoff_base_s: 1.0, allow_fallback: true }),
  [POLICY]: Object.freeze({ max_retries: 0, backoff_base_s: 0.0, allow_fallback: false }),
  [UNKNOWN]: Object.freeze({ max_retries: 1, backoff_base_s: 1.0, allow_fallback: false }),
});

const _STATUS_CODE_MAP: Readonly<Record<number, string>> = Object.freeze({
  429: RATE_LIMIT,
  401: AUTH,
  402: QUOTA,
  403: AUTH,
  404: PROVIDER,
  413: CONTEXT_OVERFLOW,
  451: POLICY,
  500: PROVIDER,
  502: PROVIDER,
  503: PROVIDER,
  529: PROVIDER,
});

// ── CPython dict 语义小工具（面语义来自 §M，单源律）────────────────────
// dict/list 脸：CPython 里不可哈希，`x in code_map` / `.get(...)` 抛
// TypeError: unhashable type: 'list'/'dict'。
function _is_dictish(v: unknown): boolean {
  if (Array.isArray(v)) return true;
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

function _unhashable(key: unknown): never {
  throw new PyTypeErrorP(`unhashable type: '${py_type_name(key)}'`);
}

/** `key in code_map`（int 键表）：仅 int 脸可能命中；429.0==429 命中；
 *  NaN/Infinity/小数/str/bool/None 皆假；list/dict 抛 TypeError。 */
function _code_lookup(map: Readonly<Record<number, string>>, key: unknown): string | undefined {
  if (_is_dictish(key)) _unhashable(key);
  if (typeof key === "number" && Number.isInteger(key)) {
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(map, k) ? map[key] : undefined;
  }
  return undefined;
}

/** `table.get(key, miss)`（str 键表）：非字符串键在源表里必无键；
 *  只认自有属性，原型成员（constructor/__proto__/…）走 miss。 */
function _map_get<T>(table: Readonly<Record<string, T>>, key: unknown, miss: T): T {
  if (_is_dictish(key)) _unhashable(key);
  if (typeof key !== "string") return miss;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : miss;
}

/** `attempt >= p.max_retries` 的 CPython 比较门：str/None/list/dict 抛
 *  TypeError（bool/int/float 脸按数值比）。 */
function _ge_gate(attempt: unknown, max_retries: number): void {
  if (typeof attempt === "number" || typeof attempt === "boolean") return;
  throw new PyTypeErrorP(
    `'>=' not supported between instances of '${py_type_name(attempt)}' and 'int'`,
  );
}

/**
 * CPython `round(x, 2)`：半偶舍入，且按 double 的**真实二进制值**判定
 * 平局（0.125 恰为二进制 ⇒ 0.12；0.575 真实值略大于 57.5 ⇒ 0.58）。
 * §M 无 py_round 导出（grep 证实），故本地实现并注明。
 * 算法：把 x 拆成 mant * 2^e（精确整数 mant），x*100 = mant*25 * 2^(e+2)，
 * e+2<0 时用 BigInt 做 q/rem 的半偶除法；|x| 在本模块量级内 Number(n) 精确。
 */
function _py_round2(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  const neg = x < 0 || Object.is(x, -0);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x), true);
  const bits = dv.getBigUint64(0, true);
  // IEEE-754 布局：bit63 符号 | bits62..52 指数 | bits51..0 尾数（低位）。
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e: number;
  if (exp === 0) {
    e = -1074; // 次正规：无隐含 1
  } else {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  let num = mant * 25n; // x*100 的分子
  e += 2;
  let n: bigint;
  if (e >= 0) {
    n = num << BigInt(e); // 整值，无舍入
  } else {
    const shift = -e;
    const q = num >> BigInt(shift);
    const rem = num & ((1n << BigInt(shift)) - 1n);
    const half = 1n << BigInt(shift - 1);
    n = rem > half || (rem === half && (q & 1n) === 1n) ? q + 1n : q;
  }
  const r = Number(n) / 100;
  return neg ? -r : r;
}

/** 从状态码或错误文本判类。状态码优先——它是结构化证据。 */
export function classify(error: unknown, status_code?: number | null): string {
  if (status_code !== null && status_code !== undefined) {
    const mapped = _code_lookup(_STATUS_CODE_MAP, status_code);
    if (mapped !== undefined) {
      return mapped;
    }
  }
  let text = "";
  if (typeof error === "object" && error !== null && !_is_dictish(error)) {
    // 引擎 seam：非 dict/list 脸的对象（Error 实例）保留 message 属性臂。
    if ("message" in error) {
      text = String((error as Record<string, unknown>)["message"] ?? "");
    }
    if (!text) {
      text = String(error);
    }
  } else if (py_truth(error)) {
    // 源臂：str(getattr(error, "message", "") or error or "")——
    // dict/list/原始值的 getattr 都取不到 message，真值链落到 str(error)。
    text = py_str(error);
  }
  if (!text) {
    return UNKNOWN;
  }
  for (const { cls, rx } of _PATTERNS) {
    if (rx.test(text)) {
      return cls;
    }
  }
  return UNKNOWN;
}

export function policy_for(cls: string): RetryPolicy {
  return _map_get(RETRY_POLICY, cls, RETRY_POLICY[UNKNOWN]!);
}

// ── llm_errors 适配层（§20：发现同类模块先复用加 adapter，不建第二套）────
// llm_errors 的语义码是权威分类源；本表把它映射到 §12 重试策略。
const _LLMErrors_POLICY_MAP: Readonly<Record<string, string>> = Object.freeze({
  quota: QUOTA,
  rate_limit: RATE_LIMIT,
  context_overflow: CONTEXT_OVERFLOW,
  auth: AUTH,
  model_not_found: INVALID_TOOL, // 配置错误：重试无益
  bad_request: INVALID_TOOL,
  server: PROVIDER,
  timeout: NETWORK,
  transport: NETWORK,
  empty_response: UNKNOWN, // 200 空响应：保守重试一次
  cancelled: POLICY, // 我们自己停的：零重试语义
  unknown: UNKNOWN,
});

/** llm_errors 的语义码 → §12 重试策略。未知码走最保守档。 */
export function policy_for_failure(failure_code: unknown): RetryPolicy {
  // 源：`_LLMErrors_POLICY_MAP.get(str(failure_code or ""), UNKNOWN)`——
  // 先走真值链再 str()，list/dict 脸被 str 成文本、不抛（DIVERGENCE 6）。
  const keytext = py_str(py_truth(failure_code) ? failure_code : "");
  const cls = _map_get(_LLMErrors_POLICY_MAP, keytext, UNKNOWN);
  return _map_get(RETRY_POLICY, cls, RETRY_POLICY[UNKNOWN]!);
}

/** 第 attempt 次（0 起）重试前的等待秒数。不可重试类返回 0。 */
export function backoff_delay(cls: string, attempt: number): number {
  const p = policy_for(cls);
  if (p.max_retries === 0) {
    return 0.0;
  }
  _ge_gate(attempt, p.max_retries);
  if (attempt >= p.max_retries) {
    return 0.0;
  }
  return _py_round2(p.backoff_base_s * (2 ** attempt));
}

/** 同 backoff_delay，但接受 llm_errors 的语义码（经适配表）。
 *
 * llm_client 手里的分类是 "server"/"timeout"/"transport"/"empty_response"
 * 这类适配层码——直接喂给 backoff_delay 会落进 UNKNOWN 档，用错退避基数。 */
export function backoff_delay_for_failure(failure_code: unknown, attempt: number): number {
  const p = policy_for_failure(failure_code);
  if (p.max_retries === 0) {
    return 0.0;
  }
  _ge_gate(attempt, p.max_retries);
  if (attempt >= p.max_retries) {
    return 0.0;
  }
  return _py_round2(p.backoff_base_s * (2 ** attempt));
}

/** 给 UI/日志的一句话处置说明。 */
export function explain(cls: unknown): string {
  const table: Readonly<Record<string, string>> = {
    [QUOTA]: "预算/额度用尽：告警或等待充值，不无限重试",
    [RATE_LIMIT]: "限流：有界退避，必要时切 fallback provider",
    [CONTEXT_OVERFLOW]: "上下文超窗：先压缩或换大窗口模型",
    [AUTH]: "凭证无效：停止并提示用户，绝不循环重试",
    [INVALID_TOOL]: "工具调用不合法：修正 schema/参数，最多重试一次",
    [NETWORK]: "网络故障：有界重试并保留 checkpoint",
    [PROVIDER]: "provider 内部错误：有限重试后 fallback 并记录",
    [POLICY]: "被策略拦截：不重试，进入审批/拒绝路径",
    [UNKNOWN]: "未归类失败：保守重试一次并保留完整现场",
  };
  return _map_get(table, cls, "未归类失败");
}
