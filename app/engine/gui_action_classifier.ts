/**
 * gui_action_classifier.ts — GUI/浏览器动作分级器：工具+参数 → 级别 + 风险旗标。
 *
 * Ported from `app/backend/gui_action_classifier.py` (677 lines, wave-5 TS).
 *
 * ## 解决什么
 *
 * COMMAND 层回答的是"这段 shell 文本多危险"；Computer Use / Browser 类工具没有
 * 命令文本，危险藏在**动作语义**里：同样是 `click`，点空白处和点「确认支付」
 * 天差地别；同样是 `fill`，填搜索框和填密码框是两回事。本模块补上这一维，
 * 作为策略管道的第二个人工检查面（与 COMMAND 层同挂 COMMAND 管道段，先到先裁）。
 *
 * ## 级别模型（三档，动作语义解耦于权限档位）
 *
 *     HANDOFF    移交人类——这类动作**就不该由代理执行**（解验证码、绕安全提示）。
 *                对应管道 DENY：驳回并在理由里告诉模型"让用户亲手做"。
 *     CONFIRM    当场必确认——删除类点击、凭证输入、页面代码执行、金融动作。
 *                同样映射 DENY（复用 RESTRICTED 的"单次人工批准"语义）。
 *     AWARE      知情确认——提交/发布/安装类。映射 ASK：走正常审批条。
 *     OK         无文本证据——弃权（裸 click/scroll/screenshot 不抬级）。
 *
 * 只看**参数文本里的机械证据**（selector/value/text/url/key 的关键词与正则），
 * 不做页面理解。误报代价是一次多余的确认；漏报代价不可接受——规则表向
 * "宁可多问"倾斜。每条规则带 why，和 command_classifier 同一份纪律。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/gui_action_classifier.py -> app/engine/gui_action_classifier.ts.
 *       Public python names (snake_case) and dataclass field names kept verbatim.
 *   §2  `class Tier(str, Enum)` — same finding as tool_policy/command_classifier:
 *       CPython 3.13 hashes a str-Enum member by VALUE, so plain string constants
 *       carry every `==` / dict-key / `is`-between-members behaviour. `to_dict()`
 *       reads `self.tier.value`, so a NON-member still crashes with python's
 *       AttributeError text (enumValue). `_coerce_tier` normalises a bare str via
 *       `Tier(v.strip().lower())` and returns a member, so the member-vs-literal
 *       distinction never reaches an output — see the identity argument below.
 *   §2  every truth gate goes through pyTruth / the `.trim()` idiom:
 *       `if self.match_all and not self.keywords`, `if rule.why:`,
 *       `if tool not in GUI_TOOLS or not isinstance(args, dict)`, `v.strip()`,
 *       `str(confirmation_class or "standard") ... or "standard"`, `bool(pre_approved)`.
 *   §2  dataclass defaults fire only when the argument is OMITTED: `GUIActionVerdict`
 *       `field(default_factory=list)` allocates a FRESH list per instance; the
 *       options-object constructor maps `undefined` (omitted) -> default, while an
 *       explicit null really stores null. Same for Rule/ScenarioRule plain defaults
 *       (tools/arg_keys/regex None, keywords/cjk (), why "", match_all False).
 *   §2  regex word boundaries: python `\b` is unicode-aware (word = str.isalnum()
 *       or "_"), JS `\b` is ASCII-only. This module's whole design leans on that:
 *       the docstring pins "ASCII 词进正则（保留 \b），CJK 词一律子串匹配". pyRe()
 *       rewrites every `\b` into the position-equivalent lookaround pair over
 *       [\p{L}\p{N}_] and turns on `u`, so a CJK-adjacent ASCII keyword such as
 *       "确认delete" behaves like python (no boundary between 认 and d) rather than
 *       over-matching like raw JS `\b`.
 *   §2  present-but-null: `args.get(k)` returns a stored null, not the default —
 *       dictGet; a non-dict receiver raises AttributeError (getAttr/dictValues).
 *   §2  `req.context[KEY] = ...` on a non-mapping context (None, a list) raises
 *       TypeError and the surrounding except swallows it, so the audit entry is
 *       skipped. setItem() reproduces the raise before JS would hang a prop off an array.
 *   §2  `_TIER_STRENGTH[ta]` keys a dict by Tier members; str-Enum hashes them by
 *       value, so a value-keyed Record is equivalent.
 *   §2  the corpus is `"\n".join(texts)[:_MAX_CORPUS_CHARS].lower()`; the slice is
 *       a python code-point slice and `.lower()` is python str.lower. See the
 *       DIVERGENCE(port) notes below for the two places where JS differs.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, enum identity): python distinguishes the member `Tier.HANDOFF`
 *       from the literal "handoff" via `is`/isinstance; here they are one value.
 *       Equivalence argument: every tier reaching a comparison is assigned from the
 *       exported constants or produced by _coerce_tier (which returns a member
 *       value), so each `is`/`===` only ever sees members; a hand-written raw
 *       literal still dies in to_dict() with python's own AttributeError text. Only
 *       a caller that bypassed the constants would see a difference; none in this
 *       tree does. Pinned as SKIP(repr-divergent) where a probe checks identity.
 *   DIVERGENCE(port, whitespace): python str.strip() removes only isspace() chars
 *       (U+0085 NEL is whitespace to python but not to JS \s, and U+00A0/U+FEFF are
 *       the reverse for trim). Used only to test "is this field blank / does it
 *       carry evidence"; no shipped rule keys on the boundary chars, so behaviour
 *       matches for every input the classifier actually sees. Documented, not exercised.
 *   DIVERGENCE(port, corpus slice + lower): JS `.slice(0,20000)` counts UTF-16 code
 *       units while python `[:20000]` counts code points, and JS `.toLowerCase()`
 *       differs from python `.lower()` for a few special-cased Unicode scalars
 *       (e.g. 'İ'). Both only bite when the corpus exceeds 20k units / contains such
 *       scalars straddling the cut — outside the mechanical-keyword regime this
 *       classifier targets. Pinned, not exercised.
 *   DIVERGENCE(port, dict key order): JS reorders integer-like string keys ahead of
 *       insertion order; python dicts always preserve insertion order. _walk_texts
 *       appends keys in iteration order, so an integer-like param key could surface
 *       earlier in the corpus here. Observable only through the 20k truncation edge.
 *       Non-string keys (an int key) can never reach this layer (JSON params only).
 *   The per-rule `try/except Exception` in classify_action and the context-write
 *   `try/except` in the layer stay broad swallows — "单条规则坏了不拖垮整体——
 *   宁缺勿崩" — so no error escapes classify_action / the layer.
 *   The import-time asserts in the python module (rule/table coherence) become
 *   module-load guard IIFEs that throw on drift; with the tables as written they
 *   never fire, but the invariant is preserved rather than dropped.
 */

