/**
 * triad_runner.ts — 三权分立任务执行系统与信息防线 (Triad Orchestrator & The Wall).
 *
 * Ported bug-for-bug from `app/backend/triad_runner.py` (343 lines, wave-10,
 * unit 220). 命名、默认值、异常类型/文案、truthiness 判定逐条对齐；源文件自身的
 * 缺陷原样保留（见下），本文件零 TODO(port)。
 *
 * BUG-FOR-BUG FACTS (pinned by the w220 parity probe)
 *   1. `from result import Result` 与 `apply_differential_masking` 被导入但**从未
 *      使用**；`copy/hashlib/json/re` 同样导入未用（logging/os/time/uuid 有用）。
 *      端口保留 `Result` 死导入以维持模块依赖边，其余死导入只在此建档。
 *   2. `build_instrument_from_spec` **从不读取 rc["timeout_s"]**：所有 case 的
 *      timeout_s 永远是 dataclass 默认 60（`evaluate` 传给 differential_validator
 *      的 spec 因此也恒为 60）——探针用 rc timeout_s=99 的输入把 60 钉死。
 *   3. `or` 兜底陷阱：`float(spec.get("threshold") or 0.90)` —— threshold 为
 *      0/0.0/""/False/None 时**静默变 0.90**；weight 同理（0→1.0，但 "nan"→NaN，
 *      因为 bool(nan)=True）；name/target_component/subsystem/id/description 的
 *      falsy 值全部落入默认串（id 为 0 时用 f"case_{i+1}"；description 缺省串
 *      f"Test behavior {cid}" 里的 cid 是**已 str() 的 id**而非序号）。
 *   4. `list(rc.get("masks") or [])`：masks 给字符串 "ab" 会**按字符展开成
 *      ["a","b"]**；给 dict 展开成键列表；给 int/float 抛
 *      `TypeError: 'int' object is not iterable`。
 *   5. `raw_cases = spec.get("cases") or []` 后 `for i, rc in enumerate(raw_cases)`：
 *      cases 给 str 会按字符迭代、给 int 抛 `TypeError: 'int' object is not
 *      iterable`；元素 rc 非 dict 时 `rc.get` 抛 `AttributeError: 'str' object
 *      has no attribute 'get'`（类型名随值变）。spec 本身非 dict → 同型
 *      AttributeError（在 iid 已消耗一个 uuid 之后才炸，FACT 12）。
 *   6. `float(str)` 用 CPython 语法（前后空白、nan/inf、下划线只能夹在数字间、
 *      "1."、"1e5"）；非法串抛 `ValueError: could not convert string to float:
 *      'abc'`（repr 引用原文）；list/dict 抛 `TypeError: float() argument must
 *      be a string or a real number, not 'list'`。
 *   7. `evaluate`：空 cases **提前返回 passed=True, score=1.0, passed_weight=1.0,
 *      total_weight=1.0, evaluated_cases=0**（不计时、不聚类）；
 *      differential_validator 返回非 dict（如 None/str/int）时 `res.get` 直接
 *      冲出 AttributeError（源文件不防御）；`res.get("evidence", [])` 缺键兜底
 *      []；status 只有**严格等于 "passed"** 才算过（None/True/"Passed" 均败）。
 *   8. `score = passed_weight / total_weight if total_weight > 0 else 1.0`；
 *      `passed = score >= (threshold - 1e-6)` —— 1e-6 容差边界两侧都要钉。
 *      `TriadEvaluationResult.to_dict` **丢弃 raw_failures**，且 score 舍入到
 *      4 位、passedWeight/totalWeight/durationMs 到 2 位——**CPython banker's
 *      rounding**（round(2.125,2)=2.12、round(0.0625,2)=0.12），端口用 BigInt
 *      精确十进制 half-even 复刻（见 DIVERGENCE D3）。
 *   9. `synthesize_directives`：按 subsystem 分组用 **dict 插入序**（subsystem
 *      可为 int/True 等可哈希非 str 键，且 **== 键相等**——True 与 1/1.0 并入
 *      同组、保留先插入键；list/dict 键抛 `TypeError: unhashable
 *      type: 'list'`）；summary 取每组**前 3 条**里 truthy 的 description 用
 *      "; " 拼接；severity：`sum(float(f.get("weight") or 1.0)) >= 3.0 or
 *      count >= 3` → high（weight 0→1.0 陷阱、"2"→2.0 语法同 FACT 6）；
 *      **action 判定读的是 `str(fails).lower()`**——在整个失败列表的 CPython
 *      repr 串里做子串搜索："timeout" 优先，其次 "not found" 或 "missing"，
 *      否则默认文案。字段名本身不命中，但 case 名/evidence 内容命中即改分支；
 *      "not_found"（下划线）**不**命中 "not found"（源文件如此，不修）。
 *      最后 `sort(key=high?0:1)` 是**稳定排序**（同 severity 保持分组序）。
 *  10. `run_cycle`：`range(1, max_rounds + 1)` —— 先算 `max_rounds + 1`（str 抛
 *      `TypeError: can only concatenate str (not "int") to str`，list 抛
 *      `can only concatenate list (not "int") to list`，None/dict 等抛
 *      `unsupported operand type(s) for +: 'NoneType' and 'int'`），结果非整抛
 *      `TypeError: 'float' object cannot be interpreted as an integer`；bool 是
 *      int 子类（True→1 轮）。日志 f-string 的
 *      `score:.2%` 是**先 IEEE ×100 再 %.2f half-even**；passed 渲染 "True"/
 *      "False"；directives 计数渲染 int。implementer falsy（None/0/""/[]）
 *      → **break，只带首轮历史返回 (False, history)**；truthy 非可调用（如 1）
*      → 调用抛 `TypeError: 'int' object is not callable`，**该抛错发生在 try
 *      之内、被 `except Exception` 捕获并打 warning 后继续下一轮**（源文件
 *      try 包住的就是调用本身）。实现体抛的 Exception 同样被捕获打
 *      `warning f"...: {exc}"`（str(exc) 文案）。轮内评估通过即返回 (True, history)。
 *  11. `TheWall.get_private_instrument_dir`：`os.makedirs(p, exist_ok=True)` ——
 *      **纯取路径函数有建目录副作用**；workspace 非 str 时 realpath 抛
 *      `TypeError: expected str, bytes or os.PathLike object, not int`。
 *      `sanitize_implementer_prompt`：falsy 输入（0/None/[]/""）一律返回 ""，
 *      truthy 非 str（如 5）→ .replace 抛 `AttributeError: 'int' object has no
 *      attribute 'replace'`；替换是**全量字面替换**
 *      `.ovolve_private_instrument` → `<INTERNAL_EVAL>`。
 *  12. uuid：`inst_{uuid4().hex[:8]}` / `dir_{uuid4().hex[:8]}` 每次调用消耗一个
 *      8-hex（build_instrument 在解析 spec **之前**先消耗，异常路径也消耗）；
 *      时钟：instrument 构造取一次 time.time()（created_at），evaluate 每次
 *      t0/t1 各一次。端口经 TRIAD_SEAMS 注入，探针两侧喂同一脚本序列。
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, native dep → seam): `from validator_registry import
 *     apply_differential_masking, differential_validator` —— validator_registry 是
 *     **Native→Rust 单元**（`rust_core/src/validator_registry/mod.rs`，见
 *     verified/validator_registry.json），TS 侧无落地件可复用（与 red_team_patrol
 *     对 mailbox 的处置同族）。端口默认 seam `differentialValidator` 抛
 *     `ModuleNotFoundError: No module named 'validator_registry'`——与宿主内核
 *     未装载时的 python import 失败逐字同文案；生产装载/探针经
 *     `_set_seams_for_parity` 注入真实现。`apply_differential_masking` 在源里
 *     本就是死导入，只建档不注入。等价性：本单元对 validator_registry 的全部
 *     可观察面就是 `differential_validator(spec, workspace)` 的返回值与调用序，
 *     seam 完整覆盖了这一面。
 *   DIVERGENCE(port, int vs float identity): JS 只有一种 number。CPython 的
 *     int/float 身份仅在**进入字符串语境**时可见。端口的规则：经 `pyFloat()`
 *     （对应源里 float()/sum()/除法）产出的值在 python 侧必然是 float，但它们
 *     只流向 JSON 数据语境（comparator 按数值归一）与 repr **子串搜索**语境
 *     （FACT 9 的 action 判定），两者对 "2" vs "2.0" 不敏感；纯 table 数值进
 *     str() 语境（id/description/name/subsystem/max_rounds 渲染）时按 int 渲染
 *     （String(v)）。场景表因此**不使用整数值形式的 float** 进任何字符串语境
 *     （写 2.5/0.5，不写 2.0）；CPython `str(10**25)` 任意精度大整在本单元
 *     不可达（数值全过 float() 归一）。
 *   DIVERGENCE(port, rounding): JS `toFixed` 平局规则是"远离零"，CPython
 *     round()/%.2f/%.2% 是对**精确二进制值**做最近舍入、平局取偶。端口用 BigInt
 *     精确十进制展开实现 half-even（pyRound/pyFormatFixed 共用；pyFormatPercent2
 *     = IEEE ×100 + %.2f，与 CPython float.__format__ 的 '%' 分支同序）。等价
 *     论证：两侧从同一 IEEE-754 double 出发、对同一精确值做同一舍入规则，输出
 *     必同；probe 的 to_dict/日志组把 2.125→2.12、0.0625→0.12、0.123456→0.1235
 *     这类平局与舍出样本钉死。
 *   DIVERGENCE(port, float repr): `pyFloatRepr` 复刻 CPython repr 的指数切换
 *     阈值（|v|>=1e16 或非零且 <1e-4 → "1e+16"/"1.5e-05" 风格，指数带符号、
 *     至少两位补零；NaN/±inf → "nan"/"inf"/"-inf"）；区间内用 JS 最短往返串 +
 *     整数值补 ".0"。两侧最短往返算法同为 Steele-White，区间内逐字一致；
 *     1e16/1e-4 边界样本由日志/摘要组 pin。
 *   DIVERGENCE(port, dict order): CPython dict 保插入序；JS 对象会把整数样键
 *     提前。分组容器（synthesize_directives 的 grouped）用**插入序数组 +
 *     CPython == 键相等**复刻（True/1/1.0 并入同组且保留先插入键；Map 的
 *     SameValueZero 会把它们错分成两组，故不用 Map）；场景表故意使用
 *     "2" / 2 / "general" 与 True/1 混排证明这点；raw_failures/directive
 *     的 repr 只进子串搜索语境，键序不改变命中集。
 *   DIVERGENCE(port, dataclass → class): dataclass 字段默认值搬进构造参数对象；
 *     源文件的 dataclass 全部经关键字构造（探针/内部都是），行为无差。
 *     `created_at` 的 default_factory=time.time 在构造时取 seam 时钟。
 *   DIVERGENCE(port, exception identity): 端口抛出的错误对象 name 用 CPython
 *     异常类名（ValueError/TypeError/AttributeError/ModuleNotFoundError），
 *     文案逐字对齐；跨语言比对按 comparator 约定只比 name（msg 进日志时由
 *     脚本保证两侧同串）。
 *   DIVERGENCE(port, os.makedirs/realpath/join → seam): 目录创建与 realpath 走
 *     TRIAD_SEAMS（默认实现 = realpathSync + 不存在路径的 CPython 式静默规范化
 *     兜底，mkdirSync recursive），探针注入记录型假件（红线 5：不产生真实
 *     目录、不依赖宿主文件系统状态）。join 只用于两段拼接（base 与固定相对段
 *     ".ovolve_private_instrument"），ntpath 语义在 base 绝对且 sub 恒为相对段
 *     时退化为"尾分隔符去重"，端口按该退化规则实现（生产路径 base 来自
 *     realpath，绝无绝对 sub 情形）。
 *
 * SEAMS (TRIAD_SEAMS): now / uuidHex8 / realpath / makedirs /
 *   differentialValidator / log —— 全部可被 `_set_seams_for_parity` 覆盖；
 *   探针侧对应 python 的模块命名空间假件（triad.time / triad.uuid / triad.os /
 *   triad.differential_validator / triad.logger）。
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";

// 源文件死导入（FACT 1）：`from result import Result`。TS 里保留依赖边但不使用。
import { Result as _Result } from "./result.js";
void _Result; // 显式声明"导入即副作用"，与 python 死导入等价

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
class ImportErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ImportError"; }
}
class ModuleNotFoundErrorP extends ImportErrorP {
    constructor(msg: string) { super(msg); this.name = "ModuleNotFoundError"; }
}

type PyDict = Record<string, unknown>;

/** python `type(x).__name__`（JSON 值域 + 端口内部对象）。 */
function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Map) return "dict";
    if (typeof v === "object") return "dict";
    if (typeof v === "function") return "function";
    return typeof v;
}

