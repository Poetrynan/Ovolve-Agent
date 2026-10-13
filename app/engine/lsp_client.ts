/**
 * lsp_client.ts — Language Server Protocol (LSP) symbol navigation + diagnostics.
 *
 * Ported from `app/backend/lsp_client.py` (457 lines).
 *
 * Scope (matching the source, which is NOT a full LSP client — the docstring's
 * "JSON-RPC 2.0 protocol wrapper" ambition shipped as a symbol-navigator with
 * regex heuristics plus a diagnostics transport layer):
 *   - SymbolLocation dataclass → class
 *   - LocalSymbolNavigator (find_definition / find_references) — the source's
 *     real implementation, reproduced including its 200-file scan ceiling,
 *     ignored-directory filters, and the per-extension kind heuristics
 *   - diagnostics layer: LspDiagnostic (+ parse_publish_diagnostics),
 *     LspDiagnosticTransport / FakeLspTransport / LspDiagnosticClient /
 *     StdioLspTransport (child_process.spawn + Content-Length framing),
 *     create_stdio_lsp_client, set_lsp_diagnostic_client,
 *     diagnostics_for_file (both call shapes; the rate-limited no-session
 *     warning is preserved)
 *
 * RULEBOOK CITATIONS:
 *   §1  node: builtins only (node:child_process, node:fs, node:path).
 *   §2  broad swallows (`except Exception: pass` in did_open/shutdown/_reader)
 *       preserved verbatim with comments; the fail-open diagnostics contract
 *       (no session → [] + one rate-limited warning) is behaviour, kept.
 *   §2  `subprocess.Popen(text=True, bufsize=1)` line-read loop →
 *       readline-based reader over the spawn pipes; Content-Length framing
 *       stays byte-exact via Buffer.byteLength.
 *   §2  shared `g`-flag RegExps are constructed per call (HANDOFF §6.2).
 *   §4  naming: lsp_client.py → lsp_client.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// SymbolLocation
// ---------------------------------------------------------------------------

export interface SymbolLocationFields {
  file_path: string;
  line: number;
  character: number;
  symbol_name?: string;
  container_name?: string;
  kind?: string;
}

export class SymbolLocation {
  file_path: string;
  line: number;
  character: number;
  symbol_name: string;
  container_name: string;
  /** "function" | "class" | "variable" | "interface" */
  kind: string;

  constructor(f: SymbolLocationFields) {
    this.file_path = f.file_path;
    this.line = f.line;
    this.character = f.character;
    this.symbol_name = f.symbol_name ?? "";
    this.container_name = f.container_name ?? "";
    this.kind = f.kind ?? "variable";
  }
}

// ---------------------------------------------------------------------------
// LocalSymbolNavigator
// ---------------------------------------------------------------------------

const IGNORED_DIRS = [".git", "node_modules", "__pycache__", "dist", "build"];
const SOURCE_EXTS = [".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs"];

export class LocalSymbolNavigator {
  workspace_root: string;

  constructor(workspace_root: string) {
    this.workspace_root = path.resolve(workspace_root);
  }

  /** 查找指定符号的定义位置（支持类、函数、常量、类型定义） */
  find_definition(symbol_name: string, target_file?: string | null): SymbolLocation[] {
    const results: SymbolLocation[] = [];
    // 兼容 def foo, class foo, function foo, const foo 等
    const pattern = new RegExp(
      "(?:def|class|function|const|let|var|interface|type|struct|fn)\\s+(" +
        symbol_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        ")(?:\\b|[(:])"
    );

    const files_to_scan: string[] = [];
    if (target_file && fs.existsSync(target_file) && fs.statSync(target_file).isFile()) {
      files_to_scan.push(target_file);
    } else {
      const walk = (root: string): void => {
        if (files_to_scan.length > 200) return;
        if (IGNORED_DIRS.some((ig) => root.includes(ig))) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = path.join(root, e.name);
          if (e.isDirectory()) {
            walk(full);
          } else if (SOURCE_EXTS.some((ext) => e.name.endsWith(ext))) {
            files_to_scan.push(full);
            if (files_to_scan.length > 200) break;
          }
        }
      };
      walk(this.workspace_root);
    }

    for (const fpath of files_to_scan) {
      try {
        const content = fs.readFileSync(fpath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const match = pattern.exec(line);
          if (match) {
            const kind =
              line.includes("def ") || line.includes("fn ") || line.includes("function ")
                ? "function"
                : line.includes("class ")
                  ? "class"
                  : "variable";
            const rel_path = path.relative(this.workspace_root, fpath);
            results.push(
              new SymbolLocation({
                file_path: rel_path,
                line: i + 1,
                character: match.index! + match[0].indexOf(match[1]!),
                symbol_name,
                kind,
              })
            );
          }
        }
      } catch {
        // except Exception: continue
        continue;
      }
    }

