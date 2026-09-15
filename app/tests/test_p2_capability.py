"""Capability-layer batch (C1–C4).

Each 语料 below pins one defect that made the agent weaker than its own code
claimed to be. The theme is the same throughout: a mechanism exists, looks
plausible when read, and does the wrong thing at runtime.

  C1  history window read the OLDEST rows instead of the newest
  C2  Stop set a flag but never cancelled the task
  C3  one fold request ran the compactor twice
  C4  AGENTS.md / MEMORY.md were written and never read back
"""
import asyncio
import os
from types import SimpleNamespace

import pytest

from storage import Storage
from router import Router


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def store(tmp_path):
    """A real Storage on a throwaway directory — these bugs live in the SQL."""
    return Storage(db_dir=str(tmp_path / "db"))


SID = "s-capability"


def seed(store, n, sid=SID):
    """n messages, alternating roles, each tagged with its own index."""
    for i in range(n):
        role = "user" if i % 2 == 0 else "assistant"
        store.add_message(sid, role, f"msg-{i}")


# ── 语料 1 · C1 历史窗口取反 ────────────────────────────────────────────────

def test_get_messages_still_returns_the_head(store):
    """The old accessor keeps its meaning — transcript views depend on it."""
    seed(store, 30)
    rows = store.get_messages(SID, limit=5)
    assert [r["content"] for r in rows] == ["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]


def test_recent_messages_returns_the_tail(store):
    seed(store, 30)
    rows = store.get_recent_messages(SID, limit=5)
    assert [r["content"] for r in rows] == ["msg-25", "msg-26", "msg-27", "msg-28", "msg-29"]


def test_recent_messages_stay_in_chronological_order(store):
    """Selected DESC to grab the tail, then reversed — the model needs turns in
    the order they happened, not newest-first."""
    seed(store, 10)
    seqs = [r["seq"] for r in store.get_recent_messages(SID, limit=4)]
    assert seqs == sorted(seqs)


def test_recent_messages_below_the_limit_returns_everything(store):
    seed(store, 3)
    rows = store.get_recent_messages(SID, limit=20)
    assert [r["content"] for r in rows] == ["msg-0", "msg-1", "msg-2"]


def test_recent_messages_is_scoped_to_one_session(store):
    seed(store, 5, sid="a")
    seed(store, 5, sid="b")
    rows = store.get_recent_messages("a", limit=99)
    assert len(rows) == 5


def test_count_messages_is_not_capped_by_a_page_limit(store):
    """``should_fold`` compares a watermark against the length of the history.
    Feeding it a 100-row page makes the count top out at 100, and once the
    watermark reaches that ceiling every later auto-fold reports no-new-content
    and folding quietly stops happening."""
    seed(store, 250)
    assert store.count_messages(SID) == 250
    assert len(store.get_messages(SID)) == 100  # the default page, for contrast


class _BareHistory:
    """``_build_history`` touches only storage, the compactor's unseal, and the
    session id. Router's real constructor pulls in SQLite, the LLM client and the
    tool registry, none of which this behaviour depends on."""

    _build_history = Router._build_history

    def __init__(self, storage, session_id=SID):
        self.storage = storage
        self.session_id = session_id
        self.compactor = SimpleNamespace(_unseal=lambda s: s)


def test_history_follows_the_conversation_forward(store):
    """The regression: past the limit the window used to freeze on the opening
    turns, so the model never saw what had just been said."""
    seed(store, 60)
    history = _BareHistory(store)._build_history(limit=10)
    assert "msg-0" not in [h["content"] for h in history]
    assert "msg-58" in [h["content"] for h in history]


def test_history_drops_the_trailing_user_row(store):
    """``handle`` already persisted the current message; replaying it would send
    the same turn twice."""
    seed(store, 4)                      # msg-3 is assistant
    store.add_message(SID, "user", "the current turn")
    history = _BareHistory(store)._build_history(limit=10)
    assert [h["content"] for h in history][-1] == "msg-3"


def test_history_replays_from_the_newest_fold_marker(store):
    """The summary stands in for everything before it. Finding the marker at all
    requires a tail window — on a head window it sits past the end."""
    seed(store, 40)
    store.add_compaction(SID, "FOLD SUMMARY", 1000, 100)
    store.add_message(SID, "user", "after the fold")
    store.add_message(SID, "assistant", "acknowledged")
    history = _BareHistory(store)._build_history(limit=10)
    contents = [h["content"] for h in history]
    assert contents[0] == "FOLD SUMMARY"
    assert history[0]["role"] == "system"     # context, not something the user said
    assert "msg-39" not in contents           # represented by the summary now
    assert "after the fold" in contents


# ── 语料 2 · C2 Stop 只是"建议" ──────────────────────────────────────────────

from server.http_server import WebSocketHandler          # noqa: E402


class _BareStop:
    """The Stop enforcement surface, without the handler's dependency graph."""

    STOP_GRACE_S = 0.05                                   # keep the test quick
    _live_turn_tasks_for = WebSocketHandler._live_turn_tasks_for
    _hard_cancel_after_grace = WebSocketHandler._hard_cancel_after_grace
    _spawn_stop_watchdog = WebSocketHandler._spawn_stop_watchdog

    def __init__(self):
        self._session_by_ws = {}
        self._turn_tasks = {}
        # Session-scoped registry. `_live_turn_tasks_for` reads this before it
        # falls back to the per-socket map, so a fake without it raises
        # AttributeError the moment a socket has announced a session.
        self._turn_tasks_by_sid = {}
        self._stop_watchdogs = set()


def test_a_stuck_turn_gets_killed_after_the_grace_window():
    """The regression: nothing ever called .cancel() on the turn task, so a turn
    parked inside a long call kept running — and kept spending — after the UI had
    already been told the agent was idle."""
    async def body():
        h = _BareStop()
        ws = object()

        async def never_finishes():
            await asyncio.sleep(30)

        task = asyncio.create_task(never_finishes())
        h._turn_tasks[id(ws)] = task
        h._spawn_stop_watchdog(ws)
        await asyncio.sleep(h.STOP_GRACE_S * 4)
        assert task.cancelled()

    run(body())


def test_a_turn_that_stops_on_its_own_is_not_cancelled():
    """Cooperative stop is the normal path: the loop notices the flag, unwinds,
    persists its interrupt note. The watchdog must not turn that into a kill —
    a cancelled task cannot finish writing the note that makes resume possible."""
    async def body():
        h = _BareStop()
        ws = object()

        async def stops_promptly():
            await asyncio.sleep(0.01)
            return "clean"

        task = asyncio.create_task(stops_promptly())
        h._turn_tasks[id(ws)] = task
        h._spawn_stop_watchdog(ws)
        await asyncio.sleep(h.STOP_GRACE_S * 4)
        assert not task.cancelled()
        assert task.result() == "clean"

    run(body())


def test_stop_reaches_every_window_on_the_same_session():
    """Two windows share one turn lifecycle, so Stop in either must reach it."""
    async def body():
        h = _BareStop()
        win_a, win_b = object(), object()
        h._session_by_ws[id(win_a)] = "shared"
        h._session_by_ws[id(win_b)] = "shared"

        async def never_finishes():
            await asyncio.sleep(30)

        task = asyncio.create_task(never_finishes())
        h._turn_tasks[id(win_a)] = task
        h._spawn_stop_watchdog(win_b)          # pressed in the OTHER window
        await asyncio.sleep(h.STOP_GRACE_S * 4)
        assert task.cancelled()

    run(body())


def test_stop_does_not_reach_another_session():
    async def body():
        h = _BareStop()
        mine, theirs = object(), object()
        h._session_by_ws[id(mine)] = "mine"
        h._session_by_ws[id(theirs)] = "theirs"

        async def never_finishes():
            await asyncio.sleep(30)

        task = asyncio.create_task(never_finishes())
        h._turn_tasks[id(theirs)] = task
        h._spawn_stop_watchdog(mine)
        await asyncio.sleep(h.STOP_GRACE_S * 4)
        assert not task.cancelled()
        task.cancel()

    run(body())


def test_watchdog_keeps_a_strong_reference_while_it_waits():
    """A bare create_task can be collected mid-wait, and a collected watchdog
    stops enforcing Stop without any error to show for it."""
    async def body():
        h = _BareStop()
        ws = object()

        async def never_finishes():
            await asyncio.sleep(30)

        task = asyncio.create_task(never_finishes())
        h._turn_tasks[id(ws)] = task
        h._spawn_stop_watchdog(ws)
        assert len(h._stop_watchdogs) == 1
        await asyncio.sleep(h.STOP_GRACE_S * 4)
        assert h._stop_watchdogs == set()      # and drops it when done

    run(body())


def test_no_watchdog_is_armed_when_nothing_is_running():
    async def body():
        h = _BareStop()
        h._spawn_stop_watchdog(object())
        assert h._stop_watchdogs == set()

    run(body())


# ── 语料 2b · C2 流式读取要真的停下来 ───────────────────────────────────────

import llm_client as lc                                   # noqa: E402


class _FakeContent:
    def __init__(self, chunks):
        self._chunks = chunks

    async def iter_any(self):
        for chunk in self._chunks:
            yield chunk


class _FakeResponse:
    status = 200
    headers: dict = {}

    def __init__(self, chunks):
        self.content = _FakeContent(chunks)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    """Just enough aiohttp to drive the SSE read loop with no network."""

    chunks: list = []
    # `_get_shared_session` pools sessions by `id(loop)` and probes `.closed`
    # before reusing one. Loop ids are recycled after GC, so a pool entry left
    # by an earlier `asyncio.run()` can be picked up by a later one — the probe
    # runs, and a fake without this attribute fails the whole request.
    closed = False

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def post(self, *a, **k):
        return _FakeResponse(self.chunks)


def _sse(*texts):
    out = [
        b'data: {"choices":[{"delta":{"content":"' + t.encode() + b'"}}]}\n'
        for t in texts
    ]
    out.append(b"data: [DONE]\n")
    return out


@pytest.fixture
def streaming_client(monkeypatch):
    monkeypatch.setattr(_FakeSession, "chunks", _sse("one", "two", "three"))
    monkeypatch.setattr(lc.aiohttp, "ClientSession", _FakeSession)
    return lc.LLMClient({"model": {
        "model_id": "test-model",
        "api_key": "k",
        "base_url": "http://127.0.0.1:1/v1",
    }})


def _collect(client, abort_check=None, sink=None):
    """Drain a stream, optionally into a caller-owned list.

    ``sink`` exists so an ``abort_check`` can react to what the caller has
    already been shown. Watching the events themselves keeps a test honest;
    counting polls or chunks would just re-encode the read loop's internals.
    """
    async def body():
        events = sink if sink is not None else []
        async for ev in client.chat_stream([{"role": "user", "content": "hi"}],
                                           abort_check=abort_check):
            events.append(ev)
        return events
    return run(body())


def test_stream_runs_to_completion_without_an_abort(streaming_client):
    events = _collect(streaming_client)
    done = events[-1]
    assert done["type"] == "done"
    assert done["reply"]["content"] == "onetwothree"
    assert done["reply"]["aborted"] is False


def test_stream_stops_reading_once_stop_is_pressed(streaming_client):
    """The regression: abort_check was consulted only at the rate-limit admission
    gate, so once the response had started the stream was read to the end no
    matter what — the provider kept generating and billing while the UI sat idle."""
    # Press Stop the moment the user has actually been shown something. Saying
    # it this way survives changes to the read loop: the loop takes a chunk off
    # the wire, *then* checks the flag, so the chunk in flight is dropped —
    # which means "one chunk shown" is not the same as "one chunk fetched".
    # Counting polls or chunks would instead bake those internals in.
    shown = []

    def stop_once_the_user_has_seen_content():
        return any(e.get("type") == "content" for e in shown)

    events = _collect(streaming_client,
                      abort_check=stop_once_the_user_has_seen_content,
                      sink=shown)
    done = events[-1]
    assert done["reply"]["content"] == "one"        # "two"/"three" never read
    assert done["reply"]["aborted"] is True


def test_an_aborted_stream_is_not_mistaken_for_a_finished_one(streaming_client):
    """Partial output is kept — the user already watched it arrive — but the turn
    must stay distinguishable from one that ran out naturally.

    There are two abort timings, and they deliberately produce two shapes:

    * Stop before the first chunk: the request is still sitting at the rate-limit
      gate, so no provider call was ever made and there is nothing to finish.
      The stream emits ``error``/``Cancelled`` and **no** ``done`` at all —
      ``llm_errors.classify`` maps that code to FAILURE_CANCELLED, which is how
      the loop tells "the user pressed stop" apart from "the provider broke".
      The non-streaming path (``chat``) answers the same way.
    * Stop mid-stream: ``done`` arrives with ``reply["aborted"] is True`` — see
      ``test_stream_stops_reading_once_stop_is_pressed``.

    Neither shape can be mistaken for a clean finish.
    """
    events = _collect(streaming_client, abort_check=lambda: True)
    assert [e["type"] for e in events] == ["error"]
    assert events[-1]["code"] == "Cancelled"
    assert not any(e["type"] == "done" for e in events)


# ── 语料 3 · C3 一次折叠请求跑了两遍 ────────────────────────────────────────

import context_compactor as cc                            # noqa: E402
from context_compactor import ContextCompactor            # noqa: E402
from event_bus import Event                               # noqa: E402


@pytest.fixture
def compactor(monkeypatch):
    """A compactor whose fold is counted instead of performed."""
    class _S:
        def add_compaction(self, *a, **k):
            pass

    monkeypatch.setattr(cc, "get_storage", lambda: _S())
    c = ContextCompactor()
    c.folds = 0

    async def counting_fold(session_id, messages, manual=False):
        c.folds += 1
        from result import Result
        return Result.success({"summary": "S", "strategy": "llm-summary"})

    monkeypatch.setattr(c, "fold", counting_fold)
    return c


def payload(**over):
    base = {
        "session_id": SID,
        "messages": [{"role": "user", "content": "长内容" * 50}],
        "manual": False,
    }
    base.update(over)
    return base


def test_the_subscriber_yields_when_the_emitter_owns_the_fold(compactor):
    """The regression: Router.fold_context emits this event and then folds itself,
    while the compactor also folds on the same event. One request ran the
    summariser twice — two model calls, two compaction rows. `_folding` could not
    stop it: the first call's `finally` had already cleared the flag."""
    run(compactor._on_compact(Event(name="session_before_compact",
                                    payload=payload(folds_itself=True))))
    assert compactor.folds == 0


def test_the_subscriber_still_folds_for_an_emitter_that_does_not(compactor):
    """The fallback path stays alive so a future emitter does not silently lose
    folding altogether."""
    run(compactor._on_compact(Event(name="session_before_compact",
                                    payload=payload())))
    assert compactor.folds == 1


def test_an_empty_history_is_never_folded(compactor):
    run(compactor._on_compact(Event(name="session_before_compact",
                                    payload=payload(messages=[]))))
    assert compactor.folds == 0


def test_router_claims_ownership_when_it_emits():
    """The claim has to actually be in the payload — the subscriber has no other
    way to know it should stand down."""
    import inspect
    src = inspect.getsource(Router.fold_context)
    assert '"folds_itself": True' in src


def test_fold_path_reads_far_more_than_one_page():
    """`should_fold` compares len(messages) against a watermark. On the default
    100-row page the count tops out, the watermark catches up to it, and every
    later auto-fold answers no-new-content — folding stops for good."""
    assert Router.FOLD_SCAN_LIMIT > 100


def test_no_new_content_is_reachable_again(store):
    """Sanity-check the watermark logic itself against a history longer than the
    old page size: the count must keep climbing past 100."""
    seed(store, 150)
    assert len(store.get_messages(SID, limit=Router.FOLD_SCAN_LIMIT)) == 150


# ── 语料 4 · C4 AGENTS.md / MEMORY.md 只写不读 ──────────────────────────────

class _BareGuidance:
    """The guidance-read surface, bound to a workspace root and nothing else."""

    GUIDANCE_FILES = Router.GUIDANCE_FILES
    GUIDANCE_MAX_CHARS = Router.GUIDANCE_MAX_CHARS
    _read_guidance_file = Router._read_guidance_file
    guidance_blocks = Router.guidance_blocks

    def __init__(self, workspace):
        self.workspace = workspace


def test_agents_md_is_read_back(tmp_path):
    """The regression: memory_layer wrote a `## Project Context` section into
    AGENTS.md and nothing ever read it, so extracted project context never reached
    the model."""
    (tmp_path / "AGENTS.md").write_text("## Project Context\n- [pref] user likes tabs",
                                        encoding="utf-8")
    blocks = _BareGuidance(str(tmp_path)).guidance_blocks()
    assert "AGENTS.md" in blocks
    assert "user likes tabs" in blocks["AGENTS.md"]


def test_evolution_learned_rules_are_read_back(tmp_path):
    """Rules the user approved land under `## Learned Rules (evolution)` in
    MEMORY.md — which must now actually reach the prompt."""
    (tmp_path / "MEMORY.md").write_text(
        "## Learned Rules (evolution)\n- always run tests from repo root",
        encoding="utf-8")
    blocks = _BareGuidance(str(tmp_path)).guidance_blocks()
    assert "always run tests from repo root" in blocks["MEMORY.md"]


def test_missing_files_yield_nothing(tmp_path):
    assert _BareGuidance(str(tmp_path)).guidance_blocks() == {}


def test_empty_file_is_not_injected(tmp_path):
    (tmp_path / "AGENTS.md").write_text("   \n\n", encoding="utf-8")
    assert _BareGuidance(str(tmp_path)).guidance_blocks() == {}


def test_oversized_guidance_is_capped(tmp_path):
    (tmp_path / "AGENTS.md").write_text("x" * 50_000, encoding="utf-8")
    body = _BareGuidance(str(tmp_path)).guidance_blocks()["AGENTS.md"]
    assert len(body) <= Router.GUIDANCE_MAX_CHARS + 64   # cap + the truncation note
    assert "截断" in body


def test_a_symlinked_guidance_file_does_not_escape_the_workspace(tmp_path):
    """The workspace root is configuration; a symlinked AGENTS.md must not pull
    arbitrary file content into the system prompt."""
    secret = tmp_path / "outside.txt"
    secret.write_text("TOP SECRET", encoding="utf-8")
    root = tmp_path / "ws"
    root.mkdir()
    link = root / "AGENTS.md"
    try:
        os.symlink(secret, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not permitted in this environment")
    blocks = _BareGuidance(str(root)).guidance_blocks()
    assert "TOP SECRET" not in blocks.get("AGENTS.md", "")


def test_no_workspace_reads_nothing():
    assert _BareGuidance("").guidance_blocks() == {}
