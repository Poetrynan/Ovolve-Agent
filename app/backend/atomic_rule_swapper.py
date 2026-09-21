# -*- coding: utf-8 -*-
"""atomic_rule_swapper.py — OS-level atomic file replacement & snapshot rollback (Module 3).

Implementation providing:
1. True atomic replacement via os.replace on the same filesystem/device.
2. fsync persistence guarantees before rename.
3. Automatic pre-swap snapshotting to .ovolve/snapshots/ with undo tokens.
4. Instant 1-step rollback capabilities.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import time
from typing import Optional, Union
import uuid


@dataclass
class SwapResult:
    success: bool
    target_path: Path
    snapshot_path: Optional[Path] = None
    undo_token: Optional[str] = None
    error: Optional[str] = None


class AtomicRuleSwapper:
    """Safely updates persistent rule files using OS-level atomic swaps."""

    def __init__(self, snapshot_dir: Optional[Union[str, Path]] = None):
        self.snapshot_dir = Path(snapshot_dir) if snapshot_dir else Path(".ovolve/snapshots")
        self._undo_registry: dict[str, dict[str, Path]] = {}

    def write_atomic(
        self,
        target_path: Union[str, Path],
        content: Union[str, bytes],
        encoding: str = "utf-8",
        create_snapshot: bool = True,
    ) -> SwapResult:
        """Atomically replaces target_path with content, taking a snapshot if existing."""
        target = Path(target_path).resolve()
        tmp_file: Optional[Path] = None
        snapshot_path: Optional[Path] = None
        undo_token: Optional[str] = None

        try:
            target.parent.mkdir(parents=True, exist_ok=True)

            # Create snapshot if file exists
            if target.exists() and create_snapshot:
                self.snapshot_dir.mkdir(parents=True, exist_ok=True)
                token = f"undo_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
                snap_name = f"{int(time.time())}_{uuid.uuid4().hex[:6]}_{target.name}"
                snap_file = self.snapshot_dir / snap_name
                shutil.copy2(target, snap_file)
                snapshot_path = snap_file
                undo_token = token
                self._undo_registry[token] = {
                    "target": target,
                    "snapshot": snap_file,
                }

            # Write to temporary file in the same directory (ensures same filesystem mount)
            tmp_name = f"{target.name}.tmp.{os.getpid()}.{uuid.uuid4().hex[:6]}"
            tmp_file = target.parent / tmp_name

            if isinstance(content, str):
                with open(tmp_file, "w", encoding=encoding) as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())
            else:
                with open(tmp_file, "wb") as f:
                    f.write(content)
                    f.flush()
                    os.fsync(f.fileno())

            # Atomic rename / replace
            os.replace(tmp_file, target)
            tmp_file = None  # Replaced successfully

            return SwapResult(
                success=True,
                target_path=target,
                snapshot_path=snapshot_path,
                undo_token=undo_token,
            )

        except Exception as exc:  # noqa: BLE001
            if tmp_file and tmp_file.exists():
                try:
                    tmp_file.unlink(missing_ok=True)
                except OSError:
                    pass
            return SwapResult(
                success=False,
                target_path=target,
                error=str(exc),
            )

    def rollback(self, undo_token: str) -> bool:
        """Restores a previous version using the undo token."""
        entry = self._undo_registry.get(undo_token)
        if not entry:
            return False

        target = entry["target"]
        snapshot = entry["snapshot"]

        if not snapshot.exists():
            return False

        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp_restore = target.parent / f"{target.name}.restore.{uuid.uuid4().hex[:6]}"
            shutil.copy2(snapshot, tmp_restore)
            os.replace(tmp_restore, target)
            return True
        except Exception:  # noqa: BLE001
            return False
