"""Rate limiter (admission control) tests.

All of them drive a fake clock — a real-time test of a per-minute bucket would
either sleep for seconds or be flaky, and neither is worth it. ``max_wait_s=0``
is used to probe "would this have blocked?" without waiting.
"""
import asyncio

import pytest

from rate_limiter import RateLimiter


class Clock:
    """Manually-advanced monotonic clock."""

    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


def run(coro):
    return asyncio.run(coro)


def test_no_quota_is_a_pass_through():
    """Opt-in: an untouched config must behave exactly as before."""
    rl = RateLimiter(clock=Clock())
    adm = run(rl.acquire("https://api.x", estimated_tokens=999_999))
    assert (adm.waited_s, adm.aborted, adm.forced) == (0.0, False, False)


def test_rpm_bucket_drains_then_blocks():
    clk = Clock()
    rl = RateLimiter(clock=clk)
    rl.set_quota("https://api.x", rpm=60)   # starts full at 60, refills 1/s

    async def drain():
        for _ in range(60):
            assert (await rl.acquire("https://api.x")).waited_s == 0

    run(drain())
    # Dry now. max_wait_s=0 turns "would block" into an observable forced pass.
    assert run(rl.acquire("https://api.x", max_wait_s=0)).forced


def test_bucket_refills_over_time():
    clk = Clock()
    rl = RateLimiter(clock=clk)
    rl.set_quota("p", rpm=60)
    run(rl.acquire("p"))
    clk.advance(5)                          # +5 slots
    adm = run(rl.acquire("p", max_wait_s=0))
    assert not adm.forced and adm.waited_s == 0


def test_abort_charges_nothing():
    """A cancelled turn must not sit at the gate, and must not spend a slot."""
    rl = RateLimiter(clock=Clock())
    rl.set_quota("p", rpm=1)
    run(rl.acquire("p"))
    adm = run(rl.acquire("p", should_abort=lambda: True))
    assert adm.aborted and adm.reserved_tokens == 0


def test_abort_is_honoured_even_without_a_quota():
    """The gate is opt-in, but Stop is not.

    ``acquire`` returned early whenever no quota was configured for the
    provider — before it ever polled ``should_abort`` — and "no quota" is the
    default state, since quotas come from config and most users never set one.
    So pressing Stop before the request went out was silently dropped:
    ``llm_client`` saw ``aborted=False``, shipped the call anyway, and the
    provider billed for a turn the user had already stopped. Honouring the
    cancel flag must not depend on whether somebody filled in a rate-limit
    number.
    """
    rl = RateLimiter(clock=Clock())          # deliberately no set_quota
    adm = run(rl.acquire("https://api.x", should_abort=lambda: True))
    assert adm.aborted
    assert adm.reserved_tokens == 0


def test_settle_corrects_an_under_estimate():
    """Estimates run low; without settle the TPM cap drifts by that much."""
    rl = RateLimiter(clock=Clock())
    rl.set_quota("p", tpm=1000)
    adm = run(rl.acquire("p", estimated_tokens=100))
    assert adm.reserved_tokens == 100

    before = rl.snapshot()["p"]["tokensAvailable"]
    rl.settle("p", reserved_tokens=100, actual_tokens=300)
    after = rl.snapshot()["p"]["tokensAvailable"]
    assert abs((before - after) - 200) < 1e-6


def test_settle_refunds_an_over_estimate():
    rl = RateLimiter(clock=Clock())
    rl.set_quota("p", tpm=1000)
    run(rl.acquire("p", estimated_tokens=500))
    before = rl.snapshot()["p"]["tokensAvailable"]
    rl.settle("p", reserved_tokens=500, actual_tokens=100)
    after = rl.snapshot()["p"]["tokensAvailable"]
    assert after > before


def test_penalize_holds_the_bucket_down():
    """429 → the provider's Retry-After wins over our own model of its quota."""
    rl = RateLimiter(clock=Clock())
    rl.set_quota("p", rpm=60)
    rl.penalize("p", retry_after_s=10)
    assert run(rl.acquire("p", max_wait_s=0)).forced


def test_providers_are_isolated():
    rl = RateLimiter(clock=Clock())
    rl.set_quota("a", rpm=1)
    rl.set_quota("b", rpm=1)
    run(rl.acquire("a"))
    adm = run(rl.acquire("b"))
    assert adm.waited_s == 0 and not adm.forced


def test_configure_reads_both_config_shapes():
    rl = RateLimiter(clock=Clock())
    n = rl.configure({
        "model": {"base_url": "https://m", "rate_limit": {"rpm": 30}},
        "providers": [
            {"base_url": "https://p1", "rate_limit": {"tokens_per_minute": 5000}},
            {"base_url": "https://p2"},          # no rate_limit → left unlimited
        ],
    })
    assert n == 2
    assert rl.quota_for("https://m").rpm == 30
    assert rl.quota_for("https://p1").tpm == 5000
    assert not rl.quota_for("https://p2").active


def test_provider_key_is_normalized():
    """Trailing slash / case must not create a second bucket for one provider."""
    rl = RateLimiter(clock=Clock())
    rl.set_quota("https://API.x/", rpm=1)
    run(rl.acquire("https://api.x"))
    assert run(rl.acquire("https://api.x/", max_wait_s=0)).forced


def test_configure_ignores_junk():
    rl = RateLimiter(clock=Clock())
    assert rl.configure({}) == 0
    assert rl.configure({"providers": "not a list"}) == 0
    assert rl.configure(None) == 0  # type: ignore[arg-type]
