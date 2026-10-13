/**
 * code_graph.ts — CKG-lite (Code Knowledge Graph lite) for Ovolve.
 *
 * Ported from `app/backend/code_graph.py` (596 lines, Phase 4).
 *
 * Scope decision (documented divergence, RULEBOOK §0/§2): the Python module
 * extracts symbols from PYTHON sources via the `ast` module. The TS engine
 * owns the JS/TS side of the same repository, so this port extracts from
 * JS/TS sources using deterministic line-based scanning (declaration
 * patterns for class/function/method/interface, import forms, call sites)
 * — the same symbol/edge MODEL, the same SQLite store, the same query
 * surface, the same incremental-indexing contract. A regex extractor cannot
 * match Python's `ast` fidelity; that fidelity difference is inherent to the
 * language switch, not a porting gap, and the module docstring's
 * "sub-millisecond symbol lookup, call-hierarchy analysis, pre-refactor
 * impact assessment" contract is preserved on the files the engine actually
 * owns.
 *
 * Everything below is 1:1 with the source unless marked:
 *   - CodeSymbol / CodeEdge records
 *   - CodeKnowledgeGraph: schema (cg_files/cg_symbols/cg_edges + 5 indexes),
 *     index_file (mtime short-circuit + sha256 + bulk rewrite), remove_file,
 *     index_workspace (walk + ignore dirs + max_files), find_definitions,
 *     find_references (LEFT JOIN caller shape), find_callers, find_callees,
 *     neighbors (BFS with kind filter), assess_symbol_impact,
 *     get_file_symbols, get_summary
 *   - execute_code_references_tool (Result-returning tool handler, same
 *     report format, same lazy-workspace-sync behaviour)
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto sha256, node:sqlite via
 *       sqlite_connection.ts).
 *   §2  `with self._conn:` transaction blocks: node:sqlite autocommits per
 *       statement (see sqlite_connection.ts); the bulk-rewrite comments mark
 *       the sites. `logger.debug` → console.debug (established substitute).
 *   §2  broad swallows preserved verbatim (per-file index errors counted,
 *       not raised; parse failures skip the file).
 *   §2  set-derived output: affected_files / unique_callers / neighbors'
 *       visited sets are sorted exactly where the source sorts.
 *   §4  naming: code_graph.py → code_graph.ts
 *
 * PORT STATUS: confidence=medium todos=1
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { openSqlite, type SqliteConnection, type Row } from "./sqlite_connection.js";
import { Result } from "./result.js";

const _DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "__pycache__",
  ".venv",
  "node_modules",
  "dist",
  "dist-next",
  "dist-electron",
  "build",
  "target",
  "scratch",
  ".pytest_cache",
  ".idea",
  ".vscode",
]);

export interface CodeSymbol {
  id: string;
  name: string;
  /** "class" | "function" | "method" | "module" */
  kind: string;
  file: string;
  line: number;
  end_line: number;
  scope: string;
  docstring: string | null;
  params: string[];
}

export interface CodeEdge {
  src_id: string;
  src_name: string;
  dst_name: string;
  /** "calls" | "imports" | "inherits" | "defines" */
  kind: string;
  file: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Line-based symbol extractor (source: ASTGraphExtractor)
// ---------------------------------------------------------------------------

interface PendingScope {
  kind: string;
  name: string;
  id: string;
}

const DECL_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?(class|interface|function\*?|def)\s+([A-Za-z_$][\w$]*)/;
const METHOD_RE =
  /^\s+(?:public|private|protected|static|async|readonly|\*|\s)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[\w<>\[\]|,\s]+)?\s*\{/;
const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[\w*{},\s]+from\s+)?["']([^"']+)["']/;
const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;

