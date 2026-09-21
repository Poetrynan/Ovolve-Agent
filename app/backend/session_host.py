"""session_host.py — Manages multiple Router sessions in a single process.

Implements the "Agent Host" pattern (VS Code 2026 / Zed ACP):
  - One Python backend process holds N independent agent sessions.
  - Each session owns its own Router instance (workspace, mode, compactor, etc.).
  - Low-level services (storage, bus, tools, models, LLM) are shared.
  - Concurrent windows connect to their respective sessions via WS.

Usage from http_server.py:
    host = SessionHost(system_prompt=cfg["system_prompt"])
    router = host.get_or_create(session_id, workspace)
    result = await router.handle(message, context)
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Optional

from router import Router

#: How long a failed run stays "pending" before its error becomes terminal.
#: A dropped LLM socket, a 503 from the provider or a 5s DNS stall are all
#: things that resolve themselves in under a second on retry. Failing the turn
#: on first contact turns a blip into a visible error the user has to re-drive;
#: holding it for a grace window lets a retry settle the SAME run successfully
#: and the user never learns anything went wrong.
PENDING_RUN_GRACE = 15.0

#: Dedupe TTLs. A caller-supplied id (bot platform message id, client-minted
#: uuid) is authoritative, so it can be remembered for minutes. A key DERIVED
#: from message text is a guess — two identical texts really can be two
#: separate intents ("继续" twice) — so it only covers the double-fire window
#: of a double-click or a reconnect replay.
DEDUPE_TTL_ID = 300.0
DEDUPE_TTL_TEXT = 3.0

#: Cap on the dedupe registry. Unbounded, it is a slow memory leak on a
#: long-lived desktop process; oldest-first eviction keeps it flat.
DEDUPE_MAX_KEYS = 512


class LifecycleMismatch(RuntimeError):
    """Raised when a run tagged with a stale generation tries to finalize.

    Every server start rotates a fresh `generation_id`; any pending run whose
    tag doesn't match must be aborted rather than silently reported to a UI
    that has since reconnected under new state. This mirrors the industry's
    ``AbortError`` for lifecycle generation.
    """


class SessionHost:
    """Process-wide registry of live Router sessions.

    Thread-safety: all mutating methods are called from the single asyncio
    event loop thread (aiohttp), so no lock is needed. If the design ever
    migrates to a threaded server, wrap `_sessions` access in a Lock.
    """

    def __init__(self, system_prompt: str = "", default_workspace: str = ""):
        self._system_prompt = system_prompt
        self._default_workspace = default_workspace or os.getcwd()
        self._sessions: dict[str, Router] = {}
        #: The first router created mounts shared bus subscribers (guards,
        #: sanitizers, risk controller). Subsequent ones skip re-mounting.
        self._shared_mounted = False
        #: Rotated on every startup. Runs, subagent callbacks and steering
        #: results tag themselves with the current value; a mismatch on
        #: finalize means the process restarted while they were in flight and
        #: they must be discarded, not delivered to a UI that has since
        #: reconnected under new state.
        self._generation_id: str = uuid.uuid4().hex
        #: Inbound dedupe registry. key -> (kind, expiry_monotonic). See
        #: `dedupe_seen`. Time-bounded and size-capped so it can't leak.
        self._dedupe: dict[str, tuple[str, float]] = {}
        #: Pending-run grace registry. token -> (session_id, key, expiry).
        #: A parked failure that a retry can still cancel. See `pending_arm`.
        self._pending_runs: dict[str, tuple[str, str, float]] = {}


    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, session_id: str) -> Optional[Router]:
        """Return the Router for a session, or None if it hasn't been loaded."""
        return self._sessions.get(session_id)

    def get_or_create(
        self,
        session_id: str,
        workspace: str = "",
    ) -> Router:
        """Return (or construct) a Router bound to the given session.

        If `session_id` is new, a fresh Router is created with the given
        workspace. If it already exists, the cached instance is returned
        (workspace changes within a session go through Router.switch_workspace).
        """
        existing = self._sessions.get(session_id)
        if existing is not None:
            return existing

        mount_shared = not self._shared_mounted
        router = Router(
            workspace=workspace or self._default_workspace,
            system_prompt=self._system_prompt,
            session_id=session_id,
            mount_shared=mount_shared,
        )
        if mount_shared:
            self._shared_mounted = True
        self._sessions[session_id] = router
        return router

    def get_primary(self) -> Router:
        """Return an already-live Router, creating the bootstrap one if needed.

        This is the fallback for callers with no session in scope: HTTP routes
        (git panel, settings, usage) and any WS frame that arrived before the
        window announced its session. It never invents a second session while
        one exists, so it cannot silently fan work out across sessions.
        """
        if self._sessions:
            return next(iter(self._sessions.values()))
        # Bootstrap: let Router run its legacy resume-or-create logic, then key
        # the registry by whatever session it actually landed on. Keying by the
        # empty string here would strand the row and make the next lookup build
        # a SECOND router for the same conversation.
        router = Router(
            workspace=self._default_workspace,
            system_prompt=self._system_prompt,
            mount_shared=not self._shared_mounted,
        )
        self._shared_mounted = True
        self._sessions[router.session_id] = router
        return router

    def close(self, session_id: str) -> None:
        """Remove a session from the host (e.g. window closed).

        Does NOT delete the session from storage — the history persists.
        """
        self._sessions.pop(session_id, None)

    def rebind(self, old_id: str, new_id: str) -> None:
        """Re-key a live Router from `old_id` to `new_id`.

        Used when a Router changes which session it serves in place — deleting
        the active session, for instance, calls ``router.new_session()`` and the
        same instance now owns a different id. Without re-keying, the registry
        would still file it under the dead id and the next lookup for `new_id`
        would build a SECOND Router for the same conversation.
        """
        if not new_id or old_id == new_id:
            return
        router = self._sessions.pop(old_id, None)
        if router is not None:
            self._sessions[new_id] = router


    def list_sessions(self) -> list[str]:
        """Return IDs of all live (in-memory) sessions."""
        return list(self._sessions.keys())

    @property
    def session_count(self) -> int:
        return len(self._sessions)

    # ------------------------------------------------------------------
    # Lifecycle generation
    # ------------------------------------------------------------------

    @property
    def generation_id(self) -> str:
        """The current lifecycle generation tag."""
        return self._generation_id

    def rotate_generation(self) -> str:
        """Mint a new generation, invalidating every in-flight run tag.

        Called on server startup (and available for a hard reset). Anything
        that was mid-flight under the old tag will fail its
        `assert_generation` check and abort instead of reporting a result into
        a world that has moved on.
        """
        self._generation_id = uuid.uuid4().hex
        return self._generation_id

    def is_generation_current(self, generation_id: str) -> bool:
        """Does this tag belong to the live generation?"""
        return bool(generation_id) and generation_id == self._generation_id

    def assert_generation(self, generation_id: str) -> None:
        """Raise LifecycleMismatch when a run's tag is stale.

        Call this at every point where a long-running operation is about to
        commit an observable side effect (persist a message, broadcast a
        terminal frame, apply a file write). Checking only at the start is not
        enough — the restart happens *during* the run.
        """
        if not self.is_generation_current(generation_id):
            raise LifecycleMismatch(
                f"run generation {generation_id!r} is stale "
                f"(current {self._generation_id!r})"
            )

    # ------------------------------------------------------------------
    # Inbound dedupe registry
    # ------------------------------------------------------------------
    # A message can hit the backend twice for perfectly ordinary reasons: the
    # WebSocket reconnected mid-flight and the client replayed its outbox; a
    # bot platform (Feishu, Telegram) delivered the same event twice under an
    # at-least-once contract; the user double-clicked send. Executing the
    # second copy runs the same tools twice, doubles the LLM cost and can
    # commit a git push twice. A tiny time-bounded set of "keys we've already
    # accepted" catches all three without any protocol changes.
    #
    # Kept on SessionHost (not on the WS handler) so bot providers, HTTP
    # callbacks and WS all share the same view — a duplicate that arrives on a
    # DIFFERENT channel than the original still gets suppressed.

    def _dedupe_gc(self) -> None:
        """Drop expired keys and cap total size.

        Called opportunistically from ``dedupe_seen``; no background timer is
        needed because dedupe is only consulted on inbound traffic.
        """
        now = time.monotonic()
        expired = [k for k, (_kind, exp) in self._dedupe.items() if exp <= now]
        for k in expired:
            self._dedupe.pop(k, None)
        # If a burst of unique ids blew past the cap, evict oldest-inserted
        # first. dict preserves insertion order in CPython 3.7+, so this is a
        # cheap approximation of an LRU without pulling in an extra structure.
        overflow = len(self._dedupe) - DEDUPE_MAX_KEYS
        if overflow > 0:
            for k in list(self._dedupe.keys())[:overflow]:
                self._dedupe.pop(k, None)

    def dedupe_seen(
        self,
        session_id: str,
        key: Optional[str],
        *,
        channel: str = "ws",
        kind: str = "id",
    ) -> bool:
        """Return True if this key was already accepted recently.

        Args:
            session_id: which conversation the key lives under; different
                sessions can legitimately reuse an id (bot user A and bot user
                B may both send `msg_id=1`).
            key: caller-supplied identifier. If empty/None, no dedupe happens
                (the caller opted out).
            channel: transport label included in the key so the same id from
                two providers is still two events.
            kind: ``"id"`` for authoritative ids (long TTL) vs ``"text"`` for
                content-derived guesses (short TTL).
        """
        if not key:
            return False
        self._dedupe_gc()
        full = f"{session_id}|{channel}|{kind}|{key}"
        ttl = DEDUPE_TTL_ID if kind == "id" else DEDUPE_TTL_TEXT
        entry = self._dedupe.get(full)
        now = time.monotonic()
        if entry is not None and entry[1] > now:
            return True
        self._dedupe[full] = (kind, now + ttl)
        return False

    # ------------------------------------------------------------------
    # Pending-run grace registry
    # ------------------------------------------------------------------
    # When a turn errors, we no longer broadcast the terminal frame right
    # away. We hand a token to the caller (WS handler, bot provider) and it
    # decides whether to commit that failure. If the client retries the SAME
    # msg_id inside the grace window, the caller cancels the pending fail and
    # the retry gets a clean run — the user never sees the transient error.
    # Requires no persistence: on process crash, all pending errors are
    # dropped anyway (the client is disconnected too).

    def pending_arm(self, session_id: str, key: str) -> str:
        """Register a pending failure token; returns the token id."""
        token = uuid.uuid4().hex
        expires = time.monotonic() + PENDING_RUN_GRACE
        self._pending_runs[token] = (session_id, key, expires)
        return token

    def pending_take_by_key(self, session_id: str, key: str) -> Optional[str]:
        """Consume any pending token for (session_id, key).

        Used by the retry path: a fresh prompt with a matching key wants to
        cancel whatever error was parked for the previous attempt. Returns
        the token id so the caller can also cancel its own timer.
        """
        if not key:
            return None
        for token, (sid, k, _exp) in list(self._pending_runs.items()):
            if sid == session_id and k == key:
                self._pending_runs.pop(token, None)
                return token
        return None

    def pending_commit(self, token: str) -> bool:
        """Consume a token before firing the parked error.

        Returns False if the token is already gone (a retry cancelled it, or
        another timer fired first) — the caller must NOT broadcast in that
        case, or the user gets a stale error after a successful retry.
        """
        return self._pending_runs.pop(token, None) is not None

    def pending_gc(self) -> None:
        """Drop expired tokens whose timers presumably fired without cleanup."""
        now = time.monotonic()
        stale = [t for t, (_s, _k, exp) in self._pending_runs.items() if exp <= now]
        for t in stale:
            self._pending_runs.pop(t, None)




# ----------------------------------------------------------------------
# Process-wide accessor
# ----------------------------------------------------------------------
# `create_server` builds the host, but `run_server` (which wires the bot) and
# any future entry point need the same instance. A module-level singleton is
# how they share it without threading the object through every signature.
_host: Optional[SessionHost] = None


def set_session_host(host: SessionHost) -> SessionHost:
    """Publish the process's SessionHost. Called once during server startup."""
    global _host
    _host = host
    return _host


def get_session_host() -> Optional[SessionHost]:
    """The process's SessionHost, or None before the server has started."""
    return _host
