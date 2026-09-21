import pytest

try:
    from router import Router
    from task_states import TurnStatus, GoalStatus
    from loop_detector import LoopDetector, LoopPattern
    from steer_protocol import SteerQueue
    from evolution_bridge import notify_loop_fault, notify_user_correction
except ImportError:
    from app.backend.router import Router
    from app.backend.task_states import TurnStatus, GoalStatus
    from app.backend.loop_detector import LoopDetector, LoopPattern
    from app.backend.steer_protocol import SteerQueue
    from app.backend.evolution_bridge import notify_loop_fault, notify_user_correction

def test_router_has_steer_and_loop_components():
    router = Router(session_id="test_sess_loop")
    assert hasattr(router, "steer_queue")
    assert hasattr(router, "_drain_steer_into")
    assert hasattr(router, "loop_detector")

def test_loop_detector_integration_simulation():
    detector = LoopDetector(threshold_repeat=3)
    trip = None
    for _ in range(3):
        trip = detector.record_call("read_file", {"path": "stuck.py"})
    assert trip is not None
    assert trip.tripped is True
    assert trip.pattern == LoopPattern.IDENTICAL_CALL
