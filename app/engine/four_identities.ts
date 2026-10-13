/**
 * four_identities.ts — Ovolve Four-Fold Identity & Memory Separation Architecture.
 *
 * PORT of `app/backend/four_identities.py` (143 L, sha16 c990744ccc97abf0). The
 * python file stays READ-ONLY and is the ORACLE: every decision recorded below is
 * pinned by a measured CPython face (primitive readings tmp/fouri_rf_py.txt,
 * tmp/fouri_rf2_py.txt, tmp/fouri_rf3_py.txt plus the case ledger
 * tmp/fouri_facts_py.json), never by a reading of this file.
 *
 * RULEBOOK CITATIONS
 *   §1 node:fs / node:path only; no new runtime dependency.
 *   §M CPython mirrors are IMPORTED, never re-implemented here:
 *        py_truth, py_strip, PY_ISSPACE, os_path_join, os_path_split, py_repr,
 *        PyExcP, PyAttributeErrorP   ←  ./server/http_server_keys.js
 *      keys.ts carries no `os.path.realpath` mirror (§M says so explicitly), so
 *      `realpath_loose()` below is the labelled local mirror of that primitive;
 *      `str.format`, CPython text-mode I/O, the strict utf-8 decoder and the `re`
 *      replacement-template emulator are likewise local mirrors of primitives
 *      keys.ts does not carry, each cited to its measurement file.
 *   §2 `re.search`/`re.sub(count=1)` → py_re_* ; `.format(name=…)` → py_format.
 *   §4 naming: four_identities.py → four_identities.ts, snake_case exports kept.
 *
 * DIVERGENCE(port) — faces the parity measurement pinned and this file fixes (case
 * ids + both values in tmp/fouri_STATE.md; the comparator's DEFECT whitelist is
 * EMPTY, so every one of them is a real behaviour change, never a whitelist):
 *   M-01 the escape check is CPython's naive `target.startswith(base)`, kept naive
 *        ON PURPOSE: `rp.escapes.sibling_prefix` shows the source ACCEPTING an
 *        escape into a sibling whose name extends the base name, and the "safer"
 *        `path.relative` test flipped that decision (and, with M-02/M-03, turned
 *        `rp.w.backslash` / `rp.w.sep_only` from ValueError into a returned path —
 *        a fail-OPEN security defect, the highest-value finding of this unit).
 *   M-02 `fs.realpathSync` threw ENOENT where `os.path.realpath(p)` (strict=False)
 *        resolves a missing leaf LEXICALLY and never throws → realpath_loose.
 *   M-03 `path.join` where the source uses `os.path.join`: an absolute second
 *        component ("/", "\", "C:\x") RESETS the result in ntpath; path.join
 *        spliced it under the base, which is what let the escape check see a
 *        bogus in-workspace path.
 *   M-04 `re.sub` treats its replacement as a TEMPLATE (escapes, group refs,
 *        `\0` as octal, PatternError/IndexError for bad ones) and expands it even
 *        when the subject does not match; `String.replace` has different rules.
 *   M-05 `$&` / `$1` / `$<` / `` $` `` / `$'` / `$$` are JS replacement patterns;
 *        CPython's `.format` and f-strings have no `$` magic at all.
 *   M-06 Python `.` excludes only `\n` (JS also excludes `\r`, `\u2028`, `\u2029`)
 *        and Python `\s` is the 29-codepoint `str.isspace()` set (JS `\s` adds
 *        `\ufeff`, drops `\x1c-\x1f` and `\x85`) → PY_ISSPACE-derived classes.
 *   M-07 `str.strip()` ≠ `trim()` (U+0085, U+00A0, U+1C..U+1F) → py_strip.
 *   M-08 `.format(name=…)` replaces EVERY field of the template; `.replace
 *        ("{name}", v)` replaced only the first literal and left the rest.
 *   M-09 CPython text-mode I/O: `open(p,"w",encoding="utf-8")` translates every
 *        `\n` to `os.linesep` (CRLF on Windows) and `open(p,"r")` folds `\r\n` and
 *        lone `\r` back to `\n`; writeFileSync/readFileSync are byte-exact, so the
 *        module's own files were LF on the port and CRLF on the oracle.
 *   M-10 `workspace_root or "."` and `if not exists or overwrite` are Python
 *        truthiness tests (py_truth), `os.makedirs(base, exist_ok=True)` keeps its
 *        exact ladder (a FILE at base → FileExistsError, a missing parent →
 *        FileNotFoundError, NUL in the path → ValueError 'mkdir: embedded null
 *        character in path'), and open() with a NUL → ValueError 'embedded null
 *        character' (all measured, rf3 fs_arms).
 *   M-11 Win32 DOS-name trailing '.'/space stripping in `os.path.realpath`:
 *        CPython hands the raw name to `nt._getfinalpathname`, whose file namespace
 *        drops the trailing dots AND spaces of every component BEFORE lookup — so
 *        when every component still exists the answer comes back WITHOUT them
 *        (measured rf4 py, tmp/fouri_rf4_py.json: `ws\   ` → `ws`, `ws\ ` → `ws`,
 *        `ws\...` → `ws`, `ws\   ...` → `ws`, `ws\x.md   ` / `ws\x.md...` /
 *        `ws\x.md. . ` → `ws\x.md`, `ws\   \x.md` → `ws\x.md`, relative `   ` →
 *        the cwd itself), while node's `fs.realpathSync.native` throws ENOENT on
 *        EVERY such name (measured rf4 ts, tmp/fouri_rf4_ts.json, 19/19 ENOENT).
 *        CPython's non-strict fallback past the last resolvable prefix keeps the
 *        REMAINDER VERBATIM — trailing junk included (measured rf4 py:
 *        `ws\nope.md   ` → `...\nope.md   `, `ws\nope.md...` → `...\nope.md...`,
 *        `ws\nope\   ` → `...\nope\   `, `ws\nope.md   \deep` verbatim).
 *        → win32_strip_ns() is applied to each OS-resolve CANDIDATE, never to the
 *        verbatim tail; "." and ".." components keep their meaning (the lexical
 *        form is already resolve-normalised, so only all-dot/all-space residues
 *        can appear, and rf4 pins them to vanish).
 * PORT FIX (successor run 2026-09-29, re-pin #1, cause: the unit's own parity
 * compare measured upn#uin_bs_bs nchars 78→79 and upn#uun_bs_bs nchars 73→74):
 *   P-01 `py_parse_template` arm for `\`+`\`: CPython's re.sub replacement
 *        template collapses a doubled backslash to ONE backslash; the old arm
 *        kept both. CPython in-situ evidence: tmp/fouri_oracle_facts.json keys
 *        D2_uin_bs_bs_nchars=78, D3_uin_bs_bs_folded, D5_uin_bs_bs_backslash_count=1,
 *        E2_uun_bs_bs_nchars=73, E3_uun_bs_bs_folded, E4_uun_bs_bs_backslash_count=1,
 *        F1_bare_repl_template_bs_bs + F2_bare_repl_bs_count=1 (bare re.sub),
 *        contrast arms G4_bs_dash_folded (punctuation keeps the backslash) and
 *        G1/G2/G3 (trailing backslash → PatternError "bad escape (end of pattern)
 *        at position 12") - arms the fix deliberately does NOT touch. The changed
 *        line in §4 cites these same keys. The gate row port_fix_evidence pins
 *        this file's hash and requires these citations.
 * Registered cross-runtime artifacts, canonicalized by the PROBES (never here):
 * the two sandboxes' own root spelling (canon → "B"), CPython's localized
 * `[WinError N] <prose>` vs this file's POSIX-shaped `[Errno N] <strerror>` (the
 * same rule app/engine/file_agent.ts 68-74 registers — only the bracketed OS
 * segment; the path a message names stays verbatim), and python's tuple face of
 * ALL_IDENTITY_FILES. §3's spec parser covers the arms rf2/rf3 measured; the
 * source's constant templates carry no conversion or spec fields, so unmeasured
 * spec shapes (e.g. a bare `010`) are outside this unit's reachable surface and
 * take the nearest measured arm.
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  PY_ISSPACE,
  PyAttributeErrorP,
  PyExcP,
  PyTypeErrorP,
  ntp_splitroot,
  os_path_join,
  os_path_split,
  py_repr,
  py_strip,
  py_truth,
} from "./server/http_server_keys.js";

export const IDENTITY_FILE = "IDENTITY.md";
export const USER_FILE = "USER.md";
export const SOUL_FILE = "SOUL.md";
export const MEMORY_FILE = "MEMORY.md";

export const ALL_IDENTITY_FILES: readonly string[] = [IDENTITY_FILE, USER_FILE, SOUL_FILE, MEMORY_FILE];

export const DEFAULT_IDENTITY_TEMPLATE = `# IDENTITY.md · AI Identity Specification

- **Name**: {name}
- **Role**: High-Performance Autonomous AI Software Engineering Assistant
- **Version**: Ovolve v1.0
- **Engine**: Hybrid Dual-Engine (Vite + Electron / Python Orchestration)
`;

export const DEFAULT_USER_TEMPLATE = `# USER.md · User Profile & Preferences

- **Name**: {user_name}
- **Role**: Technical AI Product Manager & Engineering Lead
- **Preferred Language**: Chinese (Simplified) / Technical English
- **Communication Style**: Direct, evidence-based, architecture-first
`;

export const DEFAULT_SOUL_TEMPLATE = `# SOUL.md · Agent Persona & Principles

## 1. 核心性格与语气
- 严谨、专注、实事求是。不讲空话、套话与机械套词。
- 坚持第一性原理与深水区工程穿透。

## 2. 工程与质量红线
- 证据优先：任何断言必须有物理运行与退出码支撑（No Proof, No Claim）。
- Fail-Open 与故障自愈：边缘服务崩溃坚决不中断主会话。
- 可审计性：关键路径保持显式边界与单一职责，改动必须能被自动化回归覆盖。
`;

/** 源的两个默认实参（update_* 的回退臂复用同一个值，不在两处写字面量）。 */
const DEFAULT_AI_NAME = "Ovolve";
const DEFAULT_USER_NAME = "User";

