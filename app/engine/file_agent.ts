/**
 * file_agent.ts — File sub-agent (Specialist Architecture).
 *
 * Ported from `app/backend/file_agent.py` (972 lines, SPLIT -> TS half).
 * Domain: file read/write, search, edit, Git operations.
 * Does NOT do: system settings, browser ops, app management.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/file_agent.py -> app/engine/file_agent.ts
 *   §2  present-but-null: every `args.get(k, d)` / `ctx.get(k)` is dictGet —
 *       a key present with a null value yields null, not the default; all
 *       `if x:` gates go through pyTruth.
 *   §2  comparison crash semantics: `offset > 0` / `limit > 0` in _read_text
 *       raise the Python TypeError shape on null via pyGt (JS would answer
 *       false); git's int(raw) emulation via pyIntCoerce.
 *   §2  str.strip()/rstrip() over the Python whitespace set (incl. \x1c-\x1f,
 *       \x85, \xa0) — pyStrip / pyRstrip.
 *   §2  len() is code-point length — Array.from, never UTF-16 .length
 *       (Wrote N chars, bytes_changed, count("")).
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   telemetry: `get_telemetry`/`SpanName` start_span/set_error/end_span are
 *       deleted exactly per the HANDOFF §8.3 disposition for the DELETE-flagged
 *       telemetry.py unit ("依赖方直接删调用") — same precedent as app_agent.ts;
 *       purely observational, no behaviour rides on the span.
 *   host seams (unlanded Python deps; unbound → the module raises
 *       `No module named 'X'` exactly where Python's ImportError would, so the
 *       surrounding try/except shape keeps working):
 *         bind_aider_parser — aider_parser.py's matcher (Rust-landed unit; the
 *             pure-Python fallback has no TS twin yet). Unbound error is NOT
 *             caught in _replace_file_content_impl (source has no try there) →
 *             escapes to dispatch as "Execution error: No module named ...".
 *         bind_http_get — `import requests` inside _read_text_impl's URL
 *             branch; the seam is SYNC because the impl is sync (the host wires
 *             a blocking child fetch; a JS-native async fetch would flip the
 *             tool's execution contract from thread to loop).
 *         bind_shadow_precheck — shadow_workspace.preview_write is sync in the
 *             source but async in the landed TS port; _precheck_write needs a
 *             sync answer. Unbound → ModuleNotFoundError → the source's own
 *             `except Exception` fail-opens, so the tool still writes.
 *   static-vs-lazy imports: work_copy / patch_engine / git_trust / executors'
 *       tracked_run are landed TS; their lazy `from X import Y` lines became
 *       static imports. The fail-open try/except around each CALL is kept
 *       verbatim (call-time exceptions still swallow); the import-failure half
 *       of those excepts is dead in this build, which is the same state the
 *       running Python app is in.
 *   _git_cmd: Python calls executors.tracked_run (blocking, stop-reachable,
 *       tree-kill on timeout). executors.ts trackedRun is Promise-based and a
 *       sync impl cannot await it — so _git_cmd uses execFileSync (same route
 *       the landed git_trust.ts _git already uses: cwd normalisation copied
 *       from its tracked_run-precedent), timeout 30s, kill = direct child.
 *       DIVERGENCE(port): a wedged git grandchild survives the timeout kill,
 *       and the child is not registered with the stop button. Git is a
 *       leaf-command here (git itself is the process that wedges), so the
 *       tree-kill gap is bounded; equivalence argument mirrors git_trust.ts.
 *   read-text encoding ladder (utf-8 → utf-8-sig → gbk → latin-1): Node
 *     TextDecoder fatal:true reproduces UnicodeDecodeError for utf-8 /
 *     utf-8-sig (BOM strip) / gbk (WHATWG gbk ≈ Python cp936 for test inputs);
 *     latin-1 is decoded byte-by-byte (ISO-8859-1, NOT whatwg latin1 =
 *     cp1252). WRITE-side encoding (atomic_write/append `encoding` arg) uses
 *     iconv-lite, which carries Python's cp936/GB18030/big5/cp1252 tables;
 *     unknown names raise the str(LookupError) shape "unknown encoding: X".
 *   non-utf-8 files read through the ladder then re-measured via
 *     Buffer.byteLength(content, utf8) in _replace_file_content: both sides
 *     re-encode a decoded string the same way, but Python's decode is cp936
 *     while Node's is WHATWG-gbk — only the ladder-fallback + replace combo is
 *     affected; parity pins utf-8 files for that metric.
 *   os error messages: Node fs errors are rendered `[Errno N] msg: 'path'`
 *       (POSIX str(OSError) shape) via pyOsError. DIVERGENCE(port): on Windows
 *       Python renders "[WinError N] <system message>: 'path'" instead, so the
 *       OS-dependent detail segment differs; the structural parts (message
 *       prefix, quoted path) match and parity canonicalizes the
 *       `[WinError N]/[Errno N]/NODECODE:` segment (path kept, verbatim on
 *       both sides).
 *   shutil.copy2 copies data + mtime-ish metadata; fs.copyFileSync copies
 *     data + mode only. DIVERGENCE(port): destination mtime is "now" instead
 *     of the source mtime. No tool output or message reads the copied mtime.
 *   Windows fidelity fixes surfaced BY the 124-case parity run (each pinned
 *   there, not guesses):
 *     - text-mode newline translation: Python's fdopen("w")/open("a") writes
 *       with newline=None translate every "\n" to os.linesep, so on Windows
 *       the files these tools write are CRLF on disk; Node writes bytes
 *       verbatim. pyWriteNewlines reproduces it (platform-gated exactly like
 *       CPython's os.linesep), and pyReadNewlines mirrors the universal-
 *       newlines read of the whole-file open(path,"r").read() that feeds
 *       edit/patch/replace matching (a1, d2, d3, ed3).
 *     - Windows os.rename raises FileExistsError ([WinError 183], whose str()
 *       names BOTH endpoints) when dst exists; Node's renameSync silently
 *       overwrites — pre-checked under win32 with the `[Errno N] ... 'src' ->
 *       'dst'` shape (f5, f8).
 *     - shutil.copy2 from a DIRECTORY source raises naming only the source;
 *       Node's copyfile error leaks both paths — pyCopy2SrcCheck pre-empts
 *       with the Python-shaped error (f12).
 *     - TextDecoder's default eats a leading BOM; Python's utf-8/gbk ladder
 *       KEEPS it as U+FEFF (only utf-8-sig strips) — decodeBytes now passes
 *       ignoreBOM:true (c5).
 *     - CPython fakes Windows mode bits (dirs 0o777, files 0o666) from the
 *       directory attribute; Node reports 0o666 for dirs too —
 *       _get_file_info_impl fakes the same values on win32 (g2).
 *     - pyRound's old 4-digit window treated near-ties as exact ties
 *       (round(0.98765,4) is 0.9877 in Python: the stored double sits ABOVE
 *       the tie); it now resolves the double's true decimal expansion via
 *       toFixed(digits+20) with banker rounding only on true ties (rf1/4/13).
 *     - the str-check for atomic_write's data moved INSIDE its try, and None
 *       is named "None" (not "NoneType") in the TypeError text, so a null
 *       content fails as Python's "Write failed: Atomic write to ... failed:
 *       write() argument must be str, not None" instead of escaping the tool
 *       as a bare child error (i8).
 *     - dependency fix: git_trust.ts carried CommonJS require("node:fs"/
 *       "node:path") calls that throw "require is not defined" under the
 *       app's ESM runtime — converted to static namespace imports (the
 *       hc2/hc3 commit-draft route exercised them).
 *   FileAgent.handle is async in both worlds (dispatch is awaited); the
 *     `context or {}` + setdefault pair mutates the caller's dict in TS too.
 *
 * Kept source quirks (bug-for-bug, pinned by parity):
 *   - `_precheck_write(path, ...)` receives the REDIRECTED path (ws arg from
 *     ctx), while the model-facing message uses `shown` — verbatim.
 *   - edit_file with old_string="" succeeds vacuously: count("") is
 *     code-points+1, the replace inserts between every char, and the success
 *     text still says "Replaced 1 occurrence(s)" (replace_all) or
 *     "Replaced 2 occurrence(s)" — actually the f-string prints `count`, the
 *     count of pre-images, NOT inserted positions; both sides print the same.
 *   - _git_push_impl's try block also wraps the cmd-list construction, not
 *     just validation.
 *   - get_file_agent(workspace) ignores workspace once the singleton exists.
 *   - _diff_files_impl returns "" (not "Files are identical.") only when the
 *     diff list is non-empty... (no quirk — verified identical logic).
 *
 * §6  status trailer at the bottom.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { Result, tryResult } from "./result.js";
import { getEventBus } from "./event_bus.js";
import { ToolDef, get_tool_registry, shorten_path } from "./tools.js";
import { write_lock } from "./path_lock.js";
import { for_ctx, redirect_write, record_delete } from "./work_copy.js";
import { apply_unified_patch } from "./patch_engine.js";
import { get_commit_message_generator } from "./git_trust.js";
import { SequenceMatcher } from "./difflib.js";
import type { JsonDict } from "./danger_classifier.js";
import iconv from "iconv-lite";

// ── house Python-semantics helpers (per-file, project convention) ──────────

function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return String(v);
}

/** str(exc): our constructed Errors carry the Python-shaped message. */
function pyStrExc(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isPyDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (!isPyDict(obj)) {
    throw new Error(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? (obj as Record<string, unknown>)[key] : dflt;
}

function dictSet(obj: unknown, key: string, value: unknown): void {
  if (!isPyDict(obj)) {
    throw new Error(`'${pyTypeName(obj)}' object is not a dict`);
  }
  (obj as Record<string, unknown>)[key] = value;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** `str(a or b)` — falsy or-gate then str(). */
function pyStrOr(v: unknown, dflt: unknown): string {
  return pyStr(pyTruth(v) ? v : dflt);
}

/** python time.time() — float seconds. */
function timeNow(): number {
  return Date.now() / 1000;
}

/** `a > b` where b may be a non-number — raises the Python TypeError shape. */
function pyGt(a: number, b: unknown): boolean {
  if (typeof b !== "number") {
    throw new Error(
      `'>' not supported between instances of 'int' and '${pyTypeName(b)}'`);
  }
  return a > b;
}

/** Python's str.strip()/rstrip() whitespace set (wider than JS \s). */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
function pyStrip(s: string): string {
  const cls = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "gu");
  return s.replace(cls, "");
}
function pyRstrip(s: string): string {
  return s.replace(new RegExp(`[${PY_WS}]+$`, "u"), "");
}

/** str.replace(old, new, count) — code-point-exact for the empty needle. */
function pyCount(hay: string, needle: string): number {
  if (needle === "") return Array.from(hay).length + 1;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}
function pyReplaceAll(hay: string, needle: string, repl: string): string {
  if (needle === "") return Array.from(hay).map((c) => repl + c).join("") + repl;
  return hay.split(needle).join(repl);
}
function pyReplace1(hay: string, needle: string, repl: string): string {
  if (needle === "") {
    const chars = Array.from(hay);
    if (chars.length === 0) return repl;
    return repl + chars[0] + hay.slice(1);
  }
  const i = hay.indexOf(needle);
  if (i === -1) return hay;
  return hay.slice(0, i) + repl + hay.slice(i + needle.length);
}

/** repr(str) for the f-string `{v!r}` inside git arg errors. */
function pyReprStr(s: string): string {
  let q = "'";
  if (s.includes("'") && !s.includes('"')) q = '"';
  const esc = s
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return q + (q === "'" ? esc.replaceAll("'", "\\'") : esc.replaceAll('"', '\\"')) + q;
}

function pyRepr(v: unknown): string {
  if (typeof v === "string") return pyReprStr(v);
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  return pyStr(v);
}

/** Python int(raw) on unknown input: ints pass, floats truncate, strings
 *  parse strict (no JS-style prefix parse), everything else TypeErrors. */
function pyIntCoerce(raw: unknown): number {
  if (typeof raw === "boolean") return raw ? 1 : 0; // int(True) == 1
  if (typeof raw === "number") {
    if (Number.isNaN(raw) || !Number.isFinite(raw)) {
      throw new Error(`ValueError: cannot convert float NaN to integer`);
    }
    return Math.trunc(raw);
  }
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") {
    const m = /^[ \t\n\r\f\v]*([+-]?)(0|[1-9]\d*)[ \t\n\r\f\v]*$/.exec(raw);
    if (!m) throw new Error(`ValueError: invalid literal for int() with base 10: ${pyReprStr(raw)}`);
    return Number((m[1] ?? "") + (m[2] ?? ""));
  }
  throw new Error(`TypeError: int() argument must be a string, a bytes-like object or a number, not '${pyTypeName(raw)}'`);
}

/** Python float() on unknown input (str/num, inf/nan tokens allowed). */
function pyFloatCoerce(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "string") {
    const v = pyStrip(raw);
    if (/^[+-]?(inf|infinity)$/i.test(v)) return v.startsWith("-") ? -Infinity : Infinity;
    if (/^nan$/i.test(v)) return NaN;
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
      throw new Error(`could not convert string to float: ${pyReprStr(raw)}`);
    }
    return Number(v);
  }
  throw new Error(`float() argument must be a string or a number, not '${pyTypeName(raw)}'`);
}

