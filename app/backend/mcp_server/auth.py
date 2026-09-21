"""mcp_server/auth.py - Signature verification for the MCP gateway.

Implements the ``md5(body + timestamp + accessKey + nonce)`` scheme described in
the MCP gateway pattern: a single gateway endpoint, per-business access keys,
and replay protection via a timestamp window plus a nonce cache.

The access key is never transmitted — only the digest is.
"""
from __future__ import annotations

import hashlib
import os
import time
from typing import Optional

from result import Result

#: Requests older/newer than this many seconds are rejected (clock skew window).
TIMESTAMP_WINDOW_SECONDS = 300
#: Nonces are remembered for the timestamp window so replays inside it fail.
_NONCE_TTL = TIMESTAMP_WINDOW_SECONDS * 2


class SignatureVerifier:
    """Verify gateway request signatures with replay protection.

    Args:
        access_keys: Mapping of ``business_id -> access_key``. When omitted,
            keys are read from ``OVOLVE_MCP_KEYS`` formatted as
            ``business1:key1,business2:key2``.
    """

    def __init__(self, access_keys: dict[str, str] = None) -> None:
        self._keys = dict(access_keys or self._keys_from_env())
        self._seen_nonces: dict[str, float] = {}

    @staticmethod
    def _keys_from_env() -> dict[str, str]:
        """Parse access keys out of the environment."""
        raw = os.environ.get("OVOLVE_MCP_KEYS", "")
        out: dict[str, str] = {}
        for pair in raw.split(","):
            if ":" in pair:
                business, key = pair.split(":", 1)
                business, key = business.strip(), key.strip()
                if business and key:
                    out[business] = key
        return out

    def register_key(self, business_id: str, access_key: str) -> None:
        """Register or replace an access key for a business id."""
        self._keys[business_id] = access_key

    @staticmethod
    def compute(body: str, timestamp: str, access_key: str, nonce: str) -> str:
        """Compute the expected signature digest.

        Args:
            body: Raw request body as sent (byte-for-byte).
            timestamp: Unix seconds as a string.
            access_key: Shared secret for the business id.
            nonce: Per-request random string.

        Returns:
            Lowercase hex md5 digest.
        """
        seed = f"{body}{timestamp}{access_key}{nonce}".encode("utf-8")
        return hashlib.md5(seed).hexdigest()

    def verify(
        self,
        body: str,
        business_id: str,
        timestamp: str,
        nonce: str,
        signature: str,
        now: Optional[float] = None,
    ) -> Result:
        """Verify a request signature.

        Checks, in order: known business id, timestamp freshness, nonce
        uniqueness, then digest equality (constant-time).

        Args:
            body: Raw request body.
            business_id: Caller identity used to select the access key.
            timestamp: Request timestamp header.
            nonce: Request nonce header.
            signature: Provided digest.
            now: Override for the current time (testing).

        Returns:
            Result.success(business_id) or a failure with a semantic code.
        """
        access_key = self._keys.get(business_id)
        if not access_key:
            return Result.failure(f"Unknown business id: {business_id}", code="UnknownBusiness")

        current = now if now is not None else time.time()
        try:
            ts = float(timestamp)
        except (TypeError, ValueError):
            return Result.failure("Malformed timestamp", code="BadTimestamp")
        if abs(current - ts) > TIMESTAMP_WINDOW_SECONDS:
            return Result.failure("Timestamp outside allowed window", code="StaleTimestamp")

        self._evict_expired_nonces(current)
        nonce_key = f"{business_id}:{nonce}"
        if not nonce:
            return Result.failure("Missing nonce", code="MissingNonce")
        if nonce_key in self._seen_nonces:
            return Result.failure("Nonce already used (replay)", code="ReplayDetected")

        expected = self.compute(body, timestamp, access_key, nonce)
        if not self._constant_time_eq(expected, signature or ""):
            return Result.failure("Signature mismatch", code="BadSignature")

        self._seen_nonces[nonce_key] = current
        return Result.success(business_id)

    def _evict_expired_nonces(self, now: float) -> None:
        """Drop nonces older than the retention window."""
        cutoff = now - _NONCE_TTL
        for key in [k for k, seen in self._seen_nonces.items() if seen < cutoff]:
            self._seen_nonces.pop(key, None)

    @staticmethod
    def _constant_time_eq(a: str, b: str) -> bool:
        """Length-and-content comparison that does not short-circuit."""
        if len(a) != len(b):
            return False
        diff = 0
        for x, y in zip(a, b):
            diff |= ord(x) ^ ord(y)
        return diff == 0


_verifier: Optional[SignatureVerifier] = None


def get_verifier() -> SignatureVerifier:
    """Get the global SignatureVerifier singleton."""
    global _verifier
    if _verifier is None:
        _verifier = SignatureVerifier()
    return _verifier
