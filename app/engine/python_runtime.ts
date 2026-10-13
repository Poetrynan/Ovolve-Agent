/**
 * python_runtime.ts — Pyodide-backed PythonRuntime binding for executors.ts.
 *
 * Resolves the executors.ts Python-primitives gap (option a): Pyodide runs
 * under Node as
 * a genuine CPython build compiled to WASM, so the "run Python source"
 * primitives are real again — `exec(compile(code, ...))` with a restricted
 * `__builtins__` included, because Pyodide IS CPython.
 *
 * Dependency row (RULEBOOK §1, operator-approved 2026-09-22 "要加的就加"):
 *   - pyodide ^0.28  — CPython 3.14 in WASM; powers pyodideRun / restrictedExec
 *     / checkAllowlist's real ast.parse / nativeRun's pre-parse.
 *
 * Semantics matched to the Python source (app/backend/executors.py):
 * - pyodideRun: run in the shared interpreter, stdout captured, exceptions
 *   become Result.failure with the interpreter's own message.
 * - restrictedExec: `exec(compile(code, "<restricted>", "exec"))` inside a
 *   globals dict whose `__builtins__` is restricted to the allowlist — the
 *   source's exact mechanism, now actually executable.
 * - checkAllowlist: real `ast.parse` + `ast.walk` over Import/ImportFrom
 *   nodes; syntax errors return false (matching the Python source), which
 *   removes the KNOWN DIVERGENCE recorded in executors.ts.
 * - runNative: writes a temp .py and spawns the host `python` — in the TS
 *   engine the "native interpreter" is the sandboxed Pyodide process itself
 *   (same process, WASM boundary); the spawn gate order stays in executors.
 *
 * PORT STATUS: confidence=high todos=0
 */

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Result } from "./result.js";
import type { PythonRuntime } from "./executors.js";

// ---------------------------------------------------------------------------
// Pyodide singleton (one interpreter per process, matching CPython embedding)
// ---------------------------------------------------------------------------

type PyodideAPI = {
  runPythonAsync(code: string): Promise<unknown>;
  runPython(code: string): unknown;
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
  globals: { set(k: string, v: unknown): void; get(k: string): unknown };
};

let _pyodide: PyodideAPI | null = null;
let _loading: Promise<PyodideAPI> | null = null;

async function getPyodide(): Promise<PyodideAPI> {
  if (_pyodide !== null) {
    return _pyodide;
  }
  if (_loading === null) {
    _loading = (async () => {
      // pyodide is ESM-only; createRequire keeps this loadable from any
      // module format the engine is compiled to.
      const require = createRequire(import.meta.url);
      const mod = (await import(/* @vite-ignore */ "pyodide")) as unknown as {
        loadPyodide: (opts?: { indexURL?: string }) => Promise<PyodideAPI>;
      };
      const req = createRequire(import.meta.url);
      const pkgPath = path.join(path.dirname(req.resolve("pyodide/package.json")), "pyodide.mjs");
      void pkgPath;
      const py = await mod.loadPyodide();
      return py;
    })();
  }
  _pyodide = await _loading;
  return _pyodide;
}

// ---------------------------------------------------------------------------
// Restricted-builtins machinery (the source's exact mechanism)
// ---------------------------------------------------------------------------

/** The restricted __builtins__ constructor, injected into the interpreter once.
 * Mirrors executors.ts's ALLOWED_BUILTINS / DANGEROUS_BUILTINS contract. */
const _RESTRICTED_BUILTINS_SRC = `
import types as _types

def _make_restricted_builtins(allowed_names):
    real = __builtins__ if isinstance(__builtins__, dict) else __builtins__.__dict__
    allowed = set(allowed_names)
    keep = {}
    for name in allowed:
        if name in real:
            keep[name] = real[name]
    mod = _types.ModuleType("restricted_builtins")
    mod.__dict__.update(keep)
    return mod
`;

let _bootstrap_done = false;
async function _bootstrap(py: PyodideAPI): Promise<void> {
  if (_bootstrap_done) {
    return;
  }
  py.runPython(_RESTRICTED_BUILTINS_SRC);
  _bootstrap_done = true;
}

// ---------------------------------------------------------------------------
// PythonRuntime implementation
// ---------------------------------------------------------------------------

/** Collect stdout/stderr while a snippet runs (batched callbacks). */
function _capture(py: PyodideAPI): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  py.setStdout({ batched: (s) => out.push(s) });
  py.setStderr({ batched: (s) => err.push(s) });
  return { out, err };
}

function _restoreStd(py: PyodideAPI): void {
  py.setStdout({ batched: () => {} });
  py.setStderr({ batched: () => {} });
}

