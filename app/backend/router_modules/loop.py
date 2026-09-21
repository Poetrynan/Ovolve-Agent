"""router_modules/loop.py - Agent loop core, LLM streaming, and MoA council mixin."""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Callable, Optional

from result import Result
from tools import truncate
from router_modules.prompt import _strip_leading_junk, _approved_plan_context
from router_modules.dispatch import _summarize_turn_outcome

IMAGE_HINT_DELAY = 2.5
TOOL_ARG_FRAME_INTERVAL = 0.08

INTERRUPT_NOTE_TYPE = "interrupt_note"
INTERRUPT_NUDGE = (
    "[系统提示] 上一回合是被用户主动中止的，不是正常完成——工具可能只跑了一半。"
    "接下来回答前：先说明当时进行到哪一步、哪些改动已经落盘，再等用户指示要继续还是换做法。"
    "不要假设上一个任务已经做完。"
)

SOFT_LANDING_NOTICE = (
    "[系统提示] 这一回合的工具步数快用完了（还剩两步）。现在别再开新的活儿，"
    "把手上的收尾并交接：\n"
    "1. 已经做完并落盘的改动（文件 + 具体改了什么）；\n"
    "2. 还没做完的部分，以及当前卡在哪；\n"
    "3. 下一步具体该做什么（一句话，能直接照着做）。\n"
    "如果剩下的活儿本来就长，说清楚建议到「目标」面板建目标跑——那条路有独立的迭代预算。"
)

