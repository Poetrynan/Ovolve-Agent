"""llm_client.py - Unified LLM client for Ovolve.

Connects the router / goal_manager / memory_layer to the configured LLM provider
(OpenAI-compatible Chat Completions API). Supports:
  - Streaming & non-streaming
  - Reasoning models (reasoning_content field, e.g. LongCat-2.0)
  - Token usage tracking via model_registry
  - Retry with exponential backoff
  - System prompt injection (environment snapshot + memory + goal context)

The router calls ``llm_client.chat(messages, ...)`` to get a completion. Other
modules (memory extraction, goal verification, commit-message generation) use
``llm_client.call(prompt_dict)`` which wraps a single user-turn call.
"""
from __future__ import annotations

import asyncio
import copy
import json
import time
import urllib.error
import urllib.request
from typing import Any, AsyncGenerator, Optional

from result import Result
from telemetry import get_telemetry, SpanName
from rate_limiter import get_rate_limiter
from prompt_cache_planner import plan_cache_breakpoints
from stream_scrubber import StreamingThinkScrubber, scrub_static

try:
    import aiohttp
    _HAS_AIOHTTP = True
except ImportError:
    aiohttp = None  # type: ignore
    _HAS_AIOHTTP = False


def _parse_retry_after(value) -> float:
    """``Retry-After`` → seconds. Accepts the delta-seconds form only.

    The HTTP-date form exists but no provider we talk to uses it, and guessing a
    clock skew wrong would be worse than falling back to 0 (which just means
    "use our own bucket model instead of theirs").
    """
    try:
        return max(0.0, float(str(value).strip()))
    except (TypeError, ValueError):
        return 0.0


#: Provider kinds whose wire format understands `cache_control`. Both are the
#: Claude family (`oauth` is Claude too — see model_registry's ProviderConfig).
#: Anything else gets no breakpoint at all rather than a field it might reject.
_CACHE_BREAKPOINT_KINDS = frozenset({"anthropic", "oauth"})

#: Below this, a cache entry isn't worth writing. Anthropic won't cache short
#: prefixes anyway, and asking it to costs a write surcharge for a read that
#: never happens. Characters, not tokens, because this runs before tokenizing —
#: ~4 chars/token puts this in the right ballpark for the 1024-token floor.
CACHE_PREFIX_MIN_CHARS = 4000

_SESSION_POOL: dict[str, Any] = {}


async def _get_shared_session(timeout_s: float) -> Any:
    """Get or create an aiohttp.ClientSession with connection pooling, keepalive and DNS caching."""
    if not _HAS_AIOHTTP:
        return None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    loop_id = str(id(loop))
    session = _SESSION_POOL.get(loop_id)
    if session is None or session.closed:
        connector = aiohttp.TCPConnector(
            limit=100,
            limit_per_host=20,
            keepalive_timeout=30.0,
            ttl_dns_cache=300,
            enable_cleanup_closed=True,
        )
        timeout = aiohttp.ClientTimeout(total=timeout_s, connect=10.0)
        session = aiohttp.ClientSession(connector=connector, timeout=timeout)
        _SESSION_POOL[loop_id] = session
    return session


async def close_shared_sessions() -> None:
    """Close all pooled aiohttp sessions during shutdown."""
    for session in list(_SESSION_POOL.values()):
        if session and not session.closed:
            try:
                await session.close()
            except Exception:
                pass
    _SESSION_POOL.clear()


