"""Track R2 — anti-tampering test write-protection in path_guard.py.

Mimics the sys.path handling used by the other tests in this directory via the
shared ``conftest.py`` (which puts ``app/backend`` on ``sys.path``), so a plain
``pytest`` from the repo root can import ``path_guard`` directly.
"""
from __future__ import annotations

import os

import pytest

from path_guard import (
    TAMPER_MARKER,
    PathGuard,
    _is_test_target,
    _test_protection_enabled,
)


class FakeEvent:
    """Minimal stand-in for event_bus.Event carrying only what path_guard uses."""

    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.blocked = False
        self.reason = ""
        self.asked = False

    def block(self, reason: str = "") -> None:
        self.blocked = True
        self.reason = reason

    def ask(self, prompt: str = "") -> None:  # pragma: no cover - not used here
        self.asked = True


def _attempt(guard: PathGuard, target: str, tool: str = "write_file", ws: str = "/tmp/ws") -> FakeEvent:
    if tool == "move_file":
        args = {"src": target, "dst": target + ".moved"}
    else:
        args = {"path": target}
    ev = FakeEvent({
        "tool_name": tool,
        "args": args,
        "context": {"workspace_root": ws},
    })
    guard._on_pre_tool_use(ev)
    return ev


# --------------------------------------------------------------------------
# Unit checks on the matcher
# --------------------------------------------------------------------------
def test_is_test_target_matches_spec_patterns():
    assert _is_test_target("/repo/tests/test_x.py")
    assert _is_test_target("/repo/tests/nested/foo_test.py")
    assert _is_test_target("/repo/foo_test.py")
    assert _is_test_target("/repo/bar.test.ts")
    assert _is_test_target("/repo/bar.test.tsx")
    assert _is_test_target("/repo/widget.spec.ts")
    assert _is_test_target("/repo/conftest.py")
    assert _is_test_target("/repo/pytest.ini")
    assert _is_test_target("/repo/vitest.config.js")
    assert _is_test_target("/repo/jest.config.ts")


def test_is_test_target_allows_non_test_paths():
    assert not _is_test_target("/repo/src/main.py")
    assert not _is_test_target("/repo/README.md")
    # unittest-style test_*.py is intentionally NOT covered by the spec
    assert not _is_test_target("/repo/test_math.py")


# --------------------------------------------------------------------------
# The guard blocks edits/deletes to test artifacts and carries TAMPER_DETECTED
# --------------------------------------------------------------------------
def test_write_to_tests_dir_is_blocked():
    ev = _attempt(PathGuard(), "tests/test_x.py")
    assert ev.blocked
    assert TAMPER_MARKER in ev.reason


def test_write_to_foo_test_py_is_blocked():
    ev = _attempt(PathGuard(), "foo_test.py")
    assert ev.blocked
    assert TAMPER_MARKER in ev.reason


def test_write_to_bar_test_ts_is_blocked():
    ev = _attempt(PathGuard(), "bar.test.ts")
    assert ev.blocked
    assert TAMPER_MARKER in ev.reason


def test_edit_and_delete_of_test_files_are_blocked():
    assert _attempt(PathGuard(), "tests/foo_test.py", tool="edit_file").blocked
    assert _attempt(PathGuard(), "bar.test.tsx", tool="delete_file").blocked
    assert _attempt(PathGuard(), "conftest.py", tool="move_file").blocked


def test_command_tool_write_to_test_is_blocked():
    ev = FakeEvent({
        "tool_name": "shell_executor",
        "args": {"command": "echo evil > tests/test_x.py"},
        "context": {"workspace_root": "/tmp/ws"},
    })
    PathGuard()._on_pre_tool_use(ev)
    assert ev.blocked
    assert TAMPER_MARKER in ev.reason


def test_edit_to_src_main_py_is_allowed():
    ev = _attempt(PathGuard(), "src/main.py")
    assert not ev.blocked
    assert not ev.asked


# --------------------------------------------------------------------------
# Escape hatch — default DENY, opt-in ALLOW
# --------------------------------------------------------------------------
def test_env_escape_hatch_allows_test_edits(monkeypatch):
    monkeypatch.setenv("OVOLVE_ALLOW_TEST_EDITS", "1")
    assert _test_protection_enabled(False) is False
    ev = _attempt(PathGuard(), "tests/test_x.py")
    assert not ev.blocked


def test_instance_flag_allows_test_edits(monkeypatch):
    monkeypatch.delenv("OVOLVE_ALLOW_TEST_EDITS", raising=False)
    ev = _attempt(PathGuard(allow_test_edits=True), "foo_test.py")
    assert not ev.blocked


def test_default_is_deny_without_override(monkeypatch):
    monkeypatch.delenv("OVOLVE_ALLOW_TEST_EDITS", raising=False)
    assert _test_protection_enabled(False) is True
    assert _test_protection_enabled(True) is False
