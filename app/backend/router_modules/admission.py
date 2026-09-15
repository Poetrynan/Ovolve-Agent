"""router_modules/admission.py - Session admission, workspace, cancellation, and handle entrypoint mixin."""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from typing import Any, Callable, Optional

import sys
from messaging import DeliverAs, MAX_STEER_MERGED_CHARS, MessageQueue, get_message_queue
from result import Result
from risk_control import PermissionMode, RiskController, RiskLevel, coerce_permission, parse_consent
from tools import shorten_path, truncate
from router_modules.prompt import _merge_plan_meta
from router_modules.loop import INTERRUPT_NOTE_TYPE, INTERRUPT_NUDGE
from event_bus import Event
from executors import cancel_call
from image_store import placeholder as _image_placeholder
from ask_user import get_ask_user_store
from rule_engine import get_rule_engine
import token_estimate

class RouterAdmissionMixin:
    """Mixin providing session/workspace lifecycle, usage tracking, cancellation, and handle entrypoint."""

    def _sync_fold_budget(self) -> None:
        """Point the compactor's budget at the ACTIVE model's context window.

        The compactor defaults to 80K, but the real budget depends on which model
        is selected — a 1M-context model should fold far later than a 32K one.
        Resolved lazily each fold rather than cached, since the user can switch
        models mid-session. Silent no-op if the registry reports no limit.
        """
        try:
            info = self.models.resolve(self._turn_model or None)
            if not info.ok:
                return
            v = info.value or {}
            limit = v.get("context_limit") or v.get("context") or v.get("max_input_tokens")
            if isinstance(limit, (int, float)) and limit > 0:
                self.compactor.max_tokens = int(limit)
                self.compactor.reserved_tokens = min(20_000, int(limit * 0.15))
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    async def _synthesize_for_fold(self, messages: list) -> Optional[dict]:
        """LLM layer of the fold chain: {Goal, Progress, Decisions, Open Issues}.
        Returns None when there is no usable model or the call fails, which makes
        the compactor fall through to its heuristic layer.
        """
        if not (self.llm and self.llm.api_key):
            return None
        # sqlite3.Row is not JSON-serializable; normalize to plain dicts.
        norm = []
        for m in messages:
            if isinstance(m, dict):
                norm.append(m)
            else:
                try:
                    norm.append({k: m[k] for k in m.keys()})
                except Exception:
                    continue
        r = await self.memory.synthesize_session(self.session_id, norm)
        if r and r.ok and isinstance(r.value, dict):
            return r.value
        return None

    async def _flush_memory_for_fold(self, messages: list) -> int:
        """Pre-compaction memory extraction: pull decisions/preferences from the
        about-to-be-folded segment and persist them to the memory store.

        Called by the compactor before it generates a summary. Extracts from
        both user instructions and assistant conclusions, strictly bound to
        current session_id and scope=session to prevent cross-session leaks (P1-5).

        Returns the number of memories extracted.
        """
        count = 0
        from memory_layer import MemoryScope
        for m in messages:
            content = ""
            if isinstance(m, dict):
                content = m.get("content", "")
            else:
                try:
                    content = m["content"] or ""
                except (KeyError, TypeError):
                    continue
            if not content or len(content) < 10:
                continue
            try:
                extracted = self.memory.extract(content, context=self.session_id)
                for mem in extracted:
                    mem.session_id = self.session_id
                    mem.scope = MemoryScope.SESSION
                    self.memory.store(mem)
                count += len(extracted)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        return count

    def _register_analysis_tools(self) -> None:
        """Register asset-derived analysis tools (best-effort, once).

        Each module exposes ``register_tools(registry)``; a missing data file or
        import error for one must not block the others.
        """
        import importlib
        for mod_name in ("diagnostics", "security_audit", "red_team", "recommender",
                         "goal_plan", "tool_catalog", "memory_tools", "skill_tools"):


            try:
                mod = importlib.import_module(mod_name)
                if hasattr(mod, "register_tools"):
                    mod.register_tools(self.tools)
            except Exception:
                continue
        # The `task` tool (sub-agent delegation). Registered here rather than in
        # the loop above because its schema enumerates the sub-agent registry at
        # import time, so it needs its own try/except — a broken user-authored
        # sub-agent YAML must not take the analysis tools down with it.
        try:
            from subagent_runtime import register_task_tool
            register_task_tool(self.tools)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    #: How many stored rows the fold path reads.
    #:
    #: `should_fold` compares ``len(messages)`` against ``_folded_upto`` — "how long
    #: was the history the last time we folded" — to decide whether anything new has
    #: happened. Reading a small page makes that count top out at the page size, and
    #: once the watermark reaches the ceiling every later auto-fold answers
    #: `no-new-content` and folding quietly stops for the rest of the session. The
    #: default page was 100, so that happened on any reasonably long conversation.
    #:
    #: Generous rather than unbounded: the summariser has to read whatever this
    #: returns, so an uncapped select would eventually be its own problem.
    FOLD_SCAN_LIMIT: int = 2000

    async def _on_before_compact(self, event: Event) -> None:
        """Synthesize the session into structured memory before history is compacted.

        Compaction throws away raw turns; the synthesis (Goal / Progress /
        Decisions / Open Issues) is what survives into the next session.
        """
        sid = event.payload.get("session_id") or self.session_id
        # Prefer the list the emitter already read — re-reading here would both
        # duplicate the query and risk synthesising a different window than the one
        # about to be folded.
        messages = event.payload.get("messages")
        if not messages:
            messages = self.storage.get_messages(sid, limit=self.FOLD_SCAN_LIMIT) or []
        await self.memory.synthesize_session(sid, messages)

    async def start_background(self) -> None:
        """Start background loops (memory dream consolidation).

        Call once from an async entrypoint. Safe to call more than once.
        """
        await self.memory.start_background()

    async def stop_background(self) -> None:
        """Stop background loops and cancel pending debounced extractions."""
        await self.memory.stop_background()

    async def fold_context(self, manual: bool = True) -> Result:
        """Fold (compact) the current session's history into a summary.

        This is the single entry point for both paths:
          * manual  — user ran ``/fold`` or clicked the button; bypasses the
            cooldown and the "no new content" check.
          * auto    — called from ``handle`` when the budget threshold is crossed.

        Emits ``session_before_compact`` first so memory_layer can persist the
        cross-session synthesis before raw turns stop being replayed.

        Returns:
            Result carrying the fold report, or a failure whose ``error`` is a
            reason code (``cooldown`` / ``under-threshold`` / ``max-consecutive``
            / ``no-new-content`` / ``too-short`` / ``already-folding``).
        """
        messages = self.storage.get_messages(self.session_id, limit=self.FOLD_SCAN_LIMIT) or []
        self._sync_fold_budget()
        ok, reason = self.compactor.should_fold(messages, manual=manual)
        if not ok:
            return Result.failure(reason)

        # Let subscribers (memory_layer synthesis) run before we fold.
        #
        # `folds_itself` claims ownership of the fold. The compactor subscribes to
        # this same event and folds when it fires, so without the claim one request
        # ran the summariser twice — two model calls, two `_consecutive` bumps, two
        # compaction rows in the transcript.
        try:
            await self.bus.emit("session_before_compact", {
                "session_id": self.session_id,
                "messages": messages,
                "manual": manual,
                "folds_itself": True,
            })
        except Exception:
            pass  # a failing subscriber must not block the fold itself

        report = await self.compactor.fold(self.session_id, messages, manual=manual)
        if report.ok:
            # Tighten loop detection for the next few steps. Compaction just removed
            # the model's short-term record of what it already tried, which is
            # exactly when it is most likely to walk back into a dead end it had
            # already found — and least able to notice by itself.
            self.loop_detector.note_compaction()
        return report

    async def _auto_fold_if_needed(self) -> Optional[dict]:
        """Fold before a turn if the budget is nearly spent. Returns the report."""
        r = await self.fold_context(manual=False)
        return r.value if r.ok else None

    #: 工业级自主运行循环：默认无步数截断（0 代表无限制，持续执行直至模型收敛或用户中断）
    MAX_AGENT_STEPS: int = 0

    #: 软着陆步数判定（仅在显式设置了正数上限时生效）
    SOFT_LANDING_STEP: int = -1

    def cancel(self) -> None:
        """Request cancellation of the in-flight turn.

        Cooperative, not preemptive: the agent loop checks the flag between
        steps and before each tool call, so a turn stops at the next safe
        boundary rather than being killed mid-write. A tool that is already
        running finishes — interrupting a half-written file would be worse than
        waiting for it.
        """
        self._cancelled.set()

    def cancel_hard(self) -> int:
        """Request cancellation **and** kill whatever is running right now.

        ``cancel()`` alone is cooperative: it is checked at step boundaries and
        before a tool batch, so a turn sitting inside a 10-minute build keeps
        going until that build ends. For a user-facing Pause that is the wrong
        contract — "stop" has to mean stop, the way SIGTERM+grace→SIGKILL does
        in a container runtime: ask nicely, then make it true.

        Returns how many live commands were actually killed. The killed calls
        settle as ``unknown`` in the side-effect ledger (see the ``CancelledError``
        branch of ``_execute_tool_call``), never as ``failed`` — a write that was
        already dispatched may well have landed.
        """
        self._cancelled.set()
        killed = 0
        _cancel = getattr(sys.modules.get("router"), "cancel_call", cancel_call)
        for call_id in list(self._live_calls):
            try:
                if _cancel(call_id):
                    killed += 1
            except Exception as exc:  # noqa: BLE001
                print(f"[router] hard-cancel of {call_id} failed: {exc}")
        return killed

    def live_call_names(self) -> list:
        """Tool names of the calls currently in flight. For honest reporting."""
        return sorted(self._live_calls.values())

    def _cancel_requested(self) -> bool:
        return self._cancelled.is_set()

    def _clear_cancel(self) -> None:
        self._cancelled.clear()

    def _current_turn_seq(self) -> int:
        """The seq of the message that started this turn. Used as the snapshot
        checkpoint handle — file snapshots and chat truncation both reference
        this number."""
        return self._turn_seq

    async def _drain_steer_into(self, messages: list, step: int) -> bool:
        """Inject every pending steer message onto the conversation as a user
        turn, in arrival order. Returns True when at least one was injected.

        Called at the step boundary — the only point where slipping a user
        message in is legal (no half-open assistant tool_calls awaiting their
        results). The whole steer queue is drained, not one per step, so three
        corrections fired during one slow tool all land on the next model call
        rather than trickling in over three steps.

        Two limits keep a hammering user from wrecking the next model call:
        * ``poll_steer`` drops messages past ``STEER_TTL_S`` — a correction the
          user queued five minutes ago and has since forgotten about would drag
          a converged conversation back onto an abandoned branch.
        * ``MAX_STEER_MERGED_CHARS`` caps the total injected text. Past the cap
          we stop injecting and leave a one-line note, so the model knows more
          was said rather than silently receiving a truncated instruction.

        Best-effort: a missing queue or an empty message is skipped, never
        raised, because a steering hiccup must not kill the turn.
        """
        queue = getattr(self, "queue", None)
        steer_q = getattr(self, "steer_queue", None)
        if queue is None and (steer_q is None or not steer_q.has_pending()):
            return False
        injected = 0
        budget = MAX_STEER_MERGED_CHARS
        dropped = 0

        # Drain standalone SteerQueue first (only if not bridged to queue to avoid double draining)
        if steer_q is not None and getattr(steer_q, "_msg_queue", None) is None and steer_q.has_pending():
            for s_item in steer_q.drain_all():
                s_text = (s_item.text or "").strip()
                if not s_text:
                    continue
                if len(s_text) > budget:
                    dropped += 1
                    continue
                budget -= len(s_text)
                messages.append({"role": "user", "content": s_text})
                injected += 1
                try:
                    from evolution_bridge import notify_user_correction
                    notify_user_correction(self.session_id, f"turn_{self._turn_seq}", s_text)
                except Exception:
                    pass

        # Guard the loop with a hard cap: a runaway producer must not spin here
        # forever holding the step boundary open.
        if queue is not None:
            for _ in range(64):
                msg = await queue.poll_steer()
                if msg is None:
                    break
                text = (getattr(msg, "content", "") or "").strip()
                if not text:
                    continue
                if len(text) > budget:
                    # Out of room. Keep draining so the queue doesn't stay full and
                    # replay on the next boundary, but count what we're discarding.
                    dropped += 1
                    continue
                budget -= len(text)
                messages.append({"role": "user", "content": text})
                injected += 1
                try:
                    from evolution_bridge import notify_user_correction
                    notify_user_correction(self.session_id, f"turn_{self._turn_seq}", text)
                except Exception:
                    pass

        if dropped:
            messages.append({
                "role": "user",
                "content": f"（另有 {dropped} 条纠偏消息因超出本轮注入上限被丢弃，"
                           f"如果仍然需要请重说一次。）",
            })
        if injected:
            self._clear_cancel()
        if injected or dropped:
            # Tell the UI the steer actually landed. The frontend already
            # declares this event type; without an emitter the optimistic
            # bubble was the only feedback the user ever got.
            try:
                await self.bus.emit("steer_applied", {
                    "session_id": self.session_id,
                    "step": step,
                    "injected": injected,
                    "dropped": dropped,
                })
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        return bool(injected or dropped)

    # ── @ references (六·UB2) ─────────────────────────────────────────────

    async def _inject_context_refs(self, messages: list, context: dict) -> dict:
        """Resolve this turn's @-refs and prepend them as their own message.

        Returns the summary dict (also emitted on the bus), or ``{}`` when the
        turn carried no refs.

        A SEPARATE message rather than text glued onto the user's sentence. Three
        reasons, in order of how much they bit us:

        * The model could not tell the difference between "the user typed a path"
          and "the system attached a file", so it kept calling ``read_file`` on
          something it had already been given.
        * A file whose content happens to contain the closing marker could end the
          block early and have the rest of itself read as the user's own words.
        * Compaction folds messages, and a fold that summarizes away the user's
          request while keeping 20k tokens of attached file is the wrong trade.
          Separate messages let the compactor make that choice per message.

        Placed BEFORE the user's message so the request is the last thing the
        model reads. Attachments are context for the question; the question comes
        last, where instruction-following is strongest.
        """
        raw = context.get("context_refs")
        if not isinstance(raw, list) or not raw:
            return {}
        from context_refs import (
            DEFAULT_REF_BUDGET, image_blocks, refs_summary, render_refs,
            render_vision_unavailable, resolve_images, resolve_refs,
            split_by_modality,
        )
        text_refs, image_refs = split_by_modality(raw)
        # Never let attachments claim more than a quarter of the window: the
        # history, the system prompt and the reply all still have to fit, and a
        # small-context model would otherwise be handed a request it must reject.
        ceiling = int(getattr(self.llm, "context_limit", 0) or 0) // 4
        budget = min(DEFAULT_REF_BUDGET, ceiling) if ceiling else DEFAULT_REF_BUDGET
        try:
            rows = resolve_refs(text_refs, self.workspace, budget_tokens=budget)
            img_rows = resolve_images(image_refs, self.workspace)
        except Exception as exc:
            # A failed attachment must not lose the user's turn. Tell the model
            # the attachment is missing rather than silently answering as if the
            # user had sent nothing — a confident answer about a file nobody read
            # is worse than an admission.
            messages.append({
                "role": "user",
                "content": f"（用户附加了 {len(raw)} 项引用内容，但系统读取失败：{exc}。"
                           f"请据此说明，或用工具自行读取。）",
            })
            return {}
        body = render_refs(rows)
        if body:
            messages.append({"role": "user", "content": body})

        # Images. The blocks ride on the USER message (composed by the caller),
        # not on a message of their own: a provider expects the image to sit in
        # the same turn as the question about it, and splitting them costs the
        # model the association.
        if img_rows:
            if self._model_can_read_images():
                context["_image_blocks"] = image_blocks(img_rows)
            else:
                # 一·A3's lesson, enforced: an image this model cannot process is
                # announced, never dropped. Silently discarding it produces a
                # reply that confidently answers a question about a picture it
                # never received.
                context["_vision_note"] = render_vision_unavailable(img_rows)
            failed = [r for r in img_rows if not r.get("ok")]
            if failed:
                names = "、".join(
                    f"{r.get('label')}（{r.get('error')}）" for r in failed)
                messages.append({
                    "role": "user",
                    "content": f"（有 {len(failed)} 张图片未能读取：{names}）",
                })

        summary = refs_summary(rows + img_rows)
        context["context_refs_summary"] = summary
        try:
            await self.bus.emit("context_refs_resolved", {
                "session_id": self.session_id, **summary,
            })
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        return summary

    @staticmethod
    def _compose_user_content(user_message: str, context: dict):
        """The user turn's content: a plain string, or multi-part with images.

        Multi-part ONLY when there are images to carry. Every provider accepts a
        bare string and some older gateways choke on a one-element part array, so
        wrapping unconditionally would trade a working request for a cosmetic
        consistency.

        The image blocks are consumed (`pop`) rather than read: the agent loop can
        call the model many times per turn, and re-sending the images on every
        step would multiply the image bill by the step count while telling the
        model nothing it hasn't already seen in the history.
        """
        blocks = context.pop("_image_blocks", None) or []
        note = context.pop("_vision_note", "") or ""
        text = f"{user_message}\n\n{note}" if note else user_message
        if not blocks:
            return text
        # Text first: the question frames what to look for in the images.
        return [{"type": "text", "text": text}, *blocks]

    # ── Usage accounting ─────────────────────────────────────────────────
    #
    # Providers each invented their own name for the same six numbers. Rather
    # than teach every consumer all the dialects, everything is normalised once,
    # here, into one flat shape. Unknown providers degrade to input/output only
    # instead of erroring — a missing cache stat is a blank cell in the
    # dashboard, not a broken turn.

    @staticmethod
    def _normalize_usage(u: dict) -> dict:
        """Map any provider's `usage` blob onto our canonical counters."""
        if not isinstance(u, dict):
            return {}
        det_in = u.get("prompt_tokens_details") or {}
        det_out = u.get("completion_tokens_details") or {}

        # Input: OpenAI says prompt_tokens, Anthropic says input_tokens.
        inp = int(u.get("prompt_tokens") or u.get("input_tokens") or 0)
        # Output: completion_tokens vs output_tokens.
        outp = int(u.get("completion_tokens") or u.get("output_tokens") or 0)
        # Reasoning tokens hide in completion_tokens_details on OpenAI-likes.
        reasoning = int(
            det_out.get("reasoning_tokens")
            or u.get("reasoning_tokens")
            or 0
        )

        # Cache telemetry normalization:
        # 1. DeepSeek: prompt_cache_hit_tokens & prompt_cache_miss_tokens
        # 2. Anthropic: cache_read_input_tokens (read) & input_tokens (miss) & cache_creation_input_tokens (write)
        # 3. OpenAI: det_in.cached_tokens (read) & (prompt_tokens - cached_tokens) (miss)
        has_cache_info = False
        cache_read = 0
        cache_miss = 0
        cache_creation = int(
            u.get("cache_creation_input_tokens")
            or u.get("cache_write_input_tokens")
            or 0
        )
        input_is_exclusive = False

        if "prompt_cache_hit_tokens" in u or "prompt_cache_miss_tokens" in u:
            has_cache_info = True
            cache_read = int(u.get("prompt_cache_hit_tokens") or 0)
            cache_miss = int(u.get("prompt_cache_miss_tokens") or max(0, inp - cache_read))
        elif "cache_read_input_tokens" in u or "cache_creation_input_tokens" in u:
            has_cache_info = True
            cache_read = int(u.get("cache_read_input_tokens") or 0)
            cache_miss = inp  # Anthropic input_tokens is non-cached input
            input_is_exclusive = True
        elif det_in.get("cached_tokens") is not None or u.get("cached_tokens") is not None:
            has_cache_info = True
            cache_read = int(det_in.get("cached_tokens") or u.get("cached_tokens") or 0)
            cache_miss = max(0, inp - cache_read)
        elif cache_creation > 0:
            has_cache_info = True
            cache_read = 0
            cache_miss = inp

        provider_total = int(u.get("total_tokens") or 0)
        return {
            "input": inp,
            "output": outp,
            "reasoning": reasoning,
            "cache_read": cache_read,
            "cache_miss": cache_miss,
            "cache_creation": cache_creation,
            "has_cache_info": has_cache_info,
            "input_is_exclusive": input_is_exclusive,
            "provider_total": provider_total,
        }

    def _accumulate_usage(self, context: dict, raw_usage: dict) -> None:
        """Fold one LLM call's usage into this turn's running total."""
        norm = self._normalize_usage(raw_usage)
        if not norm:
            return
        acc = context.setdefault("_usage_accum", {
            "input": 0, "output": 0, "reasoning": 0,
            "cache_read": 0, "cache_miss": 0, "cache_creation": 0, "provider_total": 0, "calls": 0,
            "has_cache_info": False,
            "input_is_exclusive": False,
            "last_step_context": 0,
        })
        for k, v in norm.items():
            if k in ("has_cache_info", "input_is_exclusive"):
                acc[k] = bool(acc.get(k, False) or v)
            else:
                acc[k] = acc.get(k, 0) + v
        acc["calls"] = acc.get("calls", 0) + 1
        _inp, _cr = norm.get("input", 0), norm.get("cache_read", 0)
        acc["last_step_context"] = _inp if (0 < _cr <= _inp and not norm.get("input_is_exclusive")) else _inp + _cr

    def _active_model_id(self) -> str:
        """`provider:model` for the model that ACTUALLY served this turn.

        Resolution order matters. The composer pick rebinds ``self.llm`` in
        :meth:`_bind_turn_model`, and a downgrade hop swaps it again mid-turn —
        but ``self.models.resolve()`` with no argument answers from config.json.
        Resolving config first therefore booked every switched or downgraded
        turn under the WRONG model, and priced it at that wrong model's rate.
        The bound client is the source of truth; config is only the fallback.
        """
        llm = getattr(self, "llm", None)
        if llm is not None:
            mid = str(getattr(llm, "model_id", "") or "").strip()
            pid = str(getattr(llm, "provider_id", "") or "").strip()
            if mid:
                return f"{pid}:{mid}" if pid else mid
        tm = str(getattr(self, "_turn_model", "") or "").strip()
        if tm:
            return tm
        try:
            info = self.models.resolve()
            if info.ok and isinstance(info.value, dict):
                pid = info.value.get("provider_id") or info.value.get("provider") or ""
                mid = info.value.get("model_id") or info.value.get("model") or info.value.get("id") or ""
                if not mid and self.config and isinstance(self.config.get("model"), dict):
                    mid = self.config["model"].get("model_id", "")
                if pid and mid:
                    return f"{pid}:{mid}"
                return str(mid or pid or "")
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        return ""

    def _record_turn_usage(self, context: dict) -> dict:
        """Persist this turn's accumulated usage and return what it cost.

        Best-effort persistence by design: losing an analytics row must never
        surface as a failed turn. The returned dict is what ``handle`` hands back
        in ``Result.meta['usage']`` — the goal worker needs this turn's real
        tokens and money, and re-querying the usage table for "the row I just
        wrote" would be both racy and slower.

        Returns:
            ``{tokens, input, output, cache_read, cache_creation, cost_micros,
            cache_saved_micros, cost_source, model_id, calls}``, or ``{}`` when
            no LLM call happened.

        ``cache_creation`` is in here for a reason worth stating: it used to be
        accumulated in ``_usage_accum`` and written to SQLite, but **left out of
        this dict**. ``_emit_usage_frame`` then did
        ``summary.get("cache_creation", 0)`` and always got 0, so the analytics
        engine computed its hit rate as ``read / (read + 0)`` — a flat 100% for
        every turn that read any cache at all. A key missing from a dict is a
        silent 0, not an error.
        """
        acc = context.get("_usage_accum")
        if not acc or acc.get("calls", 0) == 0:
            return {}
        model_id = self._active_model_id()
        total = acc.get("input", 0) + acc.get("output", 0) + acc.get("reasoning", 0)
        # Price it here, once. Anything downstream that needs money reads this
        # figure instead of re-deriving it from tokens at a later date's rates.
        try:
            priced = self.models.cost_of(model_id, acc)
        except Exception:
            priced = {"cost_micros": 0, "cache_saved_micros": 0, "cost_source": ""}
        summary = {
            "tokens": total,
            "input": acc.get("input", 0),
            "output": acc.get("output", 0),
            "cache_read": acc.get("cache_read", 0),
            "cache_miss": acc.get("cache_miss", 0),
            "cache_creation": acc.get("cache_creation", 0),
            "has_cache_info": acc.get("has_cache_info", False),
            "cost_micros": priced.get("cost_micros", 0),
            "cache_saved_micros": priced.get("cache_saved_micros", 0),
            "cost_source": priced.get("cost_source", ""),
            "model_id": model_id,
            "calls": acc.get("calls", 0),
            "last_step_context": acc.get("last_step_context", 0),
        }
        try:
            latency_ms = int((time.time() - context.get("_turn_start", time.time())) * 1000)
            self.storage.record_usage(
                self.session_id,
                f"turn-{self._turn_seq}",
                acc.get("input", 0),
                acc.get("output", 0),
                reason=acc.get("reasoning", 0),
                cc=acc.get("cache_creation", 0),
                cr=acc.get("cache_read", 0),
                pt=acc.get("provider_total", 0),
                ct=total,
                model_id=model_id,
                latency_ms=latency_ms,
                cost_micros=summary["cost_micros"],
                cache_saved_micros=summary["cache_saved_micros"],
                cost_source=summary["cost_source"],
            )
        except Exception as _e:
            # 用量落库失败若无声，Usage 页与成本归因就开始撒谎（§12 纪律）
            print(f"[router] record_usage FAILED: {_e}")
        return summary

    async def _emit_usage_frame(self, summary: dict) -> None:
        """Push this turn's real token/cost figures out on the bus.

        Until now the numbers only went into SQLite, so the context meter the
        user watches during a turn was a client-side estimate from message text
        (``contextUsageStore`` says as much in its header comment) and
        ``isEstimated`` never went false. Everything needed was already
        computed — it just had no channel out.

        ``tokenCount`` is deliberately the CONTEXT-WINDOW occupancy
        (``last_step_context`` or ``input + cache_read``, via :meth:`Storage.last_turn_context_tokens`),
        not this turn's input+output total: the frontend divides it by the
        window limit to draw the meter, and adding output tokens to that
        numerator would overstate how full the window is.

        Best-effort: a broadcast failure must not fail the turn.
        """
        if not summary:
            return
        context_tokens = summary.get("last_step_context") or 0
        if not context_tokens:
            try:
                context_tokens = self.storage.last_turn_context_tokens(self.session_id)
            except Exception:
                context_tokens = 0
        if not context_tokens:
            context_tokens = summary.get("tokens") or 0

        # system_prompt / tool_def / skill token counts are best-effort:
        # if we can't compute them cheaply, analytics falls back to attributing
        # the remainder to 'messages'. Computed BEFORE the emit so the same
        # numbers ride the WS frame — the frontend's between-turn estimate
        # needs them, and its only other source was a mount-time fetch.
        sp_tokens = getattr(self, "_last_turn_system_prompt_tokens", 0)
        tool_tokens = 0
        skill_tokens = 0
        if not sp_tokens:
            try:
                sp_tokens = self.compactor.estimate_tokens(
                    self.get_system_prompt()
                )
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        try:
            tool_tokens = self._tool_def_tokens()
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        try:
            skill_tokens = self._skill_tokens()
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        # Real model window for an honest denominator (0 => unknown; the
        # analytics engine keeps whatever it already had rather than
        # inventing a "typical" 200k).
        try:
            context_window = int(getattr(self.llm, "context_limit", 0) or 0)
        except Exception:
            context_window = 0

        try:
            await self.bus.emit("usage", {
                "session_id": self.session_id,
                # Consumed by the frontend's applyUsage(); it reads `tokenCount`
                # first and falls back to usage.total_tokens.
                "tokenCount": context_tokens,
                # The overhead breakdown so the client-side estimate between
                # turns can include what the provider counts but the message
                # list doesn't show (system prompt + tool schemas + skills
                # routinely add up to five figures).
                "breakdown": {
                    "systemPrompt": sp_tokens,
                    "tools": tool_tokens,
                    "skills": skill_tokens,
                },
                "contextWindow": context_window,
                "usage": {
                    "total_tokens": summary.get("tokens", 0),
                    "input_tokens": summary.get("input", 0),
                    "output_tokens": summary.get("output", 0),
                    "cache_read": summary.get("cache_read", 0),
                    "cache_miss": summary.get("cache_miss", 0),
                    "cache_creation": summary.get("cache_creation", 0),
                    "cost_micros": summary.get("cost_micros", 0),
                    "cache_saved_micros": summary.get("cache_saved_micros", 0),
                    "cost_source": summary.get("cost_source", ""),
                    "model_id": summary.get("model_id", ""),
                    "calls": summary.get("calls", 0),
                },
            })
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        # Update the analytics engine with per-turn real numbers.
        try:
            from token_analytics import get_token_analytics
            get_token_analytics().update_from_usage(
                context_tokens=context_tokens,
                cache_read=summary.get("cache_read", 0),
                cache_miss=summary.get("cache_miss", 0),
                cache_creation=summary.get("cache_creation", 0),
                has_cache_info=summary.get("has_cache_info", False),
                # Money comes pre-priced by model_registry (per-model rate /
                # user override / provider-reported bill). This module never
                # prices anything itself.
                savings_micros=summary.get("cache_saved_micros", 0),
                cost_source=summary.get("cost_source", ""),
                # A real summary means the numbers came from the provider's
                # usage blob, not a client-side estimate.
                used_is_exact=bool(summary.get("calls", 0)),
                model_id=summary.get("model_id", ""),
                context_window=context_window,
                system_prompt_tokens=sp_tokens,
                tool_def_tokens=tool_tokens,
                skill_tokens=skill_tokens,
            )
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    def _tool_def_tokens(self) -> int:
        """Estimate the token cost of all registered tool definitions."""
        try:
            import json
            specs = []
            if hasattr(self.tools, 'to_openai_tools'):
                specs = self.tools.to_openai_tools()
            elif hasattr(self.tools, 'to_llm_schemas'):
                specs = self.tools.to_llm_schemas()
            elif hasattr(self.tools, 'tool_specs'):
                specs = self.tools.tool_specs()
            total = 0
            for spec in specs:
                total += self.compactor.estimate_tokens(json.dumps(spec, ensure_ascii=False))
            return total
        except Exception:
            return 0

    def _request_overhead_tokens(self, system_prompt: str, tool_specs: list) -> int:
        """Tokens this request will spend on things that aren't in ``messages``.

        The system prompt and the tool-definition JSON ride along on every single
        call and routinely add up to five figures, yet neither is visible to
        ``should_fold`` (which only measures stored history) — so "we're at 60% of
        the window" and "the provider rejected this for length" could both be true
        at once. Feeding this into ``precheck_inline`` closes that gap.

        Unlike :meth:`_tool_def_tokens`, this counts the **trimmed** spec list
        actually being sent, not the whole registry. The registry total is the
        right number for the analytics breakdown; it is the wrong number for a
        fit check, because ``tool_catalog`` may have hidden two thirds of it.
        """
        try:
            total = token_estimate.estimate_tokens(system_prompt or "")
            for spec in (tool_specs or []):
                total += token_estimate.estimate_tokens_of(spec)
            return total
        except Exception:
            return 0

    def _skill_tokens(self) -> int:
        """Estimate the token cost of all loaded/available skill content."""
        try:
            prompt = self.skills.render_available_skills_prompt()
            if prompt:
                return self.compactor.estimate_tokens(prompt)
            return 0
        except Exception:
            return 0

    def switch_session(self, sid: str) -> Result:
        """Point the Router at an existing session.

        Not a session *creation* — the caller loads history separately (via
        ``storage.get_messages``) and pushes it into the frontend. Here we only
        re-anchor the server-side identity so subsequent turns write to and
        read from the right rows.

        Only safe on an IDLE router. The per-session state below (goal, cancel
        token, ``_turn_seq``) belongs to the turn in progress, so re-anchoring a
        router that is mid-turn renumbers that turn under itself and throws away
        the cancel token Stop depends on. An earlier note claimed the WS layer
        refused mid-flight switches; it did not, and the drift was live.
        ``_switch_and_reply`` now skips this call for a session whose turn is
        still running — that router is already anchored where it needs to be.
        """
        if not sid or not self.storage.get_session(sid):
            return Result.failure(f"Unknown session: {sid}")
        self.session_id = sid
        self.goals.set_session(sid)
        self.goals.load_goal_state(sid)
        # Keep the fold-card tag in sync with the session we now serve.
        try:
            self.compactor.session_id = sid
            row = self.storage.get_session(sid)
            parent = (row or {}).get("parent_id") if row else None
            if parent:
                from review_prefix_cache import lineage_for_fork
                self.compactor._lineage_root = lineage_for_fork(str(parent))
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        self._session_started = False   # session_start will re-fire on next handle()
        self._turn_seq = self.storage.seq_of_last_message(sid)
        try:
            self._cancelled.clear()
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        return Result.success(sid)

    def new_session(self, title: str = "", workspace: str = None) -> Result:
        """Create a fresh session and switch to it.

        The session is tagged with the workspace it belongs to (defaults to the
        active one), which is what lets the sidebar group history by folder.
        The default is ``effective_workspace``, not ``self.workspace``: with no
        folder picked the latter is the launch cwd, and tagging a session with
        it invents a workspace group out of Ovolve's own directory.
        """
        import uuid as _uuid
        new_sid = str(_uuid.uuid4())
        ws = self.effective_workspace if workspace is None else workspace
        self.storage.create_session(new_sid, title or "New chat", workspace=ws or "")
        return self.switch_session(new_sid)

    @property
    def effective_workspace(self) -> str:
        """The workspace as the USER understands it — `''` when they never picked.

        `self.workspace` always holds a real absolute path because the
        constructor falls back to `os.getcwd()`. That fallback is fine for the
        sandbox root (the agent has to be somewhere) but it must never be shown
        or persisted as a workspace the user owns: launched from source, cwd is
        Ovolve's own `app/` folder, so the sidebar invented a workspace called
        "app" out of the backend's launch directory and highlighted it as
        active. Every user-facing surface — the sidebar list, the memory scope
        picker — should ask for this instead of `workspace`, matching the
        `''` = 默认工作区 convention the sessions table already uses.
        """
        return self.workspace if getattr(self, "workspace_selected", False) else ""

    def switch_workspace(self, path: str) -> Result:
        """Re-point the agent at a different working folder.

        The workspace is the agent's world boundary: `path_guard` computes the
        sandbox from ``context["workspace_root"]``, which `handle()` re-derives
        from `self.workspace` on EVERY turn. So the file tools, the sandbox and
        the git routes all follow this one assignment.

        Two things do NOT follow automatically, because they were bound to the
        old path at construction, so they are rebuilt here:
          - the rule engine (reads `<workspace>/.ovolve/rules`)
          - the hook system (reads `<workspace>` hook definitions)

        A fresh session is created afterwards on purpose. Carrying the old
        conversation across a workspace change would leave the model reasoning
        about file paths from the previous project while acting on this one —
        which is how you get real, wrong edits.
        """
        if not path:
            return Result.failure("workspace path is required")
        resolved = os.path.abspath(os.path.expanduser(path))
        if not os.path.isdir(resolved):
            return Result.failure(f"Not a directory: {resolved}")

        self.workspace = resolved
        # The user just explicitly opened this folder — the git panel and any
        # other workspace-gated feature should now treat it as a real workspace.
        self.workspace_selected = True
        # Repoint memory too, or recall keeps serving the previous workspace's
        # entries after the switch — the most confusing possible carry-over,
        # because the folder changed but the agent's "what I know" did not.
        # `rescope`, not a fresh `for_root`: `mount()` already registered THIS
        # handle's bound `_on_user_prompt` on the bus, so swapping in a new
        # object would leave the bus driving recall through a handle nobody reads
        # while the visible one moved. Moving this handle in place keeps the two
        # in sync.
        try:
            self.memory.rescope(resolved, self.session_id)
        except Exception as exc:  # noqa: BLE001
            print(f"[Router] memory root repoint failed for {resolved}: {exc}")
        try:
            self.rules = get_rule_engine(resolved)
        except Exception as exc:  # noqa: BLE001
            print(f"[Router] rule engine rebuild failed for {resolved}: {exc}")
        try:
            from hook_runner import init_hooks
            init_hooks(resolved, self.session_id)
        except Exception as exc:  # noqa: BLE001
            print(f"[Router] hook re-init failed for {resolved}: {exc}")

        # Remember the choice so the next launch opens the same folder.
        try:
            self.storage.set_config("active_workspace", resolved)
        except Exception as _e:
            # 用户的选择存不下来，下次启动就回到旧工作区——这是要告诉人的事
            print(f"[router] persist active_workspace FAILED: {_e}")

        return self.new_session(workspace=resolved)

    async def _teardown_steer_inbox(self) -> None:
        """Teardown steer inbox: atomically close if empty, or drain leftover into follow-up."""
        q = getattr(self, "queue", None)
        if q is None:
            return
        try:
            if hasattr(q, "close_steer_inbox"):
                if not await q.close_steer_inbox():
                    while True:
                        rem = await q.poll_steer()
                        if not rem:
                            break
                        await q.send_message(rem.content, DeliverAs.FOLLOW_UP, sender=rem.sender)
                    await q.close_steer_inbox()
        except Exception:
            pass

    async def handle(self, user_message: str, context: dict = None) -> Result:
        """Handle one user turn.

        Two execution paths:

        * **Agent loop (default)** — the model sees the whole tool catalogue and
          decides what to call, in what order, how many times. Each call still
          passes through ``pre_tool_use`` (risk control / remote denylist) and
          emits ``tool_result`` (memory extraction), so every guardrail written
          for the keyword path keeps working.
        * **Keyword fallback** — used only when no LLM is configured, so the
          agent degrades to the previous deterministic behavior instead of
          becoming a no-op.

        Args:
            user_message: Raw user input.
            context: Optional per-turn context; ``session_id`` and
                ``workspace_root`` are filled in automatically.

        Returns:
            Result carrying the final reply text.
        """
        from agent_phases import TurnPhase, emit_phase

        # Steer 收件箱进入本轮：重置开放接收 (reopen_steer_inbox)
        if getattr(self, "queue", None) is not None and hasattr(self.queue, "reopen_steer_inbox"):
            try:
                await self.queue.reopen_steer_inbox()
            except Exception:
                pass

        context = context or {}
        context["session_id"] = self.session_id
        context["workspace_root"] = self.workspace
        # Wall-clock start for this turn. Used to compute end-to-end latency at
        # usage-record time; kept in context so a nested call (compaction,
        # steer) can't accidentally reset it by re-entering handle().
        context.setdefault("_turn_start", time.time())

        # Step E 补全：LLM 主环路的技能归因。触发匹配在这里算一次（尊重 B3
        # 可见性），命中的技能正文随后由 _skill_guidance_block 作为不可信参考
        # 材料注入系统提示；回合终态据此记录真实使用经验——没注入就不记账。
        try:
            context["skill_candidates"] = self.skills.find_by_trigger(user_message)
        except Exception:
            context["skill_candidates"] = []

        # ConversationEpisode 主题片段追踪（Phase 4 & 24）
        try:
            from episode_manager import get_episode_manager
            em = get_episode_manager(self.storage)
            turn_id = str(context.get("turn_id") or f"turn_{self._turn_seq}")
            branch_id = str(getattr(self, "branch_id", "") or context.get("branch_id") or "")
            context["episode_id"] = em.record_turn(
                session_id=self.session_id,
                turn_id=turn_id,
                topic="",  # 保守沿用当前活跃 Episode，避免每条消息前50字切分
                goal_id=str(context.get("goal_id") or ""),
                branch_id=branch_id,
                prompt=user_message,
            )
        except Exception:
            pass

        try:
            from task_states import record_task_state_transition, TurnStatus
            record_task_state_transition(
                layer="turn",
                task_id=str(context.get("turn_id") or f"turn_{self._turn_seq}"),
                old_state=TurnStatus.QUEUED,
                new_state=TurnStatus.RUNNING,
                session_id=self.session_id,
            )
        except Exception:
            pass

        # --- Phase: TURN_ENTERED ---
        # goal_id/run_id ride along from the very first frame. Without them the
        # trace ledger recorded a goal's turns as anonymous session traffic, so
        # "show me what this goal did" had nothing to filter on — the scheduler
        # knew both values (goal_scheduler builds `turn_ctx` with them) and the
        # information was simply dropped on the way to the store.
        await emit_phase(self.bus, TurnPhase.TURN_ENTERED, session_id=self.session_id,
                         extra={"goal_id": str(context.get("goal_id") or ""),
                                "run_id": str(context.get("run_id") or "")})

        # The permission level is a per-turn decision made by the USER in the UI,
        # not by the model. Resolved once here so every downstream gate and the
        # system prompt agree on what this turn is allowed to do. A payload that
        # carries no level (queued turns, replays, bot traffic) must NOT widen
        # back to auto — it runs under whatever is standing: the last UI pick or
        # the workspace/config default.
        _perm_requested = context.get("permission")
        if _perm_requested:
            self.permission = coerce_permission(_perm_requested)
        context["permission"] = self.permission.value
        # Same story for the model: the composer's pick is a per-request
        # parameter, resolved once here so the whole turn — streaming, fold
        # budget, modality gates — agrees on which model is answering. A turn
        # that sends no pick falls to the workspace default before config.json.
        _resolved = self._bind_turn_model(context.get("model") or self.workspace_model)
        context["model"] = self.llm.model_id
        if _resolved:
            context["model_provider"] = _resolved.get("provider_name") or ""
        # Thinking budget (UD4), same per-request treatment. Normalized here so an
        # unrecognised value degrades to "don't send the parameter" instead of
        # reaching the provider and earning a permanent 400.
        from model_registry import normalize_effort, supports_effort
        self._turn_effort = normalize_effort(
            context.get("thought_level") or self.workspace_thought_level)
        context["thought_level"] = self._turn_effort
        # Whether the dial even applies to the model that ended up answering.
        # Recorded rather than enforced: the request is still valid, the knob just
        # goes nowhere, and the UI needs to be able to say so.
        context["thought_supported"] = supports_effort(
            self.llm.model_id, getattr(self.llm, "kind", ""),
            getattr(self.llm, "effort_supported", None),
        )
        # A cancel belongs to the turn that was running when it arrived. Clearing
        # here stops a stale flag from killing the NEXT turn before it starts.
        self._clear_cancel()

        # Fresh loop detector per turn, for the same reason the cancel token is
        # cleared here: the repetition picture belongs to the request being worked
        # on. A new question that happens to open with the same `read_file` call as
        # the last one is not a loop, and inheriting the old history would make it
        # look like one.
        from loop_detector import LoopDetector
        self.loop_detector = LoopDetector(self._loop_config)
        from repeat_tool_guard import RepeatToolGuard
        self.repeat_tool_guard = RepeatToolGuard()

        # Same reasoning for the per-turn action counters the context meter
        # shows. They live in a popover titled "this turn", but `reset_turn` had
        # no callers at all, so the tool count on display was the process-wide
        # running total — it crossed sessions and windows and only ever went up.
        try:
            from token_analytics import get_token_analytics
            get_token_analytics().reset_turn()
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程


        # --- Phase: PERMISSION_RESOLVED ---
        await emit_phase(self.bus, TurnPhase.PERMISSION_RESOLVED, session_id=self.session_id,
                         extra={"permission": self.permission.value})

        # Emit session_start once, on the first turn (guaranteed running loop —
        # __init__ has none). SessionStart hooks and any future session-scoped
        # subscribers fire here rather than being hardcoded in __init__.
        if not self._session_started:
            self._session_started = True
            await self.bus.emit("session_start", {
                "session_id": self.session_id,
                "reason": "startup",
                "workspace_root": self.workspace,
                "context": context,
            })

        # --- Phase: WORKSPACE_READY ---
        await emit_phase(self.bus, TurnPhase.WORKSPACE_READY, session_id=self.session_id,
                         extra={"workspace": self.workspace})

        # Check for steer messages (user interrupted)
        steer = await self.queue.poll_steer()
        if steer:
            user_message = steer.content
            context["steered"] = True

        # The turn's raw input, recorded AFTER the steer swap so it matches what
        # actually drives this turn. This is the provenance anchor the
        # confused-deputy check reads: the one string in `context` that the model
        # cannot author, so "the user asked for this path" can be distinguished
        # from "a file I just read asked for it". Kept out of the prompt path —
        # nothing downstream may treat it as an instruction.
        context["user_message"] = user_message
        context.setdefault("workspace_root", self.workspace)
        context.setdefault("workspace", self.workspace)

        # Shadow workspace: staged overlay for main-agent file mutations.
        if not self.is_subagent:
            try:
                from shadow_session import inject_context, shadow_enabled
                if shadow_enabled():
                    inject_context(self.session_id, self.workspace, context)
            except Exception:
                pass

        if not context.get("silent_consent"):
            self.storage.add_message(self.session_id, "user", user_message)
            # First user turn of a new session → name the session after it. Idempotent
            # once the title is real (the storage helper won't overwrite a rename).
            try:
                self.storage.autotitle_session(self.session_id, user_message)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        # The seq this user turn landed on doubles as the rollback checkpoint:
        # "undo this message" (chat truncation) and "undo what it changed on disk"
        # (snapshot rollback) both address seq >= this number.
        self._turn_seq = self.storage.seq_of_last_message(self.session_id)
        self.memory.touch()

        # ── 两阶段确认的第二阶段 ──────────────────────────────────────────────
        # 上一回合可能停在一句「回复「同意」我就继续」上。那么这一句短回复是对那个
        # 问题的**回答**，不是新需求 —— 在这里对上号，确认流程才第一次真的闭环：
        # 在此之前 grant_permission 全代码库无人调用，INHERITED 许可层永远不可能
        # 生效，用户同意多少次都会被原地再问一次。
        if self.risk.pending_for(self.session_id):
            # A click on the card's 同意/以后都允许/不用了 button arrives as a
            # `respond_permission` frame and lands here as an explicit decision +
            # the call_id it belongs to. Typing the words still works and falls
            # back to parsing. Both funnel into ONE resolve path — the button was
            # not worth a second copy of the re-issue logic, and the call_id is
            # the only real difference: text can only answer the newest ask,
            # a click answers the card it was on.
            decision = context.get("consent_decision") or parse_consent(user_message)
            consent_call_id = str(context.get("consent_call_id") or "")
            if decision == "deny":
                # 作废那个提问。不提前返回：让模型正常读到「不用了」并自己接话，
                # 比我们硬塞一句模板回复自然。关键是许可绝不能留着。
                self.risk.resolve_pending("deny", self.session_id, consent_call_id)
            elif decision in ("approve", "approve_always"):
                # approve_always 除了放行这一次，还落一条持久规则：同类调用以后
                # 不再打断。这就是「能做完 30 个文件的重构」和「被打断 30 次」的
                # 区别 —— resolve_pending 内部按风险兜底，CRITICAL 一步不会因为
                # 一句「以后都允许」被永久放行。
                approved = self.risk.resolve_pending(
                    decision, self.session_id, consent_call_id
                )
                if approved is not None:
                    context["approved_pending"] = approved
                    if not context.get("silent_consent"):
                        user_message = (
                            f"{user_message}\n\n"
                            "[系统] 用户已确认上一步操作，该操作已自动执行。请根据执行结果继续完成任务。"
                        )

        # 用户不点问题卡片、直接打字往下说 —— 那句话就是他的答复方式。留着那组
        # 问题只会让卡片上的按钮变成陷阱：点下去后端会答「已经不在等待中了」。
        # 所以在这里作废，并把最新快照推给前端让它把卡片结掉。
        #
        # `question_answer` 标记的回合要跳过：那是点击卡片走 respond_question 进来
        # 的，被答的那一组已经在 WS 层消费掉了，此时若把整个会话清空，并存的第二
        # 张问题卡会被无辜连坐。
        if not context.get("question_answer"):
            store = get_ask_user_store()
            if store.discard_session(self.session_id):
                await self.bus.emit("pending_questions", {
                    "session_id": self.session_id,
                    "items": store.snapshot(self.session_id),
                })



        # Auto-fold: if the budget is nearly spent, summarize before we build the
        # history for this turn. `_build_history` then replays from the newest
        # fold marker forward, so the model sees the summary instead of the raw
        # turns it replaces. Cooldown + consecutive caps live in the compactor.
        await emit_phase(self.bus, TurnPhase.CONTEXT_ENGINE, session_id=self.session_id)
        fold_report = await self._auto_fold_if_needed()
        if fold_report:
            context["fold"] = fold_report

        # user_prompt_submit lets memory_layer inject <memory> into the context.
        # `workspace` rides along so subscribers that cache per project (the
        # capability recommender) can scope their key — the same question in two
        # workspaces has two different right answers.
        prompt_event = await self.bus.emit(
            "user_prompt_submit",
            {"message": user_message, "context": context, "workspace": self.workspace},
        )
        merged_ctx = prompt_event.payload.get("context")
        if isinstance(merged_ctx, dict):
            context.update(merged_ctx)
        await emit_phase(self.bus, TurnPhase.CONTEXT_ASSEMBLED, session_id=self.session_id)

        if self._cancel_requested():
            await self._teardown_steer_inbox()
            return Result.failure("Cancelled before model loop")

        trace: list[dict] = []
        if self.llm and self.llm.api_key:
            result, trace = await self._agent_loop(user_message, context)
            context["tool_trace"] = trace
        else:
            result = await self._keyword_turn(user_message, context)

        await emit_phase(self.bus, TurnPhase.ASSISTANT_REPLY_FINALIZED,
                         session_id=self.session_id,
                         extra={"ok": bool(result.ok)})


        if result.ok:
            context["audit"] = self._audit(result, {"agent": None, "primary_tool": None}, context)

        output = self._present(result, {}, context)

        output_event = await self.bus.emit("output", {"text": output, "user_intent": user_message})
        if output_event.action.value == "modify":
            output = output_event.payload.get("text", output)

        # Persist any images the model generated this turn, ONCE, at the end.
        # This appends a compact placeholder to output (~10 tokens/image) so the
        # model on the next turn knows "I made a picture" without seeing 25万
        # tokens of base64, and stores the real refs in message metadata where
        # _build_history won't replay them.
        image_refs = await self._persist_turn_images(context)
        if image_refs:
            placeholders = "\n".join(_image_placeholder(r) for r in image_refs)
            output = f"{output}\n{placeholders}" if output else placeholders
        metadata = {}
        if image_refs:
            metadata["images"] = image_refs
        if trace:
            metadata["tool_calls"] = [
                {
                    "id": t.get("call_id") or t.get("id") or f"call_{idx}",
                    "toolName": t.get("tool") or t.get("name") or t.get("toolName") or "",
                    "args": t.get("args") or {},
                    "result": t.get("output") or t.get("result") or t.get("preview") or "",
                    "output": t.get("output") or t.get("preview") or "",
                    "status": "completed" if (t.get("status") in ("ok", "success") or t.get("ok", True)) else "failed",
                    "timestamp": (t.get("timestamp") or time.time()) * 1000 if (t.get("timestamp") or 0) < 10000000000 else (t.get("timestamp") or time.time()),
                    "completedAt": (t.get("completedAt") or time.time()) * 1000 if (t.get("completedAt") or 0) < 10000000000 else (t.get("completedAt") or time.time()),
                }
                for idx, t in enumerate(trace)
            ]
        turn_reasonings = context.get("turn_reasonings") or []
        if turn_reasonings:
            metadata["reasoning"] = [
                {
                    "id": r.get("id") or f"reasoning_{idx}",
                    "step": r.get("step", 0),
                    "text": r.get("text") or "",
                    "final": r.get("final", False),
                    "timestamp": (r.get("timestamp") or time.time()) * 1000 if (r.get("timestamp") or 0) < 10000000000 else (r.get("timestamp") or time.time()),
                }
                for idx, r in enumerate(turn_reasonings)
            ]

        if output.strip() or not (getattr(result, "meta", None) or {}).get("needs_confirmation"):
            self.storage.add_message(
                self.session_id, "assistant", output,
                metadata=metadata if metadata else None,
            )

        # Hidden nudge — only when the user actually stopped this turn. Written
        # AFTER the assistant row so replay order is "reply, then the note about
        # it", which is how the model reads it as commentary on what just
        # happened rather than as a new instruction.
        if (result.meta or {}).get("cancelled"):
            try:
                self.storage.add_message(
                    self.session_id, "system", INTERRUPT_NUDGE,
                    msg_type=INTERRUPT_NOTE_TYPE,
                )
            except Exception:
                pass  # losing the nudge degrades recovery quality, never the turn

        # A real reply landed, so the agent is making progress — clear the
        # consecutive-fold counter. The cap exists to stop fold→fold→fold loops,
        # not to limit folds over a long healthy session.
        self.compactor.note_new_turn()

        await emit_phase(self.bus, TurnPhase.POST_TURN_HOOKS, session_id=self.session_id)

        # Shadow workspace: auto-merge staged overlay when permission allows.
        if not self.is_subagent and context.get("shadow_staged"):
            try:
                from shadow_workspace import maybe_auto_apply
                await maybe_auto_apply(
                    self.bus, self.session_id, self.workspace,
                    str(context.get("permission") or ""),
                )
            except Exception:
                pass

        follow_up = await self.queue.poll_follow_up()
        if follow_up:
            await self.queue.send_message(follow_up.content, DeliverAs.NEXT_TURN)

        # Persist token usage for this turn, once, now that every LLM call in the
        # loop has reported in. Recording per-step would triple the turn count.
        turn_usage = self._record_turn_usage(context)
        await self._emit_usage_frame(turn_usage)

        # LLM 主环路技能归因：本轮真的注入了技能指导、且关键词路径尚未记账
        # （其经验 id 已挂在 result.meta），按回合结果补一条经验——同一技能的
        # 履历因此覆盖两条执行路径。用户主动取消不算技能失败。
        _inj = context.get("skill_injected")
        if _inj and not ((result.meta or {}).get("skill_experience_id")) \
                and not ((result.meta or {}).get("cancelled")):
            try:
                _exp_id = self.storage.record_skill_experience(
                    _inj["name"],
                    skill_version=_inj["version"],
                    goal_id=str(context.get("goal_id") or ""),
                    run_id=str(context.get("run_id") or ""),
                    session_id=self.session_id,
                    # 选择原因由产生它的那条路径给出：触发匹配注入是
                    # llm_context_match，模型自己调 skill_load 是 skill_load_tool。
                    # 写死一个会让履历谎报"是我们推给它的"。
                    selection_reason=str(_inj.get("reason") or "llm_context_match"),

                    preconditions_met=True,
                    steps_attempted=1, steps_succeeded=1 if bool(result.ok) else 0,
                    outcome=("success" if result.ok else "failure"),
                    failure_class="" if result.ok else str(getattr(result, "error", "") or "")[:200],
                )
                if isinstance(result.meta, dict):
                    result.meta["skill_experience_id"] = _exp_id
                _rr = str(context.get("run_id") or "")
                if _rr:
                    self.storage.add_relation(
                        "run", _rr, "USES", "skill", _inj["name"],
                        evidence=f"exp:{_exp_id}",
                    )
            except Exception as _e:
                print(f"[skills] llm-path experience failed: {_e}")

        # ── task-level experience（P0-2）────────────────────────────────────
        # 之前只有"命中技能"才写履历，于是学习闭环恰好对最该学的情况瞎了：
        # 没有任何技能覆盖的任务，是"缺一个技能"的最强证据，却一行都不留。
        # observation 构造器读的就是这张表，空表 → 无从提议 → 入口断。
        #
        # 只在本轮确实没有技能履历时补写，不与技能行重复计数——否则
        # classify_observation 的成功/失败计数会凭空多出一条。
        # skill_id 用 Storage.TASK_LEVEL_SKILL_ID 哨兵，读侧默认过滤。
        # turn_id 刻意用 `turn-N`：与 turn_usage.turn_id 同一套编号，
        # 这条履历因此能和真实 token / 花费 join 上（旧的 uuid 方案不能）。
        #
        # 被打断的一轮也要留一行，outcome="cancelled"：用户在这里叫停本身
        # 就是证据（"这条路走到这里被人拦下了"），而之前它一行都不留。它不会
        # 污染任何计数——成功/失败的统计都是精确匹配 success / failure，
        # 技能孵化也只看 success，cancelled 两边都不算。
        if not ((result.meta or {}).get("skill_experience_id")):
            _cancelled = bool((result.meta or {}).get("cancelled"))
            try:
                _cost = float((turn_usage or {}).get("cost_micros") or 0) / 1_000_000.0
                # steps = 本轮 LLM 调用次数。不是工具步数——目前没有逐轮工具
                # 计数器，写一个假的"步数"比写一个诚实的近似更糟。
                _calls = int((turn_usage or {}).get("calls") or 0)
                _task_exp_id = self.storage.record_skill_experience(
                    self.storage.TASK_LEVEL_SKILL_ID,
                    turn_id=f"turn-{self._turn_seq}",
                    goal_id=str(context.get("goal_id") or ""),
                    run_id=str(context.get("run_id") or ""),
                    session_id=self.session_id,
                    selection_reason="no_skill",
                    preconditions_met=True,
                    steps_attempted=_calls,
                    steps_succeeded=(_calls if (result.ok and not _cancelled) else 0),
                    outcome=("cancelled" if _cancelled
                             else ("success" if result.ok else "failure")),
                    failure_class=("user_cancelled" if _cancelled
                                   else ("" if result.ok else
                                         str(getattr(result, "error", "") or "unknown")[:200])),
                    cost=_cost,
                    latency_ms=(time.time() - context.get("_turn_start", time.time())) * 1000,
                )

                if isinstance(result.meta, dict):
                    result.meta["task_experience_id"] = _task_exp_id
            except Exception as _e:
                print(f"[skills] task-level experience failed: {_e}")


        # Cancel honesty: a stopped turn still crosses TURN_COMPLETED here, so
        # the cancelled flag rides along on the phase — the trace bridge turns
        # it into AGENT_TURN_CANCELLED, and a replayed ledger never shows an
        # interrupted turn as a successful one.
        await emit_phase(self.bus, TurnPhase.TURN_COMPLETED, session_id=self.session_id,
                         extra={"ok": bool(result.ok),
                                "cancelled": bool((result.meta or {}).get("cancelled"))})

        # Context-pressure evolution check post TURN_COMPLETED
        try:
            from evolution_pressure import probe_context_pressure
            _comp = getattr(self, "compactor", None)
            _budget = getattr(_comp, "max_tokens", 80000) if _comp else 80000
            _th = getattr(_comp, "threshold", 0.8) if _comp else 0.8
            _turn_id = str(context.get("turn_id") or f"turn_{self._turn_seq}")
            _msgs = self.storage.get_messages(self.session_id, limit=50) if hasattr(self, "storage") else []
            if _msgs:
                probe_context_pressure(
                    _msgs, max_context_tokens=_budget, threshold=_th,
                    session_id=self.session_id, turn_id=_turn_id,
                )
        except Exception:
            pass

        # The usage figures ride along in meta so a programmatic caller (the goal
        # scheduler) can charge this turn's real spend to its budget. Previously
        # the worker had no way to learn what a turn cost and billed a flat
        # constant, which is why a $0.50 cap was never reached.
        meta = dict(result.meta) if isinstance(result.meta, dict) else {}
        # 执行轮记下的方案审批信息并入终态（否则 approved_with 无消费者）。
        meta = _merge_plan_meta(meta, context)
        # Plan 档：成功轮次自动把方案存成一等产物（缺口 B）。
        # 放在终态判定前：cancelled / needs_confirmation 都不算"方案已交付"。
        if result.ok and not bool(meta.get("cancelled")) and not bool(meta.get("needs_confirmation")):
            try:
                _pre_capture_meta = meta
                await self._maybe_capture_plan(context, output)
                if context.get("plan_id"):
                    _pre_capture_meta["plan_id"] = context["plan_id"]
            except Exception:
                pass
        _cancelled = bool(meta.get("cancelled"))
        _incomplete = bool(meta.get("incomplete"))
        _needs_confirm = bool(meta.get("needs_confirmation"))
        _partial = bool(meta.get("partial"))

        try:
            from task_states import record_task_state_transition, TurnStatus
            _final_st = (
                TurnStatus.CANCELLED if _cancelled
                else (TurnStatus.WAITING_CONFIRMATION if _needs_confirm
                else (TurnStatus.COMPLETED if result.ok else TurnStatus.FAILED))
            )
            record_task_state_transition(
                layer="turn",
                task_id=str(context.get("turn_id") or f"turn_{self._turn_seq}"),
                old_state=TurnStatus.RUNNING,
                new_state=_final_st,
                session_id=self.session_id,
                meta={"outcome": meta.get("turn_outcome")},
            )
        except Exception:
            pass

        await self._teardown_steer_inbox()

        if _cancelled:
            meta["turn_outcome"] = "cancelled"
            return Result.failure("已中断（用户点击了停止）", usage=turn_usage, meta=meta)
        elif _incomplete:
            meta["turn_outcome"] = "incomplete"
            return Result.failure(getattr(result, "error", "") or str(output), usage=turn_usage, meta=meta)
        elif _needs_confirm:
            meta["turn_outcome"] = "waiting_user"
            return Result.success(output, usage=turn_usage, meta=meta)
        elif _partial:
            meta["turn_outcome"] = "partial"
            return Result.success(output, usage=turn_usage, meta=meta)
        elif not result.ok:
            meta["turn_outcome"] = "failed"
            return Result.failure(getattr(result, "error", "") or str(output), usage=turn_usage, meta=meta)
        else:
            meta["turn_outcome"] = "completed"
            return Result.success(output, usage=turn_usage, meta=meta)

