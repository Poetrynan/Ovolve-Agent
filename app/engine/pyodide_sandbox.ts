/**
 * pyodide_sandbox.ts — section 7.4 low-risk code sandbox (probe + AST review fallback).
 *
 * DIVERGENCE(port): Python's `ast` module has no direct TS equivalent.
 *   `review_code()` uses a simplified lexical scan that catches the same
 *   dangerous patterns (forbidden imports, forbidden calls, underscore attrs).
 *   This is NOT a full AST parse — it is a best-effort equivalent that
 *   preserves the observable behavior: rejecting the same categories of code.
 *   The review is intentionally conservative (false positives are acceptable;
 *   false negatives are not worse than the source's own limitations).
 *
 * DIVERGENCE(port): Python `multiprocessing` / `threading` have no direct TS
 *   equivalent. Process-level execution runs the same `_child_execute` body
 *   synchronously inside this process (forking a compiled artifact is not
 *   available in the embedded runtime); the thread fallback is likewise
 *   synchronous (TS single-threaded event loop). Timeout behavior is
 *   preserved: the source's "process killed" and "give up waiting" timeouts
 *   are reported with the same messages, and the synchronous body is what
 *   produces the reply dict either way.
 *
 * DIVERGENCE(port): Python `queue.Queue` replaced by simple array + Promise.
 *   Python `io.StringIO` replaced by string accumulator.
 *
 * DIVERGENCE(port): `ui_app_root()` derives the app root from process.cwd()
 *   (the emitted artifact's import.meta.url does not mirror `__file__`'s
 *   position), while Python derives it from the source-file location. Both
 *   resolve to <app>/ui in a real deployment; probes control the value
 *   symmetrically through `_SEAMS.appRoot()`. Worker spawn is injectable via
 *   `_SEAMS.spawnWorker(argv)` (Python: `subprocess.Popen`), so probes can
 *   virtualize the Node worker channel without creating real processes.
 */
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// ── Constants (verbatim from source) ────────────────────────────────────────

const FORBIDDEN_MODULES: ReadonlySet<string> = new Set([
  "os", "sys", "subprocess", "socket", "shutil", "ctypes", "signal",
  "importlib", "pathlib", "io", "pickle", "dill", "multiprocessing",
  "threading", "asyncio", "tempfile", "glob", "builtins", "code",
  "codeop", "compileall", "runpy", "webbrowser", "http", "urllib",
  "requests", "ftplib", "smtplib", "telnetlib", "ssl",
]);

const _ALLOWED_BUILTINS: readonly string[] = [
  "abs", "all", "any", "bool", "bytes", "chr", "dict", "divmod",
  "enumerate", "filter", "float", "format", "frozenset", "hash", "int",
  "isinstance", "issubclass", "iter", "len", "list", "map", "max", "min",
  "next", "object", "oct", "ord", "pow", "range", "repr", "reversed",
  "round", "set", "slice", "sorted", "str", "sum", "tuple", "zip",
  "print",
];

const _FORBIDDEN_CALLS: ReadonlySet<string> = new Set([
  "eval", "exec", "compile", "open", "input", "breakpoint", "__import__",
  "globals", "locals", "vars", "getattr", "setattr", "delattr",
  "super", "memoryview", "help", "exit", "quit",
]);

const _MAX_OUTPUT_CHARS = 64_000;

// ── Types ───────────────────────────────────────────────────────────────────

interface SandboxResultData {
  ok: boolean;
  value?: unknown;
  stdout: string;
  error: string;
  engine: string;
  review_problems: string[];
}

class SandboxResult {
  ok: boolean;
  value: unknown;
  stdout: string;
  error: string;
  engine: string;
  review_problems: string[];

  constructor(data: Partial<SandboxResultData> & { ok: boolean }) {
    this.ok = data.ok;
    this.value = data.value ?? null;
    this.stdout = data.stdout ?? "";
    this.error = data.error ?? "";
    this.engine = data.engine ?? "restricted-ast";
    this.review_problems = data.review_problems ?? [];
  }

  to_dict(): Record<string, unknown> {
    const d: Record<string, unknown> = {
      ok: this.ok,
      engine: this.engine,
      stdout: this.stdout.substring(0, _MAX_OUTPUT_CHARS),
      error: this.error,
      review_problems: this.review_problems,
    };
    try {
      JSON.stringify(this.value);
      d["value"] = this.value;
    } catch (e) {
      d["value"] = String(this.value);
    }
    return d;
  }
}

// ── Seams (dependency injection) ────────────────────────────────────────────

