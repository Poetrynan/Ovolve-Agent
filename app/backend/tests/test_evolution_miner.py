# -*- coding: utf-8 -*-
"""Unit tests for background idle evolution miner."""
import time
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from evolution import (
    EvolutionEngine,
    EvolutionStore,
    MODE_ACTIVE,
)
from turn_state import TurnStatus


@pytest.fixture
def clean_miner_env(tmp_path):
    ws = tmp_path / "workspace"
    ws.mkdir()
    agents_md = ws / "AGENTS.md"
    agents_md.write_text("# Agent Guidelines\n", encoding="utf-8")

    db_path = str(tmp_path / "evolution.db")
    store = EvolutionStore(db_path=db_path)
    engine = EvolutionEngine(store=store, mode=MODE_ACTIVE, workspace_root=str(ws))
    return {
        "ws": ws,
        "agents_md": agents_md,
        "store": store,
        "engine": engine,
    }


@pytest.mark.asyncio
async def test_miner_disabled_when_interval_zero(clean_miner_env):
    from evolution_miner import EvolutionMiner

    miner = EvolutionMiner(interval_s=0, workspace_root=str(clean_miner_env["ws"]))
    res = await miner.scan_once()
    assert res.get("status") == "disabled"


@pytest.mark.asyncio
async def test_miner_skips_running_session(clean_miner_env):
    from evolution_miner import EvolutionMiner

    mock_host = MagicMock()
    mock_host.list_sessions.return_value = ["sess_running"]

    mock_router = MagicMock()
    mock_router.session_id = "sess_running"
    mock_router._flush_memory_for_fold = AsyncMock()
    mock_host.get.return_value = mock_router

    mock_turn_state = MagicMock()
    mock_turn_state.current.return_value = TurnStatus.RUNNING

    miner = EvolutionMiner(
        session_host=mock_host,
        interval_s=300,
        idle_threshold_s=300,
        workspace_root=str(clean_miner_env["ws"]),
    )

    with patch("turn_state.get_turn_state", return_value=mock_turn_state):
        res = await miner.scan_once()

    assert "sess_running" in res.get("skipped_active", [])
    assert mock_router._flush_memory_for_fold.await_count == 0


@pytest.mark.asyncio
async def test_miner_processes_idle_session_and_mines(clean_miner_env):
    from evolution_miner import EvolutionMiner

    engine = clean_miner_env["engine"]
    store = clean_miner_env["store"]
    ws = clean_miner_env["ws"]

    # 预置 3 次失败信号，待矿工挖掘
    for i in range(3):
        store.record_signal(
            kind="tool_failure",
            tool_name="git",
            detail="fatal: not a git repository",
            session_id="sess_idle",
            failure_kind="tool_failure",
        )

    mock_host = MagicMock()
    mock_host.list_sessions.return_value = ["sess_idle"]

    mock_router = MagicMock()
    mock_router.session_id = "sess_idle"
    mock_router.workspace = str(ws)
    old_time = time.time() - 600.0  # 10 分钟前
    mock_router.storage.get_messages.return_value = [
        {"role": "user", "content": "hello", "timestamp": old_time}
    ]
    mock_router._flush_memory_for_fold = AsyncMock(return_value=1)
    mock_host.get.return_value = mock_router

    mock_turn_state = MagicMock()
    mock_turn_state.current.return_value = TurnStatus.IDLE

    miner = EvolutionMiner(
        session_host=mock_host,
        interval_s=300,
        idle_threshold_s=300,
        workspace_root=str(ws),
    )

    with patch("turn_state.get_turn_state", return_value=mock_turn_state):
        with patch("evolution.get_evolution_engine", return_value=engine):
            res = await miner.scan_once()

    assert "sess_idle" in res.get("finalized_idle", [])
    assert mock_router._flush_memory_for_fold.await_count == 1
    assert res.get("proposals_made", 0) >= 1

    # 验证生成的提案已落库
    open_props = store.open_proposals()
    assert len(open_props) >= 1
    assert open_props[0].tool_name == "git"


@pytest.mark.asyncio
async def test_miner_fail_open_on_exception(clean_miner_env):
    from evolution_miner import EvolutionMiner

    mock_host = MagicMock()
    mock_host.list_sessions.side_effect = RuntimeError("database lock timeout")

    miner = EvolutionMiner(
        session_host=mock_host,
        interval_s=300,
        workspace_root=str(clean_miner_env["ws"]),
    )
    # 发生严重异常时必须 fail-open，返回错误描述字典而不向外抛错
    res = await miner.scan_once()
    assert res.get("ok") is False or "error" in res
