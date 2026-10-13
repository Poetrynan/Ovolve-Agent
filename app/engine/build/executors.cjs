"use strict";
/**
 * executors.ts 鈥?dual-layer sandbox executor.
 *
 * Ported from `app/backend/executors.py` (713 lines).
 *
 * Default: Pyodide WASM sandbox (physically isolated, data stays on machine).
 * Native: whitelisted commands + AST review + risk confirmation + resource limits.
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/executors.py -> app/engine/executors.ts
 *   搂2  ContextVar -> AsyncLocalStorage (the direct Node equivalent, a builtin)
 *   搂2  broad swallow: every fail-open catch is preserved
 *   搂3  TODO(port): the Python-execution primitives, see below
 *
 * PORT STATUS: confidence=medium todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OUTPUT_CAP = exports.BlockedCommandError = exports.DANGEROUS_ATTRS = exports.DANGEROUS_CALLS = exports.NATIVE_ALLOWLIST_MODULES = void 0;
exports.currentCallId = currentCallId;
exports.callScope = callScope;
exports.bindCallId = bindCallId;
exports.registerOutputSink = registerOutputSink;
exports.unregisterOutputSink = unregisterOutputSink;
exports.emitLine = emitLine;
exports.trackedCount = trackedCount;
exports.setPythonRuntime = setPythonRuntime;
exports.pyodideRun = pyodideRun;
exports.nativeRun = nativeRun;
exports.checkAllowlist = checkAllowlist;
exports.checkAllowlistLexical = checkAllowlistLexical;
exports.runPython = runPython;
exports.shellWord = shellWord;
exports.pyRepr = pyRepr;
exports.denyGate = denyGate;
exports.killTree = killTree;
exports.cancelCall = cancelCall;
exports.trackChildProcess = trackChildProcess;
exports.untrackChildProcess = untrackChildProcess;
exports.killChildProcess = killChildProcess;
exports.trackedRun = trackedRun;
exports.guardedSpawn = guardedSpawn;
exports.runShell = runShell;
const node_async_hooks_1 = require("node:async_hooks");
const child_process = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const danger_classifier_js_1 = require("./danger_classifier.cjs");
const result_js_1 = require("./result.cjs");
const _sinks = new Map();
const _procs = new Map();
// Node runs JS on one thread, so the lock the source holds around these maps is
// unnecessary; the maps are still mutated only through the helpers below.
/**
 * RULEBOOK 搂2 (ContextVar -> AsyncLocalStorage): the source keeps the current
 * tool call in a `contextvars.ContextVar`, which `asyncio.to_thread` copies into
 * the worker thread so a nested spawn inside a synchronous tool still claims the
 * right call id. `AsyncLocalStorage` is the direct Node equivalent and is a
 * builtin, so no dependency row is needed.
 */
const _currentCall = new node_async_hooks_1.AsyncLocalStorage();
/** The tool call this code is running inside, or "" outside any call. */
function currentCallId() {
    return _currentCall.getStore() ?? "";
}
/**
 * Run `fn` with `callId` as the ambient call id.
 *
 * The source's `call_scope` is a context manager; this takes the function to run
 * inside the scope, which is what AsyncLocalStorage needs 鈥?the store is only
 * visible on the synchronous/async continuation of the `run` call.
 */
function callScope(callId, fn) {
    return _currentCall.run(String(callId || ""), fn);
}
/**
 * Imperative form of `callScope`, for a call site whose body is too large to
 * wrap. Unlike the source's token-based `bind`/`unbind` pair, AsyncLocalStorage
 * has no re-entrant token, so this sets the store for the CURRENT context only 鈥? * callers that need the value to survive across an await boundary must use
 * `callScope` instead.
 */
function bindCallId(callId) {
    _currentCall.enterWith(String(callId || ""));
}
/** Register where one command's output goes. Unregistered means nobody listens. */
function registerOutputSink(callId, sink) {
    if (!callId) {
        return;
    }
    _sinks.set(callId, sink);
}
/** Clear after the command finishes. Leaking these grows both tables without bound. */
function unregisterOutputSink(callId) {
    if (!callId) {
        return;
    }
    _sinks.delete(callId);
    _procs.delete(callId);
}
/** Hand one output line to the sink. A throwing sink must never take down the command. */
function emitLine(callId, text) {
    if (!callId || !text) {
        return;
    }
    const sink = _sinks.get(callId);
    if (!sink) {
        return;
    }
    try {
        sink(text);
    }
    catch {
        // RULEBOOK 搂2 (fail-open): preserved.
    }
}
/**
 * How many children are registered under a call id.
 *
 * Exists so the registry's behaviour can be asserted from outside: the source's
 * tests read `_procs` directly, and a module-private Map in TS needs an
 * accessor to be observable at all.
 */
