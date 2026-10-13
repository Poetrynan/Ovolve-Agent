/**
 * ecosystem_skill_scanner.ts — Multi-protocol ecosystem skill scanner & adapter.
 *
 * Ported from `app/backend/ecosystem_skill_scanner.py` (238 lines, wave-6,
 * unit 146).
 *
 * Discovery across vendor layouts (.claude/skills, .agents/skills, .skills,
 * workspace-level), this module's OWN frontmatter dialect (it is deliberately
 * looser than skill_loader's YAML reader — see the quirk list below), protocol
 * detection, and adaptation into the native SkillEntry.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/ecosystem_skill_scanner.py
 *       -> app/engine/ecosystem_skill_scanner.ts
 *   §4  py kwargs: `EcosystemSkillScanner(search_roots=[...])` and
 *       `scan(workspace_root=...)` keep their names and become plain optional
 *       parameters; `SkillEntry(name=…, path=…, …)` was already positional in
 *       the landed skill_loader port, so the call site is unchanged in spirit.
 *   §2  bug-for-bug (all pinned by the parity probe):
 *       - `key:` with neither an inline list nor a `- item` block stores the
 *         EMPTY STRING, not a list and not None — the `if seq:` guard falls
 *         through to the scalar branch with `val` still "".
 *       - inline `[a, ""]` keeps an empty member: the filter tests `p.strip()`
 *         BEFORE the quote chop, so `""` survives as `""`.
 *       - `.strip("\"'")` (both ends, any run, either quote) is NOT "one
 *         matching pair": `'a"` → `a`, `"a'b` → `a` … it eats mixed runs.
 *       - `- ` list items need the space: `-foo` breaks the block, and the
 *         orphan lines are then re-read as ordinary `key: value` lines.
 *       - a `#` comment line inside a list block is SKIPPED and the block
 *         continues; any other non-`- ` line ENDS it.
 *       - `name`/`description` go through `str(...)`, so a list value yields
 *         python's repr ("['a', 'b']") instead of a nicer rendering.
 *       - `requires: vision` (a bare string) produces []: only a list is read.
 *       - tools fall through the `tools` → `allowed-tools` → `allowed_tools`
 *         `or` chain, so an empty list / empty string silently defers.
 *       - discovery dedupes by RESOLVED path, so the same file reached twice
 *         (search root + workspace root both cover it) is parsed ONCE, and the
 *         first root wins the ordering.
 *       - ignored-directory pruning happens AFTER the yield, exactly like
 *         `dirnames[:] = …` mutating the walk's own list.
 *       - `read_text(encoding="utf-8")` is TEXT mode, which is observable twice
 *         over: a malformed byte sequence raises and the file is skipped
 *         (return None) rather than being read with U+FFFD, and universal
 *         newlines rewrite "\r\n"/"\r" into "\n" BEFORE content_hash is taken,
 *         so a CRLF SKILL.md hashes as if it were LF.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   pathlib: python drives this module with Path objects (`.resolve()`,
 *       `.parent`, `.name`, `.parts`, `/`). The port keeps plain strings plus
 *       four helpers (pyPathStr / pyPathName / pyPathParent / pyPathParts over
 *       winPathParse) that reproduce PurePath's string shape: unified "\\"
 *       separators, empty and "." components dropped, ".." KEPT, anchors
 *       ("C:\", "\", "\\srv\share\") kept as the first component, and the
 *       empty path rendered as ".". The probe pins all four against pathlib
 *       itself over a battery of spellings, so there is no residual gap here.
 *   DIVERGENCE(port, case-insensitive de-dupe): on Windows Path.__hash__ uses
 *       the case-folded string, so `resolved in visited` ignores case. The port
 *       folds the key explicitly (normcaseKey). Inputs are all post-resolve, so
 *       both sides see the real on-disk casing anyway; the fold only matters if
 *       a caller passes two differently-cased roots.
 *   DIVERGENCE(port, directory type of a symlink): python's os.walk asks
 *     `entry.is_dir()`, which FOLLOWS a symlink, then refuses to descend via
 *     `os.path.islink(join(top, name))`; Node's Dirent does not follow. The walk
 *     helper therefore stats symlink entries to classify them and skips
 *     descending into any link, reproducing followlinks=False exactly.
 *   DIVERGENCE(port, os.walk errors): an unreadable directory is silently
 *       skipped by os.walk (its OSError is swallowed because onerror is None);
 *       the helper wraps readdir in try/catch and continues.
 *   DIVERGENCE(port, dict key order): a JS object enumerates integer-like
 *       string keys ("2", "10") in ascending numeric order ahead of the rest,
 *       while a python dict always keeps insertion order. This is visible only
 *       through `EcosystemSkill.frontmatter` / `SkillEntry.frontmatter`, and
 *       only for a frontmatter whose KEYS are numeric strings ("10: a").
 *       Nothing in this module ever iterates a frontmatter — every read is a
 *       keyed lookup (dictGet / dictHasKey) over the eleven names it knows —
 *       and `2:` / `10:` are not frontmatter fields any loader defines, so the
 *       order has no consumer. Pinned by the probe (two `parse_fm` steps tagged
 *       accept=dict-key-order), so a change here cannot go unnoticed.
 *   str.lower(): used for the SKILL.md/SKILL.yaml filename test. CPython's
 *       full-Unicode lowering and V8's agree for every name that can match this
 *       two-value set (the comparison is ASCII-only).
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { SkillEntry, TrustLevel, normalize_bool } from "./skill_loader.js";

type JsonDict = Record<string, unknown>;

// ── python-semantics helpers (house style: cron_manager.ts / skill_loader.ts) ─

class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (typeof v === "function") return "function";
    return "dict";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true; // python functions are truthy
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map) return v.size > 0;
    return Object.keys(v as object).length > 0;
}

/** python `a or b`: returns the first truthy OPERAND (not a boolean). */
function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