import {
    PolicyAction,
    PolicyDecision,
    PolicyLayer,
    type PolicyLayerFn,
    type PolicyRequest,
} from "./tool_policy.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class AttributeErrorP extends Error {
    constructor(obj: unknown, attr = "value") {
        super(`'${pyTypeName(obj)}' object has no attribute '${attr}'`);
        this.name = "AttributeError";
    }
}

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
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
    if (typeof v === "function") return v.name || "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python `dict.get(key, dflt)`: present-but-null returns null, not dflt. */
function dictGet(dict: unknown, key: string, dflt: unknown = null): unknown {
    if (dict !== null && typeof dict === "object" && !Array.isArray(dict) &&
        key in (dict as Record<string, unknown>)) {
        return (dict as Record<string, unknown>)[key];
    }
    return dflt;
}

/** python `obj.get(key)` / `obj.values()` as an ATTRIBUTE access: non-dict raises. */
function getAttr(obj: unknown, key: string): unknown {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        throw new AttributeErrorP(obj, "get");
    }
    return dictGet(obj, key);
}

function dictValues(obj: unknown): unknown[] {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        throw new AttributeErrorP(obj, "values");
    }
    return Object.values(obj as JsonDict);
}

/** python `tuple(iterable)` / `for x in v`: arrays, strings (chars), Set, Map(keys),
 *  plain objects (keys). Non-iterables raise the python TypeError. */
function pyIter(v: unknown): unknown[] {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (v instanceof Set) return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (v !== null && typeof v === "object") return Object.keys(v as object);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `obj[key] = value`: only mappings accept a string key; a list or None
 *  raises TypeError (the one call site swallows it, so the write is SKIPPED). */
function setItem(obj: unknown, key: string, val: unknown): void {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        throw new TypeErrorP(`'${pyTypeName(obj)}' object does not support item assignment`);
    }
    (obj as JsonDict)[key] = val;
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    return pyStr(v);
}

/** python `str(x)` (containers render through repr). */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number" || typeof v === "string") return String(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "set(" + (v.size ? "{...}" : "()") + ")";
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
}

/**
 * python's `\b` is unicode-aware, JS's is ASCII-only. Rewrite every `\b` into
 * the position-equivalent lookaround pair over python's word class (letters,
 * numbers, underscore) and compile with `u` so \p{...} works.
 */
const WORD = "[\\p{L}\\p{N}_]";
const BOUNDARY = "(?:(?<=" + WORD + ")(?!" + WORD + ")|(?<!" + WORD + ")(?=" + WORD + "))";
function pyRe(source: string, flags = ""): RegExp {
    return new RegExp(source.split("\\b").join(BOUNDARY), "u" + flags);
}

type JsonDict = Record<string, unknown>;

/** python `x.value` on a `str`-Enum member: non-members raise AttributeError. */
function enumValue(v: string, domain: Set<string>): string {
    if (typeof v === "string" && domain.has(v)) return v;
    throw new AttributeErrorP(v);
}

// ── 级别模型 ─────────────────────────────────────────────────────────────────

