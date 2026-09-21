"""test_loop_detector_breakers.py — 熔断阈值验证（Track R3）

用 LoopDetector 的公开接口 ``check / record / observe`` 喂两类卡死调用模式，
断言电路断路器在配置阈值内跳闸：
  * no_progress：相同参数 + 相同结果连续 N 次 → critical
  * ping_pong ：A→B→A→B 交替 → critical
"""
from __future__ import annotations

from loop_detector import LoopConfig, LoopDetector


def _drive(det: LoopDetector, tool: str, args: dict, result: str, max_steps: int = 30):
    """按生产用法循环 check→record→observe，直到被拦下或耗尽步数。

    返回 (trip_step_index, detector_name) 或 (None, None)。
    """
    for i in range(max_steps):
        v = det.check(tool, args, tool_known=True)
        if v.blocks:
            return i, v.detector
        idx = det.record(tool, args)
        det.observe(idx, result)
    return None, None


def test_no_progress_breaker_trips_within_default_threshold():
    det = LoopDetector()
    tool = "edit_file"          # 非轮询工具
    args = {"path": "/x.py", "new_string": "broken"}
    trip_step, detector = _drive(det, tool, args, result="Error: syntax invalid")
    assert trip_step is not None, "no_progress breaker did not trip"
    assert detector == "no_progress"
    # 默认 critical_threshold=5：第 5 次 check（0-indexed 4）应跳闸。
    assert trip_step == det.config.critical_threshold - 1
    assert trip_step < det.config.global_circuit_breaker


def test_no_progress_breaker_respects_custom_threshold():
    det = LoopDetector(LoopConfig(critical_threshold=3, warning_threshold=2))
    trip_step, detector = _drive(det, "edit_file", {"p": 1}, "same failure")
    assert trip_step is not None
    assert detector == "no_progress"
    assert trip_step == det.config.critical_threshold - 1 == 2


def test_ping_pong_breaker_trips_within_threshold():
    det = LoopDetector()
    tools = ["scan_a", "scan_b"]   # 两个非轮询、不同签名
    args = [{"k": 1}, {"k": 2}]
    trip_step = None
    detector = None
    for i in range(30):
        tool = tools[i % 2]
        a = args[i % 2]
        v = det.check(tool, a, tool_known=True)
        if v.blocks:
            trip_step, detector = i, v.detector
            break
        idx = det.record(tool, a)
        det.observe(idx, "no change")
    assert trip_step is not None, "ping_pong breaker did not trip"
    assert detector == "ping_pong"
    # 默认 ping_pong_window=6：应在第 6 次 check（0-indexed 5）内跳闸。
    assert trip_step <= det.config.ping_pong_window


def test_ping_pong_breaker_respects_custom_window():
    det = LoopDetector(LoopConfig(ping_pong_window=4))
    tools = ["scan_a", "scan_b"]
    args = [{"k": 1}, {"k": 2}]
    trip_step = None
    for i in range(30):
        tool = tools[i % 2]
        a = args[i % 2]
        v = det.check(tool, a, tool_known=True)
        if v.blocks:
            trip_step = i
            assert v.detector == "ping_pong"
            break
        idx = det.record(tool, a)
        det.observe(idx, "no change")
    assert trip_step is not None
    assert trip_step <= det.config.ping_pong_window


def test_unknown_tool_repeat_trips_critical():
    """幻想工具反复调用 → unknown_tool_repeat 直接 critical。"""
    det = LoopDetector()
    trip_step = None
    for i in range(20):
        v = det.check("fantasy_tool_xyz", {"x": 1}, tool_known=False)
        if v.blocks:
            trip_step = i
            assert v.detector == "unknown_tool_repeat"
            break
        det.record_blocked("fantasy_tool_xyz", {"x": 1})
    assert trip_step is not None
