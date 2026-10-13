/**
 * mcp_server/tools/search_tools.ts — Local content search over the workspace.
 *
 * Ported from `app/backend/mcp_server/tools/search_tools.py` (85 lines).
 *
 * Ripgrep-like text search plus filename glob search, both scoped to the
 * caller's workspace_root.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: .../tools/search_tools.py -> .../tools/search_tools.ts
 *   §2  behaviour: `args.get("pattern","")` falsy gate, the *asymmetric*
 *       limit idioms (`int(x or default)` here vs plain `int(x)` in
 *       file_tools.list_dir), `ignore` union with the defaults, walk order
 *       and the `dirnames[:]` prune rule (ignored AND dotted dirs), the
 *       early `return Result.success(matches)` at the cap.
 *   DIVERGENCE(port): regex flavour. CPython `re` and JS RegExp accept
 *       different syntaxes; convertible patterns (the subset reachable from
 *       JSON callers here: literals, classes, quantifiers, groups) behave
 *       identically, and BadRegex outcomes are compared by code with the
 *       engine-specific message masked. fnmatch is re-implemented with
 *       python semantics (case-insensitive on Windows, `[!seq]` negation).
 *   DIVERGENCE(port): os.walk yields in OS directory order; Node's
 *       readdirSync consults the same directory stream, but the order is not
 *       contractually equal across runtimes. Result sets below the cap are
 *       compared after canonical sorting; cap-truncation scenarios use
 *       single-file fixtures so order cannot matter.
 *   DEFECT(fixed 2026-09-27, backfill evidence chain tmp/bst_*): three REAL
 *       divergences from CPython 3.13 (oracle tmp/bst_oracle_py.json
 *       root_faces/set_faces, run with python -B) were found and FIXED here
 *       instead of being pinned in the comparator:
 *       (1) the root gate now uses PYTHON truthiness - [] / {} previously
 *           passed the JS `!root` check and were coerced; CPython answers
 *           NoWorkspace for them;
 *       (2) a truthy NON-STRING root now raises TypeError at exactly the
 *           point CPython does (os.path.join inside search_code via pyJoin;
 *           os.walk/scandir inside find_files before any listing) - the old
 *           String() coercion silently walked a relative path instead;
 *       (3) pySet(dict) now iterates the dict's keys like CPython set(dict)
 *           instead of raising 'dict' object is not iterable.
 *       Previous port hash: 640d3ecd78bb8a6e (re-pinned by the lead).
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Result } from "../../result.js";

type JsonDict = Record<string, unknown>;

const _DEFAULT_IGNORE = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build"]);
const _MAX_MATCHES = 500;

/* ---------------- small python interop helpers ---------------------------- */

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

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") return "dict";
    return "object";
}

/** python truthiness for JSON-reachable values. */
function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as JsonDict).length > 0;
    return true;
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

/** python `os.path.join`: an absolute part resets everything before it. */
function pyJoin(...parts: unknown[]): string {
    const sep = process.platform === "win32" ? "\\" : "/";
    const isAbs = (p: string) =>
        process.platform === "win32" ? /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p) : p.startsWith("/");
    let res = "";
    for (const raw of parts) {
        if (typeof raw !== "string") {
            throw new PyTypeError(
                `join() argument must be str, bytes, or os.PathLike object, not '${pyTypeName(raw)}'`);
        }
        if (isAbs(raw)) { res = raw; continue; }
        if (res === "") { res = raw; continue; }
        res = (res.endsWith("\\") || res.endsWith("/")) ? res + raw : res + sep + raw;
    }
    return res;
}

/** python `args.get(key, default)`: default only for a *missing* key; an
 *  explicit JSON null stays null (see RULEBOOK §2 falsy-vs-missing). */
function argGet(o: JsonDict, k: string, d: unknown): unknown {
    return k in o ? o[k] : d;
}

/** python `set(args.get("ignore", []))`: lists dedup; strings explode to
 *  characters; dicts iterate their KEYS like CPython `set(dict)` (oracle
 *  tmp/bst_oracle_py.json set_faces); anything else is a TypeError out of
 *  the iteration protocol. Members stay python-typed: set([5]) is legal
 *  (only list/dict members are unhashable), and such members simply never
 *  match a str dir name. */
function pySet(x: unknown): Set<unknown> {
    if (Array.isArray(x)) {
        const out = new Set<unknown>();
        for (const item of x) {
            if (Array.isArray(item) || (typeof item === "object" && item !== null)) {
                throw new PyTypeError(`unhashable type: '${pyTypeName(item)}'`);
            }
            out.add(item);
        }
        return out;
    }
    // CPython set(dict) iterates the dict's KEYS (oracle set_faces).
    if (typeof x === "object" && x !== null) return new Set(Object.keys(x));
    if (typeof x === "string") return new Set(Array.from(x));
    throw new PyTypeError(`'${pyTypeName(x)}' object is not iterable`);
}

/* ---------------- os.walk parity ------------------------------------------ */

/**
 * Walk `root` yielding files, skipping ignored directory names.
 * Mirrors topdown os.walk with onerror=None (unreadable dirs are skipped).
 */
