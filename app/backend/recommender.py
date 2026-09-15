"""
recommender.py - Capability recommendation ranking + cache.

The blueprint's recommendation link: for a user request, locally scan available
capabilities (skills + registered tools), score them against the request, and
return a ranked shortlist — cached so repeat asks are instant.

Scan -> score -> cache, all local (no network). The cache is TTL'd and backed
by the kv store so it survives within a session; scoring is keyword-overlap
based (name + description + domain) with small trust/risk adjustments.

Two consumers:
  - the ``recommend`` tool, when the model wants to ask "what do I have for
    this?" explicitly;
  - ``mount(bus)``, which rides ``user_prompt_submit`` and drops a short
    shortlist into ``context["capability_hints"]`` for the TOOLS prompt layer.
    Without that second path the ranking existed but nothing in the main loop
    ever consulted it, so a relevant skill stayed invisible unless the model
    happened to go looking for it.
"""
from __future__ import annotations

import re
import time
import hashlib
from typing import Any, Optional

from result import Result
from storage import get_storage

_CACHE_NS = "recommender"
_CACHE_TTL = 300  # seconds

#: Prompt-injection thresholds. A keyword-overlap score is a weak signal, so the
#: bar is set where a hit means the request literally shares vocabulary with the
#: capability's name/description. Below it we inject nothing at all — a wrong
#: hint costs more than a missing one, because it points the model at a tool it
#: then has to reject.
_HINT_MIN_SCORE = 0.34
_HINT_MAX_ITEMS = 3
#: Below this, a message is too short for token overlap to mean anything
#: ("ok", "继续", "yes").
_HINT_MIN_QUERY_LEN = 4


def _tokens(text: str) -> set[str]:
    return {t for t in re.split(r"\W+", (text or "").lower()) if len(t) > 1}


