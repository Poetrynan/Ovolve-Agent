"""Confused-deputy detection: workspace boundary + provenance.

The detector had no coverage at all, and the judgment it shipped with
(``".." in val or os.path.isabs(val)``) never compared the target against the
workspace. Both halves of that failure are pinned here: in-workspace absolute
paths must stay silent, and home-relative escapes must not.
"""
from __future__ import annotations

import os

import pytest

from red_team import RedTeam


@pytest.fixture
def rt():
    return RedTeam()


def _ctx(ws, **kw):
    ctx = {"workspace_root": str(ws)}
    ctx.update(kw)
    return ctx


# --- false positives the old heuristic produced ---------------------------

def test_absolute_path_inside_workspace_is_not_a_signal(rt, tmp_path):
    """The regression the user hit: their own file, flagged for being absolute."""
    target = os.path.join(str(tmp_path), "app", "main.py")
    assert rt.confused_deputy_signals("write_file", {"path": target}, _ctx(tmp_path)) == []


def test_workspace_relative_path_is_not_a_signal(rt, tmp_path):
    assert rt.confused_deputy_signals("write_file", {"path": "app/main.py"}, _ctx(tmp_path)) == []


def test_scratch_dirs_are_not_signals(rt, tmp_path):
    for sub in ("temp", "output"):
        target = os.path.join(str(tmp_path), sub, "artifact.bin")
        assert rt.confused_deputy_signals("write_file", {"path": target}, _ctx(tmp_path)) == []


def test_double_dot_in_filename_is_not_traversal(rt, tmp_path):
    """``".." in val`` was a substring test, so a filename tripped it."""
    target = os.path.join(str(tmp_path), "report..v2.html")
    assert rt.confused_deputy_signals("write_file", {"path": target}, _ctx(tmp_path)) == []


def test_traversal_that_lands_back_inside_is_not_a_signal(rt, tmp_path):
    assert rt.confused_deputy_signals(
        "write_file", {"path": "app/../app/main.py"}, _ctx(tmp_path),
    ) == []


# --- false negatives the old heuristic let through ------------------------

def test_home_relative_escape_is_flagged(rt, tmp_path):
    """``~/.ssh/id_rsa``: not absolute, no ``..`` -- the old check never saw it."""
    signals = rt.confused_deputy_signals(
        "read_file", {"path": os.path.join("~", ".ssh", "id_rsa")}, _ctx(tmp_path),
    )
    assert any("cross-context path target in `path`" in s for s in signals)


def test_env_var_escape_is_flagged(rt, tmp_path):
    var = "%USERPROFILE%" if os.name == "nt" else "$HOME"
    signals = rt.confused_deputy_signals(
        "read_file", {"path": f"{var}/.ssh/id_rsa"}, _ctx(tmp_path),
    )
    assert any("cross-context path target" in s for s in signals)