function trackedCount(callId) {
    return (_procs.get(callId) ?? []).length;
}
// 鈹€鈹€ code execution 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
/** Whitelisted modules for native execution. */
exports.NATIVE_ALLOWLIST_MODULES = new Set([
    "math", "cmath", "decimal", "fractions", "random", "statistics",
    "itertools", "functools", "collections", "heapq", "bisect",
    "re", "json", "string", "copy", "textwrap", "datetime", "time",
    "dataclasses", "typing", "numbers", "operator", "enum",
    "numpy", "scipy", "sympy", "pandas", "mpmath",
    "os.path", "hashlib", "base64", "csv", "io", "uuid",
]);
/** Dangerous call targets to block. */
exports.DANGEROUS_CALLS = new Set([
    "os.system", "os.popen", "os.exec", "os.execv", "os.execvp",
    "subprocess.call", "subprocess.run", "subprocess.Popen",
    "eval", "exec", "compile", "__import__",
    "open", // File I/O - only allowed through the tool layer
]);
exports.DANGEROUS_ATTRS = new Set([
    "system", "popen", "exec", "execv", "fork", "kill",
]);
let _runtime = null;
/** Install the code-execution backend. See the TODO(port) above. */
function setPythonRuntime(rt) {
    _runtime = rt;
}
async function pyodideRun(code, timeout = 30) {
    if (_runtime === null) {
        return result_js_1.Result.failure("Pyodide runtime is not bound (see the TODO(port) in executors.ts)");
    }
    return _runtime.runSandboxed(code, timeout);
}
async function nativeRun(code, timeout = 60, confirm = false) {
    if (_runtime === null) {
        return result_js_1.Result.failure("Native runtime is not bound (see the TODO(port) in executors.ts)");
    }
    // The gate order is preserved here rather than inside the runtime: the
    // allowlist check and the confirmation gate are this module's contract.
    if (!checkAllowlist(code)) {
        return result_js_1.Result.failure("Code uses non-whitelisted modules");
    }
    if (!confirm) {
        return result_js_1.Result.failure("Native execution requires confirmation (high risk)");
    }
    return _runtime.runNative(code, timeout);
}
/**
 * Whether the code only imports whitelisted modules.
 *
 * RULEBOOK 搂2 (no equivalent): the source walks a Python AST, so it also
 * answers "is this even parseable?" 鈥?`ast.parse` raising SyntaxError makes
 * `_check_allowlist` return false. Without a Python parser this degrades to a
 * lexical scan of the import forms.
 *
 * KNOWN DIVERGENCE, recorded rather than papered over: for syntactically
 * invalid input the original returns false and this returns true when the
 * invalid text contains no import line. The consequence is bounded 鈥?the
 * caller's next gate is the actual execution, which fails on the syntax error
 * and returns the interpreter's own message 鈥?but it is a real difference and
 * it disappears the moment a parser is bound (see the TODO(port) below).
 * `checkAllowlistLexical` is exported so that swap changes one line.
 */
function checkAllowlist(code) {
    return checkAllowlistLexical(code);
}
function checkAllowlistLexical(code) {
    const lines = code.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        const m = /^import\s+(.+)$/.exec(line);
        if (m) {
            for (const part of m[1].split(",")) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (!exports.NATIVE_ALLOWLIST_MODULES.has(name) && !name.startsWith("__")) {
                    return false;
                }
            }
            continue;
        }
        const f = /^from\s+([\w.]+)\s+import\b/.exec(line);
        if (f) {
            const mod = f[1];
            if (!exports.NATIVE_ALLOWLIST_MODULES.has(mod)) {
                return false;
            }
        }
    }
    return true;
}
/** Unified entry point for code execution. */
async function runPython(code, mode = "sandbox", timeout = 30, confirm = false) {
    if (mode === "sandbox") {
        return pyodideRun(code, timeout);
    }
    if (mode === "native") {
        return nativeRun(code, timeout, confirm);
    }
    return result_js_1.Result.failure(`Unknown execution mode: ${mode}`);
}
// 鈹€鈹€ shell execution 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
/** Raised instead of spawning when a command trips a deny-level rule. */
class BlockedCommandError extends Error {
}
exports.BlockedCommandError = BlockedCommandError;
/**
 * Shell metacharacters that turn one command into two. Tool arguments are
 * model-authored text, so any of these inside an app name or search term means
 * the string is no longer a name 鈥?it is a second command riding along.
 * Backslash and colon are deliberately allowed: `C:\Program Files\x.exe` is a
 * legitimate app name on Windows, and neither starts a new command in cmd.exe
 * or PowerShell.
 */