/** GUI 动作的语义定级。OK 不产生裁决；AWARE→ASK；CONFIRM/HANDOFF→DENY。 */
export const Tier = {
    OK: "ok",
    AWARE: "aware",
    CONFIRM: "confirm",
    HANDOFF: "handoff",
} as const;
export type TierValue = (typeof Tier)[keyof typeof Tier];

const TIER_VALUES = new Set<string>(Object.values(Tier));

// ── 风险旗标 ─────────────────────────────────────────────────────────────────

/** 风险旗标（与级别正交：填密码框同时带 sensitive-data + form-input 两个旗标） */
export const FLAG_SENSITIVE_DATA = "sensitive-data";
export const FLAG_DESTRUCTIVE = "gui-destructive";
export const FLAG_THIRD_PARTY = "third-party-communication";
export const FLAG_FINANCIAL = "financial-action";
export const FLAG_ACCOUNT = "account-management";
export const FLAG_INSTALL = "software-install";
export const FLAG_PAGE_CODE_EXEC = "page-code-exec";
export const FLAG_CAPTCHA = "captcha";
export const FLAG_SAFETY_BYPASS = "safety-bypass";
export const FLAG_SYSTEM_SETTINGS = "system-settings";

// ── 规则 ─────────────────────────────────────────────────────────────────────

export interface RuleOptions {
    tools?: Set<string> | null;
    arg_keys?: string[] | null;
    keywords?: string[] | null;
    regex?: RegExp | null;
    why?: string;
    match_all?: boolean;
}

/** 一条动作分级规则 = 适用工具 + 证据形态 + 级别 + 理由。 */
export class Rule {
    rule_id: string;
    flag: string;
    tier: TierValue;
    // None = 适用于全部 GUI 工具；否则只查这些工具的参数
    tools: Set<string> | null;
    // 只扫描这些参数键的值（None = 扫描全部字符串参数拼接）
    arg_keys: string[] | null;
    keywords: string[];
    regex: RegExp | null;
    why: string;
    // 工具级全匹配：该工具的任何调用都命中（如 evaluate——在页面里执行任意
    // JS 这个行为本身就是风险，与内容无关）。与 keywords/regex 互斥使用。
    match_all: boolean;

    // dataclass kwargs map to an options object; `undefined` (omitted) fires the
    // python default, an explicit null really stores null.
    constructor(rule_id: string, flag: string, tier: TierValue, opts: RuleOptions = {}) {
        this.rule_id = rule_id;
        this.flag = flag;
        this.tier = tier;
        this.tools = opts.tools === undefined ? null : opts.tools;
        this.arg_keys = opts.arg_keys === undefined ? null : opts.arg_keys;
        this.keywords = opts.keywords === undefined ? [] : opts.keywords as string[];
        this.regex = opts.regex === undefined ? null : opts.regex;
        this.why = opts.why === undefined ? "" : opts.why;
        this.match_all = opts.match_all === undefined ? false : opts.match_all;
    }

    hit(tool: string, texts: string[]): boolean {
        if (this.tools !== null && !this.tools.has(tool)) return false;
        if (this.match_all && !pyTruth(this.keywords) && this.regex === null) return true;
        const joined = texts.join("\n").toLowerCase();
        for (const kw of this.keywords) {
            if (joined.includes(kw)) return true;
        }
        if (this.regex !== null && this.regex.test(joined)) return true;
        return false;
    }
}

// ── HANDOFF：代理就不该做，驳回并移交 ─────────────────────────────────────────
const _H: TierValue = Tier.HANDOFF;

export const _HANDOFF_RULES: Rule[] = [
    new Rule("GA-CAP-01", FLAG_CAPTCHA, _H,
        { keywords: ["captcha", "recaptcha", "hcaptcha", "验证码", "人机验证"],
          why: "解验证码违背人机验证的存在目的，且多数服务条款明确禁止自动化求解" }),
    new Rule("GA-SB-01", FLAG_SAFETY_BYPASS, _H,
        { keywords: ["绕过", "不安全", "继续访问"],
          regex: pyRe("\\b(bypass|proceed (anyway|link)|unsafe|interstitial|" +
              "accept.?risk|ignore.?warning)\\b"),
          why: "绕过浏览器/系统安全提示（HTTPS 警告、风险拦截页）属于安全屏障类动作，必须由用户亲手决策" }),
];

// ── CONFIRM：可以做，但每次都要当场单独确认（单次批准语义） ───────────────────
const _C: TierValue = Tier.CONFIRM;

