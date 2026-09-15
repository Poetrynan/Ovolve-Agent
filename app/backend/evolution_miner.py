# -*- coding: utf-8 -*-
"""evolution_miner.py — Background idle evolution miner and session finalizer.

Runs periodically to:
1. Scan live sessions, skipping active/in-progress turns.
2. Finalize inactive/idle sessions by flushing pre-compaction memories so conversations
   that ended without explicit compaction don't lose learned facts.
3. Trigger workspace-level rule mining to synthesize accumulated signals into proposals.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Dict, List, Optional

from turn_state import TurnStatus


class EvolutionMiner:
    """Background engine scanning idle sessions and triggering workspace-level mining."""

    def __init__(
        self,
        session_host: Optional[Any] = None,
        interval_s: Optional[float] = None,
        idle_threshold_s: float = 300.0,
        workspace_root: Optional[str] = None,
    ) -> None:
        self.session_host = session_host
        self.workspace_root = workspace_root or os.getcwd()
        self.idle_threshold_s = idle_threshold_s

        # Interval priority: explicit arg > env var > default 300s
        if interval_s is not None:
            self.interval_s = float(interval_s)
        else:
            env_val = os.environ.get("OVOLVE_EVOLUTION_MINER_INTERVAL_S")
            self.interval_s = float(env_val) if env_val is not None else 300.0

        self._running = False
        self._task: Optional[asyncio.Task] = None
        # session_id -> timestamp of last message finalized
        self._finalized_sessions: Dict[str, float] = {}

    def is_enabled(self) -> bool:
        return self.interval_s > 0

    async def scan_once(self) -> Dict[str, Any]:
        """Perform a single pass of idle session finalization and workspace mining."""
        if not self.is_enabled():
            return {"status": "disabled", "ok": True}

        skipped_active: List[str] = []
        finalized_idle: List[str] = []
        proposals_made: int = 0

        try:
            host = self.session_host
            if host is None:
                try:
                    from session_host import get_session_host
                    host = get_session_host()
                except Exception:
                    host = None

            session_ids: List[str] = []
            if host and hasattr(host, "list_sessions"):
                session_ids = host.list_sessions()

            # 1. Inspect sessions and process idle ones
            try:
                from turn_state import get_turn_state
                state_machine = get_turn_state()
            except Exception:
                state_machine = None

            now = time.time()
            for sid in session_ids:
                # Check active turn status
                if state_machine:
                    current_status = state_machine.current(sid)
                    if current_status in (TurnStatus.RUNNING, TurnStatus.WAITING_USER):
                        skipped_active.append(sid)
                        continue

                router = host.get(sid) if host else None
                if not router:
                    continue

                # Query messages to assess idleness
                msgs = []
                if hasattr(router, "storage") and router.storage:
                    try:
                        msgs = router.storage.get_messages(sid, limit=20) or []
                    except Exception:
                        msgs = []

                if msgs:
                    last_msg = msgs[-1]
                    last_ts = float(last_msg.get("timestamp") or last_msg.get("created_at") or 0.0)
                    if (now - last_ts) >= self.idle_threshold_s:
                        prev_finalized = self._finalized_sessions.get(sid, 0.0)
                        if prev_finalized < last_ts:
                            if hasattr(router, "_flush_memory_for_fold"):
                                try:
                                    await router._flush_memory_for_fold(msgs)
                                except Exception as flush_exc:
                                    print(f"[evolution_miner] flush idle session {sid} failed: {flush_exc}")
                            self._finalized_sessions[sid] = last_ts
                            finalized_idle.append(sid)

            # 2. Trigger workspace-level mining across shared signals database
            try:
                from evolution import get_evolution_engine
                engine = get_evolution_engine(self.workspace_root)
                if engine and engine.enabled():
                    made = engine.maybe_mine()
                    proposals_made = len(made)
            except Exception as mine_exc:
                print(f"[evolution_miner] workspace mine failed (fail-open): {mine_exc}")

            return {
                "ok": True,
                "skipped_active": skipped_active,
                "finalized_idle": finalized_idle,
                "proposals_made": proposals_made,
            }
        except Exception as exc:
            # Absolute fail-open: background miner must never crash host process
            print(f"[evolution_miner] scan_once error (fail-open): {exc}")
            return {"ok": False, "error": str(exc)}

    async def run_loop(self) -> None:
        """Continuous polling loop."""
        self._running = True
        while self._running:
            try:
                await self.scan_once()
            except Exception as exc:
                print(f"[evolution_miner] run_loop cycle exception: {exc}")
            try:
                await asyncio.sleep(self.interval_s)
            except asyncio.CancelledError:
                break

    def start(self, loop: Optional[asyncio.AbstractEventLoop] = None) -> Optional[asyncio.Task]:
        """Start the background miner task if enabled."""
        if not self.is_enabled():
            return None
        if self._task and not self._task.done():
            return self._task

        current_loop = loop or asyncio.get_event_loop()
        self._task = current_loop.create_task(self.run_loop())
        return self._task

    def stop(self) -> None:
        """Stop background miner task."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None


_miner: Optional[EvolutionMiner] = None


def get_evolution_miner(
    session_host: Optional[Any] = None,
    workspace_root: Optional[str] = None,
) -> EvolutionMiner:
    """Process singleton accessor for EvolutionMiner."""
    global _miner
    if _miner is None:
        _miner = EvolutionMiner(
            session_host=session_host,
            workspace_root=workspace_root,
        )
    elif session_host and not _miner.session_host:
        _miner.session_host = session_host
    return _miner
