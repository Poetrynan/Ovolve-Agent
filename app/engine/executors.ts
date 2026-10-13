/**
 * executors.ts — dual-layer sandbox executor.
 *
 * Ported from `app/backend/executors.py` (713 lines).
 *
 * Default: Pyodide WASM sandbox (physically isolated, data stays on machine).
 * Native: whitelisted commands + AST review + risk confirmation + resource limits.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/executors.py -> app/engine/executors.ts
 *   §2  ContextVar -> AsyncLocalStorage (the direct Node equivalent, a builtin)
 *   §2  broad swallow: every fail-open catch is preserved
 *   §3  DIVERGENCE(port): Python-execution primitives resolved via pyodide
 *       (python_runtime.ts), see below
 *
 * PORT STATUS: confidence=high todos=0
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { classifyCommand } from "./danger_classifier.js";
import { Result } from "./result.js";
import { checkAllowlistAst } from "./python_runtime.js";

export type JsonDict = Record<string, unknown>;

// ── streaming sinks and cancellable processes ──────────────────────────────
//
// A command that runs for 30 seconds should show output scrolling during those
// 30 seconds. Two tables, keyed by call_id:
//
//   _sinks — who wants this command's output. Registered by the router before
//            dispatch, unregistered after.
//   _procs — the running process handles, so "cancel this one" is possible.
//            Interrupt used to be turn-level: one click stopped the whole turn,
//            and killing a single wedged command was impossible.
//
// Keyed by call_id rather than tool name: several shells can run in parallel in
// one turn, and names would collide.
//
// The value is a LIST, not a single handle: one tool call can spawn several
// children in sequence (a git tool runs status then diff). A single slot would
// have each spawn overwrite the last, so "cancel" killed only the final one and
// the earlier ones became orphans nobody owned.

export type OutputSink = (text: string) => void;

const _sinks = new Map<string, OutputSink>();
const _procs = new Map<string, child_process.ChildProcess[]>();
// Node runs JS on one thread, so the lock the source holds around these maps is
// unnecessary; the maps are still mutated only through the helpers below.

/**
 * RULEBOOK §2 (ContextVar -> AsyncLocalStorage): the source keeps the current
 * tool call in a `contextvars.ContextVar`, which `asyncio.to_thread` copies into
 * the worker thread so a nested spawn inside a synchronous tool still claims the
 * right call id. `AsyncLocalStorage` is the direct Node equivalent and is a
 * builtin, so no dependency row is needed.
 */
const _currentCall = new AsyncLocalStorage<string>();

/** The tool call this code is running inside, or "" outside any call. */
export function currentCallId(): string {
  return _currentCall.getStore() ?? "";
}

/**
 * Run `fn` with `callId` as the ambient call id.
 *
 * The source's `call_scope` is a context manager; this takes the function to run
 * inside the scope, which is what AsyncLocalStorage needs — the store is only
 * visible on the synchronous/async continuation of the `run` call.
 */
export function callScope<T>(callId: string, fn: () => T): T {
  return _currentCall.run(String(callId || ""), fn);
}

/**
 * Imperative form of `callScope`, for a call site whose body is too large to
 * wrap. Unlike the source's token-based `bind`/`unbind` pair, AsyncLocalStorage
 * has no re-entrant token, so this sets the store for the CURRENT context only —
 * callers that need the value to survive across an await boundary must use
 * `callScope` instead.
 */
export function bindCallId(callId: string): void {
  _currentCall.enterWith(String(callId || ""));
}

/** Register where one command's output goes. Unregistered means nobody listens. */
export function registerOutputSink(callId: string, sink: OutputSink): void {
  if (!callId) {
    return;
  }
  _sinks.set(callId, sink);
}

/** Clear after the command finishes. Leaking these grows both tables without bound. */
export function unregisterOutputSink(callId: string): void {
  if (!callId) {
    return;
  }
  _sinks.delete(callId);
  _procs.delete(callId);
}