/** round(x, 4) — Python's round(): correct decimal rounding of the binary
 *  double (0.98765 → 0.9877, since the stored value is above the tie), with
 *  banker's rounding only on a true tie. toFixed(digits+20) exposes enough of
 *  the exact expansion to resolve near-ties the old 4-digit window hid. */
function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(digits + 20);
  const keep = s.slice(0, s.length - 20);
  const rest = s.slice(s.length - 20).replace(/0+$/, "");
  let v = Number(keep);
  let dir: "up" | "tie" | "down";
  if (rest === "") dir = "tie";
  else if (rest.charAt(0) < "5") dir = "down";
  else if (rest.charAt(0) > "5" || rest.length > 1) dir = "up";
  else dir = "tie";
  const odd = Math.round(Math.abs(v) * Math.pow(10, digits)) % 2 === 1;
  if (dir === "up" || (dir === "tie" && odd)) v += Math.pow(10, -digits);
  return Number((neg ? -v : v).toFixed(digits));
}

/** f"{n:6d}" / f"{n:4d}" — right-aligned base-10 field. */
function pyPad(n: number, width: number): string {
  return String(n).padStart(width, " ");
}

/** universal-newlines readlines(): terminators normalised to \n and kept. */
function pyReadlines(text: string): string[] {
  const norm = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] === "\n") {
      out.push(norm.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < norm.length) out.push(norm.slice(start));
  return out;
}

