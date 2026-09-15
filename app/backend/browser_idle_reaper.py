"""Browser idle auto-suspend and zombie reaper.

Periodically scans browser sessions and suspends those idle beyond a configurable timeout,
shielding active runs and preserving state for subsequent resumption.
Based on community reference implementation for browser process lifecycle and idle harvesting.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Callable, Optional, List, Any

from browser_sessions import BrowserSessionManager, TAB_ACTIVE


class IdleReaper:
    """Daemon worker that auto-suspends idle browser sessions."""

    def __init__(
        self,
        manager: BrowserSessionManager,
        idle_timeout_s: float = 1800.0,
        scan_interval_s: float = 60.0,
        on_notify: Optional[Callable[[str, list[str]], None]] = None,
        clock: Optional[Callable[[], float]] = None,
    ):
        self.manager = manager
        env_val = os.environ.get("OVOLVE_BROWSER_IDLE_TIMEOUT_S")
        if env_val is not None:
            try:
                idle_timeout_s = float(env_val)
            except ValueError:
                pass
        self.idle_timeout_s = idle_timeout_s
        self.scan_interval_s = scan_interval_s
        self.on_notify = on_notify
        self._clock = clock or time.time
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        """Start the background reaper daemon thread."""
        if self.idle_timeout_s <= 0:
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run_loop, name="browser-idle-reaper", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        """Stop the background reaper daemon thread."""
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def scan(self, now: Optional[float] = None) -> List[str]:
        """Scan all sessions and auto-suspend those idle beyond the threshold.

        Returns:
            List of suspended task_ids.
        """
        if self.idle_timeout_s <= 0:
            return []

        current_time = now if now is not None else self._clock()
        reaped: List[str] = []

        # Safe iteration over sessions snapshot
        sessions_items = list(getattr(self.manager, "_sessions", {}).items())
        for task_id, session in sessions_items:
            try:
                # 1. Active-run guard: do not reap if session is marked active_until
                active_until = float(getattr(session, "active_until", 0.0) or 0.0)
                if current_time < active_until:
                    continue

                # 2. Check if there are any active tabs in this session
                tabs = getattr(session, "tabs", {})
                has_active_tabs = any(
                    getattr(tab, "state", None) == TAB_ACTIVE for tab in tabs.values()
                )
                if not has_active_tabs:
                    continue

                # 3. Check idle duration
                last_active = float(getattr(session, "last_active", getattr(session, "created_at", current_time)))
                idle_s = current_time - last_active
                if idle_s >= self.idle_timeout_s:
                    res = self.manager.suspend_session(task_id)
                    if res and getattr(res, "ok", False):
                        reaped.append(task_id)
            except Exception:
                # Fail-open: continue scanning remaining sessions even if one is broken
                continue

        if reaped and self.on_notify:
            try:
                self.on_notify("idle_suspend", reaped)
            except Exception:
                pass

        return reaped

    def _run_loop(self) -> None:
        """Main loop of daemon thread."""
        while not self._stop_event.is_set():
            try:
                self.scan()
            except Exception:
                pass
            self._stop_event.wait(self.scan_interval_s)