/** CPython truthiness（NaN 为真、±0 为假、空容器为假、bool(float) 恒为数值判）。 */
function pyTruthy(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0; // NaN !== 0 → true，与 bool(nan)=True 一致
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map) return v.size > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0; // dict {} falsy（CPython）
    if (typeof v === "function") return true;
    return Boolean(v);
}

/** python `a or b`：truthy(a) ? a : b。 */
function pyOr(a: unknown, b: unknown): unknown {
    return pyTruthy(a) ? a : b;
}

/** CPython dict 键相等（==语义）：bool 是 int 子类（True==1、0==False）；str 与数值互不等。 */
function pyKeyEq(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    const num = (v: unknown): number | null =>
        typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : null;
    const na = num(a);
    const nb = num(b);
    return na !== null && nb !== null && na === nb;
}

/** CPython `str(v)`（JSON 值域；整数按 int 渲染——见 DIVERGENCE int/float）。 */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
    return pyRepr(v); // str(list/dict) == repr(list/dict)
}

/** CPython float repr：最短往返 + 指数阈值（>=1e16 或 <1e-4）+ NaN/inf 词形。 */
export function pyFloatRepr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    if (Object.is(v, -0)) return "-0.0"; // CPython repr(-0.0) == "-0.0"
    const abs = Math.abs(v);
    if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
        const m = /^(-?(?:\d+)(?:\.\d+)?)e([+-])(\d+)$/.exec(v.toExponential());
        if (m) return `${m[1]}e${m[2]}${(m[3] as string).padStart(2, "0")}`;
        return v.toExponential();
    }
    let s = String(v);
    if (!/[.e]/.test(s)) s += ".0";
    return s;
}

