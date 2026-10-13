/**
 * app_agent.ts — Application & Native Computer Use Sub-Agent.
 *
 * Ported from `app/backend/app_agent.py` (646 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/app_agent.py -> app/engine/app_agent.ts.
 *       py kwargs on ToolDef registrations become the trailing options
 *       object; `_private` handler names keep their snake_case.
 *   §2  BROAD-SWALLOW verbatim: every tool handler wraps its body in
 *       try/catch(Exception) and degrades to Result.failure(f"...: {e}") —
 *       the inventory's BROAD-SWALLOW rows (app_agent.py:407/421/434/446/
 *       457/472/487/619/622/634) are kept exactly; the MEMORY.md append is
 *       BROAD-SWALLOW-SILENT (`except Exception: pass`) and is marked
 *       BUG(port) per the inventory directive.
 *   §2  present-but-null everywhere: args.get("k", d) returns None when the
 *       key is PRESENT with a null value — dictGet mirrors that and never
 *       folds it with `||`/`??`. `(platform or "")`/`(args.get("content") or
 *       "")`/`ctx.get("workspace_root") or os.getcwd()` are the py falsy
 *       or-gates, mirrored with pyTruth.
 *   §2  latent quirks kept: `_ui_auto_compat` reads the "text" key for the
 *       `key` action and for `scroll` clicks (default 5), and drags from a
 *       hardcoded (0,0); `_computer_screenshot` truthiness-gates the ROI and
 *       requires exactly 4 items; `int()`/`float()` use pyInt/pyFloat crash
 *       semantics (uncaught → swallowed into Result.failure at the exact
 *       same point as the source).
 *   §2  f-strings interpolate str(e) (message only) and str(None)="None"
 *       (`Screenshot saved: None` when output_path is present-null).
 *   §2  ntpath host semantics: isabs is the 3.13 rule pinned by probe
 *       ("\Windows" is NOT absolute; "\\srv" UNC is); abspath delegates to
 *       the native per-drive-CWD GetFullPathName whose drive-relative edge
 *       cases ("D:", "C:..\x") no pure function can reproduce — see the
 *       DIVERGENCE(port) notes on osPathAbspath.
 *   §2  `context.setdefault("workspace_root", ...)` only fills a MISSING
 *       key — a present null stays null (dispatch sees None like the source).
 *
 * MIGRATION DECISIONS (not divergences — documented dispositions)
 *   telemetry: `get_telemetry`/`SpanName` are deleted here exactly as the
 *       HANDOFF §8.3 disposition for the DELETE-flagged telemetry.py unit
 *       ("依赖方直接删调用"): start_span/set_error/end_span were purely
 *       observational, removal is behaviour-identical. Same precedent as
 *       memory_layer.ts.
 *   host seams: tools.py (SPLIT, wave-4, not landed) and native_desktop.py
 *       (Native, wave-4, not landed) are consumed through bindable module
 *       seams (setPythonRuntime precedent in executors.ts). Until a host
 *       binds them, construction raises — the source's top-level
 *       ImportError/ctypes failure also makes the agent unusable; the crash
 *       point moves from import-time to first-use time (the only observable
 *       shift, since TS cannot execute a failing static import).
 *   async: guarded_spawn is async in TS (spawn is Promise-based); the four
 *       app-lifecycle handlers become async functions. dispatch awaited the
 *       python tool layer too, so callers see the same Result either way.
 */

import * as subprocess from "node:child_process";
import { mkdirSync } from "node:fs";

import { Result } from "./result.js";
import { getEventBus } from "./event_bus.js";
import { BlockedCommandError, guardedSpawn, shellWord } from "./executors.js";

// `subprocess` is unused in the source as well (all spawning goes through
// guarded_spawn); kept so the import inventory lines up 1:1.
void subprocess;

// ---------------------------------------------------------------------------
// python-semantics helpers
// ---------------------------------------------------------------------------