/** str.splitlines() (no terminator kept). */
function pySplitlines(s: string): string[] {
  const parts = s.split(/[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const PY_ERRNO_MSG: Record<number, string> = {
  1: "Operation not permitted", 2: "No such file or directory",
  13: "Permission denied", 17: "File exists", 18: "Cross-device link",
  20: "Not a directory", 21: "Is a directory", 39: "Directory not empty",
};

/** Render a Node fs error like str(Python OSError): `[Errno 2] No such file
 *  or directory: 'C:\\x'`. Unknown codes fall back to the Node message. */
function pyOsError(e: unknown): string {
  const err = e as { code?: unknown; errno?: unknown; message?: unknown; path?: unknown };
  const errno = typeof err?.errno === "number" ? err.errno : -1;
  const msg = PY_ERRNO_MSG[errno];
  const p = typeof err?.path === "string" ? err.path : "";
  if (msg && errno > 0) {
    return `[Errno ${errno}] ${msg}${p ? `: ${pyReprStr(p)}` : ""}`;
  }
  return pyStrExc(e);
}

/** Errors thrown from fs callbacks re-appear through tryResult as str(exc);
 *  wrap OSError-like ones so the message is the Python shape. */
function fsTry<T>(fn: () => T): () => T {
  return () => {
    try {
      return fn();
    } catch (e) {
      const err = e as { code?: unknown };
      if (typeof err?.code === "string" && err.code.startsWith("E")) {
        throw new Error(pyOsError(e));
      }
      throw e;
    }
  };
}

// ── host seams (unlanded Python deps) ───────────────────────────────────────

export interface AiderOutcome {
  ok: boolean;
  content: string;
  replaced_count: number;
  error: string;
  diagnostics: string;
  backend: string;
  similarity: number;
}

export interface AiderModuleLike {
  DEFAULT_SIMILARITY_THRESHOLD: number;
  apply_aider_blocks(original: string, block: string, threshold: number): AiderOutcome;
  replace_once(
    original: string, search: string, replace: string,
    threshold: number, allow_multiple: boolean,
  ): AiderOutcome;
}

let _aider: AiderModuleLike | null = null;
export function bind_aider_parser(m: AiderModuleLike | null): void {
  _aider = m;
}
function aider_parser(): AiderModuleLike {
  if (_aider === null) {
    throw new Error(
      "ModuleNotFoundError: No module named 'aider_parser' (host seam not bound)");
  }
  return _aider;
}

export interface ShadowPreviewLike {
  ok: boolean;
  format_error(): string;
}

let _shadowPrecheck: ((target: string, content: unknown, ws: string) => ShadowPreviewLike) | null = null;
export function bind_shadow_precheck(fn: typeof _shadowPrecheck): void {
  _shadowPrecheck = fn;
}
function shadow_preview_write(
  target: string, content: unknown, ws: string,
): ShadowPreviewLike {
  if (_shadowPrecheck === null) {
    throw new Error(
      "ModuleNotFoundError: No module named 'shadow_workspace' (host seam not bound)");
  }
  return _shadowPrecheck(target, content, ws);
}

export interface ResponseLike {
  text: string;
  raise_for_status(): void;
}
export type HttpGetFn = (url: string, opts: { headers: JsonDict; timeout: number }) => ResponseLike;

let _httpGet: HttpGetFn | null = null;
export function bind_http_get(fn: HttpGetFn | null): void {
  _httpGet = fn;
}
function requests_get(url: string, opts: { headers: JsonDict; timeout: number }): ResponseLike {
  if (_httpGet === null) {
    throw new Error("ModuleNotFoundError: No module named 'requests' (host seam not bound)");
  }
  return _httpGet(url, opts);
}

// ── module helpers ───────────────────────────────────────────────────────────

/** Python text-mode write translation (newline=None): every "\n" becomes
 *  os.linesep — on Windows that is "\r\n", and a "\r\n" already in the string
 *  becomes "\r\r\n" (the \r passes through as data). Node writes bytes
 *  verbatim, so without this the tools would emit LF where the Python app
 *  emits CRLF — visible to the user in file size, revision tokens and diff
 *  output. Gated on the platform exactly like CPython's os.linesep is. */
function pyWriteNewlines(s: string): string {
  return process.platform === "win32" ? s.replaceAll("\n", "\r\n") : s;
}

/** Python text-mode read with newline=None (universal newlines): "\r\n" and
 *  lone "\r" both arrive as "\n". Applied to the whole-file reads that feed
 *  edit/patch/replace matching, mirroring open(path, "r").read(). */
function pyReadNewlines(s: string): string {
  return s.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function atomic_write(p: string, data: unknown, encoding = "utf-8"): Result<string> {
  const directory = path.dirname(p) || ".";
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (e) {
    return Result.failure(`Cannot create directory ${directory}: ${pyOsError(e)}`);
  }
  // tempfile.mkstemp(dir=..., suffix=".tmp") — O_CREAT|O_EXCL uniqueness.
  let tmp = "";
  let fd = -1;
  for (;;) {
    tmp = path.join(
      directory,
      "tmp" + Math.random().toString(36).slice(2, 10).padEnd(8, "x") + ".tmp",
    );
    try {
      fd = fs.openSync(tmp, "wx");
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") {
        return Result.failure(`Atomic write to ${p} failed: ${pyOsError(e)}`);
      }
    }
  }
  let failed: unknown = null;
  try {
    const buf = encodeText(pyWriteNewlines(asWriteStr(data)), encoding);
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } catch (e) {
    failed = e;
  }
  // Python's `with os.fdopen(fd, ...)` closes the handle on the error path
  // BEFORE the cleanup unlink — leaving it open makes the unlink EBUSY on
  // Windows.
  try {
    fs.closeSync(fd);
  } catch {
    // already closed / close raced — the source's with-exit ignores it too
  }
  if (failed === null) {
    try {
      fs.renameSync(tmp, p);
    } catch (e) {
      failed = e;
    }
  }
  if (failed !== null) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // fail-open: 可选增强，失败不影响主流程
    }
    return Result.failure(`Atomic write to ${p} failed: ${errLine(failed)}`);
  }
  return Result.success(p);
}

/** BaseException str() with the type prefix for uncaught Python errors —
 *  OSError-shaped errors already render as `[Errno ...]`. */
function errLine(e: unknown): string {
  const err = e as { code?: unknown; errno?: unknown };
  if (typeof err?.code === "string" && err.code.startsWith("E")) return pyOsError(e);
  if (e instanceof Error && e.name !== "Error") return `${e.name}: ${e.message}`;
  return pyStrExc(e);
}

function encodeText(data: string, encoding: string): Buffer {
  const enc = encoding.toLowerCase().replace(/[_\s]/g, "-");
  if (enc === "utf-8" || enc === "utf8" || enc === "u8" || enc === "utf") {
    return Buffer.from(data, "utf8");
  }
  if (enc === "utf-8-sig") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(data, "utf8")]);
  if (enc === "latin-1" || enc === "iso-8859-1" || enc === "iso8859-1" || enc === "latin1" || enc === "cp819" || enc === "latin") {
    const b = Buffer.alloc(Array.from(data).length);
    let i = 0;
    for (const ch of data) b[i++] = ch.codePointAt(0)! & 0xff;
    return b;
  }
  // iconv-lite carries the same tables Python's codecs use for the GB family
  // and the Windows codepages (gbk == cp936, big5, cp1252, shift_jis, ...).
  const ICONV_ALIAS: Record<string, string> = {
    "gbk": "gbk", "gb2312": "gb2312", "gb18030": "gb18030", "cp936": "gbk",
    "ms936": "gbk", "ms-cp936": "gbk", "windows-936": "gbk", "936": "gbk",
  };
  const target = ICONV_ALIAS[enc] ?? enc;
  if (iconv.encodingExists(target)) return iconv.encode(data, target);
  // str(LookupError) shape: no class prefix (Python: open(..., encoding=X)).
  throw new Error(`unknown encoding: ${encoding}`);
}