def test_traversal_to_sensitive_target_is_flagged(rt, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    signals = rt.confused_deputy_signals(
        "write_file", {"path": os.path.join("..", ".ssh", "authorized_keys")}, _ctx(ws),
    )
    assert any("cross-context path target" in s for s in signals)


# --- sensitivity gate: benign artifacts outside the fence ----------------

def test_agent_authored_report_outside_workspace_is_not_a_signal(rt, tmp_path):
    """The regression the user hit: `powercfg /batteryreport` writes its HTML to
    the home directory, the user never typed a path, and the detector called it
    a confused deputy. A fresh non-sensitive file is not an exfil channel."""
    ctx = _ctx(tmp_path, user_message="我的电池健康度是多少？帮我查查")
    for key in ("path", "output_path"):
        assert rt.confused_deputy_signals(
            "read_text", {key: os.path.join("~", "battery_report.html")}, ctx,
        ) == []


def test_ordinary_home_file_outside_workspace_is_not_a_signal(rt, tmp_path):
    assert rt.confused_deputy_signals(
        "write_file", {"path": os.path.join("~", "Documents", "notes.txt")}, _ctx(tmp_path),
    ) == []


def test_benign_traversal_out_of_workspace_is_not_a_signal(rt, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    assert rt.confused_deputy_signals(
        "write_file", {"path": os.path.join("..", "escaped.txt")}, _ctx(ws),
    ) == []


@pytest.mark.parametrize("target", [
    os.path.join("~", ".aws", "credentials"),
    os.path.join("~", ".gnupg", "secring.gpg"),
    os.path.join("~", ".git-credentials"),
    os.path.join("~", "server.pem"),
    os.path.join("~", "app", ".env"),
    os.path.join("~", ".kube", "config"),
])
def test_sensitive_targets_outside_workspace_are_flagged(rt, tmp_path, target):
    signals = rt.confused_deputy_signals("read_file", {"path": target}, _ctx(tmp_path))
    assert any("cross-context path target" in s for s in signals)


def test_sensitive_file_inside_workspace_is_not_a_signal(rt, tmp_path):
    """The fence still comes first: the project's own `.env` is the project's."""
    assert rt.confused_deputy_signals(
        "read_file", {"path": os.path.join(str(tmp_path), ".env")}, _ctx(tmp_path),
    ) == []


def test_missing_workspace_context_fails_closed(rt):
    """An absent workspace_root used to skip the loop entirely."""
    signals = rt.confused_deputy_signals("write_file", {"path": "/etc/passwd"}, {})
    assert any("unverifiable path target" in s for s in signals)


# --- provenance: who asked for the path ----------------------------------

def test_user_typed_path_is_authorization(rt, tmp_path):
    """The user naming an outside path is consent, not a confused deputy."""
    outside = os.path.join(os.path.expanduser("~"), "Desktop", "battery_report.html")
    ctx = _ctx(tmp_path, user_message=f"打开 {outside} 看一下")
    assert rt.confused_deputy_signals("read_file", {"path": outside}, ctx) == []


def test_user_typed_tilde_form_authorizes_expanded_target(rt, tmp_path):
    """The user writes ``~\\Desktop\\x``; the model calls with the full path."""
    expanded = os.path.join(os.path.expanduser("~"), "Desktop", "battery_report.html")
    ctx = _ctx(tmp_path, user_message="读一下 ~/Desktop/battery_report.html")
    assert rt.confused_deputy_signals("read_file", {"path": expanded}, ctx) == []


def test_path_the_user_never_mentioned_is_still_flagged(rt, tmp_path):
    """The injected case: an unrelated request, a path out of nowhere."""
    ctx = _ctx(tmp_path, user_message="总结一下这个网页讲了什么")
    signals = rt.confused_deputy_signals(
        "read_file", {"path": os.path.join("~", ".ssh", "id_rsa")}, ctx,
    )
    assert any("cross-context path target" in s for s in signals)


def test_empty_user_message_does_not_authorize(rt, tmp_path):
    ctx = _ctx(tmp_path, user_message="   ")
    signals = rt.confused_deputy_signals("read_file", {"path": "~/.ssh/id_rsa"}, ctx)
    assert any("cross-context path target" in s for s in signals)


# --- the remote-privileged-tool vector (unchanged behaviour) --------------

def test_remote_session_privileged_tool_is_flagged(rt, tmp_path):
    signals = rt.confused_deputy_signals("shell_executor", {}, _ctx(tmp_path, is_remote=True))
    assert any("remote session invoking privileged tool" in s for s in signals)


def test_local_session_privileged_tool_is_not_flagged(rt, tmp_path):
    assert rt.confused_deputy_signals("shell_executor", {}, _ctx(tmp_path)) == []


# --- shape / robustness --------------------------------------------------

def test_every_path_key_is_inspected(rt, tmp_path):
    args = {k: os.path.join("~", ".ssh", "id_rsa") for k in ("path", "src", "dst", "output_path")}
    signals = rt.confused_deputy_signals("move_file", args, _ctx(tmp_path))
    for key in ("path", "src", "dst", "output_path"):
        assert any(f"`{key}`" in s for s in signals)


def test_non_string_and_blank_values_are_ignored(rt, tmp_path):
    args = {"path": None, "src": 42, "dst": "", "output_path": "   "}
    assert rt.confused_deputy_signals("move_file", args, _ctx(tmp_path)) == []


def test_none_args_and_context_do_not_raise(rt):
    assert rt.confused_deputy_signals("write_file", None, None) == []
