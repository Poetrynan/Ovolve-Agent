/**
 * execution_provider.ts — 执行环境选择（Phase 8，按修订版 §7.4：无 Docker 轻量隔离）。
 *
 * Ported from `app/backend/execution_provider.py` (143 lines, wave-6, unit 154).
 *
 * ## 解决什么
 *
 * 一次工具调用该在什么环境里跑：只读、工作区内写、还是高风险旁路。本模块是
 * §7.4 那张映射表的唯一裁决者——输入一个风险等级（外加"有没有 worktree"和
 * "有没有人工确认"两个开关），输出一个自带理由的 ExecutionPlan。它不碰进程、
 * 不碰文件系统，真正的 OS 隔离由 sandbox 层在上游施加，所以整个决策是纯函数，
 * 可逐比特对齐。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/execution_provider.py -> app/engine/execution_provider.ts.
 *       Public python names stay snake_case, verbatim: RISK_LEVELS,
 *       MODE_READ_ONLY, MODE_WORKSPACE_WRITE, MODE_DANGER_FULL, MODE_REFUSED,
 *       OS_CONFINEMENT_BY_PLATFORM, _CONFINEMENT_FALLBACK, _LL_TO_R,
 *       detect_os_confinement, ExecutionPlan, _normalize_risk, risk_to_rlevel,
 *       select_execution. ExecutionPlan's fields keep their python spelling.
 *   §2  every truth gate goes through pyTruth and the python `or` idiom:
 *       `str(risk_level or "")`, `str(risk_value or "")`, and the two `if`
 *       statements (`if worktree_available:`, `if high_risk_confirmed:`) test
 *       ARBITRARY caller-supplied values, so `0`/`""`/`[]`/`{}`/null are False
 *       and a class instance is True whatever it holds (quirk §6).
 *   §2  `str(...)` is `pyStr`: bool renders True/False, float renders with
 *       python's repr, containers render through repr — so `_normalize_risk([])`
 *       yields "[]"→R4 while `_normalize_risk(["R4"])` yields "['R4']"→R4 too
 *       (the repr is never in the tuple).
 *   §2  `.upper()` / `.lower()` are applied to the RESULT of `str(...)`, which
 *       is always a python `str`, so no AttributeError arm exists here (unlike
 *       a bare `.get()` receiver); the port uses toUpperCase/toLowerCase on the
 *       already-string value.
 *   §2  `x in RISK_LEVELS` is tuple membership — exact string equality, no
 *       trimming, no case folding (quirk §2: `_normalize_risk` has NO `.strip()`
 *       while `risk_to_rlevel` does, so " R2 " normalizes to R4 but maps to R2
 *       through the other function).
 *   §2  `_LL_TO_R.get(key.lower(), "R4")` is a dict lookup with a default: the
 *       keys are the four lowercase risk_control spellings, so only those pass;
 *       anything else, including "none"/"unknown"/"", is R4 — 安全缺省.
 *   §2  exception identity: TypeErrorP/ImportErrorP carry the python class name
 *       in `.name` and the python `str(exc)` in `.message`, so the probe
 *       compares [type, str] pairs.
 *   §2  `from sandbox import describe_os_confinement` runs at CALL time inside a
 *       try, so both failure arms (module absent, name absent) and a raising
 *       probe all land in the same `except Exception` → platform-table fallback
 *       (quirk §3). The import lives behind EXECUTION_SEAMS / set_sandbox_provider
 *       exactly as confirm_meta.ts does for cua_actions.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   §1  ExecutionPlan's `os_confinement` default is the STRING "none", and
 *       `__post_init__` fires on equality with that literal — so an explicit
 *       `ExecutionPlan(..., "none")` is indistinguishable from the default and
 *       also triggers the probe.
 *   §2  `detect_os_confinement()`'s return value is stored VERBATIM: null, ""
 *       or a literal "none" from the sandbox layer all land in the audit field
 *       as-is and are never re-probed or validated.
 *   §3  the fallback arm is `OS_CONFINEMENT_BY_PLATFORM.get(sys.platform,
 *       "popen_confined")` — an unlisted platform (freebsd, aix, an empty
 *       string) yields the fallback, not an exception.
 *   §4  `select_execution("R4", worktree_available=False)` still returns
 *       danger-full-access when confirmed: the R4 branch never reads
 *       worktree_available.
 *   §5  `meta` is `field(default_factory=dict)`: every plan gets a FRESH dict
 *       (verified on CPython: two default plans do NOT share `meta`), so the
 *       port must not freeze a shared constant.
 *   §6  `_normalize_risk` is reached only through `select_execution`; unknown
 *       spellings ("R9", "low", "", None, 0, []) collapse to R4 — note "low"
 *       does NOT become R1 here, that translation belongs to `risk_to_rlevel`.
 *   §7  the R0/R1 reason is an f-string that interpolates the NORMALIZED level,
 *       so `_normalize_risk("r0")` prints "R0 只读或低危…" with the upper-cased
 *       token, never the caller's spelling.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, lazy import seam): python imports `sandbox` inside the try.
 *       sandbox.py is Native-routed (wave 1) and has no TS sibling, so the port
 *       reaches it through set_sandbox_provider, the confirm_meta.ts precedent:
 *       an unbound provider throws "ModuleNotFoundError: No module named
 *       'sandbox'", a missing attribute throws "ImportError: cannot import name
 *       …", and both are caught by the same except arm as in python. Production
 *       wiring binds the native `describe_os_confinement`, which is what CPython
 *       resolves here (rust_adapters/sandbox.py re-exports the same symbol).
 *   DIVERGENCE(port, sys.platform): EXECUTION_SEAMS.platform() returns
 *       `process.platform`. The three keys of the table (win32/darwin/linux)
 *       spell identically in both runtimes, and every other OS misses on both
 *       sides and falls to "popen_confined", so the observable value is
 *       identical on every platform this product runs on.
 *   DIVERGENCE(port, keyword-only args): python's `*, worktree_available,
 *       high_risk_confirmed` cannot be passed positionally — CPython raises
 *       `TypeError: select_execution() takes 1 positional argument but 2 were
 *       given`. The port keeps that contract at runtime as well: the second slot
 *       is the options bag (the JS spelling of the two keywords), and any other
 *       value there — null, a number, a string, a class instance — throws the
 *       identical TypeError, with the argument COUNT taken from
 *       `arguments.length`, so a three-positional call reports "3 were given"
 *       exactly as python does. The one spelling this port cannot reproduce is
 *       `select_execution("R2", {}, extra)`: python would call that an unexpected
 *       keyword argument, not a positional one. No call site in app/ does it
 *       (dispatch.py passes both values as keywords only), so production
 *       behaviour is identical.
 *   DIVERGENCE(port, missing positional): python distinguishes
 *       `select_execution()` (TypeError … missing 1 required positional
 *       argument: 'risk_level') from `select_execution(None)` (→ R4). JS has one
 *       absent-value spelling, so the port maps python's omitted argument onto
 *       "no argument passed" (`arguments.length`) and python's None onto
 *       `null`, and throws the TypeError only for the former. The same
 *       convention as the dataclass defaults (`=== undefined` fires the default,
 *       an explicit null is stored). ExecutionPlan and the two helpers carry the
 *       matching @dataclass / def arity checks (missing-required and too-many,
 *       with python counting `self` in `__init__`), so probe families e14-e17
 *       and f10-f12 compare TypeError texts verbatim.
 *   DIVERGENCE(port, dataclass surface): @dataclass generates __repr__/__eq__
 *       and __init__ arity checks. Nothing in app/ prints or compares a plan
 *       (grep: consumers read `plan.mode`, `plan.os_confinement`, `plan.reason`
 *       only), so the port implements the fields and __post_init__ but not
 *       repr/eq; the parity probe compares the seven fields one by one, which is
 *       strictly finer-grained than repr().
 *   DIVERGENCE(port, number repr): `_normalize_risk(1)` renders "1" and
 *       `_normalize_risk(1.0)` renders "1.0" in CPython, while JS has one number
 *       type. Both spellings miss RISK_LEVELS and return R4, so the difference
 *       is unobservable through any public function; the house int-style
 *       rendering (`String(v)`, same as episode_manager/confirm_meta) is kept.
 *
 *   本文件无待移植项；端口状态行在文件末行。
 */

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}
class ImportErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ImportError";
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
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate (same shape as memory_layer's): a value that IS a python
 *  dict — a plain or prototype-less object, not a class instance. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (Buffer.isBuffer(v) || v instanceof Error) return false;
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
    // A class instance is a python OBJECT: bool() is True whatever its own
    // fields are (nothing in this domain defines __bool__/__len__), so the
    // empty-container rule applies only to dict-shaped values.
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
    if (typeof v === "object") return true;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python float repr for `str()`: JS numbers carry no int/float tag, so an
 *  integral value renders like a python int (`1`, not `1.0`) — the house
 *  convention; only nan/inf take python's spelling. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

/** python `repr(x)` for the string leaf. */
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
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    if (v instanceof Map) {
        return "{" + Array.from(v.entries()).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

/** python `str.strip()` with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python's "missing N required positional argument(s)" TypeError text:
 *  `'a'`, `'a' and 'b'`, `'a', 'b', and 'c'` — CPython's own join. */
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

/** python's "takes <takes> positional argument(s) but N was/were given".
 *  `takes` is "0" / "1" / "from 4 to 8" — the dataclass form included. */
function pyTooMany(fname: string, takes: string, given: number): TypeErrorP {
    const noun = takes === "1" ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(
        `${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

type JsonDict = Record<string, unknown>;

// ── sandbox 惰性导入缝（confirm_meta.ts 的 cua_actions 同款） ────────────────

/** python `from sandbox import describe_os_confinement` 的最小视图。 */
export interface SandboxModule {
    describe_os_confinement?: unknown;
}

export type SandboxProvider = () => SandboxModule;

let _sandbox_provider: SandboxProvider | null = null;

/** 注入 sandbox 模块提供者（宿主接线与 parity 探针用）；null 恢复"模块不存在"。 */
export function set_sandbox_provider(provider: SandboxProvider | null): void {
    _sandbox_provider = provider;
}

/** python `from sandbox import describe_os_confinement`：未接线/模块缺失抛
 *  ModuleNotFoundError 同位异常，名字缺失抛 ImportError 同位异常，存在但不可调
 *  用则在下一步抛 TypeError——三条都被 python 的 except Exception 收成兜底档。 */
function _importSandboxDescribe(): () => unknown {
    if (_sandbox_provider === null) {
        throw new Error("ModuleNotFoundError: No module named 'sandbox'");
    }
    const mod = _sandbox_provider();
    if (!("describe_os_confinement" in (mod as object))) {
        throw new ImportErrorP("ImportError: cannot import name 'describe_os_confinement' from 'sandbox'");
    }
    const fn = (mod as Record<string, unknown>)["describe_os_confinement"];
    if (typeof fn !== "function") {
        throw new TypeErrorP(`${pyTypeName(fn)} object is not callable`);
    }
    return fn as () => unknown;
}

// ── 执行环境模式决策 ─────────────────────────────────────────────────────────

export const EXECUTION_SEAMS = {
    /** python `sys.platform` — 兜底查表的键。 */
    platform: (): string => process.platform,
};

// ── 常量（与 python 逐字对齐） ───────────────────────────────────────────────

export const RISK_LEVELS: readonly string[] = ["R0", "R1", "R2", "R3", "R4"];

export const MODE_READ_ONLY = "read-only";
export const MODE_WORKSPACE_WRITE = "workspace-write";
export const MODE_DANGER_FULL = "danger-full-access";
export const MODE_REFUSED = "refused";

/** 平台 → OS 原生加固种类的兜底标注。优先用 sandbox.describe_os_confinement()
 *  的探测结果（反映真实施加的隔离）；探测不可用时才落到这张静态表。 */
export const OS_CONFINEMENT_BY_PLATFORM: Record<string, string> = {
    win32: "job_object",       // Windows Job Objects / restricted token
    darwin: "seatbelt",        // macOS Seatbelt profile
    linux: "landlock",         // Linux Landlock LSM
};
export const _CONFINEMENT_FALLBACK = "popen_confined";

/** risk_control.RiskLevel.value → §7.4 风险等级。两个体系语义同构：
 *  low=读(R1) · medium=改工作区(R2) · high=shell 等高危(R3) · critical=不可逆(R4)。 */
export const _LL_TO_R: Record<string, string> = {
    low: "R1",
    medium: "R2",
    high: "R3",
    critical: "R4",
};

// ── 函数 ─────────────────────────────────────────────────────────────────────

/** 探测本机实际可用的隔离种类。绝不抛异常——审计字段不能成为故障点。 */
export function detect_os_confinement(): string {
    // python 的 0 参契约在运行期同样成立（探针 f12 钉住）。
    if (arguments.length > 0) throw pyTooMany("detect_os_confinement", "0", arguments.length);
    try {
        const describe = _importSandboxDescribe();
        // python 直接 return 探测结果，不校验：null/""/"none" 原样进审计字段。
        return describe() as string;
    } catch {
        // noqa: BLE001 — 声明失败退回平台查表，不撒谎也不炸
        const key = EXECUTION_SEAMS.platform();
        return Object.prototype.hasOwnProperty.call(OS_CONFINEMENT_BY_PLATFORM, key)
            ? OS_CONFINEMENT_BY_PLATFORM[key] as string
            : _CONFINEMENT_FALLBACK;
    }
}

/** 一次执行的完整决定：模式、载体、理由与确认要求——全部可解释。 */
export class ExecutionPlan {
    /** read-only | workspace-write | danger-full-access | refused */
    mode: string;
    /** local | worktree */
    provider: string;
    /** 为什么是这个决定（UI/审计直接引用） */
    reason: string;
    /** 是否与主工作区文件隔离（worktree 副本） */
    isolated: boolean;
    requires_confirmation: boolean;
    /** none|job_object|seatbelt|landlock|popen_confined */
    os_confinement: string;
    meta: JsonDict;

    constructor(
        mode: string,
        provider: string,
        reason: string,
        isolated: boolean = false,
        requires_confirmation: boolean = false,
        os_confinement: string = "none",
        meta: JsonDict | undefined = undefined,
    ) {
        // @dataclass 的 __init__ 契约在运行期同样成立（探针 e14-e17 钉住）。
        // python 把 self 也计入位置参数，所以 given = arguments.length + 1。
        const given = arguments.length + 1;
        if (given > 8) throw pyTooMany("ExecutionPlan.__init__", "from 4 to 8", given);
        if (arguments.length < 3) {
            throw pyMissing("ExecutionPlan.__init__",
                (["mode", "provider", "reason"] as const).slice(arguments.length));
        }
        this.mode = mode;
        this.provider = provider;
        this.reason = reason;
        this.isolated = isolated;
        this.requires_confirmation = requires_confirmation;
        this.os_confinement = os_confinement;
        // field(default_factory=dict)：每条 plan 一个全新的 dict（quirk §5）
        this.meta = meta === undefined ? {} : meta;
        // __post_init__
        // 声明性标注：除非调用方显式指定，否则按本机**实际可用**的隔离如实
        // 填写（sandbox.describe_os_confinement 探测），让每份审计记录携带的
        // 隔离等级与现实一致——探测失败才退回平台查表。
        if (this.os_confinement === "none") {
            this.os_confinement = detect_os_confinement();
        }
    }
}

export function _normalize_risk(risk_level: unknown): string {
    if (arguments.length === 0) throw pyMissing("_normalize_risk", ["risk_level"]);
    if (arguments.length > 1) throw pyTooMany("_normalize_risk", "1", arguments.length);
    const risk = pyStr(pyOr(risk_level, "")).toUpperCase();
    // 未知风险按最坏情况处理——这是安全缺省，不是方便缺省
    return RISK_LEVELS.includes(risk) ? risk : "R4";
}

/** 把 risk_control 的 "low"/"medium"/"high"/"critical" 映射成 R0–R4。
 *  已是 R 等级的原样通过；未知值按最坏情况 R4——安全缺省，不是方便缺省。 */
export function risk_to_rlevel(risk_value: unknown): string {
    if (arguments.length === 0) throw pyMissing("risk_to_rlevel", ["risk_value"]);
    if (arguments.length > 1) throw pyTooMany("risk_to_rlevel", "1", arguments.length);
    const key = pyStrip(pyStr(pyOr(risk_value, "")));
    const up = key.toUpperCase();
    if (RISK_LEVELS.includes(up)) return up;
    const low = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(_LL_TO_R, low) ? _LL_TO_R[low] as string : "R4";
}

export interface SelectExecutionOpts {
    worktree_available?: unknown;
    high_risk_confirmed?: unknown;
}

/** 按风险等级选执行模式。纯函数，便于测试与审计复核。 */
export function select_execution(
    risk_level: string,
    opts?: SelectExecutionOpts | null,
): ExecutionPlan {
    if (arguments.length === 0) {
        throw pyMissing("select_execution", ["risk_level"]);
    }
    // python 的 keyword-only 边界：第二个槽位在 JS 里是 opts 包（等价于
    // worktree_available=/high_risk_confirmed= 关键字），其余任何值——含 null、
    // 数字、字符串——都等于 python 的位置传参，一律 TypeError，措辞逐字对齐；
    // 第三个位置参数同理（探针 f01-f05/f14 钉住）。
    if (arguments.length > 2 || (arguments.length === 2 && !isPyDict(opts))) {
        throw pyTooMany("select_execution", "1", arguments.length);
    }
    const worktree_available: unknown = opts?.worktree_available === undefined
        ? true : opts.worktree_available;
    const high_risk_confirmed: unknown = opts?.high_risk_confirmed === undefined
        ? false : opts.high_risk_confirmed;

    const risk = _normalize_risk(risk_level);

    if (risk === "R0" || risk === "R1") {
        return new ExecutionPlan(
            MODE_READ_ONLY, "local",
            `${risk} 只读或低危：直接在工作区执行，路径策略照常生效`);
    }

    if (risk === "R2") {
        if (pyTruth(worktree_available)) {
            return new ExecutionPlan(
                MODE_WORKSPACE_WRITE, "worktree",
                "R2 会改文件：优先在 worktree 副本里做，验证过再合并",
                true);
        }
        return new ExecutionPlan(
            MODE_WORKSPACE_WRITE, "local",
            "R2 且无可用 worktree：限定在选定 workspace 内执行，" +
            "Git diff + validator + 回滚兜底");
    }

    if (risk === "R3") {
        if (pyTruth(worktree_available)) {
            return new ExecutionPlan(
                MODE_WORKSPACE_WRITE, "worktree",
                "R3 高危改动：在隔离副本中执行，合并前必须人工确认",
                true, true);
        }
        return new ExecutionPlan(
            MODE_WORKSPACE_WRITE, "local",
            "R3 高危改动且无 worktree：限定 workspace 并强制人工确认",
            false, true);
    }

    // R4：付款/发布/真实外发/改凭证/不可逆删除——必须人工确认，不存在自动档
    if (pyTruth(high_risk_confirmed)) {
        return new ExecutionPlan(
            MODE_DANGER_FULL, "local",
            "R4 已获显式人工确认：以 danger-full-access 执行并完整审计",
            false, true, "none",
            { "audit": "danger-full-access" });
    }
    return new ExecutionPlan(
        MODE_REFUSED, "local",
        "R4 属高风险旁路：未经显式人工确认拒绝执行——没有 Docker 也不是放宽权限的理由",
        false, true, "none",
        { "refused": true });
}

// PORT STATUS: confidence=high todos=[0]