function decodeBytes(buf: Buffer, encoding: string): string {
  const enc = encoding.toLowerCase().replace(/_/g, "-");
  if (enc === "latin-1" || enc === "iso-8859-1") {
    let s = "";
    for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]!);
    return s;
  }
  let text: string;
  // ignoreBOM: Python's utf-8/gbk codecs KEEP the BOM as U+FEFF (only
  // utf-8-sig strips it); TextDecoder's default silently eats it, which made
  // the utf-8 rung of the ladder return a different string than Python's.
  if (enc === "gbk" || enc === "gb2312" || enc === "gb18030") {
    text = new TextDecoder("gbk", { fatal: true, ignoreBOM: true }).decode(buf);
  } else {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  }
  if (enc === "utf-8-sig" && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export function file_revision(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${Math.trunc(st.mtimeMs / 1000)}:${st.size}`;
  } catch {
    return "";
  }
}

// ── UA3 overlay routing helpers ──────────────────────────────────────────────

export function _redirect(p: string, ctx: JsonDict, seed = true): string {
  try {
    return redirect_write(p, ctx, seed);
  } catch {
    return p;
  }
}

export function _record_delete(p: string, ctx: JsonDict): boolean {
  try {
    return record_delete(p, ctx);
  } catch {
    return false;
  }
}

export function _isolated(ctx: JsonDict): boolean {
  try {
    return for_ctx(ctx) !== null;
  } catch {
    return false;
  }
}

export function _read_through(p: string, ctx: JsonDict): string {
  try {
    const wc = for_ctx(ctx);
    if (wc === null) return p;
    const dest = wc.overlay_path(p);
    if (dest && fs.existsSync(dest) && fs.statSync(dest).isFile()) return dest;
    return p;
  } catch {
    return p;
  }
}

// ── the agent ────────────────────────────────────────────────────────────────

export class FileAgent {
  static DOMAIN = "file";
  workspace: string;
  private bus: ReturnType<typeof getEventBus>;
  private tools: ReturnType<typeof get_tool_registry>;

  constructor(workspace: string | null = null) {
    this.workspace = pyTruth(workspace) ? (workspace as string) : process.cwd();
    this.bus = getEventBus();
    void this.bus; // Python stores it; no tool reads it.
    this.tools = get_tool_registry();
    this._register_tools();
  }

  private _register_tools(): void {
    for (const td of this._build_tool_defs()) {
      this.tools.register(td);
    }
  }

  private _build_tool_defs(): ToolDef[] {
    const DOMAIN = FileAgent.DOMAIN;
    return [
      new ToolDef("read_text", "Read a text file with auto encoding detection.",
        { "type": "object", "properties": {
          "path": { "type": "string", "description": "Path to the file. Use `find_files`/`search_code` first if you are not sure it exists or where it is." },
          "offset": { "type": "integer", "default": 0, "description": "Start at this LINE number (0 = beginning), not a byte offset." },
          "limit": { "type": "integer", "default": 0, "description": "How many LINES to read. 0 = the whole file." } },
          "required": ["path"] },
        _read_text_impl,
        { domain: DOMAIN, risk_level: "low",
          when_to_use: "You know the path and need the actual contents. Always read " +
                       "before editing — `edit_file` needs the exact existing text.",
          when_not_to_use: "You do not know the path yet — use `find_files` or " +
                           "`search_code` first. For binary files this returns " +
                           "garbage; use `get_file_info` to check size/type instead." }),
      new ToolDef("write_file", "Write content to a file, REPLACING it entirely. Creates parent dirs.",
        { "type": "object", "properties": {
          "path": { "type": "string", "description": "Path to write. Parent directories are created. If the file exists its entire contents are replaced (unless `append`)." },
          "content": { "type": "string", "description": "The file's ENTIRE new content. Anything not included here is lost." },
          "append": { "type": "boolean", "default": false, "description": "True appends instead of replacing. Use this for logs, never for source files." },
          "encoding": { "type": "string", "default": "utf-8" } },
          "required": ["path", "content"] },
        _write_file_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "Creating a NEW file, or deliberately rewriting a whole small " +
                       "file whose full contents you just read.",
          when_not_to_use: "Changing part of an existing file — use `edit_file`. " +
                           "Writing a file you have not read overwrites everything " +
                           "in it, which is the single most common way to destroy " +
                           "the user's work." }),
      new ToolDef("edit_file", "Replace an exact string in a file, leaving the rest untouched.",
        { "type": "object", "properties": {
          "path": { "type": "string", "description": "File to edit. Read it first — an unread file's exact text is a guess." },
          "old_string": { "type": "string", "description": "Exact text to replace, whitespace and indentation included. Must match once and only once unless replace_all is set." },
          "new_string": { "type": "string", "description": "Replacement text. Pass an empty string to delete old_string." },
          "replace_all": { "type": "boolean", "description": "Replace every occurrence instead of failing on an ambiguous match.", "default": false },
          "expected_revision": { "type": "string", "description": "Revision from read_text to detect concurrent edits." } },
          "required": ["path", "old_string", "new_string"] },
        _edit_file_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "Small, surgical edits when you know the exact text to replace.",
          when_not_to_use: "Multi-hunk or large changes — prefer `apply_patch` with a unified diff." }),
      new ToolDef("apply_patch", "Apply a unified diff patch to a file (multi-hunk, FastApply-style).",
        { "type": "object", "properties": {
          "path": { "type": "string", "description": "Target file path." },
          "patch": { "type": "string", "description": "Unified diff hunks (@@ -l,s +l,s @@ lines)." },
          "expected_revision": { "type": "string", "description": "Optional revision token from read_text." } },
          "required": ["path", "patch"] },
        _apply_patch_impl,
        { domain: DOMAIN, risk_level: "medium",
          when_to_use: "Changing multiple regions or when exact old_string match is fragile.",
          when_not_to_use: "Creating a new file — use `write_file`. Single tiny replace — `edit_file` is fine." }),
      new ToolDef("replace_file_content",
        "Replace content in a file with indentation-tolerant matching. Accepts a search/replace pair, " +
        "a SEARCH/REPLACE block, or a unified diff.",
        { "type": "object", "properties": {
          "path": { "type": "string", "description": "Target file path." },
          "search": { "type": "string", "description": "Exact text to find. Leading indentation may drift from the file — it is realigned automatically. Pair with `replace`." },
          "replace": { "type": "string", "description": "Replacement text. Re-indented to the file's actual indentation when `search` matched at a different column." },
          "aider_block": { "type": "string", "description": "SEARCH/REPLACE block: `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`. Several blocks are applied in order, all-or-nothing." },
          "diff": { "type": "string", "description": "Unified diff hunks (@@ -l,s +l,s @@) applied via the patch engine instead of a search/replace." },
          "allow_multiple": { "type": "boolean", "default": false, "description": "Replace every exact occurrence instead of refusing an ambiguous match." },
          "similarity_threshold": { "type": "number", "default": 0.8, "description": "Minimum Levenshtein similarity (0-1) for a tolerant match. Below this the edit is refused rather than guessed." },
          "expected_revision": { "type": "string", "description": "Revision token from read_text to detect concurrent edits." } },
          "required": ["path"] },
        _replace_file_content_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "An `edit_file` call failed because the text you copied differs from the file only " +
                       "in indentation or a typo, or you are applying a model-authored SEARCH/REPLACE block " +
                       "verbatim. Also the one tool that takes all three edit formats.",
          when_not_to_use: "You have the exact string — `edit_file` is stricter and a strict failure is " +
                           "useful information. Tolerant matching can land on a similar-looking region, so " +
                           "never use it to 'force through' an edit you have not verified by reading the file." }),

      new ToolDef("delete_file", "Delete a file or empty directory.",
        { "type": "object", "properties": { "path": { "type": "string", "description": "File or empty directory to remove. Non-empty directories are refused; there is no recursive delete here on purpose." } }, "required": ["path"] },
        _delete_file_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "Removing a file you created this session, or one the user " +
                       "explicitly asked to delete.",
          when_not_to_use: "You just want to empty its contents (use `write_file` " +
                           "with empty content) or replace it (use `edit_file`). " +
                           "Deletes are hard to undo — never delete to 'clean up' " +
                           "something the user did not mention." }),
      new ToolDef("move_file", "Move/rename a file.",
        { "type": "object", "properties": {
          "src": { "type": "string", "description": "Existing path. Must be a file, not a directory." },
          "dst": { "type": "string", "description": "Destination path. If something already lives here it is overwritten, so check with `get_file_info` when you are not sure." } },
          "required": ["src", "dst"] },
        _move_file_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "Renaming a file, or relocating one the user asked you to move. " +
                       "Prefer this over write-then-delete: a move keeps git's rename " +
                       "detection intact, so the diff stays reviewable.",
          when_not_to_use: "Reorganising a layout nobody asked you to reorganise. A " +
                           "move breaks every import, config path and link that " +
                           "pointed at the old name, and those breaks surface far " +
                           "from here. Also not for directories." }),
      new ToolDef("copy_file", "Copy a file.",
        { "type": "object", "properties": {
          "src": { "type": "string", "description": "Existing file to copy from." },
          "dst": { "type": "string", "description": "Destination path. Overwritten if it exists." } },
          "required": ["src", "dst"] },
        _copy_file_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "Duplicating a file the user wants duplicated — seeding a config " +
                       "from an example, forking a template.",
          when_not_to_use: "Making a `.bak` before editing. `edit_file` is already " +
                           "surgical and the user has version control; backup copies " +
                           "just leave litter they have to clean up and can end up " +
                           "committed. Also not for directories." }),
      new ToolDef("get_file_info", "Get file metadata: size, mtime, permissions.",
        { "type": "object", "properties": {
          "path": { "type": "string", "description": "File or directory to inspect." } },
          "required": ["path"] },
        _get_file_info_impl,
        { domain: DOMAIN, risk_level: "low",
          when_to_use: "Deciding whether reading something is even feasible — a 40MB " +
                       "log will blow the context window, and this tells you before " +
                       "`read_text` does. Also the cheap way to confirm a path exists.",
          when_not_to_use: "You want the contents. This returns no content at all, so " +
                           "calling it first just to be safe costs a step for nothing." }),
      new ToolDef("diff_files", "Diff two files line by line.",
        { "type": "object", "properties": {
          "file_a": { "type": "string", "description": "Left side — conventionally the original / expected one." },
          "file_b": { "type": "string", "description": "Right side — conventionally the changed / actual one." } },
          "required": ["file_a", "file_b"] },
        _diff_files_impl,
        { domain: DOMAIN, risk_level: "low",
          when_to_use: "Comparing two files that both exist on disk: an actual output " +
                       "against an expected fixture, a config against its `.example`.",
          when_not_to_use: "Looking at what YOU changed — that is `git_diff`, and it " +
                           "compares against the committed state instead of needing " +
                           "you to have kept a copy. Also useless on binaries." }),
      new ToolDef("git_status", "Get git status (short form).",
        { "type": "object", "properties": {}, "required": [] },
        _git_status_impl,
        { domain: DOMAIN, risk_level: "low",
          when_to_use: "Before staging or committing, always. It is the only way to see " +
                       "what the user already had in flight before you touched " +
                       "anything — that work must not end up in your commit.",
          when_not_to_use: "To find out what a change actually says; that is `git_diff`. " +
                           "Status only names files." }),
      new ToolDef("git_add", "Stage files for commit.",
        { "type": "object", "properties": { "paths": { "type": "array", "items": { "type": "string" }, "description": "Specific paths to stage. Prefer naming the files you changed over '.' — '.' also stages unrelated work the user had in progress." } }, "required": ["paths"] },
        _git_add_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "Right before `git_commit`, to choose exactly what goes in.",
          when_not_to_use: "As a reflex after editing. Staging with no commit " +
                           "coming just makes the user's `git status` confusing." }),
      new ToolDef("git_commit", "Create a git commit. Omit message to auto-generate a Conventional Commits message from the staged diff.",
        { "type": "object", "properties": {
          "message": { "type": "string", "description": "Commit message. Omit it and one is drafted from the staged diff." } },
          "required": [] },
        _git_commit_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "The user asked to commit. Stage first with `git_add` — this " +
                       "commits what is STAGED, not what is merely changed.",
          when_not_to_use: "You finished some edits and it feels tidy to commit. " +
                           "Committing unasked mixes your work into the user's " +
                           "history. Also never commit without looking at " +
                           "`git_status` / `git_diff` first — unrelated changes and " +
                           "secrets ride along silently." }),
      new ToolDef("git_commit_message", "Draft a Conventional Commits message for the staged diff without committing.",
        { "type": "object", "properties": {}, "required": [] },
        _git_commit_message_impl,
        { domain: DOMAIN, risk_level: "low",
          when_to_use: "The user wants to review the wording before you commit, or they " +
                       "want to commit by hand and just need the message.",
          when_not_to_use: "You are about to commit anyway — `git_commit` with no " +
                           "`message` drafts the same text and commits in one step, so " +
                           "calling both wastes a turn. Reads the STAGED diff, so it " +
                           "returns nothing useful before `git_add`." }),
      new ToolDef("git_push", "Push to remote.",
        { "type": "object", "properties": { "remote": { "type": "string", "default": "origin" }, "branch": { "type": "string", "description": "Omit to push the current branch." } }, "required": [] },
        _git_push_impl,
        { domain: DOMAIN, risk_level: "high", requires_subprocess: true,
          when_to_use: "The user explicitly asked to push. This is the only " +
                       "acceptable trigger.",
          when_not_to_use: "Anything else. A push is visible to other people and " +
                           "cannot be quietly undone — it is not part of " +
                           "'finishing the task'. Never push to main/master unless " +
                           "the user said so." }),
      new ToolDef("git_pull", "Pull from remote.",
        { "type": "object", "properties": {
          "remote": { "type": "string", "default": "origin" },
          "branch": { "type": "string", "description": "Omit to pull the tracked branch." } },
          "required": [] },
        _git_pull_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "The user asked to pull, or a push was rejected as non-fast-forward " +
                       "and they asked you to sort it out.",
          when_not_to_use: "Unprompted, and never with a dirty tree. A pull rewrites the " +
                           "files under the user's editor and can stop halfway in a " +
                           "conflicted state that you cannot resolve for them. Check " +
                           "`git_status` first." }),
      new ToolDef("git_diff", "Show git diff (staged or unstaged).",
        { "type": "object", "properties": {
          "staged": { "type": "boolean", "default": false, "description": "False shows what is changed but NOT staged; True shows what a commit would actually contain. These are different sets and mixing them up is how unrelated work gets committed." } },
          "required": [] },
        _git_diff_impl,
        { domain: DOMAIN, risk_level: "low",
          when_to_use: "Reading the actual content of changes — yours or the user's — " +
                       "before committing, or to understand what a turn has done so far.",
          when_not_to_use: "As a substitute for reading the file you are about to edit. A " +
                           "diff shows what moved, not what the surrounding code is." }),
      new ToolDef("git_log", "Show recent git commits.",
        { "type": "object", "properties": {
          "count": { "type": "integer", "default": 10, "description": "How many commits back. Keep it small — a long log is mostly context you will not use." } },
          "required": [] },
        _git_log_impl,
        { domain: DOMAIN, risk_level: "low",
          when_to_use: "Learning the project's commit-message conventions before writing " +
                       "one, or finding when something changed.",
          when_not_to_use: "Establishing what the code currently does — read the code. " +
                           "Commit messages describe intent, and they age badly." }),
      new ToolDef("git_branch", "List/create/switch branches.",
        { "type": "object", "properties": {
          "action": { "type": "string", "enum": ["list", "create", "switch"], "description": "`list` is read-only and always safe. `create` and `switch` both change what the user's editor is looking at." },
          "name": { "type": "string", "description": "Branch name. Required for create/switch, ignored for list." } },
          "required": ["action"] },
        _git_branch_impl,
        { domain: DOMAIN, risk_level: "medium", requires_subprocess: true,
          when_to_use: "`list` to find out where you are before doing anything git-shaped " +
                       "— pushing from the wrong branch is the expensive mistake here. " +
                       "`create`/`switch` only when the user asked.",
          when_not_to_use: "Switching on your own initiative. Uncommitted work either " +
                           "follows you onto the new branch or blocks the switch, and " +
                           "both outcomes surprise the user. This cannot delete a " +
                           "branch, by design." }),
    ];
  }

  async handle(
    tool_name: string, args: JsonDict, context: JsonDict | null = null,
  ): Promise<Result> {
    const ctx: JsonDict = context ?? {};
    // dict.setdefault: only a MISSING key is filled — a present null stays.
    if (!("workspace_root" in ctx)) {
      dictSet(ctx, "workspace_root", this.workspace);
    }
    return await this.tools.dispatch(tool_name, args, ctx);
  }
}

// ── tool impls (all sync, like the source) ──────────────────────────────────

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isdir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `>` with a possibly-null left operand — Python's TypeError shape.
 *  bool is an int in Python (True > 0 succeeds), so it converts, not throws. */
function pyGtNum(aRaw: unknown, b: number): boolean {
  const a = typeof aRaw === "boolean" ? (aRaw ? 1 : 0) : aRaw;
  if (typeof a !== "number") {
    throw new Error(
      `'>' not supported between instances of '${pyTypeName(aRaw)}' and 'int'`);
  }
  return a > b;
}

/** splitlines(keepends=True) over the full Python boundary set. */
function pySplitlinesKeep(text: string): string[] {
  const bounds = "\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029";
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === undefined || !bounds.includes(c)) continue;
    if (c === "\r" && text[i + 1] === "\n") i++;
    out.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function pyLenStr(v: unknown, what = "object"): number {
  if (typeof v !== "string") {
    throw new Error(`object of type '${pyTypeName(v)}' has no len()`);
  }
  return Array.from(v).length;
}

function asWriteStr(v: unknown): string {
  if (typeof v !== "string") {
    // Python's TypeError names None as "None", not the pyTypeName "NoneType".
    throw new Error(`write() argument must be str, not ${v === null ? "None" : pyTypeName(v)}`);
  }
  return v;
}

function collapseWs(s: string): string {
  return s.replace(new RegExp(`[${PY_WS}]+`, "gu"), "");
}

function wsOf(ctx: JsonDict): string | null {
  return dictGet(ctx, "workspace_root") as string | null;
}

/** The offset/limit/numbering tail shared by the URL and file branches. */
export function _serveNumbered(
  allLines: string[], offset: unknown, limit: unknown,
): { content: string; total: number; shownCount: number } {
  // Python: `float` slice indices raise TypeError even when integral; JS's
  // slice() silently truncates. bool IS an int (True[1:]). Latent divergence
  // noted: a JSON number carries no int/float brand, so `2.0` cannot be
  // rejected here — only fractional values can.
  const intSlice = (v: unknown, what: string): number => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number" && !Number.isInteger(v)) {
      throw new Error("slice indices must be integers or None or have an __index__ method");
    }
    void what;
    return v as number;
  };
  const total = allLines.length;
  let lines = allLines;
  if (pyGtNum(offset, 0)) lines = lines.slice(intSlice(offset, "offset"));
  if (pyGtNum(limit, 0)) lines = lines.slice(0, intSlice(limit, "limit"));
  const off = typeof offset === "boolean" ? (offset ? 1 : 0)
    : (typeof offset === "number" ? offset : 0);
  const numbered = lines.map((line, i) => `${pyPad(i + off + 1, 6)}|${pyRstrip(line)}`);
  let content = numbered.join("\n");
  if (total > numbered.length) {
    content += `\n... (${total - numbered.length} more lines)`;
  }
  return { content, total, shownCount: numbered.length };
}

export function _read_text_impl(args: JsonDict, ctx: JsonDict): Result {
  const pathArg = dictGet(args, "path", "");
  const shown = pathArg;
  const offset = dictGet(args, "offset", 0);
  const limit = dictGet(args, "limit", 0);

  // Auto-route HTTP/HTTPS URLs to web fetcher
  const cleanPath = pyStrip(pyStr(pyTruth(pathArg) ? pathArg : ""));
  if (cleanPath.startsWith("http://") || cleanPath.startsWith("https://")) {
    try {
      const headers: JsonDict = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      };
      const resp = requests_get(cleanPath, { headers, timeout: 20 });
      resp.raise_for_status();
      let text = resp.text;
      const lower = text.toLowerCase();
      if (lower.includes("<html") || lower.includes("<body")) {
        text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
        text = text.replace(/<[^>]+>/g, " ");
        text = text.replace(/[ \t]+/g, " ");
        text = pyStrip(text.replace(/\n\s*\n+/g, "\n\n"));
      }
      const served = _serveNumbered(pySplitlinesKeep(text), offset, limit);
      return Result.success(served.content, { url: cleanPath, total_lines: served.total });
    } catch (e) {
      return Result.failure(`Failed to fetch URL ${pyStr(shown)}: ${pyStrExc(e)}`);
    }
  }

  const p = _read_through(pyStr(pathArg), ctx);
  if (!isFile(p)) return Result.failure(`File not found: ${pyStr(shown)}`);
  let buf: Buffer | null = null;
  try {
    buf = fs.readFileSync(p);
  } catch {
    buf = null; // Python: OSError falls through all four encodings → else.
  }
  let lines: string[] | null = null;
  for (const enc of ["utf-8", "utf-8-sig", "gbk", "latin-1"]) {
    try {
      if (buf === null) throw new Error("read failed");
      lines = pyReadlines(decodeBytes(buf, enc));
      break;
    } catch {
      continue;
    }
  }
  if (lines === null) {
    // for/else: unreachable while latin-1 is in the ladder (it never raises)
    // — same as the source; kept for the unreadable-file route.
    return Result.failure(`Failed to read file (encoding): ${pyStr(shown)}`);
  }
  const served = _serveNumbered(lines, offset, limit);
  return Result.success(served.content, {
    path: shorten_path(pyStr(shown), wsOf(ctx)), total_lines: served.total,
  });
}

export function _write_file_impl(args: JsonDict, ctx: JsonDict): Result {
  let p = pyStr(dictGet(args, "path", ""));
  const content = dictGet(args, "content", "");
  const append = dictGet(args, "append", false);
  const encoding = dictGet(args, "encoding", "utf-8");
  // UA3: an isolated sub-agent writes into its own overlay instead of the real
  // file. `shown` stays the real path so the message the model reads is about
  // the file it asked for, not a temp directory it knows nothing about.
  const shown = p;
  // Appending needs the existing bytes seeded in; a full overwrite does not.
  p = _redirect(p, ctx, pyTruth(append));
  const unlock = write_lock(p);
  try {
    const parent = path.dirname(p);
    if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    let r: Result<unknown>;
    if (pyTruth(append)) {
      // Append cannot go through atomic_write (that replaces the whole file).
      // Explicit flush + fsync instead.
      r = tryResult(fsTry(() => {
        const fd = fs.openSync(p, "a");
        try {
          const n = fs.writeSync(fd, encodeText(pyWriteNewlines(asWriteStr(content)), pyStr(encoding)));
          fs.fsyncSync(fd);
          return n;
        } finally {
          fs.closeSync(fd);
        }
      }));
    } else {
      // Full overwrite goes through atomic_write (the source's long comment on
      // why "w" mode truncation was replaced is preserved there).
      const pre = _precheck_write(p, content, ctx, shown);
      if (pre !== null) return pre;
      // data stays `unknown`: the str check happens INSIDE atomic_write's try so
      // a non-str content fails as "Write failed: Atomic write to ... failed:
      // write() argument must be str, not None" — Python's fdopen(...).write()
      // raises inside the same scope.
      r = atomic_write(p, content, pyStr(encoding));
    }
    if (!r.ok) return Result.failure(`Write failed: ${r.error}`);
  } finally {
    unlock();
  }
  return Result.success(
    `Wrote ${pyLenStr(content)} chars to ${shorten_path(shown, wsOf(ctx))}`);
}

export function _edit_file_impl(args: JsonDict, ctx: JsonDict): Result {
  let p = pyStr(dictGet(args, "path", ""));
  const oldStr = pyStr(dictGet(args, "old_string", ""));
  const newStr = pyStr(dictGet(args, "new_string", ""));
  const replaceAll = dictGet(args, "replace_all", false);
  const shown = p;
  // Seeded, because the whole operation is read→replace→write: without the
  // pre-image in the overlay the read would fail on the first edit of a file.
  p = _redirect(p, ctx, true);
  // The whole read→replace→write must be atomic against other writers.
  const unlock = write_lock(p);
  let count = 0;
  let newContent = "";
  try {
    if (!isFile(p)) return Result.failure(`File not found: ${shown}`);
    const expected = pyStr(dictGet(args, "expected_revision", ""));
    if (expected) {
      const currentRev = file_revision(p);
      if (currentRev && currentRev !== expected) {
        return Result.failure(
          `File changed since you last read it (expected revision ${expected}, ` +
          `current ${currentRev}). Please re-read the file and retry.`);
      }
    }
    const r = tryResult(fsTry(() => decodeBytes(fs.readFileSync(p), "utf-8")));
    if (!r.ok) return Result.failure(`Read failed: ${r.error}`);
    const content = pyReadNewlines(r.value!);
    count = pyCount(content, oldStr);
    if (count === 0) {
      // Smart auto-diagnosis: find near matches or line numbers to guide 1-step self-healing
      const lines = pySplitlines(content);
      const oldLines = pySplitlines(oldStr);
      let hint = "";
      if (oldLines.length) {
        const firstTarget = pyStrip(oldLines[0]!);
        const normTarget = collapseWs(firstTarget);
        const candidates: Array<[number, string]> = [];
        for (let idx = 0; idx < lines.length; idx++) {
          const normLine = collapseWs(lines[idx]!);
          let isMatch = pyTruth(normTarget) &&
            (normLine.includes(normTarget) || normTarget.includes(normLine));
          if (!isMatch && Array.from(normTarget).length >= 4 &&
              Array.from(normLine).length >= 4) {
            const ratio = new SequenceMatcher(
              null, Array.from(normTarget), Array.from(normLine), true).ratio();
            if (ratio >= 0.6) isMatch = true;
          }
          if (isMatch) {
            const startCtx = Math.max(0, idx - 2);
            const endCtx = Math.min(lines.length, idx + oldLines.length + 2);
            const prev: string[] = [];
            for (let i = startCtx; i < endCtx; i++) {
              prev.push(`${pyPad(i + 1, 4)} | ${lines[i]}`);
            }
            candidates.push([idx + 1, prev.join("\n")]);
            if (candidates.length >= 2) break;
          }
        }
        if (candidates.length) {
          const hintsStr = candidates
            .map(([ln, prv]) => `Near Line ${ln}:\n${prv}`).join("\n---\n");
          hint = `\n\n💡 Auto-Diagnosis: \`old_string\` was not found exactly ` +
            `(check whitespace/indentation). Found candidate line(s) in ${shown}:\n` +
            `${hintsStr}\nPlease adjust \`old_string\` to match the exact lines above.`;
        }
      }
      return Result.failure(`old_string not found in ${shown}.${hint}`);
    }
    if (count > 1 && !pyTruth(replaceAll)) {
      return Result.failure(
        `old_string appears ${count} times in ${shown}; ` +
        "provide more surrounding context or set replace_all=True");
    }
    newContent = pyTruth(replaceAll)
      ? pyReplaceAll(content, oldStr, newStr)
      : pyReplace1(content, oldStr, newStr);
    const pre = _precheck_write(p, newContent, ctx, shown);
    if (pre !== null) return pre;
    const r2 = atomic_write(p, newContent);
    if (!r2.ok) return Result.failure(`Write failed: ${r2.error}`);
  } finally {
    unlock();
  }
  return Result.success(
    `Replaced ${count} occurrence(s) in ${shorten_path(shown, wsOf(ctx))}`);
}