/** 源里两处使用的同一条模式（CPython 源码字符串；py_re_* 负责翻译）。 */
const NAME_FIELD_PATTERN = "-\\s*\\*\\*Name\\*\\*:\\s*.+";

/* ──────────────────────────────────────────────────────────────────────────
 * §0 CPython 异常镜像（message == str(exc)，全部走 keys.ts 的共享基类 PyExcP）
 * ──────────────────────────────────────────────────────────────────────── */

/** `ValueError` —— 源 61 行 `raise ValueError(f"Target path escapes workspace: …")`。 */
export class ValueErrorP extends PyExcP {
  constructor(message: string) { super("ValueError", message); }
}
/** `KeyError` —— `str(KeyError(k)) == repr(k)`，所以文案走共享的 py_repr。 */
export class KeyErrorP extends PyExcP {
  constructor(key: string) { super("KeyError", py_repr(key)); }
}
/** `IndexError` —— `.format` 的位置字段、`\g<name>` 的未知组名。 */
export class IndexErrorP extends PyExcP {
  constructor(message: string) { super("IndexError", message); }
}
/** `re.PatternError`（3.13 里 `re.error` 的真名；实测 `type(e).__name__ == "PatternError"`）。 */
export class PatternErrorP extends PyExcP {
  constructor(message: string) { super("PatternError", message); }
}
/** `UnicodeDecodeError` —— 文案与 search_agent.ts 的镜像同源（u1..u11 实测钉死）。 */
export class UnicodeDecodeErrorP extends PyExcP {
  constructor(message: string) { super("UnicodeDecodeError", message); }
}
/** `FileExistsError` —— `os.makedirs(exist_ok=True)` 撞上同名文件（WinError 183）。 */
export class FileExistsErrorP extends PyExcP {
  constructor(message: string) { super("FileExistsError", message); }
}
/** `FileNotFoundError` —— open()/mkdir() 的缺路径臂。 */
export class FileNotFoundErrorP extends PyExcP {
  constructor(message: string) { super("FileNotFoundError", message); }
}
/** `NotADirectoryError` —— mkdir 的 ENOTDIR 臂（实测 node 在该臂给 ENOENT，故极少走到）。 */
export class NotADirectoryErrorP extends PyExcP {
  constructor(message: string) { super("NotADirectoryError", message); }
}
/** `PermissionError` —— 实测 `open(目录)` 在 Windows 上是它，不是 IsADirectoryError。 */
export class PermissionErrorP extends PyExcP {
  constructor(message: string) { super("PermissionError", message); }
}
/** `OSError` 兜底。 */
export class OSErrorP extends PyExcP {
  constructor(message: string) { super("OSError", message); }
}

