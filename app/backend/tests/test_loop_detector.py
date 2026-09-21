import pytest

try:
    from loop_detector import LoopDetector, LoopPattern
except ImportError:
    from app.backend.loop_detector import LoopDetector, LoopPattern

def test_identical_call_repetition():
    detector = LoopDetector(threshold_repeat=3)
    # First 2 identical calls do not trip
    assert detector.record_call("read_file", {"path": "a.txt"}) is None
    assert detector.record_call("read_file", {"path": "a.txt"}) is None
    # 3rd identical call trips repetition loop
    trip = detector.record_call("read_file", {"path": "a.txt"})
    assert trip is not None
    assert trip.pattern == LoopPattern.IDENTICAL_CALL
    assert trip.tripped is True
    assert "read_file" in trip.message

def test_ping_pong_oscillation():
    detector = LoopDetector(threshold_oscillation=3)
    # Ping pong pattern: toolA -> toolB -> toolA -> toolB -> toolA -> toolB
    detector.record_call("list_dir", {"dir": "src"})
    detector.record_call("read_file", {"path": "src/main.py"})
    detector.record_call("list_dir", {"dir": "src"})
    detector.record_call("read_file", {"path": "src/main.py"})
    detector.record_call("list_dir", {"dir": "src"})
    trip = detector.record_call("read_file", {"path": "src/main.py"})
    assert trip is not None
    assert trip.pattern == LoopPattern.PING_PONG
    assert trip.tripped is True

def test_consecutive_failure_streak():
    detector = LoopDetector(threshold_failure_streak=3)
    detector.record_call("shell_executor", {"cmd": "make build"})
    detector.record_outcome(ok=False, error_class="WinError 2")
    detector.record_call("shell_executor", {"cmd": "make build -f"})
    detector.record_outcome(ok=False, error_class="WinError 2")
    detector.record_call("shell_executor", {"cmd": "nmake build"})
    trip = detector.record_outcome(ok=False, error_class="WinError 2")
    assert trip is not None
    assert trip.pattern == LoopPattern.CONSECUTIVE_FAILURES
