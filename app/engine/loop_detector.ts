/**
 * loop_detector.ts — 工具调用循环检测与熔断。
 *
 * Ported from `app/backend/loop_detector.py` (501 lines, unit 166, wave 7).
 *
 * 主循环给模型 8 步预算，但从不检查这 8 步有没有在原地打转。本模块是
 * tool-call 粒度的循环检测：六个检测器按严重度从高到低短路（unknown_tool_repeat
 * → global_circuit_breaker → known_poll_no_progress → no_progress → ping_pong →
 * generic_repeat），两档处置（warning 拼回工具结果 / critical 直接拦住不执行）。
 * 唯一的生产构造点：`router.py:342-344`
 * `LoopDetector(LoopConfig.from_config(cfg))`，生命周期与一个用户回合绑定。
 *
 * SEAM INVENTORY (host touches — 源码逐行核对的宿主触点清单)
 *   源文件模块级 import 只有标准库：enum / hashlib / json / re /
 *   collections.deque / dataclasses / typing。全模块没有 time、uuid、random、
 *   storage、os、print、文件、网络、子进程——它是纯计算模块，没有任何
 *   动态宿主能力缝。因此：
 *   - hashlib.md5      → node:crypto createHash("md5")，确定性等价（非宿主能力）。
 *   - re._VOLATILE_RE  → 文件内手写扫描器（python 的 \b 是 Unicode 词类、\d 是
 *                        Unicode 十进制数字、[0-9a-f] 是 ASCII——语义见 §20），
 *                        词类表取 py_unidata.ts（活动解释器逐码点扫出的 \w）。
 *   - json.dumps(...)  → 文件内 pyJsonDumpsSortKeys（sort_keys / ensure_ascii=False /
 *                        default=str / allow_nan 全语义，见 §19）。
 *   - python 的模块级全局名 `args_signature` / `result_signature` 是运行期可
 *     替换（monkeypatch）的调用面——内部调用点全部经 LOOP_DETECTOR_SEAMS 走，
 *     探针逐场景换装记账，与 python 侧替换模块属性一一对应。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/loop_detector.py -> app/engine/loop_detector.ts。
 *       Public python spellings verbatim: LoopPattern, LoopTripResult, Verdict,
 *       MAX_SIGNATURE_CHARS, args_signature, result_signature, KNOWN_POLL_TOOLS,
 *       LoopConfig, LoopDetector, _OK（下划线私有同样保名）。
 *   §2  exception identity: TypeError/ValueError/AttributeError/OverflowError/
 *       UnicodeEncodeError/FrozenInstanceError 以 .name + str(exc) 逐字存活
 *       （缺参/超参文案含 self、单复数、was/were、from N to M、牛津逗号并列）。
 *   §2  `except (TypeError, ValueError)`（args_signature 的 json 兜底）保持
 *       窄捕获——只有 pyJsonDumps 的 TypeErrorP/ValueErrorP 会落进 str(args) 臂。
 *   §2  python truthiness 处处保真：`tool or "?"`、`if ok:`、`if not text:`、
 *       `if not self.config.enabled:`、`bool(is_poll)`、`_threshold_repeat or ...`。
 *   §2  python 长度是码点：key[:400] / norm[:400] / error_class[:100] 全走
 *       码点切片（非 BMP 一个字符算一）。
 *   §2  dataclass：字段顺序 = vars() 顺序（探针按此投影）；frozen 的 setattr
 *       抛 FrozenInstanceError；replace() 经 __init__ 造新实例；不造 __repr__/
 *       __eq__（grep 证明模块内无人打印/比较它）。
 *   §2  str,Enum（LoopPattern）：CPython 3.13 成员按值 == 字符串、json 序列化
 *       为值——见 DIVERGENCE(port, enum identity)。
 *   §2  deque(maxlen=...)：append 满员时左侧挤出，索引是位置性的——observe 的
 *       旧索引在挤出后命中移位后的元素（python 行为，bug-for-bug）。
 *
 * QUIRKS PINNED BY THE PARITY PROBE（编号 §1..§23，证据场景见 verified/loop_detector.json）
 *   §1  _OK 是共享的模块级单例：所有"放行"的 check 返回同一个对象（is 身份被
 *       探针钉住），而 Verdict 是可变 dataclass。
 *   §2  config.enabled 关闭时 check 在算签名**之前**返回 _OK——零次 seam 调用
 *       （账本为空）。
 *   §3  record_call 的重复闸用 `self._threshold_repeat or ...`（真值判定！）
 *       ——threshold_repeat=0 落回已校验的 warning_threshold；真值字符串 "4"
 *       则原样进入 `>=` → TypeError(int, str)。
 *   §4  record_call 的乒乓闸用 `is not None`（不是真值！）：threshold_oscillation=0
 *       → pp_threshold=0 → **第一次调用就**以 streak=0 触发 PING_PONG。
 *   §5  不可哈希 tool 的 TypeError 触发点：record 先查 KNOWN_POLL_TOOLS 成员再算
 *       签名（账本无 args_signature）；check 先算签名再查（账本有 1 条）。
 *   §6  `[]`/`{}` 对 frozenset 成员判定抛 TypeError "unhashable type: 'list'/
 *       'dict'"，但**set** 落进 CPython set-contains 的 frozenset 包装回退——
 *       `set() in KNOWN_POLL_TOOLS` 返回 False 而不是抛错。
 *   §7  record 存 `tool or "?"`，而 _unknown_tool_streak 拿**原始** tool 比较：
 *       check("", ...) 永远看不见存进历史里的 "?"——空名工具对 unknown 连击
 *       不可见，消息里渲染的仍是原始假值 str()。
 *   §8  observe 按位置回写 result_sig：maxlen 挤出后旧索引命中**移位后**的条目
 *       （python deque 语义原样保留），越界/负索引静默忽略。
 *   §9  record_blocked 继承同签名最近一次的结果签名（全局熔断的输血通道），
 *       且**不**递减 guard_steps；record 递减。
 *   §10 _no_progress_streak 对"其他签名"与"空结果签名"是 continue（透明跳过）
 *       而不是 break——所谓连续段其实是"带透明洞的尾段"。
 *   §11 _ping_pong_streak 把**尚未入历史的当前调用**算作第 0 步、要求从尾起严格
 *       A,B,A,B… 交替；历史里全是 current_sig 时返回 0（那是 no_progress 的地盘）。
 *   §12 折叠后的收紧 `crit = max(2, min(crit, warning))` 只作用于
 *       known_poll_no_progress / no_progress 两档——全局熔断与 unknown 闸不受影响。
 *   §13 post_compaction_guard ≤0 归 0，否则抬到 max(warning_threshold, guard)
 *       ——比警告阈值小的 guard 会被抬高。
 *   §14 record_outcome 的 `if ok:` 是真值判定：ok=0/"" 走**失败**臂；
 *       error_class 先 `or "error"` 再 strip 再 [:100]，所以 "  " 变成 ""。
 *   §15 threshold_failure_streak **从不** int()：字符串原样进 `>=` → TypeError；
 *       熔断消息的 last_tool 取历史尾（空历史则 "unknown"）。
 *   §16 validated() 对除 enabled 外的每个字段 int()（enabled 只在 from_config
 *       被 bool()）：LoopConfig(enabled="False").validated() 原样保留 "False"
 *       （真值），直接构造**不会**自动校验（LoopConfig(0,…) 字段就是 0）。
 *   §17 from_config 的 `or {}` 链：cfg=0/"x"/None 分别落到默认或 AttributeError
 *       'get'；loop_detection=0（假值）静默回默认。
 *   §18 int() 全语义面："1_0"→10、"1__0"/"_1"/"1_"→ValueError、"0x10"/"7.0"/""
 *       →ValueError（文案回显原始实参）、" 7\n"/"\xa07"→7（isspace 剥白）、
 *       "١٢٣"→123 / "１２"→12（Unicode Nd 码点逐位取值）、True→1、5.9→5、
 *       NaN→ValueError、±inf→OverflowError、None/dict→TypeError。
 *   §19 json.dumps(sort_keys=True, ensure_ascii=False, default=str)：非串键在
 *       **原键排序**之后才字符串化（int/bool/None/float 键各自成型；混型键
 *       TypeError 的两个类型名顺序跟随插入序）；tuple→数组；NaN/Infinity 字面量；
 *       不可序列化值经 default=str；循环引用 → ValueError "Circular reference
 *       detected" → 兜底 str(args) 把递归容器渲染成 [...]/{...}。
 *   §20 易变片段正则的语义：\d 是 Unicode Nd（"١٢٣"→"#"），[0-9a-f] 是 ASCII；
 *       六进制臂两端都要 \b——"deadbeefx" 存活、"abc123" 整段死、"0xabc" 只死
 *       "0"、"g0x123456" 因前邻词字符而整臂失效；0x 前缀可选贪心带回溯；
 *       IGNORECASE 在 lower() 之后只剩 ASCII 大写等价（本类无 i/s/K 折叠_extra）。
 *   §21 result_signature：`if not text` 是真值判定（[]/0/{} → ""），真值非串 →
 *       AttributeError 'lower'；空白是 python isspace 类（\x1c/\x85/\xa0 算、
 *       \ufeff/\u200b 不算）；" ".join(split()) 之后才 [:400]（码点）。
 *   §22 dataclass 构造的 arity 文案：LoopTripResult 缺 4 参带牛津逗号、超参报
 *       "from 5 to 6 ... but 7 were given"（计 self）、关键字限位报 "takes 3
 *       positional arguments but 5 were given"。
 *   §23 frozen dataclass 的 setattr 对任意属性名抛 FrozenInstanceError
 *       "cannot assign to field 'x'"（含不存在的属性）。
 *
 * MIGRATION DECISIONS / DIVERGENCES（已论证的处置）
 *   DIVERGENCE(port, enum identity): LoopPattern 成员是普通字符串常量（值与
 *       python 成员 json/== 全等）。python 专有的 str(member) →
 *       "LoopPattern.IDENTICAL_CALL" 与 LoopPattern("x") 反查不可复现——本模块
 *       与消费方从不 str() 它（grep 证明），tool_policy.ts 同款裁定。
 *   DIVERGENCE(port, number repr): JS number 无法标注 5 与 5.0——args 里整值
 *       float 渲染成 int 样式；本模块**产出**值全是 int/str（签名、计数、消息），
 *       无需 PyFloatBox；探针语料避开整值 float（repr 只在相等比较里可观察）。
 *   DIVERGENCE(port, big int): 超过 2^53 的 int 在到达本模块之前已经历宿主
 *       JSON→number 的精度损失（上游边界），其签名摘要与 python 分歧——记录，
 *       不钉（生产 tool args 由模型 JSON 给出）。
 *   DIVERGENCE(port, int() exotic): ValueError 文案回显原始实参；"空白+垃圾"
 *       组合（如 "\xa07x"）的文案取决于 CPython 先做的 decimal/space→ASCII
 *       变换，探针只钉无空白组合；long- digit 溢出 2^53 的任意精度不在本模块
 *       的实际值域（阈值量级）。
 *   DIVERGENCE(port, default=str on instances): 类实例落 default=str 时 python
 *       渲染 '<X object at 0x…>'（含地址，跨运行不可复现，探针不可钉）；端口
 *       按自有字段 dict 样渲染。探针语料用 int-only set 覆盖 default=str 臂。
 *   DIVERGENCE(port, lower()): JS toLowerCase 与 python str.lower() 在语料全
 *       集（含 İ/K/U+212A、词尾 σ）一致；ſ 与 s 的 full-casefold 折叠差异不可
 *       达——易变片段的字符类是 ASCII hex 与 Nd，均不含这两个折叠对象。
 *
 * 本文件无待移植项；端口状态行在文件末行。
 */