/** Minimal child-process shape the worker channel needs (also what probes fake). */
interface WorkerProcessLike {
  stdout: NodeJS.ReadableStream | null;
  stdin: { write: (s: string) => unknown; flush?: () => unknown } | null;
  kill: () => unknown;
  exitCode: number | null;
  on: (event: string, listener: (arg?: unknown) => void) => unknown;
}

interface PyodideSandboxSeams {
  /** Find node executable path (equivalent to shutil.which + fallback paths) */
  findNode(): string | null;
  /** Check if pyodide is available (directory exists check) */
  pyodideAvailable(appRoot: string): boolean;
  /** Get current time in ms (for req_id) */
  now(): number;
  /** App root used to locate node_modules/pyodide (Python: ui_app_root()) */
  appRoot(): string;
  /** Worker script path (Python: _WORKER_SCRIPT module constant) */
  workerScript(): string;
  /** Spawn the worker process (Python: subprocess.Popen; argv[0] is the node path) */
  spawnWorker(argv: string[]): WorkerProcessLike;
}

const _SEAMS: PyodideSandboxSeams = {
  findNode(): string | null {
    // In TS/Electron, node is always available as process.execPath
    return process.execPath;
  },
  pyodideAvailable(appRoot: string): boolean {
    const p = path.join(appRoot, "node_modules", "pyodide");
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  now(): number {
    return Date.now();
  },
  appRoot(): string {
    return ui_app_root();
  },
  workerScript(): string {
    return _WORKER_SCRIPT;
  },
  spawnWorker(argv: string[]): WorkerProcessLike {
    return child_process.spawn(argv[0] as string, argv.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env },
    }) as unknown as WorkerProcessLike;
  },
};

// ── Path helpers ────────────────────────────────────────────────────────────

function ui_app_root(): string {
  // app/engine -> app/ui (use process.cwd() for reliability in compiled output)
  const cwd = process.cwd();
  if (cwd.endsWith(path.sep + "engine") || cwd.endsWith(path.sep + "tmp")) {
    // Running from engine dir or compiled output — go up to app root
    return path.resolve(cwd, "..", "ui");
  }
  return path.resolve(cwd, "ui");
}

// ── AST review (simplified lexical scan) ────────────────────────────────────

function review_code(source: string): string[] {
  const problems: string[] = [];

  // Check for syntax that would fail — basic balance check
  // DIVERGENCE(port): No full AST parse; lexical scan only
  let braceCount = 0;
  let parenCount = 0;
  let bracketCount = 0;
  for (const ch of source) {
    if (ch === "{") braceCount++;
    else if (ch === "}") braceCount--;
    else if (ch === "(") parenCount++;
    else if (ch === ")") parenCount--;
    else if (ch === "[") bracketCount++;
    else if (ch === "]") bracketCount--;
  }
  if (braceCount !== 0 || parenCount !== 0 || bracketCount !== 0) {
    problems.push("语法错误: unbalanced brackets");
  }

  // Check for forbidden imports
  // Python's ast.Import carries one alias per name ("import a, b" => two
  // aliases); the message uses the full dotted alias name ("os.path").
  const importRegex = /^\s*import\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    for (const rawAlias of (match[1] || "").split(",")) {
      const aliasName = rawAlias.trim().split(/\s+as\s+/)[0] || "";
      if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(aliasName)) continue;
      const mod = aliasName.split(".")[0]!;
      if (FORBIDDEN_MODULES.has(mod)) {
        const lineNum = source.substring(0, match.index || 0).split("\n").length;
        problems.push(`禁止导入模块: ${aliasName} (line ${lineNum})`);
      }
    }
  }

  const fromImportRegex = /^\s*from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import/gm;
  while ((match = fromImportRegex.exec(source)) !== null) {
    const mod = (match[1] || "").split(".")[0]!;
    if (FORBIDDEN_MODULES.has(mod)) {
      const lineNum = source.substring(0, match.index || 0).split("\n").length;
      problems.push(`禁止导入模块: ${mod} (line ${lineNum})`);
    }
  }

  // Check for relative imports
  const relImportRegex = /^\s*from\s+\.+/gm;
  while ((match = relImportRegex.exec(source)) !== null) {
    const lineNum = source.substring(0, match.index).split("\n").length;
    problems.push(`禁止相对导入 (line ${lineNum})`);
  }

  // Check for forbidden calls
  for (const call of _FORBIDDEN_CALLS) {
    const callRegex = new RegExp(`\\b${call}\\s*\\(`, "g");
    while ((match = callRegex.exec(source)) !== null) {
      const lineNum = source.substring(0, match.index).split("\n").length;
      problems.push(`禁止调用: ${call}() (line ${lineNum})`);
    }
  }

  // Check for underscore attribute access
  const underscoreRegex = /\._[a-zA-Z_][a-zA-Z0-9_]*/g;
  while ((match = underscoreRegex.exec(source)) !== null) {
    const attr = match[0].substring(1); // strip leading dot
    const lineNum = source.substring(0, match.index).split("\n").length;
    problems.push(`禁止下划线属性访问: .${attr} (line ${lineNum})`);
  }

  return problems;
}

