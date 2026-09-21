"""Phase 9 收口测试：失败分类学接入 llm_client 的实际重试路径。

验收口径（HANDOFF 任务 2）：
- auth 类零重试立即返回；
- rate_limit 有界退避（≥2 次，且不再烧满整条固定梯子）；
- server 类按 PROVIDER 策略只补试一次；
- backoff_delay_for_failure 走适配表，而不是把 llm_errors 语义码
  错当成 taxonomy 原生类落进 UNKNOWN 档。
"""
import asyncio

from result import Result

import llm_client as lc
from failure_taxonomy import backoff_delay, backoff_delay_for_failure


def _client(failures):
    """裸对象绑定：_post 依次吐出给定失败、之后成功；calls 记录真实发送数。"""
    c = lc.LLMClient.__new__(lc.LLMClient)
    calls = {"n": 0}

    async def _post(body, abort_check=None):
        calls["n"] += 1
        if calls["n"] <= len(failures):
            return failures[calls["n"] - 1]
        return Result.success({"ok": True})

    c._post = _post
    return c, calls


def test_backoff_delay_for_failure_uses_adapter_table():
    # "timeout"/"server" 是 llm_errors 的语义码，不在 taxonomy 原生类表里。
    # 旧写法直接喂 backoff_delay 会落进 UNKNOWN 档：base 恰好同为 1.0 掩盖了
    # 错误，但 attempt≥1 时被 UNKNOWN 的 max_retries=1 提前清零——退避被缩短。
    assert backoff_delay_for_failure("timeout", 0) == 1.0
    assert backoff_delay_for_failure("timeout", 2) == 4.0, "NETWORK 档应有完整指数梯子"
    assert backoff_delay("unknown", 2) == 0.0, "对照组：UNKNOWN 档确实会提前清零"
    assert backoff_delay_for_failure("timeout", 3) == 0.0, "超出 max_retries 不再等待"
    assert backoff_delay_for_failure("auth", 0) == 0.0, "不可重试类延迟为 0"


def test_auth_fails_immediately_without_retry():
    fail = Result.failure("HTTP 401: invalid api key", code="HTTP401")
    c, calls = _client([fail] * 5)
    res = asyncio.run(c._post_with_retry({}))
    assert not res.ok
    assert calls["n"] == 1, "auth 类零重试——一次发送后立即上抛"
    assert res.meta.get("failure") == "auth"
    assert res.meta.get("retry_policy", {}).get("allow_fallback") is False


def test_server_failure_stops_at_policy_cap(monkeypatch):
    # PROVIDER 策略 max_retries=1：初次失败后只补一次。旧实现会把固定五级
    # 梯子全部烧完（5 次发送、15s 等待）才放弃。
    waits = []

    async def _nap(s):
        waits.append(s)

    monkeypatch.setattr(asyncio, "sleep", _nap)
    fail = Result.failure("HTTP 500: provider internal error", code="HTTP500")
    c, calls = _client([fail, fail])
    res = asyncio.run(c._post_with_retry({}))
    assert not res.ok
    assert calls["n"] == 2, f"PROVIDER 类最多初次+1 补试，实际发送 {calls['n']} 次"
    assert res.meta.get("failure") == "server"
    pol = res.meta.get("retry_policy") or {}
    assert pol.get("max_retries") == 1 and pol.get("allow_fallback") is True


def test_rate_limit_bounded_backoff_ladder(monkeypatch):
    waits = []

    async def _nap(s):
        waits.append(s)

    monkeypatch.setattr(asyncio, "sleep", _nap)
    fail = Result.failure("HTTP 429: rate limit exceeded", code="HTTP429")
    c, calls = _client([fail] * 10)
    res = asyncio.run(c._post_with_retry({}))
    assert not res.ok
    assert calls["n"] == 4, "RATE_LIMIT max_retries=3 → 初次 + 3 补试，封顶"
    assert waits == [2.0, 4.0, 8.0], "退避按 RATE_LIMIT 档 base=2.0 指数增长"


def test_success_stops_the_loop_immediately():
    fail = Result.failure("HTTP 429: rate limit exceeded", code="HTTP429")
    c, calls = _client([fail])
    res = asyncio.run(c._post_with_retry({}))
    assert res.ok and res.value == {"ok": True}
    assert calls["n"] == 2, "第二次发送成功即返回，不进入更多重试"
