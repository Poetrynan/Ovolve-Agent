import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock

from messaging import MessageQueue, DeliverAs
from router import Router


@pytest.mark.asyncio
async def test_message_queue_steer_and_ui_sync():
    """Verify Issue 13: MessageQueue steer priority and UI snapshot single-source-of-truth."""
    mq = MessageQueue()

    # Enqueue UI items
    item1 = await mq.ui_enqueue("Wait in line prompt 1")
    item2 = await mq.ui_enqueue("Urgent line prompt 2", urgent=True)

    snapshot = mq.ui_snapshot()
    assert len(snapshot["items"]) == 2
    # Urgent item should be at the front
    assert snapshot["items"][0]["id"] == item2["id"]
    assert snapshot["items"][1]["id"] == item1["id"]

    # Send Steer message
    steer_msg = await mq.send_message("Please change direction!", DeliverAs.STEER, sender="user")
    assert steer_msg.deliver_as == DeliverAs.STEER

    # Poll steer
    polled = await mq.poll_steer()
    assert polled is not None
    assert polled.content == "Please change direction!"
    assert polled.deliver_as == DeliverAs.STEER

    # Next poll should be empty
    polled_none = await mq.poll_steer()
    assert polled_none is None


@pytest.mark.asyncio
async def test_router_drain_steer_clears_cancel_and_emits():
    """Verify Issue 11: Steer during tool execution clears cancel flag and injects prompt at step boundary."""
    router = Router(session_id="test-session-steer", mount_shared=False)
    router.bus = AsyncMock()
    router.queue = MessageQueue()

    # Simulate user sending steer message while router was cancelled (preempted)
    await router.queue.send_message("Adjust parameters to 0.5", DeliverAs.STEER, sender="user")
    router._cancelled.set()
    assert router._cancel_requested() is True

    messages = [{"role": "system", "content": "You are a helpful assistant."}]
    steered = await router._drain_steer_into(messages, step=1)

    assert steered is True
    # The message must be injected
    assert len(messages) == 2
    assert messages[1]["role"] == "user"
    assert messages[1]["content"] == "Adjust parameters to 0.5"

    # Crucial: cancel flag must be cleared so the loop proceeds
    assert router._cancel_requested() is False

    # Event steer_applied must be emitted
    router.bus.emit.assert_any_call("steer_applied", {
        "session_id": "test-session-steer",
        "step": 1,
        "injected": 1,
        "dropped": 0,
    })


@pytest.mark.asyncio
async def test_tool_call_cancelled_error_shielding(monkeypatch):
    """Verify Issue 12: CancelledError during tool dispatch does not crash the loop or hang state."""
    router = Router(session_id="test-session-cancel", mount_shared=False)
    router.bus = AsyncMock()
    router.storage = MagicMock()
    router.storage.find_effect_by_operation.return_value = None
    router.storage.find_recent_side_effects_for_target.return_value = []
    router.storage.find_landed_side_effect.return_value = None

    # Mock tool registry using monkeypatch to avoid polluting singleton
    mock_tool = MagicMock()
    mock_tool.halts_turn = False
    monkeypatch.setattr(router.tools, "get", MagicMock(return_value=mock_tool))

    # Tool dispatch simulates CancelledError (e.g. killed by cancel_hard)
    async def cancelling_dispatch(name, args, call_ctx):
        raise asyncio.CancelledError("Preempted by user steer")

    monkeypatch.setattr(router.tools, "dispatch", cancelling_dispatch, raising=False)

    call = {"id": "call-123", "name": "run_slow_command", "args": {"cmd": "build"}}
    context = {"goal_id": "goal-1"}

    # Should catch CancelledError, settle side-effects, and return structured failed outcome
    outcome = await router._run_tool_call(call, context)

    assert outcome["trace"]["status"] == "failed"
    assert outcome["trace"]["interrupted"] is True
    assert "这一步被中断了" in outcome["content"]

    # Side effects ledger should be settled as unknown to avoid duplicate replays
    router.storage.settle_side_effect.assert_called_with(
        "call-123", ok=False, result_preview="aborted mid-flight", status="unknown"
    )
