# -*- coding: utf-8 -*-
"""evolution_undo.py — Snapshot and rollback manager for approved evolution proposals.

Maintains atomic pre-modification file snapshots for AGENTS.md, MEMORY.md, and SOUL.md.
When a proposal acceptance is undone, restores target file contents and records a
`user_correction` signal into the evolution store to feed negative evidence into the learning loop.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from result import Result

MAX_SNAPSHOTS = 20
UNDO_SUBDIR = os.path.join("_local", "evolution_undo")


def _resolve_undo_dir(workspace_root: Optional[str] = None) -> str:
    root = workspace_root or os.getcwd()
    undo_dir = os.path.join(root, UNDO_SUBDIR)
    os.makedirs(undo_dir, exist_ok=True)
    return undo_dir


def create_evolution_snapshot(
    workspace_root: str,
    target_file: str,
    proposal_id: str,
) -> Optional[str]:
    """Capture an atomic snapshot of target file before modifying it."""
    try:
        undo_dir = _resolve_undo_dir(workspace_root)
        target_path = os.path.join(workspace_root, target_file)

        content = ""
        if os.path.isfile(target_path):
            with open(target_path, "r", encoding="utf-8") as f:
                content = f.read()

        ts_ms = int(time.time() * 1000)
        filename = f"{ts_ms}__{proposal_id}__{target_file}.bak"
        dest_path = os.path.join(undo_dir, filename)

        # Atomic write to temporary file then replace
        temp_fd, temp_path = tempfile.mkstemp(dir=undo_dir, prefix="snap_", suffix=".tmp")
        try:
            with os.fdopen(temp_fd, "w", encoding="utf-8") as f:
                f.write(content)
            os.replace(temp_path, dest_path)
        except Exception:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise

        prune_snapshots(workspace_root, keep=MAX_SNAPSHOTS)
        return dest_path
    except Exception as exc:
        print(f"[evolution_undo] create snapshot failed (fail-open): {exc}")
        return None


def prune_snapshots(workspace_root: Optional[str] = None, keep: int = MAX_SNAPSHOTS) -> int:
    """Retain only the most recent `keep` snapshots, pruning older files."""
    try:
        undo_dir = _resolve_undo_dir(workspace_root)
        files = [
            os.path.join(undo_dir, f)
            for f in os.listdir(undo_dir)
            if f.endswith(".bak") and "__" in f
        ]
        if len(files) <= keep:
            return 0

        # Sort ascending by mtime so oldest are first
        files.sort(key=lambda p: os.path.getmtime(p))
        to_delete = files[: len(files) - keep]
        pruned = 0
        for p in to_delete:
            try:
                os.remove(p)
                pruned += 1
            except OSError:
                pass
        return pruned
    except Exception:
        return 0


def list_undo(workspace_root: Optional[str] = None) -> List[Dict[str, Any]]:
    """List available snapshots ordered from newest to oldest."""
    try:
        undo_dir = _resolve_undo_dir(workspace_root)
        entries = []
        for name in os.listdir(undo_dir):
            if not name.endswith(".bak") or "__" not in name:
                continue
            parts = name[:-4].split("__")
            if len(parts) != 3:
                continue
            ts_str, prop_id, target = parts
            path = os.path.join(undo_dir, name)
            try:
                ts = int(ts_str) / 1000.0
            except ValueError:
                ts = os.path.getmtime(path)

            entries.append({
                "timestamp": ts,
                "proposal_id": prop_id,
                "target_file": target,
                "backup_path": path,
            })

        entries.sort(key=lambda e: e["timestamp"], reverse=True)
        return entries
    except Exception:
        return []


def undo(
    workspace_root: Optional[str] = None,
    proposal_id: Optional[str] = None,
    store: Optional[Any] = None,
) -> Result:
    """Restore target file from the corresponding snapshot and record correction."""
    ws = workspace_root or os.getcwd()
    history = list_undo(ws)
    if not history:
        return Result.failure("Snapshot not found to undo.")

    target_entry = None
    if proposal_id:
        for entry in history:
            if entry["proposal_id"] == proposal_id:
                target_entry = entry
                break
        if target_entry is None:
            return Result.failure(f"Snapshot not found for proposal: {proposal_id}")
    else:
        target_entry = history[0]

    backup_path = target_entry["backup_path"]
    target_file = target_entry["target_file"]
    target_full_path = os.path.join(ws, target_file)

    try:
        with open(backup_path, "r", encoding="utf-8") as f:
            backup_content = f.read()

        temp_fd, temp_path = tempfile.mkstemp(dir=ws, prefix="undo_", suffix=".tmp")
        try:
            with os.fdopen(temp_fd, "w", encoding="utf-8") as f:
                f.write(backup_content)
            os.replace(temp_path, target_full_path)
        except Exception:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise

        # Record negative feedback signal into evolution store
        try:
            evo_store = store
            if evo_store is None:
                from evolution import get_evolution_engine
                engine = get_evolution_engine(ws)
                evo_store = getattr(engine, "store", None)

            if evo_store and hasattr(evo_store, "record_signal"):
                evo_store.record_signal(
                    kind="user_correction",
                    tool_name="evolution_undo",
                    detail=f"Undone accepted evolution proposal: {target_entry['proposal_id']} on {target_file}",
                    failure_kind="user_correction",
                )
        except Exception as sig_exc:
            print(f"[evolution_undo] record user_correction signal failed (fail-open): {sig_exc}")

        return Result.success({
            "status": "undone",
            "proposal_id": target_entry["proposal_id"],
            "target_file": target_file,
            "restored_from": backup_path,
        })
    except Exception as exc:
        return Result.failure(f"Failed to undo proposal: {exc}")
