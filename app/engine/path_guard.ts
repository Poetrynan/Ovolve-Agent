/**
 * path_guard.ts — process-artifact isolation.
 *
 * Ported from `app/backend/path_guard.py` (576 lines).
 *
 * Mounted as the highest-priority `pre_tool_use` subscriber so a path violation
 * hard-blocks a write BEFORE the risk controller can approve it.
 *
 * Rules enforced on file-mutating tools (write/edit/delete/move/copy):
 *   1. never write inside a blacklisted system directory — blocked even if the
 *      user "confirmed", because that is never a safe target;
 *   2. never escape the workspace root via `..` or an absolute path landing
 *      outside the workspace / sanctioned temp / output dirs;
 *   3. never overwrite a GUIDING file (AGENTS.md / MEMORY.md / SOUL.md) — the
 *      memory layer maintains them through its own merge path, so this only
 *      closes the door on the MODEL;
 *   4. date-scoped files are APPEND-ONLY: a write whose content does not start
 *      with the current content is a rewrite, not an append;
 *   5. command-running tools get a narrower version of rules 1-2;
 *   6. test artifacts are hard-blocked, because rewriting assertions is the
 *      easiest way to inflate a score.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/path_guard.py -> app/engine/path_guard.ts
 *   §2  `re.VERBOSE` has no JS equivalent; the pattern is written unrolled
 *   §2  `fnmatch` has no JS equivalent; see the local implementation
 *   §2  broad swallow: every fail-open catch is preserved
 *   §3  DIVERGENCE(port): the SPLIT routing decision, see file end
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Event, EventBus, getEventBus } from "./event_bus.js";
import { evaluateCommand } from "./path_policy.js";

export type JsonDict = Record<string, unknown>;

/**
 * Tools that mutate the filesystem, mapped to the arg keys carrying targets.
 * `paths` is a list; `path` / `src` / `dst` are single strings.
 */
export const WRITE_TOOLS: ReadonlyMap<string, readonly string[]> = new Map([
  ["write_file", ["path"]],
  ["edit_file", ["path"]],
  ["delete_file", ["path"]],
  ["move_file", ["src", "dst"]],
  ["copy_file", ["dst"]],
  ["convert_file", ["output_path", "dst"]],
]);

/**
 * Command-running tools. `text` args carry a command line whose absolute paths
 * get blacklist-checked; `dir` args are real directories and get the full
 * workspace fence.
 */
export const COMMAND_TOOLS: ReadonlyMap<string, { text: readonly string[]; dir: readonly string[] }> =
  new Map([
    ["shell_executor", { text: ["command"], dir: ["cwd"] }],
    ["python_executor", { text: ["code"], dir: ["cwd"] }],
    ["native_action_chain", { text: ["commands"], dir: ["cwd"] }],
  ]);

/** Always-forbidden roots (extended from the config blacklist at mount time). */
export const DEFAULT_BLACKLIST: readonly string[] = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "/System",
  "/usr/bin",
  "/bin",
  "/sbin",
  "/etc",
];

/**
 * Guiding files: READONLY for the MODEL, not for the system's own merge path.
 * Basename match, case-insensitive.
 */
export const READONLY_BASENAMES: ReadonlySet<string> = new Set(["agents.md", "memory.md", "soul.md"]);

// ---------------------------------------------------------------------------
// Rule 6 — anti-tampering test write-protection.
//
// A benchmark candidate (or any agent) must NEVER edit or delete the test
// suite: rewriting the assertions is the single easiest way to inflate a score.
// These paths are hard-blocked at the highest-priority pre-tool gate, BEFORE
// the risk controller can approve them and regardless of any "confirmed" flag.
//
// ESCAPE HATCH (default DENY): set OVOLVE_ALLOW_TEST_EDITS=1, or construct
// PathGuard({allowTestEdits: true}). The env var is read at decision time so it
// can be toggled for a single process without restarting the guard.
// ---------------------------------------------------------------------------

const TEST_DIR_NAMES: ReadonlySet<string> = new Set(["tests"]);

