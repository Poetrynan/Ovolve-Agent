"""shadow_session.py — 主代理会话级影子工作区（staged overlay）

与 ``work_copy`` 子代理隔离共用同一套 COW overlay 语义，但 overlay 落在
``<workspace>/.ovolve/shadow/session/<session_id>/overlay/``，便于本地部署用户
直接查看、删除或手动合并。

模式（``OVOLVE_SHADOW_MODE``）：
  * ``off`` — 关闭影子工作区
  * ``validate`` — 直写工作区 + 完整校验（语法 + LSP + 项目探针）
  * ``staged`` — 写入 overlay，校验通过后由用户或自动策略合并到真实工作区
"""
from __future__ import annotations

import os
from typing import Optional

from work_copy import CTX_KEY, WorkCopy, discard, merge

from shadow_config import get_mode, shadow_enabled, shadow_staged

SESSION_SUBDIR = os.path.join(".ovolve", "shadow", "session")

_sessions: dict[str, WorkCopy] = {}


def overlay_dir(workspace: str, session_id: str) -> str:
    return os.path.join(workspace, SESSION_SUBDIR, session_id, "overlay")


def session_meta_dir(workspace: str, session_id: str) -> str:
    return os.path.join(workspace, SESSION_SUBDIR, session_id)


def ensure_session(session_id: str, workspace: str) -> Optional[WorkCopy]:
    """Open or return the session overlay. None when shadow is off."""
    if not shadow_staged() or not session_id or not workspace:
        return None
    if not os.path.isdir(workspace):
        return None
    if session_id in _sessions:
        return _sessions[session_id]
    from work_copy import open_at
    ovl = overlay_dir(workspace, session_id)
    wc = open_at(workspace, ovl, wc_id=session_id[:16], label=f"shadow:{session_id[:8]}")
    if wc:
        _sessions[session_id] = wc
    return wc


def get_session(session_id: str) -> Optional[WorkCopy]:
    return _sessions.get(session_id)


def inject_context(session_id: str, workspace: str, context: dict) -> None:
    """Attach overlay root to tool context for staged writes."""
    wc = ensure_session(session_id, workspace)
    if wc is None:
        return
    context[CTX_KEY] = wc.root
    context["shadow_session_id"] = session_id
    context["shadow_staged"] = True


def apply_session(session_id: str) -> dict:
    """Merge overlay into the real workspace and tear down the session."""
    wc = _sessions.pop(session_id, None)
    if wc is None:
        return {"applied": [], "deleted": [], "conflicts": {}, "errors": []}
    result = merge([wc])
    discard(wc)
    return result


def discard_session(session_id: str) -> None:
    wc = _sessions.pop(session_id, None)
    if wc:
        discard(wc)


def status(session_id: str, workspace: str) -> dict:
    wc = _sessions.get(session_id) or (
        ensure_session(session_id, workspace) if shadow_staged() else None
    )
    if wc is None:
        return {
            "session_id": session_id,
            "enabled": shadow_enabled(),
            "mode": get_mode(),
            "staged": False,
            "changes": [],
            "paths": [],
        }
    report = wc.report()
    return {
        "session_id": session_id,
        "enabled": shadow_enabled(),
        "mode": __import__("shadow_config").get_mode(),
        "staged": True,
        "overlay_root": wc.root,
        "changes": report.get("changes") or [],
        "paths": report.get("paths") or [],
    }