import { createHash } from "node:crypto";

import { PY_WORD_CLASS } from "./py_unidata.js";

// ── python-semantics helpers（house style: file-local）───────────────────────

type JsonDict = Record<string, unknown>;

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}
class ValueErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}
class OverflowErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "OverflowError";
    }
}
class UnicodeEncodeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "UnicodeEncodeError";
    }
}
class FrozenInstanceErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "FrozenInstanceError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (v instanceof Uint8Array) return "bytearray";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate（memory_layer 形状）：python dict 形状的值。 */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (v instanceof Uint8Array || v instanceof Error || v instanceof Map ||
        v instanceof Set) {
        return false;
    }
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (isPyDict(v)) return Object.keys(v as JsonDict).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python 缺参/超参 TypeError 文案（含 self 计数、牛津逗号、was/were）。 */
function pyMissing(fname: string, names: readonly string[]): TypeErrorP {
    const q = names.map((s) => `'${s}'`);
    const list = q.length === 1
        ? (q[0] as string)
        : q.length === 2
            ? `${q[0]} and ${q[1]}`
            : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
    const plural = names.length === 1 ? "positional argument" : "positional arguments";
    return new TypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

function pyTooMany(fname: string, takes: string, given: number): TypeErrorP {
    const noun = takes === "1" ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** python 字符串 `<`——码点字典序，短者居前。 */
function pyStrCmp(a: string, b: string): number {
    const A = Array.from(a);
    const B = Array.from(b);
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
        const ca = (A[i] as string).codePointAt(0) as number;
        const cb = (B[i] as string).codePointAt(0) as number;
        if (ca !== cb) return ca < cb ? -1 : 1;
    }
    return A.length === B.length ? 0 : A.length < B.length ? -1 : 1;
}

/** sorted() 的 `<` 比较：str/num/bool；混型抛 binop 身份（方向保真）。 */
function pyLess(a: unknown, b: unknown): boolean {
    const aNum = typeof a === "number" || typeof a === "boolean";
    const bNum = typeof b === "number" || typeof b === "boolean";
    if (typeof a === "string" && typeof b === "string") return pyStrCmp(a, b) < 0;
    if (aNum && bNum) return Number(a) < Number(b);
    throw new TypeErrorP(
        `'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

/** CPython list.sort 的二分插入（比较序列决定 TypeError 里类型的先后）。 */
function pySortedCopy(items: unknown[]): unknown[] {
    const a = items.slice();
    for (let i = 1; i < a.length; i++) {
        const pivot = a[i];
        let left = 0;
        let right = i;
        while (left < right) {
            const mid = (left + right) >> 1;
            if (pyLess(pivot, a[mid])) right = mid;
            else left = mid + 1;
        }
        for (let j = i; j > left; j--) a[j] = a[j - 1];
        a[left] = pivot;
    }
    return a;
}

/** python len(str)——码点数。 */
function pyLen(s: string): number {
    let n = 0;
    for (const _c of s) n++;
    return n;
}

/** python str[:n]——码点切片。 */
function pySliceCodePoints(s: string, n: number): string {
    if (pyLen(s) <= n) return s;
    return Array.from(s).slice(0, n).join("");
}

/** python str.strip()/split() 的 isspace 白类（\ufeff、\u200b 不是空白）。 */
const PY_WS_CLASS = "\\t\\n\\v\\f\\r\\x1c-\\x1f\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_WS_RE = new RegExp("[" + PY_WS_CLASS + "]");

function pyStrip(s: string): string {
    let start = 0;
    const cps = Array.from(s);
    while (start < cps.length && PY_WS_RE.test(cps[start] as string)) start++;
    let end = cps.length;
    while (end > start && PY_WS_RE.test(cps[end - 1] as string)) end--;
    return cps.slice(start, end).join("");
}

/** python str.split() 无参：按 isspace 白类的游程切分，无空串。 */
function pySplitWs(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    for (const ch of s) {
        if (PY_WS_RE.test(ch)) {
            if (cur) {
                out.push(cur);
                cur = "";
            }
        } else {
            cur += ch;
        }
    }
    if (cur) out.push(cur);
    return out;
}

/** python float repr（json.dumps 与 str() 共用的最短往返 + 指数规则）。 */
function pyFloatRepr(n: number): string {
    if (Number.isNaN(n)) return "nan";
    if (n === Infinity) return "inf";
    if (n === -Infinity) return "-inf";
    if (Object.is(n, -0)) return "-0.0";
    if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n) + ".0";
    const neg = n < 0;
    const abs = neg ? -n : n;
    const parts = abs.toExponential().split("e");
    let mant = parts[0] as string;
    const X = parseInt(parts[1] as string, 10);
    let digits = mant.replace(".", "");
    while (digits.length > 1 && digits.endsWith("0")) digits = digits.slice(0, -1);
    let body: string;
    if (X >= 16 || X <= -5) {
        const dd = digits.length > 1 ? digits.slice(0, 1) + "." + digits.slice(1) : digits;
        const esign = X < 0 ? "-" : "+";
        const eabs = String(Math.abs(X)).padStart(2, "0");
        body = dd + "e" + esign + eabs;
    } else if (X >= 0) {
        const intPart = (digits + "0".repeat(Math.max(0, X + 1 - digits.length))).slice(0, X + 1);
        const frac = digits.slice(X + 1);
        body = frac ? intPart + "." + frac : intPart + ".0";
    } else {
        body = "0." + "0".repeat(-X - 1) + digits;
    }
    return (neg ? "-" : "") + body;
}

/** python str(number)——str() 语境（nan/inf 小写、json 用大写字面量另渲染）。 */
function pyStrNum(n: number): string {
    if (Number.isNaN(n)) return "nan";
    if (n === Infinity) return "inf";
    if (n === -Infinity) return "-inf";
    if (Object.is(n, -0)) return "-0.0";
    if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
    return pyFloatRepr(n);
}

/** json.dumps 的 number 渲染（allow_nan 字面量）。 */
function pyJsonNum(n: number): string {
    if (Number.isNaN(n)) return "NaN";
    if (n === Infinity) return "Infinity";
    if (n === -Infinity) return "-Infinity";
    if (Object.is(n, -0)) return "-0.0";
    if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
    return pyFloatRepr(n);
}

function pyRepr(v: unknown, ancestors?: Set<object>): string {
    const anc = ancestors ?? new Set<object>();
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    if (typeof v === "number") return pyStrNum(v);
    return pyStr(v, anc);
}

/** python str(x)（容器走 repr；递归容器渲染 [...]/ {...}）。 */
function pyStr(v: unknown, ancestors?: Set<object>): string {
    const anc = ancestors ?? new Set<object>();
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyStrNum(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
        if (anc.has(v)) return "[...]";
        anc.add(v);
        const s = "[" + v.map((x) => pyRepr(x, anc)).join(", ") + "]";
        anc.delete(v);
        return s;
    }
    if (v instanceof Set) {
        if (anc.has(v)) return "{...}";
        if (v.size === 0) return "set()"; // python repr(set()) 的专用形态
        anc.add(v);
        const s = "{" + Array.from(v).map((x) => pyRepr(x, anc)).join(", ") + "}";
        anc.delete(v);
        return s;
    }
    if (v instanceof Map) {
        if (anc.has(v)) return "{...}";
        anc.add(v);
        const s = "{" + Array.from(v).map(([k, x]) => pyRepr(k, anc) + ": " + pyRepr(x, anc)).join(", ") + "}";
        anc.delete(v);
        return s;
    }
    if (typeof v === "object") {
        const o = v as JsonDict;
        if (anc.has(o)) return "{...}";
        anc.add(o);
        const s = "{" + Object.keys(o).map((k) => pyRepr(k, anc) + ": " + pyRepr(o[k], anc)).join(", ") + "}";
        anc.delete(o);
        return s;
    }
    return String(v);
}

// ── Unicode Nd 数字表（int() 与 \d 共用；由活动 CPython 3.13.12 逐码点扫出，
//    采集脚本 tmp/ld_truth2.py；\d == Nd，严格子集于 str.isdigit()）──────────

const PY_ND_RANGES: [number, number][] = [
    [48, 57], [1632, 1641], [1776, 1785], [1984, 1993], [2406, 2415],
    [2534, 2543], [2662, 2671], [2790, 2799], [2918, 2927], [3046, 3055],
    [3174, 3183], [3302, 3311], [3430, 3439], [3558, 3567], [3664, 3673],
    [3792, 3801], [3872, 3881], [4160, 4169], [4240, 4249], [6112, 6121],
    [6160, 6169], [6470, 6479], [6608, 6617], [6784, 6793], [6800, 6809],
    [6992, 7001], [7088, 7097], [7232, 7241], [7248, 7257], [42528, 42537],
    [43216, 43225], [43264, 43273], [43472, 43481], [43504, 43513],
    [43600, 43609], [44016, 44025], [65296, 65305], [66720, 66729],
    [68912, 68921], [69734, 69743], [69872, 69881], [69942, 69951],
    [70096, 70105], [70384, 70393], [70736, 70745], [70864, 70873],
    [71248, 71257], [71360, 71369], [71472, 71481], [71904, 71913],
    [72016, 72025], [72784, 72793], [73040, 73049], [73120, 73129],
    [73552, 73561], [92768, 92777], [92864, 92873], [93008, 93017],
    [120782, 120831], [123200, 123209], [123632, 123641], [124144, 124153],
    [125264, 125273], [130032, 130041],
];

/** Nd 码点的十进制位值（每段 10 连续码点 0-9），非 Nd 返回 -1。 */
function pyNdDigit(cp: number): number {
    let lo = 0;
    let hi = PY_ND_RANGES.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = PY_ND_RANGES[mid] as [number, number];
        if (cp < r[0]) hi = mid - 1;
        else if (cp > r[1]) lo = mid + 1;
        else return cp - r[0];
    }
    return -1;
}

/** python int(x)——完整语义面（见文件头 §18）。 */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) {
            throw new ValueErrorP("cannot convert float NaN to integer");
        }
        if (v === Infinity || v === -Infinity) {
            throw new OverflowErrorP("cannot convert float infinity to integer");
        }
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const t = pyStrip(v);
        let i = 0;
        let sign = 1;
        if (t.startsWith("+")) i = 1;
        else if (t.startsWith("-")) {
            sign = -1;
            i = 1;
        }
        const cps = Array.from(t.slice(i));
        let val = 0;
        let sawDigit = false;
        let prevUnderscore = true; // 首位前视同"下划线不可在此"
        for (const ch of cps) {
            const cp = ch.codePointAt(0) as number;
            const d = pyNdDigit(cp);
            if (d >= 0) {
                val = val * 10 + d;
                sawDigit = true;
                prevUnderscore = false;
                continue;
            }
            if (cp === 0x5f && sawDigit && !prevUnderscore) {
                prevUnderscore = true;
                continue;
            }
            throw new ValueErrorP(`invalid literal for int() with base 10: '${v}'`);
        }
        if (!sawDigit || prevUnderscore) {
            throw new ValueErrorP(`invalid literal for int() with base 10: '${v}'`);
        }
        return sign * val;
    }
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python `a >= b`：两侧 number/bool 数值比较，其余抛 binop 身份（方向保真）。 */
function pyGe(a: unknown, b: unknown): boolean {
    const aNum = typeof a === "number" || typeof a === "boolean";
    const bNum = typeof b === "number" || typeof b === "boolean";
    if (aNum && bNum) return Number(a) >= Number(b);
    throw new TypeErrorP(
        `'>=' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
}

// ── 易变片段扫描器（_VOLATILE_RE 的手写镜像，语义见文件头 §20）───────────────

/** PY_WORD_CLASS 是活动 CPython \w 的完整码点类（py_unidata.ts，u 旗标）。 */
const PY_WORD_RE = new RegExp(PY_WORD_CLASS, "u");

const VOLATILE_HEX_RUN_MIN = 6;

function isHexCp(cp: number): boolean {
    return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x46) ||
        (cp >= 0x61 && cp <= 0x66);
}

/** _VOLATILE_RE.sub("#", text) 的等价实现：\b(?:0x)?[0-9a-fA-F]{6,}\b|\d+，IGNORECASE。 */
function volatileSub(text: string): string {
    const cps = Array.from(text);
    const wordAt = (i: number): boolean =>
        i >= 0 && i < cps.length && PY_WORD_RE.test(cps[i] as string);
    const boundaryAt = (i: number): boolean => wordAt(i - 1) !== wordAt(i);
    const tryHexMatch = (i: number): number => {
        // (?:0x)? 贪心可选：先试吃掉 0x，失败回退不吃的分支
        for (const skip of [2, 0]) {
            if (skip === 2) {
                const c0 = (cps[i] as string).codePointAt(0) as number;
                const c1 = cps[i + 1] === undefined ? 0 : (cps[i + 1] as string).codePointAt(0) as number;
                if (c0 !== 0x30 || (c1 !== 0x78 && c1 !== 0x58)) continue;
            }
            let runEnd = i + skip;
            while (runEnd < cps.length && isHexCp((cps[runEnd] as string).codePointAt(0) as number)) {
                runEnd++;
            }
            for (let end = runEnd; end >= i + skip + VOLATILE_HEX_RUN_MIN; end--) {
                if (boundaryAt(end)) return end;
            }
        }
        return -1;
    };
    let out = "";
    let i = 0;
    while (i < cps.length) {
        const cp = (cps[i] as string).codePointAt(0) as number;
        if (isHexCp(cp) && boundaryAt(i)) {
            const end = tryHexMatch(i);
            if (end >= 0) {
                out += "#";
                i = end;
                continue;
            }
        }
        if (pyNdDigit(cp) >= 0) {
            let j = i;
            while (j < cps.length && pyNdDigit((cps[j] as string).codePointAt(0) as number) >= 0) j++;
            out += "#";
            i = j;
            continue;
        }
        out += cps[i] as string;
        i++;
    }
    return out;
}

// ── utf-8 编码（surrogate 臂）与 md5 ─────────────────────────────────────────

/** str.encode("utf-8")：孤立代理项抛 UnicodeEncodeError（position = 码点下标）。 */
function pyEncodeUtf8(s: string): Buffer {
    const cps = Array.from(s);
    for (let i = 0; i < cps.length; i++) {
        const cp = (cps[i] as string).codePointAt(0) as number;
        if (cp >= 0xd800 && cp <= 0xdfff) {
            throw new UnicodeEncodeErrorP(
                `'utf-8' codec can't encode character '\\u${cp.toString(16).padStart(4, "0")}' in position ${i}: surrogates not allowed`);
        }
    }
    return Buffer.from(s, "utf8");
}

function md5Hex(s: string): string {
    return createHash("md5").update(pyEncodeUtf8(s)).digest("hex");
}

// ── json.dumps(sort_keys=True, ensure_ascii=False, default=str) ──────────────

/** python json 的字符串转义：命名转义 + 其余 <0x20 小写 \u00XX；\u2028/\u2029 原样。 */
function pyJsonStr(s: string): string {
    let out = '"';
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (cp < 0x20) out += "\\u" + cp.toString(16).padStart(4, "0");
        else out += ch;
    }
    return out + '"';
}