class RouterLoopMixin:
    """Mixin providing _agent_loop, streaming LLM chat, and MoA council."""

    def _bind_turn_model(self, requested: str) -> dict:
        """Point this turn at the model the composer picked.

        ``requested`` is the UI's ``"providerId:modelId"`` composite (or a bare
        model id). It used to be dropped on the floor — the picker changed a
        label and nothing else, because the backend only ever read config.json.

        Every failure path lands on the config client, so the worst case is the
        behaviour we had before this existed rather than a broken turn.

        Returns:
            The resolved descriptor, or ``{}`` when nothing was requested.
        """
        requested = (requested or "").strip()
        if not requested:
            fallback = (self._turn_model or getattr(self, "workspace_model", "") or "").strip()
            if fallback:
                requested = fallback
        if not requested:
            self._turn_model = ""
            self.llm = self._base_llm
            return {}
        try:
            info = self.models.resolve(requested)
        except Exception:
            self._turn_model = ""
            self.llm = self._base_llm
            return {}
        if not info.ok or not isinstance(info.value, dict):
            self._turn_model = ""
            self.llm = self._base_llm
            return {}
        resolved = info.value
        self._turn_model = requested
        self.llm = self._base_llm.bind(resolved) if self._base_llm is not None else None
        return resolved


    async def _agent_loop(
        self, user_message: str, context: dict
    ) -> tuple[Result, list[dict]]:
        """Run the plan -> call tools -> observe -> repeat loop.

        Args:
            user_message: The user's message for this turn.
            context: Per-turn context (mutated with risk level per call).

        Returns:
            ``(result, trace)`` where trace lists每 executed tool call for
            auditing and UI rendering.
        """
        # /moa 会诊触发：剥掉前缀，剩余文本才是本轮真正的用户请求。
        # 触发意图挂进 context（steer 重建走同一条路时不重复触发——只有
        # 首次进入带原始 user_message 的这一步能置位）。
        from moa import strip_moa_prefix
        _moa_requested, user_message = strip_moa_prefix(user_message)
        context["_moa_requested"] = _moa_requested
        self._benchmark_mode = bool(context.get("benchmark"))

        system_prompt = self.get_system_prompt(context) + self._skill_guidance_block(context)
        self._sync_turn_cache_prefix(system_prompt)
        try:
            self._last_turn_system_prompt_tokens = self.compactor.estimate_tokens(system_prompt)
        except Exception:
            self._last_turn_system_prompt_tokens = 0
        is_silent = bool(context and context.get("silent_consent"))
        messages = self._build_history(limit=20, drop_trailing_user=not is_silent)
        await self._inject_context_refs(messages, context)
        if not (is_silent and messages and messages[-1].get("role") == "user"):
            messages.append({"role": "user", "content": self._compose_user_content(user_message, context)})

        # Plan 档执行轮：已批准方案的合同注入（缺口 B）。必须在 messages
        # 构建之后、MoA/工具目录之前——合同是本轮的根指令，优先级高于
        # 一切会诊与目录裁剪；meta_extra 经 context 落到终态 meta。
        if isinstance(context, dict) and context.get("approved_plan"):
            messages, _pa_meta = _approved_plan_context(messages, context)
            if _pa_meta:
                context.setdefault("_plan_meta", {}).update(_pa_meta)

        # MoA 会诊：在首轮模型调用前并行征求advisor意见，把「同行会诊」
        # 块并入本轮末尾的 user 消息。fail-open——没配第二个模型、advisor
        # 全挂、超时，都只退回单模型，一轮对话绝不因会诊缺席而失败。
        if _moa_requested:
            try:
                await self._run_moa_council(messages, user_message, context)
            except Exception as _moa_e:
                print(f"[moa] council failed (fail-open): {_moa_e}")

        # 六·UC1：本轮的目录视图从零开始重算 —— 相关性来自这一轮的请求，上一轮
        # 浮出来的工具不再自动可见。`_turn_query` 是 `_tool_specs_for` 打分用的
        # 唯一输入，放进 context 而不是当参数传，是为了让 steer 之后的重建走
        # 同一条路、不需要把 user_message 一路带下去。
        self._revealed_tools = set()
        self._catalogue_dirty = False
        context["_turn_query"] = user_message


        tool_specs = self._tool_specs_for(context)
        trace: list[dict] = []
        turn_reasonings: list[dict] = []
        context["turn_reasonings"] = turn_reasonings


        from agent_phases import TurnPhase, emit_phase

        import itertools
        step_iter = range(self.max_agent_steps) if self.max_agent_steps > 0 else itertools.count(0)

        for step in step_iter:
            # The step boundary is the observable checkpoint of the agent loop:
            # cancellation, steering and cost caps are all enforced here, so it
            # is also the phase a stuck turn will be sitting in.
            await emit_phase(self.bus, TurnPhase.STEP_BOUNDARY,
                             session_id=self.session_id, extra={"step": step})

            if step == 0:
                approved = context.pop("approved_pending", None)
                if approved is not None:
                    call_id = (
                        getattr(approved, "call_id", None)
                        or (approved.get("call_id") if isinstance(approved, dict) else "")
                        or context.get("consent_call_id")
                        or ""
                    )
                    tool_name = getattr(approved, "tool_name", None) or (approved.get("tool_name") if isinstance(approved, dict) else "")
                    tool_args = getattr(approved, "args", None) if not isinstance(approved, dict) else approved.get("args", {})
                    call = {
                        "id": call_id,
                        "name": tool_name,
                        "arguments": tool_args,
                    }
                    context["confirmed"] = True
                    await emit_phase(self.bus, TurnPhase.TOOL_EXECUTION_STARTED,
                                     session_id=self.session_id,
                                     extra={"step": step, "tools": [tool_name]})
                    outcome = await self._run_tool_call(call, context)
                    await emit_phase(self.bus, TurnPhase.TOOL_EXECUTION_FINISHED,
                                     session_id=self.session_id,
                                     extra={"step": step, "tools": [tool_name], "ok": self._outcome_ok(outcome)})
                    trace.append(outcome["trace"])
                    messages.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": tool_name,
                                    "arguments": json.dumps(tool_args, ensure_ascii=False) if isinstance(tool_args, (dict, list)) else str(tool_args),
                                },
                            }
                        ],
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": outcome["content"],
                    })
                    if outcome.get("halt"):
                        is_confirm = outcome.get("trace", {}).get("status") == "needs_confirmation"
                        res = Result.success("" if is_confirm else outcome["content"])
                        if is_confirm:
                            res.meta = {"needs_confirmation": True, **(outcome.get("confirm_meta") or {})}
                        return res, trace
                    continue

            # 真Steer — mid-flight course correction.
            #
            # The step boundary is the ONLY safe injection point: the provider
            # requires every assistant tool_calls message to be followed by its
            # matching tool results, so slipping a user message between them
            # would produce an invalid conversation. Here the previous step is
            # fully settled and the next model call hasn't been made yet, so an
            # extra user turn is legal and the model sees it immediately.
            #
            # Drains the whole queue: if the user fired three corrections while
            # a slow tool ran, all three land, in order, rather than one per step.
            steered = await self._drain_steer_into(messages, step)
            if steered:
                # If cancellation was triggered by a hard preempt for this steer,
                # clear the cancel flag so the turn continues with the new prompt.
                self._clear_cancel()
                # New instructions change what the model may legitimately need,
                # so re-read the tool specs (mode/permission may also have moved).
                tool_specs = self._tool_specs_for(context)
                self._catalogue_dirty = False
                context["steered"] = True
            elif self._cancel_requested():
                # Pure cancellation without steer: user clicked Stop.
                try:
                    from evolution_bridge import notify_turn_interrupted
                    notify_turn_interrupted(self.session_id, f"turn_{self._turn_seq}", reason="user_cancelled")
                except Exception:
                    pass
                return Result.failure("已中断（用户点击了停止）", cancelled=True, turn_outcome="cancelled"), trace
            elif self._catalogue_dirty:
                # 六·UC1：上一步 `tool_search` 浮出了新工具。步边界是唯一能安全
                # 换目录的时机 —— 请求一旦发出，那一次调用的目录就定了，所以命中
                # 的工具从**下一次**模型调用开始可见，而不是当场生效。
                tool_specs = self._tool_specs_for(context)
                self._catalogue_dirty = False


            # Soft landing. Two steps before the hard cap, tell the model that
            # room is running out and ask it to write a handover instead of
            # starting something new. Without this the cap arrives mid-action and
            # everything the turn discovered — files read, causes ruled out, the
            # half-applied edit — dies with the in-memory message list, and the
            # user gets a canned "ran out of steps" with nothing to resume from.
            # The hard cap below is unchanged: this only changes what the model
            # spends its last two steps on.
            if self.soft_landing_step > 0 and step == self.soft_landing_step and not context.get("_soft_landed"):
                context["_soft_landed"] = True
                messages.append({"role": "user", "content": SOFT_LANDING_NOTICE})

            # 模型调用前 overflow 预检 —— 折叠只在回合开始时跑一次，而且它只看
            # 落库历史：既不含系统提示，也不含工具定义 JSON，那两块常有一两万
            # token。第 0 步过去被 ``step > 0`` 整个跳过，等于最容易超的那一步
            # （历史 + 系统提示 + 全量工具定义，还没有任何工具结果可剪）反而
            # 没有任何保护。现在每一步都跑，且把 overhead 算进去：能剪就就地
            # 剪掉超额的旧工具输出（确定性、无需额外 LLM 往返、不动落库原文），
            # 剪不动就把 fits=False 如实播出去，而不是发一个必死的请求。
            try:
                self._sync_fold_budget()
                overhead = self._request_overhead_tokens(system_prompt, tool_specs)
                pre = self.compactor.precheck_inline(messages, overhead_tokens=overhead)
                if pre.get("pruned") or not pre.get("fits", True):
                    await self.bus.emit("context_precheck", {
                        "session_id": self.session_id,
                        "step": step,
                        **pre,
                    })
            except Exception:
                pass  # 预检失败绝不能让整个回合挂掉——大不了照原样发出去

            await emit_phase(self.bus, TurnPhase.MODEL_CALL_STARTED,
                             session_id=self.session_id, extra={"step": step})
            r = await self._llm_chat_streamed(
                messages, system=system_prompt, tools=tool_specs, step=step,
            )
            if not r.ok:
                # Before giving up: would a DIFFERENT model have worked? A quota
                # wall, a dead provider or a prompt that overflowed the window
                # are all recoverable by switching, and each wants a different
                # kind of switch (UD2).
                retried = await self._downgrade_and_retry(
                    r, messages, system_prompt, tool_specs, step,
                )
                if retried is not None:
                    r = retried
            if not r.ok:
                # LLM unreachable mid-loop: fall back so the turn still answers.
                if step == 0:
                    return await self._keyword_turn(user_message, context), trace
                # Lead with WHY in the product's language. This string is what
                # ends up in the assistant's row, so `LLM error after 3 steps:
                # HTTP 400: {"error":{...}}` was the wrong thing to show a user:
                # it names a step count they don't care about and buries the one
                # fact they can act on. The provider's raw text is kept after the
                # dash because it is what makes a bug report useful.
                from llm_errors import classify, describe
                meta = r.meta or {}
                failure = meta.get("failure") or classify(error=str(r.error or ""))
                reason = describe(failure)
                detail = str(r.error or "").strip()
                msg = f"{reason}，重试与备用模型都没能完成这次请求"
                if detail:
                    msg = f"{msg}（{truncate(detail, 400)}）"
                return Result.failure(msg), trace

            reply = r.value
            # Accumulate this step's provider-reported token usage into the turn
            # total. The agent loop can make many LLM calls per user turn, so we
            # can't record per-step or the dashboard's turn count triples.
            self._accumulate_usage(context, reply.get("usage") or {})
            from stream_scrubber import strip_protocol_tags
            calls = reply.get("tool_calls") or []
            content = strip_protocol_tags(reply.get("content") or "")

            await emit_phase(self.bus, TurnPhase.ASSISTANT_OUTPUT_STARTED,
                             session_id=self.session_id, extra={"step": step, "has_tools": bool(calls)})

            # Generated images can arrive on ANY step of the loop, not just the
            # final one. Collect raw refs now; they get written to disk once at
            # the end of the turn (see _persist_turn_images).
            self._harvest_images(reply, context)

            # Doc: TOOL_UI_UX §2 — surface the reasoning stream so the UI can
            # render a collapsible "Thinking…" panel next to the answer. Empty
            # payloads are dropped so the frontend never opens an empty card.
            reasoning = (reply.get("reasoning") or "").strip()
            # If the step called tools AND had content text, that content is intermediate step narration/rationale
            if calls and content:
                full_thought = f"{reasoning}\n\n{content}".strip() if reasoning else content
            else:
                full_thought = reasoning

            if full_thought:
                turn_reasonings.append({
                    "id": f"reasoning-{step}",
                    "step": step,
                    "text": full_thought,
                    "final": not calls,
                    "timestamp": time.time(),
                })
                await self.bus.emit("agent_reasoning", {
                    "session_id": self.session_id,
                    "step": step,
                    "text": full_thought,
                    "final": not calls,
                })

            if not calls:
                if not content and reply.get("finish_reason") == "length":
                    # Reasoning model spent the whole budget thinking — retry
                    # once with more room before declaring an empty answer.
                    r = await self._llm_chat_streamed(
                        messages, system=system_prompt, tools=tool_specs, step=step,
                        max_tokens=min(self.llm.max_tokens * 4, 16000),
                    )
                    if r.ok:
                        reply = r.value
                        content = strip_protocol_tags(reply.get("content") or "")
                        calls = reply.get("tool_calls") or []
                if not calls:
                    outcome = _summarize_turn_outcome(trace)
                    if not content:
                        if trace:
                            # 业界顶尖 Agent (Modern Autonomous Agents):
                            # 当模型完成多轮工具调用后返回空正文，不要立刻粗暴降级为固定模板，
                            # 而是进行一次轻量级的强制总结轮（Synthesis Turn, tools=None）：
                            # 此时关闭工具能力，模型会将注意力 100% 聚焦在生成人性化最终正文上！
                            synth_messages = list(messages)
                            synth_messages.append({
                                "role": "user",
                                "content": "请对刚才执行的所有操作和最终结果向用户进行简明扼要、人性化的总结汇报，如实说明成功与遇到的问题，禁止再调用任何工具。"
                            })
                            synth_r = await self._llm_chat_streamed(
                                synth_messages, system=system_prompt, tools=None, step=step,
                            )
                            if synth_r.ok and (synth_r.value.get("content") or "").strip():
                                content = synth_r.value.get("content").strip()
                                self._accumulate_usage(context, synth_r.value.get("usage") or {})
                            else:
                                if outcome["status"] == "all_failed":
                                    content = f"操作未能成功完成：{outcome['error_details'] or '工具执行遇到异常'}"
                                elif outcome["status"] == "partial":
                                    content = f"部分操作已完成，但部分步骤遇到问题：{outcome['error_details']}"
                                elif outcome["status"] == "all_success":
                                    content = "已为你执行完毕对应操作。"
                                else:
                                    content = f"操作执行完毕，但部分状态未确认：{outcome.get('error_details', '')}"
                        else:
                            content = "已收到，已准备处理。"

                    if outcome["status"] == "all_failed":
                        return Result.failure(content or outcome.get("error_details") or "工具执行失败", outcome=outcome), trace
                    if outcome["status"] == "partial":
                        return Result.success(content, outcome=outcome, partial=True), trace
                    return Result.success(content, outcome=outcome), trace

            # Record the assistant's tool-call turn verbatim; the provider
            # requires it to precede the matching tool results.
            messages.append({
                "role": "assistant",
                "content": content or None,
                "tool_calls": [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {
                            "name": c["name"],
                            "arguments": json.dumps(c["arguments"], ensure_ascii=False),
                        },
                    }
                    for c in calls
                ],
            })

            # Execute this step's tool calls. Consecutive side-effect-free reads
            # run concurrently; everything else stays strictly serial so writes,
            # shell commands and confirmation prompts keep their ordering.
            i = 0
            while i < len(calls):
                if self._cancel_requested():
                    try:
                        from evolution_bridge import notify_turn_interrupted
                        notify_turn_interrupted(self.session_id, f"turn_{self._turn_seq}", reason="user_cancelled")
                    except Exception:
                        pass
                    return Result.failure("已中断（用户点击了停止）", cancelled=True, turn_outcome="cancelled"), trace

                # Greedily take the longest run of parallel-safe calls from here.
                j = i
                while j < len(calls) and self._is_parallel_safe(calls[j]):
                    j += 1
                batch = calls[i:j]

                await emit_phase(self.bus, TurnPhase.TOOL_EXECUTION_STARTED,
                                 session_id=self.session_id,
                                 extra={"step": step,
                                        "tools": [c.get("name") for c in (batch or [calls[i]])]})

                if len(batch) > 1:
                    # asyncio.gather preserves input order in its results, so the
                    # tool-result rows still line up with the assistant's
                    # tool_calls array even though execution interleaved.
                    outcomes = await asyncio.gather(
                        *(self._run_tool_call(c, context) for c in batch),
                        return_exceptions=True,
                    )
                    for c, outcome in zip(batch, outcomes):
                        if isinstance(outcome, BaseException):
                            # One reader blowing up must not lose the others.
                            outcome = {
                                "content": f"[error] {outcome}",
                                "trace": {"tool": c.get("name"), "error": str(outcome)},
                            }
                        trace.append(outcome["trace"])
                        messages.append({
                            "role": "tool",
                            "tool_call_id": c["id"],
                            "content": outcome["content"],
                        })
                    # Close the bracket TOOL_EXECUTION_STARTED opened. The phase
                    # was declared in `agent_phases.py` with a documented payload
                    # (`tool` + `ok`) but had zero emit sites anywhere in the repo
                    # — so anyone reading the enum believed there was a completion
                    # signal that never fired. Per-tool latency and "which tool
                    # was the turn sitting in" are both derivable from the phase
                    # stream only if starts have matching finishes.
                    await emit_phase(self.bus, TurnPhase.TOOL_EXECUTION_FINISHED,
                                     session_id=self.session_id,
                                     extra={"step": step,
                                            "tools": [c.get("name") for c in batch],
                                            "ok": all(self._outcome_ok(o) for o in outcomes)})
                    # A halt inside a parallel batch should be impossible:

                    # `_is_parallel_safe` only ever batches LOW-risk reads from
                    # PARALLEL_SAFE_TOOLS, and neither a confirmation nor
                    # `ask_user` can come out of one. But "impossible because of
                    # a whitelist somewhere else" is exactly the kind of implicit
                    # dependency that breaks the day the whitelist grows, and the
                    # failure mode is silent: the turn would keep calling the
                    # model while a question sits unanswered on screen. Every
                    # result is already appended above, so honouring it here
                    # costs nothing.
                    halted = next((o for o in outcomes
                                   if isinstance(o, dict) and o.get("halt")), None)
                    if halted is not None:
                        is_confirm = halted.get("trace", {}).get("status") == "needs_confirmation"
                        res = Result.success("" if is_confirm else halted["content"])
                        if is_confirm:
                            res.meta = {"needs_confirmation": True,
                                        **(halted.get("confirm_meta") or {})}
                        return res, trace
                    i = j
                    continue

                # Single call (either not parallel-safe, or a lone read).
                call = calls[i]
                outcome = await self._run_tool_call(call, context)
                trace.append(outcome["trace"])
                messages.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": outcome["content"],
                })
                await emit_phase(self.bus, TurnPhase.TOOL_EXECUTION_FINISHED,
                                 session_id=self.session_id,
                                 extra={"step": step,
                                        "tools": [call.get("name")],
                                        "ok": self._outcome_ok(outcome)})
                if outcome.get("halt"):
                    # Confirmation required / blocked: stop and surface it now
                    # rather than letting the model narrate around the block.
                    # When halting for needs_confirmation, the interactive prompt is already
                    # attached to the tool card in the ActivityFeed (Trace UI). Returning empty
                    # text avoids double-rendering a duplicate chat bubble at the bottom.
                    is_confirm = outcome.get("trace", {}).get("status") == "needs_confirmation"
                    res = Result.success("" if is_confirm else outcome["content"])
                    if is_confirm:
                        res.meta = {"needs_confirmation": True,
                                    **(outcome.get("confirm_meta") or {})}
                    return res, trace

                # RepeatToolGuard: 检查循环死锁并在下一轮注入建议提示
                if hasattr(self, "repeat_tool_guard") and self.repeat_tool_guard:
                    loop_alert = self.repeat_tool_guard.check_loop()
                    if loop_alert:
                        messages.append({
                            "role": "user",
                            "content": loop_alert["advisory_message"]
                        })
                        try:
                            from evolution import record_user_correction
                            record_user_correction(
                                self.storage, self.session_id,
                                user_message=loop_alert["advisory_message"],
                                correction=loop_alert["failure_signature"],
                                category="tool_repeat_loop",
                            )
                        except Exception:
                            pass
                i += 1

        # Step cap hit. This is NOT a successful answer — the loop was cut off.
        # It still returns ``success`` because the caller needs the text to show
        # the user, but ``incomplete`` in the meta is what lets a caller (notably
        # subagent_runtime) tell "finished" apart from "ran out of room". Without
        # it a truncated sub-task reports COMPLETED and the parent believes the
        # work is done.
        # The text points at the Goals panel, which is the only real entry point
        # for a long-running task (frontend POSTs /api/goals then
        # /api/goals/{id}/run, handled by the scheduler). It used to say
        # "run it as a goal (`run_goal`)" — `run_goal` is not a registered tool
        # and `Router.run_goal` has no call sites, so that was pointing the user
        # at something that does not exist.
        # Step cap hit (only reachable if a positive max_agent_steps ceiling was configured).
        if self.max_agent_steps > 0:
            self._check_context_pressure(messages, context)
            return Result.success(
                f"连续用了 {self.max_agent_steps} 步工具还没得出结论，先停下来了。"
                "可以把要求拆小一点再说一次，或到「设置 → 智能体行为」调高或解除每轮步数上限；"
                "如果本来就是个长任务，"
                "到「目标」面板建一个目标再执行，那条路有独立的迭代预算和进度记录。",
                incomplete=True, stop_reason="step_cap",
            ), trace

        self._check_context_pressure(messages, context)
        outcome = _summarize_turn_outcome(trace)
        return Result.success("已完成全部操作。", outcome=outcome), trace

    def _check_context_pressure(self, messages: list, context: dict) -> None:
        """Probe context pressure and trigger evolution if threshold breached."""
        try:
            from evolution_pressure import probe_context_pressure
            comp = getattr(self, "compactor", None)
            budget = getattr(comp, "max_tokens", 80000) if comp else 80000
            th = getattr(comp, "threshold", 0.8) if comp else 0.8
            turn_id = str(context.get("turn_id") or f"turn_{getattr(self, '_turn_seq', 1)}")
            triggered, ratio, sig_id = probe_context_pressure(
                messages, max_context_tokens=budget, threshold=th,
                session_id=getattr(self, "session_id", ""), turn_id=turn_id,
            )
            if triggered:
                context["context_pressure_triggered"] = True
                context["context_pressure_ratio"] = ratio
        except Exception:
            pass  # fail-open

    def _model_can_output_images(self) -> bool:
        """Does the active model emit images? Read from the model registry.

        Gates the image-generation hint below. Without this check a slow text
        model (or a reasoning model pausing mid-answer) would claim to be drawing
        a picture — a wrong progress message is worse than none.
        """
        info = self.models.resolve(self._turn_model or None)
        if not info.ok or not isinstance(info.value, dict):
            return False
        modalities = info.value.get("modalities") or {}
        # Two shapes in the wild: the registry's per-model list (["text","image"])
        # and the provider-catalogue dict ({"input": [...], "output": [...]}).
        # Only the dict form can promise OUTPUT images; a flat list says nothing
        # about direction, so treat it as input-only and stay quiet.
        if isinstance(modalities, dict):
            out = modalities.get("output") or []
        else:
            out = []
        return "image" in out if isinstance(out, (list, tuple, set)) else False

    def _model_can_read_images(self) -> bool:
        """Can the active model SEE an attached image? (UB3)

        Reads `supports_vision` off the resolve payload, which is the registry's
        already-settled answer: an explicit provider declaration when the user
        made one, the modality list otherwise (#151). Deliberately not re-derived
        here — two places inferring vision is how they end up disagreeing, and
        the disagreement surfaces as a 400 from the provider.

        Fails CLOSED: an unresolvable model is treated as text-only, so the
        images turn into an explicit note instead of a request the provider
        rejects. Being told "this model can't see it" is recoverable; a failed
        turn is not.
        """
        info = self.models.resolve(self._turn_model or None)
        if not info.ok or not isinstance(info.value, dict):
            return False
        return bool(info.value.get("supports_vision"))

    async def _image_hint_watchdog(self, step: int, delay: float) -> None:
        """Announce likely image generation after the token stream goes quiet.

        # Why a watchdog instead of reading it off the API

        Native image generation (Gemini 2.x image, gpt-image) is not a separate
        call we can observe starting — it happens *inside* one chat-completions
        request. The model streams a little text ("好的，我来画…"), then goes
        silent for 5-30s while it renders, then the image arrives with the final
        response. No provider event marks the start of that silence.

        So we infer it: silence + an image-capable model ≈ drawing. The timer is
        independent of the socket on purpose — a provider that sends no SSE
        keepalives would never wake a data-driven check, and those are exactly
        the requests that look frozen.

        # Why it can't mislead

        Cancelled by any content or reasoning delta, so ordinary slow typing
        never triggers it. Gated on `_model_can_output_images`, so text-only
        models never trigger it. Worst case on a false positive: the hint shows
        for a moment and disappears the instant real tokens resume.
        """
        try:
            await asyncio.sleep(delay)
            await self.bus.emit("agent_image_generating", {"step": step, "session_id": self.session_id})
        except asyncio.CancelledError:
            pass  # fail-open: 取消语义即静默，正确

    async def _llm_chat_streamed(
        self,
        messages: list,
        system: str,
        tools: list,
        step: int,
        max_tokens: int = None,
    ) -> Result:
        """Call the LLM with token streaming; push content deltas to the bus.

        Emits ``agent_delta`` for each visible content piece so the WebSocket
        bridge can grow the assistant bubble live. Assembles the same reply
        shape as ``llm.chat`` for the rest of the agent loop.
        """
        reply = None
        # Only armed for image-capable models; see _image_hint_watchdog.
        watchdog: Optional[asyncio.Task] = None
        if self._model_can_output_images():
            watchdog = asyncio.create_task(
                self._image_hint_watchdog(step, IMAGE_HINT_DELAY)
            )

        def _disarm() -> None:
            if watchdog and not watchdog.done():
                watchdog.cancel()

        # Tool-call argument fragments arrive a few characters at a time. One WS
        # frame per fragment would be hundreds of frames for a single long
        # `write_file`, so coalesce on the same budget `_flush_output` already
        # uses for tool stdout: emit the first frame for a slot immediately (so
        # the card appears the moment the model names the tool) and then at most
        # one every TOOL_ARG_FRAME_INTERVAL.
        arg_seen: dict[int, float] = {}
        arg_last: dict[int, dict] = {}
        answer_content_started = False
        reasoning_started = False

        async def _emit_tool_arg(ev: dict, *, force: bool = False) -> None:
            idx = int(ev.get("index") or 0)
            arg_last[idx] = ev
            now = time.time()
            last = arg_seen.get(idx)
            if last is not None and not force and (now - last) < TOOL_ARG_FRAME_INTERVAL:
                return
            arg_seen[idx] = now
            await self.bus.emit("tool_call_delta", {
                "session_id": self.session_id,
                "step": step,
                "index": idx,
                "call_id": ev.get("call_id") or "",
                "name": ev.get("name") or "",
                "arguments": ev.get("arguments") or "",
                "final": bool(force),
            })

        async def _flush_tool_args() -> None:
            """Force out the last fragment of every slot.

            Without this the throttle can swallow the final delta, and the UI's
            preview stops a few characters short of what the model actually sent
            — a preview that quietly disagrees with the call being executed is
            worse than no preview.
            """
            for ev in list(arg_last.values()):
                try:
                    await _emit_tool_arg(ev, force=True)
                except Exception:
                    pass  # fail-open: 可选增强，失败不影响主流程


        try:
            temp_override = 0.0 if getattr(self, "_benchmark_mode", False) else None
            async for ev in self.llm.chat_stream(
                messages, system=system, tools=tools, max_tokens=max_tokens,
                temperature=temp_override,
                # Per-turn thinking budget (UD4). Translated to the provider's own
                # field inside llm_client, and dropped entirely for models that
                # have no such dial.
                reasoning_effort=self._turn_effort,
                # 3.3: where the unchanging head of the system prompt ends, so
                # the provider can cache it instead of re-billing identical
                # bytes every turn. Verified against `system` inside llm_client
                # and ignored unless it really is a prefix, so a drift between
                # the two just means no caching — never a mangled prompt.
                cache_prefix=self._sys_cache_prefix,
                # The rate limiter can hold a request at the gate. Hand it this
                # turn's cancel flag so pressing stop actually stops instead of
                # waiting out a queue the user can't see. Popped inside
                # llm_client before the body is built, so it never ships.
                abort_check=self._cancel_requested,
            ):
                kind = ev.get("type")
                if kind == "content":
                    text = ev.get("text") or ""
                    if text:
                        # LongCat and similar gateways may emit "0" / punct on the
                        # content channel before OR during CoT. Two leak shapes:
                        # whole-frame junk ("0") and junk glued to real text
                        # ("0你好") — the latter slipped past the old frame-level
                        # check and the bubble started with a stray "0" that
                        # vanished when agent_response replaced it. Strip a short
                        # junk prefix instead of dropping the frame.
                        if not answer_content_started:
                            stripped = _strip_leading_junk(text)
                            if not stripped:
                                continue
                            text = stripped
                            answer_content_started = True
                        # Real tokens are arriving — this is not a render pause.
                        _disarm()
                        await self.bus.emit("agent_delta", {
                            "session_id": self.session_id,
                            "step": step,
                            "text": text,
                        })
                elif kind == "reasoning":
                    # Reasoning models (DeepSeek-R1, o1, …) can think for 15-30s
                    # before emitting a single visible token. llm_client already
                    # streams the CoT deltas; dropping them here is what made
                    # long thinking look like the app had frozen. Forward each
                    # piece so the UI can type it out live. The consolidated
                    # `agent_reasoning` still fires at the end of the step for
                    # anything that only wants the final block.
                    text = ev.get("text") or ""
                    if text:
                        # The same gateway junk leaks onto the reasoning channel
                        # (leading "0"/punct before CoT starts). Strip a short
                        # junk prefix once at reasoning start; CoT's own numeric
                        # content ("1. 先…") has prefixes >2 chars and survives.
                        if not reasoning_started:
                            stripped = _strip_leading_junk(text)
                            if not stripped:
                                continue
                            text = stripped
                            reasoning_started = True
                        # Thinking is its own visible state; don't also claim
                        # we're drawing.
                        _disarm()
                        await self.bus.emit("agent_reasoning_delta", {
                            "session_id": self.session_id,
                            "step": step,
                            "text": text,
                        })
                elif kind == "tool_call_delta":
                    # The model is writing out a tool call. Not a render pause,
                    # and not silence either — this is the gap that used to look
                    # like a hang on any call with a large argument.
                    _disarm()
                    await _emit_tool_arg(ev)
                elif kind == "done":
                    _disarm()
                    await _flush_tool_args()
                    reply = ev.get("reply")
                elif kind == "error":
                    _disarm()
                    # Carry the provider's error code so the caller can classify
                    # the failure and decide whether a different model would help
                    # (UD2). Without this the stream collapses every failure to a
                    # bare string and downgrade can't tell quota from overflow.
                    return self._stream_failure(ev)
        except Exception as e:
            return Result.failure(f"LLM stream failed: {e}", code="Transport")
        finally:
            # A leaked watchdog would fire mid-way through the NEXT step and
            # announce a phantom image generation.
            _disarm()

        if reply is None:
            return Result.failure("LLM stream ended without a reply", code="EmptyResponse")
        return Result.success(reply)

    @staticmethod
    def _stream_failure(ev: dict) -> Result:
        """Turn a stream ``error`` event into a Result carrying failure semantics."""
        from llm_errors import classify, recovery_for
        code = str(ev.get("code") or "")
        err = ev.get("error") or "LLM stream error"
        failure = classify(code=code, error=err)
        r = Result.failure(err, code=code)
        r.meta["failure"] = failure
        r.meta["recovery"] = recovery_for(failure)
        return r

    async def _run_moa_council(
        self, messages: list, user_message: str, context: dict,
    ) -> None:
        """执行一轮 MoA 会诊并把意见块并入 messages（Phase 35）。

        advisor 池来自 model_registry.scene_candidates("main")——只从用户
        已配置、已带凭证、清过能力门槛的模型里挑，跨 provider 优先；客户端
        走 LLMClient.bind（与降级重试同一套绑定机制）。意见作为「同行会诊」
        块并进本轮末尾的 user 消息内容（不新增消息行，历史形状保持稳定，
        缓存断点与 compactor 的轮次视角都不受影响），并通过 bus 事件让
        前端实时展示「正在征询哪些模型、各自说了什么」。
        """
        from moa import MAX_ADVISORS, convene, select_advisors

        candidates = []
        try:
            candidates = self.models.scene_candidates("main") or []
        except Exception:
            pass  # 注册表不可用就单干
        advisors = select_advisors(candidates, self.llm.model_id, limit=MAX_ADVISORS)
        await self.bus.emit("moa_advisors", {
            "session_id": self.session_id,
            "step": 0,
            "advisors": [
                {"model": a.get("model_id"), "provider": a.get("provider_id")}
                for a in advisors
            ],
            "phase": "asking",
        })
        if not advisors:
            return  # 没有第二个模型：静默降级为单模型，不打扰用户

        # 会诊问题就是本轮用户请求；最近对话只给一小段摘要，控制 advisor 成本
        recent_tail = ""
        try:
            tail_msgs = [m for m in messages[-4:] if m.get("role") != "system"]
            parts = []
            for m in tail_msgs:
                c = m.get("content")
                if isinstance(c, str) and c:
                    parts.append(f"[{m['role']}] {c[:220]}")
            recent_tail = "\n".join(parts)[:1200]
        except Exception:
            pass

        council = await convene(self.llm, advisors, user_message, recent_tail)

        await self.bus.emit("moa_advisors", {
            "session_id": self.session_id,
            "step": 0,
            "phase": "answered",
            "elapsed_s": round(council.elapsed_s, 2),
            "opinions": [
                {"model": o.model_id, "ok": o.ok, "elapsed_s": round(o.elapsed_s, 2),
                 "error": o.error, "text": o.text[:2000] if o.ok else ""}
                for o in council.opinions
            ],
        })

        if council.council_block:
            # 并进本轮 user 消息：块以附加段形式存在，历史行数不变——
            # 对 compactor 的轮次视角和缓存断点都零扰动。
            last = messages[-1]
            if last.get("role") == "user":
                c = last.get("content")
                sep = "" if not isinstance(c, str) or not c.strip() else "\n\n"
                last["content"] = (c if isinstance(c, str) else str(c or "")) + sep + council.council_block

    async def _downgrade_and_retry(
        self, failed: Result, messages: list, system: str, tools: list, step: int,
    ) -> Optional[Result]:
        """After an LLM failure, try a better-suited model — if one exists (UD2).

        The failed Result carries ``meta["recovery"]`` (from ``llm_errors``),
        which says what "better" means for THIS failure: a bigger context window
        for an overflow, a different provider for an exhausted quota, anything
        healthy for a bad model id. We ask the registry for candidates in that
        direction and try them cheapest-first, emitting a user-visible
        ``model_downgraded`` event on each hop so the change is never silent.

        Returns the first successful Result, or None to let the caller report the
        original failure. Never raises — a downgrade that itself fails must not
        turn a recoverable error into a crash. ``self.llm`` is always restored.
        """
        from llm_errors import RECOVER_NONE, describe, is_permanent
        meta = failed.meta or {}
        recovery = meta.get("recovery") or RECOVER_NONE
        failure = meta.get("failure") or ""
        if not recovery:
            return None

        origin = self.llm
        cur_pid = getattr(origin, "provider_id", "") or ""
        cur_model = origin.model_id
        current = f"{cur_pid}:{cur_model}" if cur_pid else cur_model

        # A provider that hard-failed gets a strike, so a persistent outage stops
        # costing a full timeout every turn. Rate limits are NOT hard failures —
        # the provider is alive, we were just too fast — so they never count here.
        if cur_pid and failure and is_permanent(failure):
            try:
                self.models.note_provider_failure(cur_pid, failure)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

        try:
            candidates = self.models.downgrade_candidates(
                current, recovery=recovery,
                needed_context=self.llm.estimate_request_tokens(
                    {"messages": messages}
                ),
            )
        except Exception:
            candidates = []
        if not candidates:
            return None

        succeeded = False
        try:
            for cand in candidates:
                try:
                    self.llm = origin.bind(cand)
                except Exception:
                    continue
                if self.llm is origin:  # nothing actually changed; not a hop
                    continue
                if cur_model != self.llm.model_id:
                    await self.bus.emit("model_downgraded", {
                        "session_id": self.session_id,
                        "step": step,
                        "reason": recovery,
                        "failure": failure,
                        # The PRECISE cause, phrased for a person. `reason` is only the
                        # recovery direction, and four different failures share
                        # "other_provider" — quota, a rejected key, a provider 5xx and
                        # a rate limit. The banner used to name quota for all four,
                        # which sends the user to top up credits when the real problem
                        # is a bad key. `describe` is the same vocabulary the rest of
                        # the app uses, so there is one source of truth for the wording.
                        "failureText": describe(failure) if failure else "",
                        "fromModel": cur_model,
                        "toModel": self.llm.model_id,
                        "toProvider": cand.get("provider_name", ""),
                    })
                r = await self._llm_chat_streamed(
                    messages, system=system, tools=tools, step=step,
                )
                if r.ok:
                    pid = cand.get("provider_id") or ""
                    if pid:
                        try:
                            self.models.note_provider_success(pid)
                        except Exception:
                            pass  # fail-open: 可选增强，失败不影响主流程
                    succeeded = True
                    return r
            return None
        finally:
            # Only roll back when nothing worked. Restoring `origin` after a
            # SUCCESSFUL hop was a real bug: the turn continues for up to
            # MAX_AGENT_STEPS iterations, each one starting a fresh LLM call, so
            # putting the just-failed model back meant step n+1 failed exactly
            # like step n, re-ran this whole function, re-picked the same
            # candidate (the selection is stateless) and emitted a byte-identical
            # "switched provider" banner. That is why one message could paper the
            # transcript with the same notice over and over. A hop that worked is
            # now kept for the rest of the turn — one switch, one notice.
            if not succeeded:
                self.llm = origin


    async def _keyword_turn(self, user_message: str, context: dict) -> Result:
        """Deterministic fallback used when no LLM is configured."""
        approved = context.get("approved_pending")
        if approved is not None:
            tool_name = getattr(approved, "tool_name", None) or (approved.get("tool_name") if isinstance(approved, dict) else "")
            tool_args = getattr(approved, "args", None) if not isinstance(approved, dict) else approved.get("args", {})
            call_id = (
                getattr(approved, "call_id", None)
                or (approved.get("call_id") if isinstance(approved, dict) else "")
                or context.get("consent_call_id")
                or ""
            )
            if call_id:
                context["call_id"] = call_id
            dispatch = {
                "type": "direct",
                "agent": None,
                "primary_tool": tool_name,
                "args": tool_args,
            }
            context["risk_level"] = self.risk.classify_risk(
                tool_name, tool_args
            ).value
            context["confirmed"] = True
            return await self._execute(dispatch, context)

        intent = self._recognize_intent(user_message)
        if not intent.get("primary_tool"):
            # Nothing in the keyword table matched, which is the normal case for
            # anything conversational ("你好", a question, a follow-up). The old
            # reply here was a bare English "No action determined. Please clarify
            # your request." — it told the user their phrasing was at fault when
            # the real situation is that there is no model to talk to. A greeting
            # is not an unclear request; it is a request this mode structurally
            # cannot serve. Say that instead.
            return Result.success(self._degraded_reply())
        context["risk_level"] = self.risk.classify_risk(
            intent.get("primary_tool", ""), intent.get("args", {})
        ).value
        dispatch = self._determine_dispatch(intent, user_message, context)
        return await self._execute(dispatch, context)

    def _degraded_reply(self) -> str:
        """What to say when keyword routing has nothing to route.

        Two different situations reach here and they need different answers:
        no model configured at all (the common one — fix it in Settings), versus
        a configured model that this turn fell back away from. Reporting the
        first as the second sends the user hunting for a phrasing problem that
        does not exist.

        Bilingual on purpose: this string is produced deep in the backend, which
        has no access to the UI's active locale, and it is the one reply a
        brand-new user is most likely to see.
        """
        if not (self.llm and self.llm.api_key):
            return (
                "尚未配置模型，当前运行在关键词降级模式，无法进行对话。\n"
                "请到「设置 → 服务商」填入 API Key 后重试。\n"
                "（降级模式下仅能识别少量显式指令，例如「git status」「读 README.md」。）\n\n"
                "No model is configured. Running in keyword-only fallback mode, "
                "so conversation is unavailable. Add an API key under "
                "Settings → Providers and try again."
            )
        return (
            "这一轮没有走模型，关键词模式也没有匹配到可执行的操作。请换一种说法，"
            "或直接说明要操作的文件 / 命令。\n\n"
            "This turn did not reach the model and no keyword rule matched. "
            "Try rephrasing, or name the file / command directly."
        )


    def _build_history(self, limit: int = 20, drop_trailing_user: bool = True) -> list[dict]:
        """Build LLM message history from stored turns.

        The current user message was already persisted by ``handle``, so the
        trailing user row is dropped to avoid sending it twice.

        ``limit`` selects the **newest** rows, not the oldest. That distinction is
        the whole ballgame: ``get_messages(sid, limit=20)`` reads
        ``ORDER BY seq LIMIT 20``, and since ``seq`` ascends from zero that hands
        back the twenty rows from the very start of the conversation. Any session
        longer than the limit would then replay its own opening forever while the
        model never saw a word of what was just said.

        Fold-aware: if the window contains a compaction (fold) marker, replay
        starts from the NEWEST one — the summary stands in for every raw turn
        before it, which is the whole point of folding. The summary is injected as
        a ``system`` message so the model treats it as context, not as something
        the user said. This only works on a tail window; on a head window the
        marker sits past the end and is never found.

        Args:
            limit: How many of the most recent stored rows to consider.
            drop_trailing_user: Whether to drop the trailing user message. Defaults
                to True (since handle normally persists the user message first).
                False when silent_consent is True because the turn was not persisted.

        Returns:
            List of ``{role, content}`` dicts in chronological order.
        """
        rows = self.storage.get_recent_messages(self.session_id, limit=limit) or []

        # Find the newest fold marker; everything before it is represented by it.
        fold_idx = -1
        for i in range(len(rows) - 1, -1, -1):
            mt = rows[i]["msg_type"] if "msg_type" in rows[i].keys() else None
            if mt == "compaction":
                fold_idx = i
                break

        history: list[dict] = []
        if fold_idx >= 0:
            summary = rows[fold_idx]["content"] if "content" in rows[fold_idx].keys() else ""
            if summary:
                history.append({
                    "role": "system",
                    "content": self.compactor._unseal(summary),
                })
            window = rows[fold_idx + 1:]
        else:
            window = rows

        for row in window:
            role = row["role"] if "role" in row.keys() else None
            content = row["content"] if "content" in row.keys() else None
            mt = row["msg_type"] if "msg_type" in row.keys() else None
            if mt == INTERRUPT_NOTE_TYPE and content:
                # The hidden nudge. Injected as `system` for the same reason the
                # fold summary is: it's context ABOUT the conversation, not a
                # thing the user said. Replayed so the next turn knows the last
                # one was cut off mid-work — without it the model reads its own
                # truncated reply as a finished answer and moves on, silently
                # abandoning whatever was half-done.
                history.append({"role": "system", "content": content})
                continue
            if role in ("user", "assistant") and content:
                history.append({"role": role, "content": content})
        if drop_trailing_user and history and history[-1]["role"] == "user":
            history.pop()
        return history