class ValueErrorP extends Error {
    constructor(msg: string) {
        super(`ValueError: ${msg}`);
        this.name = "ValueError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class TypeErrorP extends Error {
    constructor(msg: string) {
        super(`TypeError: ${msg}`);
        this.name = "TypeError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(`AttributeError: ${msg}`);
        this.name = "AttributeError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}
class KeyErrorP extends Error {
    constructor(key: string) {
        super(`KeyError: ${key}`);
        this.name = "KeyError";
        this.pyMsg = key;
    }
    pyMsg: string;
}

/** str(e) as python would render it (message only, no type prefix). */
function excStr(e: unknown): string {
    const m = (e as { pyMsg?: string })?.pyMsg;
    if (m !== undefined) {
        return m;
    }
    return String((e as Error)?.message ?? e);
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    return "dict";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return true;
}

/** python dict.get(k, dflt)：present-but-null returns null, not dflt. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
        throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python int(x). */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) throw new OverflowErrorP("cannot convert float infinity to integer");
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const s = v.trim();
        if (/^[-+]?[0-9]+$/u.test(s)) return Number(s);
        throw new ValueErrorP(`invalid literal for int() with base 10: '${s}'`);
    }
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** python float(x). */
function pyFloat(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const s = v.trim();
        if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || /^[-+]?inf(inity)?$/i.test(s) || /^[-+]?nan$/i.test(s)) {
            const lowered = s.toLowerCase();
            if (lowered.startsWith("+inf") || lowered === "inf" || lowered === "infinity") return Infinity;
            if (lowered.startsWith("-inf")) return -Infinity;
            if (lowered === "nan" || lowered === "+nan" || lowered === "-nan") return NaN;
            return Number(s);
        }
        throw new ValueErrorP(`could not convert string to float: '${s}'`);
    }
    throw new TypeErrorP(
        `float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

class OverflowErrorP extends Error {
    constructor(msg: string) {
        super(`OverflowError: ${msg}`);
        this.name = "OverflowError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}

/** str(x) for f-strings: containers render in repr form. */
function pyReprVal(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "nan";
        if (v === Infinity) return "inf";
        if (v === -Infinity) return "-inf";
        if (Number.isInteger(v)) return String(v);
        return String(v);
    }
    if (typeof v === "string") {
        const q = v.includes("'") && !v.includes('"') ? '"' : "'";
        const body = v
            .replaceAll("\\", "\\\\")
            .replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r")
            .replaceAll("\t", "\\t");
        return q + body.replaceAll(q === "'" ? "'" : '"', "\\" + q) + q;
    }
    if (Array.isArray(v)) return "[" + v.map(pyReprVal).join(", ") + "]";
    const keys = Object.keys(v as object);
    return "{" + keys.map((k) => pyReprVal(k) + ": " + pyReprVal((v as Record<string, unknown>)[k])).join(", ") + "}";
}

function pyStrVal(v: unknown): string {
    if (typeof v === "string") return v;
    return pyReprVal(v);
}

/** len(s) in codepoints. */
function pyLen(s: string): number {
    return Array.from(s).length;
}

/** python len(x) for the ROI gate (str/list/dict; anything else TypeError). */
function pyLenOf(v: unknown): number {
    if (typeof v === "string") return pyLen(v);
    if (Array.isArray(v)) return v.length;
    if (v !== null && v !== undefined && typeof v === "object") {
        return Object.keys(v as object).length;
    }
    throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python obj[key] 下标：dict miss -> KeyError(repr)，其余按类型报错。 */
function pySub(obj: unknown, key: string | number): unknown {
    if (typeof obj === "string") {
        const chars = Array.from(obj);
        const idx = Number(key);
        if (!Number.isInteger(idx)) throw new TypeErrorP("string indices must be integers");
        if (!(idx >= 0 && idx < chars.length)) {
            throw new IndexErrorP(`string index out of range: ${idx}`);
        }
        return chars[idx];
    }
    if (Array.isArray(obj)) {
        const idx = Number(key);
        if (!Number.isInteger(idx)) throw new TypeErrorP("list indices must be integers or slices, not str");
        if (!(idx >= 0 && idx < obj.length)) {
            throw new IndexErrorP(`list index out of range: ${idx}`);
        }
        return obj[idx];
    }
    if (obj !== null && typeof obj === "object") {
        // python dict 整数键与 str 键永不相等（0 != "0"）；JSON 载体的 dict
        // 键恒为字符串，故整数下标必然 KeyError（repr(int) 无引号）。
        if (typeof key === "number") {
            throw new KeyErrorP(String(key));
        }
        if (!(key in (obj as object))) {
            throw new KeyErrorP(`'${key}'`);
        }
        return (obj as Record<string, unknown>)[key];
    }
    throw new TypeErrorP(`'${pyTypeName(obj)}' object is not subscriptable`);
}

class IndexErrorP extends Error {
    constructor(msg: string) {
        super(`IndexError: ${msg}`);
        this.name = "IndexError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}

/** python str() of a value the native layer types as float (1 -> "1.0"). */
function pyFloatStr(v: unknown): string {
    if (typeof v !== "number") return pyStrVal(v);
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/** s[:40] in codepoints. */
function pySlice40(s: string): string {
    return Array.from(s).slice(0, 40).join("");
}

// ---------------------------------------------------------------------------
// ntpath semantics pinned by probe (see findings in the RULEBOOK header)
// ---------------------------------------------------------------------------

const BS = "\\";

/** ntpath.splitroot — verbatim CPython 3.13 fallback. */
function splitroot(p: string): [string, string, string] {
    const normp = p.replaceAll("/", BS);
    if (normp.slice(0, 1) === BS) {
        if (normp.slice(1, 2) === BS) {
            const start = normp.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
            const index = normp.indexOf(BS, start);
            if (index === -1) return [p, "", ""];
            const index2 = normp.indexOf(BS, index + 1);
            if (index2 === -1) return [p, "", ""];
            return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
        }
        return ["", p.slice(0, 1), p.slice(1)];
    } else if (normp.slice(1, 2) === ":") {
        if (normp.slice(2, 3) === BS) return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
        return [p.slice(0, 2), "", p.slice(2)];
    }
    return ["", "", p];
}

/** ntpath.join(a, b) — verbatim CPython 3.13 (re-root branches skip the
 *  relative-append block, matching the source's `continue`s). */
function osPathJoin(a: unknown, b: unknown): string {
    const bad = (v: unknown): never => {
        throw new TypeErrorP(
            "expected str, bytes or os.PathLike object, not " + pyTypeName(v));
    };
    if (typeof a !== "string") bad(a);
    if (typeof b !== "string") bad(b);
    let [rd, rr, rp] = splitroot(a as string);
    const [pd, pr, pp] = splitroot(b as string);
    let relocated = false;
    if (pr !== "") {
        // Second path is absolute
        if (pd !== "" || rd === "") {
            rd = pd;
        }
        rr = pr;
        rp = pp;
        relocated = true;
    } else if (pd !== "" && pd !== rd) {
        if (pd.toLowerCase() !== rd.toLowerCase()) {
            // Different drives => ignore the first path entirely
            rd = pd;
            rr = pr;
            rp = pp;
            relocated = true;
        } else {
            // Same drive in different case
            rd = pd;
        }
    }
    if (!relocated) {
        // Second path is relative to the first
        if (rp !== "" && !rp.endsWith("\\") && !rp.endsWith("/")) {
            rp = rp + BS;
        }
        rp = rp + pp;
    }
    // add separator between UNC and non-absolute path
    if (rp !== "" && rr === "" && rd !== "" && !":\\".includes(rd.slice(-1))) {
        return rd + BS + rp;
    }
    return rd + rr + rp;
}

/** ntpath.normpath — verbatim CPython 3.13 fallback algorithm. */
function osPathNormpath(p: unknown): string {
    if (typeof p !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(p)}' object has no attribute 'replace'`);
    }
    const path = p.replaceAll("/", BS);
    const [drive, root, rest] = splitroot(path);
    const prefix = drive + root;
    const comps = rest.split(BS);
    let i = 0;
    while (i < comps.length) {
        if (comps[i] === "" || comps[i] === ".") {
            comps.splice(i, 1);
        } else if (comps[i] === "..") {
            if (i > 0 && comps[i - 1] !== "..") {
                comps.splice(i - 1, 2);
                i -= 1;
            } else if (i === 0 && root !== "") {
                // absolute path: leading .. disappears
                comps.splice(i, 1);
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    if (prefix === "" && comps.length === 0) {
        comps.push(".");
    }
    return prefix + comps.join(BS);
}

/** ntpath.isabs — 3.13 rule pinned by probe: normalise the first three
 *  chars, then `:\` at index 1 (drive-absolute) or a leading `\\` (UNC).
 *  A lone root like "\Windows" is NOT absolute (it hangs off the current
 *  drive's CWD). */
function osPathIsabs(p: unknown): boolean {
    if (typeof p !== "string") {
        throw new TypeErrorP(
            "expected str, bytes or os.PathLike object, not " + pyTypeName(p));
    }
    const s = p.slice(0, 3).replaceAll("/", BS);
    return s.startsWith(":" + BS, 1) || s.startsWith(BS + BS);
}

/** ntpath.split — (head, tail) around the final separator. */
function osPathSplit(p: string): [string, string] {
    const [d, r, rest] = splitroot(p);
    let i = rest.length;
    while (i && rest[i - 1] !== "\\" && rest[i - 1] !== "/") {
        i -= 1;
    }
    const head = rest.slice(0, i);
    const tail = rest.slice(i);
    let h = head;
    while (h.length && (h.endsWith("\\") || h.endsWith("/"))) {
        h = h.slice(0, -1);
    }
    return [d + r + h, tail];
}

/** ntpath.dirname. */
function osPathDirname(p: unknown): string {
    if (typeof p !== "string") {
        throw new TypeErrorP(
            "expected str, bytes or os.PathLike object, not " + pyTypeName(p));
    }
    return osPathSplit(p)[0];
}

/** os.path.abspath.
 *
 *  DIVERGENCE(port): the source delegates to Win32 GetFullPathName, which
 *  resolves *drive-relative* paths ("D:", "C:..\x") against a hidden
 *  per-drive current directory that no user-space API exposes to Node.
 *  Behaviour-identical for the full input space the code can actually
 *  produce (workspace-joined save paths, plain absolutes, "./x" relatives);
 *  drive-relative edges degrade to drive-root semantics, pinned by probe.
 *  Equivalence argument: save_path is either isabs (skips join entirely) or
 *  already joined under workspace_root before this call, so the divergent
 *  class can only be reached by a caller passing "X:tail" literally. */
export function osPathAbspath(p: unknown, cwd?: string): string {
    if (typeof p !== "string") {
        throw new TypeErrorP(
            "expected str, bytes or os.PathLike object, not " + pyTypeName(p));
    }
    const base = cwd ?? process.cwd();
    const [d, r, t] = splitroot(p);
    if (d !== "" && r === "") {
        if (t === "") {
            // "C:" / "D:" — per-drive CWD; degrade: same drive -> process
            // cwd, other drive -> drive root.
            const [cd] = splitroot(base);
            return cd.toLowerCase() === d.toLowerCase() ? osPathNormpath(base) : d + BS;
        }
        // "D:foo/bar" — relative to that drive's CWD; degrade onto process cwd
        // when it is the same drive, else drive root.
        const [cd] = splitroot(base);
        if (cd.toLowerCase() === d.toLowerCase()) {
            return osPathNormpath(osPathJoin(base, t));
        }
        return osPathNormpath(d + BS + t);
    }
    if (r === "" && d === "") {
        // "\Windows\.." style root-only paths are still drive-relative: py
        // prepends the process cwd's drive (probe-pinned: abspath("\x") ->
        // "D:\x"), which join(base, p) reproduces exactly.
    }
    return osPathNormpath(osPathJoin(base, p));
}

// ---------------------------------------------------------------------------
// host seams (tools.py SPLIT / native_desktop.py Native / process platform /
// guarded_spawn injection)
// ---------------------------------------------------------------------------

export interface CaptureResult {
    image: { save(path: string): void };
    width: number;
    height: number;
    scale_factor: number;
    data_uri: string;
}

/** DesktopMetrics mirrors the native dataclass the source imports for the
 *  host binding contract (unused in this module body, kept for parity). */
export interface DesktopMetrics {
    width: number;
    height: number;
    scale_factor: number;
    monitors: unknown[];
}

/** The native desktop engine surface consumed below (native_desktop.py). */
export interface NativeDesktop {
    capture_screen(opts: { roi: [number, number, number, number] | null; quality: number }): CaptureResult;
    click(opts: { x: number; y: number; button: string; clicks: number }): void;
    move_cursor(opts: { x: number; y: number; smooth: boolean }): void;
    type_unicode(text: string, opts: { delay_per_char: number }): void;
    press_key(key: string): void;
    drag(sx: number, sy: number, ex: number, ey: number, opts: { duration: number }): void;
    scroll(clicks: number, opts: { x: number | null; y: number | null }): void;
    get_metrics?(): DesktopMetrics;
}

class RuntimeErrorP extends Error {
    constructor(msg: string) {
        super(`RuntimeError: ${msg}`);
        this.name = "RuntimeError";
        this.pyMsg = msg;
    }
    pyMsg: string;
}

let _desktop: NativeDesktop | null = null;

/** Host binding point for the native desktop engine (win32 FFI lives in the
 *  Native half; executors.setPythonRuntime precedent). */
export function bind_native_desktop(d: NativeDesktop | null): void {
    _desktop = d;
}

/** 源同名函数：未绑定时与源的 ctypes/平台失败一样不可用。 */
export function get_native_desktop(): NativeDesktop {
    if (_desktop === null) {
        throw new RuntimeErrorP("native desktop engine not bound (native_desktop host seam)");
    }
    return _desktop;
}

/** tools.py surface consumed here (wave-4 SPLIT, not landed yet). */
export interface ToolRegistryLike {
    register(td: unknown): unknown;
    dispatch(tool_name: string, args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<Result> | Result;
}

export interface ToolsModuleLike {
    ToolDef: new (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        impl: (args: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
        kwargs: Record<string, unknown>,
    ) => unknown;
    get_tool_registry(): ToolRegistryLike;
}

let _toolsMod: ToolsModuleLike | null = null;

/** Host binding point for the tools package (SPLIT seam, red_team.ts
 *  precedent: the host wires `bind_tools_module(await import("./tools.js"))`
 *  at boot once the wave-4 unit lands; until then the agent is unbuildable,
 *  exactly as the source's top-level ImportError kills the module. */
export function bind_tools_module(mod: ToolsModuleLike | null): void {
    _toolsMod = mod;
}

let _platformSystem: () => string = () => {
    switch (process.platform) {
        case "win32": return "Windows";
        case "darwin": return "Darwin";
        default: return "Linux";
    }
};

export function bind_platform_system(fn: (() => string) | null): void {
    _platformSystem = fn ?? (() => {
        switch (process.platform) {
            case "win32": return "Windows";
            case "darwin": return "Darwin";
            default: return "Linux";
        }
    });
}

let _spawn: (cmd: string, opts: { timeout?: number }) => Promise<{ stdout: string }> =
    (cmd, opts) => guardedSpawn(cmd, opts);

export function bind_guarded_spawn(fn: ((cmd: string, opts: { timeout?: number }) => Promise<{ stdout: string }>) | null): void {
    _spawn = fn ?? ((cmd, opts) => guardedSpawn(cmd, opts));
}

/** Memory-module seams for the two in-function imports of the source
 *  (`from memory_layer import ...` / `from memory_mcp_server import ...`).
 *  Host binds the real modules lazily; unset means dynamic import. */
export interface MemoryLayerModuleLike {
    get_memory_layer: () => { store(mem: unknown): Result };
    Memory: new (content: string, mem_type: string, importance: number,
        scope: string, root_dir: string, session_id: string) => unknown;
    MemoryScope: Record<string, string>;
}
export interface MemoryMcpModuleLike {
    memory_search: (query: string, limit?: number) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

let _memLayerMod: MemoryLayerModuleLike | null = null;
let _memMcpMod: MemoryMcpModuleLike | null = null;

export function bind_memory_modules(layer: MemoryLayerModuleLike | null, mcp: MemoryMcpModuleLike | null): void {
    _memLayerMod = layer;
    _memMcpMod = mcp;
}

async function loadMemoryLayerModule(): Promise<MemoryLayerModuleLike> {
    if (_memLayerMod !== null) {
        return _memLayerMod;
    }
    const spec = "./memory_layer" + ".js";
    return (await import(/* @vite-ignore */ spec)) as unknown as MemoryLayerModuleLike;
}

async function loadMemoryMcpModule(): Promise<MemoryMcpModuleLike> {
    if (_memMcpMod !== null) {
        return _memMcpMod;
    }
    const spec = "./memory_mcp_server" + ".js";
    return (await import(/* @vite-ignore */ spec)) as unknown as MemoryMcpModuleLike;
}

export function resetAppAgentSeamsForTests(): void {
    _desktop = null;
    _toolsMod = null;
    _agent = null;
    _memLayerMod = null;
    _memMcpMod = null;
    bind_platform_system(null);
    bind_guarded_spawn(null);
}

// ---------------------------------------------------------------------------
// AppAgent
// ---------------------------------------------------------------------------

export class AppAgent {
    readonly DOMAIN = "app";
    workspace: string;
    bus: ReturnType<typeof getEventBus>;
    tools: ToolRegistryLike;
    desktop: NativeDesktop;

    constructor(workspace: string | null = null, toolsMod?: ToolsModuleLike) {
        this.workspace = pyTruth(workspace) ? (workspace as string) : process.cwd();
        this.bus = getEventBus();
        // py: self.tools = get_tool_registry() — synchronous singleton access.
        // TS seam: the tools module must be bound (host wiring) or the static
        // module is importable; source crashes at import in the same case.
        const mod = toolsMod ?? _toolsMod;
        if (mod === null || mod === undefined) {
            throw new RuntimeErrorP("tools registry not bound (tools.py SPLIT seam)");
        }
        this.tools = mod.get_tool_registry();
        this.desktop = get_native_desktop();
        this._register_tools(mod);
    }

    private _register_tools(mod: ToolsModuleLike): void {
        for (const td of this._build_tool_defs(mod)) {
            this.tools.register(td);
        }
    }

    private _build_tool_defs(mod: ToolsModuleLike): unknown[] {
        const ToolDef = mod.ToolDef;
        return [
            // ─── Standard Computer Use Toolset ──────────────────────────────
            new ToolDef(
                "computer_screenshot",
                "Computer Use: Capture high-resolution desktop screenshot with DPI awareness and Base64 output.",
                {
                    "type": "object",
                    "properties": {
                        "roi": {
                            "type": "array",
                            "items": { "type": "integer" },
                            "description": "Optional Region of Interest: [x, y, width, height] in screen pixels.",
                        },
                        "save_path": {
                            "type": "string",
                            "description": "Optional file path to save PNG/JPEG on disk.",
                        },
                        "quality": {
                            "type": "integer",
                            "default": 80,
                            "description": "JPEG compression quality (1-100).",
                        },
                    },
                    "required": [],
                },
                _computer_screenshot,
                {
                    domain: this.DOMAIN,
                    risk_level: "low",
                    when_to_use: "Computer Use, desktop screenshot, screen capture, visual perception of user's desktop, app UI layout, or verifying whether a click/action took effect.",
                    when_not_to_use: "When reading file contents directly or executing command line tools.",
                },
            ),
            new ToolDef(
                "computer_click",
                "Computer Use: Click mouse at coordinate (x, y) with high-DPI awareness.",
                {
                    "type": "object",
                    "properties": {
                        "x": { "type": "integer", "description": "Screen X coordinate." },
                        "y": { "type": "integer", "description": "Screen Y coordinate." },
                        "button": {
                            "type": "string",
                            "enum": ["left", "right", "middle"],
                            "default": "left",
                            "description": "Mouse button to click.",
                        },
                        "clicks": {
                            "type": "integer",
                            "default": 1,
                            "description": "Number of clicks (1 for single, 2 for double click).",
                        },
                    },
                    "required": ["x", "y"],
                },
                _computer_click,
                {
                    domain: this.DOMAIN,
                    risk_level: "medium",
                    when_to_use: "Computer Use, clicking mouse on buttons, icons, links, menu items, or focusing inputs on desktop.",
                    when_not_to_use: "Guessing coordinates without first calling computer_screenshot to visually confirm element location.",
                },
            ),
            new ToolDef(
                "computer_move_cursor",
                "Computer Use: Move mouse cursor smoothly to target coordinates.",
                {
                    "type": "object",
                    "properties": {
                        "x": { "type": "integer", "description": "Target screen X coordinate." },
                        "y": { "type": "integer", "description": "Target screen Y coordinate." },
                        "smooth": {
                            "type": "boolean",
                            "default": true,
                            "description": "Use smooth Bezier motion path.",
                        },
                    },
                    "required": ["x", "y"],
                },
                _computer_move_cursor,
                {
                    domain: this.DOMAIN,
                    risk_level: "low",
                    when_to_use: "Computer Use, moving mouse, hovering over UI elements to trigger tooltips, dropdowns, or previewing mouse path.",
                    when_not_to_use: "When immediately clicking; computer_click handles smooth movement automatically.",
                },
            ),
            new ToolDef(
                "computer_type",
                "Computer Use: Type text via native Unicode keyboard injection (immune to IME interference, supports Chinese & Emoji).",
                {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string", "description": "Text string to type into focused control." },
                        "delay_ms": {
                            "type": "integer",
                            "default": 10,
                            "description": "Delay in milliseconds between characters.",
                        },
                    },
                    "required": ["text"],
                },
                _computer_type,
                {
                    domain: this.DOMAIN,
                    risk_level: "medium",
                    when_to_use: "Computer Use, keyboard typing, entering text, search queries, code, or messages into currently focused inputs.",
                    when_not_to_use: "Sending shortcuts (use computer_press_key instead).",
                },
            ),
            new ToolDef(
                "computer_press_key",
                "Computer Use: Press hotkey combination or special keyboard key.",
                {
                    "type": "object",
                    "properties": {
                        "key": {
                            "type": "string",
                            "description": "Key or combo, e.g. 'enter', 'ctrl+s', 'win+r', 'alt+tab', 'escape', 'backspace', 'f5'.",
                        },
                    },
                    "required": ["key"],
                },
                _computer_press_key,
                {
                    domain: this.DOMAIN,
                    risk_level: "medium",
                    when_to_use: "Computer Use, triggering application shortcuts (save, find, run), pressing Enter, Tab, Escape, Win+R, hotkeys.",
                    when_not_to_use: "Typing long text paragraphs (use computer_type instead).",
                },
            ),
            new ToolDef(
                "computer_drag",
                "Computer Use: Drag mouse from start coordinate to end coordinate.",
                {
                    "type": "object",
                    "properties": {
                        "start_x": { "type": "integer", "description": "Starting X." },
                        "start_y": { "type": "integer", "description": "Starting Y." },
                        "end_x": { "type": "integer", "description": "Target X." },
                        "end_y": { "type": "integer", "description": "Target Y." },
                        "duration": {
                            "type": "number",
                            "default": 0.5,
                            "description": "Duration of drag motion in seconds.",
                        },
                    },
                    "required": ["start_x", "start_y", "end_x", "end_y"],
                },
                _computer_drag,
                {
                    domain: this.DOMAIN,
                    risk_level: "medium",
                    when_to_use: "Computer Use, mouse drag, selecting text ranges, moving window sliders, dragging canvas items.",
                    when_not_to_use: "Single click actions.",
                },
            ),
            new ToolDef(
                "computer_scroll",
                "Computer Use: Scroll mouse wheel vertically.",
                {
                    "type": "object",
                    "properties": {
                        "clicks": {
                            "type": "integer",
                            "description": "Number of scroll notches (positive = scroll up, negative = scroll down).",
                        },
                        "x": { "type": "integer", "description": "Optional X coordinate to hover before scrolling." },
                        "y": { "type": "integer", "description": "Optional Y coordinate to hover before scrolling." },
                    },
                    "required": ["clicks"],
                },
                _computer_scroll,
                {
                    domain: this.DOMAIN,
                    risk_level: "low",
                    when_to_use: "Computer Use, scrolling mouse wheel on pages, windows, documents, tables or long lists.",
                    when_not_to_use: "Navigating directly to an element that is already in view.",
                },
            ),

            // ─── OS App Lifecycle Management ─────────────────────────────────
            new ToolDef(
                "app_list",
                "List installed apps.",
                {
                    "type": "object",
                    "properties": {
                        "filter": {
                            "type": "string",
                            "description": "Case-insensitive substring to narrow the list. Omit to get everything.",
                        },
                    },
                    "required": [],
                },
                _app_list,
                {
                    domain: this.DOMAIN,
                    risk_level: "low",
                    when_to_use: "Confirming an app's exact installed name before launching or operating it.",
                    when_not_to_use: "A general audit of what the user has installed.",
                },
            ),
            new ToolDef(
                "app_launch",
                "Launch app by name or path.",
                {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Installed app name or executable path (e.g. 'notepad', 'calc', 'chrome').",
                        },
                        "args": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Command-line arguments, if the app takes any.",
                        },
                    },
                    "required": ["name"],
                },
                _app_launch,
                {
                    domain: this.DOMAIN,
                    risk_level: "medium",
                    when_to_use: "Opening an app the task needs, or that the user asked to open.",
                    when_not_to_use: "Checking whether it is already running.",
                },
            ),
            new ToolDef(
                "app_close",
                "Close or quit running app.",
                {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Running app name or executable (e.g. 'notepad').",
                        },
                    },
                    "required": ["name"],
                },
                _app_close,
                {
                    domain: this.DOMAIN,
                    risk_level: "medium",
                    when_to_use: "The user asked to close it, or you launched it for a step that is now done.",
                    when_not_to_use: "Force-terminating system-critical services.",
                },
            ),
            new ToolDef(
                "app_focus",
                "Bring app window to foreground.",
                {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Already-running app name to focus.",
                        },
                    },
                    "required": ["name"],
                },
                _app_focus,
                {
                    domain: this.DOMAIN,
                    risk_level: "low",
                    when_to_use: "Before clicking or typing, ensuring input reaches the intended window.",
                    when_not_to_use: "Starting an app — that is app_launch.",
                },
            ),

            // Backward compatibility aliases
            new ToolDef(
                "ui_screenshot",
                "Capture screen screenshot (compatibility alias for computer_screenshot).",
                { "type": "object", "properties": { "output_path": { "type": "string" } }, "required": [] },
                _ui_screenshot_compat,
                {
                    domain: this.DOMAIN,
                    risk_level: "low",
                    when_to_use: "Older sessions/skills that still call this name to look at the screen.",
                    when_not_to_use: "Anything new — call computer_screenshot directly.",
                },
            ),
            new ToolDef(
                "ui_automation",
                "UI automation (compatibility alias for computer actions).",
                {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["click", "type", "key", "wait", "scroll", "drag"],
                            "description": "Which computer-use action to run: click, type, key, wait, scroll, or drag.",
                        },
                        "x": { "type": "number" },
                        "y": { "type": "number" },
                        "text": { "type": "string" },
                        "duration": { "type": "number", "default": 1 },
                        "button": { "type": "string", "default": "left" },
                    },
                    "required": ["action"],
                },
                _ui_auto_compat,
                {
                    domain: this.DOMAIN,
                    risk_level: "medium",
                    when_to_use: "Older sessions/skills driving mouse/keyboard through this legacy name.",
                    when_not_to_use: "Anything new — use computer_click / computer_type / computer_key directly; acting on the wrong window is easy to do and hard to undo.",
                },
            ),

            // ─── Long-Term Memory & User Preference Management ──────────────
            new ToolDef(
                "memory_add",
                "Save user identity, preference, name, habit, or important facts into permanent long-term memory. Call this immediately when user says '记住我叫...', '以后称呼我为...', '我喜欢...', '记住...'.",
                {
                    "type": "object",
                    "properties": {
                        "content": { "type": "string", "description": "The exact fact, preference, or rule to store into long-term memory." },
                        "type": { "type": "string", "enum": ["preference", "fact", "rule"], "default": "preference" },
                    },
                    "required": ["content"],
                },
                _memory_add_tool,
                {
                    domain: "memory",
                    risk_level: "low",
                    when_to_use: "When user explicitly asks to remember something for future conversations or states their name/identity/preference.",
                    when_not_to_use: "Temporary session scratchpad data.",
                },
            ),
            new ToolDef(
                "memory_search",
                "Search user long-term memories and preferences.",
                {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Keywords or question to search memory." },
                    },
                    "required": ["query"],
                },
                _memory_search_tool,
                {
                    domain: "memory",
                    risk_level: "low",
                    when_to_use: "Looking up past user preferences, personal details, or persistent rules.",
                    when_not_to_use: "Searching codebase files (use grep_search or find_files).",
                },
            ),
        ];
    }

    async handle(tool_name: string, args: Record<string, unknown>, context: Record<string, unknown> | null = null): Promise<Result> {
        let ctx = pyTruth(context) ? (context as Record<string, unknown>) : {};
        // context.setdefault("workspace_root", self.workspace) — only fills a
        // MISSING key; a present null stays null (dispatch sees None).
        if (!("workspace_root" in ctx)) {
            ctx["workspace_root"] = this.workspace;
        }
        return await (this.tools.dispatch(tool_name, args, ctx) as Promise<Result>);
    }
}