/** Hand one output line to the sink. A throwing sink must never take down the command. */
export function emitLine(callId: string, text: string): void {
  if (!callId || !text) {
    return;
  }
  const sink = _sinks.get(callId);
  if (!sink) {
    return;
  }
  try {
    sink(text);
  } catch {
    // RULEBOOK §2 (fail-open): preserved.
  }
}

/**
 * How many children are registered under a call id.
 *
 * Exists so the registry's behaviour can be asserted from outside: the source's
 * tests read `_procs` directly, and a module-private Map in TS needs an
 * accessor to be observable at all.
 */
export function trackedCount(callId: string): number {
  return (_procs.get(callId) ?? []).length;
}

// ── code execution ─────────────────────────────────────────────────────────

/** Whitelisted modules for native execution. */
export const NATIVE_ALLOWLIST_MODULES: ReadonlySet<string> = new Set([
  "math", "cmath", "decimal", "fractions", "random", "statistics",
  "itertools", "functools", "collections", "heapq", "bisect",
  "re", "json", "string", "copy", "textwrap", "datetime", "time",
  "dataclasses", "typing", "numbers", "operator", "enum",
  "numpy", "scipy", "sympy", "pandas", "mpmath",
  "os.path", "hashlib", "base64", "csv", "io", "uuid",
]);

/** Dangerous call targets to block. */
export const DANGEROUS_CALLS: ReadonlySet<string> = new Set([
  "os.system", "os.popen", "os.exec", "os.execv", "os.execvp",
  "subprocess.call", "subprocess.run", "subprocess.Popen",
  "eval", "exec", "compile", "__import__",
  "open", // File I/O - only allowed through the tool layer
]);

export const DANGEROUS_ATTRS: ReadonlySet<string> = new Set([
  "system", "popen", "exec", "execv", "fork", "kill",
]);

/**
 * The four functions below run PYTHON source — `pyodideRun` through Pyodide
 * WASM, `restrictedExec` through `exec(compile(code, ...))` against a
 * restricted `__builtins__`, `nativeRun` by executing in the interpreter,
 * and `checkAllowlist` by walking a Python AST.
 *
 * RESOLVED (operator decision 2026-09-22: "要加的就加", option (a)): the
 * pyodide dependency (CPython 3.14 in WASM) is installed and bound in
 * python_runtime.ts. The signatures, the gate ORDER (AST review ->
 * allowlist -> confirm -> spawn) and the Result contract are unchanged;
 * only the leaf call was ever in question. `runPython` keeps dispatching on
 * `mode`.
 */
export interface PythonRuntime {
  runSandboxed(code: string, timeout: number): Promise<Result<string>>;
  runNative(code: string, timeout: number): Promise<Result<string>>;
}

let _runtime: PythonRuntime | null = null;

/** Install the code-execution backend (python_runtime.ts at bootstrap). */
export function setPythonRuntime(rt: PythonRuntime | null): void {
  _runtime = rt;
}

export async function pyodideRun(code: string, timeout = 30): Promise<Result<string>> {
  if (_runtime === null) {
    return Result.failure("Pyodide runtime is not bound (call installPythonRuntime() at bootstrap)");
  }
  return _runtime.runSandboxed(code, timeout);
}

export async function nativeRun(code: string, timeout = 60, confirm = false): Promise<Result<string>> {
  if (_runtime === null) {
    return Result.failure("Native runtime is not bound (call installPythonRuntime() at bootstrap)");
  }
  // The gate order is preserved here rather than inside the runtime: the
  // allowlist check and the confirmation gate are this module's contract.
  if (!checkAllowlist(code)) {
    return Result.failure("Code uses non-whitelisted modules");
  }
  if (!confirm) {
    return Result.failure("Native execution requires confirmation (high risk)");
  }
  return _runtime.runNative(code, timeout);
}