const SHELL_METACHARS = ";|&`$><\n\r\"'";
/**
 * Validate a model-supplied token before it is pasted into a shell string.
 *
 * Rejects rather than escapes. An app name containing `;` or a backtick is not
 * a name that failed to quote 鈥?it is an injection attempt, and quoting it into
 * obedience would hide that. Callers build commands like
 * `taskkill /im "{name}.exe"`, where one unbalanced quote is enough to append an
 * arbitrary command, so the check has to happen before interpolation.
 */
function shellWord(value, label = "鍙傛暟") {
    const text = String(value ?? "");
    if (!text.trim()) {
        throw new BlockedCommandError(`${label}涓嶈兘涓虹┖`);
    }
    const bad = Array.from(new Set(Array.from(text).filter((c) => SHELL_METACHARS.includes(c)))).sort();
    if (bad.length) {
        // RULEBOOK 搂2 (formatting): the source writes `{''.join(bad)!r}` 鈥?Python's
        // repr of a string. Its quote selection is not cosmetic: repr uses double
        // quotes when the value contains a single quote and no double quote, so
        // `repr("'")` is `"'"`, not `'\''`. JSON.stringify would always double-quote;
        // a fixed single quote would always escape. Both change a user-facing
        // message, so the rule is implemented.
        throw new BlockedCommandError(`${label}閲屽惈鏈?shell 鐗规畩瀛楃 ${pyRepr(bad.join(""))}锛屽凡鎷掔粷鎵ц銆俙 +
            "搴旂敤鍚?鎼滅储璇嶄笉璇ュ甫杩欎簺瀛楃銆?);
    }
    if (Array.from(text).length > 200) {
        throw new BlockedCommandError(`${label}杩囬暱锛?{Array.from(text).length} 瀛楃锛夛紝宸叉嫆缁濇墽琛宍);
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
function pyRepr(s) {
    const hasSingle = s.includes("'");
    const hasDouble = s.includes('"');
    const quote = hasSingle && !hasDouble ? '"' : "'";
    let body = "";
    for (const ch of s) {
        if (ch === "\\") {
            body += "\\\\";
        }
        else if (ch === quote) {
            body += "\\" + ch;
        }
        else if (ch === "\n") {
            body += "\\n";
        }
        else if (ch === "\r") {
            body += "\\r";
        }
        else if (ch === "\t") {
            body += "\\t";
        }
        else {
            body += ch;
        }
    }
    return quote + body + quote;
}
/**
 * Deny-level rule check. Throws rather than returning, so no caller can
 * accidentally ignore the verdict by dropping a return value.
 */
function denyGate(command) {
    const verdict = (0, danger_classifier_js_1.classifyCommand)(command || "", "shell");
    if (verdict.blocked) {
        throw new BlockedCommandError(`宸叉嫤涓嬮珮鍗卞懡浠わ紙${verdict.what || verdict.pattern}锛夈€傝繖涓€姝ヤ笉浼氭墽琛屻€俙);
    }
}
/**
 * Kill the process AND its children.
 *
 * `shell: true` means the direct child is cmd.exe / sh, and the command the user
 * actually cares about is a grandchild. `proc.kill()` reaps only the shell and
 * leaves the real work running as an orphan 鈥?which looked like "cancel did
 * nothing".
 *
 * Confined processes (Job Objects / sandbox-exec) expose a tree kill so the
 * kernel-side tree dies with the parent, not just the shell fronting it.
 */
function killTree(proc) {
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
        }
        catch {
            // RULEBOOK 搂2 (fail-open): preserved, then fall through to kill().
        }
    }
    else if (proc.pid !== undefined) {
        try {
            // RULEBOOK 搂2: the source calls `os.killpg(os.getpgid(pid), SIGKILL)`,
            // which needs the child in its own process group 鈥?spawn's `detached`
            // option is what creates that group, so it must be set at spawn time.
            process.kill(-proc.pid, "SIGKILL");
            return;
        }
        catch {
            // fall through
        }
    }
    try {
        proc.kill("SIGKILL");
    }
    catch {
        // RULEBOOK 搂2 (fail-open): preserved.
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
function cancelCall(callId) {
    const procs = [...(_procs.get(callId) ?? [])];
    let killed = false;
    for (const proc of procs) {
        try {
            if (proc.exitCode !== null || proc.signalCode !== null) {
                continue;
            }
            killTree(proc);
            killed = true;
        }
        catch (exc) {
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
function trackChildProcess(callId, proc) {
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
function untrackChildProcess(callId, proc) {
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
    }
    else {
        _procs.delete(cid);
    }
}
/** Kill a tracked child and its tree. */
function killChildProcess(proc) {
    killTree(proc);
}
/**
 * The spawnable equivalent of `subprocess.run` that the stop button can reach.
 *
 * `subprocess.run` hides its child handle, so anything spawned through it was
 * invisible to `cancelCall`: Stop killed the tools that happened to go through
 * `runShell` and silently left the rest running. Same contract, so call sites
 * only change the function name.
 *
 * On timeout the tree is killed before the error propagates 鈥?the whole point,
 * since a plain timeout kills only the direct child and a `shell: true`
 * command's real work is a grandchild.
 *
 * RULEBOOK 搂2 (asyncio mapping): Python's `subprocess.run` blocks; Node's spawn
 * does not. This returns a promise, which is the platform's shape for the same
 * operation 鈥?the ordering guarantee (kill the tree before surfacing the
 * timeout) is what is preserved.
 */
function trackedRun(command, opts = {}) {
    const cid = String(opts.callId || "") || currentCallId();
    const timeout = opts.timeout ?? 30;
    const shell = opts.shell ?? false;
    // A cwd that does not exist would make spawn throw before the command runs, so
    // a file path is reduced to its directory and a missing dir falls back to the
    // inherited one.
    let validCwd;
    if (opts.cwd && typeof opts.cwd === "string") {
        const clean = opts.cwd.replace(/^[\s"']+|[\s"']+$/g, "");
        if (clean) {
            try {
                validCwd = fs.statSync(clean).isDirectory() ? clean : path.dirname(clean);
            }
            catch {
                validCwd = undefined;
            }
        }
    }
    return new Promise((resolve, reject) => {
        const proc = child_process.spawn(command, {
            cwd: validCwd,
            shell,
            env: (opts.env ?? process.env),
            // RULEBOOK 搂2: on POSIX the tree kill needs the child in its own process
            // group, which `detached` creates. Windows uses taskkill /T instead.
            detached: process.platform !== "win32",
            stdio: opts.captureOutput === false ? "inherit" : ["ignore", "pipe", "pipe"],
        });
        trackChildProcess(cid, proc);
        const outChunks = [];
        const errChunks = [];
        proc.stdout?.on("data", (d) => outChunks.push(d));
        proc.stderr?.on("data", (d) => errChunks.push(d));
        let timer = null;
        let timedOut = false;
        const decode = (chunks) => Buffer.concat(chunks).toString(opts.encoding ?? "utf8");
        const finish = (returncode, err) => {
            if (timer) {
                clearTimeout(timer);
            }
            untrackChildProcess(cid, proc);
            const result = {
                args: command,
                returncode,
                stdout: decode(outChunks),
                stderr: decode(errChunks),
                timedOut,
            };
            if (err) {
                reject(err);
            }
            else {
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
function guardedSpawn(command, opts = {}) {
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
exports.OUTPUT_CAP = 200_000;
/**
 * Run a shell command, streaming output line by line as it arrives.
 *
 * Every command goes through three gates, in this order:
 *
 *   1. Path policy (`sandbox-policy.yaml`) 鈥?auditable, user-editable.
 *   2. Danger classifier 鈥?deny-level patterns (`format c:` vs `git log`).
 *   3. OS-native confinement 鈥?the kernel has the last word.
 *
 * Confirmation is required but is not a sandbox bypass: a confirmed command
 * still runs inside the workspace-write jail unless `sandboxMode` is explicitly
 * `danger-full-access`.
 */
async function runShell(command, opts = {}) {
    const { assertCommandAllowed } = await Promise.resolve().then(() => require("./path_policy.cjs"));
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
    }
    catch (e) {
        return result_js_1.Result.failure(e.message);
    }
    if (!opts.confirm) {
        return result_js_1.Result.failure("Shell execution requires confirmation (high risk)");
    }
    try {
        // Rule matching lives in danger_classifier, which knows the difference
        // between `format c:` and `git log --format=%h`.
        denyGate(command);
    }
    catch (e) {
        if (e instanceof BlockedCommandError) {
            return result_js_1.Result.failure(e.message);
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
     * RULEBOOK 搂2 (encoding): the source decodes utf-8 and falls back to gb18030
     * on Windows console output. Node's Buffer.toString("utf8") never throws, so
     * the fallback is applied only when the utf-8 decode produced replacement
     * characters, which is the observable symptom the source was reacting to.
     */
    const decodeLine = (raw) => {
        const utf8 = raw.toString("utf8");
        if (!utf8.includes("\uFFFD")) {
            return utf8;
        }
        try {
            return new TextDecoder("gb18030", { fatal: false }).decode(raw);
        }
        catch {
            return raw.toString("utf8");
        }
    };
    const chunks = [];
    let total = 0;
    let capped = false;
    let stderrText = "";
    try {
        await new Promise((resolve, reject) => {
            let pending = Buffer.alloc(0);
            const onData = (buf) => {
                pending = Buffer.concat([pending, buf]);
                for (;;) {
                    const nl = pending.indexOf(0x0a);
                    if (nl === -1) {
                        break;
                    }
                    const raw = pending.subarray(0, nl + 1);
                    pending = pending.subarray(nl + 1);
                    let line = decodeLine(raw);
                    // Redact per line, before it is streamed OR buffered 鈥?a leaked secret
                    // must not reach the UI even for the split second before the final
                    // result is scrubbed.
                    if (opts.lineFilter) {
                        try {
                            line = opts.lineFilter(line);
                        }
                        catch {
                            // RULEBOOK 搂2 (fail-open): preserved.
                        }
                    }
                    emitLine(callId, line);
                    if (total < exports.OUTPUT_CAP) {
                        chunks.push(line);
                        total += line.length;
                    }
                    else if (!capped) {
                        capped = true;
                    }
                }
            };
            proc.stdout?.on("data", onData);
            proc.stderr?.on("data", (d) => {
                stderrText += decodeLine(d);
                onData(d);
            });
            proc.on("error", reject);
            proc.on("close", () => resolve());
        });
    }
    catch (e) {
        killTree(proc);
        return result_js_1.Result.failure(`Shell error: ${String(e)}`, { exitCode: proc.exitCode });
    }
    finally {
        clearTimeout(killer);
        if (callId) {
            untrackChildProcess(callId, proc);
        }
    }
    let out = chunks.join("");
    if (capped) {
        out += `\n[杈撳嚭瓒呰繃 ${exports.OUTPUT_CAP} 瀛楃锛屽悗缁凡鐪佺暐]`;
    }
    const code = proc.exitCode;
    if (expired) {
        // Partial output is the whole point of reporting a timeout this way.
        return result_js_1.Result.failure(`鍛戒护瓒呮椂锛?{budget}s锛夊凡琚粓姝€備互涓嬫槸瓒呮椂鍓嶇殑杈撳嚭锛歕n${out}`.trimEnd(), { exitCode: code, timedOut: true });
    }
    if (code === 0) {
        return result_js_1.Result.success(out, { exitCode: 0 });
    }
    // Smart command-failure auto-diagnosis to enable one-step self-correction.
    let diagnosis = "";
    const lowOut = out.toLowerCase();
    if (lowOut.includes("is not recognized as an internal or external command") ||
        lowOut.includes("command not found")) {
        const cmdHead = command.trim().split(/\s+/)[0] ?? "";
        diagnosis = `\n馃挕 Auto-Diagnosis: Command \`${cmdHead}\` is not found in PATH. Try invoking via \`python -m ${cmdHead}\` or checking executable path.`;
    }
    else if (lowOut.includes("modulenotfounderror: no module named")) {
        diagnosis =
            "\n馃挕 Auto-Diagnosis: Missing Python dependency. You can install it via pip or verify the python environment.";
    }
    else if (lowOut.includes("permission denied") || lowOut.includes("access is denied")) {
        diagnosis =
            "\n馃挕 Auto-Diagnosis: File or port access denied. The resource may be locked by another running process.";
    }
    const errorMsg = `Shell exited with code ${code}:\n${out}${diagnosis}`.trimEnd();
    void stderrText;
    return result_js_1.Result.failure(errorMsg, { exitCode: code });
}