const TEST_FILE_GLOBS: readonly string[] = [
  "*_test.py",
  "*.test.ts",
  "*.test.tsx",
  "*.spec.ts",
  "conftest.py",
  "pytest.ini",
  "vitest.config.*",
  "jest.config.*",
];

/** Marker embedded in every test-protection block reason, so callers and the audit can detect a tamper attempt unambiguously. */
export const TAMPER_MARKER = "TAMPER_DETECTED";

const ALLOW_TEST_EDITS_ENV = "OVOLVE_ALLOW_TEST_EDITS";

/** Date-scoped file pattern: anything with a YYYY-MM-DD substring. */
const DATE_PATTERN = /\d{4}-\d{2}-\d{2}/;

/**
 * Absolute paths inside a command line. Windows drive paths and POSIX paths,
 * both quoted and bare. A best-effort extractor for the loss-stop check, not a
 * shell parser — it only needs to catch an absolute path aimed at a protected
 * directory.
 *
 * RULEBOOK §2: the Python source is `re.VERBOSE`, which strips whitespace and
 * comments. JS has no such mode, so the pattern is written unrolled.
 */
const ABS_PATH_PATTERN = /["']?([A-Za-z]:[\\/][^"'\s|&;<>]*|\/[^"'\s|&;<>]+)["']?/g;

const QUOTED_PATTERN = /"([^"]*)"|'([^']*)'/g;

const ABS_LIKE = /^(?:[A-Za-z]:[\\/]|\/)/;

/**
 * Absolute-looking paths mentioned in a command line.
 *
 * Quoted first: a quoted path is the only way to write one containing spaces,
 * and `C:\Program Files\...` is exactly that case. The bare-token pass below
 * would stop at `C:\Program`.
 */
export function absPathsIn(text: string): string[] {
  if (!text || typeof text !== "string") {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(QUOTED_PATTERN.source, "g"))) {
    const s = (m[1] || m[2] || "").trim();
    if (s && ABS_LIKE.test(s)) {
      out.push(s);
    }
  }
  for (const m of text.matchAll(new RegExp(ABS_PATH_PATTERN.source, "g"))) {
    const p = m[1] as string;
    // A lone "/" or a one-character POSIX path is almost always a flag or a
    // regex, not a target. Drive paths are always kept.
    if (/^[A-Za-z]:/.test(p) || p.length > 2) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Create and return the sanctioned scratch dirs under the workspace.
 *
 * RULEBOOK §2 (broad swallow): each mkdir is fail-open — the source ignores
 * OSError so a read-only workspace still yields the paths.
 */
export function ensureWorkspaceDirs(workspaceRoot: string): { temp: string; output: string } {
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch {
    /* preserved */
  }
  const temp = path.join(workspaceRoot, "temp");
  const output = path.join(workspaceRoot, "output");
  for (const d of [temp, output]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {
      /* RULEBOOK §2 (fail-open): preserved */
    }
  }
  return { temp, output };
}

/**
 * `os.path.normcase`: lowercase and separator-normalize on Windows, identity
 * elsewhere. Node's `path` has no equivalent, so it is spelled out.
 */
function normCase(p: string): string {
  if (process.platform === "win32") {
    return p.toLowerCase().replace(/\//g, "\\");
  }
  return p;
}

/**
 * Fully resolved, comparison-ready absolute path.
 *
 * `realpath` rather than `normpath` because normpath is pure string arithmetic:
 * it happily reports `<ws>\link\x` as living inside `<ws>` even when `link` is a
 * symlink or a Windows junction pointing at `C:\Windows\System32`. That made
 * both the workspace fence and the blacklist bypassable by anyone who could
 * create a link inside the workspace — and on Windows `mklink /J` needs no
 * elevation.
 *
 * RULEBOOK §2 (missing-path handling): Python's realpath resolves as far as the
 * path exists and leaves the rest intact, so it works for targets not yet
 * created — the common case for a write. Node's `fs.realpathSync` throws on a
 * missing path, so the longest existing prefix is resolved and the remainder is
 * appended, which reproduces the same result.
 */
export function realPathInternal(p: string): string {
  const abs = path.resolve(p);
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(abs);
  } catch {
    // Walk up to the longest existing prefix.
    const parts: string[] = [];
    let cur = abs;
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        resolved = abs;
        break;
      }
      parts.unshift(path.basename(cur));
      cur = parent;
      try {
        const base = fs.realpathSync.native(cur);
        resolved = path.join(base, ...parts);
        break;
      } catch {
        continue;
      }
    }
  }
  return normCase(resolved);
}

