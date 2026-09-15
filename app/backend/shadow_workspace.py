"""shadow_workspace.py — 完整影子工作区校验管线（本地优先）

## 能力

1. **单文件语法**：py_compile / json / toml
2. **LSP 诊断**：本地 pyright、tsserver、rust-analyzer、gopls（有则用，无则跳过）
3. **项目级探针**：复用 ``verify_gate.probe`` + standing permission（tsc / pytest / cargo …）
4. **Staged overlay 全量校验**：对 ``work_copy`` 会话 overlay 中每个改动跑上述检查

## 原则

* 零云端、零强制依赖
* fail-open：校验器不可用时不阻断（``validate`` 模式下 syntax/LSP error 仍阻断）
* 影子文件落在 ``<workspace>/.ovolve/shadow/``
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from typing import Optional

from shadow_config import get_mode, precheck_enabled, shadow_enabled, shadow_staged

SHADOW_SUBDIR = os.path.join(".ovolve", "shadow", "preview")
MAX_SHADOW_BYTES = 8 * 1024 * 1024
MAX_ISSUES = 50


@dataclass
class ShadowIssue:
    checker: str
    severity: str  # error | warning | info
    message: str
    path: str = ""
    line: int = 0
    character: int = 0

    def to_dict(self) -> dict:
        return {
            "checker": self.checker,
            "severity": self.severity,
            "message": self.message,
            "path": self.path,
            "line": self.line,
            "character": self.character,
        }


@dataclass
class ShadowPreview:
    ok: bool
    issues: list[ShadowIssue] = field(default_factory=list)
    shadow_path: str = ""
    changes: list[dict] = field(default_factory=list)
    mode: str = field(default_factory=get_mode)
    pending_apply: bool = False

    def format_error(self) -> str:
        errors = [i for i in self.issues if i.severity == "error"]
        if not errors:
            return ""
        head = errors[0]
        loc = f"{head.path}:{head.line}" if head.path and head.line else head.path
        prefix = f"{loc}: " if loc else ""
        return f"shadow validation failed ({head.checker}): {prefix}{head.message}"

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "issues": [i.to_dict() for i in self.issues[:MAX_ISSUES]],
            "changes": self.changes,
            "mode": self.mode,
            "pending_apply": self.pending_apply,
            "issue_count": len(self.issues),
            "error_count": sum(1 for i in self.issues if i.severity == "error"),
            "warning_count": sum(1 for i in self.issues if i.severity == "warning"),
        }


def _resolve_shadow_root(workspace: str) -> str:
    ws = (workspace or "").strip()
    if ws and os.path.isdir(ws):
        root = os.path.join(ws, SHADOW_SUBDIR)
        try:
            os.makedirs(root, exist_ok=True)
            return root
        except OSError:
            pass
    fallback = os.path.join(tempfile.gettempdir(), "ovolve-shadow", "preview")
    os.makedirs(fallback, exist_ok=True)
    return fallback


def _safe_shadow_path(logical_path: str, workspace: str, ext: str) -> str:
    root = _resolve_shadow_root(workspace)
    digest = hashlib.sha256(os.path.normpath(logical_path or "preview").encode("utf-8")).hexdigest()[:20]
    suffix = ext if ext else ".txt"
    return os.path.join(root, f"{digest}{suffix}")


def _write_shadow(logical_path: str, content: str, workspace: str) -> str:
    if content is None:
        content = ""
    if len(content.encode("utf-8", errors="replace")) > MAX_SHADOW_BYTES:
        raise ValueError(f"content exceeds shadow limit ({MAX_SHADOW_BYTES} bytes)")
    ext = os.path.splitext(str(logical_path).lower())[1]
    dest = _safe_shadow_path(logical_path, workspace, ext)
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(content)
    return dest


def _checker_python(shadow_path: str, logical_path: str) -> Optional[ShadowIssue]:
    import py_compile
    try:
        py_compile.compile(shadow_path, doraise=True)
        return None
    except py_compile.PyCompileError as exc:
        return ShadowIssue("python_syntax", "error", str(exc), path=logical_path)
    except Exception as exc:  # noqa: BLE001
        return ShadowIssue("python_syntax", "error", str(exc), path=logical_path)


def _checker_json(logical_path: str, content: str) -> Optional[ShadowIssue]:
    try:
        json.loads(content)
        return None
    except json.JSONDecodeError as exc:
        return ShadowIssue("json_syntax", "error", str(exc), path=logical_path, line=exc.lineno or 0)


def _checker_toml(logical_path: str, content: str) -> Optional[ShadowIssue]:
    try:
        import tomllib
        tomllib.loads(content)
        return None
    except Exception as exc:  # noqa: BLE001
        return ShadowIssue("toml_syntax", "error", str(exc), path=logical_path)


def _checker_lsp(workspace: str, logical_path: str, content: str) -> list[ShadowIssue]:
    try:
        from lsp_client import diagnostics_for_file
        diags = diagnostics_for_file(workspace, logical_path, content)
        return [
            ShadowIssue(
                f"lsp_{d.source}",
                d.severity if d.severity in ("error", "warning") else "info",
                d.message,
                path=logical_path,
                line=d.line,
                character=d.character,
            )
            for d in diags
        ]
    except Exception:
        return []


def _checker_project(workspace: str) -> list[ShadowIssue]:
    """Run verify_gate probes against a materialized verify tree. Permission-gated."""
    issues: list[ShadowIssue] = []
    try:
        from verify_gate import probe, is_allowed
        from executors import guarded_spawn
    except Exception:
        return issues
    for cmd in probe(workspace):
        allowed, why = is_allowed(cmd.command, workspace)
        if not allowed:
            issues.append(ShadowIssue(
                "project_verify", "info",
                f"skipped {cmd.kind} ({cmd.source}): {why}",
            ))
            continue
        try:
            proc = guarded_spawn(cmd.command, timeout=120, cwd=workspace)
            rc = int(proc.returncode or 0)
            if rc == 0:
                continue
            raw = ((proc.stdout or "") + (proc.stderr or ""))[:600]
            issues.append(ShadowIssue(
                "project_verify", "error",
                raw or f"{cmd.command} exited {rc}",
                path=cmd.source,
            ))
        except Exception as exc:  # noqa: BLE001
            issues.append(ShadowIssue("project_verify", "warning", str(exc)))
    return issues


def _checker_code_graph_impact(workspace: str, logical_path: str, content: str) -> list[ShadowIssue]:
    """Pre-check impact using CodeKnowledgeGraph when modifying Python files."""
    if not logical_path.endswith(".py") or not workspace:
        return []
    try:
        from code_graph import CodeKnowledgeGraph
        db_path = os.path.join(workspace, ".ovolve", "code_graph.db")
        if not os.path.exists(db_path):
            return []
        kg = CodeKnowledgeGraph(db_path=db_path)
        existing_syms = kg.get_file_symbols(logical_path)
        issues = []
        for sym in existing_syms:
            sname = sym["name"]
            if f"def {sname}" not in content and f"class {sname}" not in content and f"async def {sname}" not in content:
                impact = kg.assess_symbol_impact(sname)
                if impact["caller_count"] > 0:
                    issues.append(
                        ShadowIssue(
                            "code_graph_impact",
                            "warning",
                            f"Symbol '{sname}' was removed or renamed but has {impact['caller_count']} external callers in {len(impact['affected_files'])} file(s).",
                            path=logical_path,
                            line=sym.get("line", 0),
                        )
                    )
        kg.close()
        return issues
    except Exception:
        return []


def _validate_content(workspace: str, logical_path: str, content: str) -> list[ShadowIssue]:
    if not logical_path:
        return []
    ext = os.path.splitext(str(logical_path).lower())[1]
    issues: list[ShadowIssue] = []
    shadow_path = ""
    try:
        shadow_path = _write_shadow(logical_path, content, workspace)
    except Exception as exc:  # noqa: BLE001
        return [ShadowIssue("shadow_io", "warning", str(exc), path=logical_path)]

    if ext == ".py":
        hit = _checker_python(shadow_path, logical_path)
        if hit:
            issues.append(hit)
    elif ext == ".json":
        hit = _checker_json(logical_path, content)
        if hit:
            issues.append(hit)
    elif ext == ".toml":
        hit = _checker_toml(logical_path, content)
        if hit:
            issues.append(hit)

    issues.extend(_checker_lsp(workspace, logical_path, content))
    issues.extend(_checker_code_graph_impact(workspace, logical_path, content))
    return issues


def preview_write(logical_path: str, content: str, workspace: str = "") -> ShadowPreview:
    """单文件拟写入预览 + 校验（``file_agent`` 落盘前调用）。"""
    if not precheck_enabled() or not shadow_enabled() or not logical_path or content is None:
        return ShadowPreview(ok=True, mode=get_mode())

    issues = _validate_content(workspace, logical_path, content)
    has_error = any(i.severity == "error" for i in issues)
    # validate 模式：error 阻断；staged 模式：单文件 error 也阻断 overlay 写入
    block = has_error
    return ShadowPreview(ok=not block, issues=issues, mode=get_mode())


def _read_overlay_file(wc, rel: str) -> str:
    full = os.path.join(wc.root, *rel.split("/"))
    try:
        with open(full, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def validate_workcopy(wc, workspace: str) -> ShadowPreview:
    """对 staged overlay 中全部改动做完整校验。"""
    if wc is None:
        return ShadowPreview(ok=True, mode=get_mode())
    changes = wc.changes()
    issues: list[ShadowIssue] = []
    for row in changes:
        rel = row["rel"]
        if row["kind"] == "delete":
            continue
        logical = os.path.join(workspace, *rel.split("/"))
        content = _read_overlay_file(wc, rel)
        issues.extend(_validate_content(workspace, logical, content))

    verify_root = _materialize_verify_tree(workspace, wc)
    if verify_root:
        issues.extend(_checker_project(verify_root))

    has_error = any(i.severity == "error" for i in issues)
    return ShadowPreview(
        ok=not has_error,
        issues=issues,
        changes=changes,
        mode=get_mode(),
        pending_apply=shadow_staged() and bool(changes),
    )


def _materialize_verify_tree(workspace: str, wc) -> str:
    """把 overlay 改动 + 项目配置文件物化到 verify-tree，供项目级命令使用。"""
    if wc is None or not workspace:
        return ""
    base = os.path.join(
        os.path.dirname(wc.root),
        "verify-tree",
    )
    try:
        if os.path.isdir(base):
            shutil.rmtree(base, ignore_errors=True)
        os.makedirs(base, exist_ok=True)
    except OSError:
        return ""

    # 项目根配置
    for name in (
        "package.json", "tsconfig.json", "jsconfig.json",
        "pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini",
        "Cargo.toml", "go.mod", "Makefile",
    ):
        src = os.path.join(workspace, name)
        if os.path.isfile(src):
            try:
                shutil.copy2(src, os.path.join(base, name))
            except OSError:
                pass

    # 常见源码根（仅复制目录结构 + overlay 覆盖）
    for sub in ("src", "app", "lib", "tests", "test"):
        ws_sub = os.path.join(workspace, sub)
        if os.path.isdir(ws_sub):
            try:
                shutil.copytree(
                    ws_sub,
                    os.path.join(base, sub),
                    ignore=shutil.ignore_patterns(
                        "node_modules", "__pycache__", ".git", "target", "dist", "build",
                    ),
                    dirs_exist_ok=True,
                )
            except OSError:
                pass

    # overlay 改动覆盖
    for row in wc.changes():
        rel = row["rel"]
        dest = os.path.join(base, *rel.split("/"))
        if row["kind"] == "delete":
            if os.path.isfile(dest):
                try:
                    os.remove(dest)
                except OSError:
                    pass
            continue
        src = os.path.join(wc.root, *rel.split("/"))
        try:
            os.makedirs(os.path.dirname(dest) or base, exist_ok=True)
            shutil.copy2(src, dest)
        except OSError:
            pass

    return base


async def validate_and_emit(bus, session_id: str, workspace: str, context: dict) -> ShadowPreview:
    """校验当前 staged overlay 并通过 event bus 推送 UI。"""
    from shadow_session import get_session, shadow_staged
    wc = get_session(session_id)
    if wc is None or not shadow_staged():
        return ShadowPreview(ok=True, mode=get_mode())
    report = validate_workcopy(wc, workspace)
    try:
        await bus.emit("shadow_validation", {
            "session_id": session_id,
            "workspace": workspace,
            **report.to_dict(),
        })
    except Exception:
        pass
    return report


async def maybe_auto_apply(bus, session_id: str, workspace: str, permission: str) -> Optional[dict]:
    """自主/全权模式下，校验通过则自动合并 overlay。"""
    from shadow_session import apply_session, get_session, shadow_staged
    if not shadow_staged():
        return None
    if permission not in ("full", "autonomous"):
        return None
    wc = get_session(session_id)
    if wc is None or not wc.changes():
        return None
    report = validate_workcopy(wc, workspace)
    if not report.ok:
        try:
            await bus.emit("shadow_validation", {
                "session_id": session_id,
                "workspace": workspace,
                **report.to_dict(),
                "auto_apply_blocked": True,
            })
        except Exception:
            pass
        return None
    result = apply_session(session_id)
    try:
        await bus.emit("shadow_applied", {
            "session_id": session_id,
            "workspace": workspace,
            "applied": result.get("applied") or [],
            "deleted": result.get("deleted") or [],
            "conflicts": result.get("conflicts") or {},
            "errors": result.get("errors") or [],
        })
    except Exception:
        pass
    return result


def cleanup_workspace_shadow(workspace: str) -> int:
    ws = (workspace or "").strip()
    if not ws:
        return 0
    target = os.path.join(ws, ".ovolve", "shadow")
    if not os.path.isdir(target):
        return 0
    try:
        count = sum(len(files) for _d, _s, files in os.walk(target))
        shutil.rmtree(target, ignore_errors=True)
        return count
    except OSError:
        return 0
