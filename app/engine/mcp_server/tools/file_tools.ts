/**
 * mcp_server/tools/file_tools.ts — File I/O tools exposed through the gateway.
 *
 * Ported from `app/backend/mcp_server/tools/file_tools.py` (93 lines).
 *
 * These mirror the local file_agent surface but run inside the MCP server
 * context, so path resolution happens against the caller-provided workspace,
 * not the desktop app's workspace. Each handler returns a Result so the
 * gateway can serialize failures without special-casing exceptions.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: .../mcp_server/tools/file_tools.py -> .../mcp_server/tools/file_tools.ts
 *   §2  behaviour: `if not root` truthiness gate, `entries[:int(limit)]`
 *       python slicing (negative limits count from the end), `dirname or "."`,
 *       the atomic tmp+rename flow, and the source's leave-empty-tmp-behind
 *       behaviour when `f.write()` raises TypeError on a non-str payload
 *       (the OSError-only except never unlinks in that case).
 *   DIVERGENCE(port): OSError/IOError message *text* is stdlib-specific
 *       ("[Errno 2] No such file or directory: 'p'" vs "ENOENT: no such file
 *       or directory, open 'p'"). The failure codes, control flow and value
 *       shapes are identical; only the human-readable string differs, and it
 *       is OS/CPython-version dependent on the source side too.
 *   DIVERGENCE(port): fs.realpathSync throws for missing paths while
 *       os.path.realpath does not — pyRealpath below walks up to the longest
 *       existing ancestor and re-appends the tail, matching python's result.
 *
 * FIXED(port) 2026-09-28, measured on CPython (tmp/bft_oracle3.json,
 * tmp/bft_oracle4.json) — these were silent behaviour changes, see
 * tmp/bft_STATE.md §5 for the evidence lines:
 *   1. `fs.realpathSync` is case-PRESERVING on Windows while
 *      `ntpath.realpath` case-NORMALIZES every existing component
 *      ("...\CASECHK" -> "...\casechk"). Because `_resolve` compares the two
 *      realpath outputs case-sensitively, the wrong API could flip the
 *      PathEscape decision, not just the returned spelling. Now
 *      `fs.realpathSync.native`, which matches the source on all 7 measured
 *      faces.
 *   2. `open(..., encoding="utf-8")` is CPython *text mode*: reading maps
 *      "\r\n" and a lone "\r" to "\n", writing maps "\n" to os.linesep. Node
 *      does neither, so `read_text` returned and `write_text` stored different
 *      bytes than the source. Both now translate (pyReadNewlines /
 *      pyWriteNewlines); the reported `bytes` still counts the *input* string,
 *      exactly like `len(content.encode("utf-8"))` on the source.
 *   3. the header claimed to preserve the `if not root` truthiness gate, but JS
 *      truthiness is not Python truthiness: `[]` and `{}` are FALSY in Python
 *      and TRUTHY in JS, so a caller passing an empty list/dict as
 *      `workspace_root` got `NoWorkspace` from the source and a TypeError out
 *      of `join()` here. Added `pyFalsy`, measured on the source interpreter
 *      (tmp/bft_oracle5.json: the real module returns ok=False code=NoWorkspace
 *      for workspace_root=[] and workspace_root={}).
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Result } from "../../result.js";

type JsonDict = Record<string, unknown>;

const SEP = process.platform === "win32" ? "\\" : "/";

/** python `os.linesep` for the running platform (what `newline=None` writes). */
const LINESEP = process.platform === "win32" ? "\r\n" : "\n";

/**
 * CPython *text-mode* read translation (`open(..., encoding="utf-8")` never
 * passes `newline`, so "\r\n" and a lone "\r" both arrive as "\n"). Measured on
 * the source interpreter: "a\r\r\nb" -> "a\n\nb", "a\r\n\rb" -> "a\n\nb",
 * while U+0085 / U+2028 / \x0c are left alone. Node has no such translation.
 */