export const _CONFIRM_RULES: Rule[] = [
    new Rule("GA-EX-01", FLAG_PAGE_CODE_EXEC, _C,
        { tools: new Set(["evaluate"]), match_all: true,
          why: "在页面里执行任意 JS——能绕过 UI 层的一切确认直接改状态，必须单独确认" }),
    new Rule("GA-CR-01", FLAG_SENSITIVE_DATA, _C,
        { arg_keys: ["value", "text"],
          regex: pyRe("^(.{0,4}(password|passwd|pwd|passwort|密码|口令)|" +
              "(?<!\\d)\\d{6}\\s*$|" +
              "(api[_-]?key|secret|token|credential|私钥|访问令牌))"),
          why: "检测到凭证形态的输入（密码/6位OTP/密钥令牌）——输入即传输，泄露不可撤回" }),
    new Rule("GA-CR-02", FLAG_SENSITIVE_DATA, _C,
        { arg_keys: ["selector"],
          keywords: ["password", "passwd", "pwd", "otp", "密码", "口令", "验证码输入"],
          why: "目标是密码/OTP 类输入框——字段语义即敏感，无论填什么内容" }),
    new Rule("GA-FI-01", FLAG_FINANCIAL, _C,
        { keywords: ["支付", "付款", "确认订单", "提交订单"],
          regex: pyRe("\\b(place[-\\s]?order|confirm[-\\s]?payment|pay[-\\s]?now|checkout|" +
              "complete[-\\s]?purchase)\\b"),
          why: "金融交易确认动作——误触的代价是真金白银" }),
    new Rule("GA-DL-01", FLAG_DESTRUCTIVE, _C,
        { keywords: ["永久删除", "清空", "格式化", "注销账号", "delete account"],
          regex: pyRe("\\b(delete|permanently remove|empty trash|format)\\b"),
          why: "GUI 上的删除/注销类动作——对话框挡不住误触，删除通常不可撤回" }),
    new Rule("GA-ST-01", FLAG_SYSTEM_SETTINGS, _C,
        { tools: new Set(["app_launch"]), arg_keys: ["name"],
          keywords: ["regedit", "secpol", "gpedit", "control", "services.msc",
              "组策略", "服务管理"],
          why: "直接拉起系统配置/注册表/策略编辑器——改坏系统状态 recovery 成本极高" }),
];

// ── AWARE：知情确认即可，用户可以选"以后都允许"做持久预批准 ──────────────────
const _A: TierValue = Tier.AWARE;

export const _AWARE_RULES: Rule[] = [
    new Rule("GA-CM-01", FLAG_THIRD_PARTY, _A,
        { keywords: ["发布", "发送", "提交", "回复", "上传"],
          regex: pyRe("\\b(post|publish|send|tweet|reply|submit form)\\b"),
          why: "对外发布/提交类动作——内容一旦离开本机就进入第三方管辖" }),
    new Rule("GA-AC-01", FLAG_ACCOUNT, _A,
        { keywords: ["注册", "创建账号", "授权"],
          regex: pyRe("\\b(create[-\\s]?account|sign[-\\s]?up|register|" +
              "grant[-\\s]?(access|permission))\\b"),
          why: "账号创建/授权动作建立持久关系，事后清理成本高" }),
    new Rule("GA-IN-01", FLAG_INSTALL, _A,
        { keywords: ["安装", "添加扩展", "添加插件"],
          regex: pyRe("\\b(install|add extension|add.?ons|setup\\.exe)\\b"),
          why: "安装软件/扩展建立持久的本机信任关系" }),
];

export const _ALL_RULES: Rule[] = _HANDOFF_RULES.concat(_CONFIRM_RULES, _AWARE_RULES);

// ── 裁决产物 ──────────────────────────────────────────────────────────────────

/** 一次动作分级的完整产物。to_dict 的键与 CommandVerdict 对齐。 */
export class GUIActionVerdict {
    tier: TierValue;
    flags: string[];
    matched: string[];   // rule ids
    hosts: string[];     // 未用，形状对齐
    segments: number;    // 未用，形状对齐
    reasons: string[];

    constructor(tier: TierValue, opts: {
        flags?: string[] | null; matched?: string[] | null; hosts?: string[] | null;
        segments?: number; reasons?: string[] | null;
    } = {}) {
        // field(default_factory=list) allocates a FRESH list per instance and fires
        // only when the argument is OMITTED.
        this.tier = tier;
        this.flags = opts.flags === undefined ? [] : opts.flags as string[];
        this.matched = opts.matched === undefined ? [] : opts.matched as string[];
        this.hosts = opts.hosts === undefined ? [] : opts.hosts as string[];
        this.segments = opts.segments === undefined ? 0 : opts.segments;
        this.reasons = opts.reasons === undefined ? [] : opts.reasons as string[];
    }

    to_dict(): JsonDict {
        return {
            "tier": enumValue(this.tier, TIER_VALUES),
            "flags": this.flags,
            "matched": this.matched,
            "hosts": this.hosts,
            "segments": this.segments,
            "reasons": this.reasons,
        };
    }

    get is_handoff(): boolean {
        return this.tier === Tier.HANDOFF;
    }

    get needs_confirm(): boolean {
        return this.tier === Tier.CONFIRM;
    }

    get needs_awareness(): boolean {
        return this.tier === Tier.AWARE;
    }
}

// ── 工具集与观察类 ────────────────────────────────────────────────────────────