export function _precheck_write(
  logicalPath: string, content: unknown, ctx: JsonDict, shown = "",
): Result | null {
  /** Shadow-workspace precheck on the logical target path; fail-open. */
  try {
    const wsRoot = dictGet(ctx, "workspace_root");
    const ws2 = dictGet(ctx, "workspace");
    const ws = pyStr(pyTruth(wsRoot) ? wsRoot : (pyTruth(ws2) ? ws2 : ""));
    const target = pyTruth(shown) ? shown : logicalPath;
    const preview = shadow_preview_write(target, content, ws);
    if (!preview.ok) return Result.failure(preview.format_error());
  } catch {
    // fail-open
  }
  return null;
}

export function _apply_patch_impl(args: JsonDict, ctx: JsonDict): Result {
  let p = pyStr(dictGet(args, "path", ""));
  const patch = pyStr(dictGet(args, "patch", ""));
  const shown = p;
  p = _redirect(p, ctx, true);
  const unlock = write_lock(p);
  let hunks = 0;
  try {
    if (!isFile(p)) return Result.failure(`File not found: ${shown}`);
    const expected = pyStr(dictGet(args, "expected_revision", ""));
    if (expected) {
      const currentRev = file_revision(p);
      if (currentRev && currentRev !== expected) {
        return Result.failure(
          `File changed since you last read it (expected ${expected}, ` +
          `current ${currentRev}). Re-read and retry.`);
      }
    }
    const r = tryResult(fsTry(() => decodeBytes(fs.readFileSync(p), "utf-8")));
    if (!r.ok) return Result.failure(`Read failed: ${r.error}`);
    const result = apply_unified_patch(pyReadNewlines(r.value!), patch);
    if (!result.ok) return Result.failure(`Patch failed: ${result.error}`);
    const pre = _precheck_write(p, result.content, ctx, shown);
    if (pre !== null) return pre;
    const r2 = atomic_write(p, result.content);
    if (!r2.ok) return Result.failure(`Write failed: ${r2.error}`);
    hunks = result.hunks_applied;
  } finally {
    unlock();
  }
  return Result.success(
    `Applied ${hunks} hunk(s) to ${shorten_path(shown, wsOf(ctx))}`);
}