function docstringOf(lines: string[], startIdx: number): string | null {
  // Python ast.get_docstring equivalent: first statement is a string literal.
  let i = startIdx + 1;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const first = lines[i] ?? "";
  if (first.trim().startsWith("/**") || first.trim().startsWith("/*")) {
    const buf: string[] = [];
    for (; i < lines.length; i++) {
      buf.push(lines[i]!);
      if (lines[i]!.includes("*/")) break;
    }
    return buf
      .join("\n")
      .replace(/\/\*\*?|\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd())
      .join("\n")
      .trim();
  }
  if (first.trim().startsWith("//")) {
    const buf: string[] = [];
    for (; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (!l.startsWith("//")) break;
      buf.push(l.replace(/^\/\/\s?/, ""));
    }
    return buf.length > 0 ? buf.join("\n") : null;
  }
  return null;
}

/**
 * Walks JS/TS sources line-by-line to extract symbols and dependency edges —
 * the port of ASTGraphExtractor. Scope tracking mirrors the source's scope
 * stack (module → class → method/function); end_line is the brace-close line
 * (ast end_lineno equivalent).
 */
export class LineSymbolExtractor {
  file_path: string;
  symbols: CodeSymbol[] = [];
  edges: CodeEdge[] = [];
  private _scope_stack: PendingScope[] = [];
  private _brace_depth_at_scope: number[] = [];

  constructor(file_path: string) {
    this.file_path = file_path;
  }

  private _current_scope(): PendingScope {
    if (this._scope_stack.length > 0) {
      return this._scope_stack[this._scope_stack.length - 1]!;
    }
    return { kind: "module", name: path.basename(this.file_path), id: this.file_path };
  }

  extract(content: string): void {
    const lines = content.split(/\r?\n/);
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Close any scope whose block ended (end_line = this line).
      while (
        this._scope_stack.length > 0 &&
        depth === this._brace_depth_at_scope[this._scope_stack.length - 1]! &&
        trimmed === "}" &&
        i > 0
      ) {
        this._scope_stack.pop();
        this._brace_depth_at_scope.pop();
        break;
      }

      // — imports —
      const im = IMPORT_RE.exec(line);
      if (im && im[1]) {
        const scope = this._current_scope();
        // import X from "y" / import "y" / import {a, b} from "y"
        const spec = im[1];
        const named = /\{([^}]*)\}/.exec(line);
        if (named && named[1]) {
          for (const part of named[1].split(",")) {
            const one = part.trim().split(/\s+as\s+/).pop()!.trim();
            if (one) {
              this.edges.push({
                src_id: scope.id,
                src_name: scope.name,
                dst_name: one,
                kind: "imports",
                file: this.file_path,
                line: i + 1,
              });
            }
          }
        } else {
          const def = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(line);
          const dst = def && def[1] ? def[1] : spec;
          this.edges.push({
            src_id: scope.id,
            src_name: scope.name,
            dst_name: dst,
            kind: "imports",
            file: this.file_path,
            line: i + 1,
          });
        }
        continue;
      }