/** Absolute, link-resolved path (relative paths resolve against the workspace). */
export function normPath(p: string, workspaceRoot: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
  return realPathInternal(abs);
}

/** True when `child` is inside `parent` (both already normalized). */
export function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  // RULEBOOK §2: Python's commonpath raises ValueError for different Windows
  // drives, which the source maps to "not contained". `path.relative` returns
  // an absolute path in that case, which the leading-separator test catches.
  if (rel === "") {
    return true;
  }
  if (path.isAbsolute(rel)) {
    return false;
  }
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Public read-side counterpart of `realPathInternal`.
 *
 * The HTTP layer reuses this exact resolution for its read whitelist, so an
 * attacker cannot exploit a resolution mismatch between the write guard and the
 * file-serving endpoint: both sides call the same realpath + normcase logic.
 * Never cache the result across an FS mutation — realpath resolves symlinks as
 * they exist now.
 */
export function realPath(p: string): string {
  return realPathInternal(p);
}

/**
 * Public containment check: `child` inside `parent` after both are resolved
 * (symlink/junction aware, case-normalized).
 *
 * Same semantics as `within`, but accepts unresolved input so callers cannot
 * forget the resolution step — that step is exactly what defeats the junction
 * escape.
 */
export function isWithin(child: string, parent: string): boolean {
  return within(realPathInternal(child), realPathInternal(parent));
}

/**
 * Whether test-file write-protection is active.
 *
 * Protection is ON unless explicitly disabled, via the instance flag or the env
 * var. The env var wins at decision time so it can be toggled per-process.
 */
function testProtectionEnabled(allowOverride = false): boolean {
  if (allowOverride) {
    return false;
  }
  const val = process.env[ALLOW_TEST_EDITS_ENV] ?? "";
  return !["1", "true", "yes", "on"].includes(val.trim().toLowerCase());
}

/**
 * `fnmatch.fnmatch` for a basename.
 *
 * RULEBOOK §2: JS has no fnmatch. Python's version translates `*` to `.*` and
 * `?` to `.`, and on Windows normalizes case — the source already lowercases
 * both sides, so the match is case-insensitive by construction.
 */
function fnmatch(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return rx.test(name);
}

/**
 * True when `resolved` (already normalized/absolute) is a test artifact.
 *
 * Catches (a) any path whose components include a directory literally named
 * `tests` and (b) any basename matching the test-file globs.
 */
export function isTestTarget(resolved: string): boolean {
  if (!resolved) {
    return false;
  }
  const norm = path.normalize(resolved);
  const parts = norm.split(/[\\/]/).filter((p) => p && p !== ".");
  const lowered = parts.map((p) => p.toLowerCase());
  if (lowered.some((d) => TEST_DIR_NAMES.has(d))) {
    return true;
  }
  const basename = parts.length ? (parts[parts.length - 1] as string).toLowerCase() : "";
  if (!basename) {
    return false;
  }
  return TEST_FILE_GLOBS.some((g) => fnmatch(basename, g.toLowerCase()));
}

/** Block reason carrying the TAMPER_DETECTED marker for the audit pipeline. */
function testBlockReason(target: string): string {
  return (
    `${TAMPER_MARKER}: refusing agent write/delete to test artifact ` +
    `\`${target}\`. Test files are protected against score tampering. ` +
    `To override (not recommended) set ${ALLOW_TEST_EDITS_ENV}=1 or ` +
    `construct PathGuard(allow_test_edits=True).`
  );
}

