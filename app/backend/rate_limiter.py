"""rate_limiter.py — per-provider RPM/TPM token buckets (admission control).

Why this exists
---------------
The only concurrency control in the codebase is ``subagent_runtime``'s semaphore,
which bounds how many sub-agents run — not how fast LLM requests go out, and it
does not cover the main turn, cron, or the goal scheduler. So all of those can
hammer one provider at once, hit 429, and each back off independently: a
synchronised retry storm. Rate limiting has two postures — retry after the wall,
or queue before it. This is the "queue before it" half we were missing.

Design
------
* **Per provider, not global.** Keyed by the provider's base URL. Two providers
  have independent quotas; retargeting mid-session (``LLMClient.bind``) just
  lands on a different bucket.
* **Two windows.** A request/min bucket and a token/min bucket, both classic
  continuously-refilling token buckets. A call must clear BOTH.
* **Reserve-then-settle for tokens.** We don't know real token cost until the
  response comes back, so we reserve an estimate up front and correct the bucket
  once the provider reports actual usage — under-charging early would let a burst
  of big requests slip the TPM cap.
* **Opt-in.** A provider with no configured ``rpm``/``tpm`` gets a pass-through
  bucket: ``acquire`` returns immediately. Existing behaviour is unchanged until
  someone sets a limit, so this can't regress a working setup.
* **Abortable + bounded wait.** ``acquire`` polls a caller-supplied predicate so
  a cancelled turn doesn't get stuck at the gate, and honours a ``max_wait`` so a
  misconfigured tiny quota degrades to "go anyway" rather than "hang forever".
* **In-process.** Single-process desktop app; no shared store needed.

Original implementation.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Callable, Optional

#: Poll granularity while waiting for the bucket to refill. Small enough that an
#: abort feels instant, large enough not to busy-spin.
_POLL_S = 0.05


class _Bucket:
    """One continuously-refilling token bucket.

    ``capacity`` per-minute converts to a refill rate of ``capacity/60`` per
    second. ``level`` is the currently-available allowance, capped at capacity.
    A non-positive capacity means "unlimited" — every check passes.
    """

    def __init__(self, capacity: float, now: float) -> None:
        self.capacity = float(capacity)
        self.level = float(capacity)
        self._last = now

    @property
    def unlimited(self) -> bool:
        return self.capacity <= 0

    def _refill(self, now: float) -> None:
        if self.unlimited:
            return
        elapsed = max(0.0, now - self._last)
        self._last = now
        self.level = min(self.capacity, self.level + elapsed * (self.capacity / 60.0))

    def take(self, amount: float, now: float) -> bool:
        """Consume ``amount`` if available; return whether it went through."""
        if self.unlimited:
            return True
        self._refill(now)
        if self.level + 1e-9 >= amount:
            self.level -= amount
            return True
        return False

    def eta(self, amount: float, now: float) -> float:
        """Seconds until ``amount`` would be available (0 if it is now)."""
        if self.unlimited:
            return 0.0
        self._refill(now)
        deficit = amount - self.level
        if deficit <= 0:
            return 0.0
        # A single request larger than the whole bucket would never fit; cap the
        # demand at capacity so eta stays finite and `acquire`'s max_wait governs.
        deficit = min(deficit, self.capacity)
        return deficit / (self.capacity / 60.0)

    def adjust(self, delta: float, now: float) -> None:
        """Correct the level by ``delta`` (negative = charge more)."""
        if self.unlimited:
            return
        self._refill(now)
        self.level = max(-self.capacity, min(self.capacity, self.level + delta))

    def drain(self, now: float) -> None:
        """Empty the bucket — used to enforce a provider's Retry-After."""
        if self.unlimited:
            return
        self._refill(now)
        self.level = 0.0


@dataclass
class Quota:
    """A provider's per-minute allowances. ``<= 0`` means unlimited."""

    rpm: float = 0.0
    tpm: float = 0.0

    @property
    def active(self) -> bool:
        return self.rpm > 0 or self.tpm > 0