export function _replace_file_content_impl(args: JsonDict, ctx: JsonDict): Result {
  /**
   * Unified replace: search/replace OR Aider block OR unified diff.
   * Test-file refusal is deliberately NOT done here; that is path_guard's job.
   */
  const aid = aider_parser();
  const p = pyStr(dictGet(args, "path", ""));
  const search = dictGet(args, "search");
  const replace = dictGet(args, "replace");
  const aiderBlock = pyStr(dictGet(args, "aider_block", ""));
  const diff = pyStr(dictGet(args, "diff", ""));
  const allowMultiple = pyTruth(dictGet(args, "allow_multiple", false));
  const threshold = pyFloatCoerce(dictGet(args, "similarity_threshold", aid.DEFAULT_SIMILARITY_THRESHOLD));

  if (!p) return Result.failure("path is required");

  const modes: string[] = [];
  if (search !== null && search !== undefined) modes.push("search");
  if (pyTruth(aiderBlock)) modes.push("aider");
  if (pyTruth(diff)) modes.push("diff");
  if (!modes.length) {
    return Result.failure(
      "Provide one edit: `search`(+`replace`), `aider_block`, or `diff`.");
  }
  if (modes.length > 1) {
    return Result.failure(
      `Ambiguous request: ${modes.join(", ")} given together. Send exactly one edit format.`);
  }

  const shown = p;
  const target = _redirect(p, ctx, true);
  const unlock = write_lock(target);
  let newContent = "";
  let original = "";
  let backend: unknown = "";
  let similarity = 0;
  let summary = "";
  try {
    if (!isFile(target)) return Result.failure(`File not found: ${shown}`);
    const expected = pyStr(dictGet(args, "expected_revision", ""));
    if (expected) {
      const currentRev = file_revision(target);
      if (currentRev && currentRev !== expected) {
        return Result.failure(
          `File changed since you last read it (expected revision ${expected}, ` +
          `current ${currentRev}). Please re-read the file and retry.`);
      }
    }
    const r = tryResult(fsTry(() => decodeBytes(fs.readFileSync(target), "utf-8")));
    if (!r.ok) return Result.failure(`Read failed: ${r.error}`);
    original = pyReadNewlines(r.value!);

    // ── Unified diff path (patch_engine) ──────────────────────────────
    if (pyTruth(diff)) {
      const patchResult = apply_unified_patch(original, diff);
      if (!patchResult.ok) {
        return Result.failure(`Diff apply failed: ${patchResult.error}`);
      }
      newContent = patchResult.content;
      backend = "patch_engine";
      similarity = 1.0;
      summary = `applied ${patchResult.hunks_applied} hunk(s) via unified diff`;
    } else {
      // ── search/replace and Aider block share the matcher ────────────
      let outcome: AiderOutcome;
      if (aiderBlock) {
        outcome = aid.apply_aider_blocks(original, aiderBlock, threshold);
        summary = `applied ${outcome.replaced_count} Aider block(s)`;
      } else {
        outcome = aid.replace_once(
          original, search as string, pyStrOr(replace, ""), threshold, allowMultiple);
        summary = `replaced ${outcome.replaced_count} occurrence(s)`;
      }
      if (!outcome.ok) {
        let msg = outcome.error;
        if (pyTruth(outcome.diagnostics)) {
          msg = `${msg}\n\n💡 ${outcome.diagnostics}`;
        }
        return Result.failure(`${msg} (in ${shown})`);
      }
      newContent = outcome.content;
      backend = outcome.backend;
      similarity = outcome.similarity;
    }

    if (newContent === original) {
      return Result.failure(
        `No change: the replacement is identical to the existing content in ${shown}.`);
    }

    const pre = _precheck_write(target, newContent, ctx, shown);
    if (pre !== null) return pre;
    const r2 = atomic_write(target, newContent);
    if (!r2.ok) return Result.failure(`Write failed: ${r2.error}`);
  } finally {
    unlock();
  }

  const bytesChanged = Math.abs(
    Buffer.byteLength(newContent, "utf8") - Buffer.byteLength(original, "utf8"));
  return Result.success(
    `replace_file_content: ${summary} in ${shorten_path(shown, wsOf(ctx))} ` +
    `(backend=${pyStr(backend)}, similarity=${pyRound(similarity, 2).toFixed(2)})`,
    { backend, similarity: pyRound(similarity, 4), bytes_changed: bytesChanged },
  );
}

