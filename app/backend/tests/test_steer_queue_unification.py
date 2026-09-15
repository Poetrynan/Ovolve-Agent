import pytest
import asyncio
from unittest.mock import AsyncMock

from messaging import MessageQueue, DeliverAs
from steer_protocol import SteerQueue
from router import Router


@pytest.mark.asyncio
async def test_steer_queue_bridge_to_message_queue():
    """Verify SteerQueue acts as a synchronous bridge to MessageQueue when bound."""
    mq = MessageQueue()
    sq = SteerQueue(msg_queue=mq)

    assert sq.has_pending() is False
    assert sq.pending_count() == 0

    sq.enqueue("Refactor test parameters", source="user")

    assert sq.has_pending() is True
    assert sq.pending_count() == 1

    # Draining via MessageQueue should retrieve the enqueued steer item
    msg = await mq.poll_steer()
    assert msg is not None
    assert msg.content == "Refactor test parameters"
    assert msg.deliver_as == DeliverAs.STEER

    # After drain from mq, sq should reflect empty
    assert sq.has_pending() is False


@pytest.mark.asyncio
async def test_router_single_source_of_truth_drain():
    """Verify router._drain_steer_into drains both SteerQueue and MessageQueue through single pipeline."""
    router = Router(session_id="test-unify-drain", mount_shared=False)
    router.bus = AsyncMock()

    # Enqueue via synchronous adapter
    router.steer_queue.enqueue("Instruction from sync adapter", source="user")

    # Enqueue via async MessageQueue
    await router.queue.send_message("Instruction from async MessageQueue", DeliverAs.STEER, sender="user")

    messages = [{"role": "system", "content": "You are a helpful assistant."}]
    steered = await router._drain_steer_into(messages, step=1)

    assert steered is True
    # Both messages must be injected in arrival order
    assert len(messages) == 3
    assert messages[1]["role"] == "user"
    assert messages[1]["content"] == "Instruction from sync adapter"
    assert messages[2]["role"] == "user"
    assert messages[2]["content"] == "Instruction from async MessageQueue"

    # Queues must be completely drained
    assert router.steer_queue.has_pending() is False
    assert await router.queue.poll_steer() is None