/** GUI/浏览器动作类工具全集（与 tool_catalog 的 CORE_TOOL_NAMES 对应子集） */
export const GUI_TOOLS = new Set<string>([
    // Computer Use（桌面）
    "computer_screenshot", "computer_click", "computer_move_cursor",
    "computer_type", "computer_press_key", "computer_scroll", "computer_drag",
    "app_launch", "window_focus",
    // Browser（浏览器）
    "navigate", "snapshot", "click", "fill", "evaluate",
]);

/** 纯观察类动作——永远弃权（截图/快照/滚动/移动光标不改变任何状态） */
export const _OBSERVATION_TOOLS = new Set<string>([
    "computer_screenshot", "computer_move_cursor", "computer_scroll",
    "snapshot", "navigate", "window_focus",
]);

/** 按规则声明的参数键收集证据文本；未声明则收集全部字符串值。 */
export function _arg_texts(tool: string, args: unknown, rule: Rule): string[] {
    if (rule.arg_keys !== null) {
        const vals = rule.arg_keys.map((k) => getAttr(args, k));
        return vals.filter((v) => typeof v === "string" && pyTruth((v as string).trim())) as string[];
    }
    const out: string[] = [];
    for (const v of dictValues(args)) {
        if (typeof v === "string" && pyTruth(v.trim())) {
            out.push(v);
        } else if (Array.isArray(v)) {
            for (const x of v) {
                if (typeof x === "string" && pyTruth(x.trim())) out.push(x);
            }
        }
    }
    return out;
}

/** 对一个 GUI/浏览器动作做完整分级。纯函数；畸形输入→OK 空旗标。 */
export function classify_action(tool: string, args: unknown): GUIActionVerdict {
    const verdict = new GUIActionVerdict(Tier.OK);
    if (!GUI_TOOLS.has(tool) || args === null || typeof args !== "object" || Array.isArray(args)) {
        return verdict;
    }
    if (_OBSERVATION_TOOLS.has(tool)) return verdict;  // 纯观察动作不抬级——看一眼不改变世界

    for (const rule of _ALL_RULES) {
        try {
            const texts = _arg_texts(tool, args, rule);
            if (rule.hit(tool, texts)) {
                if (!verdict.flags.includes(rule.flag)) verdict.flags.push(rule.flag);
                verdict.matched.push(rule.rule_id);
                if (pyTruth(rule.why)) verdict.reasons.push(rule.why);
                if (rule.tier === Tier.HANDOFF) {
                    verdict.tier = Tier.HANDOFF;
                } else if (rule.tier === Tier.CONFIRM && verdict.tier !== Tier.HANDOFF) {
                    verdict.tier = Tier.CONFIRM;
                } else if (rule.tier === Tier.AWARE && verdict.tier === Tier.OK) {
                    verdict.tier = Tier.AWARE;
                }
            }
        } catch {
            continue;  // 单条规则坏了不拖垮整体——宁缺勿崩
        }
    }
    return verdict;
}

// ── 策略管道层 ────────────────────────────────────────────────────────────────

/** 分级结果在 request.context 里的缓存键——与命令分级共用同一个前端展示通道。 */
export const _CONTEXT_VERDICT_KEY = "_command_verdict";

/** GUI 动作层：语义分级 → HANDOFF/CONFIRM→DENY、AWARE→ASK。 */
export function make_gui_action_guard_layer(): PolicyLayerFn {
    return function _layer(req: PolicyRequest): PolicyDecision | null {
        if (!GUI_TOOLS.has(req.tool_name)) return null;
        const verdict = classify_action(req.tool_name, pyOr(req.args, {}));
        if (verdict.tier === Tier.OK) return null;
        try {
            setItem(req.context, _CONTEXT_VERDICT_KEY, verdict.to_dict());
        } catch {
            /* context 不可写只丢审计，不影响裁决 */
        }

        if (verdict.is_handoff) {
            return new PolicyDecision(
                PolicyAction.DENY,
                PolicyLayer.COMMAND,
                "action-guard:handoff",
                "这类动作需要用户亲手执行（" + verdict.reasons.slice(0, 3).join("；") + "）",
            );
        }
        if (verdict.needs_confirm) {
            return new PolicyDecision(
                PolicyAction.DENY,
                PolicyLayer.COMMAND,
                "action-guard:confirm",
                "每次执行都需要当场单独确认，预批准不适用（" +
                    verdict.reasons.slice(0, 3).join("；") + "）",
            );
        }
        return new PolicyDecision(
            PolicyAction.ASK,
            PolicyLayer.COMMAND,
            "action-guard:aware",
            "动作需要知情确认（" + verdict.reasons.slice(0, 3).join("；") + "）",
        );
    };
}