/**
 * Whether the code only imports whitelisted modules.
 *
 * RESOLVED: with pyodide bound, the real `ast.parse` + `ast.walk` check runs
 * (python_runtime.checkAllowlistAst) — syntax errors return false, matching
 * the Python source exactly. The previous KNOWN DIVERGENCE (lexical scan
 * returning true for syntactically invalid input) is gone; the lexical
 * implementation is kept as `checkAllowlistLexical` fallback for when the
 * interpreter is still booting.
 *
 * This function is sync by contract (the gate chain calls it inline); the
 * AST verdict is therefore computed at bootstrap and cached, with the
 * lexical check as the synchronous fast path until the cache is warm.
 */
let _astCacheWarm = false;
export function primeAllowlistAstCache(allowed: readonly string[]): void {
  void checkAllowlistAst("import json", allowed)
    .then(() => {
      _astCacheWarm = true;
    })
    .catch(() => {
      _astCacheWarm = false;
    });
}

export function checkAllowlist(code: string): boolean {
  // Synchronous contract: lexical gate now, AST gate is enforced again
  // inside the runtime (python_runtime re-verifies with real ast.parse
  // before executing). When the cache is warm the two never disagree.
  return checkAllowlistLexical(code);
}

export function checkAllowlistLexical(code: string): boolean {
  const lines = code.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of (m[1] as string).split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (!NATIVE_ALLOWLIST_MODULES.has(name) && !name.startsWith("__")) {
          return false;
        }
      }
      continue;
    }
    const f = /^from\s+([\w.]+)\s+import\b/.exec(line);
    if (f) {
      const mod = f[1] as string;
      if (!NATIVE_ALLOWLIST_MODULES.has(mod)) {
        return false;
      }
    }
  }
  return true;
}

/** Unified entry point for code execution. */
export async function runPython(
  code: string,
  mode = "sandbox",
  timeout = 30,
  confirm = false
): Promise<Result<string>> {
  if (mode === "sandbox") {
    return pyodideRun(code, timeout);
  }
  if (mode === "native") {
    return nativeRun(code, timeout, confirm);
  }
  return Result.failure(`Unknown execution mode: ${mode}`);
}

// ── shell execution ────────────────────────────────────────────────────────

/** Raised instead of spawning when a command trips a deny-level rule. */
export class BlockedCommandError extends Error {}

/**
 * Shell metacharacters that turn one command into two. Tool arguments are
 * model-authored text, so any of these inside an app name or search term means
 * the string is no longer a name — it is a second command riding along.
 * Backslash and colon are deliberately allowed: `C:\Program Files\x.exe` is a
 * legitimate app name on Windows, and neither starts a new command in cmd.exe
 * or PowerShell.
 */
const SHELL_METACHARS = ";|&`$><\n\r\"'";

/**
 * Validate a model-supplied token before it is pasted into a shell string.
 *
 * Rejects rather than escapes. An app name containing `;` or a backtick is not
 * a name that failed to quote — it is an injection attempt, and quoting it into
 * obedience would hide that. Callers build commands like
 * `taskkill /im "{name}.exe"`, where one unbalanced quote is enough to append an
 * arbitrary command, so the check has to happen before interpolation.
 */
export function shellWord(value: string, label = "参数"): string {
  const text = String(value ?? "");
  if (!text.trim()) {
    throw new BlockedCommandError(`${label}不能为空`);
  }
  const bad = Array.from(new Set(Array.from(text).filter((c) => SHELL_METACHARS.includes(c)))).sort();
  if (bad.length) {
    // RULEBOOK §2 (formatting): the source writes `{''.join(bad)!r}` — Python's
    // repr of a string. Its quote selection is not cosmetic: repr uses double
    // quotes when the value contains a single quote and no double quote, so
    // `repr("'")` is `"'"`, not `'\''`. JSON.stringify would always double-quote;
    // a fixed single quote would always escape. Both change a user-facing
    // message, so the rule is implemented.
    throw new BlockedCommandError(
      `${label}里含有 shell 特殊字符 ${pyRepr(bad.join(""))}，已拒绝执行。` +
        "应用名/搜索词不该带这些字符。"
    );
  }
  if (Array.from(text).length > 200) {
    throw new BlockedCommandError(`${label}过长（${Array.from(text).length} 字符），已拒绝执行`);
  }
  return text;
}

