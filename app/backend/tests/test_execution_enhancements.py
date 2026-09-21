"""test_execution_enhancements.py — 验证四大自进化与执行底座增强能力：
1. RepeatToolGuard（防死循环与重复调用守卫 + 自进化负反馈指纹）
2. ToolOutputSpillManager（超长输出 Spill 磁盘转储与 Head-Tail 有界预览）
3. PersistentShellSession（持久化 PTY 终端跨命令保持状态）
4. Subagent Forking（子代理历史快照分叉继承）
"""
import asyncio
import os
import sys
import tempfile
import pytest

from repeat_tool_guard import RepeatToolGuard, _normalize_args_fingerprint
from tool_output_spill import ToolOutputSpillManager, get_spill_manager
from persistent_terminal import PersistentShellSession, PersistentTerminalManager, get_terminal_manager
from team import DispatchPipeline


def test_repeat_tool_guard_detection():
    """测试 RepeatToolGuard 准确识别连续无进展死循环并生成建议与故障指纹。"""
    guard = RepeatToolGuard(max_window_size=10, repeat_threshold=3)

    # 1. 正常非重复调用
    guard.record_call("read_file", {"path": "a.txt"})
    guard.record_call("read_file", {"path": "b.txt"})
    assert guard.check_loop() is None

    # 2. 连续 3 次相同参数调用触发死循环告警
    guard.record_call("grep_search", {"query": "foo", "path": "src"})
    guard.record_call("grep_search", {"query": "foo", "path": "src"})
    guard.record_call("grep_search", {"query": "foo", "path": "src"})

    alert = guard.check_loop()
    assert alert is not None
    assert alert["detected"] is True
    assert alert["tool_name"] == "grep_search"
    assert alert["repeat_count"] == 3
    assert "防死循环守卫提示" in alert["advisory_message"]
    assert "repeat_loop:grep_search:" in alert["failure_signature"]

    # 3. 重复检查不重复弹窗（除非有新指纹）
    assert guard.check_loop() is None

    # 4. reset 后状态清空
    guard.reset()
    assert guard.check_loop() is None


def test_tool_output_spill_manager():
    """测试 ToolOutputSpillManager 拦截超大输出，落盘保存并输出紧凑有界预览。"""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        mgr = ToolOutputSpillManager(threshold_chars=200, head_lines=2, tail_lines=2, spill_dir=tmpdir)

        # 1. 短输出不转储
        short_text = "Hello world\nThis is short"
        res_short = mgr.process_output(short_text, tool_name="echo", session_id="s1")
        assert not res_short.is_spilled
        assert res_short.content == short_text

        # 2. 长输出转储落盘
        long_lines = [f"Line {i}: some detailed log content here..." for i in range(50)]
        long_text = "\n".join(long_lines)
        assert len(long_text) > 200

        res_long = mgr.process_output(long_text, tool_name="build", session_id="s1")
        assert res_long.is_spilled
        assert "输出过长" in res_long.content
        assert "Line 0:" in res_long.content
        assert "Line 49:" in res_long.content
        assert os.path.isfile(res_long.spill_path)

        # 3. 通过 read_spill 切片读取
        sliced = mgr.read_spill(res_long.spill_path, start_line=1, line_count=3)
        assert "Line 0:" in sliced
        assert "Line 1:" in sliced


@pytest.mark.asyncio
async def test_persistent_terminal_state():
    """测试 PersistentShellSession 跨命令保持环境变量与状态。"""
    session = PersistentShellSession(session_id="test_sess", workspace_root=".")
    try:
        # 1. 设置环境变量 / 执行命令
        if sys.platform == "win32":
            code1, out1 = await session.execute("$env:TEST_OVOLVE_VAR = 'active_12345'", timeout_seconds=10)
            assert code1 == 0

            # 2. 第二步读取该变量（验证跨调用状态保持）
            code2, out2 = await session.execute("Write-Output $env:TEST_OVOLVE_VAR", timeout_seconds=10)
            assert code2 == 0
            assert "active_12345" in out2
        else:
            code1, out1 = await session.execute("export TEST_OVOLVE_VAR=active_12345", timeout_seconds=10)
            assert code1 == 0

            code2, out2 = await session.execute("echo $TEST_OVOLVE_VAR", timeout_seconds=10)
            assert code2 == 0
            assert "active_12345" in out2
    finally:
        session._close_shell()


def test_subagent_fork_dispatch():
    """测试 DispatchPipeline 正确支持 fork 模式。"""
    pipeline = DispatchPipeline()
    admitted, why = pipeline.admit(current_concurrent=1, depth=0)
    assert admitted

    role_info = pipeline.steer("investigate bug", requested_role="analyzer")
    dispatched = pipeline.dispatch("task-01", role_info, "sess-parent", fork=True)
    assert dispatched["forked"] is True
    assert dispatched["parent_session_id"] == "sess-parent"
    assert "subagent-" in dispatched["child_session_id"]