/** node errno code → (CPython 异常名, strerror 原文, errno 号)。实测映射：
 *  mkdir 撞文件 EEXIST→FileExistsError（py 侧 WinError 183）、mkdir 缺父目录
 *  ENOENT→FileNotFoundError（py 侧 WinError 3）、open(目录) EISDIR→
 *  PermissionError(Errno 13)、open 缺目录/父段是文件 ENOENT→FileNotFoundError
 *  (Errno 2)。strerror 用 CPython 的 POSIX 侧原文，Windows 侧的本地化 WinError
 *  文案由探针按注册规则规范化（见文件头）。 */
function oserror_pair(code: string): [string, string, number] | null {
  switch (code) {
    case "ENOENT": return ["FileNotFoundError", "No such file or directory", 2];
    case "EEXIST": return ["FileExistsError", "File exists", 17];
    case "ENOTDIR": return ["NotADirectoryError", "Not a directory", 20];
    case "EISDIR": return ["IsADirectoryError", "Is a directory", 21];
    case "EACCES":
    case "EPERM": return ["PermissionError", "Permission denied", 13];
    default: return null;
  }
}

/** 把 node 的 fs 异常重写成 CPython 的异常对象（同名 + `[Errno N] …: '路径'`）。 */
function py_fs_error(e: unknown, p: string): Error {
  const code = String((e as { code?: unknown }).code ?? "");
  const pair = oserror_pair(code);
  const msg = `[Errno ${pair ? pair[2] : 0}] ${pair ? pair[1] : code}: ${py_repr(p)}`;
  switch (pair ? pair[0] : "OSError") {
    case "FileNotFoundError": return new FileNotFoundErrorP(msg);
    case "FileExistsError": return new FileExistsErrorP(msg);
    case "NotADirectoryError": return new NotADirectoryErrorP(msg);
    case "PermissionError": return new PermissionErrorP(msg);
    default: return new OSErrorP(msg);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §1 os.path 镜像（realpath 无共享镜像 → 标注的局部镜像，逐条对齐实测）
 * ──────────────────────────────────────────────────────────────────────── */

/** ntpath.abspath 的词法部分：join(cwd, p) + normpath + 盘符大写。
 *  node 的 path.resolve 做前两件，但 ① 不大写盘符（实测 `d:/x` → `d:\x`，CPython
 *  一律 `D:\x`）② 盘符相对形 `D:foo`/`a:b.md` 的解析与 Win32 不同（实测
 *  resolve(`D:foo`)=`D:\foo`、resolve(`a:b.md`)=`a:\b.md`，CPython 实测给
 *  `<cwd on D>\foo` 与**原样** `a:b.md`）——两处都在这里补上。 */
function ntp_abspath(p: string): string {
  const m = /^([A-Za-z]:)([^\\/].*)$/.exec(p);
  if (m) {
    const drive = (m[1] as string).toUpperCase();
    const rest = m[2] as string;
    const cwd = process.cwd();
    if (cwd.length > 1 && cwd[1] === ":" && cwd.slice(0, 2).toUpperCase() === drive) {
      return path.resolve(cwd.charAt(0).toUpperCase() + cwd.slice(1, 3) + rest);
    }
    return p; // 其他盘符：该盘没有隐式 cwd，Win32/CPython 原样返回（实测 a:b.md）
  }
  const r = path.resolve(p);
  return r.length > 1 && r[1] === ":" ? r.charAt(0).toUpperCase() + r.slice(1) : r;
}

/** M-11 的局部镜像（rf4 实测钉死，见文件头编号段）：Win32 DOS 名解析在查表前
 *  去掉每个路径段尾部的 '.' 与空格（全由 '.'/空格 组成的段整段消失，实测
 *  `ws\   `→`ws`、`ws\...`→`ws`、`ws\x.md   `→`ws\x.md`、`ws\   \x.md`→
 *  `ws\x.md`；`.`/`..` 两个段名有目录语义、不参与本剥离——实测它们各归各的
 *  父目录，且 lex 形经 path.resolve 后不会再出现这两段）。没有任何段被改动时
 *  原样返回入参（不重写分隔符），所以零尾巴风险。 */
function win32_strip_ns(p: string): string {
  const [drive, root, tail] = ntp_splitroot(p);
  const comps = tail.split(/[\\/]/);
  const out: string[] = [];
  let changed = false;
  for (const c of comps) {
    if (c === "." || c === "..") { out.push(c); continue; }
    const s = c.replace(/[. ]+$/g, "");
    if (s === c) { out.push(c); continue; }
    changed = true;
    if (s !== "") out.push(s);
  }
  return changed ? drive + root + out.join("\\") : p;
}

/**
 * `os.path.realpath(p)`（strict=False，3.13 的 Windows 实现）的局部镜像：
 *   · 存在的前缀用 GetFinalPathNameByHandleW（= `fs.realpathSync.native`，但
 *     node 的绑定**不做** Win32 的尾部 '.'/空格剥离——rf4 ts 实测 19/19 ENOENT，
 *     所以候选名先过 win32_strip_ns，这一剥离是 rf4 py 实测的 CPython 侧行为），
 *   · 不存在的最长尾段**词法**拼接且**原样保留**（rf4 py：`ws\nope.md   ` →
 *     `...\nope.md   `，连尾巴的 '.'/空格 都不剥），绝不抛错（实测 miss_leaf/
 *     miss_deep/realpath_under_file/realpath_nul 四行都是"返回路径、不抛"），
 *   · 结果统一为反斜杠形、盘符大写、无尾分隔符。
 * keys.ts 明写 realpath 无镜像，故这是本文件私有的标注镜像。
 */
function realpath_loose(p: string): string {
  const lex = ntp_abspath(p);
  const tail: string[] = [];
  let prefix = lex;
  for (;;) {
    try {
      let out = fs.realpathSync.native(win32_strip_ns(prefix));
      for (const seg of tail) out = os_path_join(out, seg);
      return ntp_abspath(out);
    } catch {
      const [head, name] = os_path_split(prefix);
      if (name === "" || head === prefix) break; // 已到盘根：连根都解析不了
      tail.unshift(name);
      prefix = head;
    }
  }
  return lex;
}

/** `os.path.exists`（genericpath：stat 抛异常即 False；实测 NUL 路径也是 False）。 */
function os_path_exists(p: string): boolean {
  try { fs.statSync(p); return true; } catch { return false; }
}
/** `os.path.isfile`。 */
function os_path_isfile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
/** `os.path.isdir`。 */
function os_path_isdir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** `os.makedirs(name, mode=0o777, exist_ok=True)`（3.13 逐字的递归梯子）。 */
function os_makedirs_exist_ok(name: string): void {
  let [head, tail] = os_path_split(name);
  if (!tail) [head, tail] = os_path_split(head);
  if (head && tail && !os_path_exists(head)) {
    try { os_makedirs_exist_ok(head); } catch (e) { if (!(e instanceof FileExistsErrorP)) throw e; }
    if (tail === ".") return; // `x/.` 不需要再 mkdir（实测 OK）
  }
  if (name.indexOf("\x00") >= 0) throw new ValueErrorP("mkdir: embedded null character in path");
  try {
    fs.mkdirSync(name);
  } catch (e) {
    if (!os_path_isdir(name)) throw py_fs_error(e, name);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §2 CPython 文本 I/O（M-09/M-10）
 * ──────────────────────────────────────────────────────────────────────── */

/** `os.linesep`：与 CPython 一样按平台取值。 */
const OS_LINESEP = process.platform === "win32" ? "\r\n" : "\n";

/** `open(p,"w",encoding="utf-8")` 的 newline=None 翻译：每个 `\n` → os.linesep，
 *  已有的 `\r` 原样保留（实测 write_translation：`a\nb\r\nc\r\n\n` →
 *  `a\r\nb\r\r\nc\r\r\n\r\n`，13 字节；`a\rb` → 3 字节不变）。 */
function py_write_newlines(s: string): string {
  return s.split("\n").join(OS_LINESEP);
}

/** `open(p,"r",encoding="utf-8")` 的 universal newlines：`\r\n`、孤 `\r` → `\n`。 */
function py_read_newlines(s: string): string {
  return s.split("\r\n").join("\n").split("\r").join("\n");
}

/** `bytes.decode("utf-8")`（strict 臂）+ CPython 的 UnicodeDecodeError 文案。
 *  与 search_agent.ts 的私有实现同源（那里的 u1..u11 是实测钉死的）；不 import
 *  是会把整个 search 段拖进本单元的 emit 目录。 */
function utf8_strict_decode(buf: Uint8Array): string {
  const fail = (start: number, end: number, why: string): never => {
    const head = start === end
      ? `byte 0x$(((buf[start] as number) & 0xff).toString(16).padStart(2, "0")} in position ${start}`
      : `bytes in position ${start}-${end}`;
    throw new UnicodeDecodeErrorP(`'utf-8' codec can't decode ${head}: ${why}`);
  };
  const b = Array.from(buf);
  const n = b.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const b0 = b[i] as number;
    if (b0 <= 0x7f) { out += String.fromCharCode(b0); i += 1; continue; }
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = b[i + 1] as number | undefined;
      if (b1 === undefined) fail(i, i, "unexpected end of data");
      if ((((b1 as number) & 0xc0)) !== 0x80) fail(i, i, "invalid continuation byte");
      out += String.fromCodePoint(((b0 & 0x1f) << 6) | ((b1 as number) & 0x3f));
      i += 2; continue;
    }
    if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = b[i + 1] as number | undefined;
      const b2 = b[i + 2] as number | undefined;
      if (b1 === undefined) fail(i, i, "unexpected end of data");
      if ((((b1 as number)) & 0xc0) !== 0x80) fail(i, i, "invalid continuation byte");
      if (b0 === 0xe0 && (b1 as number) < 0xa0) fail(i, i, "invalid continuation byte");
      if (b0 === 0xed && (b1 as number) >= 0xa0) fail(i, i, "invalid continuation byte");
      if (b2 === undefined) fail(i, i + 1, "unexpected end of data");
      if ((((b2 as number)) & 0xc0) !== 0x80) fail(i, i, "invalid continuation byte");
      out += String.fromCodePoint(((b0 & 0x0f) << 12) | (((b1 as number) & 0x3f) << 6) | ((b2 as number) & 0x3f));
      i += 3; continue;
    }
    if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = b[i + 1] as number | undefined;
      const b2 = b[i + 2] as number | undefined;
      const b3 = b[i + 3] as number | undefined;
      if (b1 === undefined) fail(i, i, "unexpected end of data");
      if ((((b1 as number)) & 0xc0) !== 0x80) fail(i, i, "invalid continuation byte");
      if (b0 === 0xf0 && (b1 as number) < 0x90) fail(i, i, "invalid continuation byte");
      if (b0 === 0xf4 && (b1 as number) > 0x8f) fail(i, i, "invalid continuation byte");
      if (b2 === undefined) fail(i, i + 1, "unexpected end of data");
      if ((((b2 as number)) & 0xc0) !== 0x80) fail(i, i, "invalid continuation byte");
      if (b3 === undefined) fail(i, i + 2, "unexpected end of data");
      if ((((b3 as number)) & 0xc0) !== 0x80) fail(i, i, "invalid continuation byte");
      out += String.fromCodePoint(((b0 & 0x07) << 18) | (((b1 as number) & 0x3f) << 12)
        | (((b2 as number) & 0x3f) << 6) | ((b3 as number) & 0x3f));
      i += 4; continue;
    }
    fail(i, i, "invalid start byte");
  }
  return out;
}