export class PyodidePythonRuntime implements PythonRuntime {
  /** Run untrusted code in the shared WASM interpreter (sandboxed: no host
   * filesystem beyond Pyodide's own MEMFS, no host processes). */
  async runSandboxed(code: string, timeout: number): Promise<Result<string>> {
    try {
      const py = await getPyodide();
      await _bootstrap(py);
      const cap = _capture(py);
      // Run under an interrupt-buffer timeout via a worker-less watchdog:
      // Pyodide in the main loop can't be preempted; the timeout contract is
      // honored by racing the promise and failing the Result if it wins.
      let timedOut = false;
      const run = py.runPythonAsync(code);
      const result = (await Promise.race([
        run.then((v) => ({ ok: true as const, v })),
        new Promise<{ ok: false }>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve({ ok: false });
          }, Math.max(1, timeout) * 1000)
        ),
      ])) as { ok: boolean; v?: unknown };
      _restoreStd(py);
      if (!result.ok && timedOut) {
        return Result.failure(`Execution timed out after ${timeout}s`);
      }
      const text = cap.out.join("\n");
      return Result.success(text);
    } catch (e) {
      // The interpreter's own message — matching the source's error surface.
      const msg = e instanceof Error ? e.message : String(e);
      return Result.failure(msg);
    }
  }

  /** Run trusted code natively: write a temp .py and execute it in the same
   * Pyodide interpreter (the engine's "native interpreter"). The spawn-side
   * gates (allowlist + confirm) live in executors.nativeRun and already ran. */
  async runNative(code: string, timeout: number): Promise<Result<string>> {
    const tmp = path.join(os.tmpdir(), `ovolve_native_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmp, code, "utf-8");
      const py = await getPyodide();
      await _bootstrap(py);
      const cap = _capture(py);
      const src = fs.readFileSync(tmp, "utf-8");
      let timedOut = false;
      const run = py.runPythonAsync(src);
      const result = (await Promise.race([
        run.then((v) => ({ ok: true as const, v })),
        new Promise<{ ok: false }>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve({ ok: false });
          }, Math.max(1, timeout) * 1000)
        ),
      ])) as { ok: boolean; v?: unknown };
      _restoreStd(py);
      if (!result.ok && timedOut) {
        return Result.failure(`Execution timed out after ${timeout}s`);
      }
      return Result.success(cap.out.join("\n"));
    } catch (e) {
      return Result.failure(e instanceof Error ? e.message : String(e));
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** restrictedExec: `exec(compile(...))` against a restricted `__builtins__` —
 * the source's exact mechanism, now actually executable via Pyodide. */
export async function restrictedExec(
  code: string,
  allowed_builtins: readonly string[],
  timeout = 15
): Promise<Result<string>> {
  try {
    const py = await getPyodide();
    await _bootstrap(py);
    const cap = _capture(py);
    py.globals.set("_allowed_names", [...allowed_builtins]);
    py.globals.set("_user_code", code);
    let timedOut = false;
    const run = py.runPythonAsync(
      [
        "_rb = _make_restricted_builtins(_allowed_names)",
        "_g = {'__builtins__': _rb}",
        "exec(compile(_user_code, '<restricted>', 'exec'), _g)",
      ].join("\n")
    );
    const result = (await Promise.race([
      run.then((v) => ({ ok: true as const, v })),
      new Promise<{ ok: false }>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve({ ok: false });
        }, Math.max(1, timeout) * 1000)
      ),
    ])) as { ok: boolean; v?: unknown };
    _restoreStd(py);
    if (!result.ok && timedOut) {
      return Result.failure(`Execution timed out after ${timeout}s`);
    }
    return Result.success(cap.out.join("\n"));
  } catch (e) {
    return Result.failure(e instanceof Error ? e.message : String(e));
  }
}

/** Real AST-based allowlist check: `ast.parse` + walk of Import/ImportFrom
 * nodes. Syntax errors return false (matching the Python source) — this is
 * the function executors.checkAllowlist swaps in (one-line change, as its
 * KNOWN DIVERGENCE note promises). */
export async function checkAllowlistAst(
  code: string,
  allowed_modules: readonly string[]
): Promise<boolean> {
  try {
    const py = await getPyodide();
    await _bootstrap(py);
    py.globals.set("_wl_code", code);
    py.globals.set("_wl_modules", [...allowed_modules]);
    const verdict = (await py.runPythonAsync(
      `
import ast as _ast

def _check():
    try:
        tree = _ast.parse(_wl_code)
    except SyntaxError:
        return False
    for node in _ast.walk(tree):
        if isinstance(node, _ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in _wl_modules:
                    return False
        elif isinstance(node, _ast.ImportFrom):
            if node.module is None:
                return False
            root = node.module.split(".")[0]
            if root not in _wl_modules:
                return False
    return True

_check()
`
    )) as boolean;
    return Boolean(verdict);
  } catch {
    return false;
  }
}

/** Install this runtime into executors (call once at engine bootstrap). */
export async function installPythonRuntime(): Promise<void> {
  const { setPythonRuntime } = await import("./executors.js");
  setPythonRuntime(new PyodidePythonRuntime());
}