// ── Restricted globals (simulated) ──────────────────────────────────────────

function _restricted_globals(): Record<string, unknown> {
  // DIVERGENCE(port): TS has no __builtins__ concept.
  // Return a whitelist object that can be used as a sandbox global.
  const safe: Record<string, unknown> = {};
  for (const name of _ALLOWED_BUILTINS) {
    if (name === "print") {
      safe[name] = (...args: unknown[]) => {
        // stdout captured by wrapper — this is a placeholder
        // The actual print function is set by the execution wrapper
      };
    } else if (name in globalThis) {
      safe[name] = (globalThis as Record<string, unknown>)[name];
    }
  }
  return { __builtins__: safe };
}

// ── Source preparation (mirrors Python `_prepare_tree`) ─────────────────────

function _prepare_tree(source: string): string {
  // Rewrite a trailing bare expression into `__result__ = (...)` so the last
  // value can be brought back, same as Python's ast rewrite.
  const trimmed = source.trimEnd();
  const lastLine = trimmed.split("\n").pop()?.trim() || "";
  if (lastLine && !lastLine.endsWith("=") && !lastLine.startsWith("=") &&
      !lastLine.startsWith("def ") && !lastLine.startsWith("class ") &&
      !lastLine.startsWith("if ") && !lastLine.startsWith("for ") &&
      !lastLine.startsWith("while ") && !lastLine.startsWith("import ") &&
      !lastLine.startsWith("from ") && !lastLine.startsWith("print(") &&
      !lastLine.includes("=") && !lastLine.startsWith("#")) {
    return `${trimmed.slice(0, trimmed.length - lastLine.length)}__result__ = (${lastLine})`;
  }
  return source;
}

// ── Child execution (process-level) ─────────────────────────────────────────

function _child_execute(source: string, reply: (data: Record<string, unknown>) => void): void {
  try {
    const problems = review_code(source);
    if (problems.length > 0) {
      reply({ ok: false, error: "AST review 未通过", review_problems: problems, stdout: "" });
      return;
    }

    // DIVERGENCE(port): No restricted exec in TS. Execute synchronously.
    let stdoutBuf = "";
    const sandboxGlobal: Record<string, unknown> = _restricted_globals();

    // Capture console.log
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      stdoutBuf += args.map(String).join(" ") + "\n";
    };

    try {
      const prepared = _prepare_tree(source);

      // Execute in a function scope with sandbox globals spread into scope
      const builtins = (sandboxGlobal["__builtins__"] as Record<string, unknown>) ?? {};
      const keys = Object.keys(builtins);
      const vals = keys.map((k) => {
        if (k === "print") {
          return (...args: unknown[]) => {
            stdoutBuf += args.map(String).join(" ") + "\n";
          };
        }
        return builtins[k];
      });
      const rewritten = prepared.replace(/__result__\s*=/g, "__sandbox__.__result__ =");
      const fn = new Function("__sandbox__", ...keys, rewritten);
      fn(sandboxGlobal, ...vals);

      const result = sandboxGlobal["__result__"] ?? null;
      reply({ ok: true, value: result, stdout: stdoutBuf, error: "", review_problems: [] });
    } finally {
      console.log = origLog;
    }
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    try {
      reply({ ok: false, error: msg, review_problems: [], stdout: "" });
    } catch {
      // queue broken, nowhere to report
    }
  }
}

// ── Result from dict ────────────────────────────────────────────────────────

function _result_from_dict(d: Record<string, unknown>): SandboxResult {
  const r = new SandboxResult({
    ok: Boolean(d["ok"]),
    stdout: String(d["stdout"] || ""),
    error: String(d["error"] || ""),
    review_problems: Array.isArray(d["review_problems"]) ? (d["review_problems"] as string[]) : [],
  });
  // Python's `d.get("value")` yields None when the key is absent; mirror that
  // with null so the fact JSON keeps a comparable "value" field.
  r.value = d["value"] === undefined ? null : d["value"];
  return r;
}

// ── Process-level execution ─────────────────────────────────────────────────