// ---------------------------------------------------------------------------
// ─── Computer Use Tool Implementations ───────────────────────────────────────
// ---------------------------------------------------------------------------

export function _computer_screenshot(args: Record<string, unknown>, ctx: Record<string, unknown>): Result {
    try {
        const engine = get_native_desktop();
        const roi = dictGet(args, "roi");
        let roi_tuple: [number, number, number, number] | null = null;
        if (pyTruth(roi) && pyLenOf(roi) === 4) {
            roi_tuple = [pyInt(pySub(roi, 0)), pyInt(pySub(roi, 1)),
                pyInt(pySub(roi, 2)), pyInt(pySub(roi, 3))];
        }

        const quality = pyInt(dictGet(args, "quality", 80));
        const res = engine.capture_screen({ roi: roi_tuple, quality });

        const save_path = dictGet(args, "save_path");
        let saved_msg = "";
        if (pyTruth(save_path)) {
            // If path is relative, place in workspace
            let sp = save_path as string;
            if (!osPathIsabs(sp)) {
                sp = osPathJoin(dictGet(ctx, "workspace_root", process.cwd()) as string, sp);
            }
            mkdirSync(osPathDirname(osPathAbspath(sp)), { recursive: true });
            (pySub(res, "image") as { save(path: string): void }).save(sp);
            saved_msg = ", saved to " + pyStrVal(sp);
        }

        return Result.success({
            "width": pySub(res, "width"),
            "height": pySub(res, "height"),
            "scale_factor": pySub(res, "scale_factor"),
            "data_uri": pySub(res, "data_uri"),
            "summary": `Captured desktop screenshot (${pyStrVal(pySub(res, "width"))}x${pyStrVal(pySub(res, "height"))} @ ${pyFloatStr(pySub(res, "scale_factor") as number)}x DPI${saved_msg})`,
        });
    } catch (e) {
        return Result.failure("Screenshot capture failed: " + excStr(e));
    }
}

