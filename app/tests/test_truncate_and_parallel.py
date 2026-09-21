"""Test Head-Tail truncation and the parallel-safe tool classifier.

Both are small pure-ish functions guarding real failure modes:
  · head-only truncation hid the tail of build/test output, where the actual
    error lives, from the model.
  · a wrong parallel-safe verdict would run a write concurrently with a read.
"""
import pytest

from tools import truncate
from router import PARALLEL_SAFE_TOOLS, Router
from risk_control import RiskLevel


# ── truncate ────────────────────────────────────────────────────────────────

def test_short_text_passes_through():
    assert truncate("hello", 100) == "hello"


def test_empty_and_none_are_empty():
    assert truncate("", 100) == ""
    assert truncate(None, 100) == ""


def test_exact_length_is_not_truncated():
    text = "x" * 100
    assert truncate(text, 100) == text


def test_keeps_both_head_and_tail():
    """The whole point: the tail must survive."""
    text = "HEAD_MARKER" + ("m" * 5000) + "TAIL_MARKER"
    out = truncate(text, 1000)
    assert out.startswith("HEAD_MARKER")
    assert out.endswith("TAIL_MARKER")


def test_reports_how_much_was_omitted():
    text = "a" * 10_000
    out = truncate(text, 1000)
    assert "已省略中间" in out
    # 10000 - 600 head - 400 tail = 9000
    assert "9,000" in out


def test_pytest_style_failure_is_preserved():
    """Regression: the AssertionError at the end used to be cut off."""
    log = "\n".join(f"test_thing_{i} PASSED" for i in range(2000))
    log += "\n\nE   AssertionError: expected 3 got 4\n=== 1 failed, 2000 passed ==="
    out = truncate(log, 2000)
    assert "AssertionError: expected 3 got 4" in out
    assert "1 failed" in out


def test_head_is_larger_than_tail():
    """~60/40 split — leading context is slightly more often useful."""
    text = "H" * 4000 + "T" * 4000
    out = truncate(text, 1000)
    head = out.split("\n\n... [")[0]
    tail = out.split("] ...\n\n")[-1]
    assert len(head) > len(tail)


def test_output_length_is_bounded():
    """The divider adds a little, but the payload itself respects the cap."""
    text = "x" * 100_000
    out = truncate(text, 5000)
    payload = out.replace("\n\n", "").split("... [")[0] + out.split("] ...")[-1]
    assert len(payload) <= 5000 + 8  # small slack for the stripped newlines


# ── parallel-safe classifier ────────────────────────────────────────────────

class _RiskStub:
    """Minimal risk controller: everything in the whitelist is LOW."""
    def __init__(self, escalate: set[str] | None = None):
        self.escalate = escalate or set()

    def classify_risk(self, name, args=None):
        if name in self.escalate:
            return RiskLevel.HIGH
        return RiskLevel.LOW if name in PARALLEL_SAFE_TOOLS else RiskLevel.MEDIUM


class _Bare:
    """Router's parallel-safety surface without its constructor."""
    _is_parallel_safe = Router._is_parallel_safe

    def __init__(self, escalate=None):
        self.risk = _RiskStub(escalate)


def test_reads_are_parallel_safe():
    r = _Bare()
    for name in ("read_text", "search_code", "list_dir", "web_search", "git_status"):
        assert r._is_parallel_safe({"name": name}), name


def test_writes_are_not_parallel_safe():
    r = _Bare()
    for name in ("write_file", "edit_file", "delete_file", "git_commit"):
        assert not r._is_parallel_safe({"name": name}), name


def test_shell_is_not_parallel_safe():
    r = _Bare()
    for name in ("bash", "shell_executor", "python_executor"):
        assert not r._is_parallel_safe({"name": name}), name


def test_unknown_tool_is_not_parallel_safe():
    """Default deny — an unrecognized tool must never be assumed side-effect-free."""
    r = _Bare()
    assert not r._is_parallel_safe({"name": "some_new_plugin_tool"})


def test_missing_name_is_not_parallel_safe():
    r = _Bare()
    assert not r._is_parallel_safe({})


def test_escalated_tool_falls_back_to_serial():
    """A remote-session denylist can escalate even a read — respect that."""
    r = _Bare(escalate={"web_fetch"})
    assert not r._is_parallel_safe({"name": "web_fetch"})
    assert r._is_parallel_safe({"name": "read_text"})


def test_whitelist_contains_no_mutating_tool():
    """Guard the constant itself against a careless future addition."""
    forbidden = {
        "write_file", "edit_file", "delete_file", "convert_file",
        "bash", "shell_executor", "python_executor", "dispatch_task",
        "git_add", "git_commit", "git_push", "git_push_force",
        "git_reset_hard", "git_clean", "git_checkout", "git_pull",
        "git_branch", "cron_create", "todo_write", "use_skill",
    }
    assert not (PARALLEL_SAFE_TOOLS & forbidden)
