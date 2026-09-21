# -*- coding: utf-8 -*-
"""test_workflow_recorder.py — Tests for Workflow Record & Replay protocol (Gap D Phase 1).

Covers:
- WorkflowStep and Workflow dataclasses serialization and filesystem persistence
- WorkflowRecorder start, record_step, and stop lifecycle
- WorkflowReplayer execution with BareModifierGuard physical check
- Target / state existence pre-check and drift circuit breaker (immediate stop at step N)
- Builtin tool definitions: workflow_record_start, workflow_record_stop, workflow_replay, workflow_list
"""
import json
import pytest
from pathlib import Path
from unittest.mock import MagicMock

from result import Result
from workflow_recorder import (
    WorkflowStep,
    Workflow,
    WorkflowRecorder,
    WorkflowReplayer,
    save_workflow,
    load_workflow,
    list_workflows,
    get_workflow_recorder,
)


def test_workflow_model_serialization_and_disk(tmp_path: Path):
    steps = [
        WorkflowStep(
            step_index=0,
            tool_name="computer_action",
            action="click_element",
            params={"name": "Save", "control_type": "Button"},
            timestamp=1000.0,
            pre_state_hash="hash_step_0",
            expected_target={"name": "Save"},
        ),
        WorkflowStep(
            step_index=1,
            tool_name="browser_action",
            action="navigate",
            params={"url": "https://example.org"},
            timestamp=1001.5,
        ),
    ]
    wf = Workflow(
        id="wf_test_001",
        name="Save and Browse",
        created_at=1000.0,
        session_id="sess_123",
        episode_id="ep_456",
        description="Automated save then navigate",
        steps=steps,
        metadata={"author": "test_suite"},
    )

    # Save to disk
    filepath = save_workflow(wf, dir_path=tmp_path)
    assert Path(filepath).exists()

    # Load back
    loaded = load_workflow("wf_test_001", dir_path=tmp_path)
    assert loaded is not None
    assert loaded.id == "wf_test_001"
    assert loaded.name == "Save and Browse"
    assert loaded.session_id == "sess_123"
    assert loaded.episode_id == "ep_456"
    assert len(loaded.steps) == 2
    assert loaded.steps[0].action == "click_element"
    assert loaded.steps[0].expected_target == {"name": "Save"}
    assert loaded.steps[1].params == {"url": "https://example.org"}

    # List workflows
    listing = list_workflows(dir_path=tmp_path)
    assert len(listing) == 1
    assert listing[0]["id"] == "wf_test_001"
    assert listing[0]["name"] == "Save and Browse"
    assert listing[0]["step_count"] == 2


def test_workflow_recorder_lifecycle(tmp_path: Path):
    recorder = WorkflowRecorder(dir_path=tmp_path)
    assert not recorder.is_recording()

    rec_id = recorder.start_recording(
        session_id="session_alpha",
        name="Invoice Flow",
        episode_id="ep_invoice",
        description="Records invoice creation steps",
    )
    assert recorder.is_recording()
    assert rec_id.startswith("wf_")

    step0 = recorder.record_step(
        tool_name="computer_action",
        params={"action": "click", "x": 100, "y": 200},
        expected_target={"text": "New Invoice"},
    )
    assert step0 is not None
    assert step0.step_index == 0
    assert step0.action == "click"

    step1 = recorder.record_step(
        tool_name="write_file",
        params={"path": "invoice.txt", "content": "Total: 100"},
    )
    assert step1 is not None
    assert step1.step_index == 1
    assert step1.action == "write_file"

    saved_wf = recorder.stop_recording(save=True)
    assert not recorder.is_recording()
    assert saved_wf is not None
    assert len(saved_wf.steps) == 2

    # Verify persisted file
    loaded = load_workflow(saved_wf.id, dir_path=tmp_path)
    assert loaded is not None
    assert loaded.name == "Invoice Flow"
    assert loaded.episode_id == "ep_invoice"
    assert len(loaded.steps) == 2