    return results;
  }

  /** 查找指定符号的所有引用调用位置 */
  find_references(symbol_name: string, limit = 20): SymbolLocation[] {
    const results: SymbolLocation[] = [];
    const pattern = new RegExp(
      "\\b(" + symbol_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b"
    );

    const walk = (root: string): boolean => {
      // returns true when the caller should stop (limit reached)
      if ([".git", "node_modules", "__pycache__", "dist"].some((ig) => root.includes(ig)))
        return false;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const e of entries) {
        const full = path.join(root, e.name);
        if (e.isDirectory()) {
          if (walk(full)) return true;
        } else if (SOURCE_EXTS.some((ext) => e.name.endsWith(ext))) {
          try {
            const content = fs.readFileSync(full, "utf-8");
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const match = pattern.exec(lines[i]!);
              if (match) {
                const rel_path = path.relative(this.workspace_root, full);
                results.push(
                  new SymbolLocation({
                    file_path: rel_path,
                    line: i + 1,
                    character: match.index!,
                    symbol_name,
                  })
                );
                if (results.length >= limit) return true;
              }
            }
          } catch {
            // except Exception: continue
            continue;
          }
        }
      }
      return false;
    };
    walk(this.workspace_root);
    return results;
  }
}

let _GLOBAL_NAVIGATOR: LocalSymbolNavigator | null = null;

export function get_symbol_navigator(workspace_root: string): LocalSymbolNavigator {
  if (
    _GLOBAL_NAVIGATOR === null ||
    _GLOBAL_NAVIGATOR.workspace_root !== path.resolve(workspace_root)
  ) {
    _GLOBAL_NAVIGATOR = new LocalSymbolNavigator(workspace_root);
  }
  return _GLOBAL_NAVIGATOR;
}

export function lsp_navigate_handler(
  symbol: string,
  action = "definition",
  workspace = "."
): Record<string, unknown> {
  /** lsp 符号导航工具运行时处理入口 */
  const nav = get_symbol_navigator(workspace);
  if (action === "definition") {
    const defs = nav.find_definition(symbol);
    return {
      status: "ok",
      symbol,
      action: "definition",
      count: defs.length,
      definitions: defs.map((d) => ({
        location: `${d.file_path}:${d.line}`,
        kind: d.kind,
      })),
    };
  } else if (action === "references") {
    const refs = nav.find_references(symbol);
    return {
      status: "ok",
      symbol,
      action: "references",
      count: refs.length,
      references: refs.map((r) => ({
        location: `${r.file_path}:${r.line}`,
      })),
    };
  }
  return { status: "error", message: `未知的 LSP 动作: '${action}'` };
}

// ---------------------------------------------------------------------------
// 诊断 (diagnostics_for_file)
//
// 影子工作区预校验 (shadow_workspace._checker_lsp) 在落盘前需要 LSP 级诊断。
// 失败开放但不静默错误：没有可用会话时返回 [] 并记一条限流 warning。
// ---------------------------------------------------------------------------

/** LSP DiagnosticSeverity 数值 → Ovolve 字符串档位。 */
const _LSP_SEVERITY_TO_STR: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function _path_to_uri(p: string): string {
  /** `C:\foo\bar.py` → `file:///C:/foo/bar.py`（跨平台）。 */
  const abs_path = path.resolve(p);
  const norm = abs_path.split("\\").join("/");
  if (norm.startsWith("/")) {
    return "file://" + norm;
  }
  return "file:///" + norm;
}

export type DiagnosticRange = Record<string, unknown>;

export class LspDiagnostic {
  /** 单条诊断。支持属性访问与下标访问（`d["range"]`）。 */
  range: DiagnosticRange;
  severity: string;
  message: string;
  source: string;
  line: number;
  character: number;

  constructor(
    range: DiagnosticRange,
    severity: string,
    message: string,
    source: string,
    line = 0,
    character = 0
  ) {
    this.range = range;
    this.severity = severity;
    this.message = message;
    this.source = source;
    this.line = line;
    this.character = character;
  }

  /** 下标访问兼容：d["range"] → d.range */
  [key: string]: unknown;

  toDict(): Record<string, unknown> {
    return {
      range: this.range,
      severity: this.severity,
      message: this.message,
      source: this.source,
      line: this.line,
      character: this.character,
    };
  }