/** 从工具上下文里取回本次动作分级（审计/展示用）。 */
export function last_verdict(context: unknown): JsonDict | null {
    if (context === null || typeof context !== "object" || Array.isArray(context)) return null;
    const v = dictGet(context, _CONTEXT_VERDICT_KEY);
    return (v !== null && typeof v === "object" && !Array.isArray(v)) ? v as JsonDict : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 确认政策分类学（Confirmation Taxonomy）—— U2 第一阶段
//
// 前半回答"这个动作裸看有多危险"（classify_action）；本节回答"这个动作踩到了
// 哪个雷区"（场景标签）。两条正交轴：confirmation_class（粗分类）与
// scenario_tags（参数语料命中的雷区标签）。合成定律：
//     最终档 = escalate_tiers(场景地板, 裸档)
// 反注入纪律：预批准的发言权只属于用户本人（见 PRE_APPROVAL_SOURCES）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 场景标签全集。顺序即契约：detect_scenario_tags 的输出严格按此序排列。 */
export const SCENARIO_TAGS: string[] = [
    "deletion", "credential", "finance", "third_party_comm", "system_security",
    "captcha", "software_install", "sensitive_transmission", "medical",
];

export interface ScenarioRuleOptions {
    pattern?: RegExp | null;
    cjk?: string[] | null;
}

/** 一条场景判定规则 = 场景标签 + ASCII 正则 + CJK 关键词。 */
export class ScenarioRule {
    tag: string;
    pattern: RegExp | null;   // 在小写化语料上匹配的 ASCII 词
    cjk: string[];            // CJK 关键词子串

    constructor(tag: string, opts: ScenarioRuleOptions = {}) {
        this.tag = tag;
        this.pattern = opts.pattern === undefined ? null : opts.pattern;
        this.cjk = opts.cjk === undefined ? [] : opts.cjk as string[];
    }
}

export const _SCENARIO_RULES: ScenarioRule[] = [
    new ScenarioRule("deletion", {
        pattern: pyRe("\\b(delete|deleted|deleting|deletion|remove|removed|erase|wipe|purge|" +
            "trash|uninstall|format|empty (the )?(trash|recycle[ -]?bin))\\b"),
        cjk: ["删除", "删掉", "清空", "清除", "抹掉", "格式化", "注销", "销毁", "卸载"],
    }),
    new ScenarioRule("credential", {
        pattern: pyRe("\\b(password|passwd|pwd|passphrase|passcode|api[-_ ]?key|apikey|secret|" +
            "token|credential|private[ -]?key|access[ -]?key|login|log[ -]?in|" +
            "sign[ -]?in|signin|otp|2fa|two[ -]?factor)\\b"),
        cjk: ["密码", "口令", "密钥", "私钥", "令牌", "凭证", "登录"],
    }),
    new ScenarioRule("finance", {
        pattern: pyRe("\\b(pay(ment|s|ing)?|paid|paypal|checkout|check[ -]?out|purchase|" +
            "billing|invoice|refund|bank(ing)?|bank[ -]?transfer|wire[ -]?transfer|" +
            "place[ -]?order|confirm[ -]?order|subscription)\\b"),
        cjk: ["支付", "付款", "转账", "汇款", "结账", "下单", "订单", "退款", "充值",
            "提现", "结算", "收银"],
    }),
    new ScenarioRule("third_party_comm", {
        pattern: pyRe("\\b(send|sent|post|posted|posting|publish|share|shared|reply|forward|" +
            "upload|tweet|comment|email|message|submit)\\b"),
        cjk: ["发送", "发布", "提交", "回复", "转发", "分享", "上传", "评论", "发帖",
            "私信", "推送"],
    }),
    new ScenarioRule("system_security", {
        pattern: pyRe("\\b(firewall|registry|regedit|gpedit|secpol|uac|defender|antivirus|" +
            "administrator|group[ -]?policy|system[ -]?settings|hosts[ -]?file)\\b"),
        cjk: ["防火墙", "注册表", "组策略", "系统设置", "系统配置", "安全设置",
            "管理员", "杀毒", "安全中心"],
    }),
    new ScenarioRule("captcha", {
        pattern: pyRe("\\b(captcha|recaptcha|hcaptcha|turnstile|human[ -]?verification|" +
            "are[ -]?you[ -]?human|verify[ -]?human|not[ -]?a[ -]?robot)\\b"),
        cjk: ["验证码", "人机验证", "滑块验证", "拖动滑块", "拼图验证"],
    }),
    new ScenarioRule("software_install", {
        pattern: pyRe("\\b(install(ing|er|ed|s)?|setup(\\.exe)?|\\.msi|add[ -]?ons?|" +
            "add (a |an |the )?(extension|plugin)|browser[ -]?extension)\\b"),
        cjk: ["安装", "添加扩展", "添加插件"],
    }),
    new ScenarioRule("sensitive_transmission", {
        pattern: pyRe("\\b(ssn|social[ -]?security|passport|id[ -]?card|credit[ -]?card|" +
            "debit[ -]?card|bank[ -]?account|personal[ -]?(data|info|information)|" +
            "pii|confidential)\\b"),
        cjk: ["身份证", "银行卡", "社保号", "护照", "个人信息", "隐私", "敏感信息",
            "证件号"],
    }),
    new ScenarioRule("medical", {
        pattern: pyRe("\\b(medical|medication|diagnos(is|e)|prescription|patient|symptoms?|" +
            "clinic|clinical|hospital|doctor|health[ -]?record)\\b"),
        cjk: ["医疗", "病历", "处方", "诊断", "就诊", "挂号", "用药", "药方", "症状",
            "患者"],
    }),
];

export const _SCENARIO_RULE_MAP: Record<string, ScenarioRule> = {};
for (const r of _SCENARIO_RULES) _SCENARIO_RULE_MAP[r.tag] = r;

// 导入期自检：规则表与标签全集一一对应——漏一条规则等于漏一类雷。
(function _assertRuleCoherence() {
    const mapTags = Object.keys(_SCENARIO_RULE_MAP).slice().sort();
    const setTags = SCENARIO_TAGS.slice().sort();
    if (mapTags.join("\u0000") !== setTags.join("\u0000")) {
        throw new Error("场景规则表与 SCENARIO_TAGS 必须一一对应");
    }
})();

/** 语料规模护栏——畸形/超大输入不至于把正则拖成 DoS。 */
export const _MAX_TEXTS = 256;
export const _MAX_CORPUS_CHARS = 20000;

function isPlainObject(v: unknown): v is JsonDict {
    return v !== null && typeof v === "object" && !Array.isArray(v) &&
        !(v instanceof Set) && !(v instanceof Map);
}

/**
 * 深度优先收集语料文本。收：字符串值 + 字符串键；递归下钻 dict / list / tuple。
 * 跳：以 '_' 开头的键整枝剪掉（内部缓存，如 _command_verdict）；非字符串标量不进
 * 语料。set 不遍历——迭代顺序不确定，与纯函数纪律冲突。
 */
export function _walk_texts(node: unknown, out: string[]): void {
    if (out.length >= _MAX_TEXTS) return;
    if (typeof node === "string") {
        if (pyTruth(node.trim())) out.push(node);
        return;
    }
    if (isPlainObject(node)) {
        for (const k of Object.keys(node)) {
            if (k.startsWith("_")) continue;
            if (out.length < _MAX_TEXTS) out.push(k);
            _walk_texts(node[k], out);
        }
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) _walk_texts(item, out);
        return;
    }
}

