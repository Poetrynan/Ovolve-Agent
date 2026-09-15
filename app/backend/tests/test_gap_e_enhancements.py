# -*- coding: utf-8 -*-
"""test_gap_e_enhancements.py — Tests for Gap E enhancements:
1. Steer queue high/low watermark backpressure (30 / 15)
2. Browser policy guard AST / token static analysis preventing false positives
"""
import pytest
from messaging import MessageQueue, DeliverAs, STEER_HIGH_WATERMARK, STEER_LOW_WATERMARK
from steer_protocol import SteerQueue
from browser_policy_guard import BrowserPolicyGuard, ScriptExecutionTier


@pytest.mark.asyncio
async def test_message_queue_steer_watermark_backpressure():
    mq = MessageQueue()

    # Fill up to high watermark (30 items)
    for i in range(STEER_HIGH_WATERMARK):
        await mq.send_message(f"Steer instruction {i}", deliver_as=DeliverAs.STEER)

    assert len(mq._steer) == STEER_HIGH_WATERMARK

    # 31st item must be rejected with backpressure error
    with pytest.raises(ValueError, match="转向过多"):
        await mq.send_message("Overflow steer", deliver_as=DeliverAs.STEER)

    # Drain 16 items so count is 14 (< low watermark 15)
    for _ in range(16):
        msg = await mq.poll_steer(ttl_s=0)
        assert msg is not None

    assert len(mq._steer) == 14

    # Enqueue should now succeed again
    recovered_msg = await mq.send_message("Recovered steer", deliver_as=DeliverAs.STEER)
    assert recovered_msg is not None
    assert len(mq._steer) == 15


def test_steer_queue_watermark_backpressure():
    sq = SteerQueue()
    for i in range(STEER_HIGH_WATERMARK):
        sq.enqueue(f"Sync steer {i}")

    assert sq.pending_count() == STEER_HIGH_WATERMARK

    # 31st item should be rejected
    with pytest.raises(ValueError, match="转向过多"):
        sq.enqueue("Overflow sync steer")


def test_browser_policy_guard_ast_eliminates_false_positives():
    guard = BrowserPolicyGuard()

    # 1. String literals containing "eval(" or "Function(" must NOT be blocked
    script_str = 'console.log("Checking eval() safety warning");'
    tier, reason = guard.classify_script(script_str)
    assert tier == ScriptExecutionTier.READ_ONLY, f"Expected READ_ONLY but got {tier}: {reason}"

    # 2. Comments containing dangerous words must NOT be blocked
    script_comment = '''
    // This function does not use eval(foo)
    /* nor does it use new Function() */
    const heading = document.querySelector("h1").innerText;
    '''
    tier, reason = guard.classify_script(script_comment)
    assert tier == ScriptExecutionTier.READ_ONLY, f"Expected READ_ONLY but got {tier}: {reason}"

    # 3. Substring identifiers like isFunction or obj.eval must NOT be blocked
    script_func = 'if (isFunction(callback)) { callback(); }'
    tier, reason = guard.classify_script(script_func)
    assert tier == ScriptExecutionTier.READ_ONLY, f"Expected READ_ONLY but got {tier}: {reason}"

    # 4. Genuine eval and Function MUST be blocked
    real_eval = 'const val = eval("2 + 2");'
    tier, reason = guard.classify_script(real_eval)
    assert tier == ScriptExecutionTier.BLOCKED_DANGEROUS

    real_fn = 'const f = new Function("a", "b", "return a + b");'
    tier, reason = guard.classify_script(real_fn)
    assert tier == ScriptExecutionTier.BLOCKED_DANGEROUS

    # 5. Genuine document.cookie must be blocked
    cookie_script = 'const c = document.cookie;'
    tier, reason = guard.classify_script(cookie_script)
    assert tier == ScriptExecutionTier.BLOCKED_DANGEROUS

    # 6. Mutating action
    mutating_script = 'document.querySelector("#btn-submit").click();'
    tier, reason = guard.classify_script(mutating_script)
    assert tier == ScriptExecutionTier.MUTATING