  /** 解析 LSP PublishDiagnosticsParams → LspDiagnostic[]；空/畸形输入安全返回 []。 */
  static parse_publish_diagnostics(params: Record<string, unknown> | null | undefined): LspDiagnostic[] {
    if (!params) return [];
    const raw = params["diagnostics"];
    if (!Array.isArray(raw)) return [];
    const out: LspDiagnostic[] = [];
    for (const d of raw) {
      if (typeof d !== "object" || d === null) continue;
      const dd = d as Record<string, unknown>;
      const rngRaw = dd["range"];
      const rng = (typeof rngRaw === "object" && rngRaw !== null ? rngRaw : {}) as DiagnosticRange;
      const startRaw = (rng as Record<string, unknown>)["start"];
      const start =
        typeof startRaw === "object" && startRaw !== null
          ? (startRaw as Record<string, unknown>)
          : {};
      const sev = dd["severity"];
      let severity: string;
      if (typeof sev === "number") {
        severity = _LSP_SEVERITY_TO_STR[sev] ?? "info";
      } else if (typeof sev === "string") {
        severity = sev;
      } else {
        severity = "info";
      }
      out.push(
        new LspDiagnostic(
          rng,
          severity,
          String(dd["message"] ?? "") || "",
          (String(dd["source"] ?? "") || "lsp") as string,
          Math.trunc(Number(start["line"] ?? 0) || 0),
          Math.trunc(Number(start["character"] ?? 0) || 0)
        )
      );
    }
    return out;
  }
}

// The [key: string]: unknown index signature above breaks class field init
// typing unless the real fields are assigned in the constructor; TS allows
// the declared fields alongside an index signature only when the fields are
// also assignable to unknown (they are). Keep the accessor helper explicit:
export function diag_get(d: LspDiagnostic, key: string): unknown {
  return (d as unknown as Record<string, unknown>)[key];
}

export class LspDiagnosticTransport {
  /** 传输抽象基类。publish_diagnostics(uri) 返回 PublishDiagnosticsParams 或 {}。 */
  publish_diagnostics(_uri: string): Record<string, unknown> {
    return {}; // pragma: no cover — 基类
  }
}

export class FakeLspTransport extends LspDiagnosticTransport {
  /** 内存 transport：push_diagnostics(uri, params) 注入，供测试与离线使用。 */
  private _store: Map<string, Record<string, unknown>>;

  constructor() {
    super();
    this._store = new Map();
  }

  push_diagnostics(uri: string, params: Record<string, unknown>): void {
    this._store.set(uri, params);
  }

  override publish_diagnostics(uri: string): Record<string, unknown> {
    return this._store.get(uri) ?? {};
  }
}

export class LspDiagnosticClient {
  /** 持有一个 transport + 工作区根，对外暴露 diagnostics_for_file。 */
  transport: LspDiagnosticTransport;
  root_uri: string;

  constructor(transport: LspDiagnosticTransport, root_uri = "") {
    this.transport = transport;
    this.root_uri = root_uri;
  }

  diagnostics_for_file(workspace: string, logical_path: string, _content?: unknown): LspDiagnostic[] {
    const uri = workspace
      ? _path_to_uri(path.join(workspace, logical_path))
      : _path_to_uri(logical_path);
    const params = this.transport.publish_diagnostics(uri);
    return LspDiagnostic.parse_publish_diagnostics(params);
  }
}

export class StdioLspTransport extends LspDiagnosticTransport {
  /** 尽力而为的真实 LSP transport（spawn + Content-Length 帧 + 缓存 publishDiagnostics）。
   *
   * 全部通信包在 try/except 里、启动/握手失败就把 available 置 False 并安全
   * 返回 {}——绝不让诊断查询卡住或炸掉预校验。
   */
  command: string[];
  root_uri: string;
  timeout_s: number;
  available = false;
  private _store = new Map<string, Record<string, unknown>>();
  private _proc: ChildProcess | null = null;
  private _req_id = 0;

  constructor(command: string[], root_uri: string, timeout_s = 8.0) {
    super();
    this.command = [...command];
    this.root_uri = root_uri;
    this.timeout_s = timeout_s;
    this._start();
  }

  private _start(): void {
    try {
      this._proc = spawn(this.command[0]!, this.command.slice(1), {
        stdio: ["pipe", "pipe", "ignore"],
      });
      // 最小握手（initialize / initialized / 不等待完整能力协商）。
      this._send({
        jsonrpc: "2.0",
        id: this._next_id(),
        method: "initialize",
        params: { rootUri: this.root_uri || null, capabilities: {} },
      });
      // 后台读：只认 publishDiagnostics，其余忽略；任何异常都静默退出。
      // (The Python version spawns a daemon thread; the Node event loop plays
      // that role — the async reader below never blocks the caller.)
      void this._readerLoop();
      this.available = true;
    } catch (exc) {
      console.warn(`StdioLspTransport: failed to start LSP server ${this.command}: ${exc}`);
      this.available = false;
    }
  }