def test_workflow_replayer_success(tmp_path: Path):
    wf = Workflow(
        id="wf_replay_success",
        name="Success Replay",
        created_at=100.0,
        session_id="sess_1",
        episode_id="ep_1",
        steps=[
            WorkflowStep(step_index=0, tool_name="tool_a", params={"v": 1}),
            WorkflowStep(step_index=1, tool_name="tool_b", params={"v": 2}),
        ],
    )

    fake_guard = MagicMock()
    fake_guard.wait_for_bare_state.return_value = (True, "Clean")

    dispatched = []

    def mock_executor(tool_name, params):
        dispatched.append((tool_name, params))
        return Result.success({"done": tool_name})

    replayer = WorkflowReplayer(
        guard=fake_guard,
        executor=mock_executor,
        pre_checker=lambda step: (True, "Pre-check passed"),
    )

    res = replayer.replay(wf)
    assert res.ok is True
    assert res.value["status"] == "completed"
    assert res.value["executed_steps"] == 2
    assert len(dispatched) == 2
    assert dispatched[0] == ("tool_a", {"v": 1})
    assert dispatched[1] == ("tool_b", {"v": 2})


def test_workflow_replayer_bare_modifier_interrupted(tmp_path: Path):
    wf = Workflow(
        id="wf_replay_interrupted",
        name="Interrupted Replay",
        created_at=100.0,
        session_id="sess_1",
        episode_id="ep_1",
        steps=[
            WorkflowStep(step_index=0, tool_name="tool_a", params={"v": 1}),
        ],
    )

    fake_guard = MagicMock()
    fake_guard.wait_for_bare_state.return_value = (False, "Holding modifier keys: Shift")

    replayer = WorkflowReplayer(guard=fake_guard)
    res = replayer.replay(wf)

    assert res.ok is False
    assert res.meta.get("drift") is True
    assert res.meta.get("failed_step") == 0
    assert "Holding modifier keys" in res.error


def test_workflow_replayer_target_missing_drift_circuit_breaker(tmp_path: Path):
    wf = Workflow(
        id="wf_drift_trip",
        name="Drift Test Flow",
        created_at=100.0,
        session_id="sess_1",
        episode_id="ep_1",
        steps=[
            WorkflowStep(step_index=0, tool_name="tool_a", params={"v": 1}),
            WorkflowStep(step_index=1, tool_name="tool_b", params={"v": 2}, expected_target={"name": "Submit"}),
            WorkflowStep(step_index=2, tool_name="tool_c", params={"v": 3}),
        ],
    )

    fake_guard = MagicMock()
    fake_guard.wait_for_bare_state.return_value = (True, "Clean")

    def pre_checker(step):
        if step.step_index == 1:
            return (False, "Element 'Submit' not found on current screen")
        return (True, "Ok")

    dispatched = []

    def mock_executor(tool_name, params):
        dispatched.append(tool_name)
        return Result.success({"done": tool_name})

    replayer = WorkflowReplayer(
        guard=fake_guard,
        executor=mock_executor,
        pre_checker=pre_checker,
    )

    res = replayer.replay(wf)
    assert res.ok is False
    assert res.meta.get("drift") is True
    assert res.meta.get("failed_step") == 1
    assert "Element 'Submit' not found" in res.error
    # Must immediately trip circuit breaker and never execute step 1 or step 2
    assert dispatched == ["tool_a"]


def test_workflow_builtin_tools(tmp_path: Path, monkeypatch):
    from tools import get_tool_registry

    reg = get_tool_registry()
    t_start = reg.get("workflow_record_start")
    t_stop = reg.get("workflow_record_stop")
    t_replay = reg.get("workflow_replay")
    t_list = reg.get("workflow_list")

    assert t_start is not None
    assert t_stop is not None
    assert t_replay is not None
    assert t_list is not None

    # Test workflow_record_start and workflow_record_stop through tool definitions
    rec = get_workflow_recorder()
    rec._dir_path = tmp_path

    r_start = t_start.execute(name="Test Automated Flow", description="Testing tools")
    assert r_start.ok is True
    assert r_start.value["status"] == "recording_started"
    wf_id = r_start.value["workflow_id"]

    rec.record_step("echo", {"msg": "hello"})

    r_stop = t_stop.execute(save=True)
    assert r_stop.ok is True
    assert r_stop.value["status"] == "recording_stopped"
    assert r_stop.value["workflow_id"] == wf_id

    # List workflows tool
    r_list = t_list.execute()
    assert r_list.ok is True
    assert any(w["id"] == wf_id for w in r_list.value["workflows"])
