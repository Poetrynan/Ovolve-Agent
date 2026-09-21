# -*- coding: utf-8 -*-
import datetime
import os
import shutil
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from result import Result
from workflow_recorder import Workflow, WorkflowStep, save_workflow
from workflow_scheduler import (
    MiniCron,
    WorkflowScheduler,
    get_next_run,
    validate_cron,
)


@pytest.fixture
def temp_env():
    tmp_dir = tempfile.mkdtemp(prefix="sched_test_")
    db_path = os.path.join(tmp_dir, "test_schedules.db")
    wf_dir = os.path.join(tmp_dir, "workflows")
    os.makedirs(wf_dir, exist_ok=True)
    yield {"tmp_dir": tmp_dir, "db_path": db_path, "wf_dir": wf_dir}
    shutil.rmtree(tmp_dir, ignore_errors=True)


def _create_sample_workflow(wf_dir: str, wf_id: str = "wf_test_1", status: str = "imported") -> Workflow:
    wf = Workflow(
        id=wf_id,
        name="Sample Automation",
        steps=[
            WorkflowStep(
                step_index=0,
                tool_name="tool_echo",
                action="echo",
                params={"msg": "hello"},
            )
        ],
        metadata={"status": status} if status else {},
    )
    save_workflow(wf, dir_path=wf_dir)
    return wf


# ── MiniCron Unit Tests ──

def test_mini_cron_validation():
    # Valid
    assert validate_cron("* * * * *")[0] is True
    assert validate_cron("*/5 * * * *")[0] is True
    assert validate_cron("0 9-17 * * 1-5")[0] is True
    assert validate_cron("30 2 1 * *")[0] is True
    assert validate_cron("@hourly")[0] is True
    assert validate_cron("@daily")[0] is True
    assert validate_cron("@weekly")[0] is True

    # Invalid
    assert validate_cron("")[0] is False
    assert validate_cron("* * * *")[0] is False  # 4 fields
    assert validate_cron("* * * * * *")[0] is False  # 6 fields
    assert validate_cron("60 * * * *")[0] is False  # minute > 59
    assert validate_cron("* 24 * * *")[0] is False  # hour > 23
    assert validate_cron("* * 32 * *")[0] is False  # day > 31
    assert validate_cron("* * * 13 *")[0] is False  # month > 12
    assert validate_cron("* * * * 8")[0] is False  # dow > 7
    assert validate_cron("*/0 * * * *")[0] is False  # step 0


def test_mini_cron_next_run_calculation():
    # Base time: 2026-09-16 10:05:30 (Wednesday)
    base_dt = datetime.datetime(2026, 9, 16, 10, 5, 30)
    base_ts = base_dt.timestamp()

    # 1. Every 15 minutes: next should be 10:15:00
    cron = MiniCron("*/15 * * * *")
    next_ts = cron.get_next_run(base_ts)
    next_dt = datetime.datetime.fromtimestamp(next_ts)
    assert next_dt == datetime.datetime(2026, 9, 16, 10, 15, 0)

    # 2. Daily at noon: next should be 12:00:00
    cron_noon = MiniCron("0 12 * * *")
    next_noon_ts = cron_noon.get_next_run(base_ts)
    next_noon_dt = datetime.datetime.fromtimestamp(next_noon_ts)
    assert next_noon_dt == datetime.datetime(2026, 9, 16, 12, 0, 0)

    # 3. Daily at 09:00: since 10:05 is past 09:00, next is tomorrow 09:00
    cron_morn = MiniCron("0 9 * * *")
    next_morn_ts = cron_morn.get_next_run(base_ts)
    next_morn_dt = datetime.datetime.fromtimestamp(next_morn_ts)
    assert next_morn_dt == datetime.datetime(2026, 9, 17, 9, 0, 0)

    # 4. Weekday only at 09:00 from Friday:
    # 2026-09-18 is Friday. If after Friday 09:00, next run should be Monday 2026-09-21 09:00
    fri_dt = datetime.datetime(2026, 9, 18, 11, 0, 0)
    cron_wd = MiniCron("0 9 * * 1-5")
    next_wd_ts = cron_wd.get_next_run(fri_dt.timestamp())
    next_wd_dt = datetime.datetime.fromtimestamp(next_wd_ts)
    assert next_wd_dt == datetime.datetime(2026, 9, 21, 9, 0, 0)
    assert next_wd_dt.weekday() == 0  # Monday


# ── WorkflowScheduler Service Tests ──

def test_schedule_creation_validation(temp_env):
    scheduler = WorkflowScheduler(db_path=temp_env["db_path"], workflow_dir=temp_env["wf_dir"])

    # 1. Non-existent workflow -> fail
    res = scheduler.create_schedule("wf_non_existent", "*/15 * * * *")
    assert not res.ok
    assert "not found" in res.error

    # 2. Invalid cron -> fail
    wf = _create_sample_workflow(temp_env["wf_dir"], "wf_test_valid", status="imported")
    res_cron = scheduler.create_schedule(wf.id, "invalid_cron")
    assert not res_cron.ok
    assert "cron" in res_cron.error.lower()

    # 3. Unpromoted workflow -> fail when require_promoted=True
    wf_unpromoted = _create_sample_workflow(temp_env["wf_dir"], "wf_unpromoted", status="")
    res_unpromoted = scheduler.create_schedule(wf_unpromoted.id, "*/15 * * * *", require_promoted=True)
    assert not res_unpromoted.ok
    assert "not eligible" in res_unpromoted.error

    # 4. Valid promoted workflow -> success
    res_ok = scheduler.create_schedule(wf.id, "*/15 * * * *", require_promoted=True)
    assert res_ok.ok
    sched_data = res_ok.value
    assert sched_data["workflow_id"] == wf.id
    assert sched_data["cron_expr"] == "*/15 * * * *"
    assert sched_data["enabled"] == 1
    assert sched_data["next_run"] > time.time()