export function _computer_click(args: Record<string, unknown>, _ctx: Record<string, unknown>): Result {
    try {
        const engine = get_native_desktop();
        const x = pyInt(dictGet(args, "x", 0));
        const y = pyInt(dictGet(args, "y", 0));
        const button = pyStrVal(dictGet(args, "button", "left"));
        const clicks = pyInt(dictGet(args, "clicks", 1));

        engine.click({ x, y, button, clicks });
        return Result.success(`Clicked (${x}, ${y}) [button=${pyStrVal(button)}, clicks=${clicks}]`);
    } catch (e) {
        return Result.failure("Click failed: " + excStr(e));
    }
}

export function _computer_move_cursor(args: Record<string, unknown>, _ctx: Record<string, unknown>): Result {
    try {
        const engine = get_native_desktop();
        const x = pyInt(dictGet(args, "x", 0));
        const y = pyInt(dictGet(args, "y", 0));
        const smooth = pyTruth(dictGet(args, "smooth", true));

        engine.move_cursor({ x, y, smooth });
        return Result.success(`Moved cursor to (${x}, ${y})`);
    } catch (e) {
        return Result.failure("Cursor move failed: " + excStr(e));
    }
}

export function _computer_type(args: Record<string, unknown>, _ctx: Record<string, unknown>): Result {
    try {
        const engine = get_native_desktop();
        const text = pyStrVal(dictGet(args, "text", ""));
        const delay_ms = pyFloat(dictGet(args, "delay_ms", 10));

        engine.type_unicode(text, { delay_per_char: delay_ms / 1000.0 });
        return Result.success(
            `Typed ${pyLen(text)} characters: ${pySlice40(text)}${pyLen(text) > 40 ? "..." : ""}`);
    } catch (e) {
        return Result.failure("Type failed: " + excStr(e));
    }
}