class LLMClient:
    """OpenAI-compatible Chat Completions client.

    Reads provider config from config.json's ``model`` section. Works with
    any OpenAI-compatible endpoint (OpenAI, Anthropic via proxy, LongCat, etc).

    LongCat-2.0 specifics:
      - ``message.reasoning_content`` contains the chain of thought
      - ``message.content`` is the final answer (may be None with low max_tokens)
      - ``finish_reason="length"`` means max_tokens was too low for an answer

    Args:
        config: The top-level config dict (loaded from config.json).
    """

    DEFAULT_MAX_TOKENS: int = 65536
    DEFAULT_TIMEOUT: int = 120
    RETRY_DELAYS: list[float] = [1.0, 2.0, 4.0, 8.0, 16.0]

    def __init__(self, config: dict) -> None:
        model_cfg = config.get("model", {})
        self.model_id: str = model_cfg.get("model_id", "LongCat-2.0")
        self.api_key: str = model_cfg.get("api_key", "")
        self.base_url: str = (model_cfg.get("base_url") or "").rstrip("/")
        self.max_tokens: int = model_cfg.get("max_tokens", self.DEFAULT_MAX_TOKENS)
        self.temperature: float = float(model_cfg.get("temperature", 0.0))
        self.context_limit: int = model_cfg.get("context_limit", 200000)
        #: Wall-clock ceiling for one streamed request (`model.stream_timeout_s`,
        #: user-tunable from the settings page). Slow reasoning models legitimately
        #: think for minutes, so the default is generous; clamped >= 30s so a bad
        #: hand-edit cannot insta-fail every call.
        try:
            self.timeout_s: int = max(30, int(model_cfg.get("stream_timeout_s") or self.DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            self.timeout_s = self.DEFAULT_TIMEOUT
        #: The model's own output ceiling, when the registry knows it. 0 = unknown,
        #: and the thinking-budget math falls back to a conservative constant.
        self.output_limit: int = int(model_cfg.get("output_limit") or 0)
        #: Provider protocol (``anthropic`` / ``openai-compatible`` / …). Needed
        #: because the reasoning knob's wire format depends on it, not just on the
        #: model name (a Claude behind an OpenAI-compatible proxy speaks a
        #: different dialect than Anthropic's own API).
        self.kind: str = str(model_cfg.get("kind") or "")
        #: 缓存断点 TTL 档位（``model.cache_ttl``）。空串 = 5 分钟自动过期
        #: （默认，写入不加价）；"1h" = 1 小时档，写入费翻倍，换长闲置会话
        #: 继续命中。规划器端有白名单，乱值在这里就会被丢弃。
        self.cache_ttl: str = str(model_cfg.get("cache_ttl") or "")
        #: Which registry provider this client is pointed at, when it was bound
        #: from one. Empty for the config-seeded default. Needed so a failure can
        #: be attributed to a provider rather than only to a model name — the
        #: cooldown in UD2 is per provider, because that is what goes down.
        self.provider_id: str = ""
        #: Default thinking level for calls made through this client, used when
        #: the caller doesn't pass one. Set by :meth:`bind_scene` so background
        #: work (commit subjects, memory extraction) stops inheriting whatever the
        #: user picked for the conversation. Empty = never mention the parameter.
        self.effort: str = ""
        #: The provider's three-state thinking declaration for this model:
        #: ``None`` = not declared (infer from the model family), ``True`` =
        #: forced on, ``False`` = forced off. Kept as a tri-state rather than a
        #: bool because "the user never said" and "the user said no" have to
        #: produce different request bodies.
        self.effort_supported: Optional[bool] = None
        self._telemetry = get_telemetry()

    @property
    def endpoint(self) -> str:
        """Full chat completions URL."""
        return f"{self.base_url}/chat/completions"

    def bind(self, resolved: dict) -> "LLMClient":
        """Return a clone of this client pointed at a different model/provider.

        ``resolved`` is a :meth:`ModelRegistry.resolve` payload. A clone rather
        than a mutation because turns run concurrently: flipping ``self.model_id``
        for one request would silently retarget every other in-flight call.
        Empty or missing fields keep this client's value, so a partial resolve
        degrades to today's behaviour instead of producing an unusable client.

        Returns ``self`` when nothing would actually change, so callers can use
        the result unconditionally without paying for a copy per turn.
        """
        if not isinstance(resolved, dict):
            return self
        model_id = str(resolved.get("model_id") or "").strip() or self.model_id
        api_key = str(resolved.get("api_key") or "") or self.api_key
        base_url = (str(resolved.get("base_url") or "").strip() or self.base_url).rstrip("/")
        ctx = int(resolved.get("context_limit") or 0) or self.context_limit
        out_lim = int(resolved.get("output_limit") or 0) or self.output_limit
        pid = str(resolved.get("provider_id") or "") or self.provider_id
        kind = str(resolved.get("kind") or "") or self.kind
        # Tri-state: absence of the KEY means "this payload doesn't carry a
        # declaration, keep ours", while a present `None` means "explicitly not
        # declared". `or` would collapse both of those into the current value and
        # make an explicit False unreachable.
        declared = (resolved["supports_thinking_declared"]
                    if "supports_thinking_declared" in resolved
                    else self.effort_supported)
        if (model_id, api_key, base_url, ctx, out_lim, pid, kind, declared) == (
            self.model_id, self.api_key, self.base_url, self.context_limit,
            self.output_limit, self.provider_id, self.kind, self.effort_supported,
        ):
            return self

        clone = copy.copy(self)  # shallow: telemetry and config are shared on purpose
        clone.model_id = model_id
        clone.api_key = api_key
        clone.base_url = base_url
        clone.context_limit = ctx
        clone.output_limit = out_lim
        clone.provider_id = pid
        clone.kind = kind
        clone.effort_supported = declared
        return clone

    def bind_scene(self, scene: str) -> "LLMClient":
        """A clone pointed at the cheapest model that fits ``scene`` (UD1).

        ``scene`` is one of ``model_registry.SCENES`` — "what is this call for",
        not "which model". Writing a commit subject, extracting a memory and
        summarizing a fold do not need the model the user picked for reasoning,
        and until this existed they all reused it because every internal module
        was handed ``get_llm_client().call``.

        Falls back to ``self`` on any failure, so a registry that cannot answer
        (empty, unseeded, mid-reload) leaves behaviour exactly as it was.

        Also stamps the scene's thinking level (UD4) on the clone, which is why a
        scene with no model preference can still change behaviour: pointing a
        commit-message call at the same model but with thinking off is a real win.
        """
        if not scene:
            return self
        try:
            from model_registry import get_model_registry, scene_effort
            info = get_model_registry().resolve(scene=scene)
            effort = scene_effort(scene)
        except Exception:
            return self
        bound = self
        if info.ok and isinstance(info.value, dict):
            bound = self.bind(info.value)
        if effort and effort != bound.effort:
            # Never mutate in place: `bind` returns `self` when nothing about the
            # model changed, and writing the scene's effort onto it would leak
            # into every other caller sharing that client.
            bound = copy.copy(bound)
            bound.effort = effort
        return bound

    def _apply_body_plan(self, body: dict, level: str) -> dict:
        """Reconcile ``body`` with what this model actually accepts (#151).

        Applies the registry's declarative plan in place: ``set`` first, then
        ``unset``, so a subtractive rule always beats an additive one. Returns
        the plan for logging/telemetry.

        This is the single point where dialect differences land. It replaced a
        version that only knew how to ADD the thinking parameters, which is why
        the o-series was broken: those models need `max_tokens` REMOVED and
        replaced with `max_completion_tokens`, and `temperature` dropped
        entirely. A rule set that cannot subtract cannot express that, so every
        request to them carried two fields they reject — an HTTP 400 that
        ``llm_errors`` rightly calls permanent, i.e. no retry and no downgrade.
        """
        from model_registry import body_plan
        plan = body_plan(
            self.model_id,
            kind=self.kind,
            effort=level,
            base_max_tokens=int(body.get("max_tokens") or self.max_tokens),
            output_ceiling=self.output_limit,
            effort_declared=self.effort_supported,
        )
        body.update(plan["set"])
        for key in plan["unset"]:
            body.pop(key, None)
        return plan

    def _mark_cache_breakpoint(self, msgs: list[dict], prefix: str) -> None:
        """Tag the end of the stable system prefix so the provider can cache it.

        The system prompt's opening layers (identity, soul, tool catalogue,
        output rules) are byte-identical every single turn, but without a
        breakpoint the provider re-reads and re-bills all of it each time. One
        marker turns that into a cache read at roughly a tenth of the price.

        Deliberately narrow on three axes, because the failure mode of getting
        this wrong is an HTTP 400 that `llm_errors` calls permanent — one bad
        request kills the whole turn with no retry and no downgrade:

        - **Only Claude-family providers.** `cache_control` is Anthropic's wire
          format. An OpenAI-compatible gateway that doesn't know the field may
          reject the request, and some of them also choke on a system message
          whose content is a block list rather than a plain string.
        - **Only when `prefix` really is a prefix.** The caller computes it from
          the prompt layers; if the two ever drift apart, splitting at that
          offset would silently cut the prompt in the wrong place. Mismatch means
          do nothing.
        - **Only when something follows it.** A breakpoint at the very end of the
          whole prompt caches nothing that will be reused.

        Mutates ``msgs`` in place, which is safe: the system entry is a dict this
        client just created, not one the caller still holds.
        """
        if not prefix or self.kind.lower() not in _CACHE_BREAKPOINT_KINDS:
            return
        if not msgs or msgs[0].get("role") != "system":
            return
        content = msgs[0].get("content")
        if not isinstance(content, str):
            return  # already structured — someone else owns the layout
        if not content.startswith(prefix) or len(prefix) >= len(content):
            return
        msgs[0] = {
            "role": "system",
            "content": [
                {"type": "text", "text": prefix,
                 "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": content[len(prefix):]},
            ],
        }

    def _apply_cache_plan(self, msgs: list[dict], cache_prefix: str) -> None:
        """按缓存规划器落地断点：system 前缀断点 + 对话尾部断点。

        相比 ``_mark_cache_breakpoint`` 的单断点，这里额外在历史对话的
        倒数第 2、3 条非 system 消息上放断点——长会话每轮重发的历史是
        最大的可复用缓存块，只缓存 system 前缀等于放着大头不要。规划器
        内部自带三条安全纪律（kind 白名单、前缀必须真匹配、断点后必须
        有内容），不满足任一条件就整体退回单断点行为或完全不打标。

        原地替换 ``msgs`` 内容（列表本身是调用方传入的副本，安全）。
        """
        from prompt_cache_planner import plan_cache_breakpoints, resolve_effective_system_prefix
        effective = resolve_effective_system_prefix(msgs, cache_prefix)
        plan = plan_cache_breakpoints(
            msgs,
            system_prefix=effective,
            kind=self.kind,
            ttl=self.cache_ttl,
        )
        if plan.messages is not msgs:
            msgs[:] = plan.messages

    def _backfill_reasoning_content(self, msgs: list[dict]) -> None:
        """Backfill missing reasoning_content on historical assistant messages.

        Certain reasoning-capable endpoints (DeepSeek, Kimi, Zhipu, etc.) strictly
        require all prior assistant turns in a multi-turn conversation to carry a
        `reasoning_content` field (even if empty `""`), otherwise the upstream API
        rejects the payload with HTTP 400.
        """
        try:
            from model_registry import is_reasoning_model
            key = str(self.model_id or "").lower()
            needs_backfill = (
                is_reasoning_model(self.model_id) or
                any(h in key for h in ("deepseek", "kimi", "moonshot", "glm", "qwen", "qwq"))
            )
        except Exception:
            needs_backfill = False
        if not needs_backfill:
            # Switching to a standard non-reasoning endpoint (e.g. gpt-4o, claude-3-5-sonnet):
            # Strip reasoning_content from history so strict OpenAI/Azure gateways do not reject the turn with HTTP 400.
            for msg in msgs:
                if isinstance(msg, dict) and msg.get("role") == "assistant":
                    msg.pop("reasoning_content", None)
            return
        for msg in msgs:
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                if "reasoning_content" not in msg:
                    msg["reasoning_content"] = ""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def chat(
        self,
        messages: list[dict],
        max_tokens: int = None,
        temperature: float = None,
        system: str = None,
        **extra: Any,
    ) -> Result:
        """Send a multi-turn conversation and return the assistant reply.

        Args:
            messages: List of ``{role, content}`` dicts.
            max_tokens: Override per-call.
            temperature: Override per-call.
            system: When provided, prepended as the first message with role=system.
            **extra: Forwarded into the request body (e.g. ``tools``).

        Returns:
            Result with a dict::

                {"content": str, "reasoning": str|None, "usage": dict,
                 "finish_reason": str, "raw": dict}
        """
        span = self._telemetry.start_span(SpanName.LLM_REQUEST, model=self.model_id)
        msgs = list(messages)
        if system:
            msgs.insert(0, {"role": "system", "content": system})

        # Ours, not the provider's — pull it before `extra` goes into the body.
        abort_check = extra.pop("abort_check", None)
        effort = extra.pop("reasoning_effort", "") or self.effort
        cache_prefix = str(extra.pop("cache_prefix", "") or "")
        if len(cache_prefix) >= CACHE_PREFIX_MIN_CHARS:
            self._apply_cache_plan(msgs, cache_prefix)
        self._backfill_reasoning_content(msgs)

        body: dict[str, Any] = {
            "model": self.model_id,
            "messages": msgs,
            "max_tokens": max_tokens or self.max_tokens,
            "temperature": temperature if temperature is not None else self.temperature,
        }
        body.update(extra)
        # After `extra`: the translated form is authoritative, and a caller that
        # passed a raw vendor field would otherwise fight the level it asked for.
        self._apply_body_plan(body, effort)

        result = await self._post_with_retry(body, abort_check=abort_check)
        if not result.ok:
            span.set_error(result.error)
            self._telemetry.end_span(span, error=result.error)
            return result

        raw = result.value
        choice = raw.get("choices", [{}])[0]
        message = choice.get("message") or {}
        usage = raw.get("usage", {})

        # Multi-modal responses put content in an ARRAY (text blocks + image
        # blocks), not a plain string. image_extract flattens that to clean text
        # and a uniform image list — and fixes the latent bug where the old
        # `content or ""` returned a list for vision responses.
        from image_extract import extract as _extract_media
        text, images = _extract_media(message, raw)

        # 内嵌思考块静态剥离（与流式 scrubber 同一套语义）：<think>…</think>
        # 混在正文里直接回给前端会原样渲染成半截标签。剥离出的思考并入
        # reasoning 字段——模型本就有独立 CoT 字段时两者按顺序拼接。
        hidden = ""
        if text and "<think>" in text:
            text, hidden = scrub_static(text)
        _reasoning = message.get("reasoning_content")
        if hidden:
            _reasoning = (_reasoning or "") + hidden

        out = {
            "content": text,
            "images": images,
            "reasoning": _reasoning or None,
            "tool_calls": self._normalize_tool_calls(message.get("tool_calls")),
            "usage": usage,
            "finish_reason": choice.get("finish_reason", ""),
            "raw": raw,
        }
        self._telemetry.end_span(
            span,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
        )
        return Result.success(out)

    async def chat_stream(
        self,
        messages: list[dict],
        max_tokens: int = None,
        temperature: float = None,
        system: str = None,
        **extra: Any,
    ) -> AsyncGenerator[dict, None]:
        """Stream a chat completion as progressive events.

        Yields dicts::

            {"type": "content", "text": str}       # visible answer tokens
            {"type": "reasoning", "text": str}     # chain-of-thought tokens
            {"type": "tool_call_delta", ...}       # a tool call being written out
            {"type": "done", "reply": dict}        # same shape as ``chat``
            {"type": "error", "error": str, "code": str}

        ``tool_call_delta`` carries ``{"index", "call_id", "name",
        "arguments_delta", "arguments"}``. ``index`` is the provider's own slot
        number and the only stable identity available mid-stream — ``call_id``
        can arrive in a later chunk than the first argument fragment.
        ``arguments_delta`` is the raw fragment; ``arguments`` is everything
        accumulated so far. Both are strings, deliberately: a partial JSON
        object is invalid JSON, so there is nothing to parse yet and any
        consumer that tries will fail on every frame but the last.

        Falls back to a single non-streaming ``chat`` call when aiohttp is
        unavailable (urllib cannot stream SSE cleanly here).
        """
        span = self._telemetry.start_span(SpanName.LLM_REQUEST, model=self.model_id)
        _record_success = _record_failure = None
        try:
            from stream_circuit_breaker import check_allowed, record_failure, record_success
            allowed, reason = check_allowed()
            if not allowed:
                self._telemetry.end_span(span, error=reason)
                yield {"type": "error", "error": reason, "code": "CircuitOpen"}
                return
            _record_success, _record_failure = record_success, record_failure
        except Exception:
            pass
        msgs = list(messages)
        if system:
            msgs.insert(0, {"role": "system", "content": system})

        # Pulled out BEFORE `body.update(extra)` — it's ours, not the provider's.
        # Leaving it in would ship a callable into the request body.
        abort_check = extra.pop("abort_check", None)
        effort = extra.pop("reasoning_effort", "") or self.effort
        cache_prefix = str(extra.pop("cache_prefix", "") or "")
        if len(cache_prefix) >= CACHE_PREFIX_MIN_CHARS:
            self._apply_cache_plan(msgs, cache_prefix)
        self._backfill_reasoning_content(msgs)

        body: dict[str, Any] = {
            "model": self.model_id,
            "messages": msgs,
            "max_tokens": max_tokens or self.max_tokens,
            "temperature": temperature if temperature is not None else self.temperature,
            "stream": True,
        }
        body.update(extra)
        self._apply_body_plan(body, effort)

        if not _HAS_AIOHTTP:
            # urllib path: one-shot, then synthesize a content event so callers
            # still get progressive UX hooks (one chunk).
            result = await self._post_with_retry(
                {k: v for k, v in body.items() if k != "stream"},
                abort_check=abort_check,
            )
            if not result.ok:
                span.set_error(result.error)
                self._telemetry.end_span(span, error=result.error)
                yield {"type": "error", "error": result.error, "code": "Transport"}
                return
            raw = result.value
            choice = raw.get("choices", [{}])[0]
            message = choice.get("message") or {}
            usage = raw.get("usage", {})
            content = message.get("content") or ""
            reasoning = message.get("reasoning_content")
            if reasoning:
                yield {"type": "reasoning", "text": reasoning}
            if content:
                yield {"type": "content", "text": content}
            out = {
                "content": content,
                "reasoning": reasoning,
                "tool_calls": self._normalize_tool_calls(message.get("tool_calls")),
                "usage": usage,
                "finish_reason": choice.get("finish_reason", ""),
                "raw": raw,
            }
            self._telemetry.end_span(
                span,
                input_tokens=usage.get("prompt_tokens", 0),
                output_tokens=usage.get("completion_tokens", 0),
            )
            yield {"type": "done", "reply": out}
            return

        if not self.api_key:
            yield {"type": "error", "error": "No API key configured", "code": "NoApiKey"}
            self._telemetry.end_span(span, error="NoApiKey")
            return

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "text/event-stream",
        }
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        _scrubber = StreamingThinkScrubber()
        tool_acc: dict[int, dict] = {}
        stream_images: list[dict] = []
        finish_reason = ""
        usage: dict = {}

        admission = None
        stream_result: Optional[Result] = None
        try:
            # Same gate as the non-streaming path. It has to be here too, not just
            # in `_post`: the agent loop streams, so gating only `_post` would
            # leave the busiest caller unlimited — which is the caller the storm
            # comes from.
            admission = await self._admit(body, abort_check)
            if admission.aborted:
                self._telemetry.end_span(span, error="Cancelled")
                yield {"type": "error", "error": "Cancelled while queued for rate limit",
                       "code": "Cancelled"}
                return
            session = await _get_shared_session(self.timeout_s)
            timeout = aiohttp.ClientTimeout(total=self.timeout_s) if _HAS_AIOHTTP else None
            if session is None:
                err = "aiohttp is required for streaming"
                stream_result = Result.failure(err, code="NoTransport")
                span.set_error(err)
                self._telemetry.end_span(span, error=err)
                yield {"type": "error", "error": err, "code": "NoTransport"}
                return

            async with session.post(
                self.endpoint,
                data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                headers=headers,
                timeout=timeout,
            ) as resp:
                if resp.status != 200:
                    raw = await resp.read()
                    err = f"HTTP {resp.status}: {raw.decode('utf-8', errors='replace')[:500]}"
                    retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                    stream_result = Result.failure(err, code=f"HTTP{resp.status}", retry_after=retry_after)
                    span.set_error(err)
                    self._telemetry.end_span(span, error=err)
                    if _record_failure:
                        _record_failure(f"HTTP{resp.status}")
                    yield {"type": "error", "error": err, "code": f"HTTP{resp.status}"}
                    return

                buffer = ""
                done = False
                aborted = False
                async for piece in resp.content.iter_any():
                    # Stop reading the moment the user hits Stop.
                    if abort_check is not None and abort_check():
                        aborted = True
                        break
                    buffer += piece.decode("utf-8", errors="replace")
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip("\r").strip()
                        if not line or line.startswith(":"):
                            continue
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            done = True
                            break
                        try:
                            chunk = json.loads(data)
                        except (json.JSONDecodeError, ValueError):
                            continue
                        if chunk.get("usage"):
                            usage = chunk["usage"]
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        choice = choices[0]
                        finish_reason = choice.get("finish_reason") or finish_reason
                        delta = choice.get("delta") or {}
                        # Some reasoning models stream CoT under reasoning_content.
                        r_piece = delta.get("reasoning_content") or delta.get("reasoning")
                        if r_piece:
                            reasoning_parts.append(r_piece)
                            yield {"type": "reasoning", "text": r_piece}
                        c_piece = delta.get("content")
                        if c_piece:
                            if isinstance(c_piece, str):
                                # 内嵌思考块过滤：<think>…</think> 可能被
                                # 切在任意两个 delta 的边界上，逐段正则会
                                # 漏；状态机按 hold-确认的节奏放行正文，
                                # 吞掉的思考转成 reasoning 事件，思考流
                                # UI 直接复用。
                                think_piece = ""
                                piece_text, think_piece = _scrubber.feed(c_piece)
                                if think_piece:
                                    reasoning_parts.append(think_piece)
                                    yield {"type": "reasoning", "text": think_piece}
                                if piece_text:
                                    content_parts.append(piece_text)
                                    yield {"type": "content", "text": piece_text}
                            else:
                                from image_extract import normalize_content
                                piece_text = normalize_content(c_piece, stream_images)
                                if piece_text:
                                    v_text, think_piece = _scrubber.feed(piece_text)
                                    if think_piece:
                                        reasoning_parts.append(think_piece)
                                        yield {"type": "reasoning", "text": think_piece}
                                    if v_text:
                                        content_parts.append(v_text)
                                        yield {"type": "content", "text": v_text}
                        if delta.get("images"):
                            from image_extract import extract as _x
                            _, imgs = _x({"images": delta["images"]})
                            stream_images.extend(imgs)
                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            slot = tool_acc.setdefault(idx, {
                                "id": "",
                                "name": "",
                                "arguments": "",
                            })
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = (slot["name"] or "") + fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] = (slot["arguments"] or "") + fn["arguments"]
                            yield {
                                "type": "tool_call_delta",
                                "index": idx,
                                "call_id": slot["id"],
                                "name": slot["name"],
                                "arguments_delta": fn.get("arguments") or "",
                                "arguments": slot["arguments"],
                            }
                    if done:
                        break

                stream_result = Result.success({"usage": usage})
        except asyncio.TimeoutError:
            err = "Request timed out"
            stream_result = Result.failure(err, code="Timeout")
            span.set_error(err)
            self._telemetry.end_span(span, error=err)
            if _record_failure:
                _record_failure("Timeout")
            yield {"type": "error", "error": err, "code": "Timeout"}
            return
        except Exception as e:
            err = f"Request failed: {e}"
            stream_result = Result.failure(err, code="Transport")
            span.set_error(err)
            self._telemetry.end_span(span, error=err)
            if _record_failure:
                _record_failure("Transport")
            yield {"type": "error", "error": err, "code": "Transport"}
            return
        finally:
            if admission is not None and not admission.aborted:
                final_res = stream_result if stream_result is not None else (
                    Result.success({"usage": usage}) if usage else Result.failure("Stream interrupted", code="Interrupted")
                )
                self._settle_admission(admission, final_res)

        raw_tool_calls = []
        for idx in sorted(tool_acc):
            slot = tool_acc[idx]
            raw_tool_calls.append({
                "id": slot["id"] or f"call_{idx}",
                "type": "function",
                "function": {
                    "name": slot["name"],
                    "arguments": slot["arguments"] or "{}",
                },
            })

        # 流收尾：把被 hold 住的边界残片与未闭合思考块交付——正文进正文，
        # 思考进思考，两者都不丢。之后 done 回执里的 content 才是干净的。
        _v, _r = _scrubber.flush()
        if _r:
            reasoning_parts.append(_r)
        if _v:
            content_parts.append(_v)
        out = {
            "content": "".join(content_parts),
            "images": stream_images,
            "reasoning": "".join(reasoning_parts) or None,
            "tool_calls": self._normalize_tool_calls(raw_tool_calls),
            "usage": usage,
            "finish_reason": "aborted" if aborted else finish_reason,
            "aborted": aborted,
            "raw": {},
        }
        self._telemetry.end_span(
            span,
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
        )
        try:
            if _record_success is not None:
                _record_success()
        except Exception:
            pass
        yield {"type": "done", "reply": out}

    @staticmethod
    def _normalize_tool_calls(tool_calls: Any) -> list[dict]:
        """Normalize provider tool_calls into a stable internal shape.

        Providers agree on the OpenAI envelope but differ in details: some omit
        ``id``, some hand back ``arguments`` already decoded. Normalizing here
        keeps the agent loop free of provider quirks.

        Returns:
            List of ``{"id": str, "name": str, "arguments": dict}``.
        """
        if not tool_calls:
            return []
        out: list[dict] = []
        for idx, call in enumerate(tool_calls):
            if not isinstance(call, dict):
                continue
            fn = call.get("function") or {}
            raw_args = fn.get("arguments")
            if isinstance(raw_args, str):
                try:
                    args = json.loads(raw_args) if raw_args.strip() else {}
                except (json.JSONDecodeError, ValueError):
                    # Malformed JSON from the model: surface it as an error the
                    # loop can feed back instead of crashing.
                    args = {"__parse_error__": raw_args}
            elif isinstance(raw_args, dict):
                args = raw_args
            else:
                args = {}
            out.append({
                "id": call.get("id") or f"call_{idx}",
                "name": fn.get("name") or "",
                "arguments": args,
            })
        return out

    async def call(self, prompt: Any) -> Any:
        """Simplified single-turn call for internal modules.

        Accepts either:
          - a string (sent as-is as a single user message)
          - a dict carrying an ``instruction`` (the ask) plus any number of
            payload keys (the data). The instruction goes first, then each
            remaining key is appended as a labelled block — so callers can pass
            ``{"instruction": ..., "content": ...}`` without the data being
            silently dropped.

        Args:
            prompt: String or dict as described above.

        Returns:
            Parsed JSON when the reply is a JSON object/array, otherwise the
            raw content string. Returns None on failure so callers can fall
            back to their heuristic path.
        """
        if isinstance(prompt, str):
            user_msg = prompt
        elif isinstance(prompt, dict):
            user_msg = self._render_prompt(prompt)
        else:
            user_msg = str(prompt)

        r = await self.chat([{"role": "user", "content": user_msg}])
        if not r.ok:
            return None
        content = (r.value.get("content") or "").strip()
        if not content:
            return None
        return self._maybe_json(content)

    @staticmethod
    def _render_prompt(prompt: dict) -> str:
        """Flatten a dict prompt into instruction-first text."""
        skip = {"instruction", "task"}
        head = prompt.get("instruction") or prompt.get("task") or ""
        parts: list[str] = [str(head)] if head else []
        for key, value in prompt.items():
            if key in skip or value in (None, "", [], {}):
                continue
            if isinstance(value, (dict, list)):
                try:
                    value = json.dumps(value, ensure_ascii=False)
                except (TypeError, ValueError):
                    value = str(value)
            parts.append(f"\n--- {key} ---\n{value}")
        return "\n".join(parts) if parts else json.dumps(prompt, ensure_ascii=False)

    @staticmethod
    def _maybe_json(content: str) -> Any:
        """Parse JSON out of a reply, tolerating code fences and prose."""
        text = content.strip()
        fenced = text
        if fenced.startswith("```"):
            fenced = fenced.split("\n", 1)[-1]
            if fenced.endswith("```"):
                fenced = fenced[: -3]
            fenced = fenced.strip()
        for candidate in (fenced, text):
            try:
                return json.loads(candidate)
            except (json.JSONDecodeError, ValueError):
                continue
        start = text.find("{")
        end = text.rfind("}")
        if 0 <= start < end:
            try:
                return json.loads(text[start : end + 1])
            except (json.JSONDecodeError, ValueError):
                pass  # fail-open: 可选增强，失败不影响主流程
        return content

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------

    #: Error codes / HTTP statuses that will NEVER succeed on a retry. Retrying
    #: these just burns the whole backoff ladder (1+2+4+8 = 15s) before failing
    #: with the same error, which the user experiences as the app hanging.
    #:
    #: Kept only as the last resort for a result carrying neither a code nor a
    #: recognisable body — the real decision now comes from ``llm_errors``.
    PERMANENT_CODES = ("NoApiKey",)
    PERMANENT_HTTP = ("400", "401", "402", "403", "404")

    def _classify(self, r: Result) -> str:
        """Semantic failure code for a failed Result (see ``llm_errors``).

        ``code`` lives in ``Result.meta``, not as an attribute — ``Result.failure``
        funnels every keyword into ``meta``. The previous check read
        ``getattr(r, "code")``, which is always None, so ``NoApiKey`` was never
        recognised as permanent and a missing key burned the entire 31s backoff
        ladder before reporting itself.
        """
        from llm_errors import classify
        return classify(code=self._result_code(r), error=r.error or "")

    @staticmethod
    def _result_code(r: Result) -> str:
        return str((r.meta or {}).get("code") or "")

    def _is_permanent(self, r: Result) -> bool:
        """Is this failure hopeless to retry?

        Delegates to the normalized classifier instead of sniffing the message.
        The old version returned True on any body containing "invalid", which
        misfiled a rate-limit reply that happened to mention an invalid field as
        permanent — and then never retried something that would have succeeded.
        """
        from llm_errors import is_permanent, FAILURE_UNKNOWN, FAILURE_CANCELLED
        failure = self._classify(r)
        if failure == FAILURE_CANCELLED:
            return True
        if failure != FAILURE_UNKNOWN:
            return is_permanent(failure)
        if self._result_code(r) in self.PERMANENT_CODES:
            return True
        return any(f"HTTP {code}" in (r.error or "") for code in self.PERMANENT_HTTP)

    async def _post_with_retry(self, body: dict, abort_check=None) -> Result:
        """POST with exponential backoff on transient errors only.

        Every failure that leaves here carries ``meta["failure"]`` — the semantic
        code — plus ``meta["recovery"]``, the direction a model switch would have
        to move in. The caller decides whether to act on it; classification is
        not its job, and duplicating this判断 upstream is how the two copies drift.
        """
        from llm_errors import recovery_for
        from failure_taxonomy import backoff_delay_for_failure, policy_for_failure
        last = None
        for attempt, delay in enumerate(self.RETRY_DELAYS):
            r = await self._post(body, abort_check=abort_check)
            if r.ok:
                return r
            last = r
            if self._is_permanent(r):
                return self._stamp_failure(r)
            _cls = self._classify(last)
            # Phase 9 收口：重试上限按分类动态收紧，不再一律烧完整个退避
            # 梯子。auth/policy/quota 类第一跳就停（重试无益），rate_limit/
            # network 允许满额有界退避。策略查询失败时保守放行原节奏。
            try:
                if attempt >= policy_for_failure(_cls).max_retries:
                    break  # 该分类不允许更多重试——立即带着语义上抛
            except Exception:
                pass  # fail-open: 策略缺失不改变既有节奏
            if attempt < len(self.RETRY_DELAYS) - 1:
                # Phase 9：分类学退避与既有节奏取大者——rate_limit 等类按
                # §12 策略拉长等待，其余类保持原节奏不缩短。
                _wait = delay
                try:
                    _wait = max(_wait, backoff_delay_for_failure(_cls, attempt))
                except Exception:
                    pass  # fail-open: 可选增强，失败不影响主流程
                await asyncio.sleep(_wait)
        exhausted = Result.failure(
            f"All retries exhausted. Last error: {last.error if last else ''}",
            code="RetriesExhausted",
        )
        # Carry the LAST real failure's semantics forward. "Retries exhausted" on
        # its own tells a caller nothing about what to try instead, which is why
        # the old code could only give up here.
        failure = self._classify(last) if last is not None else ""
        exhausted.meta["failure"] = failure
        exhausted.meta["recovery"] = recovery_for(failure)
        # Phase 9：把 §12 重试策略随失败一起上抛——调用方（fallback/降级逻辑）
        # 不必各自再猜"这类错还能不能再试"。分类仍是 llm_errors 的职责，
        # 这里只是策略的搬运工。
        try:
            from failure_taxonomy import policy_for_failure
            pol = policy_for_failure(failure)
            exhausted.meta["retry_policy"] = {
                "max_retries": pol.max_retries,
                "allow_fallback": pol.allow_fallback,
                "backoff_base_s": pol.backoff_base_s,
            }
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        return exhausted

    @staticmethod
    def _stamp_failure(r: Result) -> Result:
        """Attach semantic failure + recovery direction to a failed Result."""
        from llm_errors import classify, recovery_for
        failure = classify(code=str((r.meta or {}).get("code") or ""), error=r.error or "")
        r.meta["failure"] = failure
        r.meta["recovery"] = recovery_for(failure)
        # 策略随每个失败出口一起上抛：permanent 早退和 retries 耗尽两个出口
        # 的 meta 形状必须一致，调用方才不必区分"这是哪种失败返回"。
        try:
            from failure_taxonomy import policy_for_failure
            pol = policy_for_failure(failure)
            r.meta["retry_policy"] = {
                "max_retries": pol.max_retries,
                "allow_fallback": pol.allow_fallback,
                "backoff_base_s": pol.backoff_base_s,
            }
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        return r

    # ------------------------------------------------------------------
    # Rate limiting (admission control)
    # ------------------------------------------------------------------

    def estimate_request_tokens(self, body: dict) -> int:
        """Rough pre-send token cost: prompt bytes + the reply we asked for.

        Deliberately crude — it only has to be in the right order of magnitude,
        because ``RateLimiter.settle`` corrects it against the provider's real
        usage as soon as the response lands. The bytes/token ratio comes from
        ``token_estimate`` so this shares one number with the compactor instead
        of hardcoding its own copy.
        """
        from token_estimate import BYTES_PER_TOKEN
        try:
            payload = json.dumps(self._estimable(body.get("messages") or []),
                                 ensure_ascii=False)
        except (TypeError, ValueError):
            payload = ""
        prompt = int(len(payload.encode("utf-8")) / BYTES_PER_TOKEN)
        return prompt + int(body.get("max_tokens") or self.max_tokens)

    @staticmethod
    def _estimable(messages: list) -> list:
        """``messages`` with image payloads swapped for their real token cost.

        Providers bill an image by how many tiles it covers, not by the length of
        its base64 — a 1MB screenshot is ~1k tokens but ~1.4M characters. Feeding
        the raw string to a bytes-per-token estimate over-reserves by three orders
        of magnitude, and the rate limiter then refuses a request the provider
        would have accepted instantly.

        Only rewrites what it must: a message whose content is a plain string is
        returned untouched, so the common path allocates nothing extra.
        """
        from context_refs import IMAGE_TOKEN_ESTIMATE
        from token_estimate import BYTES_PER_TOKEN
        # The caller divides by BYTES_PER_TOKEN, so emit that many characters
        # per image to land on the intended token count.
        stand_in = "x" * int(IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN)
        out = []
        for m in messages:
            content = m.get("content") if isinstance(m, dict) else None
            if not isinstance(content, list):
                out.append(m)
                continue
            parts = []
            for p in content:
                if isinstance(p, dict) and p.get("type") == "image_url":
                    parts.append({"type": "image_url", "image_url": stand_in})
                else:
                    parts.append(p)
            out.append({**m, "content": parts})
        return out

    async def _admit(self, body: dict, abort_check=None):
        """Wait for this provider's bucket before spending a request slot."""
        limiter = get_rate_limiter()
        return await limiter.acquire(
            self.base_url,
            estimated_tokens=self.estimate_request_tokens(body),
            should_abort=abort_check,
        )

    def _settle_admission(self, admission, result: Result) -> None:
        """Correct the token bucket, or back off when the provider said 429."""
        if admission is None or not admission.reserved_tokens:
            return
        limiter = get_rate_limiter()
        if result.ok:
            usage = (result.value or {}).get("usage") or {}
            actual = int(usage.get("total_tokens") or 0)
            limiter.settle(self.base_url, admission.reserved_tokens, actual if actual > 0 else admission.reserved_tokens)
            return
        # Classified, not status-matched: some providers signal throttling with a
        # 400 or 503 plus a rate-limit body, and holding the bucket down is the
        # right response to the CONDITION, not to the number.
        from llm_errors import FAILURE_RATE_LIMIT
        if self._classify(result) == FAILURE_RATE_LIMIT:
            retry_after = float((result.meta or {}).get("retry_after") or 0)
            limiter.penalize(self.base_url, retry_after)
        else:
            # For non-429 failures (e.g. network timeout/cancelled), refund reserved token allowance
            limiter.settle(self.base_url, admission.reserved_tokens, 0)

    async def _post(self, body: dict, abort_check=None) -> Result:
        """Single HTTP POST to the chat completions endpoint."""
        if not self.api_key:
            return Result.failure("No API key configured", code="NoApiKey")
        admission = await self._admit(body, abort_check)
        if admission.aborted:
            # Nothing was charged and nothing was sent — the turn was cancelled
            # while queued at the gate. Reporting it as a normal cancellation
            # beats leaving the user watching a spinner they already stopped.
            return Result.failure("Cancelled while queued for rate limit",
                                  code="Cancelled")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")

        if _HAS_AIOHTTP:
            result = await self._post_aiohttp(encoded, headers)
        else:
            result = await asyncio.to_thread(self._post_urllib, encoded, headers)
        self._settle_admission(admission, result)
        return result

    async def _post_aiohttp(self, data: bytes, headers: dict) -> Result:
        try:
            session = await _get_shared_session(self.timeout_s)
            if session is None:
                return Result.failure("aiohttp transport unavailable", code="NoTransport")
            timeout = aiohttp.ClientTimeout(total=self.timeout_s)
            async with session.post(self.endpoint, data=data, headers=headers, timeout=timeout) as resp:
                raw = await resp.read()
                if resp.status != 200:
                    # Keep Retry-After: the provider's own number is better
                    # than our model of its quota, and the rate limiter uses
                    # it to hold the bucket down instead of guessing.
                    return Result.failure(
                        f"HTTP {resp.status}: {raw.decode('utf-8', errors='replace')[:500]}",
                        code=f"HTTP{resp.status}",
                        retry_after=_parse_retry_after(resp.headers.get("Retry-After")),
                    )
                return Result.success(json.loads(raw))
        except asyncio.TimeoutError:
            return Result.failure("Request timed out", code="Timeout")
        except Exception as e:
            return Result.failure(f"Request failed: {e}", code="Transport")

    def _post_urllib(self, data: bytes, headers: dict) -> Result:
        req = urllib.request.Request(self.endpoint, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                return Result.success(json.loads(resp.read().decode("utf-8")))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8")[:500]
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            return Result.failure(f"HTTP {e.code}: {body}", code=f"HTTP{e.code}")
        except Exception as e:
            return Result.failure(f"Request failed: {e}", code="Transport")


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_client: Optional[LLMClient] = None


def get_llm_client(config: dict = None) -> LLMClient:
    """Get or create the global LLMClient singleton.

    Args:
        config: Full app config. Required on first call; subsequent calls can
            omit it to get the existing instance.

    Local override: a ``config.local.json`` sitting next to ``config.json``
    deep-merges over the loaded config (top-level blocks replaced wholesale).
    Intended for machine-local model credentials — e.g. pointing the backend
    at a different provider without touching the tracked ``config.json``.
    The file must stay out of version control.
    """
    global _client
    if _client is None:
        if config is None:
            import os
            config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
            if os.path.exists(config_path):
                with open(config_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
            else:
                config = {}
            local_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.local.json")
            if os.path.exists(local_path):
                try:
                    with open(local_path, "r", encoding="utf-8") as f:
                        local_cfg = json.load(f)
                    if isinstance(local_cfg, dict):
                        for k, v in local_cfg.items():
                            if isinstance(v, dict) and isinstance(config.get(k), dict):
                                config[k].update(v)
                            else:
                                config[k] = v
                except (json.JSONDecodeError, OSError):
                    pass  # a broken local override must not break startup
        _client = LLMClient(config)
    return _client


def reset_llm_client():
    """Reset the singleton (for testing)."""
    global _client
    _client = None