/** json 键字符串化（排序在原键对象上做，转换在其后）。 */
function pyJsonKey(k: unknown): string {
    if (typeof k === "string") return k;
    if (k === null || k === undefined) return "null";
    if (typeof k === "boolean") return k ? "true" : "false";
    if (typeof k === "number") return pyJsonNum(k);
    throw new TypeErrorP(
        `keys must be str, int, float, bool or None, not ${pyTypeName(k)}`);
}

function pyJsonDumpsSortKeys(v: unknown, anc: Set<object>): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return pyJsonNum(v);
    if (typeof v === "string") return pyJsonStr(v);
    if (Array.isArray(v)) {
        if (anc.has(v)) throw new ValueErrorP("Circular reference detected");
        anc.add(v);
        const s = "[" + v.map((x) => pyJsonDumpsSortKeys(x, anc)).join(", ") + "]";
        anc.delete(v);
        return s;
    }
    if (v instanceof Set || typeof v === "function" || v instanceof Error ||
        v instanceof Uint8Array) {
        // default=str 臂（集合/函数/错误对象均不可 JSON 序列化）
        return pyJsonStr(pyStr(v));
    }
    if (v instanceof Map) {
        // python dict 的非串键形态（int/bool/None/float 键）——原键排序后转型
        if (anc.has(v)) throw new ValueErrorP("Circular reference detected");
        anc.add(v);
        const entries = Array.from(v.entries());
        const sorted = pySortedCopy(entries.map(([k]) => k)).map((k) =>
            (entries.find(([k2]) => k2 === k) as [unknown, unknown]));
        const s = "{" + sorted.map(([k, x]) =>
            pyJsonStr(pyJsonKey(k)) + ": " + pyJsonDumpsSortKeys(x, anc)).join(", ") + "}";
        anc.delete(v);
        return s;
    }
    if (typeof v === "object") {
        if (anc.has(v as object)) throw new ValueErrorP("Circular reference detected");
        anc.add(v as object);
        const o = v as JsonDict;
        const keys = pySortedCopy(Object.keys(o)) as string[];
        const s = "{" + keys.map((k) =>
            pyJsonStr(k) + ": " + pyJsonDumpsSortKeys(o[k], anc)).join(", ") + "}";
        anc.delete(v as object);
        return s;
    }
    return pyJsonStr(pyStr(v));
}