/** CPython repr 的数值渲染：整数值按 int（见 DIVERGENCE int/float identity）。 */
function pyNumRepr(v: number): string {
    if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v);
    return pyFloatRepr(v);
}

/** CPython repr：优先单引号；含单引号不含双引号 → 双引号；两者都含 → 单引号+转义。 */
function pyReprStr(s: string): string {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of Array.from(s)) {
        const cp = ch.codePointAt(0) as number;
        if (ch === quote || ch === "\\") { out += "\\" + ch; continue; }
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") { out += "\\r"; continue; }
        if (ch === "\t") { out += "\\t"; continue; }
        if (cp < 0x20 || cp === 0x7f) { out += "\\x" + cp.toString(16).padStart(2, "0"); continue; }
        if (cp < 0x7f || isPyPrintable(cp)) { out += ch; continue; }
        if (cp <= 0xffff) out += "\\u" + cp.toString(16).padStart(4, "0");
        else out += "\\U" + cp.toString(16).padStart(8, "0");
    }
    out += quote;
    return out;
}

/** CPython unicodedata.isprintable 的高码点近似（表固定 ASCII+CJK，见头注）。 */
function isPyPrintable(cp: number): boolean {
    if (cp === 0x20) return true;
    if (cp < 0x7f) return true;
    if (cp === 0x00ad) return false;
    if (cp >= 0x200b && cp <= 0x200f) return false;
    if (cp >= 0x2060 && cp <= 0x2064) return false;
    if (cp >= 0xd800 && cp <= 0xdfff) return false;
    if (cp >= 0xe000 && cp <= 0xf8ff) return false;
    if (cp >= 0xfff9 && cp <= 0xfffb) return false;
    if (cp >= 0xfffe) return false;
    if (cp >= 0x2028 && cp <= 0x202f) return cp !== 0x2028 && cp !== 0x2029 ? false : true;
    return true;
}