export function _computer_press_key(args: Record<string, unknown>, _ctx: Record<string, unknown>): Result {
    try {
        const engine = get_native_desktop();
        const key = pyStrVal(dictGet(args, "key", ""));

        engine.press_key(key);
        return Result.success("Pressed hotkey: " + pyStrVal(key));
    } catch (e) {
        return Result.failure("Press key failed: " + excStr(e));
    }
}

export function _computer_drag(args: Record<string, unknown>, _ctx: Record<string, unknown>): Result {
    try {
        const engine = get_native_desktop();
        const sx = pyInt(dictGet(args, "start_x", 0));
        const sy = pyInt(dictGet(args, "start_y", 0));
        const ex = pyInt(dictGet(args, "end_x", 0));
        const ey = pyInt(dictGet(args, "end_y", 0));
        const duration = pyFloat(dictGet(args, "duration", 0.5));

        engine.drag(sx, sy, ex, ey, { duration });
        return Result.success(`Dragged from (${sx}, ${sy}) to (${ex}, ${ey})`);
    } catch (e) {
        return Result.failure("Drag failed: " + excStr(e));
    }
}

export function _computer_scroll(args: Record<string, unknown>, _ctx: Record<string, unknown>): Result {
    try {
        const engine = get_native_desktop();
        const clicks = pyInt(dictGet(args, "clicks", 0));
        const x = dictGet(args, "x");
        const y = dictGet(args, "y");
        const x_val = x !== null && x !== undefined ? pyInt(x) : null;
        const y_val = y !== null && y !== undefined ? pyInt(y) : null;

        engine.scroll(clicks, { x: x_val, y: y_val });
        return Result.success(`Scrolled ${clicks} units`);
    } catch (e) {
        return Result.failure("Scroll failed: " + excStr(e));
    }
}

