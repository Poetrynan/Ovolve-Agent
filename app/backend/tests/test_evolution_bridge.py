import pytest

try:
    from evolution_bridge import (
        notify_turn_interrupted,
        notify_user_correction,
        notify_loop_fault,
        notify_tool_failure,
    )
except ImportError:
    from app.backend.evolution_bridge import (
        notify_turn_interrupted,
        notify_user_correction,
        notify_loop_fault,
        notify_tool_failure,
    )

def test_notify_signals_fail_open():
    # Fail-open guarantee: never raises exception even with invalid or unconfigured state
    notify_turn_interrupted("sess_1", "turn_1", reason="user_stop")
    notify_user_correction("sess_1", "turn_1", correction="use pytest instead of unittest")
    notify_loop_fault("sess_1", "turn_1", tool_name="read_file", loop_msg="repetitive calls")
    notify_tool_failure("sess_1", "turn_1", tool_name="shell_executor", error_msg="command not found")