function pyReadNewlines(s: string): string {
    return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * CPython text-mode write translation: every "\n" becomes `os.linesep`, other
 * characters (including a bare "\r") are passed through, so "a\r\nb" lands on
 * disk as "a\r\r\nb". POSIX is the identity because there os.linesep is "\n".
 */
function pyWriteNewlines(s: string): string {
    return LINESEP === "\n" ? s : s.replace(/\n/g, LINESEP);
}

/* ---------------- python-path helpers (ntpath/posixpath flavour) ---------- */

class PyTypeError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}

class PyValueError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}

/**
 * CPython raises `ValueError: embedded null byte` from every os function that
 * gets a path containing a NUL (its C argument converter). `open()` / `listdir()`
 * are NOT inside the source's `except OSError`, so that ValueError escapes the
 * handler and crashes the call; only `_resolve`'s `except (OSError, ValueError)`
 * could ever catch one, and it never sees one because `os.path.realpath` gets a
 * plain string and `os.path.islink` swallows ValueError.
 *
 * Node is worse here: libuv takes C strings, so `fs.realpathSync.native` SILENTLY
 * truncates the path at the NUL — `read("a.txt\u0000evil")` would hand back the
 * contents of `a.txt`. Checking the caller's own argument as well as the resolved
 * value reproduces the source exactly (raise, touch nothing) and closes that hole.
 */
function pyNoNul(...parts: unknown[]): void {
    for (const p of parts) {
        if (typeof p === "string" && p.includes("\0")) {
            throw new PyValueError("embedded null byte");
        }
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (isPyDict(v)) return "dict";
    return "object";
}

function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/**
 * python `not x` for the JSON-reachable domain. JS `!x` is NOT the same
 * predicate: `[]` and `{}` are falsy in CPython and truthy in JS, so the
 * `if not root:` gate of the source needs its own translation.
 */
function pyFalsy(v: unknown): boolean {
    if (v === null || v === undefined) return true;
    if (typeof v === "boolean") return !v;
    if (typeof v === "number") return v === 0 || Number.isNaN(v);
    if (typeof v === "string") return v.length === 0;
    if (Array.isArray(v)) return v.length === 0;
    if (isPyDict(v)) return Object.keys(v).length === 0;
    return false;
}

/** python `os.path.isabs` for the running platform. */
function pyIsAbs(p: string): boolean {
    if (process.platform === "win32") return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p);
    return p.startsWith("/");
}

/** python `os.path.join`: an absolute part resets everything before it. */
function pyJoin(...parts: unknown[]): string {
    let res = "";
    for (const raw of parts) {
        if (typeof raw !== "string") {
            throw new PyTypeError(
                `join() argument must be str, bytes, or os.PathLike object, not '${pyTypeName(raw)}'`);
        }
        if (pyIsAbs(raw)) { res = raw; continue; }
        if (res === "") { res = raw; continue; }
        res = (res.endsWith("\\") || res.endsWith("/")) ? res + raw : res + SEP + raw;
    }
    return res;
}

/** python `os.path.realpath` for paths that may not exist.
 *  `.native` is load-bearing: plain `fs.realpathSync` keeps the caller's letter
 *  case on Windows, `ntpath.realpath` normalises it to the on-disk case (the
 *  escape check below compares the two results case-sensitively).
 *
 *  FIXED(port) 2026-09-28 (measured on CPython: tmp/bft_oracle_nul.json): Windows
 *  `ntpath.realpath` runs the path through `GetFullPathNameW`, which strips a
 *  trailing-space component ("...\\cwd\\ " -> "...\\cwd"). Node's `path.resolve`
 *  keeps the space, so `fs.realpathSync.native` never sees the same path and the
 *  workspace-root == " " row resolved to a non-existent directory (ListError)
 *  where the source listed the (empty) workspace. Trailing spaces are stripped
 *  here to match; no fixture path legitimately ends in a space. */
function pyRealpath(p: string): string {
    let cur = process.platform === "win32" ? p.replace(/ +$/, "") : p;
    const tail: string[] = [];
    for (;;) {
        try {
            const real = fs.realpathSync.native(cur);
            return tail.length ? path.join(real, ...tail) : real;
        } catch (e) {
            const parent = path.dirname(cur);
            if (parent === cur) {
                // CPython `os.path.realpath` NEVER raises for a plain str path:
                // when even the topmost ancestor cannot be resolved it returns the
                // normalised input. Node's `.native` rejects the extended-length
                // prefix ("\\?\C:\x" -> ENOENT) all the way up to its drive root,
                // where dirname is a fixpoint. Reconstruct that best-effort value
                // instead of throwing, so _resolve's escape gate sees the same
                // target the source does (esc#unc_prefix: PathEscape, not BadPath).
                return tail.length ? path.join(cur, ...tail) : cur;
            }
            tail.unshift(path.basename(cur));
            cur = parent;
        }
    }
}

