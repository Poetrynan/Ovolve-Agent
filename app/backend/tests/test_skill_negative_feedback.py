# -*- coding: utf-8 -*-
import tempfile
from unittest.mock import MagicMock

import pytest
from skill_loader import SkillEntry, SkillStatus, get_skill_loader
from workflow_evolution import WorkflowExecutionMetrics, WorkflowMetricsTracker


@pytest.fixture
def mock_skill_loader():
    loader = get_skill_loader()
    skill_name = "wf-test-auto-feedback"
    entry = SkillEntry(
        name=skill_name,
        path=f"/fake/{skill_name}",
        description="test skill",
    )
    entry.status = SkillStatus.IMPORTED
    loader._skills[skill_name] = entry
    yield {"loader": loader, "skill_name": skill_name, "entry": entry}
    loader._skills.pop(skill_name, None)


def test_consecutive_failures_triggers_auto_degrade(mock_skill_loader):
    tracker = WorkflowMetricsTracker()
    wf_id = "test-auto-feedback"
    entry = mock_skill_loader["entry"]

    assert entry.status == SkillStatus.IMPORTED

    # Run 1: Failure
    m1 = tracker.record_run(wf_id, success=False, latency_ms=100.0)
    assert m1.consecutive_failures == 1
    assert not m1.is_degraded
    assert entry.status == SkillStatus.IMPORTED

    # Run 2: Failure
    m2 = tracker.record_run(wf_id, success=False, latency_ms=100.0)
    assert m2.consecutive_failures == 2
    assert not m2.is_degraded
    assert entry.status == SkillStatus.IMPORTED

    # Run 3: Drift failure (3rd consecutive failure) -> auto degrade!
    m3 = tracker.record_run(wf_id, success=False, drift=True, latency_ms=100.0)
    assert m3.consecutive_failures == 3
    assert m3.is_degraded is True
    # Skill loader status must now be DISABLED
    assert entry.status == SkillStatus.DISABLED


def test_clean_success_recovers_degraded_skill(mock_skill_loader):
    tracker = WorkflowMetricsTracker()
    wf_id = "test-auto-feedback"
    entry = mock_skill_loader["entry"]

    # Trigger degradation
    for _ in range(3):
        tracker.record_run(wf_id, success=False)
    assert entry.status == SkillStatus.DISABLED

    # Clean success run recovers skill
    m_rec = tracker.record_run(wf_id, success=True, drift=False)
    assert m_rec.consecutive_failures == 0
    assert m_rec.is_degraded is False
    assert entry.status == SkillStatus.IMPORTED


def test_intermittent_success_resets_failure_counter():
    tracker = WorkflowMetricsTracker()
    wf_id = "test-wf-intermittent"

    tracker.record_run(wf_id, success=False)
    tracker.record_run(wf_id, success=False)
    assert tracker.get_metrics(wf_id).consecutive_failures == 2

    # Success resets counter
    tracker.record_run(wf_id, success=True)
    assert tracker.get_metrics(wf_id).consecutive_failures == 0
    assert not tracker.get_metrics(wf_id).is_degraded
