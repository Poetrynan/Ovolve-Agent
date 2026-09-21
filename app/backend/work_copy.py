"""work_copy.py — per-subagent write isolation (UA3).

## The problem this fixes

`path_lock.py` already stops two sub-agents from *clobbering* each other: same
file, serialized writes, no lost bytes. What it cannot do is stop them from
producing changes that are individually fine and jointly broken — A renames a
function's parameters, B in another file still calls it the old way, both write
successfully, both report success, and the thing that's wrong is the *sum*.

There was no per-sub-agent diff, so nothing could be reviewed before it landed.

## The shape: a copy-on-write overlay, not a copy of the workspace

The obvious design — hand each sub-agent a full copy of the folder — breaks the
tools it needs most. `search_code`, `find_files` and `list_dir` would see only
whatever had been copied in, so a coder looking for call sites would find none
and conclude there aren't any. That is worse than the bug we started with.

So the split is by DIRECTION, not by tree:

- **reads and searches go straight to the real workspace** — unchanged, complete,
  no copying, no cost.
- **writes land in a private overlay directory**, mirroring the workspace layout.
  A file is seeded from the real one the first time it's edited, so
  `edit_file`'s read→replace→write still sees the true pre-image.

The sub-agent's `workspace_root` therefore stays the REAL folder: `path_guard`
keeps validating containment against it exactly as before, and the redirect
happens deeper down, inside the file tools. Nothing about the guard changes.

## Deletes need a tombstone

An overlay can express "this file now has these bytes" by holding the file. It
cannot express "this file is gone" by holding nothing — that's indistinguishable
from "untouched". So deletions are recorded in a manifest at the overlay root.
Without it, a sub-agent's delete would silently not happen on merge, and the
sub-agent would have reported success.

## Merge is the parent's job, and only for sub-agents that succeeded

`spawn_batch` is the only place that sees every sibling of one batch, so overlap
detection lives there. Two rules that matter more than the mechanism:

- a sub-agent that failed, timed out, or ran out of steps has its overlay
  DISCARDED. Half of an intended change is not a smaller version of it.
- when two sub-agents touched the same file, neither one's version of that file
  is applied, and the conflict is reported upward. Picking a winner silently is
  how you get the joint-breakage this module exists to prevent.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

#: Kill switch. Off means every sub-agent writes straight to the workspace, i.e.
#: exactly the behaviour before this module existed.
WORK_COPY_ENABLED = True

#: The ctx key a redirected tool looks for. Absent → no redirection at all, which
#: is the main agent's normal path.
CTX_KEY = "work_copy_root"

#: Manifest filename inside an overlay. Also the marker that says "this directory
#: is an overlay" — used to refuse to treat a real workspace as one.
MANIFEST = ".ovolve-workcopy.json"

#: Don't seed absurdly large files into an overlay. A sub-agent editing a 200 MB
#: file is not a workflow we need to support, and copying it would stall the turn.
MAX_SEED_BYTES = 8 * 1024 * 1024


def _overlay_root() -> Path:
    root = Path(tempfile.gettempdir()) / "ovolve-workcopies"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


@dataclass
class WorkCopy:
    """One sub-agent's private overlay over the real workspace."""

    id: str
    root: str
    source_root: str
    label: str = ""
    kind: str = "overlay"
    #: Workspace-relative paths the sub-agent asked to delete.
    deleted: set[str] = field(default_factory=set)

    def cleanup(self) -> None:
        discard(self)

    # ── path mapping ─────────────────────────────────────────────────────

    def rel(self, real_path: str) -> str | None:
        """Workspace-relative form of a real path, or None if it's outside.

        Outside-the-workspace paths are NOT redirected: `path_guard` will have
        already refused them for anything that matters, and silently rerouting
        something the guard let through (a temp file, say) would hide it from the
        merge instead of isolating it.
        """
        try:
            r = os.path.relpath(_norm(real_path), _norm(self.source_root))
        except ValueError:
            return None  # different drive on Windows
        if r == os.curdir or r.startswith(os.pardir + os.sep) or r == os.pardir:
            return None
        return r.replace("\\", "/")

    def overlay_path(self, real_path: str) -> str | None:
        r = self.rel(real_path)
        if r is None:
            return None
        return os.path.join(self.root, *r.split("/"))

    # ── write-side operations ────────────────────────────────────────────

    def prepare(self, real_path: str, *, seed: bool = True) -> str | None:
        """Overlay path for a write, seeded from the real file when needed.

        `seed=True` is what makes `edit_file` correct inside an overlay: it does
        read→replace→write, and without the pre-image the read would fail (or
        worse, succeed against a stale earlier overlay state).
        """
        dest = self.overlay_path(real_path)
        if dest is None:
            return None
        os.makedirs(os.path.dirname(dest) or self.root, exist_ok=True)
        if seed and not os.path.exists(dest) and os.path.isfile(real_path):
            try:
                if os.path.getsize(real_path) <= MAX_SEED_BYTES:
                    shutil.copy2(real_path, dest)
            except OSError:
                pass  # a failed seed degrades to "write from scratch", not a crash
        # A path that was tombstoned and is now being written again is alive.
        r = self.rel(real_path)
        if r:
            self.deleted.discard(r)
        return dest

    def tombstone(self, real_path: str) -> bool:
        """Record "the sub-agent deleted this". Returns whether it was recorded."""
        r = self.rel(real_path)
        if r is None:
            return False
        self.deleted.add(r)
        # Drop any overlay copy: keeping it would make the merge see both a new
        # version AND a delete for the same path.
        dest = self.overlay_path(real_path)
        if dest and os.path.exists(dest):
            try:
                os.remove(dest) if os.path.isfile(dest) else shutil.rmtree(dest, ignore_errors=True)
            except OSError:
                pass  # fail-open: 可选增强，失败不影响主流程
        self.save()
        return True

    def save(self) -> None:
        try:
            Path(self.root, MANIFEST).write_text(json.dumps({
                "id": self.id, "label": self.label,
                "sourceRoot": self.source_root,
                "deleted": sorted(self.deleted),
            }, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass  # fail-open: 可选增强，失败不影响主流程

    # ── read-side: what did this sub-agent actually change? ──────────────

    def changes(self) -> list[dict]:
        """Every change this overlay holds, as ``{rel, kind, bytes}``.

        `kind` is `write` (the overlay holds a version of the file) or `delete`.
        Purely a walk of the overlay tree plus the tombstone list — no comparison
        against the real workspace, because "identical to the original" is still a
        write the sub-agent chose to make and the parent should see it.
        """
        rows: list[dict] = []
        for dirpath, _dirs, files in os.walk(self.root):
            for name in files:
                if name == MANIFEST and _norm(dirpath) == _norm(self.root):
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, self.root).replace("\\", "/")
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                rows.append({"rel": rel, "kind": "write", "bytes": size})
        for rel in sorted(self.deleted):
            rows.append({"rel": rel, "kind": "delete", "bytes": 0})
        rows.sort(key=lambda r: (r["rel"], r["kind"]))
        return rows

    def report(self) -> dict:
        """Summary for the parent: which paths, how many, and where they live."""
        rows = self.changes()
        return {
            "id": self.id,
            "label": self.label,
            "root": self.root,
            "changes": rows,
            "paths": [r["rel"] for r in rows],
        }


#: Live overlays by root path, so a tool call holding only the ctx string can find
#: the object that knows the tombstones. Entries are removed by `discard`.
_live: dict[str, WorkCopy] = {}


def create(source_root: str, label: str = "") -> WorkCopy | None:
    """Open a fresh overlay over `source_root`. None when isolation is off or the
    source isn't a usable directory (in which case the caller writes directly,
    which is the pre-UA3 behaviour and still correct — just not isolated)."""
    if not WORK_COPY_ENABLED or not source_root or not os.path.isdir(source_root):
        return None
    wc_id = uuid.uuid4().hex[:8]
    try:
        root = tempfile.mkdtemp(prefix=f"wc-{wc_id}-", dir=str(_overlay_root()))
    except OSError:
        return None
    return _register(source_root, root, wc_id=wc_id, label=label)


def open_at(
    source_root: str,
    overlay_root: str,
    *,
    wc_id: str = "",
    label: str = "",
) -> WorkCopy | None:
    """Open an overlay at a caller-chosen path (shadow workspace sessions).

    Unlike ``create``, the overlay lives under the workspace (e.g.
    ``<workspace>/.ovolve/shadow/session/<id>/overlay/``) so local deploys can
    inspect or delete staged changes on disk.
    """
    if not WORK_COPY_ENABLED or not source_root or not os.path.isdir(source_root):
        return None
    root = os.path.abspath(overlay_root)
    try:
        os.makedirs(root, exist_ok=True)
    except OSError:
        return None
    return _register(source_root, root, wc_id=wc_id or uuid.uuid4().hex[:8], label=label)


def _register(source_root: str, root: str, *, wc_id: str, label: str) -> WorkCopy:
    wc = WorkCopy(id=wc_id, root=root, source_root=os.path.abspath(source_root), label=label)
    wc.save()
    _live[_norm(root)] = wc
    return wc


def for_ctx(ctx: dict) -> WorkCopy | None:
    """The overlay this tool call should write into, if any."""
    if not isinstance(ctx, dict):
        return None
    root = ctx.get(CTX_KEY)
    if not root:
        return None
    return _live.get(_norm(str(root)))


def redirect_write(path: str, ctx: dict, *, seed: bool = True) -> str:
    """Map a real path to its overlay location. Unchanged when not isolated.

    Deliberately total and silent: every mutating file tool calls this, and the
    main agent (no overlay in ctx) must come out the other side with exactly the
    path it passed in.
    """
    wc = for_ctx(ctx)
    if wc is None:
        return path
    dest = wc.prepare(path, seed=seed)
    return dest or path


def record_delete(path: str, ctx: dict) -> bool:
    """Record a delete against the overlay. False when not isolated (delete for
    real). Callers must NOT touch the real file when this returns True."""
    wc = for_ctx(ctx)
    if wc is None:
        return False
    return wc.tombstone(path)


def discard(wc: WorkCopy | None) -> None:
    """Throw the overlay away. Used for failed sub-agents and after a merge."""
    if wc is None:
        return
    _live.pop(_norm(wc.root), None)
    shutil.rmtree(wc.root, ignore_errors=True)


def find_conflicts(copies: list[WorkCopy]) -> dict[str, list[str]]:
    """Workspace-relative paths that more than one overlay touched.

    File-level granularity on purpose. Two sub-agents editing different regions of
    one file is *sometimes* mergeable, but deciding that correctly needs a real
    three-way merge, and getting it wrong silently produces exactly the broken sum
    this module exists to catch. A conflict the parent has to resolve is a worse
    experience and a better outcome.
    """
    seen: dict[str, list[str]] = {}
    for wc in copies:
        for rel in {r["rel"] for r in wc.changes()}:
            seen.setdefault(rel, []).append(wc.label or wc.id)
    return {rel: who for rel, who in seen.items() if len(who) > 1}


def merge(copies: list[WorkCopy]) -> dict:
    """Apply every non-conflicting change from `copies` to the real workspace.

    Only pass overlays whose sub-agent SUCCEEDED — this function does not know
    that and will happily apply a half-finished attempt.

    Returns ``{applied, deleted, conflicts, errors}``: `applied`/`deleted` are
    relative paths, `conflicts` maps a path to the sub-agents that fought over it,
    and `errors` holds per-path failures. Nothing raises: a merge that partly fails
    still has to report what did land.
    """
    from path_lock import write_lock

    conflicts = find_conflicts(copies)
    applied: list[str] = []
    deleted: list[str] = []
    errors: list[dict] = []

    for wc in copies:
        for row in wc.changes():
            rel = row["rel"]
            if rel in conflicts:
                continue
            real = os.path.join(wc.source_root, *rel.split("/"))
            try:
                # Same lock the file tools take, so a merge can't race a write the
                # parent agent is doing on its own.
                with write_lock(real):
                    if row["kind"] == "delete":
                        if os.path.isfile(real):
                            os.remove(real)
                        elif os.path.isdir(real):
                            os.rmdir(real)
                        deleted.append(rel)
                    else:
                        os.makedirs(os.path.dirname(real) or wc.source_root, exist_ok=True)
                        shutil.copy2(os.path.join(wc.root, *rel.split("/")), real)
                        applied.append(rel)
            except OSError as exc:
                errors.append({"path": rel, "by": wc.label or wc.id, "error": str(exc)})

    return {"applied": applied, "deleted": deleted,
            "conflicts": conflicts, "errors": errors}


def describe_merge(result: dict) -> str:
    """One short paragraph for the parent agent's tool result.

    The conflict list is the part that must never be dropped: a parent that thinks
    the work landed will move on and build on top of changes that aren't there.
    """
    bits: list[str] = []
    n = len(result.get("applied") or []) + len(result.get("deleted") or [])
    if n:
        bits.append(f"已合并 {n} 个文件改动")
    conflicts = result.get("conflicts") or {}
    if conflicts:
        detail = "; ".join(f"{p}（{'、'.join(who)}）" for p, who in sorted(conflicts.items()))
        bits.append(
            f"有 {len(conflicts)} 个文件被多个子代理同时改了，都没有合并，需要你自己决定："
            f"{detail}"
        )
    for e in result.get("errors") or []:
        bits.append(f"合并 {e['path']} 失败：{e['error']}")
    return " ".join(bits)


# ── F4: merge 状态机────────────────────────────
# merge 枚举 {SAFE_MERGE=2, MERGE_WITH_CONFLICTS=3} 一等暴露给 UI。
# Ovolve 的 merge 返回 dict，新增 describe_merge_status 返回结构化状态。

MERGE_STATUS_EMPTY = "empty"
MERGE_STATUS_SAFE = "safe_merge"
MERGE_STATUS_CONFLICTS = "merge_with_conflicts"
MERGE_STATUS_FAILED = "merge_back_failed"


def describe_merge_status(result: dict) -> str:
    """F4: 将 merge 结果判定为结构化状态。

    判定优先级:
        1. errors 非空且 applied 为空 → merge_back_failed
        2. conflicts 非空 → merge_with_conflicts
        3. applied/deleted 有内容 → safe_merge
        4. 否则 → empty
    """
    applied = result.get("applied") or []
    deleted = result.get("deleted") or []
    conflicts = result.get("conflicts") or {}
    errors = result.get("errors") or []

    # 判定优先级：errors > conflicts > safe > empty
    if errors and not applied:
        return MERGE_STATUS_FAILED
    if conflicts:
        return MERGE_STATUS_CONFLICTS
    if applied or deleted:
        return MERGE_STATUS_SAFE
    return MERGE_STATUS_EMPTY