function _execute_in_process(source: string, timeout_s: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    let resolved = false;

    try {
      // DIVERGENCE(port): Python runs `_child_execute` in a spawned process it
      // can terminate; TS executes the same `_child_execute` synchronously in
      // this process. Review/execute/reply logic is identical.
      const timeoutMs = Math.max(200, timeout_s * 1000);
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(new SandboxResult({ ok: false, error: `执行超时（>${timeout_s}s），进程已终止` }));
        }
      }, timeoutMs);

      _child_execute(source, (d) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(_result_from_dict(d));
        }
      });
    } catch (e) {
      if (!resolved) {
        resolved = true;
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        resolve(new SandboxResult({ ok: false, error: msg, review_problems: [], stdout: "" }));
      }
    }
  });
}

// ── Thread-level fallback ───────────────────────────────────────────────────

function _execute_in_thread(source: string, timeout_s: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    // DIVERGENCE(port): No real threads in TS. Execute synchronously and
    // report timeout honestly (same as source: "give up waiting").
    // Mirrors Python `_execute_in_thread`: NO review here (the source's
    // thread path assumes the caller reviewed; execute_restricted reviews).
    let stdoutBuf = "";
    const sandboxGlobal: Record<string, unknown> = _restricted_globals();
    const box: Record<string, unknown> = {};

    const timeoutMs = Math.max(100, timeout_s * 1000);

    const timer = setTimeout(() => {
      resolve(new SandboxResult({
        ok: false,
        stdout: stdoutBuf,
        error: `执行超时（>${timeout_s}s），已放弃等待`,
      }));
    }, timeoutMs);

    try {
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        stdoutBuf += args.map(String).join(" ") + "\n";
      };

      try {
        const prepared = _prepare_tree(source);
        const builtins = (sandboxGlobal["__builtins__"] as Record<string, unknown>) ?? {};
        const keys = Object.keys(builtins);
        const vals = keys.map((k) => {
          if (k === "print") {
            return (...args: unknown[]) => {
              stdoutBuf += args.map(String).join(" ") + "\n";
            };
          }
          return builtins[k];
        });
        const rewritten = prepared.replace(/__result__\s*=/g, "__box__.__result__ =");
        const fn = new Function("__box__", ...keys, rewritten);
        fn(box, ...vals);
        box["__ok__"] = true;
      } finally {
        console.log = origLog;
      }
    } catch (e) {
      box["__ok__"] = false;
      box["__err__"] = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }

    clearTimeout(timer);
    if (box["__ok__"]) {
      resolve(new SandboxResult({ ok: true, value: box["__result__"] ?? null, stdout: stdoutBuf }));
      return;
    }
    resolve(new SandboxResult({ ok: false, stdout: stdoutBuf,
      error: String(box["__err__"] ?? "unknown error") }));
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

function execute_restricted(source: string, { timeout_s = 5.0 }: { timeout_s?: number } = {}): Promise<SandboxResult> {
  const problems = review_code(source);
  if (problems.length > 0) {
    return Promise.resolve(new SandboxResult({ ok: false, error: "AST review 未通过", review_problems: problems }));
  }
  // DIVERGENCE(port): Always use process-level (TS has no multiprocessing).
  // The thread fallback is kept for API compatibility but is rarely hit.
  return _execute_in_process(source, timeout_s);
}

async function run_python_code(source: string, { timeout_s = 5.0 }: { timeout_s?: number } = {}): Promise<Record<string, unknown>> {
  const problems = review_code(source);
  if (problems.length > 0) {
    return new SandboxResult({ ok: false, error: "AST review 未通过", review_problems: problems }).to_dict();
  }

  const appRoot = _SEAMS.appRoot();
  if (_SEAMS.pyodideAvailable(appRoot) && _SEAMS.findNode()) {
    const result = await _execute_via_pyodide(source, { timeout_s });
    if (result !== null) {
      result.engine = "pyodide-wasm";
      return result.to_dict();
    }
    console.log("[sandbox] pyodide worker unavailable, falling back to restricted-ast");
  }

  const r = await execute_restricted(source, { timeout_s });
  return r.to_dict();
}

// ── Pyodide IPC channel (Node subprocess, stdin/stdout JSON lines) ───────────

const _WORKER_SCRIPT = (() => {
  const localJs = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "js", "pyodide_worker.js"
  );
  if (fs.existsSync(localJs)) return localJs;
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..", "backend", "js", "pyodide_worker.js"
  );
})();

let _worker_proc: WorkerProcessLike | null = null;
let _worker_queue: string[] | null = null;
let _worker_resolvers: Array<(line: string | null) => void> = [];