@dataclass
class Admission:
    """What ``acquire`` did, so callers can log/report honestly."""

    waited_s: float = 0.0
    aborted: bool = False
    forced: bool = False   # max_wait elapsed and we let it through anyway
    reserved_tokens: int = 0


class RateLimiter:
    """Per-provider admission control. Safe to share across the process."""

    #: Never block a turn longer than this at the gate. Past it we let the call
    #: through: a wrong-looking quota should slow us down, not wedge the app.
    DEFAULT_MAX_WAIT_S = 30.0

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._quotas: dict[str, Quota] = {}
        self._req: dict[str, _Bucket] = {}
        self._tok: dict[str, _Bucket] = {}
        self._lock = asyncio.Lock()

    # ── configuration ────────────────────────────────────────────────────

    def set_quota(self, provider: str, rpm: float = 0, tpm: float = 0) -> None:
        """Install (or replace) a provider's quota. Resets its buckets."""
        key = self._key(provider)
        now = self._clock()
        self._quotas[key] = Quota(float(rpm or 0), float(tpm or 0))
        self._req[key] = _Bucket(float(rpm or 0), now)
        self._tok[key] = _Bucket(float(tpm or 0), now)

    def configure(self, config: dict) -> int:
        """Read quotas out of config. Returns how many providers got one.

        Two shapes are accepted, because the config has both a single ``model``
        block and a ``providers`` list::

            {"model": {"base_url": ..., "rate_limit": {"rpm": 60, "tpm": 90000}}}
            {"providers": [{"base_url": ..., "rate_limit": {...}}, ...]}

        Anything without a ``rate_limit`` is left unlimited on purpose — this
        feature is opt-in, so an untouched config behaves exactly as before.
        """
        installed = 0
        if not isinstance(config, dict):
            return 0
        candidates = []
        model = config.get("model")
        if isinstance(model, dict):
            candidates.append(model)
        providers = config.get("providers")
        if isinstance(providers, list):
            candidates.extend(p for p in providers if isinstance(p, dict))
        for entry in candidates:
            limits = entry.get("rate_limit")
            if not isinstance(limits, dict):
                continue
            rpm = limits.get("rpm") or limits.get("requests_per_minute") or 0
            tpm = limits.get("tpm") or limits.get("tokens_per_minute") or 0
            if not (rpm or tpm):
                continue
            self.set_quota(entry.get("base_url") or entry.get("id") or "", rpm, tpm)
            installed += 1
        return installed

    def quota_for(self, provider: str) -> Quota:
        return self._quotas.get(self._key(provider), Quota())

    @staticmethod
    def _key(provider: str) -> str:
        return (provider or "").strip().rstrip("/").lower() or "default"

    # ── admission ────────────────────────────────────────────────────────

    async def acquire(
        self,
        provider: str,
        estimated_tokens: int = 0,
        max_wait_s: Optional[float] = None,
        should_abort: Optional[Callable[[], bool]] = None,
    ) -> Admission:
        """Wait until this provider can take one more request, then charge it.

        Args:
            provider: Provider base URL (or id).
            estimated_tokens: Pre-charge for the TPM bucket; corrected later by
                :meth:`settle`.
            max_wait_s: Hard ceiling on waiting. ``None`` uses the class default.
            should_abort: Polled while waiting — return True to give up. Wire the
                turn's cancel flag here so stopping a turn doesn't leave the user
                staring at a gate they can't see.

        Returns:
            An :class:`Admission` describing what happened. ``aborted=True`` means
            **nothing was charged and the caller must not send the request**.
        """
        key = self._key(provider)
        # Stop is not opt-in. Quotas are (they come from config, and most users
        # never set one), and the shortcut below used to return *before* the
        # cancel flag was ever polled — so with no quota configured, a turn the
        # user had already stopped still shipped, and the provider still billed
        # for it. The flag has to be read on the way in, ahead of the shortcut.
        if should_abort is not None and should_abort():
            return Admission(aborted=True)
        quota = self._quotas.get(key)
        if quota is None or not quota.active:
            return Admission()  # opt-in: no quota configured, no gate

        req = self._req.setdefault(key, _Bucket(quota.rpm, self._clock()))
        tok = self._tok.setdefault(key, _Bucket(quota.tpm, self._clock()))
        cap = self.DEFAULT_MAX_WAIT_S if max_wait_s is None else float(max_wait_s)
        tokens = max(0, int(estimated_tokens))
        started = self._clock()

        while True:
            if should_abort is not None and should_abort():
                return Admission(waited_s=self._clock() - started, aborted=True)
            # Both windows have to clear, and they must be taken together —
            # charging RPM then failing on TPM would leak allowance on every
            # retry of the wait loop.
            async with self._lock:
                now = self._clock()
                wait = max(req.eta(1, now), tok.eta(tokens, now))
                if wait <= 0:
                    req.take(1, now)
                    tok.take(tokens, now)
                    return Admission(waited_s=now - started,
                                     reserved_tokens=tokens)
            waited = self._clock() - started
            if waited >= cap:
                # Bounded wait: past the ceiling we go anyway and say so, rather
                # than hanging a turn on a quota someone typo'd.
                async with self._lock:
                    now = self._clock()
                    req.adjust(-1, now)
                    tok.adjust(-tokens, now)
                return Admission(waited_s=waited, forced=True,
                                 reserved_tokens=tokens)
            await asyncio.sleep(min(_POLL_S, max(0.0, wait), max(0.0, cap - waited)))

    def settle(self, provider: str, reserved_tokens: int, actual_tokens: int) -> None:
        """Correct the TPM bucket once the provider reports real usage.

        Estimates are usually low (they can't see the tokenizer or the cached
        prefix), so this is normally an extra charge. Without it the TPM cap
        drifts to whatever our estimator happens to under-count by.
        """
        key = self._key(provider)
        tok = self._tok.get(key)
        if tok is None or tok.unlimited:
            return
        delta = float(int(reserved_tokens or 0) - int(actual_tokens or 0))
        if delta:
            tok.adjust(delta, self._clock())

    def penalize(self, provider: str, retry_after_s: float = 0.0) -> None:
        """A 429 came back — drain the buckets so we stop pushing.

        The provider's own Retry-After is more trustworthy than our model of its
        quota, so it wins: we drain and additionally hold the request bucket down
        for that long instead of letting a fixed backoff overwrite it.
        """
        key = self._key(provider)
        now = self._clock()
        for bucket in (self._req.get(key), self._tok.get(key)):
            if bucket is None or bucket.unlimited:
                continue
            bucket.drain(now)
            if retry_after_s > 0:
                # Push the level negative so the refill has to climb back out,
                # which is exactly "don't come back for N seconds".
                bucket.adjust(-(retry_after_s * bucket.capacity / 60.0), now)

    def snapshot(self) -> dict:
        """Current levels per provider — for diagnostics / the usage page."""
        out: dict[str, dict] = {}
        now = self._clock()
        for key, quota in self._quotas.items():
            req, tok = self._req.get(key), self._tok.get(key)
            # eta(0) is a no-op read that also refills, so levels aren't stale.
            if req is not None:
                req.eta(0, now)
            if tok is not None:
                tok.eta(0, now)
            out[key] = {
                "rpm": quota.rpm,
                "tpm": quota.tpm,
                "requestsAvailable": round(req.level, 2) if req else 0,
                "tokensAvailable": round(tok.level, 2) if tok else 0,
            }
        return out


_limiter: Optional[RateLimiter] = None


def get_rate_limiter() -> RateLimiter:
    """Process-wide limiter. One bucket set per provider, shared by every caller
    (main turn, sub-agents, cron, goal scheduler) — which is the whole point."""
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter()
    return _limiter


def reset_rate_limiter() -> None:
    """Drop the singleton. For tests."""
    global _limiter
    _limiter = None