// ---------------------------------------------------------------------------
// ─── OS App Lifecycle Implementations ────────────────────────────────────────
// ---------------------------------------------------------------------------

export function _safe_app_name(args: Record<string, unknown>): [string, null] | ["", Result] {
    try {
        return [shellWord(dictGet(args, "name", "") as string, "应用名"), null];
    } catch (e) {
        if (e instanceof BlockedCommandError) {
            return ["", Result.failure(excStr(e))];
        }
        throw e;
    }
}

export async function _app_list(args: Record<string, unknown>, _ctx: Record<string, unknown>): Promise<Result> {
    const filt = dictGet(args, "filter", "");
    let cmd: string;
    if (_platformSystem() === "Darwin") {
        cmd = "ls /Applications/ 2>/dev/null; ls ~/Applications/ 2>/dev/null";
    } else if (_platformSystem() === "Windows") {
        cmd = 'powershell "Get-StartApps | Format-Table -AutoSize"';
    } else {
        cmd = "ls /usr/share/applications/*.desktop 2>/dev/null | xargs -I{} basename {} .desktop";
    }
    const r = await tryResultAsync(() => _spawn(cmd, { timeout: 5 }).then((cp) => cp.stdout));
    if (!r.ok) {
        return Result.failure("Failed: " + r.error);
    }
    let lines = String(r.value).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (pyTruth(filt)) {
        const f = (filt as string).toLowerCase();
        lines = lines.filter((l) => l.toLowerCase().includes(f));
    }
    return Result.success(lines.slice(0, 30).join("\n"));
}

