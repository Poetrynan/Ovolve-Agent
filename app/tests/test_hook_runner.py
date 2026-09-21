"""Test hook_runner: config validation, execution protocol, bus integration."""
import asyncio
import json
import os
import sys
import tempfile

import pytest

from hook_runner import HookRunner, HOOK_EVENTS
from event_bus import EventBus


def write_config(tmpdir, cfg) -> str:
    path = os.path.join(tmpdir, "hooks.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    return path


def make_runner(tmpdir, cfg) -> HookRunner:
    runner = HookRunner(project_dir=tmpdir, session_id="s1")
    runner.load([write_config(tmpdir, cfg)])
    return runner


# ── config loading & validation ───────────────────────────────────

def test_disabled_by_default():
    """No config on disk -> runner stays disabled and fires nothing."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = HookRunner(project_dir=tmp)
        summary = runner.load([os.path.join(tmp, "nope.json")])
        assert summary["enabled"] is False
        assert summary["registered"] == 0
        assert asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"})) == []


def test_enabled_registers_hooks():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [
                {"matcher": "bash", "hooks": [{"type": "command", "command": "echo hi"}]}
            ]},
        })
        assert runner.enabled is True
        assert len(runner.matchers["PreToolUse"]) == 1


def test_unsupported_event_reported():
    """An event name we don't dispatch is reported, not silently dropped.

    Used to probe with ``PreCompact``, which has since become a real supported
    event (the bus now maps ``session_before_compact`` onto it), so the test was
    asserting the opposite of the shipped behaviour. Probing with a name that is
    not in SUPPORTED_EVENTS keeps the check about the mechanism instead of about
    one event's status.
    """
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"NotAnEvent": [{"hooks": [{"command": "echo x"}]}]},
        })
        assert any("NotAnEvent" in p for p in runner.problems)
        assert "NotAnEvent" not in runner.matchers


def test_invalid_regex_reported_and_dropped():
    """An unparseable matcher would never fire — surface it instead."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [
                {"matcher": "[unclosed", "hooks": [{"command": "echo x"}]}
            ]},
        })
        assert any("not a valid regex" in p for p in runner.problems)
        assert runner.matchers["PreToolUse"] == []


def test_mixed_type_fields_rejected():
    """A process hook must not carry command-hook fields like `shell`."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [
                {"hooks": [{"type": "process", "command": "python", "shell": True}]}
            ]},
        })
        assert any("not valid for its type" in p for p in runner.problems)
        assert runner.matchers["PreToolUse"] == []


def test_timeout_seconds_converted_to_ms():
    """`timeout` is seconds, `timeoutMs` is milliseconds; only ms travels on."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [
                {"hooks": [
                    {"type": "command", "command": "echo a", "timeout": 3},
                    {"type": "command", "command": "echo b", "timeoutMs": 250},
                ]}
            ]},
        })
        specs = runner.matchers["PreToolUse"][0]["hooks"]
        assert specs[0]["timeout_ms"] == 3000
        assert specs[1]["timeout_ms"] == 250


def test_plugin_shape_hooks_key_accepted():
    """A hooks.json copied from a plugin uses `hooks:` not `events:`."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "hooks": {"Stop": [{"hooks": [{"command": "echo done"}]}]},
        })
        assert len(runner.matchers["Stop"]) == 1


def test_all_seven_events_accepted():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {e: [{"hooks": [{"command": "echo x"}]}] for e in HOOK_EVENTS},
        })
        assert runner.problems == []
        assert all(runner.matchers[e] for e in HOOK_EVENTS)


# ── real subprocess execution ─────────────────────────────────────

def test_exit_zero_passes():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable, "args": ["-c", "pass"]}
            ]}]},
        })
        out = asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert len(out) == 1
        assert out[0].status == "pass"


def test_exit_two_blocks():
    """Exit code 2 is a deliberate deny."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "import sys; print('nope'); sys.exit(2)"]}
            ]}]},
        })
        out = asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert out[0].status == "block"
        assert out[0].decision == "deny"
        assert "nope" in out[0].reason


def test_other_nonzero_is_error_not_block():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "import sys; sys.exit(7)"]}
            ]}]},
        })
        out = asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert out[0].status == "error"


