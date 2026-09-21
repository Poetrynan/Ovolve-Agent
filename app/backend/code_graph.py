# -*- coding: utf-8 -*-
"""code_graph.py - CKG-lite (Code Knowledge Graph lite) for Ovolve.

Phase 4: AST-based Code Knowledge Graph & Symbol Reference Index.
Extracts definitions (classes, functions, methods), calls, imports, and inheritance
relationships into a lightweight embedded SQLite store for sub-millisecond symbol lookup,
call-hierarchy analysis, and pre-refactor impact assessment.
"""
from __future__ import annotations

import ast
import hashlib
import json
import logging
import os
import sqlite3
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from result import Result

logger = logging.getLogger("ovolve.code_graph")

_DEFAULT_IGNORE_DIRS = {
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
}


@dataclass
class CodeSymbol:
    id: str
    name: str
    kind: str  # "class", "function", "method", "module"
    file: str
    line: int
    end_line: int
    scope: str = ""
    docstring: Optional[str] = None
    params: List[str] = field(default_factory=list)


@dataclass
class CodeEdge:
    src_id: str
    src_name: str
    dst_name: str
    kind: str  # "calls", "imports", "inherits", "defines"
    file: str
    line: int


class ASTGraphExtractor(ast.NodeVisitor):
    """Walks Python AST to extract symbols and dependency edges."""

    def __init__(self, file_path: str):
        self.file_path = file_path
        self.symbols: List[CodeSymbol] = []
        self.edges: List[CodeEdge] = []
        self._scope_stack: List[Tuple[str, str, str]] = []  # (kind, name, symbol_id)

    def _current_scope(self) -> Tuple[str, str, str]:
        if self._scope_stack:
            return self._scope_stack[-1]
        return ("module", os.path.basename(self.file_path), self.file_path)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        symbol_id = f"{self.file_path}:{node.lineno}:class:{node.name}"
        parent_scope = self._current_scope()[1] if self._scope_stack else ""
        docstring = ast.get_docstring(node)
        end_line = getattr(node, "end_lineno", node.lineno)

        sym = CodeSymbol(
            id=symbol_id,
            name=node.name,
            kind="class",
            file=self.file_path,
            line=node.lineno,
            end_line=end_line,
            scope=parent_scope,
            docstring=docstring,
            params=[],
        )
        self.symbols.append(sym)

        # Inheritance edges
        for base in node.bases:
            base_name = ""
            if isinstance(base, ast.Name):
                base_name = base.id
            elif isinstance(base, ast.Attribute):
                base_name = base.attr
            if base_name:
                self.edges.append(
                    CodeEdge(
                        src_id=symbol_id,
                        src_name=node.name,
                        dst_name=base_name,
                        kind="inherits",
                        file=self.file_path,
                        line=node.lineno,
                    )
                )

        self._scope_stack.append(("class", node.name, symbol_id))
        self.generic_visit(node)
        self._scope_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._handle_func(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._handle_func(node)

    def _handle_func(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        parent_kind, parent_name, parent_id = self._current_scope()
        kind = "method" if parent_kind == "class" else "function"
        symbol_id = f"{self.file_path}:{node.lineno}:{kind}:{node.name}"
        docstring = ast.get_docstring(node)
        end_line = getattr(node, "end_lineno", node.lineno)

        params = [arg.arg for arg in node.args.args]

        sym = CodeSymbol(
            id=symbol_id,
            name=node.name,
            kind=kind,
            file=self.file_path,
            line=node.lineno,
            end_line=end_line,
            scope=parent_name if parent_kind == "class" else "",
            docstring=docstring,
            params=params,
        )
        self.symbols.append(sym)

        # Definition edge
        self.edges.append(
            CodeEdge(
                src_id=parent_id,
                src_name=parent_name,
                dst_name=node.name,
                kind="defines",
                file=self.file_path,
                line=node.lineno,
            )
        )

        self._scope_stack.append((kind, node.name, symbol_id))
        self.generic_visit(node)
        self._scope_stack.pop()

    def visit_Import(self, node: ast.Import) -> None:
        _, scope_name, scope_id = self._current_scope()
        for alias in node.names:
            self.edges.append(
                CodeEdge(
                    src_id=scope_id,
                    src_name=scope_name,
                    dst_name=alias.name,
                    kind="imports",
                    file=self.file_path,
                    line=node.lineno,
                )
            )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        _, scope_name, scope_id = self._current_scope()
        mod = node.module or ""
        for alias in node.names:
            imported_name = alias.name
            full_dst = f"{mod}.{imported_name}" if mod else imported_name
            self.edges.append(
                CodeEdge(
                    src_id=scope_id,
                    src_name=scope_name,
                    dst_name=imported_name,
                    kind="imports",
                    file=self.file_path,
                    line=node.lineno,
                )
            )

    def visit_Call(self, node: ast.Call) -> None:
        _, scope_name, scope_id = self._current_scope()
        call_name = ""
        if isinstance(node.func, ast.Name):
            call_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            call_name = node.func.attr

        if call_name:
            self.edges.append(
                CodeEdge(
                    src_id=scope_id,
                    src_name=scope_name,
                    dst_name=call_name,
                    kind="calls",
                    file=self.file_path,
                    line=node.lineno,
                )
            )
        self.generic_visit(node)


class CodeKnowledgeGraph:
    """Embedded SQLite-based Code Knowledge Graph for fast AST symbol and call navigation."""

    def __init__(self, db_path: str = ":memory:"):
        self.db_path = db_path
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._init_schema()

    def _init_schema(self) -> None:
        with self._conn:
            self._conn.executescript(
                """
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
                """
            )

    def close(self) -> None:
        if self._conn:
            self._conn.close()

    def index_file(self, file_path: str, force: bool = False) -> bool:
        """Indexes or incrementally refreshes a Python source file.

        Returns True if newly indexed or reindexed; False if skipped or failed.
        """
        norm_path = os.path.abspath(file_path)
        if not os.path.isfile(norm_path) or not norm_path.endswith(".py"):
            return False

        try:
            stat = os.stat(norm_path)
            mtime = stat.st_mtime
        except OSError:
            return False

        if not force:
            row = self._conn.execute(
                "SELECT mtime FROM cg_files WHERE path = ?", (norm_path,)
            ).fetchone()
            if row and abs(row["mtime"] - mtime) < 1e-4:
                return False

        try:
            with open(norm_path, "rb") as f:
                content_bytes = f.read()
            file_hash = hashlib.sha256(content_bytes).hexdigest()
            tree = ast.parse(content_bytes.decode("utf-8", errors="replace"), filename=norm_path)
        except (SyntaxError, OSError, Exception) as exc:
            logger.debug("Failed to parse %s: %s", norm_path, exc)
            return False

        extractor = ASTGraphExtractor(norm_path)
        try:
            extractor.visit(tree)
        except Exception as exc:
            logger.debug("Extraction error on %s: %s", norm_path, exc)
            return False

        # Bulk write transaction
        now = time.time()
        with self._conn:
            self._conn.execute("DELETE FROM cg_symbols WHERE file = ?", (norm_path,))
            self._conn.execute("DELETE FROM cg_edges WHERE file = ?", (norm_path,))

            for s in extractor.symbols:
                self._conn.execute(
                    """
                    INSERT OR REPLACE INTO cg_symbols
                    (id, name, kind, file, line, end_line, scope, docstring, params)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        s.id,
                        s.name,
                        s.kind,
                        s.file,
                        s.line,
                        s.end_line,
                        s.scope,
                        s.docstring,
                        json.dumps(s.params),
                    ),
                )

            for e in extractor.edges:
                self._conn.execute(
                    """
                    INSERT INTO cg_edges
                    (src_id, src_name, dst_name, kind, file, line)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (e.src_id, e.src_name, e.dst_name, e.kind, e.file, e.line),
                )

            self._conn.execute(
                """
                INSERT OR REPLACE INTO cg_files
                (path, mtime, file_hash, symbol_count, indexed_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (norm_path, mtime, file_hash, len(extractor.symbols), now),
            )

        return True

    def remove_file(self, file_path: str) -> None:
        """Purges a deleted file and its symbols/edges from the graph."""
        norm_path = os.path.abspath(file_path)
        with self._conn:
            self._conn.execute("DELETE FROM cg_files WHERE path = ?", (norm_path,))
            self._conn.execute("DELETE FROM cg_symbols WHERE file = ?", (norm_path,))
            self._conn.execute("DELETE FROM cg_edges WHERE file = ?", (norm_path,))

    def index_workspace(
        self,
        workspace_dir: str,
        incremental: bool = True,
        max_files: int = 2000,
        ignore_dirs: Optional[Set[str]] = None,
    ) -> Dict[str, Any]:
        """Indexes all Python files under workspace_dir."""
        ws = os.path.abspath(workspace_dir)
        ignores = set(ignore_dirs or _DEFAULT_IGNORE_DIRS)

        indexed = 0
        skipped = 0
        errors = 0

        py_files: List[str] = []
        for root, dirs, files in os.walk(ws):
            dirs[:] = [d for d in dirs if d not in ignores and not d.startswith(".")]
            for fn in files:
                if fn.endswith(".py"):
                    py_files.append(os.path.join(root, fn))
                    if len(py_files) >= max_files:
                        break
            if len(py_files) >= max_files:
                break

        for fp in py_files:
            try:
                changed = self.index_file(fp, force=not incremental)
                if changed:
                    indexed += 1
                else:
                    skipped += 1
            except Exception:
                errors += 1

        summary = self.get_summary()
        return {
            "indexed_files": indexed,
            "skipped_files": skipped,
            "error_files": errors,
            "total_files": summary["total_files"],
            "total_symbols": summary["total_symbols"],
            "total_edges": summary["total_edges"],
        }

    def find_definitions(self, name: str) -> List[Dict[str, Any]]:
        """Finds symbol definition records matching exact name."""
        rows = self._conn.execute(
            """
            SELECT id, name, kind, file, line, end_line, scope, docstring, params
            FROM cg_symbols
            WHERE name = ?
            ORDER BY file ASC, line ASC
            """,
            (name,),
        ).fetchall()

        out = []
        for r in rows:
            out.append({
                "id": r["id"],
                "name": r["name"],
                "kind": r["kind"],
                "file": r["file"],
                "line": r["line"],
                "end_line": r["end_line"],
                "scope": r["scope"],
                "docstring": r["docstring"],
                "params": json.loads(r["params"] or "[]"),
            })
        return out

    def find_references(self, name: str) -> List[Dict[str, Any]]:
        """Finds all usages, calls, and imports referencing the given symbol name."""
        rows = self._conn.execute(
            """
            SELECT e.id, e.src_id, e.src_name, e.dst_name, e.kind, e.file, e.line,
                   s.kind as caller_kind, s.scope as caller_scope
            FROM cg_edges e
            LEFT JOIN cg_symbols s ON e.src_id = s.id
            WHERE e.dst_name = ?
            ORDER BY e.file ASC, e.line ASC
            """,
            (name,),
        ).fetchall()

        out = []
        for r in rows:
            out.append({
                "edge_id": r["id"],
                "src_id": r["src_id"],
                "src_name": r["src_name"],
                "caller_name": r["src_name"],
                "caller_kind": r["caller_kind"] or "module",
                "caller_scope": r["caller_scope"] or "",
                "dst_name": r["dst_name"],
                "kind": r["kind"],
                "file": r["file"],
                "line": r["line"],
            })
        return out

    def find_callers(self, name: str) -> List[Dict[str, Any]]:
        """Returns only call references for the target symbol."""
        refs = self.find_references(name)
        return [r for r in refs if r["kind"] == "calls"]

    def find_callees(self, symbol_name: str) -> List[Dict[str, Any]]:
        """Finds all outgoing function calls made from symbol_name."""
        rows = self._conn.execute(
            """
            SELECT id, src_id, src_name, dst_name, kind, file, line
            FROM cg_edges
            WHERE src_name = ? AND kind = 'calls'
            ORDER BY line ASC
            """,
            (symbol_name,),
        ).fetchall()

        out = []
        for r in rows:
            out.append({
                "src_name": r["src_name"],
                "dst_name": r["dst_name"],
                "kind": r["kind"],
                "file": r["file"],
                "line": r["line"],
            })
        return out

    def neighbors(
        self,
        symbol_name: str,
        depth: int = 1,
        edge_kinds: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Breadth-first neighborhood subgraph query up to `depth` hops."""
        visited_nodes: Set[str] = {symbol_name}
        nodes_info: Dict[str, Dict[str, Any]] = {
            symbol_name: {"name": symbol_name, "kind": "symbol"}
        }
        collected_edges: List[Dict[str, Any]] = []

        frontier = {symbol_name}
        for _ in range(depth):
            if not frontier:
                break
            next_frontier: Set[str] = set()
            for current in frontier:
                # Outgoing edges
                out_rows = self._conn.execute(
                    "SELECT src_name, dst_name, kind, file, line FROM cg_edges WHERE src_name = ?",
                    (current,),
                ).fetchall()
                for r in out_rows:
                    if edge_kinds and r["kind"] not in edge_kinds:
                        continue
                    dst = r["dst_name"]
                    collected_edges.append({
                        "source": r["src_name"],
                        "target": dst,
                        "kind": r["kind"],
                        "file": r["file"],
                        "line": r["line"],
                    })
                    if dst not in visited_nodes:
                        visited_nodes.add(dst)
                        nodes_info[dst] = {"name": dst, "kind": "target"}
                        next_frontier.add(dst)

                # Incoming edges
                in_rows = self._conn.execute(
                    "SELECT src_name, dst_name, kind, file, line FROM cg_edges WHERE dst_name = ?",
                    (current,),
                ).fetchall()
                for r in in_rows:
                    if edge_kinds and r["kind"] not in edge_kinds:
                        continue
                    src = r["src_name"]
                    collected_edges.append({
                        "source": src,
                        "target": r["dst_name"],
                        "kind": r["kind"],
                        "file": r["file"],
                        "line": r["line"],
                    })
                    if src not in visited_nodes:
                        visited_nodes.add(src)
                        nodes_info[src] = {"name": src, "kind": "caller"}
                        next_frontier.add(src)

            frontier = next_frontier

        return {
            "root": symbol_name,
            "depth": depth,
            "nodes": list(nodes_info.values()),
            "edges": collected_edges,
        }

    def assess_symbol_impact(self, symbol_name: str) -> Dict[str, Any]:
        """Pre-refactoring impact assessment: caller count, affected files, and callers."""
        callers = self.find_callers(symbol_name)
        affected_files = sorted({c["file"] for c in callers})
        unique_callers = sorted({c["caller_name"] for c in callers})

        return {
            "symbol": symbol_name,
            "caller_count": len(callers),
            "affected_files": affected_files,
            "callers": unique_callers,
            "details": callers,
        }

    def get_file_symbols(self, file_path: str) -> List[Dict[str, Any]]:
        """Lists all symbols declared in a specific file."""
        norm_path = os.path.abspath(file_path)
        rows = self._conn.execute(
            """
            SELECT id, name, kind, file, line, end_line, scope, docstring
            FROM cg_symbols
            WHERE file = ?
            ORDER BY line ASC
            """,
            (norm_path,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_summary(self) -> Dict[str, int]:
        """Returns overview counts of the indexed knowledge graph."""
        total_files = self._conn.execute("SELECT COUNT(*) as c FROM cg_files").fetchone()["c"]
        total_symbols = self._conn.execute("SELECT COUNT(*) as c FROM cg_symbols").fetchone()["c"]
        total_edges = self._conn.execute("SELECT COUNT(*) as c FROM cg_edges").fetchone()["c"]
        return {
            "total_files": total_files,
            "total_symbols": total_symbols,
            "total_edges": total_edges,
        }


def execute_code_references_tool(args: Dict[str, Any], ctx: Dict[str, Any]) -> Result:
    """Tool execution handler for `code_references`.

    Args:
        args: {"symbol": str, "include_callers": bool, "depth": int}
        ctx: context dictionary containing workspace_root or optional code_graph instance
    """
    symbol = (args.get("symbol") or "").strip()
    if not symbol:
        return Result.failure("Argument 'symbol' is required.")

    kg: Optional[CodeKnowledgeGraph] = ctx.get("code_graph")
    ws = ctx.get("workspace_root") or os.getcwd()

    should_close = False
    if kg is None:
        db_path = os.path.join(ws, ".ovolve", "code_graph.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        kg = CodeKnowledgeGraph(db_path=db_path)
        should_close = True
        # Quick sync workspace if db is empty
        summary = kg.get_summary()
        if summary["total_files"] == 0:
            kg.index_workspace(ws)

    try:
        definitions = kg.find_definitions(symbol)
        references = kg.find_references(symbol)
        impact = kg.assess_symbol_impact(symbol)

        lines = [f"### 🔍 Symbol Analysis: `{symbol}`"]
        if definitions:
            lines.append(f"\n**Definitions ({len(definitions)}):**")
            for d in definitions:
                rel = os.path.relpath(d["file"], ws) if ws else d["file"]
                lines.append(f"- [{d['kind']}] `{rel}:{d['line']}` (scope: `{d['scope'] or 'top-level'}`)")
        else:
            lines.append("\n*(No local definition found in indexed workspace)*")

        call_refs = [r for r in references if r["kind"] == "calls"]
        import_refs = [r for r in references if r["kind"] == "imports"]
        inherit_refs = [r for r in references if r["kind"] == "inherits"]

        lines.append(f"\n**References & Usages ({len(references)} total):**")
        lines.append(f"- 📞 **Callers ({len(call_refs)})**: in {len(impact['affected_files'])} files")
        for c in call_refs[:20]:
            rel = os.path.relpath(c["file"], ws) if ws else c["file"]
            lines.append(f"  - `{c['caller_name']}()` in `{rel}:{c['line']}`")
        if len(call_refs) > 20:
            lines.append(f"  - *(...and {len(call_refs) - 20} more calls)*")

        if import_refs:
            lines.append(f"- 📦 **Imported by ({len(import_refs)})**:")
            for im in import_refs[:10]:
                rel = os.path.relpath(im["file"], ws) if ws else im["file"]
                lines.append(f"  - `{rel}:{im['line']}`")

        if inherit_refs:
            lines.append(f"- 🧬 **Inherited by ({len(inherit_refs)})**:")
            for inh in inherit_refs:
                rel = os.path.relpath(inh["file"], ws) if ws else inh["file"]
                lines.append(f"  - `{inh['src_name']}` in `{rel}:{inh['line']}`")

        return Result.success("\n".join(lines))
    finally:
        if should_close and kg is not None:
            kg.close()