// ── 公共签名函数（源文件逐字对应）────────────────────────────────────────────

/** 参与哈希的最大字符数。与 goal_scheduler._call_signature 同口径。 */
export const MAX_SIGNATURE_CHARS = 400;

/** ``工具名:参数哈希``。键序无关，不可序列化的值退化成 str。 */
export function args_signature(tool?: unknown, args?: unknown): string {
    if (arguments.length < 2) {
        throw pyMissing("args_signature", ["tool", "args"].slice(arguments.length));
    }
    if (arguments.length > 2) {
        throw pyTooMany("args_signature", "2", arguments.length);
    }
    let key: string;
    try {
        key = pyJsonDumpsSortKeys(args, new Set<object>());
    } catch (e) {
        if (e instanceof TypeErrorP || e instanceof ValueErrorP) {
            key = pyStr(args);
        } else {
            throw e;
        }
    }
    const digest = md5Hex(pySliceCodePoints(key, MAX_SIGNATURE_CHARS));
    return `${pyStr(pyOr(tool, "?"))}:${pySliceCodePoints(digest, 8)}`;
}

/** 结果文本的归一化哈希。空文本返回 ""（= 还不知道结果）。 */
export function result_signature(text?: unknown): string {
    if (arguments.length < 1) {
        throw pyMissing("result_signature", ["text"]);
    }
    if (arguments.length > 1) {
        throw pyTooMany("result_signature", "1", arguments.length);
    }
    if (!pyTruth(text)) return "";
    if (typeof text !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(text)}' object has no attribute 'lower'`);
    }
    let norm = volatileSub(text.toLowerCase());
    norm = pySliceCodePoints(pySplitWs(norm).join(" "), MAX_SIGNATURE_CHARS);
    return pySliceCodePoints(md5Hex(norm), 12);
}