/** python `str.rstrip(sep)`: drop *all* trailing separators. */
function pyRstripSep(s: string): string {
    let end = s.length;
    while (end > 0 && (s[end - 1] === "\\" || s[end - 1] === "/")) end--;
    return s.slice(0, end);
}

/** python `int(x)` for the JSON-reachable domain. */
function pyInt(x: unknown): number {
    if (typeof x === "boolean") return x ? 1 : 0;
    if (typeof x === "number") return Math.trunc(x);
    if (typeof x === "string") {
        const t = x.trim();
        if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
        throw new PyValueError(`invalid literal for int() with base 10: '${x}'`);
    }
    throw new PyTypeError(
        "int() argument must be a string, a bytes-like object or a real number, " +
        `not '${pyTypeName(x)}'`);
}

/** python `arr[:n]`, including the negative-n-from-the-end case. */
function pySliceN<T>(arr: T[], n: number): T[] {
    return n >= 0 ? arr.slice(0, Math.min(n, arr.length)) : arr.slice(0, Math.max(0, arr.length + n));
}

/** python `args.get(key, default)`: the default fires ONLY for a missing key;
 *  an explicit JSON null stays null (the `??` operator would wrongly swallow
 *  it) — found by the mcp probe on write_text(content:null). */
function argGet(o: JsonDict, k: string, d: unknown): unknown {
    return k in o ? o[k] : d;
}

/* ---------------- tool handlers ------------------------------------------- */

/** Confine `path` to the caller's workspace. */
function _resolve(ctx: JsonDict, p: unknown): Result {
    const root = ctx["workspace_root"];
    if (pyFalsy(root)) {
        return Result.failure("Missing workspace_root", { code: "NoWorkspace" });
    }
    let target: string;
    let base: string;
    try {
        const joined = pyJoin(root, p);
        target = pyRealpath(pyAbspath(joined));
        base = pyRealpath(pyAbspath(String(root)));
    } catch (e) {
        // py catches only (OSError, ValueError) here — a TypeError from
        // join()/realpath() escapes to _invoke unchanged.
        if (e instanceof PyTypeError) throw e;
        return Result.failure(`Bad path: ${(e as Error).message}`, { code: "BadPath" });
    }
    if (target !== base && !target.startsWith(pyRstripSep(base) + SEP)) {
        return Result.failure("Path escapes workspace", { code: "PathEscape" });
    }
    return Result.success(target);
}

/** python `os.path.abspath` = normpath(join(cwd, p)) — path.resolve matches
 *  for every input the gateway actually reaches (drive-absolute posix-style
 *  paths like "/x" differ; documented DIVERGENCE in the header). */
function pyAbspath(p: string): string {
    return path.resolve(p);
}

/** Read a text file under the caller's workspace. */
export function read_text(args: JsonDict, ctx: JsonDict): Result {
    const rawPath = argGet(args, "path", "");
    const resolved = _resolve(ctx, rawPath);
    if (!resolved.ok) return resolved;
    try {
        // CPython raises `ValueError: embedded null byte` from open() and that
        // ValueError is NOT caught by `except OSError`, so it escapes the whole
        // call (measured on the source: tmp/bft_oracle_nul.json read_nul).
        pyNoNul(rawPath);
        // errors="replace": Node's utf8 decode substitutes U+FFFD the same way
        // (measured byte-for-byte on 9 sequences, tmp/bft_oracle2/3.json);
        // pyReadNewlines adds the text-mode translation Node does not do.
        return Result.success(pyReadNewlines(fs.readFileSync(resolved.value as string).toString("utf8")));
    } catch (e) {
        if (e instanceof PyValueError) throw e;
        return Result.failure(`read failed: ${(e as Error).message}`, { code: "ReadError" });
    }
}