/** `with open(p,"r",encoding="utf-8") as f: f.read()` */
function py_read_text(p: string): string {
  if (p.indexOf("\x00") >= 0) throw new ValueErrorP("embedded null character");
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? "");
    // 实测：读目录在 Windows 上是 PermissionError([Errno 13])，不是 IsADirectoryError
    if (code === "EISDIR") throw new PermissionErrorP(`[Errno 13] Permission denied: ${py_repr(p)}`);
    throw py_fs_error(e, p);
  }
  return py_read_newlines(utf8_strict_decode(buf));
}

/** `with open(p,"w",encoding="utf-8") as f: f.write(s)`（截断 + 文本模式翻译）。 */
function py_write_text(p: string, s: string): void {
  if (p.indexOf("\x00") >= 0) throw new ValueErrorP("embedded null character");
  try {
    fs.writeFileSync(p, py_write_newlines(s), "utf8");
  } catch (e) {
    const code = String((e as { code?: unknown }).code ?? "");
    if (code === "EISDIR") throw new PermissionErrorP(`[Errno 13] Permission denied: ${py_repr(p)}`);
    throw py_fs_error(e, p);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §3 `str.format(**kw)`（M-05 / M-08）——实测见 rf2["format"] + rf3["format2"]
 * ──────────────────────────────────────────────────────────────────────── */

/** 一个 `{…}` 字段：`{name}` / `{name!r}` / `{name:spec}` / 下标 / 属性的 CPython 语义。 */
function format_field(field: string, kw: Record<string, string>): string {
  if (field === "" || /^[0-9.]/.test(field)) {
    // 位置字段（源只用关键字实参）→ 实测 IndexError 原文
    throw new IndexErrorP("Replacement index 0 out of range for positional args tuple");
  }
  const colon = field.indexOf(":");
  let head = colon < 0 ? field : field.slice(0, colon);
  const spec = colon < 0 ? "" : field.slice(colon + 1);
  let conv = "";
  if (head.length > 2 && head.charAt(head.length - 2) === "!") {
    conv = head.charAt(head.length - 1);
    head = head.slice(0, head.length - 2);
  }
  // 属性字段：源的常量模板不出现。CPython 对真实 str 成员给绑定方法的 repr（含内存
  // 地址，任何运行时都不可移植，实测 rf3 `{name.upper}`），对未知属性给
  // AttributeError —— 端口统一走实测的那一支。
  if (head.indexOf(".") >= 0) throw new PyAttributeErrorP("", head.slice(head.indexOf(".") + 1));
  let subIdx = -1;
  if (head.indexOf("[") >= 0) {
    const inner = head.slice(head.indexOf("[") + 1, head.length - 1);
    if (!/^[0-9]+$/.test(inner)) throw new PyTypeErrorP("string indices must be integers, not 'str'");
    subIdx = Number(inner);
    head = head.slice(0, head.indexOf("["));
  }
  if (!(head in kw)) throw new KeyErrorP(head);
  let value = kw[head] as string;
  if (subIdx >= 0) value = Array.from(value)[subIdx] as string;
  if (conv === "r" || conv === "a") value = py_repr(value);
  else if (conv === "s" || conv === "") { /* 恒等 */ }
  else throw new ValueErrorP(`Unknown conversion specifier ${conv}`);
  if (spec === "") return value;
  return py_format_spec(value, spec, kw);
}

/** `[[fill]align][sign][#][0][width][,][.precision][type]`，str 臂（rf3 实测集）。 */
function py_format_spec(value: string, spec: string, kw: Record<string, string>): string {
  let i = 0;
  let fill = " ";
  let align = "";
  if (spec.length >= 2 && "<^>=! ".indexOf(spec.charAt(1)) >= 0 && spec.charAt(1) !== "!") {
    fill = spec.charAt(0); align = spec.charAt(1); i = 2;
  } else if ("<^>".indexOf(spec.charAt(0)) >= 0) { align = spec.charAt(0); i = 1; }
  if (spec.charAt(i) === "=") throw new ValueErrorP("'=' alignment not allowed in string format specifier");
  const sign = spec.charAt(i);
  if (sign === "+" || sign === "-") throw new ValueErrorP("Sign not allowed in string format specifier");
  if (sign === " ") throw new ValueErrorP("Space not allowed in string format specifier");
  if (sign === "-") i += 1;
  if (spec.charAt(i) === "#") throw new ValueErrorP("Alternate form (#) not allowed in string format specifier");
  let zero = false;
  if (spec.charAt(i) === "0") { zero = true; i += 1; }
  let width = "";
  while (i < spec.length && spec.charAt(i) >= "0" && spec.charAt(i) <= "9") { width += spec.charAt(i); i += 1; }
  if (spec.charAt(i) === ",") throw new ValueErrorP("Cannot specify ',' with 's'.");
  if (spec.charAt(i) === "_") throw new ValueErrorP("Cannot specify '_' with 's'.");
  let precision = -1;
  if (spec.charAt(i) === ".") {
    i += 1;
    let d = "";
    while (i < spec.length && spec.charAt(i) >= "0" && spec.charAt(i) <= "9") { d += spec.charAt(i); i += 1; }
    precision = d === "" ? 0 : Number(d);
  }
  let type = spec.slice(i);
  if (type.indexOf("{") === 0) {
    // 嵌套字段：实测 `{name:{user_name}}` → Unknown format code 'U' …
    if (type === "{}") throw new IndexErrorP("Replacement index 0 out of range for positional args tuple");
    const inner = type.slice(1, type.length - 1);
    if (inner in kw) throw new ValueErrorP(`Unknown format code '${kw[inner]}' for object of type 'str'`);
    throw new KeyErrorP(inner);
  }
  if (type !== "" && type !== "s") throw new ValueErrorP(`Unknown format code '${type}' for object of type 'str'`);
  let s = value;
  if (precision >= 0) s = Array.from(s).slice(0, precision).join("");
  const w = width === "" ? 0 : Number(width);
  if (zero && !align && width) fill = "0";
  if (!align) align = "<"; // str 的默认对齐（实测 `{name:10}` → 左对齐）
  const padCount = Math.max(0, w - Array.from(s).length);
  if (padCount === 0) return s;
  if (align === "<") return s + fill.repeat(padCount);
  if (align === ">") return fill.repeat(padCount) + s;
  const left = Math.floor(padCount / 2);
  return fill.repeat(left) + s + fill.repeat(padCount - left);
}

/** `TPL.format(**kw)`：扫描模板，替换**每一个**字段（M-08），`{{`/`}}` 是字面量。
 *  实参值里的 `{`/`}`/`$` 都不再被扫描（实测 ai_brace / ai_dollar 两族）。 */
function py_format(tpl: string, kw: Record<string, string>): string {
  let out = "";
  let i = 0;
  const n = tpl.length;
  while (i < n) {
    const c = tpl.charAt(i);
    if (c === "{") {
      if (tpl.charAt(i + 1) === "{") { out += "{"; i += 2; continue; }
      const close = tpl.indexOf("}", i + 1);
      if (close < 0) throw new ValueErrorP("expected '}' before end of string");
      out += format_field(tpl.slice(i + 1, close), kw);
      i = close + 1;
      continue;
    }
    if (c === "}") {
      if (tpl.charAt(i + 1) === "}") { out += "}"; i += 2; continue; }
      throw new ValueErrorP("Single '}' encountered in format string");
    }
    out += c;
    i += 1;
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * §4 `re`：Python 字符类 + 替换模板（M-04 / M-05 / M-06）
 * ──────────────────────────────────────────────────────────────────────── */

/** Python `\s`（str 模式）= `str.isspace()` 的码位集，直接由 §M 的 PY_ISSPACE 生成；
 *  JS 的 `\s` 多 `\ufeff`、少 `\x1c-\x1f`/`\x85`，不能直接用（实测 search_extra）。 */
function py_space_class(negate: boolean): string {
  const cps = Array.from(PY_ISSPACE.values()).sort((a, b) => a - b);
  let body = "";
  for (const cp of cps) {
    body += cp <= 0xff ? "\\x" + cp.toString(16).padStart(2, "0") : "\\u" + cp.toString(16).padStart(4, "0");
  }
  return "[" + (negate ? "^" : "") + body + "]";
}

/** 源里那条模式的 Python 原子 → JS 原子：`.` 只排除 `\n`，`\s` 换成上面的类。
 *  本单元的 pattern 是常量，只用这两种原子；`\w`/`\d` 一族在 CPython 里是 Unicode
 *  语义、JS 不等价，所以显式拒绝而不是"顺手近似"（改模式的变异会被抓）。 */
function py_re_to_js(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === "\\") {
      const d = src.charAt(i + 1);
      if (d === "") throw new PatternErrorP(`bad escape (end of pattern) at position ${i}`);
      if (d === "s") { out += py_space_class(false); i += 2; continue; }
      if (d === "S") { out += py_space_class(true); i += 2; continue; }
      if (/[a-zA-Z]/.test(d)) throw new PatternErrorP(`untranslated python atom \\${d} at position ${i}`);
      out += "\\" + d;
      i += 2; continue;
    }
    if (c === ".") { out += "[^\\n]"; i += 1; continue; }
    out += c;
    i += 1;
  }
  return out;
}

/** 模式里的捕获组数（本单元的常量模式为 0；命名组不计）。 */
function py_re_groups(src: string): number {
  return (src.match(/(?<!\\)\((?!\?)/g) || []).length;
}

/** `re.search(p, s)` → 匹配区间，找不到 null。 */
function py_re_search(src: string, s: string): { start: number; end: number } | null {
  const m = new RegExp(py_re_to_js(src)).exec(s);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\x08", f: "\x0c", n: "\n", r: "\r", t: "\t", v: "\x0b",
};

/**
 * `re.sub` 的替换模板编译器（CPython `parse_template`，实测
 * rf2["sub_templates"] + rf3["sub_extra"]）：返回按 match 展开的函数。
 * 要点（M-04/M-05）：`$` 在模板里**没有**任何魔法，`\` 才有；`\q` 一类非法转义在
 * 解析期抛 PatternError(`bad escape \q at position P`，P = 反斜脚下标)，组引用越界
 * 抛 PatternError(`invalid group reference N at position P`，P = 首位数字下标)，
 * 未知组名抛 IndexError(`unknown group name 'x'`)，`\0`/`\00` 是**八进制**而不是
 * 组 0，非字母非数字的 `\X` 保留反斜杠（实测 `\-` → `\-`），而且**即使主题不匹配
 * 也照样解析并抛错**（实测 nomatch 主题同样 THROW）。
 */
function py_parse_template(
  tpl: string,
  ngroups: number,
  groupindex: Record<string, number> = {}
): (whole: string, groups: string[]) => string {
  const items: Array<{ lit: string } | { grp: number }> = [];
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isOct = (c: string) => c >= "0" && c <= "7";
  let i = 0;
  const n = tpl.length;
  while (i < n) {
    const c = tpl.charAt(i);
    if (c !== "\\") { items.push({ lit: c }); i += 1; continue; }
    if (i + 1 >= n) throw new PatternErrorP(`bad escape (end of pattern) at position ${i}`);
    const d = tpl.charAt(i + 1);
    // P-01 (2026-09-29 successor fix, CPython in-situ oracle tmp/fouri_oracle_facts.json):
    // the template parser reads `\`+`\` as an ESCAPED BACKSLASH and emits ONE
    // backslash - measured keys D3_uin_bs_bs_folded / E3_uun_bs_bs_folded (text
    // "...- **Name": \"), D5/E4 backslash_count=1, D2_uin_bs_bs_nchars=78,
    // E2_uun_bs_bs_nchars=73, F1/F2 bare re.sub face. `\`+punctuation keeps BOTH
    // chars (G4_bs_dash_folded: "\-" → "\-") and `\`+end throws PatternError at
    // the backslash index (G3_single_bs_exc_msg "bad escape (end of pattern) at
    // position 12") - those arms already sit below and stay untouched. The old
    // code fell through to the punctuation arm for `\\` and DOUBLED one
    // backslash into two (parity compare C/D: upn#uin_bs_bs nchars 78→79,
    // upn#uun_bs_bs nchars 73→74).
    if (d === "\\") { items.push({ lit: "\\" }); i += 2; continue; }
    if (!/[a-zA-Z0-9]/.test(d)) { items.push({ lit: "\\" + d }); i += 2; continue; }
    if (isDigit(d)) {
      if (d === "0") {
        let j = i + 1;
        let val = 0;
        let k = 0;
        while (j < n && k < 3 && isOct(tpl.charAt(j))) { val = val * 8 + (tpl.charCodeAt(j) - 48); j += 1; k += 1; }
        items.push({ lit: String.fromCodePoint(val) });
        i = j; continue;
      }
      let j = i + 1;
      let num = "";
      while (j < n && isDigit(tpl.charAt(j))) { num += tpl.charAt(j); j += 1; }
      const g = Number(num);
      if (g > ngroups) throw new PatternErrorP(`invalid group reference ${g} at position ${i + 1}`);
      items.push({ grp: g });
      i = j; continue;
    }
    if (d === "g") {
      if (tpl.charAt(i + 2) !== "<") throw new PatternErrorP(`missing < at position ${i + 2}`);
      const start = i + 3;
      const close = tpl.indexOf(">", start);
      const namestr = close < 0 ? tpl.slice(start) : tpl.slice(start, close);
      if (namestr === "") throw new PatternErrorP(`missing group name at position ${start}`);
      if (close < 0) throw new PatternErrorP(`missing > at position ${tpl.length}`);
      if (/^[0-9]+$/.test(namestr)) {
        const g = Number(namestr);
        if (g > ngroups) throw new PatternErrorP(`invalid group reference ${g} at position ${start}`);
        items.push({ grp: g });
      } else {
        if (!(namestr in groupindex)) throw new IndexErrorP(`unknown group name ${py_repr(namestr)}`);
        items.push({ grp: groupindex[namestr] as number });
      }
      i = close + 1; continue;
    }
    if (d in SIMPLE_ESCAPES) { items.push({ lit: SIMPLE_ESCAPES[d] as string }); i += 2; continue; }
    throw new PatternErrorP(`bad escape \\${d} at position ${i}`);
  }
  return (whole: string, groups: string[]) => {
    let s = "";
    for (const it of items) s += "lit" in it ? (it as { lit: string }).lit : (it.grp === 0 ? whole : groups[it.grp - 1] ?? "");
    return s;
  };
}

/** `re.sub(pattern, repl, s, count)`（count=0 → 全部；实测 sub_count0 三行）。 */
function py_re_sub(src: string, repl: string, s: string, count = 1): string {
  const expand = py_parse_template(repl, py_re_groups(src));
  const rx = new RegExp(py_re_to_js(src), "g");
  let out = "";
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    if (count > 0 && n >= count) break;
    out += s.slice(last, m.index);
    out += expand(m[0], m.slice(1));
    last = m.index + m[0].length;
    n += 1;
    if (m[0] === "") rx.lastIndex += 1; // 零宽匹配不原地打转（实测 `x*` → 'Xabc'）
  }
  out += s.slice(last);
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * §5 源函数
 * ──────────────────────────────────────────────────────────────────────── */

/** Safely resolve an identity file path within the workspace. */
export function get_identity_path(workspace_root: string, filename: string): string {
  const base = realpath_loose(py_truth(workspace_root) ? String(workspace_root) : ".");
  const target = realpath_loose(os_path_join(base, String(filename)));
  if (!target.startsWith(base)) {
    throw new ValueErrorP(`Target path escapes workspace: ${filename}`);
  }
  return target;
}

/** Initialize default identity files if they do not already exist. */
export function init_workspace_identities(
  workspace_root: string,
  ai_name: string = DEFAULT_AI_NAME,
  user_name: string = DEFAULT_USER_NAME,
  overwrite: boolean = false
): Record<string, boolean> {
  const results: Record<string, boolean> = {};
  const base = realpath_loose(py_truth(workspace_root) ? String(workspace_root) : ".");
  os_makedirs_exist_ok(base);

  const defaults: Array<[string, string]> = [
    [IDENTITY_FILE, py_format(DEFAULT_IDENTITY_TEMPLATE, { name: ai_name })],
    [USER_FILE, py_format(DEFAULT_USER_TEMPLATE, { user_name: user_name })],
    [SOUL_FILE, DEFAULT_SOUL_TEMPLATE],
  ];

  for (const [fname, content] of defaults) {
    const p = os_path_join(base, fname);
    if (!os_path_exists(p) || py_truth(overwrite)) {
      py_write_text(p, py_strip(content) + "\n");
      results[fname] = true;
    } else {
      results[fname] = false;
    }
  }

  return results;
}

/** 两个 update_* 的公共体：源里除文件名与 init 的关键字实参外逐字相同。 */
function update_name_field(
  workspace_root: string,
  filename: string,
  new_name: string,
  as_user: boolean
): boolean {
  const p = get_identity_path(workspace_root, filename);
  if (!os_path_isfile(p)) {
    if (as_user) init_workspace_identities(workspace_root, DEFAULT_AI_NAME, new_name);
    else init_workspace_identities(workspace_root, new_name);
    return true;
  }

  const content = py_read_text(p);

  // Precise regex replacement for - **Name**: <name>
  let new_content: string;
  if (py_re_search(NAME_FIELD_PATTERN, content)) {
    new_content = py_re_sub(NAME_FIELD_PATTERN, `- **Name**: ${new_name}`, content, 1);
  } else {
    new_content = py_strip(content) + `\n- **Name**: ${new_name}\n`;
  }

  py_write_text(p, new_content);
  return true;
}

/** Update the AI assistant's name in IDENTITY.md without modifying other fields. */
export function update_identity_name(workspace_root: string, new_ai_name: string): boolean {
  return update_name_field(workspace_root, IDENTITY_FILE, new_ai_name, false);
}

/** Update the user's preferred name in USER.md without modifying other fields. */
export function update_user_name(workspace_root: string, new_user_name: string): boolean {
  return update_name_field(workspace_root, USER_FILE, new_user_name, true);
}

// PORT STATUS: 本文件无 TODO(port)。