/**
 * 场景判定器：从动作参数上下文里识别雷区标签。确定性纯函数、零网络。
 * 命中按 SCENARIO_TAGS 固定顺序返回；无一命中返回空数组。畸形输入一律空。
 */
export function detect_scenario_tags(tool: unknown, params: unknown, ctx: unknown = null): string[] {
    const texts: string[] = [];
    if (typeof tool === "string" && pyTruth(tool.trim())) texts.push(tool);
    _walk_texts(params, texts);
    if (ctx !== null && ctx !== undefined) _walk_texts(ctx, texts);
    if (texts.length === 0) return [];
    const corpus = texts.join("\n").slice(0, _MAX_CORPUS_CHARS).toLowerCase();
    const hits: string[] = [];
    for (const tag of SCENARIO_TAGS) {
        const rule = _SCENARIO_RULE_MAP[tag];
        if (rule === undefined) continue;
        if (rule.pattern !== null && rule.pattern.test(corpus)) { hits.push(tag); continue; }
        if (rule.cjk.some((kw) => corpus.includes(kw))) hits.push(tag);
    }
    return hits;
}

// ── 政策分组：哪些雷区预批准买不动，哪些可以 ──────────────────────────────────

/** 必弹组——命中即恒 CONFIRM，预批准买不动。 */
export const ALWAYS_CONFIRM_SCENARIOS = new Set<string>([
    "deletion", "finance", "captcha", "software_install", "medical", "system_security",
]);

/** 预批准可解组——用户做过持久授权后从 CONFIRM 降为 AWARE。 */
export const PRE_APPROVAL_SCENARIOS = new Set<string>([
    "credential", "sensitive_transmission", "third_party_comm",
]);

/** 场景 → 地板档位显式映射表。值为二元组 [未预批准地板, 预批准后地板]。 */
export const SCENARIO_TIER_TABLE: Record<string, [TierValue, TierValue]> = {
    deletion: [Tier.CONFIRM, Tier.CONFIRM],
    credential: [Tier.CONFIRM, Tier.AWARE],
    finance: [Tier.CONFIRM, Tier.CONFIRM],
    third_party_comm: [Tier.CONFIRM, Tier.AWARE],
    system_security: [Tier.CONFIRM, Tier.CONFIRM],
    captcha: [Tier.CONFIRM, Tier.CONFIRM],
    software_install: [Tier.CONFIRM, Tier.CONFIRM],
    sensitive_transmission: [Tier.CONFIRM, Tier.AWARE],
    medical: [Tier.CONFIRM, Tier.CONFIRM],
};