def test_additional_context_captured():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"UserPromptSubmit": [{"hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "print('{\"additionalContext\": \"ticket ABC-1\"}')"]}
            ]}]},
        })
        out = asyncio.run(runner.fire("user_prompt_submit", {"message": "hi"}))
        assert out[0].status == "pass"
        assert out[0].context == "ticket ABC-1"


def test_strict_schema_rejects_unknown_key():
    """An extra output key invalidates the payload — the schema is strict."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "print('{\"bogusKey\": 1}')"]}
            ]}]},
        })
        out = asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert out[0].status == "invalid"
        assert "bogusKey" in out[0].reason


def test_permission_decision_deny_blocks():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "print('{\"permissionDecision\": \"deny\", "
                                "\"permissionDecisionReason\": \"policy\"}')"]}
            ]}]},
        })
        out = asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert out[0].status == "block"
        assert out[0].decision == "deny"
        assert out[0].reason == "policy"


def test_timeout_kills_hook():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "import time; time.sleep(10)"], "timeoutMs": 300}
            ]}]},
        })
        out = asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert out[0].status == "timeout"


def test_missing_executable_is_error_not_crash():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": "definitely-not-a-real-binary-xyz"}
            ]}]},
        })
        out = asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert out[0].status == "error"


# ── matcher semantics ─────────────────────────────────────────────

def test_matcher_is_case_sensitive():
    """`bash` must not match tool name `Bash` — documented footgun."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [
                {"matcher": "bash", "hooks": [
                    {"type": "process", "command": sys.executable, "args": ["-c", "pass"]}
                ]}
            ]},
        })
        assert asyncio.run(runner.fire("pre_tool_use", {"tool_name": "Bash"})) == []
        assert len(asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))) == 1


def test_omitted_matcher_matches_everything():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable, "args": ["-c", "pass"]}
            ]}]},
        })
        assert len(asyncio.run(runner.fire("pre_tool_use", {"tool_name": "anything"}))) == 1


def test_tool_result_fans_out_by_success():
    """tool_result maps to PostToolUse or PostToolUseFailure by result.ok."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PostToolUseFailure": [{"hooks": [
                {"type": "process", "command": sys.executable, "args": ["-c", "pass"]}
            ]}]},
        })
        ok_payload = {"tool_name": "bash", "result": {"ok": True}}
        bad_payload = {"tool_name": "bash", "result": {"ok": False}}
        assert asyncio.run(runner.fire("tool_result", ok_payload)) == []
        assert len(asyncio.run(runner.fire("tool_result", bad_payload))) == 1


# ── bus integration ───────────────────────────────────────────────

def test_mounted_hook_blocks_pre_tool_use():
    """A denying hook must block the event on the real bus."""
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"matcher": "bash", "hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "import sys; print('forbidden'); sys.exit(2)"]}
            ]}]},
        })
        bus = EventBus()
        runner.mount(bus)
        event = asyncio.run(bus.emit("pre_tool_use", {"tool_name": "bash", "args": {}}))
        assert event.action.value == "block"
        assert "forbidden" in event.block_reason


def test_mounted_hook_injects_context():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"UserPromptSubmit": [{"hooks": [
                {"type": "process", "command": sys.executable,
                 "args": ["-c", "print('{\"additionalContext\": \"extra\"}')"]}
            ]}]},
        })
        bus = EventBus()
        runner.mount(bus)
        event = asyncio.run(bus.emit("user_prompt_submit", {"message": "hello"}))
        assert event.payload["hook_context"] == ["extra"]


def test_execution_log_records_outcome():
    with tempfile.TemporaryDirectory() as tmp:
        runner = make_runner(tmp, {
            "enabled": True,
            "events": {"PreToolUse": [{"hooks": [
                {"type": "process", "command": sys.executable, "args": ["-c", "pass"]}
            ]}]},
        })
        asyncio.run(runner.fire("pre_tool_use", {"tool_name": "bash"}))
        assert len(runner.log) == 1
        assert runner.log[0]["status"] == "pass"
        assert runner.log[0]["event"] == "PreToolUse"