// ── 测试缝（python 模块全局名可替换的调用面镜像）────────────────────────────

export const LOOP_DETECTOR_SEAMS = {
    /** python 模块全局 `args_signature`（内部调用点经此走，探针逐场景换装）。 */
    argsSignature: (tool: unknown, args: unknown): string => args_signature(tool, args),
    /** python 模块全局 `result_signature`。 */
    resultSignature: (text: unknown): string => result_signature(text),
};

// ── 轮询/只读工具名单 ────────────────────────────────────────────────────────

export const KNOWN_POLL_TOOLS: ReadonlySet<string> = new Set([
    "read_text", "read_file", "list_dir", "find_files", "search_code", "grep",
    "glob", "git_status", "git_log", "git_diff", "git_show", "system_info",
    "tool_search", "snapshot", "get_text", "web_fetch",
]);

/** python `x in KNOWN_POLL_TOOLS`：list/dict 抛 unhashable，set 走 CPython 的
 *  frozenset 包装回退（返回 False），其余按哈希成员判定。 */
function pyInKnownPollTools(tool: unknown): boolean {
    if (Array.isArray(tool)) {
        throw new TypeErrorP("unhashable type: 'list'");
    }
    if (isPyDict(tool) || tool instanceof Map) {
        throw new TypeErrorP("unhashable type: 'dict'");
    }
    if (tool instanceof Uint8Array) {
        throw new TypeErrorP("unhashable type: 'bytearray'");
    }
    if (tool instanceof Set) {
        return false; // CPython set.__contains__ 的 make-new-frozenset 回退
    }
    return KNOWN_POLL_TOOLS.has(tool as string);
}

// ── LoopPattern（class LoopPattern(str, Enum)）──────────────────────────────

/** str-Enum 成员 = 值字符串（== 与 json 与 python 全等；见 DIVERGENCE）。 */
export const LoopPattern = {
    IDENTICAL_CALL: "identical_call",
    PING_PONG: "ping_pong",
    CONSECUTIVE_FAILURES: "consecutive_failures",
    UNKNOWN_TOOL: "unknown_tool",
    GLOBAL_BREAKER: "global_breaker",
    NO_PROGRESS: "no_progress",
} as const;
export type LoopPatternValue = (typeof LoopPattern)[keyof typeof LoopPattern];

// ── deque(maxlen=...) ───────────────────────────────────────────────────────

/** collections.deque：append 满员左挤出；索引按位置（含负下标）。 */
class PyDeque<T> {
    items: T[] = [];
    maxlen: number;

    constructor(maxlen: number) {
        this.maxlen = maxlen;
    }

    get length(): number {
        return this.items.length;
    }

    append(v: T): void {
        if (this.maxlen <= 0) return;
        if (this.items.length >= this.maxlen) this.items.shift();
        this.items.push(v);
    }

    /** python dq[i]（支持负下标）。 */
    get(i: number): T {
        const idx = i < 0 ? this.items.length + i : i;
        return this.items[idx] as T;
    }

    reversed(): T[] {
        return this.items.slice().reverse();
    }
}

// ── dataclass：_Call / LoopTripResult / Verdict ──────────────────────────────

class _Call {
    tool: unknown;
    args_sig: string;
    result_sig: string;
    poll: boolean;

    constructor(tool: unknown, args_sig: string, result_sig = "", poll = false) {
        this.tool = tool;
        this.args_sig = args_sig;
        this.result_sig = result_sig;
        this.poll = poll;
    }
}

export class LoopTripResult {
    tripped: boolean;
    pattern: LoopPatternValue;
    message: string;
    tool_name: unknown;
    details: JsonDict;

    constructor(tripped?: unknown, pattern?: unknown, message?: unknown,
                tool_name?: unknown, details?: unknown) {
        if (arguments.length < 4) {
            throw pyMissing("LoopTripResult.__init__",
                ["tripped", "pattern", "message", "tool_name"].slice(arguments.length));
        }
        if (arguments.length > 5) {
            throw pyTooMany("LoopTripResult.__init__", "from 5 to 6", arguments.length + 1);
        }
        this.tripped = tripped as boolean;
        this.pattern = pattern as LoopPatternValue;
        this.message = message as string;
        this.tool_name = tool_name;
        this.details = details === undefined ? {} : details as JsonDict;
    }
}

export class Verdict {
    level: string;
    detector: string;
    count: number;
    message: string;

    constructor(level?: unknown, detector?: unknown, count?: unknown, message?: unknown) {
        if (arguments.length > 4) {
            throw pyTooMany("Verdict.__init__", "from 1 to 5", arguments.length + 1);
        }
        this.level = level === undefined ? "" : level as string;
        this.detector = detector === undefined ? "" : detector as string;
        this.count = count === undefined ? 0 : count as number;
        this.message = message === undefined ? "" : message as string;
    }

    get stuck(): boolean {
        return this.level === "warning" || this.level === "critical";
    }

    get blocks(): boolean {
        return this.level === "critical";
    }
}

/** 模块级单例：所有"放行"判定共用同一个对象（§1）。 */
export const _OK: Verdict = new Verdict();

// ── LoopConfig（frozen dataclass）────────────────────────────────────────────

/** frozen dataclass 的赋值拦截（任意属性名，§23）。 */
function frozenSetter(name: string): never {
    throw new FrozenInstanceErrorP(`cannot assign to field '${name}'`);
}

export class LoopConfig {
    private readonly _f: {
        warning_threshold: unknown;
        critical_threshold: unknown;
        global_circuit_breaker: unknown;
        window: unknown;
        ping_pong_window: unknown;
        history_size: unknown;
        post_compaction_guard: unknown;
        enabled: unknown;
    };

    constructor(warning_threshold?: unknown, critical_threshold?: unknown,
                global_circuit_breaker?: unknown, window?: unknown,
                ping_pong_window?: unknown, history_size?: unknown,
                post_compaction_guard?: unknown, enabled?: unknown) {
        if (arguments.length > 8) {
            throw pyTooMany("LoopConfig.__init__", "from 1 to 9", arguments.length + 1);
        }
        this._f = {
            warning_threshold: warning_threshold === undefined ? 3 : warning_threshold,
            critical_threshold: critical_threshold === undefined ? 5 : critical_threshold,
            global_circuit_breaker: global_circuit_breaker === undefined ? 10 : global_circuit_breaker,
            window: window === undefined ? 8 : window,
            ping_pong_window: ping_pong_window === undefined ? 6 : ping_pong_window,
            history_size: history_size === undefined ? 64 : history_size,
            post_compaction_guard: post_compaction_guard === undefined ? 3 : post_compaction_guard,
            enabled: enabled === undefined ? true : enabled,
        };
    }

    get warning_threshold(): unknown {
        return this._f.warning_threshold;
    }
    set warning_threshold(_v: never) {
        frozenSetter("warning_threshold");
    }
    get critical_threshold(): unknown {
        return this._f.critical_threshold;
    }
    set critical_threshold(_v: never) {
        frozenSetter("critical_threshold");
    }
    get global_circuit_breaker(): unknown {
        return this._f.global_circuit_breaker;
    }
    set global_circuit_breaker(_v: never) {
        frozenSetter("global_circuit_breaker");
    }
    get window(): unknown {
        return this._f.window;
    }
    set window(_v: never) {
        frozenSetter("window");
    }
    get ping_pong_window(): unknown {
        return this._f.ping_pong_window;
    }
    set ping_pong_window(_v: never) {
        frozenSetter("ping_pong_window");
    }
    get history_size(): unknown {
        return this._f.history_size;
    }
    set history_size(_v: never) {
        frozenSetter("history_size");
    }
    get post_compaction_guard(): unknown {
        return this._f.post_compaction_guard;
    }
    set post_compaction_guard(_v: never) {
        frozenSetter("post_compaction_guard");
    }
    get enabled(): unknown {
        return this._f.enabled;
    }
    set enabled(_v: never) {
        frozenSetter("enabled");
    }