// 导入期自检：分组与映射表不得漂移（改表必先改组，反之亦然）。
(function _assertGroupCoherence() {
    for (const a of ALWAYS_CONFIRM_SCENARIOS) {
        if (PRE_APPROVAL_SCENARIOS.has(a)) throw new Error("分组重叠: " + a);
    }
    const union = new Set<string>([...ALWAYS_CONFIRM_SCENARIOS, ...PRE_APPROVAL_SCENARIOS]);
    if (union.size !== ALWAYS_CONFIRM_SCENARIOS.size + PRE_APPROVAL_SCENARIOS.size) {
        throw new Error("分组交集非空");
    }
    const tagSet = new Set(SCENARIO_TAGS);
    for (const t of union) if (!tagSet.has(t)) throw new Error("分组含未知标签: " + t);
    for (const t of SCENARIO_TAGS) if (!union.has(t)) throw new Error("分组漏标签: " + t);
    for (const _tag of SCENARIO_TAGS) {
        const _expected: [TierValue, TierValue] =
            PRE_APPROVAL_SCENARIOS.has(_tag) ? [Tier.CONFIRM, Tier.AWARE] : [Tier.CONFIRM, Tier.CONFIRM];
        const got = SCENARIO_TIER_TABLE[_tag]!;
        if (got[0] !== _expected[0] || got[1] !== _expected[1]) {
            throw new Error("SCENARIO_TIER_TABLE 漂移: " + _tag);
        }
    }
})();

// ── 档位算术与最终裁决 ────────────────────────────────────────────────────────

export const _TIER_STRENGTH: Record<TierValue, number> = {
    ok: 0, aware: 1, confirm: 2, handoff: 3,
};

/** 把任意输入安全折算为 Tier；认不出返回 None（宁可弃权不瞎猜）。 */
export function _coerce_tier(value: unknown): TierValue | null {
    if (typeof value === "string" && TIER_VALUES.has(value)) return value as TierValue;
    if (typeof value === "string") {
        const t = value.trim().toLowerCase();
        return TIER_VALUES.has(t) ? (t as TierValue) : null;
    }
    return null;
}

/** 两档取高：OK < AWARE < CONFIRM < HANDOFF。畸形输入按 OK 处理。 */
export function escalate_tiers(a: unknown, b: unknown): TierValue {
    let ta = _coerce_tier(a);
    if (ta === null) ta = Tier.OK;
    let tb = _coerce_tier(b);
    if (tb === null) tb = Tier.OK;
    return _TIER_STRENGTH[ta] >= _TIER_STRENGTH[tb] ? ta : tb;
}

/** confirmation_class 词表——动作粗分类。 */
export const CONFIRMATION_CLASSES = new Set<string>([
    "handoff", "always_confirm", "pre_approval", "standard",
]);

/**
 * 确认档位裁决：粗分类 × 场景标签 × 预批准 → 最终档。三条硬规则按序裁定，先命中先赢。
 * 防御式容错：class 归一化后未知按 standard；未知标签忽略；scenario_tags 接受任意
 * 可迭代（含单个字符串）；None/畸形输入不抛异常。
 */
export function resolve_confirmation_tier(
    confirmation_class: unknown, scenario_tags: unknown, pre_approved: unknown = false): TierValue {
    let cls = pyStr(pyOr(confirmation_class, "standard")).trim().toLowerCase();
    if (!pyTruth(cls)) cls = "standard";
    if (!CONFIRMATION_CLASSES.has(cls)) cls = "standard";

    let tags: string[];
    if (typeof scenario_tags === "string") {
        tags = [scenario_tags];
    } else if (scenario_tags === null || scenario_tags === undefined) {
        tags = [];
    } else {
        try {
            tags = pyIter(scenario_tags) as string[];
        } catch {
            tags = [];
        }
    }
    const pre = pyTruth(pre_approved);

    // 硬规则一：handoff 恒 HANDOFF——预批准无权触碰
    if (cls === "handoff") return Tier.HANDOFF;
    // 硬规则二：必弹类/必弹场景恒 CONFIRM——预批准买不动
    if (cls === "always_confirm" || tags.some((t) => ALWAYS_CONFIRM_SCENARIOS.has(t))) return Tier.CONFIRM;
    // 硬规则三：可预批准类/场景——批准降为知情，未批准当场确认
    if (cls === "pre_approval" || tags.some((t) => PRE_APPROVAL_SCENARIOS.has(t))) {
        return pre ? Tier.AWARE : Tier.CONFIRM;
    }
    // standard 且无标签：地板不生效
    return Tier.OK;
}

// ── 反注入：预批准来源白名单 ──────────────────────────────────────────────────

/** 预批准证据的白名单——只有"用户亲口说"的两个通道。 */
export const PRE_APPROVAL_SOURCES = new Set<string>(["user_first_message", "confirm_card"]);

/** 判定授权来源是否可信（在白名单内）。畸形输入一律 False。 */
export function is_pre_approval_source(source: unknown): boolean {
    if (typeof source !== "string") return false;
    return PRE_APPROVAL_SOURCES.has(source.trim().toLowerCase());
}

// PORT STATUS: confidence=high todos=[0]
