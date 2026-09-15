"""worktree.py — per-subagent git worktree isolation .

``work_copy`` overlays only the file tools. A sub-agent that ran a shell
command still wrote into the real workspace. A git worktree makes the
child's *entire* world a separate checkout: file tools, search, and (if
the policy ever lets it) the shell all stay off the parent's tree.

Fallback is deliberate. This module returns None when git isn't there,
the folder isn't a repo, HEAD doesn't exist, or ``git worktree add``
fails — ``subagent_runtime`` then uses the overlay, which is the
behaviour from before this file existed.

The object duck-types ``WorkCopy`` (``id``, ``root``, ``source_root``,
``label``, ``changes()``, ``cleanup()``) so the existing merge path in
``work_copy.merge`` does not need a second implementation.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

KIND = "worktree"

#: Don't hash absurdly large files into the snapshot.
MAX_HASH_BYTES = 8 * 1024 * 1024

_SKIP_DIR_NAMES = {".git", "__pycache__", "node_modules", ".venv", "venv"}


def _git(*args: str, cwd: str, timeout: int = 30) -> subprocess.CompletedProcess:
    # Tracked so Stop/Pause can kill it: a worktree add on a large repo is one
    # of the longer-running children the agent starts.
    from executors import tracked_run
    return tracked_run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def _which_git() -> Optional[str]:
    return shutil.which("git")


def repo_toplevel(path: str) -> Optional[str]:
    """Absolute toplevel of the git repo containing ``path``, or None."""
    if not path or not os.path.isdir(path) or not _which_git():
        return None
    try:
        proc = _git("rev-parse", "--show-toplevel", cwd=path)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    top = (proc.stdout or "").strip()
    return os.path.abspath(top) if top else None


def _file_fingerprint(path: str) -> str:
    try:
        size = os.path.getsize(path)
    except OSError:
        return "missing"
    if size > MAX_HASH_BYTES:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        return f"size:{size}:mtime:{mtime}"
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except OSError:
        return f"size:{size}"
    return h.hexdigest()


def _walk_files(root: str) -> list[str]:
    out: list[str] = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIR_NAMES]
        for name in files:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            if rel.startswith(".git/") or rel == ".git":
                continue
            out.append(rel)
    return out


def _snapshot(root: str) -> dict[str, str]:
    snap: dict[str, str] = {}
    for rel in _walk_files(root):
        snap[rel] = _file_fingerprint(os.path.join(root, *rel.split("/")))
    return snap


def _copy_file(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    shutil.copy2(src, dst)


@dataclass
class WorktreeCopy:
    """One sub-agent's git worktree, duck-typed as a WorkCopy."""

    id: str
    root: str
    source_root: str
    label: str = ""
    kind: str = KIND
    #: The actual ``git worktree`` path (repo root of the linked checkout).
    wt_root: str = ""
    repo_toplevel: str = ""
    #: Fingerprints of ``root`` immediately after create+sync.
    _snapshot: dict = field(default_factory=dict, repr=False)

    def changes(self) -> list[dict]:
        """Files in this worktree that differ from the post-create snapshot."""
        rows: list[dict] = []
        current = set(_walk_files(self.root))
        previous = set(self._snapshot)
        for rel in sorted(current | previous):
            full = os.path.join(self.root, *rel.split("/"))
            if rel not in current:
                rows.append({"rel": rel, "kind": "delete", "bytes": 0})
                continue
            if rel not in previous or self._snapshot.get(rel) != _file_fingerprint(full):
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                rows.append({"rel": rel, "kind": "write", "bytes": size})
        return rows

    def report(self) -> dict:
        rows = self.changes()
        return {
            "id": self.id,
            "label": self.label,
            "root": self.root,
            "kind": self.kind,
            "changes": rows,
            "paths": [r["rel"] for r in rows],
        }

    def cleanup(self) -> None:
        discard(self)


def _sync_dirty(toplevel: str, wt_root: str) -> None:
    """Copy the parent's dirty/untracked files into the worktree.

    ``git worktree add`` checks out HEAD, so uncommitted parent edits would
    otherwise be invisible to the child. Porcelain is the cheap, correct list.
    """
    try:
        proc = _git("status", "--porcelain", "-uall", "--ignore-submodules=none", cwd=toplevel)
    except (OSError, subprocess.TimeoutExpired):
        return
    if proc.returncode != 0:
        return
    for line in (proc.stdout or "").splitlines():
        if len(line) < 4:
            continue
        rel = line[3:].strip()
        if " -> " in rel:
            rel = rel.split(" -> ", 1)[-1]
        rel = rel.strip().strip('"')
        if not rel or rel.startswith(".git"):
            continue
        src = os.path.join(toplevel, rel)
        dst = os.path.join(wt_root, rel)
        if os.path.isfile(src):
            try:
                _copy_file(src, dst)
            except OSError:
                pass  # fail-open: 可选增强，失败不影响主流程
        elif not os.path.exists(src) and os.path.isfile(dst):
            try:
                os.remove(dst)
            except OSError:
                pass  # fail-open: 可选增强，失败不影响主流程


def create(source_root: str, label: str = "") -> Optional[WorktreeCopy]:
    """Open a detached worktree over ``source_root``. None = caller should overlay."""
    if not source_root or not os.path.isdir(source_root) or not _which_git():
        return None
    toplevel = repo_toplevel(source_root)
    if not toplevel:
        return None
    try:
        head = _git("rev-parse", "--verify", "HEAD", cwd=toplevel)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if head.returncode != 0:
        return None

    wt_id = uuid.uuid4().hex[:8]
    parent = tempfile.mkdtemp(prefix=f"ovolve-wt-{wt_id}-")
    wt_path = os.path.join(parent, "tree")
    try:
        added = _git(
            "worktree", "add", "--detach", "--force", wt_path, "HEAD",
            cwd=toplevel, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        shutil.rmtree(parent, ignore_errors=True)
        return None
    if added.returncode != 0 or not os.path.isdir(wt_path):
        shutil.rmtree(parent, ignore_errors=True)
        return None

    try:
        _sync_dirty(toplevel, wt_path)
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程

    try:
        rel = os.path.relpath(os.path.abspath(source_root), toplevel)
    except ValueError:
        rel = "."
    if rel in (os.curdir, ""):
        child_root = wt_path
    elif rel.startswith(".."):
        # source_root is outside the repo (shouldn't happen). Abort.
        discard_path(toplevel, wt_path, parent)
        return None
    else:
        child_root = os.path.join(wt_path, rel)
        os.makedirs(child_root, exist_ok=True)

    wc = WorktreeCopy(
        id=wt_id,
        root=os.path.abspath(child_root),
        source_root=os.path.abspath(source_root),
        label=label,
        wt_root=os.path.abspath(wt_path),
        repo_toplevel=toplevel,
        _snapshot=_snapshot(os.path.abspath(child_root)),
    )
    return wc


def discard_path(toplevel: str, wt_path: str, parent: str = "") -> None:
    try:
        _git("worktree", "remove", "--force", wt_path, cwd=toplevel, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        pass  # fail-open: 可选增强，失败不影响主流程
    shutil.rmtree(wt_path, ignore_errors=True)
    if parent:
        shutil.rmtree(parent, ignore_errors=True)
    try:
        _git("worktree", "prune", cwd=toplevel, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        pass  # fail-open: 可选增强，失败不影响主流程


def discard(wt: Optional[WorktreeCopy]) -> None:
    if wt is None:
        return
    parent = str(Path(wt.wt_root).parent) if wt.wt_root else ""
    discard_path(wt.repo_toplevel or wt.source_root, wt.wt_root or wt.root, parent)