    /** dataclasses.replace：全字段经 __init__ 造新实例。 */
    with_(changes: Partial<Record<string, unknown>>): LoopConfig {
        const merged: unknown[] = [];
        for (const k of ["warning_threshold", "critical_threshold", "global_circuit_breaker",
            "window", "ping_pong_window", "history_size", "post_compaction_guard", "enabled"]) {
            merged.push(k in changes ? (changes as JsonDict)[k] : (this._f as JsonDict)[k]);
        }
        return new LoopConfig(...merged);
    }

    /** 夹取到自洽区间（warning < critical < global 硬约束）。 */
    validated(): LoopConfig {
        if (arguments.length > 0) {
            throw pyTooMany("LoopConfig.validated", "1", arguments.length + 1);
        }
        const warn = Math.max(1, pyInt(this._f.warning_threshold));
        const crit = Math.max(warn + 1, pyInt(this._f.critical_threshold));
        const glob = Math.max(crit + 1, pyInt(this._f.global_circuit_breaker));
        const guard0 = pyInt(this._f.post_compaction_guard);
        const guard = guard0 <= 0 ? 0 : Math.max(warn, guard0);
        return this.with_({
            warning_threshold: warn,
            critical_threshold: crit,
            global_circuit_breaker: glob,
            window: Math.max(crit, pyInt(this._f.window)),
            ping_pong_window: Math.max(2, pyInt(this._f.ping_pong_window)),
            history_size: Math.max(glob, pyInt(this._f.history_size)),
            post_compaction_guard: guard,
        });
    }

    /** 从 config.json 的 agent.loop_detection 读取，缺失走默认。 */
    static from_config(cfg?: unknown): LoopConfig {
        if (arguments.length < 1) {
            throw pyMissing("LoopConfig.from_config", ["cfg"]);
        }
        if (arguments.length > 1) {
            // python 的形参只有 (cls, cfg)：第二个位置实参就是超参
            throw pyTooMany("LoopConfig.from_config", "2", arguments.length + 1);
        }
        const c = pyOr(cfg, {});
        const agent = pyOr(pyGetCall(c, "agent"), {});
        const block = pyOr(pyGetCall(agent, "loop_detection"), {});
        const base = new LoopConfig();
        return new LoopConfig(
            pyInt(pyGetCall(block, "warning_threshold", base.warning_threshold)),
            pyInt(pyGetCall(block, "critical_threshold", base.critical_threshold)),
            pyInt(pyGetCall(block, "global_circuit_breaker", base.global_circuit_breaker)),
            pyInt(pyGetCall(block, "window", base.window)),
            pyInt(pyGetCall(block, "ping_pong_window", base.ping_pong_window)),
            pyInt(pyGetCall(block, "history_size", base.history_size)),
            pyInt(pyGetCall(block, "post_compaction_guard", base.post_compaction_guard)),
            pyTruth(pyGetCall(block, "enabled", base.enabled)),
        ).validated();
    }
}

/** python 的 **kwargs 袋在 TS 侧的形态：真对象（非数组/非 null）。
 *  占位参数收到非对象值 = python 的多传位置实参（keyword-only 边界外）。 */
function isKwBag(v: unknown): boolean {
    return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

/** python `x * 2`：str/list 重复、数值相乘、其余 TypeError。 */
function pyMul2(v: unknown): unknown {
    if (typeof v === "string") return v + v;
    if (Array.isArray(v)) return v.concat(v);
    if (typeof v === "number" || typeof v === "boolean") return Number(v) * 2;
    throw new TypeErrorP(
        `unsupported operand type(s) for *: '${pyTypeName(v)}' and 'int'`);
}

/** python `x.get(k)` / `x.get(k, d)`：普通对象即 dict，其余要有真 .get 方法。 */
function pyGetCall(v: unknown, key: string, ...rest: unknown[]): unknown {
    const hasDefault = rest.length >= 1;
    if (v === null || v === undefined || Array.isArray(v) ||
        (typeof v !== "object" && typeof v !== "function")) {
        throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'get'`);
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
        if (v instanceof Map) {
            if (v.has(key)) return v.get(key);
            return hasDefault ? rest[0] : null;
        }
        const get = (v as JsonDict)["get"];
        if (typeof get !== "function") {
            throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'get'`);
        }
        return (get as (...a: unknown[]) => unknown).apply(v, [key, ...rest]);
    }
    const o = v as JsonDict;
    if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
    return hasDefault ? rest[0] : null;
}

// ── LoopDetector ─────────────────────────────────────────────────────────────

export interface LoopDetectorKw {
    threshold_repeat?: unknown;
    threshold_oscillation?: unknown;
    threshold_failure_streak?: unknown;
    window_size?: unknown;
}

export class LoopDetector {
    config: LoopConfig;
    _history: PyDeque<_Call>;
    _guard_steps: number;
    _threshold_repeat: unknown;
    _threshold_oscillation: unknown;
    _threshold_failure_streak: unknown;
    _failure_streak: number;
    _last_error_class: string;

    constructor(config?: unknown, kw?: LoopDetectorKw | undefined) {
        if (arguments.length > 2) {
            throw pyTooMany("LoopDetector.__init__", "from 1 to 2", arguments.length + 1);
        }
        if (arguments.length === 2 && !isKwBag(kw)) {
            // python：config 之后是 keyword-only 区，第二位置实参必然超参
            throw pyTooMany("LoopDetector.__init__", "from 1 to 2", 3);
        }
        if (kw !== undefined && kw !== null) {
            for (const k of Object.keys(kw)) {
                if (!["threshold_repeat", "threshold_oscillation",
                    "threshold_failure_streak", "window_size"].includes(k)) {
                    throw new TypeErrorP(
                        `LoopDetector.__init__() got an unexpected keyword argument '${k}'`);
                }
            }
        }
        const kwV = (kw ?? {}) as JsonDict;
        let base_cfg: LoopConfig;
        if (pyTruth(config)) {
            if (!(config instanceof LoopConfig)) {
                // dataclasses.replace / .validated() 对非 dataclass 的两条 python 臂
                if (kwV.threshold_repeat !== undefined || kwV.window_size !== undefined) {
                    throw new TypeErrorP("replace() should be called on dataclass instances");
                }
                const vfn = (config as JsonDict)["validated"];
                if (typeof vfn !== "function") {
                    throw new AttributeErrorP(
                        `'${pyTypeName(config)}' object has no attribute 'validated'`);
                }
                this.config = (vfn as (...a: unknown[]) => unknown).call(config) as LoopConfig;
                this._history = new PyDeque<_Call>(this.config.history_size as number);
                this._guard_steps = 0;
                this._threshold_repeat = kwV.threshold_repeat !== undefined ? kwV.threshold_repeat : null;
                this._threshold_oscillation = kwV.threshold_oscillation !== undefined ? kwV.threshold_oscillation : null;
                this._threshold_failure_streak = kwV.threshold_failure_streak !== undefined ? kwV.threshold_failure_streak : 3;
                this._failure_streak = 0;
                this._last_error_class = "";
                return;
            }
            base_cfg = config;
        } else {
            base_cfg = new LoopConfig();
        }
        if (kwV.threshold_repeat !== undefined) {
            base_cfg = base_cfg.with_({
                warning_threshold: kwV.threshold_repeat,
                critical_threshold: kwV.threshold_repeat,
            });
        }
        if (kwV.window_size !== undefined) {
            base_cfg = base_cfg.with_({ window: kwV.window_size });
        }
        this.config = base_cfg.validated();
        this._history = new PyDeque<_Call>(this.config.history_size as number);
        this._guard_steps = 0;
        this._threshold_repeat = kwV.threshold_repeat !== undefined ? kwV.threshold_repeat : null;
        this._threshold_oscillation = kwV.threshold_oscillation !== undefined ? kwV.threshold_oscillation : null;
        this._threshold_failure_streak = kwV.threshold_failure_streak !== undefined ? kwV.threshold_failure_streak : 3;
        this._failure_streak = 0;
        this._last_error_class = "";
    }