/** Operators that, inside a command line, imply a write to their target path. */
const WRITE_INTENT_TOKENS: readonly string[] = [">>", " >", "tee ", "sed -i", "2>", "| tee", "1>"];

/**
 * Best-effort detection of a command that writes into a test artifact.
 *
 * Used by the command-running tools, which were previously outside the
 * file-tool gate. A token is flagged only when it both (a) resolves to a
 * protected test path and (b) is accompanied by an explicit write intent, so
 * reads like `cat tests/x` or `pytest tests/` are NOT blocked.
 */
function commandWritesTest(text: string, workspaceRoot: string, allowTestEdits: boolean): string | null {
  if (!testProtectionEnabled(allowTestEdits)) {
    return null;
  }
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  if (!WRITE_INTENT_TOKENS.some((tok) => text.includes(tok))) {
    return null;
  }

  const candidates = new Set<string>(absPathsIn(text));
  for (const m of text.matchAll(new RegExp(QUOTED_PATTERN.source, "g"))) {
    const s = (m[1] || m[2] || "").trim();
    if (s) {
      candidates.add(s);
    }
  }
  for (const tok of text.match(/[^\s"'>|&;()]+/g) ?? []) {
    if (tok.includes("/") || tok.includes("\\") || tok.includes(".")) {
      candidates.add(tok);
    }
  }
  for (const c of candidates) {
    let resolved: string;
    try {
      resolved = normPath(c, workspaceRoot);
    } catch {
      continue;
    }
    if (isTestTarget(resolved)) {
      return c;
    }
  }
  return null;
}

/** Enforce workspace isolation for file-mutating tools. */
export class PathGuard {
  /** Above the remote decorator (200) and the risk controller (100). */
  static readonly PRIORITY = 300;

  blacklist: string[];
  allowTestEdits: boolean;
  blockCount = 0;

  private _bus: EventBus | null = null;
  /**
   * RULEBOOK §2 (module-level mutable state): the source passes the bound method
   * `self._on_pre_tool_use` to both `on` and `off`, and Python's bound methods
   * compare equal for the same instance, so `off` finds the registration. In JS
   * an arrow function is a fresh object every time, so `off` would silently fail
   * to unsubscribe and `unmount` would leave the guard live. The reference is
   * held instead.
   */
  private _handler: (e: Event) => void = (e) => this._onPreToolUse(e);

  constructor(opts: { blacklist?: readonly string[] | null; allowTestEdits?: boolean } = {}) {
    this.blacklist = [...DEFAULT_BLACKLIST];
    if (opts.blacklist) {
      this.blacklist.push(...opts.blacklist);
    }
    this.allowTestEdits = Boolean(opts.allowTestEdits);
  }

  mount(bus?: EventBus | null): void {
    this._bus = bus ?? getEventBus();
    this._bus.on("pre_tool_use", this._handler, PathGuard.PRIORITY);
  }

  unmount(): void {
    if (this._bus) {
      this._bus.off("pre_tool_use", this._handler);
    }
  }

  /** The offending blacklist root if `target` is inside one, else null. */
  _blacklisted(target: string): string | null {
    for (const root of this.blacklist) {
      if (!root) {
        continue;
      }
      if (within(target, realPathInternal(root))) {
        return root;
      }
    }
    return null;
  }

  /** Workspace root plus the sanctioned scratch dirs, all link-resolved. */
  _allowedRoots(workspaceRoot: string): string[] {
    const allowed = [realPathInternal(workspaceRoot)];
    const dirs = ensureWorkspaceDirs(workspaceRoot);
    allowed.push(realPathInternal(dirs.temp), realPathInternal(dirs.output));
    return allowed;
  }

  /**
   * Rule 5: the loss-stop for tools that run commands.
   *
   * These tools were entirely outside the guard: `WRITE_TOOLS.get(name)`
   * returned undefined for them and the handler returned immediately, so every
   * rule above could be sidestepped by asking for a shell command instead of a
   * write.
   */
  _checkCommandTool(
    toolName: string,
    args: JsonDict,
    workspaceRoot: string,
    event: Event,
    context: JsonDict = {}
  ): void {
    const spec = COMMAND_TOOLS.get(toolName);
    if (!spec) {
      return;
    }

    for (const key of spec.dir) {
      const raw = args[key];
      if (typeof raw !== "string" || !raw.trim()) {
        continue;
      }
      const resolved = normPath(raw, workspaceRoot);
      if (!this._allowedRoots(workspaceRoot).some((root) => within(resolved, root))) {
        const perm = context["permission"];
        if (context["confirmed"] || ["full", "yolo", "never", "full_access"].includes(perm as string)) {
          continue;
        }
        this.blockCount += 1;
        event.block(
          `Refused: \`${toolName}\` targets directory \`${raw}\` outside allowed workspace roots.\n` +
            `如需授权在该外部路径执行，请把该目录加入工作区白名单 (allowed_paths)。`
        );
        return;
      }
    }

    const texts: string[] = [];
    for (const key of spec.text) {
      const val = args[key];
      if (typeof val === "string") {
        texts.push(val);
      } else if (Array.isArray(val)) {
        texts.push(...val.filter((v): v is string => typeof v === "string"));
      }
    }

    // Rule 6: a command that writes into a test artifact is a tamper attempt.
    for (const text of texts) {
      const offending = commandWritesTest(text, workspaceRoot, this.allowTestEdits);
      if (offending) {
        this.blockCount += 1;
        event.block(testBlockReason(offending));
        return;
      }
    }

    for (const text of texts) {
      // 1. Literal mention of a protected root. Catches the forms the extractor
      //    cannot tokenise, above all an unquoted path with a space in it
      //    (`copy x C:\Program Files\y`).
      const low = text.toLowerCase();
      for (const root of this.blacklist) {
        if (root && low.includes(root.toLowerCase())) {
          this.blockCount += 1;
          event.block(
            `Refused: \`${toolName}\` names a protected system location ` +
              `(${root}). Commands that touch system directories are blocked ` +
              `regardless of intent — do the work inside the workspace.`
          );
          return;
        }
      }
      // 2. Resolved check, so `C:/Windows/...`, trailing `..` and case
      //    differences land on the same verdict.
      for (const candidate of absPathsIn(text)) {
        const offending = this._blacklisted(realPathInternal(candidate));
        if (offending) {
          this.blockCount += 1;
          event.block(
            `Refused: \`${toolName}\` names a protected system location ` +
              `(${offending}) in \`${candidate}\`. Commands that touch system ` +
              `directories are blocked regardless of intent — do the work ` +
              `inside the workspace.`
          );
          return;
        }
      }
    }

    // Path policy (sandbox-policy.yaml): finer-grained than the blacklist, and
    // it sees redirections (`echo x > ..`) that the extractor above only flags
    // when they are already absolute and blacklisted.
    let cwd = workspaceRoot;
    for (const key of spec.dir) {
      const raw = args[key];
      if (typeof raw === "string" && raw.trim()) {
        cwd = raw;
        break;
      }
    }
    try {
      for (const text of texts) {
        const verdict = evaluateCommand(text, { cwd, workspaceRoot });
        if (!verdict.allowed) {
          this.blockCount += 1;
          event.block(verdict.reason);
          return;
        }
      }
    } catch {
      // RULEBOOK §2 (broad swallow, fail-open): preserved — a policy-loading
      // failure must not stop the guard from applying its own rules.
    }
  }

  _onPreToolUse(event: Event): void {
    const toolName = (event.payload["tool_name"] as string) ?? "";
    const args = (event.payload["args"] as JsonDict) ?? {};
    const context = (event.payload["context"] as JsonDict) ?? {};
    const workspaceRoot = (context["workspace_root"] as string) || process.cwd();

    if (COMMAND_TOOLS.has(toolName)) {
      this._checkCommandTool(toolName, args, workspaceRoot, event, context);
      return;
    }

    const keys = WRITE_TOOLS.get(toolName);
    if (!keys) {
      return;
    }
    const allowed = this._allowedRoots(workspaceRoot);

    const targets: string[] = [];
    for (const key of keys) {
      const val = args[key];
      if (typeof val === "string" && val) {
        targets.push(val);
      }
    }
    // write_file / git_add style: a `paths` list.
    if (Array.isArray(args["paths"])) {
      targets.push(...(args["paths"] as unknown[]).filter((p): p is string => typeof p === "string"));
    }

    for (const raw of targets) {
      const resolved = normPath(raw, workspaceRoot);

      // Rule 6: hard-block agent writes/deletes to test artifacts. Checked first
      // and unconditionally — no "confirmed" / permission escape, because
      // rewriting the test suite is exactly how a candidate fakes a pass.
      if (testProtectionEnabled(this.allowTestEdits) && isTestTarget(resolved)) {
        this.blockCount += 1;
        event.block(testBlockReason(raw));
        return;
      }

      const offending = this._blacklisted(resolved);
      if (offending) {
        this.blockCount += 1;
        event.block(
          `Refused: \`${toolName}\` targets a protected system location ` +
            `(${offending}). This is never a safe write target.`
        );
        return;
      }

      if (!allowed.some((root) => within(resolved, root))) {
        const perm = context["permission"];
        if (context["confirmed"] || ["full", "yolo", "never", "full_access"].includes(perm as string)) {
          continue;
        }
        this.blockCount += 1;
        event.block(
          `Refused: \`${toolName}\` targets \`${raw}\` outside allowed workspace roots.\n` +
            `如需授权写入该外部路径，请把该目录加入工作区白名单 (allowed_paths)。`
        );
        return;
      }

      // Rule 3: guiding files are readonly for the model.
      const basename = path.basename(resolved).toLowerCase();
      if (READONLY_BASENAMES.has(basename) && !context["allow_guiding_write"]) {
        this.blockCount += 1;
        event.block(
          `Refused: \`${basename}\` is a guiding file maintained by the ` +
            `memory layer. The model must not overwrite it directly — use ` +
            `the memory tools or let the extraction pipeline manage it.`
        );
        return;
      }

      // Rule 4: date-scoped files are append-only.
      if (toolName === "write_file" && DATE_PATTERN.test(path.basename(raw))) {
        const newContent = (args["content"] as string) || "";
        if (newContent && isFile(resolved)) {
          let existing = "";
          try {
            existing = fs.readFileSync(resolved, "utf8");
          } catch {
            // RULEBOOK §2: preserved — an unreadable file yields "" and the
            // append check passes, matching the source.
            existing = "";
          }
          if (existing && !newContent.startsWith(existing)) {
            this.blockCount += 1;
            event.block(
              `Refused: \`${path.basename(raw)}\` is a date-scoped ` +
                `journal file. It is append-only — new content must ` +
                `start with the existing body. Use edit_file to ` +
                `append instead of write_file to overwrite.`
            );
            return;
          }
        }
      }
    }
  }

  getStats(): JsonDict {
    return { blocks: this.blockCount };
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

let _guard: PathGuard | null = null;

export function getPathGuard(): PathGuard {
  if (_guard === null) {
    _guard = new PathGuard();
  }
  return _guard;
}

export function initPathGuard(opts: { blacklist?: readonly string[] | null; allowTestEdits?: boolean } = {}): PathGuard {
  _guard = new PathGuard(opts);
  _guard.mount();
  return _guard;
}

/**
 * DIVERGENCE(port): this unit is routed SPLIT (shell to TS, core to Rust).
 * The core the line-count rule found here is `realPathInternal`, `normPath`,
 * `within`, `absPathsIn` and `isTestTarget` — five small functions over
 * strings. Each call would cross an FFI boundary and back for work measured
 * in microseconds, and `within` runs once per allowed root per target, so a
 * single write would make several crossings. Kept as one TS module:
 * equivalent because these are pure string predicates whose behaviour is
 * fully defined by the translation already in this file — the Rust side would
 * be the same algorithm, so there is no observable difference to gain, only
 * boundary cost to pay. Decided per AMEND-07.
 */