/** try_result over an awaitable: mirrors the source's lambda-in-try_result. */
async function tryResultAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
    try {
        return Result.success(await fn());
    } catch (e) {
        return Result.failure(excStr(e));
    }
}

export async function _app_launch(args: Record<string, unknown>, _ctx: Record<string, unknown>): Promise<Result> {
    const [name, err] = _safe_app_name(args);
    if (err !== null) {
        return err;
    }
    let cmd: string;
    if (_platformSystem() === "Darwin") {
        cmd = `open -a "${name}"`;
    } else if (_platformSystem() === "Windows") {
        cmd = `powershell "Start-Process '${name}'"`;
    } else {
        cmd = `xdg-open "${name}" 2>/dev/null || gtk-launch "${name}" 2>/dev/null`;
    }
    const r = await tryResultAsync(() => _spawn(cmd, { timeout: 5 }));
    return r.ok ? Result.success("Launched: " + pyStrVal(name)) : Result.failure("Launch failed: " + r.error);
}

export async function _app_close(args: Record<string, unknown>, _ctx: Record<string, unknown>): Promise<Result> {
    const [name, err] = _safe_app_name(args);
    if (err !== null) {
        return err;
    }
    let cmd: string;
    if (_platformSystem() === "Darwin") {
        cmd = `osascript -e 'tell application "${name}" to quit'`;
    } else if (_platformSystem() === "Windows") {
        cmd = `taskkill /im "${name}.exe" /f`;
    } else {
        cmd = `pkill -f "${name}"`;
    }
    const r = await tryResultAsync(() => _spawn(cmd, { timeout: 5 }));
    return r.ok ? Result.success("Closed: " + pyStrVal(name)) : Result.failure("Close failed: " + r.error);
}

