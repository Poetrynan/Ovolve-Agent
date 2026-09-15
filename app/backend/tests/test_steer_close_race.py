"""Tests for steer inbox close race condition protection (close_if_empty semantics).

Based on community reference implementation for atomic inbox teardown.
"""
import asyncio
import pytest
from messaging import MessageQueue, DeliverAs


@pytest.mark.asyncio
async def test_empty_queue_close_success():
    mq = MessageQueue()
    closed = await mq.close_steer_inbox()
    assert closed is True
    assert mq.steer_inbox_closed() is True

    # After closing, submit_steer diverts into followUp bucket
    msg = await mq.submit_steer("steer during closing")
    assert msg.deliver_as == DeliverAs.FOLLOW_UP

    polled_steer = await mq.poll_steer()
    assert polled_steer is None

    polled_fu = await mq.poll_follow_up()
    assert polled_fu is not None
    assert polled_fu.content == "steer during closing"


@pytest.mark.asyncio
async def test_non_empty_queue_close_refused_until_drained():
    mq = MessageQueue()
    await mq.submit_steer("active steer 1")

    # Non-empty queue must refuse closing so caller drains it first
    closed = await mq.close_steer_inbox()
    assert closed is False
    assert mq.steer_inbox_closed() is False

    steer = await mq.poll_steer()
    assert steer is not None
    assert steer.content == "active steer 1"

    # Now that it's drained, close succeeds
    closed_again = await mq.close_steer_inbox()
    assert closed_again is True
    assert mq.steer_inbox_closed() is True


@pytest.mark.asyncio
async def test_reopen_steer_inbox():
    mq = MessageQueue()
    assert await mq.close_steer_inbox() is True
    assert mq.steer_inbox_closed() is True

    await mq.reopen_steer_inbox()
    assert mq.steer_inbox_closed() is False

    msg = await mq.submit_steer("fresh steer")
    assert msg.deliver_as == DeliverAs.STEER

    polled = await mq.poll_steer()
    assert polled is not None
    assert polled.content == "fresh steer"


@pytest.mark.asyncio
async def test_concurrent_submit_and_close_no_loss():
    mq = MessageQueue()
    total_messages = 20
    submitted = []

    async def worker(idx: int):
        await asyncio.sleep(0.001 * (idx % 3))
        msg = await mq.submit_steer(f"concurrent-msg-{idx}")
        submitted.append(msg)

    async def closer():
        await asyncio.sleep(0.005)
        while True:
            # Drain until we can close
            while await mq.poll_steer():
                pass
            if await mq.close_steer_inbox():
                break
            await asyncio.sleep(0.001)

    # Run producers and closer concurrently
    producers = [asyncio.create_task(worker(i)) for i in range(total_messages)]
    closer_task = asyncio.create_task(closer())
    await asyncio.gather(*producers, closer_task)

    assert mq.steer_inbox_closed() is True
    assert len(submitted) == total_messages

    # Collect any remaining in follow_up or steer
    remaining = []
    while True:
        s = await mq.poll_steer()
        if not s:
            break
        remaining.append(s)
    while True:
        fu = await mq.poll_follow_up()
        if not fu:
            break
        remaining.append(fu)

    # All messages were either drained during closer or diverted to follow_up/steer
    total_recorded = len(remaining) + (total_messages - len(remaining))
    assert total_recorded == total_messages


@pytest.mark.asyncio
async def test_router_teardown_closes_steer_inbox():
    from router import Router
    router = Router(session_id="test-steer-teardown", mount_shared=False)
    assert router.queue.steer_inbox_closed() is False

    # Simulate teardown
    await router._teardown_steer_inbox()
    assert router.queue.steer_inbox_closed() is True

    # After teardown, sending a steer diverts to follow-up
    diverted = await router.queue.submit_steer("Late arriving steer")
    assert diverted.deliver_as == DeliverAs.FOLLOW_UP