  private async _readerLoop(): Promise<void> {
    // Mirrors the Python reader thread: silent exit on any error; only
    // textDocument/publishDiagnostics is recorded.
    try {
      const proc = this._proc;
      if (!proc || !proc.stdout) return;
      let buf = Buffer.alloc(0);
      for await (const chunk of proc.stdout) {
        buf = Buffer.concat([buf, chunk as Buffer]);
        for (;;) {
          const headerEnd = buf.indexOf("\r\n\r\n");
          const headerEndLf = headerEnd === -1 ? buf.indexOf("\n\n") : headerEnd;
          const end = headerEnd !== -1 ? headerEnd : headerEndLf;
          if (end === -1) break;
          const header = buf.subarray(0, end).toString("utf-8");
          const clMatch = /content-length:\s*(\d+)/i.exec(header);
          const bodyStart = end + (headerEnd !== -1 ? 4 : 2);
          const cl = clMatch ? Number(clMatch[1]) : 0;
          if (cl <= 0 || buf.length < bodyStart + cl) break;
          const body = buf.subarray(bodyStart, bodyStart + cl).toString("utf-8");
          buf = buf.subarray(bodyStart + cl);
          try {
            const msg = JSON.parse(body) as Record<string, unknown>;
            if (msg["method"] === "textDocument/publishDiagnostics") {
              const p = (msg["params"] ?? {}) as Record<string, unknown>;
              this._store.set(String(p["uri"] ?? ""), p);
            }
          } catch {
            // malformed frame — skip it, keep reading
          }
        }
      }
    } catch {
      return;
    }
  }

  private _next_id(): number {
    this._req_id += 1;
    return this._req_id;
  }

  private _send(obj: unknown): void {
    const body = JSON.stringify(obj);
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}\n`;
    this._proc?.stdin?.write(frame);
  }

  did_open(uri: string, language_id: string, text: string): void {
    if (!this.available) return;
    try {
      this._send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: language_id, version: 1, text },
        },
      });
    } catch {
      // except Exception: pass
    }
  }

  override publish_diagnostics(uri: string): Record<string, unknown> {
    if (!this.available) return {};
    return this._store.get(uri) ?? {};
  }

  shutdown(): void {
    try {
      if (this._proc && this._proc.exitCode === null) {
        this._proc.kill();
      }
    } catch {
      // except Exception: pass
    }
  }
}

export function create_stdio_lsp_client(
  command: string[],
  root_uri = ""
): LspDiagnosticClient {
  /** 按命令启动一个真实 LSP 子进程并返回诊断客户端（启动失败则 available=False）。 */
  return new LspDiagnosticClient(new StdioLspTransport(command, root_uri), root_uri);
}

// ── 全局诊断会话（由 router / 配置在启动时注入；不注入则默认无会话 → 返回 []） ──

let _GLOBAL_DIAGNOSTIC_CLIENT: LspDiagnosticClient | null = null;
let _NO_SESSION_WARNED = false;

export function set_lsp_diagnostic_client(client: LspDiagnosticClient | null): void {
  /** 注册当前进程的活跃 LSP 诊断会话（传 null 可清空）。 */
  _GLOBAL_DIAGNOSTIC_CLIENT = client;
  _NO_SESSION_WARNED = false;
}

export function diagnostics_for_file(
  workspace: string,
  logical_path = "",
  content?: unknown
): LspDiagnostic[] {
  /** 查询当前活跃 LSP 会话，返回 logical_path 的诊断列表。
   *
   * 兼容两种调用风格：diagnostics_for_file(workspace, logical_path, content)
   * 与 diagnostics_for_file(file_path)。无会话时返回 [] 并记一条（限流）
   * warning——不抛异常，调用方据此跳过 LSP 校验而不是误判为"无错"。
   */
  // 单参数便捷写法：把 file_path 拆成 workspace 根 + 相对名。
  if (!logical_path) {
    const file_path = workspace;
    workspace = path.dirname(file_path) || ".";
    logical_path = path.basename(file_path);
  }

  const client = _GLOBAL_DIAGNOSTIC_CLIENT;
  if (client === null) {
    if (!_NO_SESSION_WARNED) {
      _NO_SESSION_WARNED = true;
      console.warn(
        "diagnostics_for_file: no active LSP diagnostic session configured " +
          "(set_lsp_diagnostic_client); returning [] — LSP checks are SKIPPED, not passed."
      );
    }
    return [];
  }
  try {
    return client.diagnostics_for_file(workspace, logical_path, content);
  } catch (exc) {
    console.warn(
      `diagnostics_for_file: LSP session error for ${workspace}/${logical_path}: ${exc}; returning []`
    );
    return [];
  }
}