/** Atomic write of a text file (tmp + rename). */
export function write_text(args: JsonDict, ctx: JsonDict): Result {
    const rawPath = argGet(args, "path", "");
    const resolved = _resolve(ctx, rawPath);
    if (!resolved.ok) return resolved;
    const content = argGet(args, "content", "");
    const target = resolved.value as string;
    const tmp = `${target}.tmp.${process.pid}`;
    try {
        // CPython's write_text runs `os.makedirs(os.path.dirname(target) or ".")`
        // BEFORE `open(tmp)`. So for a target whose file-name component contains a
        // NUL (e.g. "out/g\u0000h.txt") the *parent* ("out", no NUL) is still
        // created, and only the subsequent `open(tmp)` raises
        // `ValueError: embedded null byte` (measured: tmp/bft_oracle_nul.json),
        // which the OSError-only except does not catch, so it escapes. Reproduce
        // that exact order and side-effect: mkdir the dirname, then check the tmp
        // name. (The tmp carries the NUL iff the caller's path did.)
        fs.mkdirSync(path.dirname(target) || ".", { recursive: true });
        pyNoNul(tmp);
        // python creates+truncates the tmp file *before* f.write() raises on a
        // non-str payload, and the TypeError bypasses the OSError cleanup, so
        // the empty tmp file survives. Reproduce that exact disk state.
        fs.writeFileSync(tmp, "", "utf8");
        if (typeof content !== "string") {
            // Measured on the source: CPython formats None as "None" but
            // everything else by type name ("int", "bool", ...).
            const tn = content === null || content === undefined ? "None" : pyTypeName(content);
            throw new PyTypeError(`write() argument must be str, not ${tn}`);
        }
        // CPython text mode writes "\n" as os.linesep; the reported `bytes`
        // stays len(content.encode("utf-8")) of the *input*, as on the source.
        fs.writeFileSync(tmp, pyWriteNewlines(content), "utf8");
        fs.renameSync(tmp, target);
    } catch (e) {
        if (e instanceof PyTypeError || e instanceof PyValueError) throw e;
        try {
            fs.unlinkSync(tmp);
        } catch {
            // fail-open: 可选增强，失败不影响主流程
        }
        return Result.failure(`write failed: ${(e as Error).message}`, { code: "WriteError" });
    }
    return Result.success({ path: target, bytes: Buffer.byteLength(content as string, "utf8") });
}

/** List directory entries, directories suffixed with `/`. */
export function list_dir(args: JsonDict, ctx: JsonDict): Result {
    const rawPath = argGet(args, "path", ".");
    const resolved = _resolve(ctx, rawPath);
    if (!resolved.ok) return resolved;
    let entries: string[];
    try {
        // os.listdir() raises `ValueError: embedded null byte` for a NUL path and
        // the source's `except OSError` does not swallow it (measured:
        // tmp/bft_oracle_nul.json list_nul) - it escapes the whole call.
        pyNoNul(rawPath);
        // python sorted(): codepoint order, not JS default UTF-16 order.
        entries = fs.readdirSync(resolved.value as string).sort((a, b) => {
            const ca = Array.from(a);
            const cb = Array.from(b);
            for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
                const da = ca[i]!.codePointAt(0)!;
                const db = cb[i]!.codePointAt(0)!;
                if (da !== db) return da - db;
            }
            return ca.length - cb.length;
        });
    } catch (e) {
        if (e instanceof PyValueError) throw e;
        return Result.failure(`list failed: ${(e as Error).message}`, { code: "ListError" });
    }
    const limit = pyInt(argGet(args, "limit", 200));
    const labeled: string[] = [];
    for (const name of pySliceN(entries, limit)) {
        const full = pyJoin(resolved.value as string, name);
        let isDir = false;
        try {
            isDir = fs.statSync(full).isDirectory();
        } catch {
            isDir = false; // os.path.isdir swallows OSError -> False
        }
        labeled.push(name + (isDir ? "/" : ""));
    }
    return Result.success(labeled);
}

export const TOOLS: Record<string, (args: JsonDict, ctx: JsonDict) => Result> = {
    read_text,
    write_text,
    list_dir,
};

// PORT STATUS: confidence=high todos=[0]