function isPyDict(v: unknown): v is JsonDict {
    return (
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        !(v instanceof Map) &&
        typeof v !== "function"
    );
}

/** `d.get(k)` / `d in …` over the mapping shapes this module meets. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (obj instanceof Map) return obj.has(key) ? obj.get(key) : dflt;
    if (isPyDict(obj)) {
        return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as JsonDict)[key] : dflt;
    }
    throw new AttributeErrorP(`'${pyTypeName(obj)}' object has no attribute 'get'`);
}

function dictHasKey(obj: unknown, key: string): boolean {
    if (obj instanceof Map) return obj.has(key);
    if (isPyDict(obj)) return Object.prototype.hasOwnProperty.call(obj, key);
    throw new TypeErrorP(`argument of type '${pyTypeName(obj)}' is not iterable`);
}

/** repr() for the atoms/containers `str(...)` reaches in this module. */
function pyReprStr(s: string): string {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === "\\") out += "\\\\";
        else if (ch === quote) out += "\\" + ch;
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
        else out += ch;
    }
    return out + quote;
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Map) {
        const parts: string[] = [];
        for (const [k, val] of v) parts.push(`${pyRepr(k)}: ${pyRepr(val)}`);
        return "{" + parts.join(", ") + "}";
    }
    if (isPyDict(v)) {
        return (
            "{" +
            Object.keys(v)
                .map((k) => `${pyRepr(k)}: ${pyRepr((v as JsonDict)[k])}`)
                .join(", ") +
            "}"
        );
    }
    return pyStr(v);
}

/** python str(x): containers go through repr(), atoms print bare. */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "nan";
        if (v === Infinity) return "inf";
        if (v === -Infinity) return "-inf";
        return String(v);
    }
    if (typeof v === "string") return v;
    if (typeof v === "function") return `<function ${v.name || "?"}>`;
    if (v instanceof Error) return pyStrExc(v);
    if (Array.isArray(v) || isPyDict(v) || v instanceof Map) return pyRepr(v);
    return String(v);
}

function pyStrExc(e: unknown): string {
    if (e instanceof Error) return e.message;
    return pyStr(e);
}