def test_schedule_crud_and_status(temp_env):
    scheduler = WorkflowScheduler(db_path=temp_env["db_path"], workflow_dir=temp_env["wf_dir"])
    wf = _create_sample_workflow(temp_env["wf_dir"], "wf_crud", status="imported")

    res = scheduler.create_schedule(wf.id, "@hourly")
    assert res.ok
    sched_id = res.value["id"]

    # List
    items = scheduler.list_schedules()
    assert len(items) == 1
    assert items[0]["id"] == sched_id

    # Disable
    res_dis = scheduler.set_enabled(sched_id, enabled=False)
    assert res_dis.ok
    assert len(scheduler.list_schedules(enabled_only=True)) == 0
    assert len(scheduler.list_schedules(enabled_only=False)) == 1

    # Re-enable
    res_en = scheduler.set_enabled(sched_id, enabled=True)
    assert res_en.ok
    assert len(scheduler.list_schedules(enabled_only=True)) == 1

    # Delete
    res_del = scheduler.delete_schedule(sched_id)
    assert res_del.ok
    assert len(scheduler.list_schedules()) == 0

    # Delete non-existent
    res_del_none = scheduler.delete_schedule("sched_fake")
    assert not res_del_none.ok


def test_trigger_due_execution(temp_env):
    scheduler = WorkflowScheduler(db_path=temp_env["db_path"], workflow_dir=temp_env["wf_dir"])
    wf = _create_sample_workflow(temp_env["wf_dir"], "wf_trigger", status="imported")

    res = scheduler.create_schedule(wf.id, "*/10 * * * *")
    assert res.ok
    sched_id = res.value["id"]

    # Manually set next_run to 10 seconds ago to simulate it being due
    now = time.time()
    with scheduler._get_conn() as conn:
        conn.execute("UPDATE workflow_schedules SET next_run = ? WHERE id = ?", (now - 10.0, sched_id))
        conn.commit()

    # Mock WorkflowReplayer
    mock_replayer = MagicMock()
    mock_replayer.replay.return_value = Result.success({"status": "completed", "executed_steps": 1})

    runs = scheduler.trigger_due(now=now, replayer=mock_replayer)
    assert len(runs) == 1
    run = runs[0]
    assert run["schedule_id"] == sched_id
    assert run["ok"] is True

    # Verify DB updated
    sched = scheduler.get_schedule(sched_id)
    assert sched is not None
    assert sched["last_run"] == pytest.approx(now, abs=1.0)
    assert sched["next_run"] > now
    assert sched["error_count"] == 0

    # Test failure case
    with scheduler._get_conn() as conn:
        conn.execute("UPDATE workflow_schedules SET next_run = ? WHERE id = ?", (now - 10.0, sched_id))
        conn.commit()

    mock_fail_replayer = MagicMock()
    mock_fail_replayer.replay.return_value = Result.failure("drift circuit breaker tripped")

    fail_runs = scheduler.trigger_due(now=now, replayer=mock_fail_replayer)
    assert len(fail_runs) == 1
    assert fail_runs[0]["ok"] is False

    sched_after_fail = scheduler.get_schedule(sched_id)
    assert sched_after_fail["error_count"] == 1
    assert "circuit breaker" in sched_after_fail["last_error"]


# ── Builtin Tool Integration Tests ──

def test_workflow_scheduler_tools(temp_env):
    wf = _create_sample_workflow(temp_env["wf_dir"], "wf_tool_test", status="imported")

    # Point global scheduler to temp env
    from workflow_scheduler import set_default_workflow_scheduler
    test_scheduler = WorkflowScheduler(db_path=temp_env["db_path"], workflow_dir=temp_env["wf_dir"])
    set_default_workflow_scheduler(test_scheduler)

    from tools import get_tool_registry
    registry = get_tool_registry()

    # 1. Create schedule tool
    create_tool = registry.get("workflow_schedule_create")
    assert create_tool is not None
    res_c = create_tool.execute(workflow_id=wf.id, cron_expr="0 9 * * *")
    assert res_c.ok
    sched_id = res_c.value["id"]

    # 2. List schedules tool
    list_tool = registry.get("workflow_schedule_list")
    assert list_tool is not None
    res_l = list_tool.execute()
    assert res_l.ok
    assert res_l.value["count"] == 1
    assert res_l.value["schedules"][0]["id"] == sched_id

    # 3. Delete schedule tool
    del_tool = registry.get("workflow_schedule_delete")
    assert del_tool is not None
    res_d = del_tool.execute(schedule_id=sched_id)
    assert res_d.ok
    assert res_d.value["deleted"] is True

    # Post-delete check
    res_l2 = list_tool.execute()
    assert res_l2.value["count"] == 0