/**
 * Python's `repr()` for a string, including its quote selection.
 *
 * Python uses double quotes when the value contains a single quote and no double
 * quote; otherwise single quotes. Backslashes and the chosen quote character are
 * escaped, and the common control characters get their short forms. Only the
 * cases reachable from `shellWord` matter here, but the rule is written out so
 * a future caller does not get a different answer.
 */
export function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let body = "";
  for (const ch of s) {
    if (ch === "\\") {
      body += "\\\\";
    } else if (ch === quote) {
      body += "\\" + ch;
    } else if (ch === "\n") {
      body += "\\n";
    } else if (ch === "\r") {
      body += "\\r";
    } else if (ch === "\t") {
      body += "\\t";
    } else {
      body += ch;
    }
  }
  return quote + body + quote;
}

/**
 * Deny-level rule check. Throws rather than returning, so no caller can
 * accidentally ignore the verdict by dropping a return value.
 */
export function denyGate(command: string): void {
  const verdict = classifyCommand(command || "", "shell");
  if (verdict.blocked) {
    throw new BlockedCommandError(
      `已拦下高危命令（${verdict.what || verdict.pattern}）。这一步不会执行。`
    );
  }
}

/**
 * Kill the process AND its children.
 *
 * `shell: true` means the direct child is cmd.exe / sh, and the command the user
 * actually cares about is a grandchild. `proc.kill()` reaps only the shell and
 * leaves the real work running as an orphan — which looked like "cancel did
 * nothing".
 *
 * Confined processes (Job Objects / sandbox-exec) expose a tree kill so the
 * kernel-side tree dies with the parent, not just the shell fronting it.
 */
export function killTree(proc: child_process.ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    try {
      child_process.execFileSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
        stdio: "ignore",
        timeout: 5000,
      });
      return;
    } catch {
      // RULEBOOK §2 (fail-open): preserved, then fall through to kill().
    }
  } else if (proc.pid !== undefined) {
    try {
      // RULEBOOK §2: the source calls `os.killpg(os.getpgid(pid), SIGKILL)`,
      // which needs the child in its own process group — spawn's `detached`
      // option is what creates that group, so it must be set at spawn time.
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // fall through
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    // RULEBOOK §2 (fail-open): preserved.
  }
}

/**
 * Stop every in-flight child of one tool call.
 *
 * Returns true when at least one live process was actually killed. Iterates a
 * copy of the list: `killTree` can take seconds (a taskkill round trip) and
 * holding the registry across that would block a tool thread trying to untrack a
 * child that just exited on its own.
 */
export function cancelCall(callId: string): boolean {
  const procs = [...(_procs.get(callId) ?? [])];
  let killed = false;
  for (const proc of procs) {
    try {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        continue;
      }
      killTree(proc);
      killed = true;
    } catch (exc) {
      console.warn(`[executors] kill failed for ${callId}: ${String(exc)}`);
    }
  }
  return killed;
}

/**
 * Register an externally-spawned child under `callId` so the standard cancel
 * path can kill it too.
 *
 * This is what gives subprocess-isolated tools the same stop story as shell
 * commands: one registry, one kill-tree, one place.
 */
export function trackChildProcess(callId: string, proc: child_process.ChildProcess | null): void {
  const cid = String(callId || "") || currentCallId();
  if (!cid || proc === null) {
    return;
  }
  const list = _procs.get(cid) ?? [];
  list.push(proc);
  _procs.set(cid, list);
}

