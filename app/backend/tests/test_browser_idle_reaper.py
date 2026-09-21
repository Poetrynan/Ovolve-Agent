"""Tests for browser session idle reaper and auto-suspend.

Based on community reference implementation for browser process lifecycle and idle harvesting.
"""
import pytest
from unittest.mock import MagicMock
from result import Result
from browser_sessions import BrowserSessionManager, TAB_ACTIVE, TAB_SUSPENDED
from browser_idle_reaper import IdleReaper


class FakeBridge:
    def __init__(self):
        self.calls = []

    def call(self, endpoint, payload, timeout=35):
        self.calls.append((endpoint, payload))
        return Result.success({"ok": True})


def _setup_manager_with_session(task_id="task-1", t0=1000.0):
    bridge = FakeBridge()
    mgr = BrowserSessionManager(client=bridge)
    mgr.begin_session(task_id)
    session = mgr._sessions[task_id]
    session.created_at = t0
    session.last_active = t0
    # Add an active tab
    res = mgr.open_tab(task_id, url="https://example.com")
    assert res.ok
    tab_id = res.value["tab_id"]
    assert session.tabs[tab_id].state == TAB_ACTIVE
    session.tabs[tab_id].opened_at = t0
    session.tabs[tab_id].last_active = t0
    return mgr, session, bridge, tab_id


def test_idle_session_suspended():
    t0 = 1000.0
    mgr, session, bridge, tab_id = _setup_manager_with_session("task-1", t0)
    reaper = IdleReaper(mgr, idle_timeout_s=1800)

    # 100 seconds later: not idle enough
    assert reaper.scan(now=t0 + 100.0) == []
    assert session.tabs[tab_id].state == TAB_ACTIVE

    # 1801 seconds later: exceeds timeout -> suspended
    reaped = reaper.scan(now=t0 + 1801.0)
    assert reaped == ["task-1"]
    assert session.tabs[tab_id].state == TAB_SUSPENDED
    # Ensure bridge called tab_suspend, NOT tab_close (non-destructive)
    endpoints = [c[0] for c in bridge.calls]
    assert "tab_suspend" in endpoints
    assert "tab_close" not in endpoints


def test_active_session_not_suspended():
    t0 = 1000.0
    mgr, session, bridge, tab_id = _setup_manager_with_session("task-1", t0)
    reaper = IdleReaper(mgr, idle_timeout_s=1800)

    # Touch at t0 + 1000s
    mgr.touch("task-1", now=t0 + 1000.0)

    # At t0 + 1900s, only 900s has elapsed since touch
    reaped = reaper.scan(now=t0 + 1900.0)
    assert reaped == []
    assert session.tabs[tab_id].state == TAB_ACTIVE


def test_active_run_guard_shields_from_reap():
    t0 = 1000.0
    mgr, session, bridge, tab_id = _setup_manager_with_session("task-1", t0)
    reaper = IdleReaper(mgr, idle_timeout_s=1800)

    # Mark active run for 3000s
    mgr.mark_run_active("task-1", duration_s=3000.0, now=t0)

    # Even though 2000s passed without touch, active_until is t0 + 3000
    reaped = reaper.scan(now=t0 + 2000.0)
    assert reaped == []
    assert session.tabs[tab_id].state == TAB_ACTIVE


def test_timeout_zero_disabled(monkeypatch):
    t0 = 1000.0
    mgr, session, _, tab_id = _setup_manager_with_session("task-1", t0)
    monkeypatch.setenv("OVOLVE_BROWSER_IDLE_TIMEOUT_S", "0")
    reaper = IdleReaper(mgr)
    assert reaper.idle_timeout_s == 0.0

    # Never reaps when timeout is 0
    reaped = reaper.scan(now=t0 + 999999.0)
    assert reaped == []
    assert session.tabs[tab_id].state == TAB_ACTIVE


def test_exception_fail_open():
    mgr = BrowserSessionManager(client=FakeBridge())
    # Malformed session that raises on attribute access
    class BrokenSession:
        @property
        def active_until(self):
            raise RuntimeError("Corrupted session internal state")

    mgr._sessions["broken-task"] = BrokenSession()
    reaper = IdleReaper(mgr, idle_timeout_s=100)

    # Should not raise exception; fail-open and skip
    reaped = reaper.scan(now=1000.0)
    assert reaped == []