    /** Convenience single-step check & record method. */
    record_call(tool_name?: unknown, args?: unknown): LoopTripResult | null {
        if (arguments.length < 2) {
            throw pyMissing("LoopDetector.record_call",
                ["tool_name", "args"].slice(arguments.length));
        }
        if (arguments.length > 2) {
            throw pyTooMany("LoopDetector.record_call", "2", arguments.length + 1);
        }
        const sig = LOOP_DETECTOR_SEAMS.argsSignature(tool_name, args);
        const repeat_streak = this._same_args_streak(sig) + 1;
        const repeat_threshold = pyTruth(this._threshold_repeat)
            ? this._threshold_repeat
            : this.config.warning_threshold;
        if (pyGe(repeat_streak, repeat_threshold)) {
            this.record_blocked(tool_name, args);
            return new LoopTripResult(
                true,
                LoopPattern.IDENTICAL_CALL,
                `Loop was detected in model tool calls: tool '${pyStr(tool_name)}' invoked ${pyStr(repeat_streak)} times with identical parameters. Circuit breaker tripped to halt runaway execution.`,
                tool_name,
                { repeat_count: repeat_streak, sig: sig },
            );
        }
        const pp_streak = this._ping_pong_streak(sig);
        const pp_threshold = this._threshold_oscillation !== null
            ? pyMul2(this._threshold_oscillation)
            : this.config.ping_pong_window;
        if (pyGe(pp_streak, pp_threshold)) {
            this.record_blocked(tool_name, args);
            return new LoopTripResult(
                true,
                LoopPattern.PING_PONG,
                `Loop was detected: oscillating ping-pong pattern across ${pyStr(pp_streak)} consecutive steps. Execution halted.`,
                tool_name,
                { streak: pp_streak },
            );
        }
        this.record(tool_name, args);
        return null;
    }

    /** Track consecutive execution failures. */
    record_outcome(ok?: unknown, error_class?: unknown): LoopTripResult | null {
        if (arguments.length < 1) {
            throw pyMissing("LoopDetector.record_outcome", ["ok"]);
        }
        if (arguments.length > 2) {
            throw pyTooMany("LoopDetector.record_outcome", "from 2 to 3", arguments.length + 1);
        }
        const errV = error_class === undefined ? "" : error_class;
        if (pyTruth(ok)) {
            this._failure_streak = 0;
            this._last_error_class = "";
            return null;
        }
        const clean_src = pyOr(errV, "error");
        if (typeof clean_src !== "string") {
            throw new AttributeErrorP(
                `'${pyTypeName(clean_src)}' object has no attribute 'strip'`);
        }
        const clean_err = pySliceCodePoints(pyStrip(clean_src), 100);
        if (this._failure_streak > 0 && clean_err === this._last_error_class) {
            this._failure_streak += 1;
        } else {
            this._failure_streak = 1;
            this._last_error_class = clean_err;
        }
        if (pyGe(this._failure_streak, this._threshold_failure_streak)) {
            const last_tool = this._history.length > 0 ? this._history.get(-1).tool : "unknown";
            return new LoopTripResult(
                true,
                LoopPattern.CONSECUTIVE_FAILURES,
                `Failure streak breaker tripped: ${pyStr(this._failure_streak)} consecutive failures with error '${clean_err}'. Halted to prevent further token waste.`,
                last_tool,
                { failure_streak: this._failure_streak, error_class: clean_err },
            );
        }
        return null;
    }

    private _same_args_streak(sig?: unknown): number {
        if (arguments.length < 1) {
            throw pyMissing("LoopDetector._same_args_streak", ["sig"]);
        }
        if (arguments.length > 1) {
            throw pyTooMany("LoopDetector._same_args_streak", "2", arguments.length + 1);
        }
        let streak = 0;
        for (const call of this._history.reversed()) {
            if (call.args_sig === sig) streak += 1;
            else break;
        }
        return streak;
    }

    /** 折叠发生了——武装 post-compaction guard。 */
    note_compaction(): void {
        if (arguments.length > 0) {
            throw pyTooMany("LoopDetector.note_compaction", "1", arguments.length + 1);
        }
        this._guard_steps = this.config.post_compaction_guard as number;
    }

    /** 把一次即将执行的调用登记进历史，返回它的索引给 observe 用。 */
    record(tool?: unknown, args?: unknown, kw?: { poll?: unknown } | undefined): number {
        if (arguments.length < 2) {
            throw pyMissing("LoopDetector.record", ["tool", "args"].slice(arguments.length));
        }
        if (arguments.length > 3) {
            throw pyTooMany("LoopDetector.record", "3", arguments.length + 1);
        }
        if (arguments.length === 3 && !isKwBag(kw)) {
            // poll 是 keyword-only：第三位置实参必然超参
            throw pyTooMany("LoopDetector.record", "3", arguments.length + 1);
        }
        if (kw !== undefined && kw !== null) {
            for (const k of Object.keys(kw)) {
                if (k !== "poll") {
                    throw new TypeErrorP(
                        `LoopDetector.record() got an unexpected keyword argument '${k}'`);
                }
            }
        }
        const pollV = kw !== undefined && kw !== null && kw.poll !== undefined ? kw.poll : null;
        // python 求值序：先成员判定（不可哈希在此抛），再算签名，再入历史
        const is_poll = pollV === null ? pyInKnownPollTools(tool) : pollV;
        this._history.append(new _Call(
            pyOr(tool, "?"),
            LOOP_DETECTOR_SEAMS.argsSignature(tool, args),
            "",
            pyTruth(is_poll),
        ));
        if (this._guard_steps > 0) {
            this._guard_steps -= 1;
        }
        return this._history.length - 1;
    }

    /** 登记一次被拦下、没有执行的调用（继承同签名最近的结果签名）。 */
    record_blocked(tool?: unknown, args?: unknown): void {
        if (arguments.length < 2) {
            throw pyMissing("LoopDetector.record_blocked",
                ["tool", "args"].slice(arguments.length));
        }
        if (arguments.length > 2) {
            throw pyTooMany("LoopDetector.record_blocked", "2", arguments.length + 1);
        }
        const sig = LOOP_DETECTOR_SEAMS.argsSignature(tool, args);
        let inherited = "";
        for (const call of this._history.reversed()) {
            if (call.args_sig === sig && pyTruth(call.result_sig)) {
                inherited = call.result_sig;
                break;
            }
        }
        this._history.append(new _Call(
            pyOr(tool, "?"),
            sig,
            inherited,
            pyInKnownPollTools(tool),
        ));
    }

