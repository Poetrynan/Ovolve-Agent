"""Test the cooperative cancel token on Router.

Router.__init__ pulls in the whole world (SQLite, LLM client, tool registry), so
these tests exercise the cancel primitives against a bare object with just the
token wired up — the same three methods the agent loop calls.
"""
import asyncio
import pytest

from router import Router


class _Bare:
    """Router's cancel surface, without the constructor's dependency graph."""
    cancel = Router.cancel
    _cancel_requested = Router._cancel_requested
    _clear_cancel = Router._clear_cancel

    def __init__(self):
        self._cancelled = asyncio.Event()


def make():
    async def build():
        return _Bare()
    return asyncio.run(build())


def test_starts_uncancelled():
    r = make()
    assert r._cancel_requested() is False


def test_cancel_sets_the_flag():
    r = make()
    r.cancel()
    assert r._cancel_requested() is True


def test_clear_resets_the_flag():
    """Each turn clears the token so a stale Stop doesn't kill the next turn."""
    r = make()
    r.cancel()
    r._clear_cancel()
    assert r._cancel_requested() is False


def test_cancel_is_idempotent():
    r = make()
    r.cancel()
    r.cancel()
    assert r._cancel_requested() is True


def test_router_actually_exposes_cancel():
    """Regression: http_server used to guard with hasattr and silently no-op
    because Router had no cancel() at all — the Stop button did nothing."""
    assert callable(getattr(Router, "cancel", None))