export function _delete_file_impl(args: JsonDict, ctx: JsonDict): Result {
  const p = pyStr(dictGet(args, "path", ""));
  // UA3: inside an overlay a delete is a tombstone, not an unlink. The
  // existence check comes FIRST: a tombstone recorded for a path that was
  // never there would be replayed at merge time as a delete nobody asked for.
  if (_isolated(ctx)) {
    if (!fs.existsSync(_read_through(p, ctx)) && !fs.existsSync(p)) {
      return Result.failure(`Path not found: ${p}`);
    }
    if (_record_delete(p, ctx)) {
      return Result.success(`Deleted: ${shorten_path(p, wsOf(ctx))}`);
    }
  }
  const unlock = write_lock(p);
  try {
    if (!fs.existsSync(p)) return Result.failure(`Path not found: ${p}`);
    const r = tryResult(fsTry(() => {
      if (isdir(p)) fs.rmdirSync(p); else fs.unlinkSync(p);
    }));
    if (!r.ok) return Result.failure(`Delete failed: ${r.error}`);
  } finally {
    unlock();
  }
  return Result.success(`Deleted: ${shorten_path(p, wsOf(ctx))}`);
}

export function _move_file_impl(args: JsonDict, ctx: JsonDict): Result {
  const src = pyStr(dictGet(args, "src", ""));
  const dst = pyStr(dictGet(args, "dst", ""));
  // UA3: inside an overlay a move is "write the destination, tombstone the
  // source". Order matters: the source is resolved and copied BEFORE the
  // tombstone, because tombstoning drops the overlay's copy of it.
  if (_isolated(ctx)) {
    const readSrc = _read_through(src, ctx);
    if (!fs.existsSync(readSrc)) return Result.failure(`Source not found: ${src}`);
    const out = _redirect(dst, ctx, false);
    // DIVERGENCE(port): copyFileSync does not carry the source mtime over
    // (copy2 does); no tool output reads it.
    const r = tryResult(fsTry(() => { pyCopy2SrcCheck(readSrc); fs.copyFileSync(readSrc, out); }));
    if (!r.ok) return Result.failure(`Move failed: ${r.error}`);
    _record_delete(src, ctx);
    return Result.success(
      `Moved: ${shorten_path(src, wsOf(ctx))} -> ${shorten_path(dst, wsOf(ctx))}`);
  }
  // Lock both endpoints; write_lock sorts the keys, so no deadlock.
  const unlock = write_lock(src, dst);
  try {
    if (!fs.existsSync(src)) return Result.failure(`Source not found: ${src}`);
    const parent = path.dirname(dst);
    if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    const r = tryResult(fsTry(() => {
      if (process.platform === "win32" && fs.existsSync(dst)) {
        // Windows os.rename (msvcrt._wrename) raises FileExistsError
        // ([WinError 183], str() names BOTH endpoints) when dst exists —
        // pinned by parity f8; Node's renameSync would silently overwrite.
        // POSIX os.rename overwrite semantics are kept by the platform gate.
        throw new Error(`[Errno 17] File exists: ${pyReprStr(src)} -> ${pyReprStr(dst)}`);
      }
      fs.renameSync(src, dst);
    }));
    if (!r.ok) return Result.failure(`Move failed: ${r.error}`);
  } finally {
    unlock();
  }
  return Result.success(
    `Moved: ${shorten_path(src, wsOf(ctx))} -> ${shorten_path(dst, wsOf(ctx))}`);
}

/** shutil.copy2 with a directory source: Python's read of the dir raises
 *  IsADirectoryError/PermissionError naming only the SOURCE; Node's
 *  copyFileSync message would leak both paths ("copyfile 'src' -> 'dst'").
 *  Pre-empt with the Python-shaped error. */
function pyCopy2SrcCheck(src: string): void {
  if (fs.statSync(src).isDirectory()) {
    throw new Error(`[Errno 21] Is a directory: ${pyReprStr(src)}`);
  }
}

export function _copy_file_impl(args: JsonDict, ctx: JsonDict): Result {
  const src = pyStr(dictGet(args, "src", ""));
  const dst = pyStr(dictGet(args, "dst", ""));
  // Only the destination is a write; the source is read through the overlay
  // so a file this sub-agent already edited copies its OWN version.
  const readSrc = _read_through(src, ctx);
  const out = _redirect(dst, ctx, false);
  const unlock = write_lock(readSrc, out);
  try {
    if (!fs.existsSync(readSrc)) return Result.failure(`Source not found: ${src}`);
    const parent = path.dirname(out);
    if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    // DIVERGENCE(port): mtime not preserved (see _move_file_impl).
    const r = tryResult(fsTry(() => { pyCopy2SrcCheck(readSrc); fs.copyFileSync(readSrc, out); }));
    if (!r.ok) return Result.failure(`Copy failed: ${r.error}`);
  } finally {
    unlock();
  }
  return Result.success(
    `Copied: ${shorten_path(src, wsOf(ctx))} -> ${shorten_path(dst, wsOf(ctx))}`);
}

/** time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)) — local wall clock. */
function pyStrftime(ms: number): string {
  const d = new Date(ms);
  const z = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${z(d.getFullYear(), 4)}-${z(d.getMonth() + 1)}-${z(d.getDate())} ` +
    `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

export function _get_file_info_impl(args: JsonDict, ctx: JsonDict): Result {
  const p = pyStr(dictGet(args, "path", ""));
  if (!fs.existsSync(p)) return Result.failure(`Path not found: ${p}`);
  const stat = fs.statSync(p);
  // Windows has no mode bits: CPython fakes them (0o777 for directories,
  // 0o666 for files) from FILE_ATTRIBUTE_DIRECTORY; Node exposes 0o666 for
  // both. Report the Python faked value so the model sees the same numbers.
  const mode = process.platform === "win32" && stat.isDirectory()
    ? 0o777 : stat.mode & 0o777;
  return Result.success({
    path: shorten_path(p, wsOf(ctx)),
    size: stat.size, modified: pyStrftime(stat.mtimeMs),
    is_dir: isdir(p), is_file: isFile(p),
    permissions: "0o" + mode.toString(8),
  });
}

// ── difflib.unified_diff (stdlib source copied shape-for-shape) ─────────────

function _format_range_unified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (!length) beginning -= 1; // empty ranges begin at line just before the range
  return `${beginning},${length}`;
}

function _grouped_opcodes(
  sm: SequenceMatcher, n: number,
): Array<Array<[string, number, number, number, number]>> {
  const codes = sm.getOpcodes().map(
    (c) => [c[0], c[1], c[2], c[3], c[4]] as [string, number, number, number, number]);
  if (!codes.length) codes.push(["equal", 0, 1, 0, 1]);
  if (codes[0]![0] === "equal") {
    const [tag, i1, i2, j1, j2] = codes[0]!;
    codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
  }
  {
    const last = codes[codes.length - 1]!;
    if (last[0] === "equal") {
      const [tag, i1, i2, j1, j2] = last;
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
  }
  const nn = n + n;
  const out: Array<Array<[string, number, number, number, number]>> = [];
  let group: Array<[string, number, number, number, number]> = [];
  for (const [tag, i1r, i2, j1r, j2] of codes) {
    let i1 = i1r;
    let j1 = j1r;
    if (tag === "equal" && i2 - i1 > nn) {
      group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      out.push(group);
      group = [];
      i1 = Math.max(i1, i2 - n);
      j1 = Math.max(j1, j2 - n);
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0]![0] === "equal")) out.push(group);
  return out;
}

function _unified_diff(
  a: string[], b: string[], fromfile = "", tofile = "", n = 3, lineterm = "\n",
): string[] {
  const out: string[] = [];
  let started = false;
  for (const group of _grouped_opcodes(new SequenceMatcher(null, a, b, true), n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}${lineterm}`);
      out.push(`+++ ${tofile}${lineterm}`);
    }
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const file1Range = _format_range_unified(first[1], last[2]);
    const file2Range = _format_range_unified(first[3], last[4]);
    out.push(`@@ -${file1Range} +${file2Range} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(" " + line);
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        for (const line of a.slice(i1, i2)) out.push("-" + line);
      }
      if (tag === "replace" || tag === "insert") {
        for (const line of b.slice(j1, j2)) out.push("+" + line);
      }
    }
  }
  return out;
}

