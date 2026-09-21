"""
memory_layer.py - Long-term memory and synthesis system.

Implements the full memory lifecycle:
  1. Debounced extraction (60s -> LLM refine -> AGENTS.md)
  2. Dream consolidation (idle background analysis)
  3. Semantic prefetch (<memory> injection on user_prompt_submit)
  4. Session synthesis (structured JSON at session end / compaction)
  5. Storage upgrade (memory_entries with type/importance/tags/archived)

All features are event-driven via the EventBus, never embedded in router.py.
"""
from __future__ import annotations

import asyncio
import hashlib
import json

import math
import os
import re
import time
import uuid
from typing import Any, Callable, List, Optional

from result import Result
from storage import get_storage
from telemetry import get_telemetry, SpanName
from memory_tiers import (
    MemoryTier,
    ALWAYS_INJECT_TIERS,
    TOTAL_INJECT_BUDGET,
    estimate_tokens,
    normalize_tier,
    policy_for,
    should_promote,
    summarize_tiers,
    trim_to_budget,
)


def _l2_normalize(vec: list) -> list:
    """L2 normalize a vector. Zero-length returns as-is so we never divide by 0.

    ``embedder.encode()`` already normalizes, but external providers may not,
    and a re-read from cache is a good place to guarantee unit length so cosine
    similarity is just a dot product downstream. Idempotent for unit vectors.
    """
    norm = math.sqrt(sum(float(x) * float(x) for x in vec))
    if norm == 0:
        return list(vec)
    return [float(x) / norm for x in vec]


# ---------------------------------------------------------------------------
# Recall ranking parameters
# ---------------------------------------------------------------------------

#: Half-life for recency weighting. A memory 30 days old counts half as much as
#: an identical one recorded today; at 60 days, a quarter. Chosen because a
#: month is roughly the horizon over which a project's conventions turn over —
#: "we use webpack" from three months ago is actively misleading once the repo
#: moved to vite, and pure cosine similarity has no way to know that.
RECALL_HALFLIFE_DAYS = 30.0

#: MMR trade-off. 1.0 = pure relevance (and near-duplicate results), 0.0 = pure
#: diversity (and off-topic results). 0.7 leans relevance while still refusing
#: to spend all five injection slots on five phrasings of the same fact — which
#: is exactly what plain top-k does when a preference was recorded repeatedly.
RECALL_MMR_LAMBDA = 0.7

#: Over-fetch factor before re-ranking. Decay and MMR can only reorder what
#: they're given; asking for exactly `limit` rows means the diverse or fresher
#: candidate that should have won was never a candidate at all.
RECALL_CANDIDATE_MULTIPLIER = 4

#: How many (root, session) WORKING-tier buckets to keep alive at once. A folder
#: switch or a new session mints a key, and the process is long-lived, so the map
#: needs a ceiling. Well above any plausible number of simultaneously open
#: windows, low enough that it can never be mistaken for a leak.
MAX_WORKING_BUCKETS = 32



# ---------------------------------------------------------------------------
# Memory types & scopes
# ---------------------------------------------------------------------------

class MemoryType:
    """Memory category constants.

    These classify *what* a memory is about. Orthogonal to ``MemoryTier`` (C1)
    which classifies *how long* a memory lives and *where* it is stored.
    """
    FACT = "fact"
    PREFERENCE = "preference"
    CONTEXT = "context"
    PROCEDURE = "procedure"
    DREAM = "dream"
    SESSION = "session"


class MemoryScope:
    """Memory scope constants."""
    WORKSPACE = "workspace"
    PROJECT = "project"
    SESSION = "session"


# ---------------------------------------------------------------------------
# Memory data class
# ---------------------------------------------------------------------------

class Memory:
    """A single memory entry with metadata."""

    def __init__(
        self,
        content: str,
        mem_type: str = MemoryType.FACT,
        importance: float = 0.5,
        scope: str = MemoryScope.PROJECT,
        root_dir: str = "",
        session_id: str = "",
        tags: Optional[List[str]] = None,
        tier: str = MemoryTier.SEMANTIC,
        created_by: str = "agent",
    ) -> None:

        self.id: str = str(uuid.uuid4())
        self.content: str = content
        self.type: str = mem_type
        self.importance: float = importance
        self.scope: str = scope
        self.root_dir: str = root_dir
        self.session_id: str = session_id
        self.tags: List[str] = tags or []
        self.tier: str = tier if isinstance(tier, str) else tier.value
        self.created_at: float = time.time()
        self.updated_at: float = time.time()
        self.accessed_at: float = 0.0
        self.archived: bool = False
        self.embeddings: Optional[List[float]] = None
        self.hits: int = 0
        #: 谁写的：user | agent | import | evolution。决定写入闸门的严格程度——
        #: 用户自己打进去的字不该被"这句话里有'可能'"这种启发式拦下来。
        self.created_by: str = created_by or "agent"
        #: 敏感度由闸门贴，不由调用方声明。
        self.sensitivity: str = "public"
        #: 想以什么状态落盘。空 = 交给库的默认（active）。Dream 会用
        #: ``candidate``：一份提案在被批准之前不该进召回。
        self.status: str = ""
        #: 0016：如果这一条被批准，这几条会被归档。非空 = 它是一份合并提案。
        self.supersedes: List[str] = []



    def add_tag(self, tag: str) -> None:
        """Add a tag if not already present."""
        if tag not in self.tags:
            self.tags.append(tag)

    def to_dict(self) -> dict:
        """Serialize to dictionary for storage."""
        return {
            "id": self.id,
            "content": self.content,
            "type": self.type,
            "importance": self.importance,
            "scope": self.scope,
            "root_dir": self.root_dir,
            "session_id": self.session_id,
            "tags": self.tags,
            "tier": self.tier,
            "hits": self.hits,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "accessed_at": self.accessed_at,
            "archived": self.archived,
        }

    @staticmethod
    def from_dict(d: dict) -> "Memory":
        """Deserialize from storage dict."""
        m = Memory(
            content=d.get("content", ""),
            mem_type=d.get("type", MemoryType.FACT),
            importance=d.get("importance", 0.5),
            scope=d.get("scope", MemoryScope.PROJECT),
            root_dir=d.get("root_dir", ""),
            session_id=d.get("session_id", ""),
            tags=d.get("tags", []),
            # Rows written before C1 carry no tier; normalize_tier lands them in
            # SEMANTIC, which is exactly what the old flat table behaved like.
            tier=normalize_tier(d.get("tier")).value,
        )
        m.id = d.get("id", str(uuid.uuid4()))
        m.created_at = d.get("created_at", time.time())
        m.updated_at = d.get("updated_at", time.time())
        m.accessed_at = d.get("accessed_at", 0.0)
        m.archived = bool(d.get("archived", 0))
        m.hits = int(d.get("hits", 0) or 0)
        return m


# ---------------------------------------------------------------------------
# DebouncedExtractor -- 60s debounce -> LLM refine -> AGENTS.md
# ---------------------------------------------------------------------------

class DebouncedExtractor:
    """Watch tool_result for Write/Edit, debounce 60s, then extract memories.

    Same file multiple writes within the window -> reset timer.
    Timer expires -> read file -> LLM refine -> write to AGENTS.md + memory_entries.
    """

    DEBOUNCE_SECONDS: float = 60.0

    #: Files the memory layer itself writes. Extracting from these would create a
    #: self-excitation loop: write AGENTS.md -> tool_result -> 60s -> write
    #: AGENTS.md -> ... Never schedule extraction for them.
    SELF_WRITTEN_BASENAMES: frozenset = frozenset({"agents.md", "claude.md"})

    def __init__(self, memory_layer: "MemoryLayer", llm_callback: Optional[Callable] = None) -> None:
        self._layer = memory_layer
        self._llm = llm_callback
        self._timers: dict[str, asyncio.Task] = {}
        self._pending_files: set[str] = set()

    async def on_tool_result(self, event: Any) -> None:
        """EventBus subscriber for 'tool_result' events.

        Args:
            event: EventBus Event with payload containing tool_name and args.
        """
        payload = event.payload or {}
        tool_name = payload.get("tool_name", "")
        if tool_name not in ("write_file", "edit_file", "Write", "Edit"):
            return
        # Only extract from writes that actually succeeded.
        result = payload.get("result") or {}
        if isinstance(result, dict) and result.get("ok") is False:
            return
        args = payload.get("args") or {}
        file_path = args.get("path") or (result.get("path", "") if isinstance(result, dict) else "")
        if not file_path:
            return
        if self._is_self_written(file_path):
            return

        context = payload.get("context") or {}
        scope = {
            "session_id": payload.get("session_id") or context.get("session_id") or "",
            "branch_id": payload.get("branch_id") or context.get("branch_id") or "",
            "turn_id": payload.get("turn_id") or context.get("turn_id") or "",
            "episode_id": payload.get("episode_id") or context.get("episode_id") or "",
            "goal_id": payload.get("goal_id") or context.get("goal_id") or "",
            "run_id": payload.get("run_id") or context.get("run_id") or "",
        }
        await self._schedule_extraction(file_path, scope=scope)

    def _is_self_written(self, file_path: str) -> bool:
        """Whether this path is a memory-layer output (loop guard)."""
        return os.path.basename(file_path).lower() in self.SELF_WRITTEN_BASENAMES

    async def _schedule_extraction(self, file_path: str, scope: Optional[dict] = None) -> None:
        """Schedule or reset debounced extraction for a file."""
        old = self._timers.pop(file_path, None)
        if old and not old.done():
            old.cancel()
        self._pending_files.add(file_path)
        self._timers[file_path] = asyncio.create_task(self._debounced_extract(file_path, scope=scope))

    async def _debounced_extract(self, file_path: str, scope: Optional[dict] = None) -> None:
        """Wait for debounce window, then trigger extraction."""
        try:
            await asyncio.sleep(self.DEBOUNCE_SECONDS)
        except asyncio.CancelledError:
            return
        self._pending_files.discard(file_path)
        self._timers.pop(file_path, None)
        await self._layer.extract_from_file(file_path, scope=scope)

    @property
    def pending_files(self) -> set[str]:
        """Return a copy of files pending extraction."""
        return set(self._pending_files)


# ---------------------------------------------------------------------------
# DreamConsolidator -- idle background analysis
# ---------------------------------------------------------------------------

class DreamConsolidator:
    """空闲（>5 分钟）时整合最近的记忆。

    读最近 24h 的 memory_entries → 模型分析 → **提议**合并 / 提炼更高层的理解 →
    落一条 candidate 提案，等用户裁决。它不会自己归档任何既有记忆（§10.2），整趟
    跑在一个带租约和预算的 job 里（§10.3）。
    """


    IDLE_THRESHOLD_SECONDS: int = 300
    CHECK_INTERVAL_SECONDS: int = 300
    LOOKBACK_SECONDS: int = 86400
    #: §10.3 预算。一趟整合最多占这么久的墙上时间；超时按 failed 收尾并写进日记，
    #: 而不是让一个卡住的 LLM 调用永远拿着租约。
    MAX_WALL_SECONDS: int = 120
    #: 喂给模型的输入上限（估算 token）。上限的意义不只是省钱：一次塞 50 条记忆
    #: 进去，模型会开始在无关的事实之间编造联系。
    MAX_INPUT_TOKENS: int = 4000
    #: 续租间隔。必须显著小于租约时长，否则一次 GC 停顿就能让自己的租约过期。
    HEARTBEAT_SECONDS: int = 30


    def __init__(self, memory_layer: "MemoryLayer", llm_callback: Optional[Callable] = None) -> None:
        self._layer = memory_layer
        self._llm = llm_callback
        self._last_interaction: float = time.time()
        self._task: Optional[asyncio.Task] = None
        self._running: bool = False

    def touch(self) -> None:
        """Call on any user interaction to reset idle timer."""
        self._last_interaction = time.time()

    async def start(self) -> None:
        """Start the background dream loop."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._dream_loop())

    async def stop(self) -> None:
        """Stop the background loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass  # fail-open: 取消语义即静默，正确

    async def _dream_loop(self) -> None:
        """Periodically check if system is idle enough to dream."""
        while self._running:
            await asyncio.sleep(self.CHECK_INTERVAL_SECONDS)
            if (time.time() - self._last_interaction) < self.IDLE_THRESHOLD_SECONDS:
                continue
            await self._layer.dream_consolidate()

    @property
    def is_idle(self) -> bool:
        """Whether the system has been idle long enough to dream."""
        return (time.time() - self._last_interaction) >= self.IDLE_THRESHOLD_SECONDS


# ---------------------------------------------------------------------------
# MemoryLayer -- main facade
# ---------------------------------------------------------------------------