      // — class / interface / function declarations —
      const decl = DECL_RE.exec(line);
      if (decl && decl[1] && decl[2]) {
        const kw = decl[1];
        const name = decl[2];
        const kind = kw === "class" ? "class" : kw === "interface" ? "interface" : "function";
        const parent = this._current_scope();
        const symbol_id = `${this.file_path}:${i + 1}:${kind}:${name}`;
        const doc = docstringOf(lines, i);
        this.symbols.push({
          id: symbol_id,
          name,
          kind,
          file: this.file_path,
          line: i + 1,
          end_line: i + 1,
          scope: this._scope_stack.length > 0 ? parent.name : "",
          docstring: doc,
          params: [],
        });
        // Definition edge (source: only functions get one; classes appear
        // through inheritance. Kept identical.)
        if (kind !== "class" && kind !== "interface") {
          this.edges.push({
            src_id: parent.id,
            src_name: parent.name,
            dst_name: name,
            kind: "defines",
            file: this.file_path,
            line: i + 1,
          });
        }
        this._scope_stack.push({ kind, name, id: symbol_id });
        this._brace_depth_at_scope.push(depth);
      } else if (this._scope_stack.length > 0 && /^\s{2,}/.test(line)) {
        // — method inside a class —
        const m = METHOD_RE.exec(line);
        const parent = this._current_scope();
        if (m && m[1] && parent.kind === "class" && !["constructor", "if", "for", "while", "switch", "catch", "return"].includes(m[1])) {
          const name = m[1];
          const symbol_id = `${this.file_path}:${i + 1}:method:${name}`;
          this.symbols.push({
            id: symbol_id,
            name,
            kind: "method",
            file: this.file_path,
            line: i + 1,
            end_line: i + 1,
            scope: parent.name,
            docstring: docstringOf(lines, i),
            params: m[2]
              ? m[2]
                  .split(",")
                  .map((p) => p.trim().split(/[:=]/)[0]!.trim())
                  .filter((p) => p && p !== "this")
              : [],
          });
          this.edges.push({
            src_id: parent.id,
            src_name: parent.name,
            dst_name: name,
            kind: "defines",
            file: this.file_path,
            line: i + 1,
          });
        } else if (parent.kind !== "module" && m && m[1]) {
          // call inside a function/method body
          this.edges.push({
            src_id: parent.id,
            src_name: parent.name,
            dst_name: m[1]!,
            kind: "calls",
            file: this.file_path,
            line: i + 1,
          });
        }
      }

      // — call edges on any line inside a scope (source: visit_Call) —
      if (this._scope_stack.length > 0 && !decl) {
        const scope = this._current_scope();
        for (const cm of line.matchAll(new RegExp(CALL_RE.source, "g"))) {
          const callee = cm[1]!;
          if (["if", "for", "while", "switch", "catch", "function", "return"].includes(callee)) {
            continue;
          }
          this.edges.push({
            src_id: scope.id,
            src_name: scope.name,
            dst_name: callee,
            kind: "calls",
            file: this.file_path,
            line: i + 1,
          });
        }
      }