export function _diff_files_impl(args: JsonDict, ctx: JsonDict): Result {
  const fa = pyStr(dictGet(args, "file_a", ""));
  const fb = pyStr(dictGet(args, "file_b", ""));
  if (!isFile(fa)) return Result.failure(`File A not found: ${fa}`);
  if (!isFile(fb)) return Result.failure(`File B not found: ${fb}`);
  // errors="ignore" in the source: non-fatal decode (replacement chars
  // instead of dropped bytes — documented divergence).
  const ra = tryResult(fsTry(() =>
    pyReadlines(new TextDecoder("utf-8").decode(fs.readFileSync(fa)))));
  const rb = tryResult(fsTry(() =>
    pyReadlines(new TextDecoder("utf-8").decode(fs.readFileSync(fb)))));
  if (!ra.ok || !rb.ok) return Result.failure("Failed to read files for diff");
  const d = _unified_diff(
    ra.value!, rb.value!,
    shorten_path(fa, wsOf(ctx)), shorten_path(fb, wsOf(ctx)));
  return Result.success(d.length ? d.join("") : "Files are identical.");
}

// ── git ──────────────────────────────────────────────────────────────────────

/**
 * Python's executors.tracked_run with the same cwd normalisation executors.ts
 * already documents (file → dirname, missing → inherited); see the header for
 * the kill/stop divergences.
 */
export function _git_cmd(argsList: string[], cwdRaw: unknown): Result<string> {
  const full = ["-c", "core.quotePath=false", ...argsList];
  let validCwd: string | undefined;
  if (cwdRaw !== null && cwdRaw !== undefined && typeof cwdRaw === "string") {
    const clean = cwdRaw.replace(/^[\s"']+|[\s"']+$/g, "");
    if (clean) {
      try {
        validCwd = fs.statSync(clean).isDirectory() ? clean : path.dirname(clean);
      } catch {
        validCwd = undefined;
      }
    }
  }
  try {
    const stdout = execFileSync("git", full, {
      cwd: validCwd, encoding: "utf-8", timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return Result.success(pyStrip(stdout));
  } catch (e) {
    const err = e as { status?: unknown; stderr?: unknown };
    if (typeof err.status === "number") {
      const stderr = typeof err.stderr === "string" ? err.stderr : "";
      return Result.failure(`git exited ${err.status}: ${pyStrip(stderr)}`);
    }
    return Result.failure(`git error: ${errLine(e)}`);
  }
}

class _GitArgError extends Error {
  /** A git tool argument that git would parse as an option, not a value. */
}

export function _git_value(v: unknown, label: string): string {
  if (typeof v !== "string" || !pyStrip(v)) {
    throw new _GitArgError(`${label}不能为空`);
  }
  const s = pyStrip(v);
  if (s.startsWith("-")) {
    throw new _GitArgError(
      `${label}不能以 - 开头（git 会当作选项解析）: ${pyReprStr(s)}`);
  }
  if (s.includes("\n") || s.includes("\r") || s.includes("\x00")) {
    throw new _GitArgError(`${label}含非法控制字符`);
  }
  return s;
}

export function _git_paths(raw: unknown, label = "路径"): string[] {
  /** Validate a pathspec list. Callers must still pass it after a `--`. */
  if (!Array.isArray(raw)) throw new _GitArgError(`${label}必须是数组`);
  if (!raw.length) throw new _GitArgError(`${label}不能为空`);
  return raw.map((p) => _git_value(p, label));
}

export function _git_count(raw: unknown, dflt = 10, cap = 500): number {
  /** Coerce a commit count to a bounded int (it is interpolated into `-N`). */
  let n: number;
  try {
    n = pyIntCoerce(raw === undefined ? dflt : raw);
  } catch {
    throw new _GitArgError(`count 必须是整数: ${pyRepr(raw)}`);
  }
  return Math.max(1, Math.min(cap, n));
}

export function _git_status_impl(args: JsonDict, ctx: JsonDict): Result {
  return _git_cmd(["status", "--short"], dictGet(ctx, "workspace_root"));
}

export function _git_add_impl(args: JsonDict, ctx: JsonDict): Result {
  let paths: string[];
  try {
    paths = _git_paths(dictGet(args, "paths", []));
  } catch (e) {
    if (e instanceof _GitArgError) return Result.failure(e.message);
    throw e;
  }
  // `--` terminates option parsing: everything after it is a pathspec.
  return _git_cmd(["add", "--", ...paths], dictGet(ctx, "workspace_root"));
}

export function _git_commit_impl(args: JsonDict, ctx: JsonDict): Result {
  /**
   * Commit staged changes. When no message is supplied, generate a
   * Conventional Commits message from the staged diff (fallback = heuristic
   * when no LLM is wired up).
   */
  let message = pyStrip(pyStrOr(dictGet(args, "message"), ""));
  if (!message) {
    const drafted = _draft_commit_message(dictGet(ctx, "workspace_root"));
    if (!drafted.ok) return drafted;
    message = pyStr(dictGet(drafted.value, "message"));
  }
  const result = _git_cmd(["commit", "-m", message], dictGet(ctx, "workspace_root"));
  if (result.ok) dictSet(result.meta, "commit_message", message);
  return result;
}

export function _git_commit_message_impl(args: JsonDict, ctx: JsonDict): Result {
  /** Draft a commit message without committing (for UI preview). */
  return _draft_commit_message(dictGet(ctx, "workspace_root"));
}

export function _draft_commit_message(repoRaw: unknown): Result {
  /**
   * Synchronously draft a commit message via CommitMessageGenerator.
   * An async wrapper can call ``generator.generate`` for the LLM path.
   */
  const repoPath = repoRaw === undefined ? null : repoRaw as string | null;
  const gen = get_commit_message_generator();
  if (!pyTruth(repoPath)) return Result.failure("No workspace_root in context");
  const diffR = gen.collect_staged_diff(repoPath as string);
  if (!diffR.ok) return diffR;
  const g = gen as unknown as {
    _heuristic(repo_path: string, diff: string, include_unstaged: boolean): string;
    _extract_type(message: string): string;
  };
  const message = g._heuristic(repoPath as string, diffR.value as string, false);
  return Result.success({
    message,
    type: g._extract_type(message),
    generated_by: "heuristic",
  });
}

export function _git_push_impl(args: JsonDict, ctx: JsonDict): Result {
  let cmd: string[];
  try {
    cmd = ["push", _git_value(pyStrOr(dictGet(args, "remote"), "") || "origin", "remote")];
    const branch = dictGet(args, "branch");
    if (pyTruth(branch)) cmd.push(_git_value(branch, "branch"));
  } catch (e) {
    if (e instanceof _GitArgError) return Result.failure(e.message);
    throw e;
  }
  return _git_cmd(cmd, dictGet(ctx, "workspace_root"));
}

export function _git_pull_impl(args: JsonDict, ctx: JsonDict): Result {
  let cmd: string[];
  try {
    cmd = ["pull", _git_value(pyStrOr(dictGet(args, "remote"), "") || "origin", "remote")];
    const branch = dictGet(args, "branch");
    if (pyTruth(branch)) cmd.push(_git_value(branch, "branch"));
  } catch (e) {
    if (e instanceof _GitArgError) return Result.failure(e.message);
    throw e;
  }
  return _git_cmd(cmd, dictGet(ctx, "workspace_root"));
}

export function _git_diff_impl(args: JsonDict, ctx: JsonDict): Result {
  const cmd = ["diff"];
  if (pyTruth(dictGet(args, "staged", false))) cmd.push("--cached");
  return _git_cmd(cmd, dictGet(ctx, "workspace_root"));
}

export function _git_log_impl(args: JsonDict, ctx: JsonDict): Result {
  let count: number;
  try {
    count = _git_count(dictGet(args, "count", 10));
  } catch (e) {
    if (e instanceof _GitArgError) return Result.failure(e.message);
    throw e;
  }
  return _git_cmd(["log", "--oneline", `-${count}`], dictGet(ctx, "workspace_root"));
}

export function _git_branch_impl(args: JsonDict, ctx: JsonDict): Result {
  const action = pyStr(dictGet(args, "action", "list"));
  if (action === "list") {
    return _git_cmd(["branch"], dictGet(ctx, "workspace_root"));
  }
  if (action !== "create" && action !== "switch") {
    return Result.failure(`Unknown action: ${action}`);
  }
  let name: string;
  try {
    name = _git_value(dictGet(args, "name"), "分支名");
  } catch (e) {
    if (e instanceof _GitArgError) return Result.failure(e.message);
    throw e;
  }
  // No `--` here on purpose: `git checkout -- <name>` means "restore this
  // path", not "switch to this branch". The leading-dash rejection above is
  // what protects the argument.
  if (action === "create") {
    return _git_cmd(["branch", name], dictGet(ctx, "workspace_root"));
  }
  return _git_cmd(["checkout", name], dictGet(ctx, "workspace_root"));
}

// ── singleton ────────────────────────────────────────────────────────────────

let _agent: FileAgent | null = null;

export function get_file_agent(workspace: string | null = null): FileAgent {
  if (_agent === null) {
    _agent = new FileAgent(workspace);
  }
  return _agent;
}

// PORT STATUS: confidence=high todos=[0]
