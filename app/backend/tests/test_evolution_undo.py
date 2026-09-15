# -*- coding: utf-8 -*-
"""Unit tests for evolution undo mechanism."""
import os
import time
from pathlib import Path
import pytest

from evolution import (
    EvolutionEngine,
    EvolutionStore,
    Proposal,
    MODE_ACTIVE,
)
from result import Result


@pytest.fixture
def clean_env(tmp_path):
    ws = tmp_path / "workspace"
    ws.mkdir()
    agents_md = ws / "AGENTS.md"
    original_content = "# Agent Operating Guidelines\n\n- Rule 1: Always check environment.\n"
    agents_md.write_text(original_content, encoding="utf-8")

    db_path = str(tmp_path / "evolution.db")
    store = EvolutionStore(db_path=db_path)
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    return {
        "ws": ws,
        "agents_md": agents_md,
        "original_content": original_content,
        "store": store,
        "engine": engine,
    }


def test_backup_created_on_decide_accept(clean_env):
    from evolution_undo import list_undo

    engine = clean_env["engine"]
    ws = clean_env["ws"]

    p = Proposal(
        id="prop_undo_1",
        signature="sig_tool_fail_1",
        kind="tool_failure",
        tool_name="bash",
        target_file="AGENTS.md",
        draft="- bash 执行失败时优先查看错误详情。",
        rationale="近 14 天多次同类报错",
        hits=3,
        status="pending",
        created_at=time.time(),
    )
    engine.store.insert_proposal(p)

    res = engine.decide(p.id, accept=True)
    assert res["ok"]
    assert res["applied"]

    # 验证目标文件已写入
    updated = clean_env["agents_md"].read_text(encoding="utf-8")
    assert "- bash 执行失败时优先查看错误详情。" in updated

    # 验证快照文件已生成
    backups = list_undo(str(ws))
    assert len(backups) == 1
    assert backups[0]["proposal_id"] == "prop_undo_1"
    assert backups[0]["target_file"] == "AGENTS.md"
    assert os.path.isfile(backups[0]["backup_path"])


def test_undo_restores_file_and_records_signal(clean_env):
    from evolution_undo import undo

    engine = clean_env["engine"]
    ws = clean_env["ws"]
    orig = clean_env["original_content"]

    p = Proposal(
        id="prop_undo_2",
        signature="sig_tool_fail_2",
        kind="tool_failure",
        tool_name="bash",
        target_file="AGENTS.md",
        draft="- 临时新增的坏规则。",
        rationale="测试理由",
        hits=3,
        status="pending",
        created_at=time.time(),
    )
    engine.store.insert_proposal(p)
    engine.decide(p.id, accept=True)

    # 确认文件已被修改
    assert "- 临时新增的坏规则。" in clean_env["agents_md"].read_text(encoding="utf-8")

    # 执行撤销
    undo_res = undo(workspace_root=str(ws), proposal_id="prop_undo_2", store=clean_env["store"])
    assert undo_res.ok
    assert undo_res.value["proposal_id"] == "prop_undo_2"

    # 验证文件逐字节还原
    restored = clean_env["agents_md"].read_text(encoding="utf-8")
    assert restored == orig

    # 验证在进化库中沉淀了 user_correction 信号
    signals = clean_env["store"].recent_signals(limit=10)
    corrections = [s for s in signals if s.get("kind") == "user_correction"]
    assert len(corrections) >= 1
    assert "prop_undo_2" in corrections[0].get("detail", "")


def test_list_undo_sorted_and_rolling_limit(clean_env):
    from evolution_undo import create_evolution_snapshot, list_undo, MAX_SNAPSHOTS

    ws = clean_env["ws"]
    agents_md = clean_env["agents_md"]

    # 生成 25 份快照
    for i in range(25):
        agents_md.write_text(f"version {i}", encoding="utf-8")
        create_evolution_snapshot(str(ws), "AGENTS.md", f"prop_{i:02d}")
        time.sleep(0.01)

    backups = list_undo(str(ws))
    # 验证滚动窗口不超过 MAX_SNAPSHOTS (20)
    assert len(backups) == MAX_SNAPSHOTS
    # 验证按时间倒序排列（最新排在最前）
    assert backups[0]["proposal_id"] == "prop_24"
    assert backups[-1]["proposal_id"] == "prop_05"


def test_undo_missing_target_fails_cleanly(clean_env):
    from evolution_undo import undo

    ws = clean_env["ws"]
    res = undo(workspace_root=str(ws), proposal_id="non_existent_prop")
    assert not res.ok
    assert "not found" in res.error.lower()


def test_evolution_undo_tool_registered(clean_env):
    from tools import get_tool_registry

    reg = get_tool_registry()
    tool = reg.get("evolution_undo")
    assert tool is not None
    assert tool.risk_level == "medium"
    assert tool.domain == "system"


@pytest.mark.asyncio
async def test_evolution_undo_http_handlers(clean_env, monkeypatch):
    from server.http_server import handle_evolution_undo_list, handle_evolution_undo
    from evolution_undo import create_evolution_snapshot

    ws = clean_env["ws"]
    monkeypatch.setenv("OVOLVE_WORKSPACE", str(ws))

    # Mock request for GET /api/evolution/undo
    class FakeRequest:
        def __init__(self, json_data=None):
            self._json = json_data or {}

        async def json(self):
            return self._json

    # Initial list is empty
    list_resp = await handle_evolution_undo_list(FakeRequest())
    assert list_resp.status == 200
    import json
    data = json.loads(list_resp.text)
    assert data["ok"]
    assert len(data["snapshots"]) == 0

    # Create snapshot and verify list
    create_evolution_snapshot(str(ws), "AGENTS.md", "prop_http_1")
    list_resp2 = await handle_evolution_undo_list(FakeRequest())
    data2 = json.loads(list_resp2.text)
    assert len(data2["snapshots"]) == 1

    # Call POST /api/evolution/undo
    undo_resp = await handle_evolution_undo(FakeRequest({"proposal_id": "prop_http_1"}))
    assert undo_resp.status == 200
    undo_data = json.loads(undo_resp.text)
    assert undo_data["ok"]
    assert undo_data["data"]["proposal_id"] == "prop_http_1"