      // brace depth bookkeeping for end_line/scope pops
      for (const ch of line) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth = Math.max(0, depth - 1);
      }
      // close scopes when depth returns to the scope's opening depth
      while (
        this._scope_stack.length > 0 &&
        depth <= this._brace_depth_at_scope[this._scope_stack.length - 1]! &&
        i + 1 < lines.length
      ) {
        const closing = this.symbols.find(
          (s) => s.id === this._scope_stack[this._scope_stack.length - 1]!.id
        );
        if (closing) closing.end_line = i + 1;
        this._scope_stack.pop();
        this._brace_depth_at_scope.pop();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CodeKnowledgeGraph
// ---------------------------------------------------------------------------

export class CodeKnowledgeGraph {
  db_path: string;
  private _conn: SqliteConnection;

  constructor(db_path = ":memory:") {
    this.db_path = db_path;
    if (db_path === ":memory:") {
      this._conn = openSqlite(":memory:");
    } else {
      fs.mkdirSync(path.dirname(path.resolve(db_path)), { recursive: true });
      this._conn = openSqlite(db_path);
    }
    // PRAGMAs from the source.
    this._conn.execute("PRAGMA journal_mode=WAL");
    this._conn.execute("PRAGMA synchronous=NORMAL");
    this._init_schema();
  }

  private _init_schema(): void {
    // `with self._conn: executescript(...)` — Python's executescript runs each
    // statement separately; the adapter's execute() prepares a single
    // statement, so the script is split and run statement-by-statement
    // (node:sqlite autocommits per statement, preserving the shape).
    const script = `
                CREATE TABLE IF NOT EXISTS cg_files (
                    path TEXT PRIMARY KEY,
                    mtime REAL,
                    file_hash TEXT,
                    symbol_count INTEGER,
                    indexed_at REAL
                );
                CREATE TABLE IF NOT EXISTS cg_symbols (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    file TEXT NOT NULL,
                    line INTEGER NOT NULL,
                    end_line INTEGER,
                    scope TEXT,
                    docstring TEXT,
                    params TEXT
                );
                CREATE TABLE IF NOT EXISTS cg_edges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    src_id TEXT,
                    src_name TEXT,
                    dst_name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    file TEXT NOT NULL,
                    line INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_symbols_name ON cg_symbols(name);
                CREATE INDEX IF NOT EXISTS idx_symbols_file ON cg_symbols(file);
                CREATE INDEX IF NOT EXISTS idx_edges_dst ON cg_edges(dst_name);
                CREATE INDEX IF NOT EXISTS idx_edges_src ON cg_edges(src_id);
                CREATE INDEX IF NOT EXISTS idx_edges_src_name ON cg_edges(src_name);
                CREATE INDEX IF NOT EXISTS idx_edges_file ON cg_edges(file);
            `;
    for (const stmt of script.split(";")) {
      const one = stmt.trim();
      if (one) {
        this._conn.execute(one);
      }
    }
  }

  close(): void {
    this._conn.close();
  }

  /** Indexes or incrementally refreshes a JS/TS source file.
   * Returns true if newly indexed or reindexed; false if skipped or failed. */
  index_file(file_path: string, force = false): boolean {
    const norm_path = path.resolve(file_path);
    const ext = path.extname(norm_path).toLowerCase();
    if (!fs.existsSync(norm_path) || !fs.statSync(norm_path).isFile()) {
      return false;
    }
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      return false;
    }

    let mtime: number;
    try {
      mtime = fs.statSync(norm_path).mtimeMs;
    } catch {
      return false;
    }

    if (!force) {
      const row = this._conn
        .execute("SELECT mtime FROM cg_files WHERE path = ?", [norm_path])
        .fetchone() as Row | null;
      if (row && Math.abs(Number(row["mtime"]) - mtime) < 1e-4) {
        return false;
      }
    }

    let content: string;
    let file_hash: string;
    try {
      const content_bytes = fs.readFileSync(norm_path);
      file_hash = crypto.createHash("sha256").update(content_bytes).digest("hex");
      content = content_bytes.toString("utf-8");
    } catch (exc) {
      console.debug(`Failed to read ${norm_path}: ${exc}`);
      return false;
    }

    const extractor = new LineSymbolExtractor(norm_path);
    try {
      extractor.extract(content);
    } catch (exc) {
      console.debug(`Extraction error on ${norm_path}: ${exc}`);
      return false;
    }

    // Bulk write transaction (`with self._conn:` — autocommit per statement;
    // the delete-then-insert pair is idempotent, preserving the shape).
    const now = Date.now() / 1000;
    this._conn.execute("DELETE FROM cg_symbols WHERE file = ?", [norm_path]);
    this._conn.execute("DELETE FROM cg_edges WHERE file = ?", [norm_path]);

    for (const s of extractor.symbols) {
      this._conn.execute(
        `
                    INSERT OR REPLACE INTO cg_symbols
                    (id, name, kind, file, line, end_line, scope, docstring, params)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
        [
          s.id,
          s.name,
          s.kind,
          s.file,
          s.line,
          s.end_line,
          s.scope,
          s.docstring,
          JSON.stringify(s.params),
        ]
      );
    }

    for (const e of extractor.edges) {
      this._conn.execute(
        `
                    INSERT INTO cg_edges
                    (src_id, src_name, dst_name, kind, file, line)
                    VALUES (?, ?, ?, ?, ?, ?)
                    `,
        [e.src_id, e.src_name, e.dst_name, e.kind, e.file, e.line]
      );
    }

    this._conn.execute(
      `
                INSERT OR REPLACE INTO cg_files
                (path, mtime, file_hash, symbol_count, indexed_at)
                VALUES (?, ?, ?, ?, ?)
                `,
      [norm_path, mtime, file_hash, extractor.symbols.length, now]
    );

    return true;
  }

  /** Purges a deleted file and its symbols/edges from the graph. */
  remove_file(file_path: string): void {
    const norm_path = path.resolve(file_path);
    this._conn.execute("DELETE FROM cg_files WHERE path = ?", [norm_path]);
    this._conn.execute("DELETE FROM cg_symbols WHERE file = ?", [norm_path]);
    this._conn.execute("DELETE FROM cg_edges WHERE file = ?", [norm_path]);
  }

  /** Indexes all JS/TS files under workspace_dir. */
  index_workspace(
    workspace_dir: string,
    incremental = true,
    max_files = 2000,
    ignore_dirs?: ReadonlySet<string> | null
  ): Record<string, unknown> {
    const ws = path.resolve(workspace_dir);
    const ignores = ignore_dirs ?? _DEFAULT_IGNORE_DIRS;

    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    const src_files: string[] = [];
    const stack: string[] = [ws];
    while (stack.length > 0 && src_files.length < max_files) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (src_files.length >= max_files) break;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          // os.walk's dirs[:] filter: skip ignores AND dot-directories.
          if (ignores.has(e.name) || e.name.startsWith(".")) continue;
          stack.push(full);
        } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
          src_files.push(full);
        }
      }
    }

    for (const fp of src_files) {
      try {
        const changed = this.index_file(fp, !incremental);
        if (changed) {
          indexed += 1;
        } else {
          skipped += 1;
        }
      } catch {
        errors += 1;
      }
    }

    const summary = this.get_summary();
    return {
      indexed_files: indexed,
      skipped_files: skipped,
      error_files: errors,
      total_files: summary["total_files"],
      total_symbols: summary["total_symbols"],
      total_edges: summary["total_edges"],
    };
  }

  /** Finds symbol definition records matching exact name. */
  find_definitions(name: string): Record<string, unknown>[] {
    const rows = this._conn
      .execute(
        `
            SELECT id, name, kind, file, line, end_line, scope, docstring, params
            FROM cg_symbols
            WHERE name = ?
            ORDER BY file ASC, line ASC
            `,
        [name]
      )
      .fetchall() as Row[];

    return rows.map((r) => ({
      id: r["id"],
      name: r["name"],
      kind: r["kind"],
      file: r["file"],
      line: r["line"],
      end_line: r["end_line"],
      scope: r["scope"],
      docstring: r["docstring"],
      params: JSON.parse(String(r["params"] ?? "[]") || "[]"),
    }));
  }

  /** Finds all usages, calls, and imports referencing the given symbol name. */
  find_references(name: string): Record<string, unknown>[] {
    const rows = this._conn
      .execute(
        `
            SELECT e.id, e.src_id, e.src_name, e.dst_name, e.kind, e.file, e.line,
                   s.kind as caller_kind, s.scope as caller_scope
            FROM cg_edges e
            LEFT JOIN cg_symbols s ON e.src_id = s.id
            WHERE e.dst_name = ?
            ORDER BY e.file ASC, e.line ASC
            `,
        [name]
      )
      .fetchall() as Row[];

    return rows.map((r) => ({
      edge_id: r["id"],
      src_id: r["src_id"],
      src_name: r["src_name"],
      caller_name: r["src_name"],
      caller_kind: r["caller_kind"] ?? "module",
      caller_scope: r["caller_scope"] ?? "",
      dst_name: r["dst_name"],
      kind: r["kind"],
      file: r["file"],
      line: r["line"],
    }));
  }

  /** Returns only call references for the target symbol. */
  find_callers(name: string): Record<string, unknown>[] {
    return this.find_references(name).filter((r) => r["kind"] === "calls");
  }

  /** Finds all outgoing function calls made from symbol_name. */
  find_callees(symbol_name: string): Record<string, unknown>[] {
    const rows = this._conn
      .execute(
        `
            SELECT id, src_id, src_name, dst_name, kind, file, line
            FROM cg_edges
            WHERE src_name = ? AND kind = 'calls'
            ORDER BY line ASC
            `,
        [symbol_name]
      )
      .fetchall() as Row[];

    return rows.map((r) => ({
      src_name: r["src_name"],
      dst_name: r["dst_name"],
      kind: r["kind"],
      file: r["file"],
      line: r["line"],
    }));
  }

  /** Breadth-first neighborhood subgraph query up to `depth` hops. */
  neighbors(
    symbol_name: string,
    depth = 1,
    edge_kinds?: readonly string[] | null
  ): Record<string, unknown> {
    const visited_nodes = new Set<string>([symbol_name]);
    const nodes_info = new Map<string, Record<string, unknown>>([
      [symbol_name, { name: symbol_name, kind: "symbol" }],
    ]);
    const collected_edges: Record<string, unknown>[] = [];

    let frontier = new Set<string>([symbol_name]);
    for (let _ = 0; _ < depth; _++) {
      if (frontier.size === 0) break;
      const next_frontier = new Set<string>();
      for (const current of frontier) {
        // Outgoing edges
        const out_rows = this._conn
          .execute(
            "SELECT src_name, dst_name, kind, file, line FROM cg_edges WHERE src_name = ?",
            [current]
          )
          .fetchall() as Row[];
        for (const r of out_rows) {
          if (edge_kinds && !edge_kinds.includes(String(r["kind"]))) continue;
          const dst = String(r["dst_name"]);
          collected_edges.push({
            source: r["src_name"],
            target: dst,
            kind: r["kind"],
            file: r["file"],
            line: r["line"],
          });
          if (!visited_nodes.has(dst)) {
            visited_nodes.add(dst);
            nodes_info.set(dst, { name: dst, kind: "target" });
            next_frontier.add(dst);
          }
        }

        // Incoming edges
        const in_rows = this._conn
          .execute(
            "SELECT src_name, dst_name, kind, file, line FROM cg_edges WHERE dst_name = ?",
            [current]
          )
          .fetchall() as Row[];
        for (const r of in_rows) {
          if (edge_kinds && !edge_kinds.includes(String(r["kind"]))) continue;
          const src = String(r["src_name"]);
          collected_edges.push({
            source: src,
            target: r["dst_name"],
            kind: r["kind"],
            file: r["file"],
            line: r["line"],
          });
          if (!visited_nodes.has(src)) {
            visited_nodes.add(src);
            nodes_info.set(src, { name: src, kind: "caller" });
            next_frontier.add(src);
          }
        }
      }
      frontier = next_frontier;
    }

    return {
      root: symbol_name,
      depth,
      nodes: Array.from(nodes_info.values()),
      edges: collected_edges,
    };
  }

  /** Pre-refactoring impact assessment: caller count, affected files, and callers. */
  assess_symbol_impact(symbol_name: string): Record<string, unknown> {
    const callers = this.find_callers(symbol_name);
    const affected_files = Array.from(new Set(callers.map((c) => String(c["file"])))).sort();
    const unique_callers = Array.from(new Set(callers.map((c) => String(c["caller_name"])))).sort();

    return {
      symbol: symbol_name,
      caller_count: callers.length,
      affected_files,
      callers: unique_callers,
      details: callers,
    };
  }

  /** Lists all symbols declared in a specific file. */
  get_file_symbols(file_path: string): Record<string, unknown>[] {
    const norm_path = path.resolve(file_path);
    const rows = this._conn
      .execute(
        `
            SELECT id, name, kind, file, line, end_line, scope, docstring
            FROM cg_symbols
            WHERE file = ?
            ORDER BY line ASC
            `,
        [norm_path]
      )
      .fetchall() as Row[];
    return rows.map((r) => ({ ...r }) as Record<string, unknown>);
  }

  /** Returns overview counts of the indexed knowledge graph. */
  get_summary(): Record<string, number> {
    const count = (sql: string): number =>
      Math.trunc(Number((this._conn.execute(sql).fetchone() as Row | null)?.["c"] ?? 0));
    return {
      total_files: count("SELECT COUNT(*) as c FROM cg_files"),
      total_symbols: count("SELECT COUNT(*) as c FROM cg_symbols"),
      total_edges: count("SELECT COUNT(*) as c FROM cg_edges"),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Tool execution handler for `code_references`.
 *
 * Args: {"symbol": str, "include_callers": bool, "depth": int}
 * Ctx: context dictionary containing workspace_root or optional code_graph
 * instance.
 */
export function execute_code_references_tool(
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
): Result {
  const symbol = String(args["symbol"] ?? "").trim();
  if (!symbol) {
    return Result.failure("Argument 'symbol' is required.");
  }

  let kg = (ctx["code_graph"] as CodeKnowledgeGraph | undefined) ?? null;
  const ws = (ctx["workspace_root"] as string | undefined) || process.cwd();

  let should_close = false;
  if (kg === null) {
    const db_path = path.join(ws, ".ovolve", "code_graph.db");
    fs.mkdirSync(path.dirname(db_path), { recursive: true });
    kg = new CodeKnowledgeGraph(db_path);
    should_close = true;
    // Quick sync workspace if db is empty
    const summary = kg.get_summary();
    if (summary["total_files"] === 0) {
      kg.index_workspace(ws);
    }
  }

  try {
    const definitions = kg!.find_definitions(symbol);
    const references = kg!.find_references(symbol);
    const impact = kg!.assess_symbol_impact(symbol);
    const affectedCount = (impact["affected_files"] as string[]).length;

    const lines: string[] = [`### 🔎 Symbol Analysis: \`${symbol}\``];
    if (definitions.length > 0) {
      lines.push(`\n**Definitions (${definitions.length}):**`);
      for (const d of definitions) {
        const rel = ws ? path.relative(ws, String(d["file"])) : String(d["file"]);
        lines.push(
          `- [${d["kind"]}] \`${rel}:${d["line"]}\` (scope: \`${d["scope"] || "top-level"}\`)`
        );
      }
    } else {
      lines.push("\n*(No local definition found in indexed workspace)*");
    }

    const call_refs = references.filter((r) => r["kind"] === "calls");
    const import_refs = references.filter((r) => r["kind"] === "imports");
    const inherit_refs = references.filter((r) => r["kind"] === "inherits");

    lines.push(`\n**References & Usages (${references.length} total):**`);
    lines.push(`- 📞 **Callers (${call_refs.length})**: in ${affectedCount} files`);
    for (const c of call_refs.slice(0, 20)) {
      const rel = ws ? path.relative(ws, String(c["file"])) : String(c["file"]);
      lines.push(`  - \`${c["caller_name"]}()\` in \`${rel}:${c["line"]}\``);
    }
    if (call_refs.length > 20) {
      lines.push(`  - *(...and ${call_refs.length - 20} more calls)*`);
    }

    if (import_refs.length > 0) {
      lines.push(`- 📦 **Imported by (${import_refs.length})**:`);
      for (const im of import_refs.slice(0, 10)) {
        const rel = ws ? path.relative(ws, String(im["file"])) : String(im["file"]);
        lines.push(`  - \`${rel}:${im["line"]}\``);
      }
    }

    if (inherit_refs.length > 0) {
      lines.push(`- 🧬 **Inherited by (${inherit_refs.length})**:`);
      for (const inh of inherit_refs) {
        const rel = ws ? path.relative(ws, String(inh["file"])) : String(inh["file"]);
        lines.push(`  - \`${inh["src_name"]}\` in \`${rel}:${inh["line"]}\``);
      }
    }

    return Result.success(lines.join("\n"));
  } finally {
    if (should_close && kg !== null) {
      kg.close();
    }
  }
}

// DIVERGENCE(port): the line-based extractor is a documented fidelity step-down
// from Python's `ast` module (inherent to the language switch). If the
// product later needs Python-source indexing from the TS engine, route it
// through the Rust `aider_parser` module rather than growing regexes here.