class Recommender:
    """Rank local capabilities against a request, with a TTL cache."""

    def __init__(self) -> None:
        self.storage = get_storage()

    def _score(self, query_tokens: set[str], *fields: str) -> float:
        """Overlap score in [0,1]: fraction of query tokens hit in the fields."""
        if not query_tokens:
            return 0.0
        hay = _tokens(" ".join(f for f in fields if f))
        if not hay:
            return 0.0
        hits = sum(1 for t in query_tokens if t in hay)
        return hits / len(query_tokens)

    def _scan_skills(self, query_tokens: set[str]) -> list[dict]:
        try:
            from skill_loader import get_skill_loader
            skills = get_skill_loader().list_skills(include_disabled=True)
        except Exception:
            return []
        out = []
        for s in skills:
            score = self._score(query_tokens, s.get("name", ""), s.get("description", ""))
            # Trust nudges enabled/own skills slightly ahead of untrusted ones.
            if s.get("trust") == "own":
                score += 0.05
            if s.get("status") == "disabled":
                score -= 0.1
            if score > 0:
                out.append({"kind": "skill", "name": s.get("name"),
                            "score": round(score, 4),
                            "description": (s.get("description") or "")[:160],
                            "status": s.get("status")})
        return out

    def _scan_tools(self, query_tokens: set[str]) -> list[dict]:
        try:
            from tools import get_tool_registry
            tools = get_tool_registry().list_tools()
        except Exception:
            return []
        out = []
        for t in tools:
            score = self._score(query_tokens, t.name, t.description, t.domain)
            # De-prioritize high-risk tools so recommendations lean safe-first.
            if getattr(t, "risk_level", "low") == "high":
                score -= 0.05
            if score > 0:
                out.append({"kind": "tool", "name": t.name,
                            "score": round(score, 4),
                            "description": (t.description or "")[:160],
                            "domain": t.domain, "risk_level": t.risk_level})
        return out

    def _cache_key(self, query: str, kinds: tuple, scope: str = "") -> str:
        """Hash the query *and its scope* into a kv key.

        ``scope`` is the workspace path. It has to be part of the key: skills are
        loaded per workspace, so the same question asked in two projects has two
        different correct answers. Without it the first project to ask warms a
        global entry and the second one reads back a shortlist naming skills it
        does not have, for the whole 5-minute TTL.
        """
        raw = f"{scope}|{query}|{','.join(sorted(kinds))}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def recommend(self, query: str, limit: int = 5,
                  kinds: tuple = ("skill", "tool"), use_cache: bool = True,
                  scope: str = "") -> dict:
        """Return a ranked shortlist of capabilities for ``query``.

        Args:
            query: The user request / intent.
            limit: Max results.
            kinds: Which capability kinds to include ("skill", "tool").
            use_cache: Read/write the TTL cache when True.
            scope: Workspace path the answer is valid for (cache isolation).

        Returns:
            ``{"query", "results": [...], "cached": bool}``.
        """
        key = self._cache_key(query, tuple(kinds), scope)
        if use_cache:
            cached = self.storage.kv_get(key, ns=_CACHE_NS)
            if isinstance(cached, dict) and (time.time() - cached.get("ts", 0)) < _CACHE_TTL:
                return {"query": query, "results": cached.get("results", []), "cached": True}

        qtokens = _tokens(query)
        results: list[dict] = []
        if "skill" in kinds:
            results.extend(self._scan_skills(qtokens))
        if "tool" in kinds:
            results.extend(self._scan_tools(qtokens))
        results.sort(key=lambda r: -r["score"])
        results = results[:limit]

        if use_cache:
            self.storage.kv_set(key, {"ts": time.time(), "results": results}, ns=_CACHE_NS)
        return {"query": query, "results": results, "cached": False}

    def clear_cache(self) -> None:
        """Drop cached recommendations (best-effort)."""
        try:
            c = self.storage._db("kv")
            c.execute("DELETE FROM kv_store WHERE namespace=?", (_CACHE_NS,))
            c.commit()
        except Exception as _e:
            print(f"[recommender] operation FAILED: {_e}")

    # ------------------------------------------------------------------
    # Prompt injection (main loop)
    # ------------------------------------------------------------------

    def render_hints(self, query: str, scope: str = "",
                     limit: int = _HINT_MAX_ITEMS,
                     min_score: float = _HINT_MIN_SCORE) -> str:
        """Render a short capability shortlist for the TOOLS prompt layer.

        Returns ``""`` whenever the signal is weak, which is the common case —
        an ordinary turn should cost zero extra tokens. The block is worded as a
        hint, not an instruction: the score is keyword overlap, so it is often
        right about the topic and wrong about the specific capability, and the
        model must stay free to ignore it.
        """
        q = (query or "").strip()
        if len(q) < _HINT_MIN_QUERY_LEN:
            return ""
        ranked = self.recommend(q, limit=max(limit, 1), scope=scope).get("results", [])
        picked = [r for r in ranked
                  if float(r.get("score") or 0) >= min_score
                  and r.get("status") != "disabled"]
        if not picked:
            return ""

        lines = [
            "## Possibly Relevant Capabilities",
            "本地按关键词重合度排出来的候选，仅供参考——不是「必须用这个」。"
            "不相关就直接忽略，别为了用上它而绕路。",
        ]
        for r in picked:
            desc = (r.get("description") or "").replace("\n", " ").strip()
            lines.append(f"- [{r.get('kind')}] {r.get('name')} — {desc}")
        return "\n".join(lines)

    def mount(self, bus: Any) -> None:
        """Subscribe to ``user_prompt_submit`` to publish per-turn hints.

        Priority 20 puts this after memory_layer's own injector (priority 10);
        both only add keys to the same context dict, so the order just keeps the
        cheap one from delaying the one that does real recall work.
        """
        bus.on("user_prompt_submit", self._on_user_prompt, priority=20)

    def _on_user_prompt(self, event: Any) -> None:
        """Write ``context["capability_hints"]`` for this turn (best-effort)."""
        payload = getattr(event, "payload", None) or {}
        context = payload.get("context")
        if not isinstance(context, dict):
            return
        try:
            block = self.render_hints(
                payload.get("message", ""),
                scope=str(payload.get("workspace") or ""),
            )
        except Exception:
            return  # a ranking miss must never cost the user a turn
        if block:
            context["capability_hints"] = block



def _recommend_impl(args, ctx):
    rec = get_recommender()
    return Result.success(rec.recommend(
        args.get("query", ""),
        limit=args.get("limit", 5),
    ))


def register_tools(registry=None) -> None:
    """Register the ``recommend`` tool."""
    from tools import ToolDef, get_tool_registry
    registry = registry or get_tool_registry()
    registry.register(ToolDef(
        "recommend",
        "Recommend the most relevant skills/tools for a request (scan -> score -> cache).",
        {"type": "object", "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer", "default": 5},
        }, "required": ["query"]},
        _recommend_impl, domain="general", risk_level="low",
    ))


_recommender: Optional[Recommender] = None


def get_recommender() -> Recommender:
    global _recommender
    if _recommender is None:
        _recommender = Recommender()
    return _recommender