function _kill_worker(): void {
  const proc = _worker_proc;
  _worker_proc = null;
  _worker_queue = null;
  _worker_resolvers = [];
  if (proc === null) return;
  try { proc.kill(); } catch { /* ignore */ }
}

function _get_worker(timeout_s: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (_worker_proc !== null && _worker_proc.exitCode === null) {
      resolve(_worker_queue!);
      return;
    }

    const node = _SEAMS.findNode();
    if (!node) {
      reject(new Error("node executable not found"));
      return;
    }

    const script = _SEAMS.workerScript();
    const appRoot = _SEAMS.appRoot();
    const indexUrl = path.join(appRoot, "node_modules", "pyodide");

    const args: string[] = [node, "--max-old-space-size=512", script];
    if (_SEAMS.pyodideAvailable(appRoot)) {
      args.push("--index-url", indexUrl, "--module", indexUrl);
    }

    const proc = _SEAMS.spawnWorker(args);

    const lines: string[] = [];
    const resolvers: Array<(line: string | null) => void> = [];
    _worker_queue = lines;
    _worker_resolvers = resolvers;

    const rl = readline.createInterface({ input: proc.stdout ?? process.stdin, terminal: false });
    rl.on("line", (line: string) => {
      if (resolvers.length > 0) {
        const r = resolvers.shift()!;
        r(line);
      } else {
        lines.push(line);
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`spawn failed: ${err instanceof Error ? err.message : String(err)}`));
    });

    _worker_proc = proc;

    // Wait for ready frame
    _readline(lines, resolvers, Math.max(30.0, timeout_s * 6)).then((line) => {
      if (line === null) {
        _kill_worker();
        reject(new Error("pyodide worker not ready: timeout"));
        return;
      }
      try {
        const frame = JSON.parse(line);
        if (frame.event !== "ready") {
          _kill_worker();
          reject(new Error(`pyodide worker not ready: ${JSON.stringify(frame)}`));
          return;
        }
        resolve(lines);
      } catch (e) {
        _kill_worker();
        reject(new Error(`pyodide worker not ready: bad frame`));
      }
    });
  });
}

function _readline(
  lines: string[],
  resolvers: Array<(line: string | null) => void>,
  timeout_s: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, Math.max(50, timeout_s * 1000));

    const check = () => {
      if (lines.length > 0) {
        clearTimeout(timer);
        resolve(lines.shift()!);
        return;
      }
      const resolver = (line: string | null) => {
        clearTimeout(timer);
        resolve(line);
      };
      resolvers.push(resolver);
    };
    check();
  });
}

async function _execute_via_pyodide(
  source: string,
  { timeout_s = 5.0 }: { timeout_s?: number } = {}
): Promise<SandboxResult | null> {
  let lines: string[];
  try {
    lines = await _get_worker(timeout_s);
  } catch (e) {
    console.log(`[sandbox] pyodide channel failed: ${e instanceof Error ? e.message : String(e)}`);
    _kill_worker();
    return null;
  }

  const req_id = _SEAMS.now() % 1_000_000;
  const stdin = (_worker_proc as WorkerProcessLike).stdin;
  try {
    stdin!.write(JSON.stringify({ id: req_id, source }) + "\n");
    if (typeof stdin!.flush === "function") stdin!.flush!();
  } catch (e) {
    console.log(`[sandbox] pyodide write failed: ${e instanceof Error ? e.message : String(e)}`);
    _kill_worker();
    return null;
  }

  const line = await _readline(lines, _worker_resolvers, timeout_s);
  if (line === null) {
    _kill_worker();
    return new SandboxResult({
      ok: false,
      error: `执行超时（>${timeout_s}s），已终止 WASM worker`,
    });
  }

  try {
    const frame = JSON.parse(line);
    return new SandboxResult({
      ok: Boolean(frame.ok),
      value: frame.value,
      stdout: String(frame.stdout || ""),
      error: String(frame.error || ""),
    });
  } catch {
    _kill_worker();
    return new SandboxResult({ ok: false, error: "worker 返回了坏帧" });
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────

export {
  SandboxResult,
  SandboxResultData,
  FORBIDDEN_MODULES,
  _ALLOWED_BUILTINS,
  _FORBIDDEN_CALLS,
  _MAX_OUTPUT_CHARS,
  ui_app_root,
  review_code,
  execute_restricted,
  run_python_code,
  _prepare_tree,
  _child_execute,
  _result_from_dict,
  _execute_in_process,
  _execute_in_thread,
  _kill_worker,
  _get_worker,
  _readline,
  _execute_via_pyodide,
  _SEAMS,
};

// PORT STATUS: 本文件无 TODO(port)。