    /** 结果回来后补写 result_sig。索引越界（被 maxlen 挤掉）就忽略。 */
    observe(index?: unknown, result_text?: unknown): void {
        if (arguments.length < 2) {
            throw pyMissing("LoopDetector.observe",
                ["index", "result_text"].slice(arguments.length));
        }
        if (arguments.length > 2) {
            throw pyTooMany("LoopDetector.observe", "2", arguments.length + 1);
        }
        // python `0 <= index < len(...)`：0 <= index 先求值，非数值抛 '<=' TypeError
        if (typeof index !== "number" && typeof index !== "boolean") {
            throw new TypeErrorP(
                `'<=' not supported between instances of 'int' and '${pyTypeName(index)}'`);
        }
        const idx = typeof index === "boolean" ? (index ? 1 : 0) : index;
        if (0 <= idx && idx < this._history.length) {
            this._history.get(idx).result_sig =
                LOOP_DETECTOR_SEAMS.resultSignature(pyOr(result_text, ""));
        }
    }

    /** 在执行 tool(args) 之前判断该不该拦。 */
    check(tool?: unknown, args?: unknown, kw?: { tool_known?: unknown } | undefined): Verdict {
        if (arguments.length < 2) {
            throw pyMissing("LoopDetector.check", ["tool", "args"].slice(arguments.length));
        }
        if (arguments.length > 3) {
            throw pyTooMany("LoopDetector.check", "3", arguments.length + 1);
        }
        if (arguments.length === 3 && !isKwBag(kw)) {
            // tool_known 是 keyword-only：第三位置实参必然超参
            throw pyTooMany("LoopDetector.check", "3", arguments.length + 1);
        }
        if (kw !== undefined && kw !== null) {
            for (const k of Object.keys(kw)) {
                if (k !== "tool_known") {
                    throw new TypeErrorP(
                        `LoopDetector.check() got an unexpected keyword argument '${k}'`);
                }
            }
        }
        const tool_known = kw !== undefined && kw !== null && kw.tool_known !== undefined
            ? kw.tool_known
            : true;
        if (!pyTruth(this.config.enabled)) {
            return _OK;
        }
        const sig = LOOP_DETECTOR_SEAMS.argsSignature(tool, args);
        const poll = pyInKnownPollTools(tool);
        const c = this.config;

        const no_progress = this._no_progress_streak(sig) + 1;
        const repeat_recent = this._recent_same_args(sig) + 1;
        const unknown_repeat = this._unknown_tool_streak(tool) + 1;

        let crit_threshold = c.critical_threshold as number;
        if (this._guard_steps > 0) {
            crit_threshold = Math.max(2, Math.min(crit_threshold, c.warning_threshold as number));
        }

        // 1. unknown_tool_repeat —— 幻想工具，最先拦。
        if (!pyTruth(tool_known) && pyGe(unknown_repeat, Math.max(2, c.warning_threshold as number))) {
            return new Verdict("critical", "unknown_tool_repeat", unknown_repeat,
                `⚠️ 你已经第 ${pyStr(unknown_repeat)} 次尝试调用 \`${pyStr(tool)}\`，但它不是一个可用工具。不要再重试这个不存在的名字——改用现有工具，或直接基于已有信息作答。`);
        }
        // 2. global_circuit_breaker —— 最后的保险丝。
        if (no_progress >= (c.global_circuit_breaker as number)) {
            return new Verdict("critical", "global_circuit_breaker", no_progress,
                `⛔ \`${pyStr(tool)}\` 已经用相同参数、得到相同结果连续 ${pyStr(no_progress)} 次，毫无进展。全局熔断已触发以防止空转：请停止这条路径，换一种完全不同的方法，或如实向用户说明你卡在了哪里。`);
        }
        // 3. known_poll_no_progress —— 轮询工具专属：只在"连结果都没变"时判。
        if (poll && no_progress >= crit_threshold) {
            return new Verdict("critical", "known_poll_no_progress", no_progress,
                `⚠️ \`${pyStr(tool)}\` 连续 ${pyStr(no_progress)} 次返回完全相同的结果。轮询没有等到任何变化，继续调用只会浪费步数——基于当前结果继续，或换个思路。`);
        }
        // 4. no_progress —— 参数相同且结果相同（非轮询工具）。
        if (!poll && no_progress >= crit_threshold) {
            return new Verdict("critical", "no_progress", no_progress,
                `⚠️ \`${pyStr(tool)}\` 用相同参数、得到相同结果连续 ${pyStr(no_progress)} 次。这一步没有推进任务，重复它不会有不同结果——换参数、换工具，或说明为什么卡住。`);
        }
        // 5. ping_pong —— A→B→A→B 交替。
        const pp = this._ping_pong_streak(sig);
        if (pyGe(pp, c.ping_pong_window)) {
            return new Verdict("critical", "ping_pong", pp,
                `⚠️ 最近 ${pyStr(pp)} 步只在两个动作之间来回横跳，没有前进。跳出这个循环：退一步重新规划，而不是继续在两个选项间切换。`);
        }
        // 6. generic_repeat —— 最弱信号，只警告。轮询工具豁免。
        if (!poll && pyGe(repeat_recent, c.warning_threshold)) {
            return new Verdict("warning", "generic_repeat", repeat_recent,
                `提示：你已经用相同参数调用 \`${pyStr(tool)}\` ${pyStr(repeat_recent)} 次了。如果没有取得进展，请停止重试，换个方法或如实报告失败。`);
        }
        return _OK;
    }

    private _no_progress_streak(sig?: unknown): number {
        if (arguments.length < 1) {
            throw pyMissing("LoopDetector._no_progress_streak", ["sig"]);
        }
        if (arguments.length > 1) {
            throw pyTooMany("LoopDetector._no_progress_streak", "2", arguments.length + 1);
        }
        let streak = 0;
        let latest: string | null = null;
        for (const call of this._history.reversed()) {
            if (call.args_sig !== sig) continue;
            if (!pyTruth(call.result_sig)) continue;
            if (latest === null) {
                latest = call.result_sig;
                streak = 1;
                continue;
            }
            if (call.result_sig !== latest) break;
            streak += 1;
        }
        return streak;
    }

    private _recent_same_args(sig?: unknown): number {
        if (arguments.length < 1) {
            throw pyMissing("LoopDetector._recent_same_args", ["sig"]);
        }
        if (arguments.length > 1) {
            throw pyTooMany("LoopDetector._recent_same_args", "2", arguments.length + 1);
        }
        const window = this._history.items.slice(-(this.config.window as number));
        return window.filter((c) => c.args_sig === sig).length;
    }

    private _unknown_tool_streak(tool?: unknown): number {
        if (arguments.length < 1) {
            throw pyMissing("LoopDetector._unknown_tool_streak", ["tool"]);
        }
        if (arguments.length > 1) {
            throw pyTooMany("LoopDetector._unknown_tool_streak", "2", arguments.length + 1);
        }
        let streak = 0;
        for (const call of this._history.reversed()) {
            if (call.tool === tool) streak += 1;
            else break;
        }
        return streak;
    }

    private _ping_pong_streak(current_sig?: unknown): number {
        if (arguments.length < 1) {
            throw pyMissing("LoopDetector._ping_pong_streak", ["current_sig"]);
        }
        if (arguments.length > 1) {
            throw pyTooMany("LoopDetector._ping_pong_streak", "2", arguments.length + 1);
        }
        const hist = this._history.items;
        if (hist.length === 0) return 0;
        let other: string | null = null;
        for (let i = hist.length - 1; i >= 0; i--) {
            const call = hist[i] as _Call;
            if (call.args_sig !== current_sig) {
                other = call.args_sig;
                break;
            }
        }
        if (other === null) return 0;
        const otherSig: string = other;
        let count = 1;
        let expect: string = otherSig;
        for (let i = hist.length - 1; i >= 0; i--) {
            const call = hist[i] as _Call;
            if (call.args_sig !== expect) break;
            count += 1;
            expect = expect === otherSig ? (current_sig as string) : otherSig;
        }
        return count;
    }
}

// PORT STATUS: confidence=high todos=[0]
