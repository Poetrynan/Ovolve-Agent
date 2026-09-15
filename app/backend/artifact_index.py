"""Session artifact index — one flat, newest-first list of everything a session produced.

Why this exists as its own module rather than a query inside http_server: the
"artifacts" of a turn are scattered across three stores that were each built for
a different job, and none of them knows about the others.

  * ``image_store``   — generated images live on disk under ``.ovolve/images``,
    and the only durable record of *which session* produced one is the
    ``metadata.images`` blob on the assistant message (``router.py`` writes it).
    There is deliberately no image table to scan: a session-scoped index has to
    come from the messages.
  * ``snapshot_store`` — every mutating tool call snapshots the file's PREVIOUS
    state before touching it. That table is therefore also a complete log of
    which files a session wrote, with the producing tool name attached.
  * ``session_messages`` — supplies the seq→turn mapping so a row in the panel
    can scroll the transcript back to the turn that created it.

Assistant ``toolCalls`` are NOT persisted server-side (only the frontend store
seals them into its in-memory message), so they are not a source here. The
snapshot table covers the same ground for anything that touched a file, which is
the part a user actually wants to find again.

Read-only. Nothing in this module mutates any store.
"""

from __future__ import annotations

import json
import os
from typing import Any

# A cap, not a page size. The panel is a "find that thing again" surface, not an
# audit log — past a few hundred rows scrolling is useless and the payload starts
# to matter. Newest-first ordering means the cap drops the least interesting end.
MAX_ARTIFACTS = 400


def _rel(path: str, workspace: str) -> str:
    """Workspace-relative path when the file is inside it, else the absolute path.

    Absolute paths are kept verbatim rather than mangled into ``../../..`` chains:
    a file outside the workspace is genuinely elsewhere and saying so is clearer.
    """
    if not workspace:
        return path
    try:
        rel = os.path.relpath(path, workspace)
    except ValueError:
        return path  # different drive on Windows
    return path if rel.startswith("..") else rel.replace(os.sep, "/")


def _turn_map(messages: list[dict]) -> list[int]:
    """Ascending seqs of the user messages — index in this list IS the turn index.

    Matches ``storage.seq_of_nth_user_message`` and the frontend's
    ``data-turn-index`` anchors: the Nth bubble the user typed is the Nth
    ``role='user'`` row.
    """
    return [int(m.get("seq") or 0) for m in messages if m.get("role") == "user"]


def _turn_for_seq(user_seqs: list[int], seq: int) -> int:
    """Which turn a given message seq belongs to. -1 when it precedes turn 0."""
    turn = -1
    for i, s in enumerate(user_seqs):
        if s <= seq:
            turn = i
        else:
            break
    return turn


def _image_artifacts(messages: list[dict], user_seqs: list[int]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in messages:
        raw = m.get("metadata") or "{}"
        try:
            meta = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (ValueError, TypeError):
            continue  # a corrupt metadata blob loses its images, not the whole index
        refs = meta.get("images")
        if not isinstance(refs, list):
            continue
        seq = int(m.get("seq") or 0)
        created = int(m.get("created_at") or 0)
        for ref in refs:
            if not isinstance(ref, dict) or not ref.get("id"):
                continue
            out.append({
                "id": f"img:{ref['id']}",
                "kind": "image",
                "name": ref.get("name") or f"{ref['id']}.{ref.get('ext') or 'png'}",
                "path": ref.get("path") or "",
                "url": ref.get("url") or f"/api/images/{ref['id']}",
                "mime": ref.get("mime") or "image/png",
                "bytes": int(ref.get("bytes") or 0),
                "tool": "",
                "change": "created",
                "revisions": 1,
                "exists": True,
                "seq": seq,
                "turnIndex": _turn_for_seq(user_seqs, seq),
                "createdAt": created,
            })
    return out


def _file_artifacts(rows: list[dict], workspace: str,
                    user_seqs: list[int]) -> list[dict[str, Any]]:
    """Collapse the snapshot log into one row per file path.

    A file edited five times produced ONE artifact with five revisions, not five
    artifacts — the panel answers "what did this session touch", and five rows for
    one path buries the other four files. The newest touch wins for seq/time so
    the jump-to-turn link lands on the most recent change.

    ``kind == 'missing'`` in the snapshot means the path did not exist when the
    tool ran, i.e. that call CREATED it. The earliest snapshot decides
    created-vs-modified; later ones always see the file present.
    """
    by_path: dict[str, dict[str, Any]] = {}
    for r in rows:
        path = r.get("path") or ""
        if not path or r.get("kind") == "dir":
            continue  # directories aren't artifacts a user opens
        seq = int(r.get("seq") or 0)
        entry = by_path.get(path)
        if entry is None:
            by_path[path] = {
                "id": f"file:{path}",
                "kind": "file",
                "name": os.path.basename(path) or path,
                "path": _rel(path, workspace),
                "url": "",
                "mime": "",
                "bytes": 0,
                "tool": r.get("tool_name") or "",
                "change": "created" if r.get("kind") == "missing" else "modified",
                "revisions": 1,
                "exists": False,
                "seq": seq,
                "turnIndex": _turn_for_seq(user_seqs, seq),
                "createdAt": int(r.get("created_at") or 0),
            }
            continue
        entry["revisions"] += 1
        if seq >= entry["seq"]:
            entry["seq"] = seq
            entry["turnIndex"] = _turn_for_seq(user_seqs, seq)
            entry["createdAt"] = int(r.get("created_at") or 0)
            entry["tool"] = r.get("tool_name") or entry["tool"]

    # Resolve current on-disk state once per path. A file the agent wrote and then
    # deleted (or the user removed) must show as gone rather than 404 on click.
    for path, entry in by_path.items():
        try:
            st = os.stat(path)
            entry["exists"] = True
            entry["bytes"] = int(st.st_size)
        except OSError:
            entry["exists"] = False
    return list(by_path.values())


def build_index(storage, session_id: str, workspace: str = "") -> dict[str, Any]:
    """Assemble the artifact index for one session.

    Every source is guarded separately: a broken snapshot DB must still yield the
    images, and vice versa. A partial index beats an error page.
    """
    messages: list[dict] = []
    try:
        # 5000 is "the whole session" in practice; get_messages has no all-rows mode.
        messages = storage.get_messages(session_id, limit=5000, offset=0) or []
    except Exception:
        messages = []
    user_seqs = _turn_map(messages)

    artifacts: list[dict[str, Any]] = []
    try:
        artifacts.extend(_image_artifacts(messages, user_seqs))
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程
    try:
        from snapshot_store import get_snapshot_store
        rows = get_snapshot_store().list_since(session_id, 0)
        artifacts.extend(_file_artifacts(rows, workspace, user_seqs))
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程

    # Newest first, and stable for equal timestamps (seq breaks the tie) so the
    # list doesn't shuffle between polls.
    artifacts.sort(key=lambda a: (a["createdAt"], a["seq"]), reverse=True)
    total = len(artifacts)
    artifacts = artifacts[:MAX_ARTIFACTS]

    return {
        "sessionId": session_id,
        "workspace": workspace or "",
        "total": total,
        "truncated": total > len(artifacts),
        "counts": {
            "image": sum(1 for a in artifacts if a["kind"] == "image"),
            "file": sum(1 for a in artifacts if a["kind"] == "file"),
        },
        "artifacts": artifacts,
    }