function _iter_files(root: string, ignore: Set<unknown>): string[] {
    const out: string[] = [];
    const walk = (dirpath: string): void => {
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(dirpath, { withFileTypes: true });
        } catch {
            return; // os.walk swallows scandir errors by default
        }
        const dirnames: string[] = [];
        const filenames: string[] = [];
        for (const e of dirents) {
            let isDir = e.isDirectory();
            if (e.isSymbolicLink()) {
                // DirEntry.is_dir() follows symlinks in os.walk.
                try { isDir = fs.statSync(path.join(dirpath, e.name)).isDirectory(); } catch { isDir = false; }
            }
            if (isDir) dirnames.push(e.name);
            else filenames.push(e.name);
        }
        const kept = dirnames.filter((d) => !ignore.has(d) && !d.startsWith("."));
        for (const fname of filenames) out.push(pyJoin(dirpath, fname));
        for (const d of kept) walk(pyJoin(dirpath, d));
    };
    walk(root);
    return out;
}

/* ---------------- fnmatch parity ------------------------------------------ */

/** python `fnmatch.translate` semantics: `*`/`?`/`[seq]` with `[!seq]`
 *  negation, everything else literal. Case-insensitive on Windows because
 *  fnmatch.normcase lowercases both sides there. */
function fnmatch(name: string, glob: string): boolean {
    let re = "^";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === "*") re += "[\\s\\S]*";
        else if (c === "?") re += "[\\s\\S]";
        else if (c === "[") {
            const j = glob.indexOf("]", i + 1);
            if (j < 0) { re += "\\["; continue; }
            let cls = glob.slice(i + 1, j);
            if (cls.startsWith("!")) cls = "^" + cls.slice(1);
            re += "[" + cls.replace(/[\\^$.|?*+(){}]/g, (m) => (m === "^" ? m : "\\" + m)) + "]";
            i = j;
        } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    re += "$";
    const flags = process.platform === "win32" ? "i" : "";
    return new RegExp(re, flags).test(name);
}

/* ---------------- tool handlers ------------------------------------------- */

/** Grep-like text search across the workspace. */
export function search_code(args: JsonDict, ctx: JsonDict): Result {
    const root = ctx["workspace_root"];
    // CPython `if not root` is PYTHON truthiness: [] / {} / 0 / "" all fail
    // the gate (DEFECT(fix): JS truthiness treated [] / {} as a usable root).
    if (!pyTruth(root)) {
        return Result.failure("Missing workspace_root", { code: "NoWorkspace" });
    }
    const pattern = argGet(args, "pattern", "");
    if (!pyTruth(pattern)) {
        return Result.failure("Missing 'pattern'", { code: "MissingArg" });
    }
    if (typeof pattern !== "string") {
        // Measured on py3.13: re.compile(5) -> this exact message.
        throw new PyTypeError("first argument must be string or compiled pattern");
    }
    const flags = pyTruth(args["ignore_case"]) ? "i" : "";
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, flags);
    } catch (e) {
        // re.error message text is engine-specific; code channel identical.
        return Result.failure(`Invalid regex: ${(e as Error).message}`, { code: "BadRegex" });
    }
    const limit = Math.min(pyInt(pyTruth(args["limit"]) ? args["limit"] : 100), _MAX_MATCHES);
    // pyJoin mirrors os.path.join's TypeError on a non-str part (DEFECT(fix):
    // the old String(root) coercion swallowed CPython's TypeError face).
    const base = pyJoin(root, argGet(args, "path", ""));
    const ignore = new Set([...pySet(argGet(args, "ignore", [])), ..._DEFAULT_IGNORE]);

    const matches: string[] = [];
    for (const p of _iter_files(base, ignore)) {
        let text: string;
        try {
            text = fs.readFileSync(p).toString("utf8"); // errors="replace" parity
        } catch {
            continue; // OSError: skip unreadable files
        }
        // Text-mode open() does universal-newline translation before lines
        // are split: \r\n and lone \r both become \n.
        text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = text.split(/(?<=\n)/); // keepends, like iterating a text file
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
                const rel = path.relative(String(root), p);
                matches.push(`${rel}:${i + 1}:${lines[i]!.replace(/\s+$/, "")}`);
                if (matches.length >= limit) return Result.success(matches);
            }
        }
    }
    return Result.success(matches);
}

/** Glob for filenames under the workspace. */
export function find_files(args: JsonDict, ctx: JsonDict): Result {
    const root = ctx["workspace_root"];
    // CPython `if not root` is PYTHON truthiness (see search_code DEFECT(fix)).
    if (!pyTruth(root)) {
        return Result.failure("Missing workspace_root", { code: "NoWorkspace" });
    }
    const glob = argGet(args, "glob", "*");
    const limit = Math.min(pyInt(pyTruth(args["limit"]) ? args["limit"] : 200), _MAX_MATCHES);
    const ignore = new Set([...pySet(argGet(args, "ignore", [])), ..._DEFAULT_IGNORE]);
    if (typeof root !== "string") {
        // os.walk -> os.scandir raises TypeError on a non-path top BEFORE any
        // listing (DEFECT(fix): the old String(root) coercion walked "" instead).
        throw new PyTypeError(`walk: path should be string, bytes, or os.PathLike, not '${pyTypeName(root)}'`);
    }
    const out: string[] = [];
    for (const p of _iter_files(root, ignore)) {
        const rel = path.relative(String(root), p);
        if (typeof glob !== "string") {
            // fnmatch.translate -> os.fspath message (no quotes around type).
            throw new PyTypeError(`expected str, bytes or os.PathLike object, not ${pyTypeName(glob)}`);
        }
        if (fnmatch(path.basename(p), glob)) {
            out.push(rel);
            if (out.length >= limit) break;
        }
    }
    return Result.success(out);
}

export const TOOLS: Record<string, (args: JsonDict, ctx: JsonDict) => Result> = {
    search_code,
    find_files,
};

// PORT STATUS: confidence=high todos=[0]
