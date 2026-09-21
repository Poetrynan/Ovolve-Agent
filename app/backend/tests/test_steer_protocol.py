import pytest

try:
    from steer_protocol import SteerQueue, format_steer_prompt
except ImportError:
    from app.backend.steer_protocol import SteerQueue, format_steer_prompt

def test_steer_queue_enqueue_and_drain():
    queue = SteerQueue()
    assert queue.has_pending() is False
    queue.enqueue("不要改 a.py 了，去改 b.py", source="user")
    queue.enqueue("另外请加上详细日志", source="user")
    assert queue.has_pending() is True
    assert queue.pending_count() == 2

    drained = queue.drain_all()
    assert len(drained) == 2
    assert drained[0].text == "不要改 a.py 了，去改 b.py"
    assert queue.has_pending() is False

def test_format_steer_prompt():
    queue = SteerQueue()
    queue.enqueue("请优先优化性能")
    drained = queue.drain_all()
    formatted = format_steer_prompt(drained)
    assert "系统与用户转向提示" in formatted
    assert "请优先优化性能" in formatted