class MemoryLayer:
    """Memory management: extract, dream, recall, prefetch, synthesize.

    All operations are event-driven. Mount on EventBus via ``mount(bus)``.
    """

    _EXTRACT_PATTERNS: dict = {
        MemoryType.PREFERENCE: [
            r"I like (.+)", r"I prefer (.+)", r"I don't like (.+)",
            r"Please (.+)", r"Never (.+)", r"我喜欢(.+)", r"我偏好(.+)",
        ],
        MemoryType.FACT: [
            r"My name is (.+)", r"I work at (.+)", r"I use (.+)",
            r"Remember that (.+)", r"我叫(.+)", r"我在(.+)工作",
        ],
    }

    _STOP_WORDS: frozenset = frozenset({
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "have", "has", "had", "do", "does", "did", "will", "would",
        "could", "should", "may", "might", "must", "can", "to", "of",
        "in", "for", "on", "with", "at", "by", "from", "as", "and",
        "but", "or", "not", "so", "than", "too", "very", "just",
    })

    def __init__(
        self,
        llm_callback: Optional[Callable] = None,
        embed_callback: Optional[Callable] = None,
        storage: Optional[Any] = None,
        root_dir: str = "",
    ) -> None:
        """Initialize the memory layer."""
        self.storage = storage or get_storage()
        self.telemetry = get_telemetry()
        self._llm = llm_callback
        self._embed = embed_callback
        self._root_dir = root_dir
        self._extractor = DebouncedExtractor(self, llm_callback)
        self._dreamer = DreamConsolidator(self, llm_callback)

        #: Master switch, seeded from config.json's `memory.enabled`. The key was
        #: written by the settings page for a long time while nothing read it —
        #: the toggle was a placebo. When off: no extraction, no session
        #: synthesis, no recall injection, no dream consolidation. Manual CRUD
        #: from the memory settings page still works (curating an off store is
        #: legitimate; "off" means the agent stops consulting it, not amnesia).
        self.enabled: bool = True
        try:
            _cfg_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
            with open(_cfg_path, "r", encoding="utf-8") as _f:
                _val = (json.load(_f).get("memory") or {}).get("enabled")
            if _val is not None:
                self.enabled = bool(_val)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        self._bus = None
        #: Workspace root + session scope. Empty string is the default
        #: workspace, the same key the sessions table uses — not a missing value.
        self._root_dir: str = os.getcwd()
        #: The instance that OWNS the shared machinery. For a normally
        #: constructed layer that is itself; for a :meth:`for_root` view it is
        #: the layer the view was derived from. Lazy singletons (``_active``,
        #: ``_wiki``) and configuration writes are routed here so N per-workspace
        #: views cannot spawn N ActiveMemory worker threads or leave one view
        #: holding an embedder the others don't have.
        self._origin: "MemoryLayer" = self
        #: WORKING tier (C1): current-turn scratch, in-process only. Deliberately
        #: not persisted. Bucketed by ``(root, session)`` and held on the ORIGIN.
        self._working_buckets: dict[tuple, List[Memory]] = {}
        #: Which session this handle speaks for, used as the second half of the
        #: working-tier key. Empty means "not session-scoped".
        self._session_scope: str = ""
        #: Recall re-ranking toggles. Instance flags so a caller can turn either
        #: off and see the unweighted ordering.
        self.decay_enabled: bool = True
        self.mmr_enabled: bool = True
        #: C3 Active Memory facade. Built lazily so constructing a MemoryLayer
        #: never spawns a worker thread.
        self._active = None
        #: C4 WikiStore, also lazy — it runs DDL on construction.
        self._wiki = None

    @property
    def memory_enabled(self) -> bool:
        """The master switch, always read through the ORIGIN.

        ``for_root`` views copy the instance dict, so a plain ``self.enabled``
        on a view freezes the value at view-creation time and a later toggle
        never reaches existing routers. Routing through ``_origin`` makes the
        hot-applied flag visible everywhere at once.
        """
        try:
            return self._origin.enabled
        except AttributeError:
            return self.enabled

    async def set_enabled(self, enabled: bool) -> None:
        """Hot-apply the master switch (settings page).

        Off also stops the dream consolidator and pending debounced
        extractions; back on restarts the dreamer when a loop is running.
        """
        target = getattr(self, "_origin", self)
        target.enabled = bool(enabled)
        if not enabled:
            await target.stop_background()
        else:
            try:
                asyncio.get_running_loop()
                await target.start_background()
            except RuntimeError:
                pass  # no loop here; the next router construction starts it

    @property
    def memory_enabled(self) -> bool:
        """The master switch, always read through the ORIGIN.

        ``for_root`` views copy the instance dict, so a plain ``self.enabled``
        on a view freezes the value at view-creation time and a later toggle
        never reaches existing routers. Routing through ``_origin`` makes the
        hot-applied flag visible everywhere at once.
        """
        try:
            return self._origin.enabled
        except AttributeError:
            return self.enabled

    @property
    def _working_key(self) -> tuple:
        """Which working-tier bucket this handle owns."""
        return (self._root_dir, self._session_scope)

    @property
    def _working(self) -> List[Memory]:
        """This handle's slice of the WORKING tier.

        Reads through ``_origin`` so every view of the same (root, session) sees
        one list, while two different scopes can never see each other's notes.
        """
        buckets = self._origin._working_buckets
        key = self._working_key
        bucket = buckets.get(key)
        if bucket is None:
            bucket = []
            buckets[key] = bucket
            # A desktop process can accumulate scopes for as long as it runs
            # (every folder switch mints a new key). Evict the oldest inserted
            # bucket rather than let the dict grow for the process lifetime;
            # WORKING is turn-scoped scratch, so losing the least recently
            # created bucket costs nothing anyone can observe.
            while len(buckets) > MAX_WORKING_BUCKETS:
                buckets.pop(next(iter(buckets)))
        return bucket

    @_working.setter
    def _working(self, value: List[Memory]) -> None:
        self._origin._working_buckets[self._working_key] = list(value)


    @property
    def active(self):
        """C3: the resilient recall facade (TTL cache + breaker + timeout).

        Prefer this over calling ``prefetch`` directly from the prompt-assembly
        path: ``prefetch`` has no latency ceiling and returns unlabeled text,
        which on the hot path means a stalled turn and an injection surface.

        Built on ``_origin`` so every per-workspace view shares one instance.
        ActiveMemory owns a worker thread and a cache keyed BY root, so one
        instance serves all roots correctly while N instances would only burn
        threads.
        """
        origin = self._origin
        if origin._active is None:
            from active_memory import build_active_memory
            origin._active = build_active_memory(origin)
        return origin._active

    def active_recall(
        self,
        query: str,
        limit: int = 5,
        session_id: str = "",
        branch_id: str = "",
    ) -> tuple:
        """Cached, breaker-guarded, untrusted-labeled recall for prompt assembly.

        Returns ``(wrapped_xml, meta)`` — see ``active_memory.ActiveMemory``.
        """
        return self.active.recall(
            self._root_dir,
            query,
            limit=limit,
            session_id=session_id,
            branch_id=branch_id,
        )

    def _invalidate_active(self) -> None:
        """Drop cached recalls for this workspace after a write so the next turn sees new memories.

        Without this, a memory stored mid-conversation would be invisible for up
        to the cache TTL — the single most confusing possible failure mode
        ("I just told it that and it doesn't know").
        """
        if self._origin._active is not None:
            try:
                self._origin._active.invalidate(self._root_dir)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

    def set_embed_callback(self, embed_callback: Optional[Callable]) -> None:
        """Install or replace the embedding function used for semantic recall.

        Written to ``_origin`` as well as to this instance: the embedder is
        global configuration, not per-workspace state, and the background
        extractor/dreamer hold a reference to the origin. Without the
        write-through, a view installing the embedder would leave every other
        view — and all background work — on keyword-only recall.
        """
        self._embed = embed_callback
        if self._origin is not self:
            self._origin._embed = embed_callback

    @property
    def has_embeddings(self) -> bool:
        """Whether semantic (vector) recall is available."""
        return self._embed is not None

    def retrieval_channels(self) -> dict:
        """What hybrid retrieval will actually do in this workspace, right now.

        Answers the question the diagnostics panel could not: the 0.7 vector
        weight is a design constant, but if nothing in this workspace carries an
        embedding the dense channel contributes nothing and fusion silently runs
        pure lexical. ``vectorUsable`` / ``coverage`` say which of those is true.
        """
        stats = {"rows": 0, "embedded": 0, "coverage": 0.0, "vectorUsable": False}
        try:
            stats = self.storage.memory_embedding_stats(self._root_dir)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        try:
            from memory_retrieval import VECTOR_WEIGHT, KEYWORD_WEIGHT
        except Exception:
            VECTOR_WEIGHT, KEYWORD_WEIGHT = 0.7, 0.3
        usable = bool(stats.get("vectorUsable")) and self.has_embeddings
        return {
            **stats,
            "root": self._root_dir,
            # No embedder wired means queries can't be embedded either, so the
            # channel is dead even if every stored row has a vector.
            "embedderWired": self.has_embeddings,
            "vectorUsable": usable,
            "mode": "hybrid" if usable else "keyword_only",
            "nominalVectorWeight": VECTOR_WEIGHT,
            "nominalKeywordWeight": KEYWORD_WEIGHT,
            "effectiveVectorWeight": VECTOR_WEIGHT if usable else 0.0,
            "effectiveKeywordWeight": KEYWORD_WEIGHT if usable else 1.0,
            "degraded": not usable,
            "pendingEmbeddings": max(
                0, int(stats.get("rows", 0)) - int(stats.get("embedded", 0))
            ),
        }

    def backfill_embeddings(self, limit: int = 200) -> dict:
        """Compute and store vectors for rows that never got one.

        Existing memories were written before an embedder was wired (or while one
        was unavailable), so the dense channel had nothing to score even though
        recall claimed to be hybrid. This is the catch-up pass: bounded per call
        so the caller controls the cost, and idempotent — a row that already has a
        vector is never revisited.

        Returns ``{processed, embedded, failed, remaining}``.
        """
        out = {"processed": 0, "embedded": 0, "failed": 0, "remaining": 0}
        if not self.has_embeddings:
            # Nothing to do and nothing to report as failure: without an embedder
            # a backfill is not "broken", it is not applicable.
            out["remaining"] = int(
                self.retrieval_channels().get("pendingEmbeddings", 0)
            )
            return out
        try:
            todo = self.storage.memories_missing_embeddings(
                self._root_dir, limit=max(1, int(limit))
            )
        except Exception:
            return out
        for row in todo:
            out["processed"] += 1
            vec = self._embed_text(row.get("content") or "")
            if not vec:
                out["failed"] += 1
                continue
            blob = json.dumps(vec).encode("utf-8")
            if self.storage.set_memory_embedding(row.get("id"), blob):
                out["embedded"] += 1
            else:
                out["failed"] += 1
        if out["embedded"]:
            # Recall results cached before the vectors existed are now wrong in
            # the only way that matters: they were ranked without the dense
            # channel.
            self._invalidate_active()
        out["remaining"] = int(
            self.retrieval_channels().get("pendingEmbeddings", 0)
        )
        return out


    def _embed_text(self, text: str) -> Optional[list]:
        """Compute an embedding, returning None on any failure.

        Three things happen here beyond calling the provider:

        1. **Cache read.** The same text gets embedded over and over — every
           prompt prefetch re-embeds the query, every dream pass re-embeds
           unchanged memories. Local BGE costs ~15-40ms per sentence; a remote
           provider costs money. Keyed by (provider, model, sha256(text)) so a
           model swap can never serve a vector from a different space.
        2. **L2 normalize.** Guarantees unit length regardless of provider, so
           cosine similarity downstream is a plain dot product.
        3. **Cache write.** Best-effort; a failing cache must never break
           recall, so every storage call is individually guarded.

        Embedding itself is best-effort too: a failing provider degrades recall
        to keyword scoring, it never breaks the turn.
        """
        if not self._embed or not text:
            return None
        provider, model = self._embed_identity()
        try:
            cached = self.storage.get_cached_embedding(provider, model, text)
        except Exception:
            cached = None
        if cached:
            return _l2_normalize(cached)
        try:
            vec = self._embed(text)
        except Exception:
            return None
        if isinstance(vec, (list, tuple)) and vec and all(
            isinstance(x, (int, float)) for x in vec
        ):
            normalized = _l2_normalize([float(x) for x in vec])
            try:
                self.storage.save_cached_embedding(provider, model, text, normalized)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            return normalized
        return None

    def _embed_identity(self) -> tuple:
        """(provider, model) label for the active embedding function.

        The cache key MUST change when the vector space changes. Asking the
        embedder directly keeps that automatic; if the callback isn't our
        embedder we fall back to a generic label, which is still correct as
        long as the caller doesn't hot-swap providers behind the same callback.
        """
        try:
            from embedder import get_embedder
            emb = get_embedder()
            return (emb.backend or "pending", emb.model_name)
        except Exception:
            return ("custom", "unknown")

    # ------------------------------------------------------------------
    # Event bus mounting
    # ------------------------------------------------------------------

    def mount(self, bus: Any) -> None:
        """Subscribe to events on the bus.

        Args:
            bus: EventBus instance.
        """
        self._bus = bus
        bus.on("tool_result", self._extractor.on_tool_result, priority=0)
        bus.on("user_prompt_submit", self._on_user_prompt, priority=10)

    def for_root(self, root: str, session_id: str = "") -> "MemoryLayer":
        """A handle on this layer scoped to one workspace (and optionally session).

        The layer is a process singleton but the app has many workspaces open at
        once, so a mutable "current root" was a race: whichever window last set
        it decided what every other window's recall read, which memories got
        written, and whose ``AGENTS.md`` got rewritten. There is deliberately no
        setter any more — a caller that wants a scope asks for a handle.

        Args:
            root: Workspace to scope to. ``""`` is the default workspace, the
                same key the sessions table uses — not a missing value.
            session_id: Owner of the WORKING tier bucket. Omit for callers that
                aren't a conversation (REST handlers, background jobs); they get
                their own bucket rather than borrowing someone's turn scratch.

        The handle shares everything expensive and stateful with its origin
        (storage, embedder, the ActiveMemory worker + cache, the WikiStore, the
        background extractor/dreamer). Only the scope differs. It is NOT a deep
        copy: lazy singletons and the working-tier bucket map are reached through
        ``_origin``, so a handle can never fork them. Construction is cheap — no
        DDL, no threads — because ``__init__`` defers all of that.
        """
        view = object.__new__(MemoryLayer)
        # Copy the instance dict wholesale so the view starts identical, then
        # override only what makes it a distinct scope. Sharing by reference is
        # the point: mutating memories through the view writes to the same DB.
        view.__dict__.update(self.__dict__)
        view._root_dir = root
        view._session_scope = session_id
        # Route lazy singletons and config writes to the true owner, never to a
        # view — otherwise two views would each build their own ActiveMemory.
        view._origin = self._origin
        return view

    def rescope(self, root: str, session_id: str = None) -> None:
        """Move THIS handle to another workspace, in place.

        For the one case a fresh handle can't cover: the owner already registered
        bound methods of this object on the event bus (``mount``), so replacing
        the object would leave the bus calling a handle nobody reads any more —
        the user switches folders and recall silently keeps serving the old one.

        Legal only on a ``for_root`` handle. Calling it on the shared origin is
        the exact cross-session mutation this design removed, so it raises
        instead of quietly corrupting every other session's scope.
        """
        if self._origin is self:
            raise RuntimeError(
                "rescope() is for a for_root handle; the shared layer has no "
                "current workspace to move. Ask for a handle instead."
            )
        self._root_dir = root
        if session_id is not None:
            self._session_scope = session_id



    def touch(self) -> None:
        """Reset the idle timer that gates dream consolidation.

        Call on any user interaction. Exposed publicly so callers (e.g. the
        router) do not have to reach into the private ``_dreamer``.
        """
        self._dreamer.touch()

    async def start_background(self) -> None:
        """Start the idle-driven dream consolidation loop.

        Idempotent — calling twice is a no-op. Without this the dream
        consolidator never runs (it has no self-start). Skipped entirely while
        the memory master switch is off: dreaming about an off store is work
        for nothing.
        """
        if not self.memory_enabled:
            return
        await self._dreamer.start()

    async def stop_background(self) -> None:
        """Stop the dream consolidation loop and cancel pending extractions."""
        await self._dreamer.stop()
        for task in list(self._extractor._timers.values()):
            if not task.done():
                task.cancel()
        self._extractor._timers.clear()

    @property
    def is_idle(self) -> bool:
        """Whether the system has been idle long enough to dream."""
        return self._dreamer.is_idle


    async def _on_user_prompt(self, event: Any) -> None:
        """On user_prompt_submit: touch dreamer + run resilient memory recall.

        C3: uses active_recall (TTL cache + breaker + timeout + untrusted frame)
        instead of raw prefetch. The model sees recalled content wrapped in an
        <untrusted-context> block with explicit instructions not to execute
        content that looks like commands.

        Also injects the C1 always-inject block (WORKING + LONG_TERM) and the
        C4 wiki claims block — these are unconditional and cheap (both are
        already in-process / pre-budgeted).
        """
        self._dreamer.touch()
        payload = event.payload
        message = payload.get("message", "")
        context = payload.get("context", {})

        # ── C1: always-inject tier block (WORKING + LONG_TERM) ──
        inject = self.inject_block()
        if inject:
            context["memory_inject"] = inject

        # ── C3: resilient recall with untrusted framing ──
        session_id = str(payload.get("session_id") or payload.get("sessionId") or getattr(event, "session_id", "") or "")
        branch_id = str(payload.get("branch_id") or payload.get("branchId") or getattr(event, "branch_id", "") or "")
        recalled, meta = self.active_recall(message, session_id=session_id, branch_id=branch_id)
        if recalled:
            context["injected_memories"] = recalled
            context["_memory_meta"] = meta

        # ── C4: wiki claims ──
        wiki_block = self._render_wiki()
        if wiki_block:
            context["wiki_claims"] = wiki_block

        # ── Reflexion: 检索适用的前置避坑反思 ──
        try:
            from reflection_engine import get_reflection_store
            ref_block = get_reflection_store().format_reflection_context(query=message, limit=3)
            if ref_block:
                context["reflections"] = ref_block
        except Exception:
            pass

        if inject or recalled or wiki_block or context.get("reflections"):
            event.modify({**payload, "context": context})

    def _render_wiki(self) -> str:
        """C4: render wiki claims for prompt injection. Lazy-loads WikiStore."""
        try:
            return self.wiki.render_block(self._root_dir)
        except Exception:
            return ""

    @property
    def wiki(self):
        """C4 declarative-knowledge store (claims / confidence / contradictions).

        Shared via ``_origin``: WikiStore runs DDL on construction and takes the
        root per call, so one instance is both cheaper and correct.
        """
        origin = self._origin
        if origin._wiki is None:
            from wiki_store import WikiStore
            origin._wiki = WikiStore(origin.storage)
        return origin._wiki

    # ------------------------------------------------------------------
    # 1. Debounced extraction
    # ------------------------------------------------------------------

    def extract(self, text: str, context: str = "") -> List[Memory]:
        """Extract facts/preferences from conversation text (regex fallback).

        Args:
            text: Input text to extract from.
            context: Optional context string.

        Returns:
            List of extracted Memory objects.
        """
        if not self.memory_enabled:
            return []
        span = self.telemetry.start_span(SpanName.MEMORY_EXTRACT)
        try:
            memories: List[Memory] = []
            for mem_type, pats in self._EXTRACT_PATTERNS.items():
                for pat in pats:
                    for match in re.finditer(pat, text, re.IGNORECASE):
                        mem = Memory(
                            content=match.group(0),
                            mem_type=mem_type,
                            importance=0.7,
                            root_dir=self._root_dir,
                            session_id=str(context or ""),
                            scope=MemoryScope.SESSION if context else MemoryScope.PROJECT,
                        )
                        mem.add_tag("extracted")
                        memories.append(mem)
            return memories
        finally:
            self.telemetry.end_span(span)

    async def extract_from_file(self, file_path: str, scope: Optional[dict] = None) -> None:
        """Read a file and extract memories from its content (debounced trigger).

        Args:
            file_path: Path to the file to extract memories from.
            scope: Optional structured ScopeContext dictionary.
        """
        span = self.telemetry.start_span(SpanName.MEMORY_EXTRACT, file=file_path)
        try:
            try:
                with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()[:50000]
            except (IOError, OSError) as e:
                self.telemetry.end_span(span, error=str(e))
                return

            if self._llm:
                try:
                    prompt = self._build_extraction_prompt(file_path, content)
                    if asyncio.iscoroutinefunction(self._llm):
                        result = await self._llm(prompt)
                    else:
                        result = self._llm(prompt)
                    extracted = self._parse_llm_extraction(result, file_path)
                except Exception:
                    extracted = []
                if not extracted:
                    # Model returned prose / nothing usable — keep the regex
                    # pass so a wired LLM is never worse than no LLM.
                    extracted = self.extract(content)
                    for m in extracted:
                        m.root_dir = self._root_dir
            else:
                extracted = self.extract(content)
                for m in extracted:
                    m.root_dir = self._root_dir

            for mem in extracted:
                self.store(mem)

            # 补强（Step C & P0-4）：抽取结果发射成 memory.extracted 事件，带完整 6 维结构化溯源与 event_id
            if extracted:
                try:
                    import uuid
                    scope = scope or {}
                    sid = (
                        scope.get("session_id")
                        or getattr(self, "_session_id", "")
                        or getattr(self, "session_id", "")
                        or f"workspace:{self._root_dir}"
                    )
                    bid = scope.get("branch_id") or getattr(self, "_branch_id", "") or getattr(self, "branch_id", "") or ""
                    tid = scope.get("turn_id") or getattr(self, "_turn_id", "") or getattr(self, "turn_id", "") or ""
                    eid = scope.get("episode_id") or getattr(self, "_episode_id", "") or getattr(self, "episode_id", "") or ""
                    gid = scope.get("goal_id") or getattr(self, "_goal_id", "") or getattr(self, "goal_id", "") or ""
                    rid = scope.get("run_id") or getattr(self, "_run_id", "") or getattr(self, "run_id", "") or ""
                    event_id = f"mem_ext_{uuid.uuid4().hex[:12]}"
                    self.storage.trace_event(
                        session_id=sid,
                        event_type="memory.extracted",
                        payload={
                            "event_id": event_id,
                            "file": file_path,
                            "count": len(extracted),
                            "facts": [str(m.content)[:200] for m in extracted],
                            "session_id": sid,
                            "branch_id": bid,
                            "turn_id": tid,
                            "episode_id": eid,
                            "goal_id": gid,
                            "run_id": rid,
                            "workspace_root": self._root_dir,
                            "source_event_ids": [event_id],
                        },
                        importance="observational",
                        branch_id=bid or None,
                        turn_id=tid or None,
                        goal_id=gid or None,
                    )
                except Exception as e:
                    print(f"[memory] extracted-event mirror failed: {e}")


            if extracted:
                self._update_agents_md(extracted)

            self.telemetry.end_span(span, extracted_count=len(extracted))
        except Exception as e:
            self.telemetry.end_span(span, error=str(e))

    def _build_extraction_prompt(self, file_path: str, content: str) -> dict:
        """Craft the extraction instruction handed to the LLM callback.

        The regex-only extractor was hand-tuned for chat turns; this prompt
        adapts the same shape (facts / preferences / context / procedures) for
        arbitrary edited files. It asks explicitly for JSON so
        ``_parse_llm_extraction`` gets what it expects.

        Args:
            file_path: The file that triggered extraction (for scoping).
            content: File body (already length-capped by the caller).

        Returns:
            A dict prompt suitable for ``llm_client.call``.
        """
        return {
            "task": "memory_extraction",
            "instruction": (
                "You are updating a project's long-term memory (AGENTS.md).\n"
                "Extract ONLY high-value, reusable project knowledge, architecture conventions, and developer preferences.\n"
                "Language requirement: Output MUST be in Simplified Chinese (简体中文) unless referencing exact code identifiers.\n"
                "Path requirement: NEVER use local absolute paths like C:\\Users\\... — ALWAYS use relative workspace paths (e.g. `output/`).\n"
                "Return ONLY a JSON object, no prose, no code fences:\n"
                '{"facts": ["..."], "preferences": ["..."], '
                '"context": ["..."], "procedures": ["..."]}\n'
                "Rules:\n"
                "- Skip boilerplate (imports, license headers, trivial file I/O).\n"
                "- Skip anything that looks like a secret or API key.\n"
                "- Each item must be a single, clear, human-readable sentence in Chinese.\n"
                "- Empty arrays are fine — don't invent memories."
            ),
            "file": os.path.basename(file_path),
            "content": content,
        }

    def _parse_llm_extraction(self, result: Any, file_path: str) -> List[Memory]:
        """Parse LLM extraction result into Memory objects.

        Args:
            result: Dict with keys like 'facts', 'preferences', 'context'.
            file_path: Source file path for tagging.

        Returns:
            List of parsed Memory objects.
        """
        memories: List[Memory] = []
        if not isinstance(result, dict):
            return memories
        type_map = [
            ("facts", MemoryType.FACT),
            ("preferences", MemoryType.PREFERENCE),
            ("context", MemoryType.CONTEXT),
            ("procedures", MemoryType.PROCEDURE),
        ]
        for key, mem_type in type_map:
            for item in result.get(key, []):
                if isinstance(item, str):
                    mem = Memory(
                        content=item,
                        mem_type=mem_type,
                        importance=result.get("importance", {}).get(item, 0.6),
                        root_dir=self._root_dir,
                    )
                    mem.add_tag("llm_extracted")
                    mem.add_tag(os.path.basename(file_path))
                    memories.append(mem)
        return memories

    _CONTEXT_HEADING: str = "## Project Context"

    def _update_agents_md(self, memories: List[Memory]) -> None:
        """Turn extracted memories into **pending proposals**, never a direct write.

        P0-4 fix. What this used to do: open ``AGENTS.md`` with a bare
        ``open(..., "w")`` and rewrite it, automatically, with no approval and
        with this extractor enabled by default. Three things made that the most
        dangerous write in the codebase:

        * ``AGENTS.md`` is injected into **every single turn**. A line landing
          there is not a note — it is a standing instruction to the model.
        * The content came from an LLM reading whatever file the user just
          edited. Editing a file that contains adversarial text was enough to
          get that text into the system prompt, permanently. That is prompt
          injection with persistence, reachable without the user doing anything
          unusual.
        * It was invisible. No card, no diff, no undo — the file simply changed.

        Meanwhile the project already had exactly one legitimate gated path to
        the guidance files (propose → user accepts → ``atomic_write``). This
        path existed *next to* it and bypassed it. The fix is not to make the
        write safer; it is to delete the second write path.

        So: the same lines are still derived, still deduped against what is
        already on disk, and the memories themselves are still stored in the DB
        and still recalled — but reaching ``AGENTS.md`` now requires a human
        clicking accept. If the evolution subsystem is off there is no queue to
        put them in, and the honest outcome is that nothing is proposed and a
        line is logged saying so. Silently writing anyway is what got us here.

        Args:
            memories: Newly extracted Memory objects to propose.
        """
        if not memories:
            return
        agents_md_path = os.path.join(self._root_dir, "AGENTS.md")
        new_lines = [f"- [{m.type}] {m.content}" for m in memories]

        existing = ""
        try:
            if os.path.exists(agents_md_path):
                with open(agents_md_path, "r", encoding="utf-8") as f:
                    existing = f.read()
        except OSError:
            existing = ""

        _head, old_lines, _tail = self._split_context_section(existing)
        on_disk = {ln.strip() for ln in existing.splitlines() if ln.strip()}
        on_disk.update(ln.strip() for ln in old_lines)
        fresh = [ln for ln in new_lines if ln.strip() not in on_disk]

        # DB-only bookkeeping: what the extractor believes the project context
        # is. This never touched the filesystem and needs no approval, so it
        # stays — losing it would blind the memory index for no safety gain.
        section = (
            f"{self._CONTEXT_HEADING}\n"
            f"<!-- proposed by memory layer; "
            f"last extraction {time.strftime('%Y-%m-%d %H:%M')} -->\n"
            + "\n".join(old_lines + fresh)
        )
        try:
            self.storage.update_memory_index(self._root_dir, section)
        except Exception as exc:  # noqa: BLE001
            print(f"[memory] memory index update failed: {exc}")

        if not fresh:
            return
        self._queue_context_proposals(fresh)

    def _queue_context_proposals(self, lines: List[str]) -> int:
        """Put extracted context lines in the evolution approval queue.

        Returns the number of proposals actually created. Import is local and
        failure is logged rather than raised: memory extraction is a background
        best-effort path, and an unavailable optional subsystem must not take a
        user's turn down with it. What it must NOT do is fall back to writing.
        """
        try:
            from evolution import (Proposal, get_evolution_engine,
                                   signature_for, MODE_POLICIES)
        except Exception as exc:  # noqa: BLE001
            print(f"[memory] cannot propose context lines (evolution unavailable): {exc}")
            return 0

        engine = get_evolution_engine(self._root_dir)
        if not engine.enabled():
            print(f"[memory] {len(lines)} extracted context line(s) NOT written to "
                  f"AGENTS.md: evolution is off, so there is no approval queue. "
                  f"They remain in memory storage and are still recalled.")
            return 0

        policy = MODE_POLICIES.get(engine.mode)
        if policy is None:
            return 0
        made = 0
        for line in lines[:self.MAX_CONTEXT_PROPOSALS]:
            if engine.store.count_open() >= policy.max_open:
                break
            sig = signature_for("extracted_context", "", line)
            if engine.store.has_open_for_signature(sig):
                continue
            last_rej = engine.store.last_rejected_at(sig)
            if last_rej and (time.time() - last_rej) < policy.reject_cooldown_s:
                continue
            clean_line = re.sub(r"^\[(?:fact|preference|context|procedure)\]\s*", "", line, flags=re.IGNORECASE).strip()
            # 路径相对化与清洗
            clean_line = re.sub(r'[A-Za-z]:\\[^\\s\']+[\\/]([A-Za-z0-9_\-]+)[\\/]?', r'\1/', clean_line)
            clean_line = re.sub(r'\/[^\s\']+\/([A-Za-z0-9_\-]+)\/?', r'\1/', clean_line)
            clean_draft = f"- {clean_line}" if not clean_line.startswith("-") else clean_line
            engine.store.insert_proposal(Proposal(
                id=uuid.uuid4().hex[:12],
                signature=sig,
                kind="extracted_context",
                tool_name="",
                target_file="AGENTS.md",
                draft=clean_draft,
                rationale="从您最近编辑的文件中提炼的项目常识 · 采纳后将写入项目规范并持续生效",
                hits=1,
                status="pending",
                created_at=time.time(),
            ))
            made += 1

        return made

    #: Cap on how many context lines one extraction may queue. Same reasoning as
    #: evolution.MAX_FACT_PROPOSALS: a queue nobody can clear gets bulk-rejected,
    #: which is functionally identical to the feature not existing.
    MAX_CONTEXT_PROPOSALS: int = 5


    def _split_context_section(self, text: str) -> tuple[str, List[str], str]:
        """Split AGENTS.md into (before, existing bullet lines, after).

        Args:
            text: Full AGENTS.md content (may be empty).

        Returns:
            Tuple of text before the section, the section's bullet lines,
            and text after the section.
        """
        if self._CONTEXT_HEADING not in text:
            return text, [], ""
        idx = text.index(self._CONTEXT_HEADING)
        head = text[:idx]
        rest = text[idx + len(self._CONTEXT_HEADING):]
        next_section = rest.find("\n## ")
        body = rest if next_section == -1 else rest[:next_section]
        tail = "" if next_section == -1 else rest[next_section:]
        lines = [
            ln.strip() for ln in body.splitlines()
            if ln.strip().startswith("- ")
        ]
        return head, lines, tail

    def _legacy_update_agents_md(self, memories: List[Memory]) -> None:
        """Deprecated overwrite-style writer, kept only for reference."""
        agents_md_path = os.path.join(self._root_dir, "AGENTS.md")
        sections = [f"- [{m.type}] {m.content}" for m in memories]
        new_context = (
            f"\n## Project Context (auto-extracted {time.strftime('%Y-%m-%d %H:%M')})\n"
            + "\n".join(sections)
        )
        existing = ""
        try:
            if os.path.exists(agents_md_path):
                with open(agents_md_path, "r", encoding="utf-8") as f:
                    existing = f.read()
            if "## Project Context" in existing:
                idx = existing.index("## Project Context")
                next_section = existing.find("\n## ", idx + 1)
                if next_section == -1:
                    existing = existing[:idx].rstrip() + new_context + "\n"
                else:
                    existing = existing[:idx].rstrip() + new_context + "\n" + existing[next_section:]
            else:
                existing = existing.rstrip() + new_context + "\n"
            with open(agents_md_path, "w", encoding="utf-8") as f:
                f.write(existing)
        except (IOError, OSError):
            pass  # fail-open: 可选增强，失败不影响主流程

    # ------------------------------------------------------------------
    # 2. Dream consolidation
    # ------------------------------------------------------------------

    def dream(self, limit: int = 10) -> str:
        """Generate a dream summary from recent memories (legacy API).

        Args:
            limit: Maximum number of memories to include.

        Returns:
            Formatted dream summary string.
        """
        recent = self.storage.get_memory_entries(root=self._root_dir, limit=limit)
        if not recent:
            return "No memories yet."
        parts = [f"[{m.get('type', '')}] {m.get('content', '')}" for m in recent]
        return "Memory dream:\n" + "\n".join(parts)

    def _dream_pool(self, since: int) -> list:
        """这一趟要看的记忆池：最近新增的 + 长期欠整理的。

        只看"最近 24 小时的活记忆"等于只看新增：昨天就和别人矛盾的那条、上个月
        过期的那条，从第二天起再也进不了任何一趟整合。冲突因此只增不减，而"整理
        记忆"这件事恰恰是为它们存在的。

        欠整理的放前面：预算裁剪是从头保留的（见 :meth:`_dream_inputs`），排在后
        面就等于永远被裁掉——那和根本不查一样。按 id 去重，同一条不占两份预算。
        """
        pool, seen = [], set()
        try:
            review = self.storage.list_memories_needing_review(self._root_dir, limit=20)
        except Exception as e:  # noqa: BLE001
            print(f"[dream] 欠整理清单没查到：{e}")
            review = []
        for r in list(review) + list(
                self.storage.get_memory_entries(
                    root=self._root_dir, since=since, limit=50)):
            rid = str(r.get("id") or "")
            if not rid or rid in seen:
                continue
            seen.add(rid)
            pool.append(r)
        return pool

    def _dream_inputs(self, recent: list, reserved: int = 0) -> tuple:
        """裁到预算之内的输入 + 它的幂等键。返回 ``(rows, idem_key, tokens)``。

        键取内容而不是时间窗：时间窗每次都不一样，等于没有幂等。同一批记忆无论
        什么时候再跑一遍，键都一样，所以不会产出第二份指向同几行的提案。键里只有
        记忆行——旁证（见 :meth:`_dream_context`）变了不该让同一批记忆再提一次案。

        ``reserved`` 是旁证已经吃掉的预算。不扣的话预算就是假的：旁证越多，实际
        送出去的 token 越超，而"一次别塞太多"这条上限本来是为了防止模型在无关事实
        之间编造联系。
        """
        budget = max(0, DreamConsolidator.MAX_INPUT_TOKENS - int(reserved or 0))
        kept, tokens = [], 0
        for r in recent:
            cost = estimate_tokens(str(r.get("content", "")))
            if tokens + cost > budget:
                break
            kept.append(r)
            tokens += cost
        ids = sorted(str(r.get("id") or "") for r in kept)
        key = hashlib.sha256(
            (str(self._root_dir) + "|" + "|".join(ids)).encode("utf-8")
        ).hexdigest()[:32] if ids else ""
        return kept, key, tokens

    #: 旁证的条数上限。旁证是判据不是主角，多了会把记忆本身挤出预算。
    _CTX_BUNDLES = 5
    _CTX_EXPERIENCES = 8

    def _dream_context(self) -> dict:
        """只读的旁证：最近的目标学习结论 + 技能经验。

        §10.1 把这两样和记忆行并列成 Dream 的输入。它们**不进 merge_ids**：一条
        技能经验不是记忆，"合并"它没有意义，让模型以为可以合并只会换来一堆被丢掉
        的幻觉 id。它们的作用是判据——同一件事目标侧已经学到过，这批记忆就更值得
        合成一条；某个技能刚刚因为某个原因失败过，与之矛盾的旧记忆就更可能是过时
        的那条。

        两个来源都可能不可用（演化档位 off、表还是空的），少一块就少一块，不报错：
        Dream 的价值不该依赖它们在场。
        """
        ctx: dict = {}
        try:
            from evolution import get_evolution_engine
            eng = get_evolution_engine()
            if eng.enabled():
                ctx["goalLearnings"] = [
                    {"decision": str(b.get("decision") or ""),
                     "why": str(b.get("rationale") or "")[:200]}
                    for b in eng.store.list_bundles(limit=self._CTX_BUNDLES)
                    if str(b.get("decision") or "") not in ("", "NO_OP")
                ]
        except Exception as e:  # noqa: BLE001
            print(f"[dream] 目标学习结论没读到：{e}")
        try:
            ctx["skillExperiences"] = [
                {"skill": str(e.get("skill_id") or ""),
                 "outcome": str(e.get("outcome") or ""),
                 "failure": str(e.get("failure_class") or ""),
                 "feedback": str(e.get("user_feedback") or "")[:160]}
                for e in self.storage.list_skill_experiences(
                    limit=self._CTX_EXPERIENCES)
            ]
        except Exception as e:  # noqa: BLE001
            print(f"[dream] 技能经验没读到：{e}")
        return {k: v for k, v in ctx.items() if v}

    def _build_dream_prompt(self, rows: list, context: Optional[dict] = None) -> dict:
        """整合要问模型的那句话。返回 ``llm_client.call`` 认识的 dict prompt。

        原来这里直接 ``self._llm(rows)``，把数据库行丢给回调。生产环境的回调是
        ``llm_client.call``：它只认字符串和带 ``instruction`` 的 dict，收到 list
        就 ``str(prompt)``——模型看到的是一堆 Python repr，没有任何指令，自然
        不会回 ``{"summary", "merge_ids"}`` 这个只有我们自己知道的形状。于是
        ``isinstance(result, dict)`` 永远为假，Dream 每一趟都以"模型没有给出可用
        的整合结论"收尾。整条 §10.2（提案 → 待你裁决 → 批准）在真机上从未跑过，
        而闭环检查全绿，因为检查里的假回调恰好说这门私有协议。


        只投影 id / 内容 / 类型 / 状态四项，不是整行：行里带 embedding 向量，塞
        进 prompt 既撑爆预算又毫无信息。顺带把"这条正在和别人冲突"告诉模型——
        欠整理的行本来就是靠这个进池子的（见 :meth:`_dream_pool`）。
        """
        items = []
        for r in rows:
            items.append({
                "id": str(r.get("id") or ""),
                "content": str(r.get("content") or ""),
                "type": str(r.get("mem_type") or r.get("type") or ""),
                "status": str(r.get("status") or "active"),
                "source": str(r.get("created_by") or ""),
                "conflicting": str(r.get("conflict_set") or "[]") not in ("", "[]"),
            })
        prompt = {
            "task": "memory_consolidation",
            "instruction": (
                "You are consolidating long-term memory .\n"
                "Synthesize memories below into durable, high-value statements so future sessions can orient quickly.\n"
                "Find memories that are redundant, overlapping, or in contradiction, and merge them into ONE consolidated record.\n"
                "Return ONLY a JSON object, no prose, no code fences:\n"
                '{"summary": "...", "merge_ids": ["...", "..."]}\n\n'
                "Three Golden Memory Principles:\n"
                "1. Applicable: Must provide actionable, concrete context or factual rules that future sessions can immediately use.\n"
                "2. Durable: Focus on enduring truths, project conventions, and user preferences; discard ephemeral transient state.\n"
                "3. Legible: Single self-contained sentence, written in the same language as the source memories, clear and crisp.\n\n"
                "Conflict & Security Rules:\n"
                "- When memories contradict, the newer fact wins. User-explicit memories (source: 'user') strictly override inferred ones.\n"
                "- `merge_ids` must strictly come from the provided `memories` list.\n"
                "- Never include secrets, tokens, passwords, or API keys.\n"
                '- If there is nothing meaningful to consolidate, return {"summary": "", "merge_ids": []}.\n'
            ),
            "memories": items,
        }
        if context:
            prompt["context"] = context
        return prompt

    def _parse_dream_result(self, result: Any) -> tuple:
        """从模型回复里取 ``(summary, raw_ids)``。取不到就 ``("", [])``。

        ``llm_client.call`` 已经会剥 code fence 并尝试 JSON，所以正常情况下拿到的
        就是 dict。但回调不一定是它（测试替身、别的客户端），退回文本时也要能读：
        一句"没什么可合的"散文应该等于"这趟不提案"，而不是一个异常。
        """
        data = result
        if isinstance(data, str):
            s = data.strip()
            start, end = s.find("{"), s.rfind("}")
            if 0 <= start < end:
                try:
                    data = json.loads(s[start:end + 1])
                except (json.JSONDecodeError, ValueError):
                    return "", []
            else:
                return "", []
        if not isinstance(data, dict):
            return "", []
        summary = str(data.get("summary") or "").strip()
        raw = data.get("merge_ids") or []
        if not isinstance(raw, list):
            raw = []
        return summary, [str(i) for i in raw]

    def _dream_observe(self, job_id: str, summary: str, merge_ids: list) -> tuple:
        """把这一趟 Dream 的产物记成一条 EvolutionObservation。

        返回 ``(decision, reason, obs)``；``obs`` 给 :meth:`_dream_bundle` 用，档位
        off 或记账失败时是 ``None``。

        为什么要绕一趟观察层：目标结束时学到的东西都在 ``observations`` 里有据可
        查（依据了什么、为什么这么判），Dream 提出的合并却只有 ``dream_runs`` 一行
        文字。同一个问题"它凭什么改我的记忆"在两条路径上得到两种答案，等于审计
        链断了一半。两个账本用 ``run_id == job_id`` 对上。

        顺带把 Dream 也挡在同一道秘密闸门后面：``classify_observation`` 在证据里嗅
        到 api key/token 形状就判 NO_OP，调用方据此**不落这条提案**——一条含凭证的
        整合记忆一旦被批准就是永久泄露，而它长得和正常提案一模一样。

        evolution 档位 off 时 ``observe()`` 返回 NO_OP + "未评估"，那不是拒绝：
        返回的 ``decision`` 为空字符串，让调用方知道这趟没人评过，照常提案。
        """
        try:
            from evolution import EvolutionObservation, get_evolution_engine
            engine = get_evolution_engine()
            if not engine.enabled():
                return "", "", None
            obs = EvolutionObservation(
                run_id=job_id,
                session_id="dream",
                used_memory=list(merge_ids or []),
                new_facts=[summary],
                created_at=time.time(),
            )
            engine.observe(obs)
            return obs.decision or "", obs.reason or "", obs
        except Exception as e:  # noqa: BLE001
            # 记账失败不能吃掉提案：Dream 的价值不依赖 evolution 库可用。
            print(f"[dream] 观察没记下来：{e}")
            return "", "", None

    def _dream_bundle(self, obs, job_id: str, proposal_id: str,
                      outcome: str) -> None:
        """给这一趟 Dream 落一条 LearningBundle。

        ``/api/evolution/bundles`` 是"学到了什么"的统一台账，它撑着一句话：Memory
        和 Skill 是同一条经验的两个投影，不是两个相邻功能。但在这之前它只有目标终态
        一个生产者——Dream 整理出来的记忆完全不在里面，那句话对一半的产物不成立。

        被拒的那趟也要落（``outcome="refused"``）：和目标侧的 NO_OP 同一个道理，
        "为什么没学"也是审计要回答的问题。

        ``bundle_key`` 取 ``dream:{job_id}``，所以崩溃重来拿到的是同一条 bundle 的
        id，不是第二条——job_id 本身已经是按输入内容幂等的。
        """
        if obs is None or not job_id:
            return
        try:
            from evolution import get_evolution_engine
            get_evolution_engine().emit_learning_bundle(
                obs,
                {"memoryProposals": [proposal_id] if proposal_id else []},
                bundle_key=f"dream:{job_id}",
                outcome=outcome,
            )
        except Exception as e:  # noqa: BLE001
            print(f"[dream] bundle 没落下来：{e}")


    async def dream_consolidate(self) -> None:
        """后台整合：把冗余记忆合并成一条更高层的理解——但只**提议**，不执行。

        §10.2：Dream 的产物进 proposal，由人裁决。这里的提案形状就是一条
        ``status='candidate'`` 且 ``supersedes=[被合并的 id...]`` 的记忆：它自己不
        进召回，被它指向的那几条也一条都没动，直到用户在设置页点批准。

        §10.3：整趟跑在一个有账本的 job 里——job_id、租约、心跳、墙上时间上限、
        输入 token 上限、幂等键、取消语义。缺了租约，两个窗口会对同一个 workspace
        同时整合并各提一份指向同几行的提案；缺了幂等键，崩溃重来会再提一份。

        无论走哪条分支都会往 ``dream_runs`` 写一行结论（§10.2 的 DreamJournal）：
        一个只记录成功的日记会让"它到底有没有在工作"变成不可回答的问题。

        提案在落盘前还要过一遍观察层（见 :meth:`_dream_observe`）：既让"依据了什么、
        为什么这么判"和目标学习走进同一个台账，也让 Dream 受同一道秘密闸门约束。

        §10.1 的输入不止记忆行：目标学到的结论和技能经验作为只读旁证一起送进去
        （见 :meth:`_dream_context`），但只有记忆行能出现在 ``merge_ids`` 里。
        """
        span = self.telemetry.start_span("memory_dream")
        job_id, beat = "", None
        t0 = time.time()
        try:
            since = int(time.time()) - DreamConsolidator.LOOKBACK_SECONDS
            recent = self._dream_pool(since)
            if len(recent) < 3:
                self.telemetry.end_span(span, reason="not_enough")
                return

            # 旁证先算，因为它要从同一个 token 预算里扣（见 _dream_inputs）。
            ctx = self._dream_context()
            ctx_tokens = estimate_tokens(
                json.dumps(ctx, ensure_ascii=False)) if ctx else 0
            rows, idem_key, tokens = self._dream_inputs(recent, reserved=ctx_tokens)
            if len(rows) < 3:
                self.telemetry.end_span(span, reason="budget_too_small")
                return
            tokens += ctx_tokens

            job_id, verdict = self.storage.claim_dream_run(
                self._root_dir, idem_key,
                lease_seconds=DreamConsolidator.MAX_WALL_SECONDS
                + DreamConsolidator.HEARTBEAT_SECONDS * 2)
            if not job_id:
                # busy = 别的进程在做同一批；done = 这批已经出过提案了。两种都
                # 不该重做，也都不是错误。
                print(f"[dream] 跳过：{verdict}")
                self.telemetry.end_span(span, reason=verdict)
                return

            beat = asyncio.create_task(self._dream_heartbeat(job_id))

            if not self._llm:
                # 没有 LLM 就没有可靠的合并依据。原来这里按内容前 100 字去重然后
                # 直接归档，两个问题叠在一起：前缀相同不等于内容相同（两条在第
                # 101 个字才分岔的记忆会丢一条），而且它同样是未经批准的销毁性
                # 写入。精确等价的重复现在由写入闸门在落盘前挡掉，历史重复交给
                # 设置页的「待你裁决」面板让用户自己选。
                self.storage.update_memory_dream_time(self._root_dir)
                self.storage.finish_dream_run(
                    job_id, "noop", outcome="没有可用的模型，这一趟没有做任何合并",
                    input_count=len(rows), tokens_used=tokens,
                    wall_ms=int((time.time() - t0) * 1000))
                self.telemetry.end_span(span, reason="no_llm_no_op")
                return

            try:
                prompt = self._build_dream_prompt(rows, ctx)
                if asyncio.iscoroutinefunction(self._llm):
                    result = await asyncio.wait_for(
                        self._llm(prompt), timeout=DreamConsolidator.MAX_WALL_SECONDS)
                else:
                    result = self._llm(prompt)
            except asyncio.TimeoutError:
                self.storage.finish_dream_run(
                    job_id, "failed",
                    outcome=f"模型超过 {DreamConsolidator.MAX_WALL_SECONDS}s 没有返回",
                    input_count=len(rows), tokens_used=tokens,
                    wall_ms=int((time.time() - t0) * 1000))
                self.telemetry.end_span(span, reason="llm_timeout")
                return
            except Exception as e:
                self.storage.finish_dream_run(
                    job_id, "failed", outcome=f"模型调用失败：{e}",
                    input_count=len(rows), tokens_used=tokens,
                    wall_ms=int((time.time() - t0) * 1000))
                self.telemetry.end_span(span, error=str(e))
                return

            # 落盘之前再确认一次租约还在自己手里。到这里已经过了几十秒，中途被
            # 接管的话，另一趟正在写同一批的提案。
            if not self.storage.heartbeat_dream_run(job_id):
                print("[dream] 租约已经不属于这一趟，放弃写入")
                self.telemetry.end_span(span, reason="lease_lost")
                return

            merge_ids: list = []
            summary, raw_ids = self._parse_dream_result(result)
            if summary:
                # 只认这一趟真的读过的那些 id。模型返回一个不在输入里的 id 就是
                # 幻觉，照着它归档等于让幻觉删用户的记忆。
                seen_ids = {str(r.get("id")) for r in rows}
                merge_ids = [i for i in raw_ids if i in seen_ids]
                dropped = len(raw_ids) - len(merge_ids)
                if dropped:
                    print(f"[dream] 丢掉 {dropped} 个不在本轮输入里的 merge_id")

            proposal_id, outcome, status = "", "", "noop"
            if summary:
                decision, why, obs = self._dream_observe(job_id, summary, merge_ids)
                if decision == "NO_OP":
                    # 观察层看完证据说这条不该固化（最常见的是嗅到了凭证形状）。
                    # 提案不落盘，但理由要留在日记里——否则用户只看到"什么都没
                    # 发生"，不知道是没东西可合并还是被拦下来了。
                    self._dream_bundle(obs, job_id, "", "refused")
                    self.storage.update_memory_dream_time(self._root_dir)
                    self.storage.finish_dream_run(
                        job_id, "noop", outcome=f"这条整合没有提交：{why}",
                        input_count=len(rows), tokens_used=tokens,
                        wall_ms=int((time.time() - t0) * 1000))
                    self.telemetry.end_span(span, reason="observation_no_op")
                    return
                dream_mem = Memory(
                    content=summary,
                    mem_type=MemoryType.DREAM,
                    importance=0.9,
                    root_dir=self._root_dir,
                    tier=MemoryTier.DREAMING.value,
                )
                dream_mem.add_tag("dream")
                # 提案：未批准不进召回，也不动任何既有记忆。
                dream_mem.status = "candidate"
                dream_mem.supersedes = merge_ids
                r = self.store(dream_mem)
                if r.ok:
                    proposal_id, status = r.value, "done"
                    outcome = (f"提议把 {len(merge_ids)} 条记忆合并成 1 条，等你裁决"
                               if merge_ids else "提议新增 1 条整合记忆，等你裁决")
                else:
                    status, outcome = "failed", f"提案没写下来：{r.error}"
                    print(f"[dream] {outcome}")
                self._dream_bundle(obs, job_id, proposal_id,
                                   "success" if r.ok else "failure")
            else:
                outcome = "模型没有给出可用的整合结论，这一趟什么都没改"

            self.storage.update_memory_dream_time(self._root_dir)
            self.storage.finish_dream_run(
                job_id, status, outcome=outcome, proposal_id=proposal_id,
                input_count=len(rows), tokens_used=tokens,
                wall_ms=int((time.time() - t0) * 1000))
            self.telemetry.end_span(span, proposed=len(merge_ids))
        except asyncio.CancelledError:
            # 取消是协作式的：走到这里说明我们停在某个 await 上，没有半个写入。
            if job_id:
                self.storage.finish_dream_run(
                    job_id, "cancelled", outcome="被取消（前台有事要做或应用退出）",
                    wall_ms=int((time.time() - t0) * 1000))
            self.telemetry.end_span(span, reason="cancelled")
            raise
        except Exception as e:
            if job_id:
                self.storage.finish_dream_run(
                    job_id, "failed", outcome=f"这一趟出错了：{e}",
                    wall_ms=int((time.time() - t0) * 1000))
            self.telemetry.end_span(span, error=str(e))
        finally:
            if beat is not None and not beat.done():
                beat.cancel()

    async def _dream_heartbeat(self, job_id: str) -> None:
        """定期续租。续不上就说明这趟被接管或被取消了，让它自己安静结束。

        这里只负责报活，不负责中止——中止由主流程在落盘前那次 heartbeat 检查决定，
        这样取消永远发生在两次写入之间，而不是一次写入中间。
        """
        try:
            while True:
                await asyncio.sleep(DreamConsolidator.HEARTBEAT_SECONDS)
                if not self.storage.heartbeat_dream_run(job_id):
                    return
        except asyncio.CancelledError:
            return



    # ------------------------------------------------------------------
    # 3. Semantic prefetch (<memory> injection)
    # ------------------------------------------------------------------

    def prefetch(
        self,
        query: str,
        limit: int = 5,
        root: str = "",
        session_id: str = "",
        branch_id: str = "",
    ) -> str:
        """Retrieve relevant memories and format as <memory> XML for injection.

        Called on user_prompt_submit. Results injected into system prompt context.

        C2: delegates to ``search_memory_hybrid`` which fuses dense vectors with
        FTS5 keyword search. The old ``search_memory_semantic`` path is kept as
        internal fallback when hybrid import fails.

        Args:
            query: User's message text.
            limit: Maximum memories to retrieve.
            root: Explicit workspace root (defaults to view's _root_dir).
            session_id: Current session id for scope isolation.
            branch_id: Current branch id for scope isolation.

        Returns:
            XML string of <memory> blocks, or empty string if none found.
        """
        span = self.telemetry.start_span(SpanName.MEMORY_RECALL, query=query[:100])
        try:
            actual_root = root or self._root_dir
            keywords = self._extract_keywords(query)
            query_vec = self._embed_text(query)
            results, trace = self.storage.search_memory_hybrid(
                root=actual_root,
                query_text=query,
                query_embedding=query_vec,
                keywords=keywords if keywords else None,
                limit=limit * RECALL_CANDIDATE_MULTIPLIER,
                session_id=session_id,
                branch_id=branch_id,
            )
            results = self._rerank(results, query_vec, limit)
            if not results:
                self.telemetry.end_span(span, found=0)
                return ""
            # C1: count the recall so promotion can see load-bearing memories.
            self.note_recall(results)
            blocks = []
            now = time.time()
            for m in results:
                scope = m.get("scope", "project")
                content = m.get("content", "")
                mem_type = m.get("type", "fact")
                # Drift marker: a memory's truth decays with its age. A
                # preference captured three months ago may well have been
                # superseded; tagging WHICH rows are stale lets the model
                # weigh them instead of treating recall as ground truth.
                try:
                    age_days = (now - float(m.get("updated_at") or m.get("created_at") or 0)) / 86400.0
                except (TypeError, ValueError):
                    age_days = 0.0
                if age_days >= 90:
                    content += ' <drift note="可能已过时：超过 90 天未更新，当作线索而非事实，使用前向用户确认"/>'
                elif age_days >= 30:
                    content += ' <drift note="较旧：超过 30 天未更新"/>'
                blocks.append(
                    f'<memory context="{scope}" type="{mem_type}">{content}</memory>'
                )
            # 跨会话相关发现（Phase 36）：本会话+全局的主召回之外，再扫
            # 一遍全库（session_id 置空 = 不做会话过滤），取属于**其他会
            # 话**的 top 命中。这些是"你过去在别处和这个话题打过交道"的
            # 线索——定位为提示而非事实，条数与长度都从严。
            try:
                cross = self._cross_session_hits(
                    query, actual_root, exclude_session=session_id, limit=2,
                )
                for m in cross:
                    sid = str(m.get("session_id") or "unknown")[:18]
                    snippet = str(m.get("content", ""))[:260]
                    blocks.append(
                        f'<memory context="cross-session" type="discovery" session="{sid}">'
                        f'{snippet} <drift note="来自其他会话的相关发现：仅作线索，使用前与用户确认"/></memory>'
                    )
            except Exception:
                pass  # 跨会话通道失败不阻塞主召回
            # Phase 60 联动: 拓扑图谱关联召回 (Knowledge Graph Recall)
            try:
                graph_engine = get_graph_memory_engine(storage=self.storage)
                graph_edges = []
                for kw in (keywords or [query])[:3]:
                    edges = graph_engine.recall_associative_graph(kw, root_dir=actual_root, max_hops=2)
                    if edges:
                        graph_edges.extend(edges)
                if graph_edges:
                    seen_edges = set()
                    unique_edges = []
                    for e in graph_edges:
                        edge_sig = (e.get("source"), e.get("relation"), e.get("target"))
                        if edge_sig not in seen_edges:
                            seen_edges.add(edge_sig)
                            unique_edges.append(e)
                    graph_prompt = graph_engine.format_graph_for_prompt(unique_edges[:5])
                    if graph_prompt:
                        blocks.append(f'<memory context="knowledge_graph" type="graph">{graph_prompt}</memory>')
            except Exception:
                pass

            # Phase 62 约束: 25KB 容量预算与 150 字符单行约束 (MemoryIndexCapper)
            capped_blocks = MemoryIndexCapper.enforce_budget(blocks)
            xml = "\n".join(capped_blocks)
            self.telemetry.end_span(span, found=len(results), trace=trace[:3] if trace else [])
            return xml
        except Exception as e:
            self.telemetry.end_span(span, error=str(e))
            return ""

    def _cross_session_hits(
        self, query: str, root: str, *, exclude_session: str, limit: int = 2,
    ) -> list:
        """全库检索中属于**其他会话**的 top 命中（跨会话发现）。

        复用 C2 混合检索（向量+FTS5 融合），session_id 置空即不做会话过
        滤；过滤掉本会话与无归属的全局条目（后者主召回已覆盖），只留有
        明确会话归属的"别的对话里聊过什么"。
        """
        keywords = self._extract_keywords(query)
        results, _trace = self.storage.search_memory_hybrid(
            root=root,
            query_text=query,
            query_embedding=self._embed_text(query),
            keywords=keywords if keywords else None,
            limit=limit + 6,
            session_id="",
            branch_id="",
        )
        out: list = []
        for m in results or []:
            sid = str(m.get("session_id") or "")
            if not sid or sid == exclude_session:
                continue
            out.append(m)
            if len(out) >= limit:
                break
        # Session message FTS: find past conversations mentioning this topic
        if len(out) < limit:
            try:
                ws_row = self.storage._db("sessions").execute(
                    "SELECT workspace FROM sessions WHERE id=?", (exclude_session or "",)
                ).fetchone()
                workspace = str((ws_row or {}).get("workspace") or "")
                for hit in self.storage.search_sessions_fts(query, workspace=workspace, limit=limit):
                    sid = str(hit.get("session_id") or "")
                    if not sid or sid == exclude_session:
                        continue
                    if any(str(x.get("session_id")) == sid for x in out):
                        continue
                    out.append({
                        "session_id": sid,
                        "content": str(hit.get("snippet") or ""),
                        "scope": "session",
                        "type": "conversation",
                    })
                    if len(out) >= limit:
                        break
            except Exception:
                pass
        return out

    def recall(self, query: str, limit: int = 5) -> List[Memory]:
        """Recall relevant memories (returns Memory objects).

        C2: uses hybrid retrieval (vector + FTS5 keyword fusion).

        Args:
            query: Search query string.
            limit: Maximum results.

        Returns:
            List of matching Memory objects.
        """
        if not self.memory_enabled:
            return []
        span = self.telemetry.start_span(SpanName.MEMORY_RECALL, query=query[:100])
        try:
            keywords = self._extract_keywords(query)
            query_vec = self._embed_text(query)
            results, _trace = self.storage.search_memory_hybrid(
                root=self._root_dir,
                query_text=query,
                query_embedding=query_vec,
                keywords=keywords if keywords else None,
                limit=limit * RECALL_CANDIDATE_MULTIPLIER,
            )
            results = self._rerank(results, query_vec, limit)
            self.note_recall(results)
            mems = [Memory.from_dict(m) for m in results]
            self.telemetry.end_span(span, found=len(mems))
            return mems
        except Exception as e:
            self.telemetry.end_span(span, error=str(e))
            return []

    def _extract_keywords(self, text: str) -> List[str]:
        """Extract meaningful keywords from text for search.

        Args:
            text: Input text.

        Returns:
            List of keyword strings (lowercase, stop-words removed).
        """
        words = re.findall(r"[\w]+", text.lower())
        return [w for w in words if len(w) > 2 and w not in self._STOP_WORDS]

    # ------------------------------------------------------------------
    # Recall re-ranking: time decay + MMR diversity
    # ------------------------------------------------------------------

    def _decay_weight(self, row: dict) -> float:
        """Exponential recency weight in (0, 1]. 1.0 when decay is disabled.

        Uses `updated_at` in preference to `created_at`: a memory that was
        re-confirmed last week is current knowledge even if first recorded a
        year ago. Incorporates access recency and citation reinforcement.
        """
        if not self.decay_enabled:
            return 1.0
        ts = row.get("updated_at") or row.get("created_at") or 0
        if not ts:
            return 1.0
        now = time.time()
        created_age = max(0.0, (now - float(ts)) / 86400.0)
        accessed_ts = row.get("accessed_at") or row.get("last_accessed_at")
        if accessed_ts and float(accessed_ts) > 0:
            access_age = max(0.0, (now - float(accessed_ts)) / 86400.0)
            effective_age = 0.2 * created_age + 0.8 * access_age
        else:
            effective_age = created_age

        base_decay = 0.5 ** (effective_age / RECALL_HALFLIFE_DAYS)
        hits = float(row.get("hits") or 0)
        citation_bonus = min(1.5, 1.0 + 0.1 * math.log1p(max(0.0, hits)))
        return min(1.0, base_decay * citation_bonus)

    @staticmethod
    def _confidence_of(row: dict) -> float:
        """一行的置信度，缺失/异常时按 0.5 处理。

        0013 之前的行没有这一列，工作记忆的 scratch dict 也没有。落在 0.5 上是
        故意的：那是"不知道"的中点，而且作为**均匀**乘数对排序没有任何影响——
        只有当 Dream 或用户真的调过它，它才开始区分。
        """
        try:
            v = float(row.get("confidence"))
        except (TypeError, ValueError):
            return 0.5
        if v <= 0.0 or v > 1.0:
            return 0.5
        return v

    def _row_vector(self, row: dict) -> Optional[list]:
        """Decode a row's stored embedding, or None."""


        try:
            vec = self.storage._decode_embedding(row.get("embedding"))
        except Exception:
            return None
        if isinstance(vec, list) and vec:
            return vec
        return None

    @staticmethod
    def _cos(a, b) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(float(x) * float(y) for x, y in zip(a, b))
        na = math.sqrt(sum(float(x) * float(x) for x in a))
        nb = math.sqrt(sum(float(y) * float(y) for y in b))
        if na == 0 or nb == 0:
            return 0.0
        return dot / (na * nb)

    def _rerank(
        self,
        rows: List[dict],
        query_vec: Optional[list],
        limit: int,
    ) -> List[dict]:
        """Re-rank candidates by decayed relevance, then greedily pick for MMR.

        Two stages, each independently switchable:

        1. **Decay.** base = relevance x importance x confidence x recency_weight.
           Storage already returned rows best-first; when there's no query vector
           we reconstruct a relevance proxy from that rank position, which is
           enough to keep the ordering meaningful in keyword-only mode.
        2. **MMR.** Greedily take the candidate maximizing
           ``λ·relevance − (1−λ)·max_similarity_to_already_picked``. Without
           this, five recordings of "prefers TypeScript" consume every slot and
           the model learns one fact instead of five.

        MMR needs vectors to measure redundancy. Without embeddings it silently
        degrades to plain decayed ranking rather than pretending to diversify.

        为什么 importance 和 confidence 都要在这里，而且形状不一样：
        - importance 是"这条多重要"，用 ``0.5 + importance`` 当权重——一条不重要的
          记忆仍然可能是对的，不该被压到近乎消失。
        - confidence 是"这条多可能是对的"，直接当乘数。一条大概是错的记忆，无论多
          相关都不该排在前面；0.05 的置信度就该拿到 5% 的分。这也是 0013 之前
          importance 被当置信度用的那个 bug 的反面：那时"很重要但很可能已经不对"
          的记忆会排到最前面。
        - 老行的 confidence 默认 0.5，是个**均匀**乘数，对排序没有任何影响；只有
          当 Dream 或用户真的调过它，它才开始产生区分。所以这一步对现存语料是
          零风险的。
        """
        if not rows:
            return []
        n = len(rows)
        scored = []
        for i, row in enumerate(rows):
            vec = self._row_vector(row)
            if query_vec and vec:
                relevance = max(0.0, self._cos(query_vec, vec))
            else:
                # Rank-position proxy: first row = 1.0, last = ~0.
                relevance = 1.0 - (i / max(1, n))
            importance = float(row.get("importance") or 0.5)
            confidence = self._confidence_of(row)
            base = (relevance * (0.5 + importance) * confidence
                    * self._decay_weight(row))
            scored.append({"row": row, "vec": vec, "relevance": relevance, "score": base})


        scored.sort(key=lambda d: -d["score"])

        if not self.mmr_enabled or limit >= len(scored):
            return [d["row"] for d in scored[:limit]]

        selected: List[dict] = []
        pool = list(scored)
        while pool and len(selected) < limit:
            best = None
            best_val = None
            for cand in pool:
                if selected and cand["vec"]:
                    redundancy = max(
                        (self._cos(cand["vec"], s["vec"]) for s in selected if s["vec"]),
                        default=0.0,
                    )
                else:
                    redundancy = 0.0
                val = RECALL_MMR_LAMBDA * cand["score"] - (1 - RECALL_MMR_LAMBDA) * redundancy
                if best_val is None or val > best_val:
                    best_val = val
                    best = cand
            selected.append(best)
            pool.remove(best)
        return [d["row"] for d in selected]

    # ------------------------------------------------------------------
    # 4. Session synthesis
    # ------------------------------------------------------------------

    def synthesize(self, topic: str) -> str:
        """Synthesize memories around a topic (legacy API).

        Args:
            topic: Topic to synthesize around.

        Returns:
            Formatted synthesis string.
        """
        relevant = self.recall(topic, limit=10)
        if not relevant:
            return f"No memories about: {topic}"
        parts = [f"About {topic}:"]
        for m in relevant:
            parts.append(f"- {m.type}: {m.content}")
        return "\n".join(parts)

    #: 会话综述的四个槽位。这是"下一次会话的上下文前缀"的形状，改它等于改
    #: 已经存进 session_synthesis 表的历史行的读法，所以它是契约而不是细节。
    _SYNTHESIS_KEYS = ("Goal", "Progress", "Decisions", "Open Issues")

    def _build_synthesis_prompt(self, messages: List[dict]) -> dict:
        """会话综述要问模型的那句话。

        和 Dream 那边同一个病根：原来直接 ``self._llm(messages)`` 把消息列表丢给
        ``llm_client.call``，它只认 str / 带 instruction 的 dict，收到 list 就
        ``str(prompt)``——模型没有指令，回不出四槽位的 dict，
        ``isinstance(synthesis, dict)`` 于是永远为假，每次都静默退回
        :meth:`_heuristic_synthesis`。而启发式版本只是把前 3 条用户消息和前 5 条
        助手消息截到 200 字，那就是用户下一次会话真正拿到的"上文"。

        取头 4 条 + 尾 20 条：目标在开头，进展和未决在结尾，中间那段最不值钱。
        """
        head, tail = messages[:4], messages[4:][-20:]
        items = []
        for m in head + tail:
            items.append({
                "role": str(m.get("role") or ""),
                "content": str(m.get("content") or "")[:1200],
            })
        return {
            "task": "session_synthesis",
            "instruction": (
                "Summarize the conversation below into a handoff note for the "
                "next session.\n"
                "Return ONLY a JSON object, no prose, no code fences:\n"
                '{"Goal": ["..."], "Progress": ["..."], '
                '"Decisions": ["..."], "Open Issues": ["..."]}\n'
                "Rules:\n"
                "- Each item is one short sentence, written in the language of "
                "the conversation.\n"
                "- `Decisions` are choices already made and their reason; "
                "`Open Issues` are what is still unresolved.\n"
                "- Empty arrays are fine — don't invent progress that didn't "
                "happen.\n"
                "- Never copy anything that looks like a secret, token or API "
                "key."
            ),
            "messages": items,
        }

    def _parse_synthesis(self, result: Any) -> Optional[dict]:
        """把模型回复归一成四槽位，读不出就 None（调用方退回启发式）。

        归一而不是照抄：原来的代码接受**任何** dict，所以模型回一句
        ``{"answer": "..."}`` 也会被存成综述，然后作为上下文前缀注进下一次会话。
        一个形状不对的前缀比没有前缀更糟——它看起来像是系统整理过的。
        """
        data = result
        if isinstance(data, str):
            s = data.strip()
            start, end = s.find("{"), s.rfind("}")
            if not (0 <= start < end):
                return None
            try:
                data = json.loads(s[start:end + 1])
            except (json.JSONDecodeError, ValueError):
                return None
        if not isinstance(data, dict):
            return None
        out, hit = {}, False
        for key in self._SYNTHESIS_KEYS:
            raw = data.get(key)
            if isinstance(raw, str):
                raw = [raw] if raw.strip() else []
            if not isinstance(raw, list):
                raw = []
            items = [str(x).strip() for x in raw if str(x).strip()]
            if items:
                hit = True
            out[key] = items
        return out if hit else None

    async def synthesize_session(self, session_id: str, messages: List[dict]) -> Result:
        """Synthesize a complete session into structured JSON.

        Produces: {Goal, Progress, Decisions, Open Issues}
        Stored in session_synthesis table, used as next session's context prefix.

        Args:
            session_id: Session identifier.
            messages: List of message dicts from the session.

        Returns:
            Result containing the synthesis dict on success.
        """
        if not self.memory_enabled:
            # The router treats a non-ok Result as "nothing to inject", which
            # is exactly the semantics of the switch being off.
            return Result.failure("memory disabled")
        span = self.telemetry.start_span("memory_synthesize", session_id=session_id)
        try:
            if self._llm:
                raw = None
                try:
                    prompt = self._build_synthesis_prompt(messages)
                    if asyncio.iscoroutinefunction(self._llm):
                        raw = await self._llm(prompt)
                    else:
                        raw = self._llm(prompt)
                except Exception:
                    raw = None
                synthesis = self._parse_synthesis(raw)
                if synthesis:
                    self.storage.save_session_synthesis(session_id, synthesis)
                    self.telemetry.end_span(span)
                    return Result.success(synthesis)

            # Fallback: simple heuristic synthesis
            synthesis = self._heuristic_synthesis(messages)
            self.storage.save_session_synthesis(session_id, synthesis)
            self.telemetry.end_span(span)
            return Result.success(synthesis)
        except Exception as e:
            self.telemetry.end_span(span, error=str(e))
            return Result.failure(f"Session synthesis failed: {e}")

    def _heuristic_synthesis(self, messages: List[dict]) -> dict:
        """Generate a simple heuristic synthesis when LLM is unavailable.

        Args:
            messages: Session messages.

        Returns:
            Structured dict with Goal/Progress/Decisions/Open Issues.
        """
        user_msgs = [m for m in messages if m.get("role") == "user"]
        assistant_msgs = [m for m in messages if m.get("role") == "assistant"]
        goals = [m.get("content", "")[:200] for m in user_msgs[:3]]
        progress = [m.get("content", "")[:200] for m in assistant_msgs[:5]]
        return {
            "Goal": goals,
            "Progress": progress,
            "Decisions": [],
            "Open Issues": [],
        }

    def get_session_synthesis(self, session_id: str) -> Optional[dict]:
        """Retrieve a previously stored session synthesis.

        Args:
            session_id: Session identifier.

        Returns:
            Synthesis dict or None.
        """
        if not self.memory_enabled:
            return None
        return self.storage.get_session_synthesis(session_id)

    # ------------------------------------------------------------------
    # 5. Storage operations
    # ------------------------------------------------------------------

    def store(self, memory: Memory) -> Result:
        """Store a memory entry.

        WORKING-tier memories are held in process only — persisting a
        current-turn scratch note means it comes back stale next session, which
        is worse than not having it at all.

        Args:
            memory: Memory object to persist.

        Returns:
            Result indicating success or failure.
        """
        try:
            tier = normalize_tier(memory.tier)
            if not policy_for(tier).persisted:
                self._working.append(memory)
                # Bound the scratch list so a long turn can't grow it forever.
                if len(self._working) > 64:
                    self._working = self._working[-64:]
                return Result.success(memory.id)

            # §9.3 写入闸门。秘密整条拒收（截断的半条秘密还是秘密）、prompt
            # injection 整条拒收（一条能改写指令的长期记忆就是永久后门）、一次性
            # 噪声和无归属的臆测拒收、隐形 Unicode 剥除后放行。长期记忆每轮都会
            # 注入模型，这里放过的东西没有第二道防线。
            #
            # trusted 由 created_by 推导，而不是另开一个参数：两个来源会互相矛盾，
            # 而"谁写的"本来就是决定严格程度的那个事实。
            from memory_guard import screen_memory_content
            _v = screen_memory_content(
                memory.content, trusted=(memory.created_by == "user"))
            if not _v.allowed:
                print(f"[memory] store rejected ({'; '.join(_v.reasons)}): "
                      f"{str(memory.content)[:80]!r}")
                return Result.failure("memory rejected by safety guard: "
                                      + "; ".join(_v.reasons))
            memory.content = _v.content
            memory.sensitivity = _v.sensitivity

            root = memory.root_dir or self._root_dir

            # 物理隐私脱敏与相对时间绝对化 (Phase 61 核心内化)
            try:
                from sanitizer import PrivacySanitizer
                memory.content = PrivacySanitizer.clean(memory.content, workspace_root=root)
            except Exception:
                pass


            # §9.3 去重：同一条事实被再观察到一次，不是第二条记忆，而是这条**又被
            # 确认了一次**。插一条新行会让召回里出现两条一模一样的内容，占两份预算，
            # 而且新鲜度各算一套——用户改了其中一条，另一条还在照旧注入。
            for dup in (self.storage.find_memories_by_content(
                    root, memory.content, limit=2) or []):
                if dup == memory.id:
                    continue  # 就是自己，这是一次更新而不是重复
                self.storage.confirm_memory(dup)
                self._invalidate_active()
                return Result.success(dup)

            # §9.3 写入前冲突检测。命中的话新行落成 candidate 而不是 active：
            # 两条互相矛盾的记忆里必有一条是错的，但库这一层不知道是哪条，所以两边
            # 都不覆盖、也不让新的那条直接进召回，等用户或 Dream 裁决。
            peers = []
            status = memory.status or None
            try:
                peers = self.storage.find_conflicting_memories(
                    root, memory.content) or []
            except Exception as e:  # 冲突检测坏了不该让写入失败
                print(f"[memory] conflict detect failed: {e}")
            if peers:
                status = "candidate"


            emb = self._embed_text(memory.content)
            emb_blob = json.dumps(emb).encode("utf-8") if emb else None
            self.storage.save_memory_entry(
                eid=memory.id,
                sid=memory.session_id,
                root=root,
                scope=memory.scope,

                content=memory.content,
                emb=emb_blob,
                meta={"tags": memory.tags, "accessed_at": memory.accessed_at},
                mem_type=memory.type,
                importance=memory.importance,
                tags=memory.tags,
                archived=int(memory.archived),
                tier=tier.value,
                hits=memory.hits,
                accessed_at=int(memory.accessed_at or 0),
                created_by=memory.created_by,
                sensitivity=memory.sensitivity,
                status=status,
                supersedes=memory.supersedes or None,
            )


            # 关系是对称写的，所以从任何一边打开都看得到分歧。放在写入之后是因为
            # 新行必须先存在——link 会校验两端都在库里。
            for peer in peers:
                try:
                    self.storage.link_memory_conflict(memory.id, peer)
                except Exception as e:
                    print(f"[memory] link conflict {memory.id}<->{peer} failed: {e}")
            if peers:
                print(f"[memory] stored as candidate, conflicts with "
                      f"{len(peers)} live memory(ies): {str(memory.content)[:60]!r}")


            # C4：结构化镜像。放在这里而不是写入之前，是因为 evidence 指向的那条
            # 记忆必须先真的存在。
            self._mirror_to_wiki(memory, root, status)

            # C3: newly stored memory must be visible on the very next recall,
            # not up to 15s later when the cache TTL expires. Same for updates
            # to importance/tier — they change what recall should surface.
            self._invalidate_active()
            return Result.success(memory.id)
        except Exception as e:
            return Result.failure(f"Failed to store memory: {e}")

    def _mirror_to_wiki(self, memory: Memory, root: str, status) -> None:
        """认得出三元组的那些事实，顺手在 wiki 里也记一条。

        在这之前 ``WikiStore.add()`` 全系统只有测试调用它：``wiki_claims`` 永远是
        空表，``_render_wiki()`` 永远返回空串，那套结构化冲突检测（同 subject+
        predicate 不同 object）一行都没跑过。一个没有生产者的存储不是"以后再接"，
        它是不存在的功能——而它恰恰能发现自由文本比对发现不了的矛盾：
        "我在 A 工作" vs "我在 B 工作" 没有共同的字面，去掉否定词也不同形，
        ``find_conflicting_memories`` 一辈子看不出这两句冲突。

        三道限制，都是为了不往 prompt 里灌垃圾：
        - 只有 :func:`triple_from_text` 整串认得的句子才镜像，认不出就算了；
        - 只镜像会被召回的行（``active``）。candidate 还没被批准，不该进 prompt；
        - claim id 由 memory id 派生，所以同一条记忆改十次也只有一条 claim。

        失败只打日志：wiki 是附加视图，它坏了不该让一次正常的记忆写入失败。
        """
        if status not in (None, "", "active"):
            return
        try:
            from wiki_store import triple_from_text
            triple = triple_from_text(memory.content)
            if not triple:
                return
            claim_id = f"m-{memory.id}"
            wiki = self.wiki
            if wiki.get(claim_id) is not None:
                return          # 这条记忆已经镜像过了，一次更新不该变成第二条断言
            subject, predicate, obj = triple
            _new, conflicts = wiki.add(
                root_dir=root, subject=subject, predicate=predicate,
                object=obj, statement=memory.content,
                confidence=float(memory.importance or 0.5),
                evidence=[memory.id], source=f"memory:{memory.created_by or ''}",
                claim_id=claim_id,
            )
            if conflicts:
                print(f"[wiki] {subject}/{predicate} 与 {len(conflicts)} 条既有断言"
                      f"冲突，两边都标成 disputed：{obj!r}")
        except Exception as e:  # noqa: BLE001
            print(f"[wiki] 镜像失败（记忆本身已经写好了）：{e}")

    # ------------------------------------------------------------------
    # C1 tier operations
    # ------------------------------------------------------------------

    def working_set(self) -> List[Memory]:
        """Current-turn scratch memories (WORKING tier, never persisted)."""
        return list(self._working)

    def clear_working(self) -> None:
        """Drop the working set. Called at turn boundaries.

        A working note that outlives its turn is a lie — the file it referred to
        may already have been rewritten.
        """
        self._working = []

    def inject_block(self) -> str:
        """Render the always-inject tiers as one budgeted <memory> block.

        Only LONG_TERM and WORKING are injected verbatim; everything else is
        retrieved on demand by :meth:`prefetch`. The per-tier budgets are
        enforced first, then the combined total, because each tier can be
        individually legal while the sum still blows the context window.
        """
        rendered: list[str] = []
        used = 0
        for tier in ALWAYS_INJECT_TIERS:
            pol = policy_for(tier)
            if pol.persisted:
                rows = self.storage.get_memory_entries(
                    root=self._root_dir, limit=200,
                ) or []
                rows = [r for r in rows if normalize_tier(r.get("tier")) == tier]
            else:
                rows = [m.to_dict() for m in self._working]
            if not rows:
                continue

            kept, dropped = trim_to_budget(rows, tier)
            for r in kept:
                cost = estimate_tokens(str(r.get("content", "")))
                if used + cost > TOTAL_INJECT_BUDGET:
                    break
                rendered.append(
                    f'<memory tier="{tier.value}" type="{r.get("type", "fact")}">'
                    f'{r.get("content", "")}</memory>'
                )
                used += cost
            if dropped:
                # Say so rather than silently truncating: a user who edited
                # MEMORY.md past the cap needs to know part of it isn't loaded.
                rendered.append(
                    f'<memory tier="{tier.value}" type="notice">'
                    f'（{tier.value} 超出 {pol.token_budget} token 预算，'
                    f'已按重要度略去 {dropped} 条）</memory>'
                )
        return "\n".join(rendered)

    def note_recall(self, rows: List[dict]) -> None:
        """Record hits for retrieved rows and promote whatever earned it.

        This is the engine of the hierarchy: without a hit count nothing ever
        moves between tiers and the six tiers are just six labels.
        """
        for r in rows:
            eid = r.get("id")
            if not eid:
                continue
            try:
                self.storage.touch_memory_hit(eid)
            except Exception:
                continue
            tier = normalize_tier(r.get("tier"))
            hits = int(r.get("hits", 0) or 0) + 1
            target = should_promote(tier, hits)
            if target is not None and target != tier:
                try:
                    self.storage.set_memory_tier(eid, target.value)
                except Exception:
                    pass  # fail-open: 可选增强，失败不影响主流程

    def sweep_expired(self) -> dict:
        """Archive entries past their tier TTL. Returns per-tier counts.

        Only tiers with a finite TTL are swept — LONG_TERM / SEMANTIC / WIKI
        never expire on a timer, they are only displaced by budget pressure or
        an explicit forget.
        """
        swept: dict[str, int] = {}
        now = time.time()
        for tier in (MemoryTier.SHORT_TERM_RECALL, MemoryTier.DREAMING):
            pol = policy_for(tier)
            if pol.ttl_seconds <= 0:
                continue
            cutoff = now - pol.ttl_seconds
            # limit=None for the same reason as tier_stats: this count feeds the
            # "swept N" report, and a 1000-row cap made before/after both saturate
            # so the delta read 0 while entries were in fact being archived.
            before = len([
                r for r in (self.storage.get_memory_entries(root=self._root_dir, limit=None) or [])
                if normalize_tier(r.get("tier")) == tier
            ])
            try:
                self.storage.expire_memories_by_tier(self._root_dir, tier.value, int(cutoff))
            except Exception:
                continue
            after = len([
                r for r in (self.storage.get_memory_entries(root=self._root_dir, limit=None) or [])
                if normalize_tier(r.get("tier")) == tier
            ])
            swept[tier.value] = max(0, before - after)
        return swept

    def tier_stats(self) -> List[dict]:
        """Per-tier counts / token usage / over-budget flags for the UI.

        Reads with ``limit=None`` on purpose. This used to cap at 2000 rows,
        which meant that past 2000 memories the panel kept rendering confident
        numbers that were simply the first 2000 — counts too low, token totals
        too low, and therefore ``over_budget`` capable of staying false while the
        tier was actually over. A stat panel must either be complete or say it
        isn't; silently truncating is the one option that isn't allowed.
        """
        rows = self.storage.get_memory_entries(root=self._root_dir, limit=None) or []
        rows = list(rows) + [m.to_dict() for m in self._working]
        return summarize_tiers(rows)

    def forget(self, memory_id: str) -> Result:
        """Forget (archive) a memory by ID.

        Args:
            memory_id: Memory identifier.

        Returns:
            Result indicating success or failure.
        """
        try:
            self.storage.archive_memory(memory_id)
            # The archived row must stop showing up in recall immediately;
            # otherwise a user "deletes" a memory and the model still cites it
            # for up to one cache TTL, which reads as the delete having failed.
            self._invalidate_active()
            # Step D：记忆被删/归档同样让依赖它的技能进入待重验——建立在已删
            # 事实上的技能不能再自称有效。辅助账目，绝不反过来让删除失败。
            try:
                self.storage.mark_skills_stale_for_memory(memory_id)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            return Result.success(f"Archived memory: {memory_id}")
        except Exception as e:
            return Result.failure(f"Failed to forget memory: {e}")

    # ------------------------------------------------------------------
    # Entry-level read/write (settings UI control surface)
    #
    # tier_stats() answers "how much is in there"; these answer "what exactly
    # is in there, and let me fix it". Both are needed: a memory the user can
    # see the count of but not the content of is a memory they cannot correct,
    # and a wrong memory that keeps getting injected every turn is worse than
    # no memory at all.
    #
    # The storage layer already had every atomic operation for this
    # (get_memory_entries / save_memory_entry's INSERT OR REPLACE /
    # set_memory_tier / archive_memory). These methods only compose them and
    # own the tier-specific rules that storage has no business knowing.
    # ------------------------------------------------------------------

    def list_entries(
        self,
        tier: Optional[str] = None,
        query: str = "",
        limit: int = 100,
        offset: int = 0,
        root: Optional[str] = None,
        mem_type: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[dict]:

        """Entries with their actual content, for the settings UI.

        ``root`` scopes the query to one workspace. It is an explicit parameter
        rather than a read of ``self._root_dir`` because this layer is a process
        singleton while the app has many workspaces open at once: whoever
        switched last would otherwise decide what every other window sees.
        Callers that genuinely mean "the current one" pass it in from
        ``router.workspace``.

        WORKING is served from the in-process scratch list rather than SQLite —
        it is never persisted, so a DB query would always return nothing and the
        panel would claim the tier is empty while the model is actively using it.
        Those rows come back flagged ``editable: False``: editing a note that is
        wiped at the next turn boundary would be a lie.

        WIKI lives in its own claims table with confidence/evidence semantics and
        has a dedicated endpoint; it is intentionally not merged in here.

        ``status`` 筛生命周期状态：``None`` 用
        ``memory_domain.UI_DEFAULT_STATUSES``（活的 + 过期的，不含墓碑），
        ``"all"`` 表示全部，其他值按精确匹配。0013 之前这里用的是
        ``include_archived=False``，而那个条件在 0013 之后会把 ``stale`` 也挡掉——
        于是过期的记忆既不进 prompt、界面上也不存在，用户没法把它救回来。
        """
        want = normalize_tier(tier).value if tier else ""
        want_type = (mem_type or "").strip().lower()
        scope = root or self._root_dir

        if want == MemoryTier.WORKING.value:
            rows = [m.to_dict() for m in self._working]
        else:
            # Over-fetch: get_memory_entries has no tier predicate, so the tier
            # filter happens in Python. Asking for exactly `limit` rows would
            # under-fill any tier that isn't the most recently written one.
            raw = self.storage.get_memory_entries(
                root=scope,
                mem_type=want_type or None,
                include_archived=True,
                limit=2000,
            ) or []
            rows = self._filter_by_status(list(raw), status)
            if want:
                rows = [r for r in rows if normalize_tier(r.get("tier")).value == want]


        needle = (query or "").strip().lower()
        if needle:
            rows = [r for r in rows if needle in str(r.get("content") or "").lower()]

        rows.sort(key=lambda r: float(r.get("updated_at") or r.get("created_at") or 0), reverse=True)
        window = rows[offset:offset + max(1, int(limit))]
        return [self._public_entry(r) for r in window]

    def count_entries(
        self,
        tier: Optional[str] = None,
        query: str = "",
        root: Optional[str] = None,
        mem_type: Optional[str] = None,
        status: Optional[str] = None,
    ) -> int:
        """How many entries match — so the UI can paginate honestly."""
        want = normalize_tier(tier).value if tier else ""
        want_type = (mem_type or "").strip().lower()
        if want == MemoryTier.WORKING.value:
            rows: List[dict] = [m.to_dict() for m in self._working]
        else:
            raw = self.storage.get_memory_entries(
                root=root or self._root_dir,
                mem_type=want_type or None,
                include_archived=True,
                limit=2000,
            ) or []
            rows = [r for r in self._filter_by_status(list(raw), status)
                    if not want or normalize_tier(r.get("tier")).value == want]
        needle = (query or "").strip().lower()
        if needle:
            rows = [r for r in rows if needle in str(r.get("content") or "").lower()]
        return len(rows)

    @staticmethod
    def _filter_by_status(rows: List[dict], status: Optional[str]) -> List[dict]:
        """按生命周期状态筛行。``"all"`` 放行全部，``None`` 用 UI 默认集合。

        兼容 0013 之前的行：``status`` 列为空时按 ``archived`` 列推断，否则老库
        升级后那些行会因为"状态不在集合里"整批消失。
        """
        from memory_domain import UI_DEFAULT_STATUSES
        want = (status or "").strip().lower()
        if want == "all":
            return rows

        def _st(r: dict) -> str:
            s = str(r.get("status") or "")
            if s:
                return s
            return "archived" if int(r.get("archived") or 0) else "active"

        allow = {want} if want else set(UI_DEFAULT_STATUSES)
        return [r for r in rows if _st(r) in allow]


    def last_dream_at(self, root: Optional[str] = None) -> float:
        """When this workspace last completed a dream pass (epoch seconds)."""
        scope = root if root is not None else self._root_dir
        try:
            row = self.storage._db("memory").execute(
                "SELECT last_dream_at FROM project_memory_index WHERE root_dir=?",
                (scope,),
            ).fetchone()
            if row and row["last_dream_at"]:
                return float(row["last_dream_at"])
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        return 0.0

    def list_roots(self) -> List[dict]:
        """Workspaces that actually hold memories: ``[{root, count}]``.

        Powers the settings picker. Deliberately reports what the memory table
        knows rather than what the workspace registry knows — a memory written
        under a path that was later un-registered would otherwise become
        unreachable from the UI while still being injected into prompts.
        """
        try:
            return self.storage.list_memory_roots() or []
        except Exception:
            return []

    def _public_entry(self, row: dict) -> dict:
        """Shape one row for the API: camelCase, tags decoded, tier policy applied.

        生命周期字段（status / confidence / live / 最后确认时间）从
        ``memory_domain`` 取，而不是在这里各读一遍列：那些字段的口径（尤其
        ``live`` 要把惰性过期算进去）只应该有一个定义，否则界面显示"生效中"
        而召回已经跳过它，用户根本没法知道。
        """
        tier = normalize_tier(row.get("tier"))
        pol = policy_for(tier)
        tags = row.get("tags")
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except (json.JSONDecodeError, TypeError):
                tags = []
        content = str(row.get("content") or "")
        out = {
            "id": row.get("id") or "",
            "content": content,
            "type": row.get("type") or MemoryType.FACT,
            "tier": tier.value,
            "importance": float(row.get("importance") or 0.0),
            "tags": tags or [],
            "hits": int(row.get("hits") or 0),
            "createdAt": float(row.get("created_at") or 0),
            "updatedAt": float(row.get("updated_at") or 0),
            "tokens": estimate_tokens(content),
            # WORKING is wiped every turn, so offering an edit box would be a lie.
            "editable": bool(pol.persisted),
        }
        try:
            from memory_domain import item_from_entry
            lc = item_from_entry(row).to_api()
        except Exception:
            return out
        for key in ("kind", "status", "live", "confidence", "source",
                    "supersededBy", "statusReason", "validUntil",
                    "lastConfirmedAt", "sensitivity", "sourceGoalId",
                    "sourceEventIds", "validFrom"):
            out[key] = lc[key]

        # WORKING 行来自内存里的 scratch list，没有 status 列，item_from_entry
        # 会兜底成 active。它每轮都被清空，说它"生效中"是对的，但不可编辑这一点
        # 由上面的 tier policy 决定，这里不覆盖。
        return out


    def update_entry(
        self,
        memory_id: str,
        content: Optional[str] = None,
        tier: Optional[str] = None,
        importance: Optional[float] = None,
        tags: Optional[List[str]] = None,
        root: Optional[str] = None,
    ) -> Result:
        """Edit one stored memory in place. Only non-None fields change.

        ``root`` narrows the lookup to one workspace. Passing None searches every
        workspace: ids are unique, so an edit issued from a settings page that is
        pointed at another workspace still lands instead of 404-ing.

        Re-embeds when the text changed — leaving a stale vector behind would
        make the edited memory retrievable by its OLD wording and invisible under
        its new wording, which is the most confusing possible outcome of an edit.
        """
        try:
            rows = self.storage.get_memory_entries(
                root=root, include_archived=True, limit=5000
            ) or []
            row = next((r for r in rows if r.get("id") == memory_id), None)
            if row is None:
                return Result.failure(f"No such memory: {memory_id}")

            old_content = str(row.get("content") or "")
            new_content = old_content if content is None else str(content).strip()
            if not new_content:
                return Result.failure("Memory content cannot be empty")

            existing_tags = row.get("tags")
            if isinstance(existing_tags, str):
                try:
                    existing_tags = json.loads(existing_tags)
                except (json.JSONDecodeError, TypeError):
                    existing_tags = []
            new_tags = existing_tags or [] if tags is None else list(tags)

            new_tier = normalize_tier(tier) if tier else normalize_tier(row.get("tier"))
            if not policy_for(new_tier).persisted:
                return Result.failure(
                    f"Tier '{new_tier.value}' is not persisted and cannot hold an edited entry"
                )

            new_importance = (
                float(row.get("importance") or 0.5) if importance is None else float(importance)
            )

            # Only pay for an embedding when the text actually moved.
            if new_content != old_content:
                emb = self._embed_text(new_content)
                emb_blob = json.dumps(emb).encode("utf-8") if emb else None
            else:
                emb_blob = row.get("embedding")

            self.storage.save_memory_entry(
                eid=memory_id,
                sid=row.get("session_id") or "",
                root=row.get("root_dir") or self._root_dir,
                scope=row.get("scope") or MemoryScope.PROJECT,
                content=new_content,
                emb=emb_blob,
                meta={"tags": new_tags, "edited_by": "user"},
                mem_type=row.get("type") or MemoryType.FACT,
                importance=new_importance,
                tags=new_tags,
                archived=0,
                tier=new_tier.value,
                hits=int(row.get("hits") or 0),
                accessed_at=int(row.get("accessed_at") or 0),
            )
            # save_memory_entry keeps the old tier when handed the 'semantic'
            # default, so an explicit demotion TO semantic needs the direct call.
            if tier:
                self.storage.set_memory_tier(memory_id, new_tier.value)
            self._invalidate_active()
            # Step D：内容被编辑过的记忆同样触发依赖技能的待重验标记。
            try:
                self.storage.mark_skills_stale_for_memory(memory_id)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            return Result.success(memory_id)
        except Exception as e:
            return Result.failure(f"Failed to update memory: {e}")

    def forget_tag(self, tag: str) -> Result:
        """Forget all memories with a given tag.

        Args:
            tag: Tag string to match.

        Returns:
            Result with count of archived memories.
        """
        try:
            all_mems = self.storage.get_memory_entries(
                root=self._root_dir, include_archived=False, limit=None
            )
            count = 0
            for m in all_mems:
                tags_raw = m.get("tags", "[]")
                try:
                    tags = json.loads(tags_raw) if isinstance(tags_raw, str) else tags_raw
                except (json.JSONDecodeError, TypeError):
                    tags = []
                if tag in tags:
                    self.storage.archive_memory(m.get("id"))
                    count += 1
            return Result.success(f"Forgot {count} memories with tag: {tag}")
        except Exception as e:
            return Result.failure(f"Failed to forget by tag: {e}")

    def get_stats(self) -> dict:
        """Get memory statistics.

        Returns:
            Dict with total count and breakdown by type.
        """
        all_mems = self.storage.get_memory_entries(
            root=self._root_dir, include_archived=True, limit=None
        )
        by_type: dict[str, int] = {}
        for m in all_mems:
            t = m.get("type", "unknown")
            by_type[t] = by_type.get(t, 0) + 1
        return {
            "total": len(all_mems),
            "by_type": by_type,
        }

    def prune_stale_memories(self, root_dir: str = "", max_age_days: int = 180) -> dict:
        """闲时梦境记忆修剪与陈旧事实证伪 (Phase 62 核心硬内化)。
        
        主动反向证伪与修剪：
        1. 识别并归档/物理清理 superseded / 超过 max_age_days 且低频未命中的陈旧记忆；
        2. 清理孤立实体节点 (degree 0)；
        3. 返回修剪前后的存储预算统计与释放空间。
        """
        actual_root = root_dir or self._root_dir
        c = self.storage._db("memory")
        now = time.time()
        cutoff_ts = now - (max_age_days * 86400.0)

        all_before = c.execute(
            "SELECT id, content, status, hits, updated_at, created_at FROM memory_entries "
            "WHERE (root_dir=? OR root_dir='') AND status!='archived'",
            (actual_root,)
        ).fetchall()
        budget_before = MemoryIndexCapper.get_budget_stats([dict(m) for m in all_before])

        pruned_count = 0
        retired_count = 0

        # 1. 归档已被 supersede 的旧记录
        superseded_rows = c.execute(
            "SELECT id FROM memory_entries WHERE (root_dir=? OR root_dir='') AND status='superseded'",
            (actual_root,)
        ).fetchall()
        for r in superseded_rows:
            c.execute("UPDATE memory_entries SET status='archived', updated_at=? WHERE id=?", (now, r["id"]))
            retired_count += 1

        # 2. 归档超期且从未被成功召回的陈旧记忆 (hits <= 0)
        stale_rows = c.execute(
            "SELECT id FROM memory_entries WHERE (root_dir=? OR root_dir='') AND status='active' "
            "AND created_at < ? AND (hits IS NULL OR hits <= 0)",
            (actual_root, cutoff_ts)
        ).fetchall()
        for r in stale_rows:
            c.execute("UPDATE memory_entries SET status='archived', updated_at=? WHERE id=?", (now, r["id"]))
            pruned_count += 1

        # 3. 清理孤儿图谱节点 (没有相连边且超过 30 天未更新)
        orphan_nodes_removed = 0
        try:
            orphan_nodes = c.execute(
                "SELECT id FROM graph_entities WHERE (root_dir=? OR root_dir='') "
                "AND id NOT IN (SELECT source_id FROM graph_relations UNION SELECT target_id FROM graph_relations) "
                "AND created_at < ?",
                (actual_root, now - 30 * 86400.0)
            ).fetchall()
            for o in orphan_nodes:
                c.execute("DELETE FROM graph_entities WHERE id=?", (o["id"],))
                orphan_nodes_removed += 1
        except Exception:
            pass

        c.commit()
        self._invalidate_active()

        all_after = c.execute(
            "SELECT id, content, status, hits, updated_at, created_at FROM memory_entries "
            "WHERE (root_dir=? OR root_dir='') AND status!='archived'",
            (actual_root,)
        ).fetchall()
        budget_after = MemoryIndexCapper.get_budget_stats([dict(m) for m in all_after])
        freed_bytes = max(0, budget_before["used_bytes"] - budget_after["used_bytes"])


        return {
            "root_dir": actual_root,
            "pruned_count": pruned_count,
            "retired_count": retired_count,
            "orphan_nodes_removed": orphan_nodes_removed,
            "freed_bytes": freed_bytes,
            "budget_before": budget_before,
            "budget_after": budget_after,
        }


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_layer: Optional[MemoryLayer] = None


def get_memory_layer(
    llm_callback: Optional[Callable] = None,
    embed_callback: Optional[Callable] = None,
    storage: Optional[Any] = None,
    root_dir: str = "",
) -> MemoryLayer:
    """Get the global MemoryLayer singleton."""
    global _layer
    if _layer is None:
        _layer = MemoryLayer(llm_callback=llm_callback, embed_callback=embed_callback, storage=storage, root_dir=root_dir)
        return _layer
    if storage is not None and _layer.storage is None:
        _layer.storage = storage
    if root_dir and not _layer._root_dir:
        _layer._root_dir = root_dir
    if llm_callback is not None and _layer._llm is None:
        _layer._llm = llm_callback
        _layer._extractor._llm = llm_callback
        _layer._dreamer._llm = llm_callback
    if embed_callback is not None and _layer._embed is None:
        _layer.set_embed_callback(embed_callback)
    return _layer



# ---------------------------------------------------------------------------
# Phase 59 内化: 实体图谱记忆引擎 (GraphMemoryEngine)
# ---------------------------------------------------------------------------

class GraphMemoryEngine:
    """Phase 59 内化模块: 实体关系图谱长期记忆引擎。
    
    从 ontology 技能提纯，提供强类型三元组 (Subject, Predicate, Object)
    存储、更新与多跳图拓扑关联召回。
    """
    def __init__(self, storage=None) -> None:
        self._storage = storage or get_storage()

    def ingest_triplet(
        self,
        root_dir: str,
        subject: str,
        predicate: str,
        object_val: str,
        subject_type: str = "Concept",
        object_type: str = "Concept",
        confidence: float = 1.0,
        properties: Optional[dict] = None
    ) -> str:
        """抽取并沉淀一条语义三元组边。"""
        try:
            from sanitizer import PrivacySanitizer
            clean_subj = PrivacySanitizer.clean(subject, workspace_root=root_dir)
            clean_obj = PrivacySanitizer.clean(object_val, workspace_root=root_dir)
        except Exception:
            clean_subj, clean_obj = subject, object_val

        return self._storage.upsert_graph_relation(
            root_dir=root_dir,
            source_name=clean_subj,
            target_name=clean_obj,
            relation_type=predicate,
            confidence=confidence,
            source_type=subject_type,
            target_type=object_type
        )

    def recall_associative_graph(self, entity_name: str, root_dir: str = "", max_hops: int = 2) -> list[dict]:
        """关联召回与当前实体相连的所有拓扑边。"""
        try:
            from sanitizer import PrivacySanitizer
            clean_ent = PrivacySanitizer.clean(entity_name, workspace_root=root_dir)
        except Exception:
            clean_ent = entity_name
        return self._storage.query_related_entities(clean_ent, root_dir=root_dir, max_hops=max_hops)

    def format_graph_for_prompt(self, related_edges: list[dict]) -> str:
        """将图谱关系格式化为适合 LLM 注入的紧凑上下文。"""
        if not related_edges:
            return ""
        lines = ["<knowledge_graph>"]
        for edge in related_edges:
            lines.append(f"- ({edge.get('source')}) --[{edge.get('relation')}]--> ({edge.get('target')}) [置信度: {edge.get('confidence', 1.0)}]")
        lines.append("</knowledge_graph>")
        return "\n".join(lines)


_graph_engine: Optional[GraphMemoryEngine] = None


def get_graph_memory_engine(storage=None) -> GraphMemoryEngine:
    """获取 GraphMemoryEngine 全局单例。"""
    global _graph_engine
    if _graph_engine is None:
        _graph_engine = GraphMemoryEngine(storage=storage)
    return _graph_engine


# ---------------------------------------------------------------------------
# Phase 62 内化: 记忆容量预算与索引约束器 (MemoryIndexCapper)
# ---------------------------------------------------------------------------

class MemoryIndexCapper:
    """生产级记忆容量预算与索引约束器 (Phase 62 核心硬内化)。

        - 索引必须保持精炼，单行建议不超过 150 字符；
    - 注入总容量物理封顶 25KB (25,600 Bytes)，杜绝记忆污染上下文与撑爆 Prompt Cache；
    - 超额自动按相关度/置信度截断保留最核心的高价值记忆。
    """

    MAX_LINE_CHARS = 150
    MAX_BUDGET_BYTES = 25600  # 25 KB

    @classmethod
    def cap_entry_line(cls, text: str, max_chars: int = MAX_LINE_CHARS) -> str:
        """单条记忆索引行长修剪."""
        if not text or len(text) <= max_chars:
            return text or ""
        return text[:max_chars - 3].rstrip() + "..."

    @classmethod
    def enforce_budget(cls, blocks: list[str], max_bytes: int = MAX_BUDGET_BYTES) -> list[str]:
        """对记忆 XML 块列表进行 25KB 物理预算封顶裁决."""
        accepted = []
        current_bytes = 0
        for b in blocks:
            b_bytes = len(b.encode("utf-8"))
            if current_bytes + b_bytes > max_bytes:
                # 尝试压缩或停止追加
                if not accepted:
                    truncated_b = b.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")
                    accepted.append(truncated_b)
                break
            accepted.append(b)
            current_bytes += b_bytes
        return accepted

    @classmethod
    def get_budget_stats(cls, memory_entries: list[dict], max_bytes: int = MAX_BUDGET_BYTES) -> dict:
        """计算当前记忆库容量预算统计."""
        total_bytes = sum(len(str(m.get("content", "")).encode("utf-8")) for m in memory_entries)
        return {
            "used_bytes": total_bytes,
            "max_bytes": max_bytes,
            "usage_ratio": round(min(1.0, total_bytes / max(1, max_bytes)), 4),
            "entries_count": len(memory_entries),
            "healthy": total_bytes <= max_bytes,
        }