export async function _app_focus(args: Record<string, unknown>, _ctx: Record<string, unknown>): Promise<Result> {
    const [name, err] = _safe_app_name(args);
    if (err !== null) {
        return err;
    }
    let cmd: string;
    if (_platformSystem() === "Darwin") {
        cmd = `osascript -e 'tell application "${name}" to activate'`;
    } else if (_platformSystem() === "Windows") {
        cmd = `powershell "Start-Process '${name}'"`;
    } else {
        return Result.failure("Focus not supported on Linux");
    }
    const r = await tryResultAsync(() => _spawn(cmd, { timeout: 5 }));
    return r.ok ? Result.success("Focused: " + pyStrVal(name)) : Result.failure("Focus failed: " + r.error);
}

// ---------------------------------------------------------------------------
// ─── Backward Compatibility Wrappers ─────────────────────────────────────────
// ---------------------------------------------------------------------------

export function _ui_screenshot_compat(args: Record<string, unknown>, ctx: Record<string, unknown>): Result {
    const res = _computer_screenshot({ "save_path": dictGet(args, "output_path", "screenshot.png") }, ctx);
    if (res.ok) {
        return Result.success("Screenshot saved: " + pyStrVal(dictGet(args, "output_path", "screenshot.png")));
    }
    return res;
}

export function _ui_auto_compat(args: Record<string, unknown>, ctx: Record<string, unknown>): Result {
    const action = dictGet(args, "action", "");
    if (action === "click") {
        return _computer_click({
            "x": dictGet(args, "x", 0), "y": dictGet(args, "y", 0),
            "button": dictGet(args, "button", "left"),
        }, ctx);
    } else if (action === "type") {
        return _computer_type({ "text": dictGet(args, "text", "") }, ctx);
    } else if (action === "key") {
        // 源如此：key 动作读的是 "text" 键。
        return _computer_press_key({ "key": dictGet(args, "text", "") }, ctx);
    } else if (action === "scroll") {
        // 源如此：scroll 的格数读的是 "text" 键，默认 5。
        return _computer_scroll({
            "clicks": dictGet(args, "text", 5), "x": dictGet(args, "x"), "y": dictGet(args, "y"),
        }, ctx);
    } else if (action === "drag") {
        // 源如此：起点硬编码 (0, 0)。
        return _computer_drag({
            "start_x": 0, "start_y": 0, "end_x": dictGet(args, "x", 0), "end_y": dictGet(args, "y", 0),
            "duration": dictGet(args, "duration", 1),
        }, ctx);
    }
    return Result.failure("Unsupported action: " + pyStrVal(action));
}

// ---------------------------------------------------------------------------
// ─── Long-Term Memory Tool Handlers ──────────────────────────────────────────
// ---------------------------------------------------------------------------

export async function _memory_add_tool(args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<Result> {
    const contentRaw = dictGet(args, "content");
    const content = (pyTruth(contentRaw) ? (contentRaw as string) : "").trim();
    if (!pyTruth(content)) {
        return Result.failure("content 不能为空");
    }
    try {
        const { get_memory_layer, Memory, MemoryScope } = await loadMemoryLayerModule();
        const wrRaw = dictGet(ctx, "workspace_root");
        const workspace_root = pyTruth(wrRaw) ? (wrRaw as string) : process.cwd();
        const memory = get_memory_layer();
        // present-but-null type/session_id stay null — the source's kwargs
        // pass them through verbatim (no || folding to the defaults).
        const mem = new Memory(
            content,
            dictGet(args, "type", "preference") as string,
            0.95,
            MemoryScope.WORKSPACE as string,
            workspace_root,
            dictGet(ctx, "session_id", "main") as string,
        );
        memory.store(mem);
        // Also append to MEMORY.md if available
        try {
            const fs = await import("node:fs");
            const mem_file = osPathJoin(workspace_root, "MEMORY.md");
            const line = `- ${content}\n`;
            let existing = "";
            if (fs.existsSync(mem_file)) {
                // open(..., errors="replace") — lossy UTF-8 decode.
                const buf = fs.readFileSync(mem_file) as unknown as Uint8Array;
                // open(..., "r", newline=None) — python universal newlines:
                // CRLF/CR on disk read back as "\n".
                existing = new TextDecoder("utf-8", { fatal: false }).decode(buf)
                    .replaceAll("\r\n", "\n").replaceAll("\r", "\n");
            }
            if (!existing.includes(content)) {
                // open(..., "a", newline=None) — "\n" translates to os.linesep.
                const NL = process.platform === "win32" ? "\r\n" : "\n";
                if (pyTruth(existing) && !existing.endsWith("\n")) {
                    fs.appendFileSync(mem_file, NL);
                }
                fs.appendFileSync(mem_file, line.replaceAll("\n", NL));
            }
        } catch {
            // BUG(port): 源的 `except Exception: pass`（宽吞、无日志），逐字保留。
        }
        return Result.success("已成功永久写入长期记忆与 MEMORY.md: " + pyStrVal(content));
    } catch (e) {
        return Result.failure("写入记忆失败: " + excStr(e));
    }
}

export async function _memory_search_tool(args: Record<string, unknown>, _ctx: Record<string, unknown>): Promise<Result> {
    const queryRaw = dictGet(args, "query");
    const query = (pyTruth(queryRaw) ? (queryRaw as string) : "").trim();
    if (!pyTruth(query)) {
        return Result.failure("query 不能为空");
    }
    try {
        const { memory_search } = await loadMemoryMcpModule();
        const res = await memory_search(query, dictGet(args, "limit", 5) as number);
        return Result.success(pyStrVal(res));
    } catch (e) {
        return Result.failure("搜索记忆失败: " + excStr(e));
    }
}

// ---------------------------------------------------------------------------
// singleton
// ---------------------------------------------------------------------------

let _agent: AppAgent | null = null;

export function get_app_agent(workspace: string | null = null, toolsMod?: ToolsModuleLike): AppAgent {
    if (_agent === null) {
        _agent = new AppAgent(workspace, toolsMod);
    }
    return _agent;
}

// PORT STATUS: confidence=high todos=[0]