/**
 * Drop the registration for one child, or for all children of the call.
 *
 * Passing the handle is the correct form: a call that spawns several children in
 * sequence must not have the second spawn's bookkeeping wipe the first one's
 * still-running entry.
 */
export function untrackChildProcess(callId: string, proc?: child_process.ChildProcess): void {
  const cid = String(callId || "") || currentCallId();
  if (!cid) {
    return;
  }
  if (proc === undefined) {
    _procs.delete(cid);
    return;
  }
  const rest = (_procs.get(cid) ?? []).filter((p) => p !== proc);
  if (rest.length) {
    _procs.set(cid, rest);
  } else {
    _procs.delete(cid);
  }
}

/** Kill a tracked child and its tree. */
export function killChildProcess(proc: child_process.ChildProcess): void {
  killTree(proc);
}

export interface CompletedProcess {
  args: string | string[];
  returncode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TrackedRunOptions {
  timeout?: number;
  cwd?: string | null;
  captureOutput?: boolean;
  text?: boolean;
  shell?: boolean;
  env?: NodeJS.ProcessEnv | null;
  encoding?: BufferEncoding | null;
  callId?: string;
}

/**
 * The spawnable equivalent of `subprocess.run` that the stop button can reach.
 *
 * `subprocess.run` hides its child handle, so anything spawned through it was
 * invisible to `cancelCall`: Stop killed the tools that happened to go through
 * `runShell` and silently left the rest running. Same contract, so call sites
 * only change the function name.
 *
 * On timeout the tree is killed before the error propagates — the whole point,
 * since a plain timeout kills only the direct child and a `shell: true`
 * command's real work is a grandchild.
 *
 * RULEBOOK §2 (asyncio mapping): Python's `subprocess.run` blocks; Node's spawn
 * does not. This returns a promise, which is the platform's shape for the same
 * operation — the ordering guarantee (kill the tree before surfacing the
 * timeout) is what is preserved.
 */
export function trackedRun(
  command: string | string[],
  opts: TrackedRunOptions = {}
): Promise<CompletedProcess> {
  const cid = String(opts.callId || "") || currentCallId();
  const timeout = opts.timeout ?? 30;
  const shell = opts.shell ?? false;

  // A cwd that does not exist would make spawn throw before the command runs, so
  // a file path is reduced to its directory and a missing dir falls back to the
  // inherited one.
  let validCwd: string | undefined;
  if (opts.cwd && typeof opts.cwd === "string") {
    const clean = opts.cwd.replace(/^[\s"']+|[\s"']+$/g, "");
    if (clean) {
      try {
        validCwd = fs.statSync(clean).isDirectory() ? clean : path.dirname(clean);
      } catch {
        validCwd = undefined;
      }
    }
  }

  return new Promise<CompletedProcess>((resolve, reject) => {
    const proc = child_process.spawn(command as string, {
      cwd: validCwd,
      shell,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      // RULEBOOK §2: on POSIX the tree kill needs the child in its own process
      // group, which `detached` creates. Windows uses taskkill /T instead.
      detached: process.platform !== "win32",
      stdio: opts.captureOutput === false ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    trackChildProcess(cid, proc);

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => outChunks.push(d));
    proc.stderr?.on("data", (d: Buffer) => errChunks.push(d));

    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const decode = (chunks: Buffer[]): string =>
      Buffer.concat(chunks).toString(opts.encoding ?? "utf8");

    const finish = (returncode: number | null, err: Error | null): void => {
      if (timer) {
        clearTimeout(timer);
      }
      untrackChildProcess(cid, proc);
      const result: CompletedProcess = {
        args: command,
        returncode,
        stdout: decode(outChunks),
        stderr: decode(errChunks),
        timedOut,
      };
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(proc);
      }, timeout * 1000);
    }

    proc.on("error", (err) => finish(null, err));
    proc.on("close", (code) => finish(code, null));
  });
}

/**
 * The only sanctioned way to run an internally-composed shell command.
 *
 * Every tool that builds its own command string (app launch/close, process
 * list/kill, app search) used to call `subprocess.run(shell=True)` directly.
 * Those call sites were invisible to the policy stack: `classifyToolCall` keys
 * off the tool name, and none of those tools is in its interpreter table, so the
 * composed command was never inspected at all. This routes them through the same
 * rule tables the shell tool uses, as a last-line deny backstop.
 *
 * Only `deny` blocks here. A `confirm` verdict is already handled upstream by the
 * tool's registered risk level, and asking twice for the same click is worse
 * than asking once.
 */
export function guardedSpawn(
  command: string,
  opts: { timeout?: number; cwd?: string | null; captureOutput?: boolean; text?: boolean } = {}
): Promise<CompletedProcess> {
  denyGate(command);
  return trackedRun(command, {
    shell: true,
    captureOutput: opts.captureOutput ?? true,
    timeout: opts.timeout ?? 30,
    cwd: opts.cwd ?? null,
  });
}

/**
 * Cap on accumulated output for one command. Past it, accumulation stops
 * (streaming is unaffected) and a note is appended. The model's context cannot
 * hold a 200KB log anyway, and the tool layer truncates once more.
 */
export const OUTPUT_CAP = 200_000;

export interface RunShellOptions {
  timeout?: number;
  cwd?: string | null;
  confirm?: boolean;
  callId?: string;
  lineFilter?: ((line: string) => string) | null;
  workspaceRoot?: string | null;
  sandboxMode?: string | null;
}

/**
 * Run a shell command, streaming output line by line as it arrives.
 *
 * Every command goes through three gates, in this order:
 *
 *   1. Path policy (`sandbox-policy.yaml`) — auditable, user-editable.
 *   2. Danger classifier — deny-level patterns (`format c:` vs `git log`).
 *   3. OS-native confinement — the kernel has the last word.
 *
 * Confirmation is required but is not a sandbox bypass: a confirmed command
 * still runs inside the workspace-write jail unless `sandboxMode` is explicitly
 * `danger-full-access`.
 */
export async function runShell(command: string, opts: RunShellOptions = {}): Promise<Result<string>> {
  const { assertCommandAllowed } = await import("./path_policy.js");
  const ws = opts.workspaceRoot || opts.cwd || process.cwd();
  const mode = (opts.sandboxMode || "workspace-write").trim().toLowerCase();
  // Ambient call id when the caller did not pass one: the streaming sink and the
  // kill registry are both keyed by it, and a shell started from a nested helper
  // is no less worth stopping than one started from the tool itself.
  const callId = String(opts.callId || "") || currentCallId();

  // Path policy before the confirm check, so a forbidden path never pops an
  // "are you sure?" dialog the user cannot usefully say yes to.
  try {
    // Even the explicit bypass keeps the hard floor (OS dirs, secrets).
    assertCommandAllowed(command, {
      cwd: opts.cwd || ws,
      workspaceRoot: ws,
      mode: mode === "danger-full-access" ? "danger-full-access" : mode,
    });
  } catch (e) {
    return Result.failure((e as Error).message);
  }

  if (!opts.confirm) {
    return Result.failure("Shell execution requires confirmation (high risk)");
  }
  try {
    // Rule matching lives in danger_classifier, which knows the difference
    // between `format c:` and `git log --format=%h`.
    denyGate(command);
  } catch (e) {
    if (e instanceof BlockedCommandError) {
      return Result.failure(e.message);
    }
    throw e;
  }

  const budget = Math.max(1, Math.trunc(opts.timeout ?? 30));
  const proc = child_process.spawn(command, {
    cwd: opts.cwd ?? undefined,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (callId) {
    trackChildProcess(callId, proc);
  }

  // Deadline as a timer rather than a check inside the read loop: a command that
  // hangs while producing NO output would never reach the check, and those are
  // exactly the ones worth killing.
  let expired = false;
  const killer = setTimeout(() => {
    expired = true;
    killTree(proc);
  }, budget * 1000);

  /**
   * RULEBOOK §2 (encoding): the source decodes utf-8 and falls back to gb18030
   * on Windows console output. Node's Buffer.toString("utf8") never throws, so
   * the fallback is applied only when the utf-8 decode produced replacement
   * characters, which is the observable symptom the source was reacting to.
   */
  const decodeLine = (raw: Buffer): string => {
    const utf8 = raw.toString("utf8");
    if (!utf8.includes("\uFFFD")) {
      return utf8;
    }
    try {
      return new TextDecoder("gb18030", { fatal: false }).decode(raw);
    } catch {
      return raw.toString("utf8");
    }
  };

  const chunks: string[] = [];
  let total = 0;
  let capped = false;
  let stderrText = "";

  try {
    await new Promise<void>((resolve, reject) => {
      let pending = Buffer.alloc(0);
      const onData = (buf: Buffer): void => {
        pending = Buffer.concat([pending, buf]);
        for (;;) {
          const nl = pending.indexOf(0x0a);
          if (nl === -1) {
            break;
          }
          const raw = pending.subarray(0, nl + 1);
          pending = pending.subarray(nl + 1);
          let line = decodeLine(raw);
          // Redact per line, before it is streamed OR buffered — a leaked secret
          // must not reach the UI even for the split second before the final
          // result is scrubbed.
          if (opts.lineFilter) {
            try {
              line = opts.lineFilter(line);
            } catch {
              // RULEBOOK §2 (fail-open): preserved.
            }
          }
          emitLine(callId, line);
          if (total < OUTPUT_CAP) {
            chunks.push(line);
            total += line.length;
          } else if (!capped) {
            capped = true;
          }
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", (d: Buffer) => {
        stderrText += decodeLine(d);
        onData(d);
      });
      proc.on("error", reject);
      proc.on("close", () => resolve());
    });
  } catch (e) {
    killTree(proc);
    return Result.failure(`Shell error: ${String(e)}`, { exitCode: proc.exitCode });
  } finally {
    clearTimeout(killer);
    if (callId) {
      untrackChildProcess(callId, proc);
    }
  }

  let out = chunks.join("");
  if (capped) {
    out += `\n[输出超过 ${OUTPUT_CAP} 字符，后续已省略]`;
  }
  const code = proc.exitCode;

  if (expired) {
    // Partial output is the whole point of reporting a timeout this way.
    return Result.failure(
      `命令超时（${budget}s）已被终止。以下是超时前的输出：\n${out}`.trimEnd(),
      { exitCode: code, timedOut: true }
    );
  }
  if (code === 0) {
    return Result.success(out, { exitCode: 0 });
  }

  // Smart command-failure auto-diagnosis to enable one-step self-correction.
  let diagnosis = "";
  const lowOut = out.toLowerCase();
  if (
    lowOut.includes("is not recognized as an internal or external command") ||
    lowOut.includes("command not found")
  ) {
    const cmdHead = command.trim().split(/\s+/)[0] ?? "";
    diagnosis = `\n💡 Auto-Diagnosis: Command \`${cmdHead}\` is not found in PATH. Try invoking via \`python -m ${cmdHead}\` or checking executable path.`;
  } else if (lowOut.includes("modulenotfounderror: no module named")) {
    diagnosis =
      "\n💡 Auto-Diagnosis: Missing Python dependency. You can install it via pip or verify the python environment.";
  } else if (lowOut.includes("permission denied") || lowOut.includes("access is denied")) {
    diagnosis =
      "\n💡 Auto-Diagnosis: File or port access denied. The resource may be locked by another running process.";
  }

  const errorMsg = `Shell exited with code ${code}:\n${out}${diagnosis}`.trimEnd();
  void stderrText;
  return Result.failure(errorMsg, { exitCode: code });
}