/** CPython `repr(v)`：dict 用插入序（端口 dict 均为固定键序对象/Map）。 */
function pyRepr(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumRepr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Map) {
        const parts: string[] = [];
        for (const [k, val] of v) parts.push(`${pyReprKey(k)}: ${pyRepr(val)}`);
        return "{" + parts.join(", ") + "}";
    }
    if (typeof v === "object") {
        const parts: string[] = [];
        for (const [k, val] of Object.entries(v as PyDict)) parts.push(`${pyRepr(k)}: ${pyRepr(val)}`);
        return "{" + parts.join(", ") + "}";
    }
    return pyStr(v);
}

/** dict 键的 repr：整数键不带小数点。 */
function pyReprKey(k: unknown): string {
    if (typeof k === "number") return String(k);
    if (typeof k === "boolean") return k ? "True" : "False";
    return pyRepr(k);
}

/** python `dict.get(k[, default])`；非 dict 抛 CPython 同文案 AttributeError。 */
function dictGet(obj: unknown, key: string, def: unknown = null): unknown {
    if (obj === null || obj === undefined) {
        throw new AttributeErrorP("'NoneType' object has no attribute 'get'");
    }
    if (typeof obj !== "object" || Array.isArray(obj)) {
        // list/str/int/function 均无 .get —— CPython AttributeError
        throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    const d = obj as PyDict;
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : def;
}

/** python `list(x)`：可迭代展开（str→字符、dict→键），否则 TypeError。 */
function pyList(x: unknown): unknown[] {
    if (Array.isArray(x)) return x.slice();
    if (typeof x === "string") return Array.from(x);
    if (x instanceof Map) return [...x.keys()];
    if (x !== null && x !== undefined && typeof x === "object") {
        return Object.keys(x as PyDict);
    }
    throw new TypeErrorP(`'${pyTypeName(x)}' object is not iterable`);
}

/** python for-in 的迭代面（与 list() 同语法；供 enumerate/直接迭代用）。 */
function pyIterate(x: unknown): unknown[] {
    return pyList(x);
}

/** CPython float() 语义（含 str 语法：空白、nan/inf、下划线、"1."、指数）。 */
function pyFloat(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1.0 : 0.0;
    if (typeof v === "string") {
        const s = v.trim();
        for (let i = 0; i < s.length; i++) {
            if (s[i] === "_") {
                const before = i > 0 && s.charAt(i - 1) >= "0" && s.charAt(i - 1) <= "9";
                const after = i + 1 < s.length && s.charAt(i + 1) >= "0" && s.charAt(i + 1) <= "9";
                if (!before || !after) {
                    throw new ValueErrorP(`could not convert string to float: ${pyReprStr(v)}`);
                }
            }
        }
        const t = s.replace(/_/g, "");
        const low = t.toLowerCase();
        if (/^[+-]?nan$/.test(low)) return NaN;
        if (/^[+-]?(inf|infinity)$/.test(low)) {
            return low.startsWith("-") ? -Infinity : Infinity;
        }
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
            throw new ValueErrorP(`could not convert string to float: ${pyReprStr(v)}`);
        }
        return parseFloat(t);
    }
    throw new TypeErrorP(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** CPython str.replace(old, new)（全量非重叠）。 */
function pyStrReplace(s: string, from: string, to: string): string {
    return s.split(from).join(to);
}

// ── exact-decimal rounding helpers (CPython round() / %.2f / %.2%) ───────────

/** 把非负 double 精确展开成十进制：value = digits × 10^(-negExp)。 */
function exactDecimal(absValue: number): { digits: bigint; negExp: number } {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = absValue;
    const bits = new BigUint64Array(buf)[0] as bigint;
    const expBits = Number((bits >> 52n) & 0x7ffn);
    const frac = bits & ((1n << 52n) - 1n);
    let m: bigint, e: number;
    if (expBits === 0) { m = frac; e = -1074; }
    else { m = frac | (1n << 52n); e = expBits - 1075; }
    if (m === 0n) return { digits: 0n, negExp: 0 };
    if (e >= 0) return { digits: m << BigInt(e), negExp: 0 };
    let d = m;
    for (let i = 0; i < -e; i++) d *= 5n;
    return { digits: d, negExp: -e };
}

/** 对非负 double 的精确十进制值 round-half-even 到 ndigits 位，返回 ×10^ndigits 的 BigInt。 */
function roundHalfEvenAbs(value: number, ndigits: number): bigint {
    const { digits, negExp } = exactDecimal(value);
    const shift = negExp - ndigits;
    if (shift <= 0) return digits * 10n ** BigInt(-shift);
    const div = 10n ** BigInt(shift);
    const q = digits / div;
    const r = digits % div;
    const twice = r * 2n;
    if (twice > div) return q + 1n;
    if (twice < div) return q;
    return q % 2n === 0n ? q : q + 1n;
}

/** CPython `round(x, ndigits)`（float 输入；最近舍入、平局取偶；返回 double）。 */
export function pyRound(x: number, ndigits: number): number {
    if (!Number.isFinite(x)) return x;
    const neg = x < 0 || Object.is(x, -0); // CPython round(-0.0, 2) == -0.0
    const scaled = roundHalfEvenAbs(Math.abs(x), ndigits);
    const s = scaled.toString();
    let out: number;
    if (ndigits <= 0) out = Number(s) * 10 ** (-ndigits);
    else if (s.length <= ndigits) out = Number("0." + s.padStart(ndigits, "0"));
    else out = Number(s.slice(0, s.length - ndigits) + "." + s.slice(s.length - ndigits));
    return neg ? -out : out;
}

/** CPython `format(x, '.{n}f')`（精确值 half-even 的定长小数字符串）。 */
export function pyFormatFixed(x: number, ndigits: number): string {
    if (Number.isNaN(x)) return "nan";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    const neg = x < 0 || Object.is(x, -0);
    const scaled = roundHalfEvenAbs(Math.abs(x), ndigits);
    const s = scaled.toString();
    let out: string;
    if (ndigits === 0) out = s;
    else if (s.length <= ndigits) out = "0." + s.padStart(ndigits, "0");
    else out = s.slice(0, s.length - ndigits) + "." + s.slice(s.length - ndigits);
    return neg ? "-" + out : out;
}

/** CPython `format(x, '.2%')`：先 IEEE ×100（同一 double 乘法），再 %.2f。 */
export function pyFormatPercent2(x: number): string {
    if (Number.isNaN(x)) return "nan%";
    if (x === Infinity) return "inf%";
    if (x === -Infinity) return "-inf%";
    return pyFormatFixed(x * 100, 2) + "%";
}

// ── ntpath helpers ───────────────────────────────────────────────────────────

/** ntpath.join(base, sub)：sub 恒为私有相对段（见 DIVERGENCE makedirs/join 注）。 */
function pyJoinNT(base: string, sub: string): string {
    if (sub.startsWith("\\") || sub.startsWith("/")) return sub;
    if (base.endsWith("\\") || base.endsWith("/")) return base + sub;
    return base + "\\" + sub;
}

/** python `sep.join(seq)`：非 str 元素抛 `sequence item i: expected str, X found`。 */
function pyJoinSeq(sep: string, seq: unknown[]): string {
    seq.forEach((item, i) => {
        if (typeof item !== "string") {
            throw new TypeErrorP(`sequence item ${i}: expected str, ${pyTypeName(item)} found`);
        }
    });
    return (seq as string[]).join(sep);
}

// ── seams（测试注入面；默认实现 = 生产行为）─────────────────────────────────

export const TRIAD_SEAMS = {
    /** python `time.time()` */
    now: (): number => Date.now() / 1000,
    /** python `uuid.uuid4().hex[:8]` */
    uuidHex8: (): string => randomBytes(16).toString("hex").slice(0, 8),
    /** python `os.path.realpath`（非 str 输入抛 CPython 同文案 TypeError） */
    realpath: (p: unknown): string => {
        if (typeof p !== "string") {
            throw new TypeErrorP(`expected str, bytes or os.PathLike object, not ${pyTypeName(p)}`);
        }
        return nodeRealpath(p);
    },
    /** python `os.makedirs(p, exist_ok=True)` */
    makedirs: (p: string): void => { fs.mkdirSync(p, { recursive: true }); },
    /** python `from validator_registry import differential_validator`（Native→Rust，见 DIVERGENCE） */
    differentialValidator: (_spec: PyDict, _workspace: unknown): unknown => {
        throw new ModuleNotFoundErrorP("No module named 'validator_registry'");
    },
    /** python `logger`（f-string 已在调用侧完成插值，这里收最终串） */
    log: (level: "info" | "warning", msg: string): void => {
        if (level === "warning") console.error(`triad_runner: ${msg}`);
    },
};

export function _set_seams_for_parity(overrides: Partial<typeof TRIAD_SEAMS>): void {
    Object.assign(TRIAD_SEAMS, overrides);
}

const DEFAULT_SEAMS_SNAPSHOT: Partial<typeof TRIAD_SEAMS> = { ...TRIAD_SEAMS };
export function _reset_seams_for_parity(): void {
    Object.assign(TRIAD_SEAMS, DEFAULT_SEAMS_SNAPSHOT);
}

/**
 * DIVERGENCE(port, realpath): 默认实现 fs.realpathSync + ENOENT 兜底
 * （HANDOFF §10 坑 1 / plugin_registry pyRealpath 同款问题的最小化：CPython
 * realpath 对不存在路径静默规范化不报错，Node 抛 ENOENT；兜底分支只做分隔符
 * 规范化。探针侧该 seam 被记录型假件替换，默认实现仅保生产语义）。
 */
function nodeRealpath(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        const norm = p.replace(/[\\/]+/g, "\\");
        return norm.endsWith("\\") ? norm : norm.replace(/\\+$/g, "") || norm;
    }
}

// ── 数据结构 ────────────────────────────────────────────────────────────────

export interface BehavioralCaseInit {
    id?: string;
    description?: string;
    command?: string;
    actual_file?: string;
    expected?: string;
    expected_file?: string;
    weight?: number;
    masks?: unknown[];
    timeout_s?: number;
    subsystem?: string;
}

/** 一个独立的端到端行为测量用例。 */
export class BehavioralCase {
    id: string;
    description: string;
    command: string;
    actual_file: string;
    expected: string;
    expected_file: string;
    weight: number;
    masks: unknown[];
    timeout_s: number;
    subsystem: string;

    constructor(init: BehavioralCaseInit = {}) {
        this.id = init.id ?? "";
        this.description = init.description ?? "";
        this.command = init.command ?? "";
        this.actual_file = init.actual_file ?? "";
        this.expected = init.expected ?? "";
        this.expected_file = init.expected_file ?? "";
        this.weight = init.weight ?? 1.0;
        this.masks = init.masks ?? [];
        this.timeout_s = init.timeout_s ?? 60;
        this.subsystem = init.subsystem ?? "general";
    }

    to_dict(): PyDict {
        return {
            id: this.id,
            description: this.description,
            command: this.command,
            actual_file: this.actual_file,
            expected: this.expected,
            expected_file: this.expected_file,
            weight: this.weight,
            masks: this.masks,
            timeout_s: this.timeout_s,
            subsystem: this.subsystem,
        };
    }
}

export interface BehavioralInstrumentInit {
    instrument_id?: string;
    name?: string;
    target_component?: string;
    cases?: BehavioralCase[];
    threshold?: number;
    created_at?: number;
}

/** 一组由 Validator 构建的完备行为测量衡具。 */
export class BehavioralInstrument {
    instrument_id: string;
    name: string;
    target_component: string;
    cases: BehavioralCase[];
    threshold: number;
    created_at: number;

    constructor(init: BehavioralInstrumentInit = {}) {
        this.instrument_id = init.instrument_id ?? "";
        this.name = init.name ?? "";
        this.target_component = init.target_component ?? "";
        this.cases = init.cases ?? [];
        this.threshold = init.threshold ?? 0.90;
        // dataclass default_factory=time.time（FACT 12）
        this.created_at = init.created_at ?? TRIAD_SEAMS.now();
    }

    total_weight(): number {
        // sum(c.weight for c in self.cases) or 1.0
        let t = 0.0;
        for (const c of this.cases) t += c.weight;
        return pyTruthy(t) ? t : 1.0;
    }

    to_dict(): PyDict {
        return {
            instrumentId: this.instrument_id,
            name: this.name,
            targetComponent: this.target_component,
            cases: this.cases.map((c) => c.to_dict()),
            threshold: this.threshold,
            createdAt: this.created_at,
        };
    }
}

export interface DirectiveInit {
    directive_id?: string;
    subsystem?: unknown;
    issue_summary?: string;
    suggested_action?: string;
    severity?: string;
    failing_cases_count?: number;
}

/** Orchestrator 提炼的高阶语义修复指令（不泄露底层测试用例）。 */
export class Directive {
    directive_id: string;
    subsystem: unknown;
    issue_summary: string;
    suggested_action: string;
    severity: string;
    failing_cases_count: number;

    constructor(init: DirectiveInit = {}) {
        this.directive_id = init.directive_id ?? "";
        this.subsystem = init.subsystem ?? "";
        this.issue_summary = init.issue_summary ?? "";
        this.suggested_action = init.suggested_action ?? "";
        this.severity = init.severity ?? "medium"; // high | medium | low
        this.failing_cases_count = init.failing_cases_count ?? 1;
    }

    to_dict(): PyDict {
        return {
            directiveId: this.directive_id,
            subsystem: this.subsystem,
            issueSummary: this.issue_summary,
            suggestedAction: this.suggested_action,
            severity: this.severity,
            failingCasesCount: this.failing_cases_count,
        };
    }
}

export interface TriadEvaluationResultInit {
    passed?: boolean;
    score?: number;
    passed_weight?: number;
    total_weight?: number;
    directives?: Directive[];
    raw_failures?: PyDict[];
    evaluated_cases?: number;
    duration_ms?: number;
}

/** 一次完整的盲测评估报告。 */
export class TriadEvaluationResult {
    passed: boolean;
    score: number;
    passed_weight: number;
    total_weight: number;
    directives: Directive[];
    raw_failures: PyDict[];
    evaluated_cases: number;
    duration_ms: number;

    constructor(init: TriadEvaluationResultInit = {}) {
        this.passed = init.passed ?? false;
        this.score = init.score ?? 0.0;
        this.passed_weight = init.passed_weight ?? 0.0;
        this.total_weight = init.total_weight ?? 0.0;
        this.directives = init.directives ?? [];
        this.raw_failures = init.raw_failures ?? [];
        this.evaluated_cases = init.evaluated_cases ?? 0;
        this.duration_ms = init.duration_ms ?? 0.0;
    }

    to_dict(): PyDict {
        return {
            passed: this.passed,
            score: pyRound(this.score, 4),
            passedWeight: pyRound(this.passed_weight, 2),
            totalWeight: pyRound(this.total_weight, 2),
            directives: this.directives.map((d) => d.to_dict()),
            evaluatedCases: this.evaluated_cases,
            durationMs: pyRound(this.duration_ms, 2),
        };
    }
}

// ── 信息防线与衡具构建 ──────────────────────────────────────────────────────

/** 信息防线隔离器：确保 Implementer 无法直接读取私有测试套件。 */
export class TheWall {
    static readonly PRIVATE_SUBDIR = ".ovolve_private_instrument";

    static get_private_instrument_dir(workspace: unknown): string {
        const p = pyJoinNT(TRIAD_SEAMS.realpath(workspace), TheWall.PRIVATE_SUBDIR);
        TRIAD_SEAMS.makedirs(p); // FACT 11：取路径函数带建目录副作用（bug-for-bug）
        return p;
    }

    /** 剥离 Prompt 中可能意外泄露的私有测试用例断言。 */
    static sanitize_implementer_prompt(prompt_text: unknown): string {
        if (!pyTruthy(prompt_text)) return "";
        if (typeof prompt_text !== "string") {
            throw new AttributeErrorP(`'${pyTypeName(prompt_text)}' object has no attribute 'replace'`);
        }
        return pyStrReplace(prompt_text, TheWall.PRIVATE_SUBDIR, "<INTERNAL_EVAL>");
    }
}

/** 验证者角色：负责测量衡具的构建与盲测执行。 */
export class ValidatorEngine {
    /** 从规格说明或需求中解析/生成行为衡具。 */
    static build_instrument_from_spec(spec: unknown): BehavioralInstrument {
        const iid = `inst_${TRIAD_SEAMS.uuidHex8()}`; // FACT 12：先消耗 uuid 再解析
        const name = pyStr(pyOr(dictGet(spec, "name"), "behavioral_instrument"));
        const component = pyStr(pyOr(dictGet(spec, "target_component"), "core"));
        const threshold = pyFloat(pyOr(dictGet(spec, "threshold"), 0.90));

        const cases: BehavioralCase[] = [];
        const rawCases = pyIterate(pyOr(dictGet(spec, "cases"), []));
        rawCases.forEach((rc, i) => {
            const cid = pyStr(pyOr(dictGet(rc, "id"), `case_${i + 1}`));
            const desc = pyStr(pyOr(dictGet(rc, "description"), `Test behavior ${cid}`));
            const cmd = pyStr(pyOr(dictGet(rc, "command"), ""));
            const actFile = pyStr(pyOr(dictGet(rc, "actual_file"), ""));
            const exp = pyStr(pyOr(dictGet(rc, "expected"), ""));
            const expFile = pyStr(pyOr(dictGet(rc, "expected_file"), ""));
            const weight = pyFloat(pyOr(dictGet(rc, "weight"), 1.0));
            const masks = pyList(pyOr(dictGet(rc, "masks"), []));
            const subsys = pyStr(pyOr(dictGet(rc, "subsystem"), "general"));
            // FACT 2：源文件从不读 rc["timeout_s"]，永远用 dataclass 默认 60。
            cases.push(new BehavioralCase({
                id: cid,
                description: desc,
                command: cmd,
                actual_file: actFile,
                expected: exp,
                expected_file: expFile,
                weight,
                masks,
                subsystem: subsys,
            }));
        });

        return new BehavioralInstrument({
            instrument_id: iid,
            name,
            target_component: component,
            cases,
            threshold,
        });
    }

    /** 在工作区上盲测运行衡具，产出加权得分与失败轨迹。 */
    static evaluate(instrument: BehavioralInstrument, workspace: unknown): TriadEvaluationResult {
        const t0 = TRIAD_SEAMS.now();
        if (!pyTruthy(instrument.cases)) {
            return new TriadEvaluationResult({
                passed: true, score: 1.0, passed_weight: 1.0, total_weight: 1.0, evaluated_cases: 0,
            });
        }

        let passedWeight = 0.0;
        const totalWeight = instrument.total_weight();
        const rawFailures: PyDict[] = [];

        for (const case_ of instrument.cases) {
            const spec: PyDict = {
                name: case_.id,
                command: case_.command,
                actual_file: case_.actual_file,
                expected: case_.expected,
                expected_file: case_.expected_file,
                masks: case_.masks,
                timeout_s: case_.timeout_s,
            };
            const res = TRIAD_SEAMS.differentialValidator(spec, workspace);
            if (dictGet(res, "status") === "passed") {
                passedWeight += case_.weight;
            } else {
                rawFailures.push({
                    case_id: case_.id,
                    subsystem: case_.subsystem,
                    description: case_.description,
                    status: dictGet(res, "status"),
                    evidence: dictGet(res, "evidence", []),
                    weight: case_.weight,
                });
            }
        }

        const score = (totalWeight as number) > 0 ? passedWeight / (totalWeight as number) : 1.0;
        const passed = score >= (instrument.threshold - 1e-6);
        const dur = (TRIAD_SEAMS.now() - t0) * 1000;

        // 将失败送入 Orchestrator 提炼 Directives
        const directives = OrchestratorEngine.synthesize_directives(rawFailures);

        return new TriadEvaluationResult({
            passed,
            score,
            passed_weight: passedWeight,
            total_weight: totalWeight,
            directives,
            raw_failures: rawFailures,
            evaluated_cases: instrument.cases.length,
            duration_ms: dur,
        });
    }
}

/** 编排者角色：过滤噪声，将底层测试失败升维为高阶语义指令 (Directives)。 */
export class OrchestratorEngine {
    /** 将离散的测试失败按子系统与失败模式聚类，生成对 Implementer 友好的语义指令。 */
    static synthesize_directives(rawFailures: unknown): Directive[] {
        if (!pyTruthy(rawFailures)) return [];

        // 按 subsystem 分组：插入序 + CPython dict 键相等语义（True==1、1.0==1 并入同组，
        // 保留先插入的键；见 FACT 9 与头注 DIVERGENCE dict order）
        const grouped: Array<{ key: unknown; bucket: PyDict[] }> = [];
        for (const f0 of pyIterate(rawFailures)) {
            // 非 dict 元素在这里走 dictGet → CPython 同文案 AttributeError（FACT 9）
            const f = f0 as PyDict;
            const sub = pyOr(dictGet(f, "subsystem"), "general");
            if (Array.isArray(sub) || (sub !== null && typeof sub === "object")) {
                throw new TypeErrorP(`unhashable type: '${pyTypeName(sub)}'`);
            }
            const hit = grouped.find((g) => pyKeyEq(g.key, sub));
            if (hit) hit.bucket.push(f);
            else grouped.push({ key: sub, bucket: [f] });
        }

        const directives: Directive[] = [];
        for (const entry of grouped) {
            const subsys = entry.key;
            const fails = entry.bucket;
            const did = `dir_${TRIAD_SEAMS.uuidHex8()}`;
            const count = fails.length;

            // 提炼公共失败特征（前 3 条中 truthy description 原样收集——源文件不 str()，
            // 非 str truthy 会在 join 处抛 CPython 同文案 TypeError，FACT 9）
            const sampleDescs: unknown[] = [];
            for (const f of fails.slice(0, 3)) {
                const d = dictGet(f, "description", "");
                if (pyTruthy(d)) sampleDescs.push(d);
            }
            const summary = `Subsystem '${pyStr(subsys)}' 行为偏离 (${pyStr(count)} 个用例未达标): `
                + pyJoinSeq("; ", sampleDescs);

            // 确定严重度
            let totalFailWeight = 0.0;
            for (const f of fails) totalFailWeight += pyFloat(pyOr(dictGet(f, "weight"), 1.0));
            const sev = totalFailWeight >= 3.0 || count >= 3 ? "high" : "medium";

            // 构造高阶修复建议：判定读的是整个失败列表的 CPython repr 小写串（FACT 9）
            const failsLower = pyRepr(fails).toLowerCase();
            let action: string;
            if (failsLower.includes("timeout")) {
                action = `优化 ${pyStr(subsys)} 的处理性能与大输入耗时，增加分批或边界检查。`;
            } else if (failsLower.includes("not found") || failsLower.includes("missing")) {
                action = `补齐 ${pyStr(subsys)} 模块所缺少的核心功能分支、输出格式或文件协议支持。`;
            } else {
                action = `对照系统行为预期，修正 ${pyStr(subsys)} 在参数解析、边界条件处理及输出格式上的逻辑缺陷。`;
            }

            directives.push(new Directive({
                directive_id: did,
                subsystem: subsys,
                issue_summary: summary,
                suggested_action: action,
                severity: sev,
                failing_cases_count: count,
            }));
        }

        // 按严重度排序（稳定：与 CPython list.sort 一致）
        directives.sort((a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1));
        return directives;
    }
}

/** 三权分立闭环协调器 (Triad Runner). */
export class TriadRunner {
    workspace: string;

    constructor(workspace: unknown) {
        this.workspace = TRIAD_SEAMS.realpath(workspace);
    }

    /** 执行多轮盲测-指令化迭代。 */
    run_cycle(
        instrument: BehavioralInstrument,
        implementerActionFn: unknown = null,
        maxRounds: unknown = 5,
    ): [boolean, TriadEvaluationResult[]] {
        const resultsHistory: TriadEvaluationResult[] = [];
        // range(1, max_rounds + 1)（FACT 10）：先 +1（可能 TypeError），再整型校验
        const stop = pyRangeStop(maxRounds);

        for (let roundIdx = 1; roundIdx < stop; roundIdx++) {
            TRIAD_SEAMS.log("info",
                `[Triad] Round ${pyStr(roundIdx)}/${pyStr(maxRounds)} starting blind evaluation...`);
            const evalRes = ValidatorEngine.evaluate(instrument, this.workspace);
            resultsHistory.push(evalRes);

            TRIAD_SEAMS.log("info",
                `[Triad] Round ${pyStr(roundIdx)} score: ${pyFormatPercent2(evalRes.score)}, `
                + `passed: ${evalRes.passed ? "True" : "False"}, directives: ${pyStr(evalRes.directives.length)}`);

            if (evalRes.passed) {
                TRIAD_SEAMS.log("info", "[Triad] Standard of completion achieved!");
                return [true, resultsHistory];
            }

            if (pyTruthy(implementerActionFn)) {
                // 下发指令给 Implementer 进行独立修复（不泄露 raw cases）
                // FACT 10：调用在 try 内——不可调用 TypeError 也被捕获臂接住。
                try {
                    if (typeof implementerActionFn !== "function") {
                        throw new TypeErrorP(`'${pyTypeName(implementerActionFn)}' object is not callable`);
                    }
                    (implementerActionFn as (directives: Directive[], workspace: string) => unknown)(
                        evalRes.directives, this.workspace);
                } catch (exc) {
                    TRIAD_SEAMS.log("warning",
                        `[Triad] Implementer execution error in round ${pyStr(roundIdx)}: ${pyStrOfExc(exc)}`);
                }
            } else {
                // 无自动修复函数时返回首轮结果
                break;
            }
        }

        return [false, resultsHistory];
    }
}

/** python f-string `{exc}` 的取串语义：str(Exception) == message。 */
function pyStrOfExc(exc: unknown): string {
    if (exc instanceof Error) return exc.message;
    return pyStr(exc);
}

/**
 * range(1, max_rounds + 1) 的 CPython 语义切片：先 +1（可能 TypeError），再 __index__ 校验。
 * 实测本机 CPython 3.13.12：`range(1, float("inf"))` 抛 **TypeError**
 * （"'float' object cannot be interpreted as an integer"），**不是** OverflowError ——
 * OverflowError 只在 `int(float("inf"))` 那条路上出现，本模块没有那种调用点。
 * 所以 ±inf 与 nan 一样，一律落到下面的非整 TypeError 分支。
 */
function pyRangeStop(maxRounds: unknown): number {
    const stop = pyAddInt(maxRounds, 1);
    if (!Number.isInteger(stop)) {
        throw new TypeErrorP(`'${pyTypeName(stop)}' object cannot be interpreted as an integer`);
    }
    return stop;
}

/** python `x + 1`（max_rounds + 1）：数值/bool 支持，str/list 走自身 __add__ 文案，其余 TypeError。 */
function pyAddInt(v: unknown, n: number): number {
    if (typeof v === "number") return v + n;
    if (typeof v === "boolean") return (v ? 1 : 0) + n;
    // 实测本机 CPython 3.13.12（tmp/w220_inf_check.py）：`'3' + 1` 走 str.__add__，
    // 文案是 `can only concatenate str (not "int") to str`，**不是**通用的
    // `unsupported operand type(s) for +: 'str' and 'int'`（那是 None/dict 那条路）。
    // 端口原先把 str 归到通用文案，属于自造措辞，现按实测逐字修正。
    if (typeof v === "string") throw new TypeErrorP(`can only concatenate str (not "int") to str`);
    if (Array.isArray(v)) throw new TypeErrorP(`can only concatenate list (not "int") to list`);
    throw new TypeErrorP(`unsupported operand type(s) for +: '${pyTypeName(v)}' and 'int'`);
}

// PORT STATUS: 本文件无 TODO(port)。
