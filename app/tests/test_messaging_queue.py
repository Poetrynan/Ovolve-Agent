"""Test the UI pending-prompt queue in messaging.MessageQueue.

This is the single source of truth for the desktop "待发送 N 条" panel — the
renderer only mirrors it, so the ordering / pause / drain rules are tested here.
"""
import asyncio
import pytest
from messaging import MessageQueue


def run(coro):
    return asyncio.run(coro)


def test_enqueue_appends_in_order():
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("a")
        await q.ui_enqueue("b")
        return [i["text"] for i in q.ui_snapshot()["items"]]
    assert run(go()) == ["a", "b"]


def test_urgent_enqueue_goes_to_front():
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("a")
        await q.ui_enqueue("urgent", urgent=True)
        snap = q.ui_snapshot()["items"]
        return snap[0]["text"], snap[0]["delivery"]
    assert run(go()) == ("urgent", "steer")


def test_ids_are_unique():
    async def go():
        q = MessageQueue()
        a = await q.ui_enqueue("a")
        b = await q.ui_enqueue("b")
        return a["id"] != b["id"]
    assert run(go())


def test_remove_drops_only_that_item():
    async def go():
        q = MessageQueue()
        a = await q.ui_enqueue("doomed")
        await q.ui_enqueue("safe")
        await q.ui_remove(a["id"])
        return [i["text"] for i in q.ui_snapshot()["items"]]
    assert run(go()) == ["safe"]


def test_clear_empties_queue():
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("a")
        await q.ui_enqueue("b")
        await q.ui_clear()
        return q.ui_pending
    assert run(go()) == 0


def test_update_text_mutates_matching_item():
    async def go():
        q = MessageQueue()
        a = await q.ui_enqueue("old")
        await q.ui_update_text(a["id"], "new")
        return q.ui_snapshot()["items"][0]["text"]
    assert run(go()) == "new"


def test_promote_moves_item_to_head():
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("a")
        b = await q.ui_enqueue("b")
        await q.ui_promote(b["id"])
        return [i["text"] for i in q.ui_snapshot()["items"]]
    assert run(go()) == ["b", "a"]


def test_promote_head_is_a_noop():
    async def go():
        q = MessageQueue()
        a = await q.ui_enqueue("a")
        await q.ui_enqueue("b")
        await q.ui_promote(a["id"])
        return [i["text"] for i in q.ui_snapshot()["items"]]
    assert run(go()) == ["a", "b"]


def test_reorder_applies_client_order():
    async def go():
        q = MessageQueue()
        a = await q.ui_enqueue("a")
        b = await q.ui_enqueue("b")
        c = await q.ui_enqueue("c")
        await q.ui_reorder([c["id"], a["id"], b["id"]])
        return [i["text"] for i in q.ui_snapshot()["items"]]
    assert run(go()) == ["c", "a", "b"]


def test_reorder_keeps_items_missing_from_the_id_list():
    """A stale client order must not silently delete items."""
    async def go():
        q = MessageQueue()
        a = await q.ui_enqueue("a")
        b = await q.ui_enqueue("b")
        await q.ui_enqueue("added-later")
        await q.ui_reorder([b["id"], a["id"]])
        return [i["text"] for i in q.ui_snapshot()["items"]]
    assert run(go()) == ["b", "a", "added-later"]


def test_take_next_pops_the_head():
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("first")
        await q.ui_enqueue("second")
        item = await q.ui_take_next()
        return item["text"], q.ui_pending
    assert run(go()) == ("first", 1)


def test_take_next_returns_none_when_paused():
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("waiting")
        await q.ui_pause("interrupted")
        return await q.ui_take_next()
    assert run(go()) is None


def test_take_next_returns_none_when_empty():
    async def go():
        q = MessageQueue()
        return await q.ui_take_next()
    assert run(go()) is None


def test_resume_allows_draining_again():
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("waiting")
        await q.ui_pause("error")
        blocked = await q.ui_take_next()
        await q.ui_resume()
        drained = await q.ui_take_next()
        return blocked, drained["text"]
    assert run(go()) == (None, "waiting")


def test_snapshot_reports_pause_reason():
    async def go():
        q = MessageQueue()
        await q.ui_pause("interrupted")
        snap = q.ui_snapshot()
        return snap["paused"], snap["pauseReason"]
    assert run(go()) == (True, "interrupted")


def test_resume_clears_pause_reason():
    async def go():
        q = MessageQueue()
        await q.ui_pause("manual")
        await q.ui_resume()
        snap = q.ui_snapshot()
        return snap["paused"], snap["pauseReason"]
    assert run(go()) == (False, None)


def test_snapshot_is_a_copy():
    """Mutating a snapshot must not corrupt the live queue."""
    async def go():
        q = MessageQueue()
        await q.ui_enqueue("a")
        snap = q.ui_snapshot()
        snap["items"][0]["text"] = "tampered"
        return q.ui_snapshot()["items"][0]["text"]
    assert run(go()) == "a"


def test_ui_queue_is_independent_of_the_tiered_queue():
    """The steer/followUp tiers used by the router must not leak into the UI list."""
    async def go():
        q = MessageQueue()
        await q.send_message("router-level", "steer")
        return q.ui_pending
    assert run(go()) == 0