/** Python str.strip() (default whitespace set), house-implementation match. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x0b\x1c\x1d\x1e\x1f]+|[\s\x0b\x1c\x1d\x1e\x1f]+$/g, "");
}

/** str.strip("\"'"): any run of either quote char at either end. */
function pyStripQuotes(s: string): string {
    return s.replace(/^["']+|["']+$/g, "");
}

/** CPython str.splitlines() line boundaries. */
const LINE_BOUNDARIES = /[\n\v\f\r\x1c\x1d\x1e\u0085\u2028\u2029]/;
function pySplitlines(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    const chars = Array.from(s);
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string;
        if (ch === "\r" && chars[i + 1] === "\n") {
            out.push(cur);
            cur = "";
            i++;
            continue;
        }
        if (LINE_BOUNDARIES.test(ch)) {
            out.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    if (cur.length > 0) out.push(cur);
    return out;
}

/** str.split(sep, maxsplit) with sep a non-empty string. */
function pySplitMax(s: string, sep: string, maxsplit: number): string[] {
    const out: string[] = [];
    let i = 0;
    let cuts = 0;
    while (true) {
        const at = s.indexOf(sep, i);
        if (at < 0 || cuts >= maxsplit) {
            out.push(s.slice(i));
            break;
        }
        out.push(s.slice(i, at));
        i = at + sep.length;
        cuts++;
    }
    return out;
}

/** str[1:-1] by code points (only ever applied to a >= 2-char "[…]" here). */
function pyChopBrackets(s: string): string {
    const chars = Array.from(s);
    return chars.slice(1, chars.length - 1).join("");
}

// ── pathlib surface (string-shaped) ─────────────────────────────────────────
//
// These reproduce `str(PureWindowsPath(x))`, `.parts`, `.name` and `.parent`.
// They are exported because the parity probe compares them against pathlib
// itself over a battery of spellings — python reaches the same behaviour
// through the Path object, the port through these helpers.

type WinPathParse = { anchor: string; root: string; names: string[] };

/** PureWindowsPath's decomposition: an optional drive/UNC anchor, an optional
 *  root separator, and name components. Separators are unified, empty and "."
 *  components dropped, ".." KEPT (pathlib never folds it). */
export function winPathParse(raw: string): WinPathParse {
    const s = raw.replace(/\//g, "\\");
    let anchor = "";
    let root = "";
    let rest = s;
    if (s.startsWith("\\\\")) {
        const unc = /^\\\\[^\\]+\\[^\\]+/.exec(s);
        if (unc) {
            anchor = unc[0];
            rest = s.slice(anchor.length);
            // A UNC anchor always carries its root separator: str(Path(r"\\srv\share"))
            // is "\\\\srv\\share\\".
            root = "\\";
            if (rest.startsWith("\\")) rest = rest.slice(1);
        } else {
            rest = s.slice(2);
            root = "\\";
            const comps = rest.split("\\").filter((c) => c.length > 0 && c !== ".");
            return { anchor: "\\\\", root: "", names: comps };
        }
    } else {
        const drive = /^([A-Za-z]:)/.exec(s);
        if (drive) {
            anchor = drive[1] as string;
            rest = s.slice(anchor.length);
        } else if (s.startsWith("\\")) {
            root = "\\";
            rest = s.slice(1);
        }
    }
    if (rest.startsWith("\\")) {
        root = "\\";
        rest = rest.slice(1);
    }
    const names = rest.split("\\").filter((c) => c.length > 0 && c !== ".");
    return { anchor, root, names };
}

function winPathStr(p: WinPathParse): string {
    if (p.root !== "") return p.anchor + p.root + p.names.join("\\");
    if (p.anchor !== "") {
        // No root: the anchor stays glued to the first name ("C:rel/x").
        if (p.names.length === 0) return p.anchor;
        return p.anchor + p.names.join("\\");
    }
    const out = p.names.join("\\");
    return out === "" ? "." : out;
}

/** str(Path(x)) on Windows. */
export function pyPathStr(raw: unknown): string {
    if (typeof raw !== "string" && !(raw instanceof String)) {
        if (typeof raw === "object" && raw !== null && "pyPath" in (raw as JsonDict)) {
            raw = String((raw as JsonDict).pyPath);
        } else {
            throw new TypeErrorP(
                `argument should be a str or an os.PathLike object where __fspath__ returns a str, not '${pyTypeName(raw)}'`
            );
        }
    }
    return winPathStr(winPathParse(String(raw)));
}

/** PurePath.parts — the anchor (plus root, when present) is the first entry.
 *  A drive WITHOUT a root separator is its own component: "C:a/b" splits into
 *  ("C:", "a", "b") even though str() renders it glued back together. */
export function pyPathParts(p: string): string[] {
    const q = winPathParse(p);
    if (q.root !== "") return [q.anchor + q.root, ...q.names];
    if (q.anchor !== "") return [q.anchor, ...q.names];
    return [...q.names];
}

/** PurePath.name — "" when nothing is left after the anchor and the root. */
export function pyPathName(p: string): string {
    const q = winPathParse(p);
    return q.names.length > 0 ? (q.names[q.names.length - 1] as string) : "";
}

/** PurePath.parent — drop the last name, or stay put on an anchor-only path. */
export function pyPathParent(p: string): string {
    const q = winPathParse(p);
    if (q.names.length === 0) return winPathStr(q);
    return winPathStr({ anchor: q.anchor, root: q.root, names: q.names.slice(0, q.names.length - 1) });
}

/** Windows Path.__hash__ / equality fold (case + separators). */
function normcaseKey(p: string): string {
    return p.replace(/\//g, "\\").toLowerCase();
}

// ── 测试缝 ───────────────────────────────────────────────────────────────────

export type Dirent3 = { name: string; isDir: boolean; isLink: boolean };

export const ECO_SEAMS = {
    /** python `Path.exists()`（os.walk 之前那道门）。 */
    pathExists: (p: string): boolean => fs.existsSync(p),
    /** python `Path.resolve()`（strict=False：解析失败退回 abspath）。 */
    resolvePath: (p: string): string => {
        try {
            return fs.realpathSync(p);
        } catch {
            return path.win32.resolve(p);
        }
    },
    /** python `skill_file.read_text(encoding="utf-8")`. Text mode, so two
     *  properties are observable: a malformed byte sequence raises
     *  UnicodeDecodeError (the caller swallows it and skips the file), and
     *  universal newlines rewrite "\r\n"/"\r" into "\n" BEFORE the caller
     *  hashes the content. `ignoreBOM` keeps the U+FEFF the utf-8 codec keeps. */
    readFileUtf8: (p: string): string => {
        const buf = fs.readFileSync(p);
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
        return text.replace(/\r\n?/g, "\n");
    },
    /** python `os.scandir` 一层的原始条目（顺序即 os.walk 看到的顺序）。 */
    readDir: (p: string): Dirent3[] =>
        fs.readdirSync(p, { withFileTypes: true }).map((e) => {
            let isDir = e.isDirectory();
            if (e.isSymbolicLink() && !isDir) {
                try {
                    isDir = fs.statSync(path.win32.join(p, e.name)).isDirectory();
                } catch {
                    isDir = false;
                }
            }
            return { name: e.name, isDir, isLink: e.isSymbolicLink() };
        }),
    /** python `os.path.islink(join(top, name))`。 */
    isLink: (p: string): boolean => {
        try {
            return fs.lstatSync(p).isSymbolicLink();
        } catch {
            return false;
        }
    },
    /** python `hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]`。 */
    contentHash: (content: string): string =>
        createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex").slice(0, 16),
};

// ── 常量 ─────────────────────────────────────────────────────────────────────

const _IGNORED_DIRS: ReadonlySet<string> = new Set([
    ".git",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    "venv",
    ".venv",
    "temp",
    "temp.__todelete",
    ".gemini",
]);

// ── EcosystemSkill ───────────────────────────────────────────────────────────

export class EcosystemSkill {
    name: string;
    description: string;
    path: string;
    /** "claude-code" | "ovolve-native" | "open-agent" */
    protocol: string;
    frontmatter: JsonDict;
    instructions: string;
    tools: string[];
    requires: string[];
    content_hash: string;

    constructor(
        name: string,
        description: string,
        path_: string,
        protocol: string,
        frontmatter?: JsonDict,
        instructions?: string,
        tools?: string[],
        requires?: string[],
        contentHash?: string
    ) {
        this.name = name;
        this.description = description;
        this.path = path_;
        this.protocol = protocol;
        this.frontmatter = frontmatter ?? {};
        this.instructions = instructions ?? "";
        this.tools = tools ?? [];
        this.requires = requires ?? [];
        this.content_hash = contentHash ?? "";
    }
}

// ── frontmatter ──────────────────────────────────────────────────────────────

/** Parse YAML-ish frontmatter delimited by ---. */
export function _parse_frontmatter(content: string): [JsonDict, string] {
    if (!content.startsWith("---")) return [{}, content];

    const parts = pySplitMax(content, "---", 2);
    if (parts.length < 3) return [{}, content];

    const rawFm = parts[1] as string;
    const body = pyStrip(parts[2] as string);

    const fm: JsonDict = {};
    const lines = pySplitlines(rawFm);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] as string;
        const stripped = pyStrip(line);
        if (stripped === "" || stripped.startsWith("#")) {
            i += 1;
            continue;
        }

        if (stripped.includes(":")) {
            const at = stripped.indexOf(":");
            const key = pyStrip(stripped.slice(0, at));
            const val = pyStrip(stripped.slice(at + 1));

            // Multiline list handling:
            // key:
            //   - item1
            //   - item2
            if (val === "") {
                const seq: string[] = [];
                let j = i + 1;
                while (j < lines.length) {
                    const nxt = pyStrip(lines[j] as string);
                    if (nxt === "" || nxt.startsWith("#")) {
                        j += 1;
                        continue;
                    }
                    if (nxt.startsWith("- ")) {
                        seq.push(pyStripQuotes(pyStrip(nxt.slice(2))));
                        j += 1;
                        continue;
                    }
                    break;
                }
                if (seq.length > 0) {
                    fm[key] = seq;
                    i = j;
                    continue;
                }
            }

            // Inline list handling [a, b]
            if (val.startsWith("[") && val.endsWith("]")) {
                const inner = pyChopBrackets(val);
                const items: string[] = [];
                for (const p of inner.split(",")) {
                    if (pyStrip(p) === "") continue; // filter BEFORE the chop
                    items.push(pyStripQuotes(pyStrip(p)));
                }
                fm[key] = items;
            } else {
                fm[key] = pyStripQuotes(val);
            }
        }
        i += 1;
    }

    return [fm, body];
}

// ── os.walk (topdown, followlinks=False, errors swallowed) ────────────────────

export type WalkEntry = [string, string[], string[]];

/**
 * python `os.walk(root)` — same entry order, same topdown pre-order, same
 * in-place `dirnames` pruning contract, same symlink refusal.
 */
export function* osWalk(top: string): Generator<WalkEntry, void, unknown> {
    const stack: string[] = [top];
    while (stack.length > 0) {
        const root = stack.pop() as string;
        let entries: Dirent3[];
        try {
            entries = ECO_SEAMS.readDir(root);
        } catch {
            continue; // os.walk swallows the OSError (onerror is None)
        }
        const dirs: string[] = [];
        const nondirs: string[] = [];
        for (const e of entries) {
            if (e.isDir) dirs.push(e.name);
            else nondirs.push(e.name);
        }

        yield [root, dirs, nondirs];

        // `for dirname in reversed(dirs): stack.append(...)` + `stack.pop()`
        // is left-to-right depth-first over the (possibly pruned) list.
        for (let k = dirs.length - 1; k >= 0; k--) {
            const dirname = dirs[k] as string;
            const newPath = path.win32.join(root, dirname);
            if (!ECO_SEAMS.isLink(newPath)) stack.push(newPath);
        }
    }
}

// ── scanner ──────────────────────────────────────────────────────────────────

/** Discovers and adapts skills across multi-vendor ecosystem formats. */
export class EcosystemSkillScanner {
    search_roots: string[];

    constructor(search_roots?: readonly (string | null)[] | null) {
        this.search_roots = pyTruth(search_roots ?? null)
            ? (search_roots as readonly string[]).map((r) => pyPathStr(r))
            : [];
    }

    /** Scan configured search roots or workspace_root for SKILL.md files. */
    scan(workspace_root?: string | null): EcosystemSkill[] {
        const skills: EcosystemSkill[] = [];
        const visitedPaths = new Set<string>();

        const rootsToCheck: string[] = [];
        if (this.search_roots.length > 0) rootsToCheck.push(...this.search_roots);

        if (pyTruth(workspace_root)) {
            const w = ECO_SEAMS.resolvePath(pyPathStr(String(workspace_root)));
            rootsToCheck.push(
                path.win32.join(w, ".claude", "skills"),
                path.win32.join(w, ".agents", "skills"),
                path.win32.join(w, ".skills"),
                w
            );
        }

        for (const root of rootsToCheck) {
            if (!ECO_SEAMS.pathExists(root)) continue;

            for (const [dirpath, dirnames, filenames] of osWalk(root)) {
                // Prune ignored directories in-place (`dirnames[:] = …`)
                const kept = dirnames.filter((d) => !_IGNORED_DIRS.has(d));
                dirnames.length = 0;
                dirnames.push(...kept);

                for (const fname of filenames) {
                    const lower = fname.toLowerCase();
                    if (lower !== "skill.md" && lower !== "skill.yaml") continue;
                    const skillFile = pyPathStr(path.win32.join(dirpath, fname));
                    const resolvedFile = ECO_SEAMS.resolvePath(skillFile);
                    const key = normcaseKey(resolvedFile);
                    if (visitedPaths.has(key)) continue;
                    visitedPaths.add(key);

                    const parsed = this._parse_skill_file(resolvedFile);
                    if (parsed !== null) skills.push(parsed);
                }
            }
        }

        return skills;
    }

    /** Parse a single SKILL.md file into an EcosystemSkill. */
    _parse_skill_file(skill_file: string): EcosystemSkill | null {
        let content: string;
        try {
            content = ECO_SEAMS.readFileUtf8(skill_file);
        } catch {
            return null;
        }

        const contentHash = ECO_SEAMS.contentHash(content);
        const [fm, body] = _parse_frontmatter(content);

        const parentName = pyPathName(pyPathParent(skill_file));
        const name = pyStr(
            pyOr(
                pyOr(dictGet(fm, "name"), parentName === "" ? null : parentName),
                "unnamed-skill"
            )
        );
        const description = pyStr(pyOr(dictGet(fm, "description"), ""));

        // Protocol detection
        const parts = pyPathParts(skill_file);
        let protocol: string;
        if (parts.includes(".claude") || dictHasKey(fm, "tools")) {
            protocol = "claude-code";
        } else if (
            dictHasKey(fm, "user-invocable") ||
            dictHasKey(fm, "requires-bins") ||
            parts.includes(".agents")
        ) {
            protocol = "ovolve-native";
        } else {
            protocol = "open-agent";
        }

        // Extract tools
        const toolsRaw = pyOr(
            pyOr(pyOr(dictGet(fm, "tools"), dictGet(fm, "allowed-tools")), dictGet(fm, "allowed_tools")),
            []
        );
        let tools: string[];
        if (typeof toolsRaw === "string") {
            tools = [];
            for (const p of toolsRaw.split(",")) {
                const s = pyStrip(p);
                if (s !== "") tools.push(s);
            }
        } else if (Array.isArray(toolsRaw)) {
            tools = [];
            for (const t of toolsRaw) {
                const s = pyStrip(pyStr(t));
                if (s !== "") tools.push(s);
            }
        } else {
            tools = [];
        }

        // Extract requirements
        const reqsRaw = pyOr(dictGet(fm, "requires"), []);
        let requires: string[];
        if (Array.isArray(reqsRaw)) {
            requires = [];
            for (const r of reqsRaw) {
                const s = pyStrip(pyStr(r));
                if (s !== "") requires.push(s);
            }
        } else {
            requires = [];
        }

        return new EcosystemSkill(
            name,
            description,
            skill_file,
            protocol,
            fm,
            body,
            tools,
            requires,
            contentHash
        );
    }

    /** Adapt an EcosystemSkill into a native Ovolve SkillEntry. */
    adapt_to_skill_entry(
        skill: EcosystemSkill,
        trust: TrustLevel = TrustLevel.VERIFIED
    ): SkillEntry {
        const skillDir = pyPathParent(skill.path);
        const entry = new SkillEntry(
            skill.name,
            skillDir,
            skill.description,
            skill.content_hash,
            trust
        );
        entry.body = skill.instructions;
        entry.frontmatter = { ...skill.frontmatter };
        entry.declared_version = pyStr(pyOr(dictGet(skill.frontmatter, "version"), ""));
        entry.allowed_tools = [...skill.tools];
        entry.requires = [...skill.requires];
        entry.source = `ecosystem:${skill.protocol}`;

        // Populate boolean visibility flags
        entry.user_invocable = normalize_bool(
            pyOr(dictGet(skill.frontmatter, "user-invocable"), dictGet(skill.frontmatter, "user_invocable")),
            true
        );
        entry.disable_model_invocation = normalize_bool(
            pyOr(
                dictGet(skill.frontmatter, "disable-model-invocation"),
                dictGet(skill.frontmatter, "disable_model_invocation")
            ),
            false
        );

        return entry;
    }
}
