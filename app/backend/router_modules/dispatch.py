"""router_modules/dispatch.py - Tool execution, dispatching, and audit mixin."""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Any, Callable, Optional

from ask_user import (
    ASK_WAIT_TIMEOUT_S,
    AUTO_RESOLVE_SYSTEM,
    PendingQuestion,
    build_auto_resolve_user_prompt,
    drop_waiter,
    get_ask_user_store,
    normalize_questions,
    parse_auto_resolution,
    register_waiter,
    render_answer,
)
from execution_provider import (
    MODE_DANGER_FULL,
    MODE_REFUSED,
    risk_to_rlevel,
    select_execution,
)
from executors import cancel_call, register_output_sink, unregister_output_sink
from image_store import placeholder as _image_placeholder, save_ref as _save_image_ref
from result import Result
from risk_control import RiskLevel, parse_consent
import threading
from tool_hooks import HookStage, get_tool_hooks
from tools import shorten_path, truncate
from router_modules.prompt import EnvironmentSnapshot

MUTATING_WORKSPACE_TOOLS = {
    "write_file", "edit_file", "apply_patch", "delete_file", "move_file", "rename_file",
    "create_file", "append_file", "replace_file_content", "write_to_file", "file_write", "file_edit",
    "run_shell", "run_command", "git_commit", "git_checkout", "git_add", "git_reset",
    "git_merge", "git_rebase", "git_cherry_pick", "git_stash", "git_pull", "git_branch",
    "worktree_create", "worktree_switch", "worktree_delete",
}

AGENT_ROLES = {
    "file_agent": {"domain": "file", "tools": ["read_text","write_file","edit_file","search_code","find_files","list_dir","git_status","git_add","git_commit","git_push"]},
    "computer_agent": {"domain": "computer", "tools": ["shell_executor","action_search","native_action_chain","cua_action"]},
    "app_agent": {"domain": "app", "tools": ["computer_screenshot","computer_click","computer_move_cursor","computer_type","computer_press_key","computer_drag","computer_scroll","app_launch","app_close","app_focus","app_list","operate_app","ui_automation"]},
    "browser_agent": {"domain": "browser", "tools": ["navigate","snapshot","click","fill","evaluate","web_fetch","tab_open","tab_switch","tab_close","tab_suspend","tab_resume","tab_list","viewport","tab_screenshot","session_suspend","session_resume"]},
    "search_agent": {"domain": "search", "tools": ["academic_search","standard_search","web_search","credibility_check"]},
}

PARALLEL_SAFE_TOOLS = frozenset({
    "read_text", "read_file", "search_code", "find_files", "list_dir",
    "web_fetch", "web_search", "semantic_search", "academic_search",
    "git_status", "git_log", "git_diff", "git_show", "system_info",
    "grep", "glob",
    "tool_search",
})

def _summarize_turn_outcome(trace: list[dict]) -> dict:
    """Analyze the execution trace of the current turn deterministically."""
    if not trace:
        return {"status": "empty", "failed_tools": [], "successful_tools": [], "error_details": ""}
    
    successful = []
    failed = []
    errors = []
    
    for t in trace:
        st = str(t.get("status") or "").lower()
        is_ok = t.get("ok")
        # An unknown status or error or explicit ok=False must NOT be considered successful
        if (
            st in ("failed", "error", "unknown", "rejected", "blocked")
            or is_ok is False
            or (t.get("error") and not (st in ("ok", "success") or is_ok is True))
            or (st not in ("ok", "success") and is_ok is not True)
        ):
            failed.append(t)
            err = t.get("error") or t.get("output") or ""
            tname = t.get("tool") or t.get("name") or "tool"
            if err:
                err_first = str(err).strip().split("\n")[0]
                errors.append(f"{tname}: {truncate(err_first, 80)}")
            else:
                errors.append(f"{tname} failed (status={st or 'unconfirmed'})")
        else:
            successful.append(t)
                
    if not failed:
        return {"status": "all_success", "failed_tools": [], "successful_tools": successful, "error_details": ""}
    elif not successful:
        return {
            "status": "all_failed",
            "failed_tools": failed,
            "successful_tools": [],
            "error_details": "; ".join(errors[:2]),
        }
    else:
        return {
            "status": "partial",
            "failed_tools": failed,
            "successful_tools": successful,
            "error_details": "; ".join(errors[:2]),
        }



class RouterDispatchMixin:
    """Mixin providing tool dispatching, execution, ask-user, and presentation."""

    def _tool_specs_for(self, context: dict) -> list[dict]:
        """Build the tool catalogue exposed to the model for this turn.

        Remote (bot) sessions get the denylisted tools stripped from the
        catalogue entirely — belt and braces alongside the runtime block, so the
        model is not even tempted to propose them.
        """
        exclude: set[str] = set()
        if context.get("is_remote"):
            try:
                from bot_remote import get_bot_controller
                exclude = set(
                    get_bot_controller().load_tool_denylist(context.get("platform", ""))
                )
            except Exception:
                exclude = set()
        # Sub-agent allowlist: invert it into the exclude set the registry
        # already understands, so a read-only sub-agent never even SEES a write
        # tool. `_run_tool_call` re-checks at dispatch — hiding a tool from the
        # catalogue is a hint, blocking it is the guarantee.
        if self.allowed_tools is not None:
            for tool in self.tools.list_tools():
                if tool.name not in self.allowed_tools:
                    exclude.add(tool.name)
        # A sub-agent may not spawn further sub-agents — except through an
        # explicit hand-off allowlist on its own persona, and only one level
        # deep. Without a cap a runaway prompt could fan out recursively and
        # exhaust the semaphore, which is why `handoffs` is data on the
        # definition rather than something the model can talk its way into.
        if self.is_subagent and not self._may_hand_off():
            exclude.add("task")
        # `ask_user` needs a clickable card in front of a human. Two callers have
        # nobody to click it: a sub-agent (its parent is blocked waiting on a
        # final marker, and the question would render on nobody's screen), and a
        # remote/bot session (no card UI at all). Hiding it is better than
        # letting either one park a question that can never be answered.
        # P3-2: 子代理 MCP 工具数硬顶 (默认 24，SubagentDef.mcp_tool_cap 可覆写) 与 mcpRules 过滤
        if self.is_subagent or context.get("is_subagent"):
            mcp_cap = getattr(self, "mcp_tool_cap", None)
            if mcp_cap is None:
                mcp_cap = context.get("mcp_tool_cap", 24)
            d_rules = getattr(self, "domain_rules", {}) or context.get("domain_rules", {})
            mcp_rules = d_rules.get("mcpRules", {}) if isinstance(d_rules, dict) else {}
            deny_mcp = mcp_rules.get("deny", [])
            allow_mcp = mcp_rules.get("allow", [])

            import fnmatch
            all_mcp_tools = [t.name for t in self.tools.list_tools() if t.name.startswith("mcp__")]
            visible_mcp = []
            for t_name in all_mcp_tools:
                if any(fnmatch.fnmatch(t_name, pat) for pat in deny_mcp):
                    exclude.add(t_name)
                    continue
                if allow_mcp and allow_mcp != ["*"]:
                    if not any(fnmatch.fnmatch(t_name, pat) for pat in allow_mcp):
                        exclude.add(t_name)
                        continue
                if t_name not in exclude:
                    visible_mcp.append(t_name)

            if len(visible_mcp) > mcp_cap:
                truncated = visible_mcp[mcp_cap:]
                for t_name in truncated:
                    exclude.add(t_name)
                import logging
                logging.getLogger("router.subagent").info(
                    "子代理 MCP 工具数超出硬顶 (%d > %d)，已截断 %d 个工具",
                    len(visible_mcp), mcp_cap, len(truncated)
                )

        # 六·UC1 检索式目录裁剪。只对主会话生效：子代理已经有 allowlist、远程
        # 已经有 denylist，两者都是**按职责**收窄的，再叠一层**按相关性**收窄
        # 只会让「为什么这个工具不见了」变成两个原因的乘积。
        #
        # 这一步和上面三个来源共用同一个 exclude，所以它同样只是提示 ——
        # `_run_tool_call` 那边的校验一个字都没动。
        if not self.is_subagent and not context.get("is_remote"):
            try:
                from tool_catalog import trim_exclude
                exclude |= trim_exclude(
                    self.tools,
                    query=str(context.get("_turn_query") or ""),
                    revealed=self._revealed_tools,
                    scope=str(self.workspace or ""),
                )
            except Exception:
                pass  # 裁剪失败就照全量发 —— 贵一点，但绝不能让回合挂掉
        return self.tools.to_openai_tools(exclude=exclude)

    def _absorb_revealed(self, result) -> bool:
        """把 `tool_search` 命中的工具收进本轮视图。

        名字要拿全量注册表再核一遍：`revealed_tools` 走的是 `Result.meta`，
        而 meta 最终来自工具实现，核对之后视图里就不可能出现一个注册表里没有
        的名字。这不是安全边界（派发那侧本来就会拒），而是不让一个幽灵名字
        在目录里挂着、让模型反复去调一个不存在的东西。

        Returns:
            True 表示视图变宽了，调用方需要重建 tool_specs。
        """
        names = (getattr(result, "meta", None) or {}).get("revealed_tools")
        if not names:
            return False
        fresh = {n for n in names if isinstance(n, str) and self.tools.get(n)}
        if fresh <= self._revealed_tools:
            return False
        self._revealed_tools |= fresh
        return True


    def _may_hand_off(self) -> bool:
        """True if this sub-agent is still allowed to delegate onward.

        A first-level sub-agent (spawned from the user's turn) is depth 1 and
        may hand off once; its target is depth 2 and is a leaf. So the gate is
        ``depth <= MAX_HANDOFF_DEPTH``, not ``<``.
        """
        from subagent_runtime import MAX_HANDOFF_DEPTH
        return bool(self.subagent_handoffs) and self.subagent_depth <= MAX_HANDOFF_DEPTH

    @staticmethod
    def _outcome_ok(outcome) -> bool:
        """Did this tool call succeed? Read from the trace row, not the content.

        Four shapes reach here, which is why this is a function rather than an
        inline check: a normal row (`status` is "ok"/"error"), an `ask_user` row
        ("answered"/"needs_input" — both mean the mechanism worked), and the
        gather-exception row, which has no `status` at all and only an `error`
        key. Anything unrecognised counts as NOT ok: an observability signal that
        over-reports success is worse than one that over-reports failure.
        """
        if isinstance(outcome, BaseException) or not isinstance(outcome, dict):
            return False
        row = outcome.get("trace")
        if not isinstance(row, dict):
            return False
        if row.get("error"):
            return False
        return row.get("status") in ("ok", "answered", "needs_input")

    def _is_parallel_safe(self, call: dict) -> bool:

        """True if this tool call can safely run concurrently with others.

        Conditions:
        1. The tool name is in PARALLEL_SAFE_TOOLS (strictly read-only).
        2. The risk controller has NOT marked it as needing approval — even a
           low-risk tool could have been escalated by a RemoteSessionRiskDecorator
           or dynamic denylist.
        """
        name = call.get("name") or ""
        if name not in PARALLEL_SAFE_TOOLS:
            return False
        # Double-check: the risk controller may have escalated it.
        risk = self.risk.classify_risk(name, call.get("arguments"))
        return risk == RiskLevel.LOW

    async def _run_tool_call(self, call: dict, context: dict) -> dict:
        """Execute one model-requested tool call under full guardrails.

        Args:
            call: Normalized ``{id, name, arguments}``.
            context: Per-turn context.

        Returns:
            ``{"content": str, "trace": dict, "halt": bool}`` — ``content`` is
            what gets fed back to the model as the tool result.
        """
        name = call.get("name") or ""
        args = call.get("arguments") or {}
        call_id = call.get("id") or f"{name}-{uuid.uuid4().hex[:8]}"

        if "__parse_error__" in args:
            msg = (
                f"Arguments for `{name}` were not valid JSON. "
                "Re-issue the call with well-formed JSON arguments."
            )
            return {"content": msg, "trace": {"tool": name, "status": "bad_args"}, "halt": False}

        context["risk_level"] = self.risk.classify_risk(name, args).value

        # Sub-agent capability boundary. The tool was already hidden from the
        # catalogue in `_tool_specs_for`, but a model can still hallucinate a
        # name it never saw — this is the enforcement, not the hint.
        if self.allowed_tools is not None and name not in self.allowed_tools:
            msg = (
                f"Tool `{name}` is not available to this sub-agent. "
                f"Allowed: {', '.join(sorted(self.allowed_tools)) or '(none)'}."
            )
            return {
                "content": msg,
                "trace": {"tool": name, "status": "subagent_blocked"},
                "halt": False,
            }
        if self.is_subagent and name == "task":
            if not self._may_hand_off():
                return {
                    "content": (
                        "Sub-agents cannot spawn further sub-agents. Finish the "
                        "task yourself and report back."
                    ),
                    "trace": {"tool": name, "status": "subagent_blocked"},
                    "halt": False,
                }
            # Hand-off is allowed, but only to the personas this one declares.
            # Checked here and not only in the schema because the enum is global
            # — the model can name any registered persona and we must not let a
            # read-only planner conjure a write-capable coder.
            requested = {
                str((spec or {}).get("subagent_type") or "")
                for spec in (args.get("tasks") or [])
            }
            illegal = sorted(requested - self.subagent_handoffs)
            if illegal:
                allowed = ", ".join(sorted(self.subagent_handoffs))
                return {
                    "content": (
                        f"Hand-off to {illegal} is not permitted for this "
                        f"sub-agent. Allowed hand-offs: {allowed}."
                    ),
                    "trace": {"tool": name, "status": "handoff_blocked"},
                    "halt": False,
                }

        # P3-2: 子代理五轴域规则判定 (filesystem, network, commandRules, mcpRules, onRestrict)
        if self.is_subagent or context.get("is_subagent"):
            d_rules = getattr(self, "domain_rules", {}) or context.get("domain_rules", {})
            if d_rules:
                try:
                    from subagent_registry import evaluate_domain_rules
                    allowed, action, failure_kind, reason = evaluate_domain_rules(d_rules, name, args)
                    if not allowed:
                        if action == "block":
                            try:
                                from evolution_bridge import notify_tool_failure
                                notify_tool_failure(
                                    self.session_id,
                                    f"turn_{self._turn_seq}",
                                    name,
                                    reason,
                                    failure_kind=failure_kind,
                                )
                            except Exception:
                                pass
                            msg = f"子代理域规则拦截 (action=block): {reason}"
                            await self._emit_tool_result(
                                name, call_id, args, context,
                                ok=False, value=None, error=msg, status="denied"
                            )
                            return {
                                "content": msg,
                                "trace": {"tool": name, "status": "domain_rule_blocked", "failure_kind": failure_kind},
                                "halt": False,
                            }
                        elif action == "fallback":
                            msg = f"子代理域规则受限提示 (action=fallback): {reason}。请切换其他备选工具或向用户说明限制。"
                            await self._emit_tool_result(
                                name, call_id, args, context,
                                ok=False, value=None, error=msg, status="restricted_fallback"
                            )
                            return {
                                "content": msg,
                                "trace": {"tool": name, "status": "domain_rule_fallback", "failure_kind": failure_kind},
                                "halt": False,
                            }
                except Exception:
                    pass

        # ── Loop / no-progress gate ──────────────────────────────────────────
        #
        # Placed here deliberately: before `pre_tool_use`, so a call we are going
        # to refuse never gets as far as asking the user to approve it. A stuck
        # model that has already failed this exact call four times should not be
        # generating permission prompts.
        #
        # A `critical` verdict blocks the ACTION, not the turn — the explanation
        # comes back as the tool result, so the model still has its remaining steps
        # to change approach or report the failure honestly. That is the whole
        # point: stopping the turn outright would leave the user with silence,
        # while letting it run leaves them with eight identical failures.
        _loop_verdict = self.loop_detector.check(
            name, args, tool_known=self.tools.get(name) is not None
        )
        if _loop_verdict.blocks:
            # Record the refusal too. Without it the no-progress streak freezes at
            # whatever tripped `critical`, the global breaker can never be reached,
            # and a model that keeps hammering the same call after being told to stop
            # gets the same gentle message forever instead of escalating.
            self.loop_detector.record_blocked(name, args)
            try:
                from evolution_bridge import notify_loop_fault
                notify_loop_fault(self.session_id, f"turn_{self._turn_seq}", name, _loop_verdict.message)
            except Exception:
                pass
            return {
                "content": _loop_verdict.message,
                "trace": {
                    "tool": name,
                    "status": "loop_blocked",
                    "detector": _loop_verdict.detector,
                    "count": _loop_verdict.count,
                },
                "halt": False,
            }

        # No permission pre-check here on purpose. The turn's permission rides on
        # `context["permission"]`, and risk_control's GLOBAL policy layer reads it
        # to decide allow/ask/deny. That layer is the hard guarantee behind
        # 计划模式/只读: a GLOBAL DENY short-circuits the pipeline walk, so neither
        # a granted permission nor the INHERITED layer can talk it back into
        # running. Keeping a second gate here is how the two systems drifted apart
        # in the first place.
        event = await self.bus.emit(
            "pre_tool_use",
            {"tool_name": name, "call_id": call_id, "args": args, "context": context, "session_id": self.session_id},
        )
        action = event.action.value
        if action == "ask":
            # An approval the user already gave clears this exact call. Blocks are
            # untouched — only an *ask* is answerable, so a read-only permission
            # can't be unlocked by a stale grant.
            if self.risk.has_grant(name, args, context):
                action = "continue"
        if action == "ask":
            # Give PermissionRequest hooks a chance to resolve the prompt without
            # bothering the user. A hook may return allow (proceed), deny (block)
            # or stay silent (fall through to asking the user).
            perm = await self.bus.emit("permission_request", {
                "tool_name": name,
                "call_id": call_id,
                "args": args,
                "risk_level": context.get("risk_level"),
                "reason": event.block_reason,
                "context": context,
            })
            decision = (perm.payload or {}).get("hook_decision", "")
            if decision == "allow":
                action = "continue"
            elif perm.action.value == "block" or decision == "deny":
                action = "block"
                event.block_reason = perm.block_reason or event.block_reason

        if action in ("block", "ask"):
            # The card is already on screen as "running" (pre_tool_use was
            # broadcast). Settle it explicitly, otherwise it spins forever.
            # Structured confirm semantics (U wave): the same guard verdict the
            # CUA registry would apply, recomputed from the same pure sources
            # (gui_action_classifier + ACTION_SPECS) — confirm_reason原文 /
            # scenario_tags / confirmation_class / allow_always / handoff.
            # Pure display payloads: enforcement paths above are untouched.
            from confirm_meta import build_confirm_meta
            confirm_meta = build_confirm_meta(
                name, args, block_reason=str(event.block_reason or ""),
                context=context,
            )
            if action == "ask" and confirm_meta.get("handoff") is True:
                # HANDOFF 档不是"待确认"而是"不该由代理做"：停成 denied，
                # 不落 pending——移交类没有可批准的选项，问了也是白问。
                status = "denied"
                msg = str(confirm_meta.get("confirm_reason")
                          or "这类动作需要用户亲手执行。")
            elif action == "block":
                status = "denied"
                msg = f"已被策略拦截：{event.block_reason}"
            else:
                status = "needs_confirmation"
                # block_reason already carries the natural Chinese confirmation
                # prompt from RiskController._build_confirmation_prompt.
                msg = event.block_reason or (
                    "接下来这一步会改动你的电脑状态。"
                    "回复「同意」我就继续；不想做的话直接告诉我换个做法。"
                )
                # Record the question. The policy pipeline already does this for
                # its own asks, but a gate-level ask never went through it — and
                # an unrecorded ask cannot be answered by the next turn.
                self.risk.record_pending(call_id, name, args, msg, self.session_id)
            await self._emit_tool_result(
                name, call_id, args, context,
                ok=False, value=None, error=msg, status=status,
                meta=({"needs_confirmation": True, **confirm_meta}
                      if status == "needs_confirmation" else confirm_meta),
            )
            return {"content": msg, "trace": {"tool": name, "status": status,
                                              "reason": event.block_reason},
                    "halt": True, "confirm_meta": confirm_meta}


        if not self.tools.get(name):
            msg = f"No such tool: `{name}`. Pick one from the provided tool list."
            await self._emit_tool_result(name, call_id, args, context,
                                         ok=False, value=None, error=msg, status="failed")
            return {"content": msg, "trace": {"tool": name, "status": "unknown"}, "halt": False}

        # B5: Pre-hooks run AFTER policy authorization, BEFORE dispatch.
        # May veto (destructive guard) or rewrite args (sanitization).
        hooks = get_tool_hooks()
        pre = hooks.run_pre(name, args, context)
        if pre["blocked"]:
            msg = pre["reason"]
            await self._emit_tool_result(name, call_id, args, context,
                                         ok=False, value=None, error=msg, status="denied")
            return {"content": msg, "trace": {"tool": name, "status": "hook_blocked",
                                              "hook_trail": pre["trail"]}, "halt": True}
        # A pre-hook may sanitize / normalize args before dispatch.
        args = pre["args"]

        # File-mutating tool → snapshot pre-image so a later rollback can undo it.
        # Best-effort: capture never blocks dispatch, and the store swallows its
        # own errors so a broken snapshot degrades to "no undo for this step".
        #
        # The report is KEPT. It used to be discarded, which is how the
        # "reversible" badge came to be a lie: it was a lookup on the tool name,
        # so a write over a file bigger than the snapshot cap — nothing stored,
        # nothing restorable — still rendered as reversible.
        snapshot_report = None
        try:
            from snapshot_store import mutating_paths_for, get_snapshot_store
            paths = mutating_paths_for(name, args)
        except Exception:
            paths = []
        if paths:
            # Resolving paths already proved this is a tracked mutating call, so
            # from here a failure means "we hold no pre-image", not "nothing to
            # undo" — the two must not collapse into the same None.
            try:
                # Use the newest user-turn seq as the checkpoint handle, matching
                # the chat-truncation contract on the frontend.
                turn_seq = self._current_turn_seq()
                snapshot_report = dict(get_snapshot_store().capture(
                    self.session_id, turn_seq, name, call_id, paths,
                ) or {})
                snapshot_report["seq"] = turn_seq
            except Exception:
                snapshot_report = {"captured": [], "skipped": [], "failed": list(paths),
                                   "recoverable": False}



        try:
            self.risk.consume_grant(name, args, context)
        except Exception as _e:
            # 风险预算扣减失败若无声，等于预算管线被旁路（§3 不变量 8 邻域）
            print(f"[risk] consume_grant FAILED for {name}: {_e}")

        # ask_user auto-resolution: before we stop the turn to ask, check whether
        # the answer is already in the conversation. If a separate judgement call
        # says every question is settled by something the user already said (or a
        # fact already on the table), answer it ourselves and let the turn keep
        # going — no card, no interruption. Anything uncertain still asks. See the
        # three disciplines in ask_user.py. Best-effort: any failure falls through
        # to the normal ask.
        if name == "ask_user" and self.ask_auto_resolve:
            auto = await self._auto_resolve_ask(args)
            if auto is not None:
                await self._emit_tool_result(
                    name, call_id, args, context,
                    ok=True, value=auto["content"], error=None,
                    status="completed", meta={"ask_auto_resolved": True},
                )
                return {"content": auto["content"],
                        "trace": {"tool": name, "status": "auto_resolved"},
                        "halt": False}

        # Per-call context. `context` is shared by every call in the turn, so
        # writing call_id onto it would race: a parallel read batch runs through
        # asyncio.gather, and two calls stamping the same dict would attribute
        # one command's output to the other's card. Only the dispatch needs it.
        call_ctx = dict(context)
        call_ctx["call_id"] = call_id
        is_full_mode = getattr(self, "permission", None) and getattr(self.permission, "value", str(self.permission)) in ("full", "autonomous")
        if action == "continue" or is_full_mode:
            call_ctx["confirmed"] = True
        if is_full_mode:
            call_ctx["sandbox_mode"] = "danger-full-access"

        # §7.4 执行模式选择——与关键词路径 `_execute` 同一道闸，放在策略门之后：
        # CRITICAL 工具的策略询问先走，批准授权本身就是 §7.4 要的人工确认，
        # 在询问之前拒绝会让 R4 永远不可达。worktree_available=False 如实传参：
        # LLM 分发路径同样没有副本机制，不假装隔离。
        try:
            plan = select_execution(
                risk_to_rlevel(str(context.get("risk_level") or "")),
                worktree_available=False,
                high_risk_confirmed=bool(call_ctx.get("confirmed"))
                                    or self.risk.has_grant(name, args, context),
            )
        except Exception as _e:
            # 模式选择崩溃绝不默认放行——fail-closed 并把原因作为工具结果回给模型
            print(f"[execution] select_execution FAILED, refusing {name}: {_e}")
            msg = "[execution] 执行模式选择失败，已按最坏情况拒绝执行。"
            await self._emit_tool_result(name, call_id, args, context,
                                         ok=False, value=None, error=msg,
                                         status="denied")
            return {"content": msg, "trace": {"tool": name,
                                              "status": "execution_refused"},
                    "halt": True}
        call_ctx["execution_mode"] = plan.mode
        call_ctx["os_confinement"] = plan.os_confinement
        if plan.mode == MODE_REFUSED:
            # 策略放行但 §7.4 不放行：未经显式人工确认的 R4 无论权限模式如何都拒绝
            msg = f"[execution] {plan.reason}"
            await self._emit_tool_result(name, call_id, args, context,
                                         ok=False, value=None, error=msg,
                                         status="denied")
            return {"content": msg, "trace": {"tool": name,
                                              "status": "execution_refused"},
                    "halt": False}
        if plan.mode == MODE_DANGER_FULL:
            print(f"[execution] DANGER-FULL-ACCESS granted for {name} "
                  f"(call={call_id}, session={self.session_id})")

        # Phase 2·R2: cross-process replay interception.
        #
        # The args hash is computed here rather than next to the ledger write
        # because the same value answers two questions: "what should the ledger
        # row say" and "has this exact call already landed". Hashing the args as
        # they will actually be used — pre-hooks have already run — is what makes
        # two identical effective calls hash the same.
        _ledger = context.get("risk_level") in ("medium", "high", "critical")
        _args_hash = ""
        if _ledger:
            try:
                import hashlib as _hl
                _args_hash = _hl.sha256(json.dumps(
                    args, sort_keys=True, ensure_ascii=False, default=str
                ).encode("utf-8")).hexdigest()
            except Exception:
                import logging as _lg
                _lg.getLogger(__name__).exception("side-effect args hash failed")
        # Typed effect (Phase 2). `args_hash` can only say "same words"; this
        # says "this change, to this thing, expected to end in this state" — the
        # only form in which a resumed run can check the WORLD instead of the
        # transcript. Unmodelled tools return None and keep the advisory ledger.
        _effect: dict = {}
        _op_id = ""
        _pre_hash = ""
        _planned_hash = ""
        if _ledger:
            try:
                import effects as _fx
                _effect = _fx.classify(
                    name, args, str(getattr(self, "workspace", "") or "")) or {}
                if _effect:
                    _pre_hash = _fx.snapshot_hash(name, args, _effect)
                    _planned_hash = _fx.planned_state_hash(name, args)
                    _op_id = _fx.operation_id(
                        str(context.get("goal_id") or self.session_id),
                        _effect["kind"], _effect["target"],
                        _fx.intent_hash(name, args))
            except Exception:
                import logging as _lg
                _lg.getLogger(__name__).exception("typed effect classify failed")
                _effect, _op_id = {}, ""
        # Typed replay / conflict guard — the point of Phase 2.
        #
        # It only looks at attempts from a process that is no longer alive, and
        # it decides by comparing the TARGET's current state against that
        # attempt's before/expected states, not by comparing argument text:
        #
        #   landed      the file already is what this call would make it →
        #               running it would be the second time. Skip, with evidence.
        #   conflict    the file changed into something else → someone (the user,
        #               another tool, a half-finished write) is in the way. Skip
        #               and say so; a full-content write would clobber it.
        #   not_started the file is byte-identical to before → safe, run it.
        #   unknown     no proof either way → run it, and let the resume prompt's
        #               "verify before redoing" list carry the doubt (blocking
        #               every unprovable case would wall the agent).
        #
        # Either skip restamps the old row to this generation, so the guard fires
        # once per operation: a deliberate repeat gets through on the next call.
        if _op_id and _effect:
            _prev = None
            try:
                _prev = self.storage.find_effect_by_operation(_op_id)
            except Exception:
                import logging as _lg
                _lg.getLogger(__name__).exception("typed effect lookup failed")
            if _prev:
                import effects as _fx
                _rec = _fx.reconcile(
                    _effect["kind"], _effect["target"],
                    str(_prev.get("pre_hash") or "") or _pre_hash,
                    str(_prev.get("planned_hash") or "") or _planned_hash,
                )
                if _rec["status"] in ("landed", "conflict"):
                    try:
                        self.storage.mark_effect_reconciled(
                            str(_prev.get("call_id") or ""),
                            "completed" if _rec["status"] == "landed" else "conflict",
                            _fx.snapshot_hash(name, args, _effect),
                            operation_id=_op_id)
                    except Exception:
                        import logging as _lg
                        _lg.getLogger(__name__).exception("effect reconcile write failed")
                    _short = os.path.basename(_effect["target"]) or _effect["target"]
                    _is_git = _effect["kind"] in getattr(_fx, "GIT_KINDS", ())
                    if _is_git and _rec["status"] == "landed":
                        # The repo itself is the evidence: HEAD moved to our
                        # commit, the branch is the one we asked for, the remote
                        # ref contains our sha. Doing it again means a second
                        # commit or a second push.
                        msg = (
                            f"这一步跳过了：仓库 `{_short}` 里这次 {name} **已经生效了**"
                            f"（上一个进程的 call {str(_prev.get('call_id', ''))[:8]}，"
                            f"现场核对：{_rec.get('detail')}）。再执行一遍会多出一次"
                            f"提交/推送。\n"
                            f"如果你确认还要再做一次，请再发一次同样的调用，这次会真的执行。"
                        )
                    elif _is_git:
                        msg = (
                            f"这一步拦下了：仓库 `{_short}` 的状态既不是上次动手前的样子，"
                            f"也不是这次 {name} 要达成的样子——中间有别人动过"
                            f"（上次尝试 call {str(_prev.get('call_id', ''))[:8]}，"
                            f"现场核对：{_rec.get('detail')}）。\n"
                            f"请先看一遍 git log / git status，确认当前在哪个提交上，"
                            f"再决定要不要继续。"
                        )
                    elif _rec["status"] == "landed":

                        msg = (
                            f"这一步跳过了：`{_short}` 现在的内容已经**正好是**这次 "
                            f"{name} 想写成的样子——上一个进程里这次写入已经落地了"
                            f"（call {str(_prev.get('call_id', ''))[:8]}，状态 "
                            f"{_prev.get('status')}）。再执行一遍就是写第二次。\n"
                            f"如果你确认还需要写，请再发一次同样的调用，这次会真的执行。"
                        )
                    else:
                        msg = (
                            f"这一步拦下了：`{_short}` 既不是上次动手前的样子，也不是"
                            f"这次 {name} 想写成的样子——它在这中间被别人改过"
                            f"（上次尝试 call {str(_prev.get('call_id', ''))[:8]}，"
                            f"状态 {_prev.get('status')}）。直接写会覆盖掉那个改动。\n"
                            f"请先读一遍这个文件，确认要保留什么，再决定怎么写。"
                        )
                    unregister_output_sink(call_id)
                    await self._emit_tool_result(name, call_id, args, context,
                                                 ok=False, value=None, error=msg,
                                                 status="skipped")
                    return {"content": msg,
                            "trace": {"tool": name, "call_id": call_id,
                                      "status": f"effect_{_rec['status']}",
                                      "target": _effect["target"]},
                            "halt": False}
        # Only CRITICAL is intercepted, and only across a process boundary. A
        # resumed goal re-issuing a force-push that already succeeded before the
        # crash is the case this exists for; anything below critical stays
        # advisory (the resume prompt lists it) because blocking a legitimate
        # repeat is worse than doing an idempotent write twice.
        if _args_hash and context.get("risk_level") == "critical":
            _landed = None
            try:
                _landed = self.storage.find_landed_side_effect(
                    str(context.get("goal_id") or ""), name, _args_hash)
            except Exception:
                import logging as _lg
                _lg.getLogger(__name__).exception("replay lookup failed")
            if _landed:
                msg = (
                    f"这次调用被拦下了：同一目标下、参数完全相同的 {name} "
                    f"在上一个进程里已经成功执行过（call "
                    f"{str(_landed.get('call_id', ''))[:8]}），没有重新执行。\n"
                    f"上次结果：{str(_landed.get('result_preview', '') or '（无预览）')}\n"
                    f"如果确实需要再做一次，请改变参数或先确认当前状态，不要原样重试。"
                )
                unregister_output_sink(call_id)  # 尚未注册也安全，保持清理对称
                await self._emit_tool_result(name, call_id, args, context,
                                            ok=False, value=None, error=msg,
                                            status="skipped")
                return {"content": msg,
                        "trace": {"tool": name, "call_id": call_id,
                                  "status": "already_landed"},
                        "halt": False}


        # Live output plumbing. The tool impl is a SYNC function running in a
        # worker thread (see ToolRegistry.dispatch), so it cannot touch the event
        # loop; it hands lines to this sink, which marshals them across.
        loop = asyncio.get_running_loop()
        pending: list[str] = []
        last_flush = [time.time()]
        buf_lock = threading.Lock()

        def _flush_output() -> None:
            with buf_lock:
                if not pending:
                    return
                chunk = "".join(pending)
                pending.clear()
                last_flush[0] = time.time()
            try:
                asyncio.run_coroutine_threadsafe(
                    self.bus.emit("tool_output", {
                        "tool_name": name, "call_id": call_id, "chunk": chunk,
                        "session_id": self.session_id,
                    }),
                    loop,
                )
            except Exception:
                pass  # loop closing mid-command — losing a chunk beats crashing

        def _sink(line: str) -> None:
            with buf_lock:
                pending.append(line)
                size = sum(len(p) for p in pending)
                due = (time.time() - last_flush[0]) > 0.08
            if size >= 2048 or due:
                _flush_output()

        register_output_sink(call_id, _sink)
        # From here until the `finally` below, this call is killable by
        # `cancel_hard()` — Pause needs a handle on the child command, not just
        # on the coroutine awaiting it.
        self._live_calls[call_id] = name
        # Analytics: track tool calls for the context window popover.
        try:
            from token_analytics import get_token_analytics
            get_token_analytics().on_tool_call(name)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        t0_dispatch = time.time()
        try:
            from agent_logger import log_tool_dispatch, log_tool_result
            log_tool_dispatch(
                tool_name=name,
                args=args,
                call_id=call_id,
                permission=getattr(self.permission, "value", str(self.permission)),
                confirmed=bool(call_ctx.get("confirmed")),
                sandbox_mode=str(call_ctx.get("sandbox_mode", "")),
            )
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        # Register the attempt now, with the args as they will actually be used —
        # pre-hooks may have rewritten them above, and hashing the pre-rewrite
        # version would make two identical effective calls look different.
        _loop_slot = self.loop_detector.record(name, args)
        # Phase 2: side-effect ledger. Write-class calls (risk >= medium) are
        # recorded as PENDING before dispatch and settled after, so a goal
        # resumed after a crash can be told what already landed instead of
        # redoing it. Pure mirror — a ledger failure must never block the tool.
        # `_ledger` / `_args_hash` were decided above, next to the replay guard
        # that reads the same hash.
        if _ledger and _args_hash:
            try:
                self.storage.record_side_effect(
                    self.session_id, str(context.get("goal_id") or ""),
                    call_id, name, _args_hash,
                    effect_kind=str(_effect.get("kind") or ""),
                    target=str(_effect.get("target") or ""),
                    operation_id=_op_id, pre_hash=_pre_hash,
                    planned_hash=_planned_hash,
                )
            except Exception:
                import logging as _lg
                _lg.getLogger(__name__).exception("side-effect ledger record failed")
        try:
            result = await self.tools.dispatch(name, args, call_ctx)
        except asyncio.CancelledError:
            # B5: OnAbort — the call was stopped mid-flight. Record a terminal
            # state (otherwise the tool_use has no matching tool_result and the
            # transcript is invalid) plus whatever recovery notes hooks provide.
            if _ledger:
                try:
                    # NOT ok=False: the call was already dispatched, so its
                    # effect may well have landed. `failed` would tell a
                    # resumed run "safe to redo" — for a write-class tool that
                    # is how you get the same write twice. `unknown` is the
                    # honest state and forces a check before redoing.
                    self.storage.settle_side_effect(
                        call_id, ok=False, result_preview="aborted mid-flight",
                        status="unknown")
                except Exception as _e:
                    # 中断结算失败会留下 pending——pending 本身是诚实状态，
                    # 但结算通道坏了必须让人知道
                    print(f"[side_effects] abort-settle FAILED for {call_id}: {_e}")
            aborted = hooks.run_abort(name, args, context)
            notes = "；".join(aborted["notes"])
            msg = "这一步被中断了。" + (f"{notes}" if notes else "工具可能只跑了一半，下一步前请先确认状态。")
            try:
                await asyncio.shield(self._emit_tool_result(name, call_id, args, context,
                                             ok=False, value=None, error=msg, status="failed"))
            except Exception:
                pass
            return {
                "content": msg,
                "trace": {
                    "tool": name,
                    "call_id": call_id,
                    "args": args,
                    "status": "failed",
                    "error": msg,
                    "interrupted": True,
                },
                "halt": False,
            }
        finally:
            # Push whatever is still buffered, THEN stop listening. Reversing
            # these two loses the tail of the output, which is usually the part
            # that says why the command failed.
            _flush_output()
            unregister_output_sink(call_id)
            self._live_calls.pop(call_id, None)
        if _ledger:
            try:
                # A killed or timed-out subprocess reports effect_status=
                # "unknown" through its Result meta: the child is dead, so
                # "failed" would read as safe-to-redo for a write that may
                # well have landed. Same honesty rule as the abort branch.
                _meta = getattr(result, "meta", None) or {}
                _forced = ("unknown"
                           if (not getattr(result, "ok", True)
                               and str(_meta.get("effect_status") or "") == "unknown")
                           else "")
                # Observe the target now. This is what makes the ledger evidence
                # rather than testimony: a later reconcile compares the world
                # against this hash instead of believing "the tool said ok".
                _post_hash = ""
                if _effect:
                    try:
                        import effects as _fx
                        _post_hash = _fx.snapshot_hash(name, args, _effect)
                    except Exception:
                        import logging as _lg
                        _lg.getLogger(__name__).exception(
                            "postcondition observe failed")
                self.storage.settle_side_effect(
                    call_id, ok=bool(getattr(result, "ok", True)),
                    result_preview=str(getattr(result, "value", "") or getattr(result, "error", "")),
                    status=_forced, post_hash=_post_hash,
                )
            except Exception:
                import logging as _lg
                _lg.getLogger(__name__).exception("side-effect ledger settle failed")

        try:
            from agent_logger import log_tool_result
            log_tool_result(
                tool_name=name,
                call_id=call_id,
                ok=bool(getattr(result, "ok", True)),
                status="completed" if getattr(result, "ok", True) else "failed",
                duration_ms=(time.time() - t0_dispatch) * 1000,
                result_preview=str(getattr(result, "value", "")) or "",
                error=str(getattr(result, "error", "")) if not getattr(result, "ok", True) else None,
            )
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        # Mutation Invalidation: ensure file/git mutations immediately invalidate snapshot cache
        if getattr(result, "ok", True):
            if name in MUTATING_WORKSPACE_TOOLS or any(k in name for k in ("write", "edit", "patch", "command", "shell", "git", "delete", "move", "rename")):
                try:
                    EnvironmentSnapshot.invalidate(self.workspace)
                except Exception:
                    pass

        # B5: Post-hooks run on the result text BEFORE it enters the context, so
        # a leaked credential never makes it into the transcript (and therefore
        # never gets replayed to the provider on later turns).
        content = self._tool_output_for_llm(result)
        post = hooks.run_post(name, content, context)
        content = post["content"]

        # Close the loop on this attempt. The result hash is what separates "the
        # model keeps retrying and nothing changes" from "the model is polling
        # something that is legitimately still moving" — without it, a detector can
        # only see repetition, not the absence of progress.
        self.loop_detector.observe(_loop_slot, content)
        if not getattr(result, "ok", True):
            try:
                from evolution_bridge import notify_tool_failure
                notify_tool_failure(
                    self.session_id,
                    f"turn_{self._turn_seq}",
                    name,
                    str(getattr(result, "error", "") or content),
                )
            except Exception:
                pass
        if _loop_verdict.level == "warning":
            # Warning rides along with the real result rather than replacing it: the
            # call was allowed and its output is still what the model asked for. The
            # nudge is appended so the model reads both — the answer, and the fact
            # that it has now asked the same thing several times.
            content = f"{content}\n\n[loop-detector] {_loop_verdict.message}"

        # 六·UC1：`tool_search` 命中的工具进入本轮视图。放在这里而不是工具内部，
        # 是因为视图是 router 的状态 —— 工具只负责回答「有什么」，要不要让它可见
        # 由 router 决定，而且名字会拿全量注册表再核一遍。
        if self._absorb_revealed(result):
            self._catalogue_dirty = True


        # A halts_turn tool (ask_user) parks a question. Big-company shape (a `waiting`
        # status, a still-open tool call): the answer comes back as THIS
        # call's tool result, in the SAME turn, not as a new user message. So we
        # emit the card, then suspend the turn on a waiter for the answer.
        #
        # Only on success: a failed ask_user (bad args) feeds the error straight
        # back so the model fixes the call this same turn.
        tool_def = self.tools.get(name)
        if tool_def and tool_def.halts_turn and result.ok:
            await self._emit_tool_result(
                name, call_id, args, context,
                ok=True, value=result.value, error=None,
                status="needs_input", meta=result.meta,
            )
            answer = await self._await_ask_answer(call_id)
            if answer is not None:
                # Answered in place → settle the card and hand the answer back as
                # this call's result. Turn CONTINUES; the model reads it and goes on.
                await self._emit_tool_result(
                    name, call_id, args, context,
                    ok=True, value=answer, error=None,
                    status="completed", meta={"ask_answered": True},
                )
                return {"content": answer,
                        "trace": {"tool": name, "call_id": call_id, "status": "answered"},
                        "halt": False}
            # No in-place answer (connection dropped, or the wait timed out). Fall
            # back to ending the turn: the ledger entry + card survive, and the
            # answer will arrive as a fresh turn via the persistent path.
            return {"content": content,
                    "trace": {"tool": name, "call_id": call_id, "status": "needs_input"},
                    "halt": True}

        # Authoritative reversibility, decided now that we know what the snapshot
        # actually stored — not from the tool-name table the pre-call badge used.
        # Rides in `meta` because that is the existing channel for per-call facts
        # (exit_code, ask_*), so the card gets corrected on the same frame that
        # settles it.
        settle_meta = dict(result.meta or {})
        # 执行决定随结算帧下发——UI/审计看"这次是怎么被放行的"不必重新推导，
        # 与关键词路径 `_execute` 的 result.meta 同形状。（plan 必已定义：
        # 未定义的路径都在上面提前返回了。）
        settle_meta["execution_mode"] = plan.mode
        settle_meta["os_confinement"] = plan.os_confinement
        try:
            from snapshot_store import reversible_after_capture
            settle_meta["reversible"] = reversible_after_capture(name, snapshot_report)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        if snapshot_report is not None:
            settle_meta["snapshot"] = {
                "seq": snapshot_report.get("seq"),
                "captured": len(snapshot_report.get("captured") or []),
                "skipped": snapshot_report.get("skipped") or [],
                "failed": snapshot_report.get("failed") or [],
            }

        # ToolOutputSpill: 拦截超长工具输出（>16,000 字符），安全转储至磁盘并生成有界预览
        try:
            from tool_output_spill import get_spill_manager
            spill_res = get_spill_manager().process_output(
                content, tool_name=name, session_id=self.session_id, workspace=self.effective_workspace
            )
            if spill_res.is_spilled:
                content = spill_res.content
                settle_meta["spill"] = {
                    "spill_id": spill_res.spill_id,
                    "spill_path": spill_res.spill_path,
                    "total_chars": spill_res.total_chars,
                    "total_lines": spill_res.total_lines,
                }
        except Exception:
            pass

        # RepeatToolGuard: 记录本次工具调用指纹
        if hasattr(self, "repeat_tool_guard") and self.repeat_tool_guard:
            try:
                self.repeat_tool_guard.record_call(
                    name, args, outcome_ok=bool(result.ok), outcome_content=content
                )
            except Exception:
                pass

        # Shadow workspace: validate staged overlay after file mutations.
        _FILE_MUTATORS = frozenset({
            "write_file", "edit_file", "apply_patch", "delete_file", "move_file", "copy_file",
        })
        if result.ok and name in _FILE_MUTATORS and context.get("shadow_staged"):
            try:
                from shadow_workspace import validate_and_emit
                await validate_and_emit(self.bus, self.session_id, self.workspace, context)
            except Exception:
                pass

        await self._emit_tool_result(
            name, call_id, args, context,
            ok=result.ok, value=result.value, error=result.error,
            status=("completed" if result.ok else "failed"),
            meta=settle_meta,
        )

        trace_row = {
            "tool": name,
            "call_id": call_id,
            "args": args,
            "status": "ok" if result.ok else "error",
            "preview": content[:200],
            "timestamp": t0_dispatch,
            "completedAt": time.time(),
        }
        if post["redactions"]:
            # Surface redaction in the audit trail so the user can see that the
            # output was touched and why.
            trace_row["redactions"] = post["redactions"]
            trace_row["hook_trail"] = post["trail"]

        if result.ok:
            try:
                from workflow_recorder import get_workflow_recorder
                _w_rec = get_workflow_recorder()
                if _w_rec.is_recording() and name not in (
                    "workflow_record_start", "workflow_record_stop", "workflow_replay", "workflow_list"
                ):
                    _meta = getattr(result, "meta", {}) if isinstance(getattr(result, "meta", {}), dict) else {}
                    _w_rec.record_step(
                        tool_name=name,
                        params=args,
                        pre_state_hash=_meta.get("ocr_hash"),
                        expected_target=_meta.get("target"),
                    )
            except Exception:
                pass

        return {"content": content, "trace": trace_row, "halt": False}

    async def _await_ask_answer(self, call_id: str) -> Optional[str]:
        """Suspend the turn until the user answers this ``ask_user`` card.

        Returns the rendered answer text (to become the tool result), or None to
        fall back to ending the turn — which happens on a real stop (cancelled),
        a dropped connection, or the long safety timeout. The card and the ledger
        entry outlive this either way, so a fallback loses nothing but the
        in-place continuation.

        The waiter is registered BEFORE we start awaiting and the card is already
        on screen, so a fast click can't slip through the gap: if the answer beats
        the await it just resolves the future immediately.
        """
        fut = register_waiter(call_id)
        try:
            payload = await asyncio.wait_for(
                asyncio.shield(fut), timeout=ASK_WAIT_TIMEOUT_S
            )
        except asyncio.CancelledError:
            # Real stop / socket teardown. Let it propagate so the turn actually
            # stops, but don't leave a dangling waiter behind.
            drop_waiter(call_id)
            raise
        except (asyncio.TimeoutError, RuntimeError):
            # 超时，或 future 已被别处消解。两种都退回持久路径。
            drop_waiter(call_id)
            return None
        # Render through the store so an in-place answer reads identically to one
        # that came via the persistent path, and the ledger entry is consumed.
        try:
            text = get_ask_user_store().resolve(
                self.session_id, call_id=call_id,
                answers=payload.get("answers"), skipped=bool(payload.get("skipped")),
            )
        except Exception:
            return None
        if text:
            # The ledger changed, so re-publish it: another open client still has
            # this card on screen with live buttons.
            try:
                await self.bus.emit("pending_questions", {
                    "session_id": self.session_id,
                    "items": get_ask_user_store().snapshot(self.session_id),
                })
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        return text

    async def _auto_resolve_ask(self, args: dict) -> Optional[dict]:
        """Try to answer an ``ask_user`` call from what the conversation already says.

        Returns the tool-result text to hand back to the model, or None to let the
        question reach the user.

        The judgement is a SEPARATE model call with its own system prompt rather
        than a line in the main prompt, and that separation is the point: the
        agent that just decided to ask is the worst judge of whether it needed to.
        A fresh call with no stake in the answer, one job, and a schema it has to
        satisfy is what makes "no" the cheap outcome.

        Fails open toward asking: no model, an error, unparseable output, or a
        single unsupported question all end up as None.
        """
        if not (self.llm and self.llm.api_key):
            return None
        questions, err = normalize_questions(args.get("questions"))
        if err or not questions:
            return None  # let the tool report the validation error properly

        header = str(args.get("header") or "").strip()
        try:
            messages = self._build_history(limit=12)
            messages.append({
                "role": "user",
                "content": build_auto_resolve_user_prompt(header, questions),
            })
            # Cheapest model that clears the bar (UD1), not the conversation
            # model: this is a schema-constrained lookup in history the user can
            # see and override on the card, not part of the reasoning the model
            # was picked for. Degrades to `self.llm` when routing finds nothing.
            from model_registry import SCENE_AUTO_RESOLVE
            r = await self.llm.bind_scene(SCENE_AUTO_RESOLVE).chat(
                messages, system=AUTO_RESOLVE_SYSTEM,
            )
        except Exception:
            return None
        if not r.ok:
            return None
        verdict = parse_auto_resolution(r.value.get("content") or "", questions)
        if verdict is None:
            return None

        # Reuse the same renderer the click path uses, so the model reads an
        # identical shape whether the human answered or we did.
        pending = PendingQuestion(call_id="", session_id=self.session_id,
                                  header=header, questions=questions)
        answer = render_answer(pending, verdict["answers"])
        return {"content": (
            f"{answer}\n\n"
            "[系统] 以上答案是根据当前对话已经确定的信息自动判定的，没有打断用户。"
            f"判定依据：\n{verdict['reason']}\n"
            "按这个答案继续做。如果你认为依据不成立，就说出来，不要重复提问。"
        )}

    async def _emit_tool_result(
        self, name: str, call_id: str, args: dict, context: dict,
        *, ok: bool, value: Any, error: Any, status: str,
        meta: Optional[dict] = None,
    ) -> None:
        """Emit ``tool_result`` for every terminal outcome of a tool call.

        Denials and unknown tools go through here too so subscribers (memory
        extraction, the WebSocket bridge) see a settled state for every card
        they were told about via ``pre_tool_use``.

        ``meta`` carries whatever the tool attached to its ``Result`` — for
        shell that is ``exit_code`` / ``timed_out``. The terminal card needs the
        real exit code: scraping it out of the text only works when the message
        happens to spell it out, and "退出码 0" vs "退出码 1" is the difference
        between a green and a red card.
        """
        await self.bus.emit("tool_result", {
            "tool_name": name,
            "call_id": call_id,
            "args": args,
            "status": status,
            "result": {"ok": ok, "value": value, "error": error},
            "meta": meta or {},
            "context": context,
            "session_id": self.session_id,
        })


    def _recognize_intent(self, message: str) -> dict:
        """Step 1: Recognize intent and identify primary tool."""
        cleaned_msg = (message or "").strip()
        if "[系统]" in cleaned_msg:
            cleaned_msg = cleaned_msg.split("[系统]")[0].strip()
        msg_lower = cleaned_msg.lower()
        if not msg_lower:
            return {"agent": None, "primary_tool": None, "args": {}}

        # Explicit confirmation / conversational approval words should NOT route to arbitrary commands
        if msg_lower in ("同意", "approve", "yes", "y", "允许", "确认", "确定", "好", "好的", "ok", "继续", "收到", "不用了", "拒绝", "deny", "no", "n"):
            return {"agent": None, "primary_tool": None, "args": {}}

        # Keyword-based intent recognition
        if any(w in msg_lower for w in ["搜索","search","查找","find","grep"]):
            if any(w in msg_lower for w in ["代码","code","文件","file"]):
                return {"agent": "file_agent", "primary_tool": "search_code", "args": {"pattern": cleaned_msg}}
        # 浏览器与网址优先识别（防止 "打开百度" / "打开网址" 被通配的 "打开" 截胡到 read_text）
        is_web_nav = any(w in msg_lower for w in ["http://", "https://", "www.", ".com", ".cn", ".org", ".net"]) or \
                     any(w in msg_lower for w in ["浏览器", "browser", "网页", "网站", "web", "site", "百度", "谷歌", "google", "bing"])
        if is_web_nav and any(w in msg_lower for w in ["打开", "open", "浏览", "访问", "查看", "进入", "跳转", "navigate"]):
            target = cleaned_msg.strip()
            for prefix in ["打开", "open", "浏览", "访问", "查看", "进入", "跳转", "navigate"]:
                if target.lower().startswith(prefix):
                    target = target[len(prefix):].strip()
                    break
            if not target.startswith("http://") and not target.startswith("https://"):
                if "百度" in target or target.lower() == "baidu":
                    target = "https://www.baidu.com"
                elif "bing" in target.lower() or "必应" in target:
                    target = "https://www.bing.com"
                elif "google" in target.lower() or "谷歌" in target:
                    target = "https://www.google.com"
                elif "." in target and " " not in target:
                    target = f"https://{target}"
                elif target:
                    target = f"https://www.bing.com/search?q={target}"
                else:
                    target = "https://www.bing.com"
            return {"agent": "browser_agent", "primary_tool": "navigate", "args": {"url": target}}

        if any(w in msg_lower for w in ["读","read","打开","open","查看","view"]):
            return {"agent": "file_agent", "primary_tool": "read_text", "args": {"path": cleaned_msg}}
        if any(w in msg_lower for w in ["写","write","创建","create","保存","save"]):
            return {"agent": "file_agent", "primary_tool": "write_file", "args": {"content": cleaned_msg}}
        if any(w in msg_lower for w in ["git","提交","commit","push","pull"]):
            return {"agent": "file_agent", "primary_tool": "git_status", "args": {}}
        if any(w in msg_lower for w in ["系统","system","进程","process","服务","service"]):
            return {"agent": "computer_agent", "primary_tool": "shell_executor", "args": {"command": cleaned_msg}}
        if any(w in msg_lower for w in ["浏览器","browser","网页","web","网站","site"]):
            return {"agent": "browser_agent", "primary_tool": "navigate", "args": {"url": cleaned_msg}}
        if any(w in msg_lower for w in ["应用","app","安装","install","启动","launch"]):
            return {"agent": "app_agent", "primary_tool": "operate_app", "args": {"action": cleaned_msg}}
        if any(w in msg_lower for w in ["list","列出","目录","dir","folder"]):
            return {"agent": None, "primary_tool": "list_dir", "args": {"path": "."}}
        if any(w in msg_lower for w in ["ls","文件"]):
            return {"agent": None, "primary_tool": "list_dir", "args": {"path": "."}}
        return {"agent": None, "primary_tool": None, "args": {}}

    def _determine_dispatch(self, intent: dict, message: str, context: dict) -> dict:
        """Step 2: Determine dispatch target."""
        agent = intent.get("agent")
        primary_tool = intent.get("primary_tool")
        args = intent.get("args", {})

        # If no agent but primary_tool is set, do direct tool execution
        if primary_tool and not agent:
            return {"type": "direct", "agent": None, "primary_tool": primary_tool, "args": args}

        if agent and agent in AGENT_ROLES:
            # Check if a skill matches
            skill_matches = self.skills.find_by_trigger(message)
            return {"type": "agent", "agent": agent, "tools": AGENT_ROLES[agent]["tools"],
                    "primary_tool": primary_tool, "args": args,
                    "skill_matches": skill_matches}
        # Direct tool execution
        return {"type": "direct", "agent": None, "primary_tool": primary_tool, "args": args}

    async def _execute(self, dispatch: dict, context: dict) -> Result:
        """Step 3: Execute based on dispatch decision."""
        tool_name = dispatch.get("primary_tool")
        if not tool_name:
            return Result.success("No action determined. Please clarify your request.")

        # Sub-agent capability boundary on the keyword path too. The LLM
        # dispatch path enforces `allowed_tools` before anything runs; skipping
        # it here would make which tools a sub-agent may call depend on whether
        # an API key happens to be configured.
        if self.allowed_tools is not None and tool_name not in self.allowed_tools:
            return Result.failure(
                f"[team] tool '{tool_name}' not in role allowlist "
                f"({', '.join(sorted(self.allowed_tools)) or '(none)'})"
            )

        args = dispatch.get("args", {})
        # Phase 8: execution-mode selection (§7.4). Computed BEFORE the policy
        # gate so the chosen mode rides along in the audit payload, but the
        # refused verdict is enforced AFTER it: for CRITICAL tools the policy
        # layer asks first, and the resulting approval grant IS the explicit
        # human confirmation §7.4 requires — refusing before that ask would
        # make R4 unreachable instead of merely gated.
        #
        # worktree_available is False on purpose: the main-router dispatch path
        # has no worktree-copy mechanism (that lives in subagent_runtime), and
        # claiming isolation that never happens is how the "reversible" badge
        # became a lie once already. R2 therefore runs in-workspace with the
        # Git diff + validator + rollback backstop, as the plan reason says.
        try:
            plan = select_execution(
                risk_to_rlevel(str(context.get("risk_level") or "")),
                worktree_available=False,
                high_risk_confirmed=bool(context.get("confirmed"))
                                    or self.risk.has_grant(tool_name, args, context),
            )
        except Exception as _e:
            # 模式选择崩溃绝不能默认放行——fail-closed 并响亮打印（§3 纪律）。
            print(f"[execution] select_execution FAILED, refusing: {_e}")
            return Result.failure("[execution] 执行模式选择失败，已按最坏情况拒绝执行。")
        call_id = str(context.get("call_id") or f"{tool_name}-{int(time.time() * 1000)}")
        context["call_id"] = call_id
        # 执行模式决定必须落在 context 上：它是下游审计/回放引用这次
        # 放行或拒绝的唯一凭据。之前只在少数分支写（如 call_ctx），
        # 拒绝分支干脆没写——被拒的那次执行在记录里查不到原因。
        context["execution_mode"] = plan.mode
        # Emit pre_tool_use event (risk control checks here)
        event = await self.bus.emit("pre_tool_use", {
            "tool_name": tool_name, "args": args, "context": context,
            "call_id": call_id,
            "execution_mode": plan.mode, "execution_plan": plan.reason,
        })
        if event.action.value == "block":
            return Result.failure(f"Blocked: {event.block_reason}")
        if event.action.value == "ask":
            msg = event.block_reason or (
                "接下来这一步会改动你的电脑状态。"
                "回复「同意」我就继续；不想做的话直接告诉我换个做法。"
            )
            self.risk.record_pending(call_id, tool_name, args, msg, self.session_id)
            from confirm_meta import build_confirm_meta
            confirm_meta = build_confirm_meta(
                tool_name, args, block_reason=str(event.block_reason or ""),
                context=context,
            )
            await self._emit_tool_result(
                tool_name, call_id, args, context,
                ok=False, value=None, error=msg, status="needs_confirmation",
                meta={"needs_confirmation": True, **confirm_meta},
            )
            res = Result.success("")
            res.meta = {"needs_confirmation": True, "turn_outcome": "incomplete", **confirm_meta}
            return res
        if plan.mode == MODE_REFUSED:
            # Policy allowed it but §7.4 did not: R4 without explicit human
            # confirmation is refused no matter what the permission mode says.
            return Result.failure(f"[execution] {plan.reason}")
        if plan.mode == MODE_DANGER_FULL:
            # §7.4: the bypass mode must leave a loud audit mark on the record.
            print(f"[execution] DANGER-FULL-ACCESS granted for {tool_name} "
                  f"(session={self.session_id})")
        # Skill lifecycle (learning loop). find_by_trigger results used to be
        # computed in _determine_dispatch and then dropped on the floor: skills
        # were "discovered" every turn but never used, never measured. A match
        # that survives the risk gate is now a REAL use — its body rides along
        # with the reply, and the outcome lands in the experience ledger (0003).
        _skill_used = None
        _skill_t0 = time.time()
        try:
            _matches = dispatch.get("skill_matches") or []
            if _matches:
                _entry = self.skills.get_skill(str(_matches[0].get("name") or ""))
                if _entry is not None:
                    _skill_used = {
                        "name": _entry.name,
                        "version": getattr(_entry, "version", "") or "",
                        "score": int(_matches[0].get("match_score") or 0),
                        "body": "",
                    }
                    try:
                        _loaded = self.skills.load_skill_body(_entry.name)
                        if getattr(_loaded, "ok", False):
                            _val = getattr(_loaded, "value", None)
                            # load_skill_body 的真实契约是 {body, frontmatter, path}
                            # 字典——取正文本身，别把整个字典 repr 进回复。
                            _skill_used["body"] = (
                                str(_val.get("body") or "")
                                if isinstance(_val, dict) else str(_val or "")
                            )
                    except Exception:
                        pass  # fail-open: 可选增强，失败不影响主流程
                    self._trace_skill("skill.started", _skill_used, context,
                                      selection=f"trigger_match(score={_skill_used['score']})")
        except Exception as _e:
            print(f"[skills] lifecycle setup failed: {_e}")

        # Check if tool exists in registry
        tool = self.tools.get(tool_name)
        if tool:
            result = await self.tools.dispatch(tool_name, args, context)
        else:
            # Tool not in registry - would dispatch to sub-agent
            result = Result.success(f"[{dispatch.get('agent')}] Would execute: {tool_name} with {args}")

        # The execution decision travels with the result so UI/audit can show
        # "how was this allowed to run" without re-deriving it.
        if isinstance(result.meta, dict):
            result.meta["execution_mode"] = plan.mode
            result.meta["os_confinement"] = plan.os_confinement

        if getattr(result, "ok", True):
            if tool_name in MUTATING_WORKSPACE_TOOLS or any(k in tool_name for k in ("write", "edit", "patch", "command", "shell", "git", "delete", "move", "rename")):
                try:
                    EnvironmentSnapshot.invalidate(self.workspace)
                except Exception:
                    pass

        if _skill_used is not None:
            _ok = bool(getattr(result, "ok", False))
            try:
                self._trace_skill(
                    "skill.completed" if _ok else "skill.failed", _skill_used, context,
                )
                _exp_id = self.storage.record_skill_experience(
                    _skill_used["name"],
                    skill_version=_skill_used["version"],
                    goal_id=str(context.get("goal_id") or ""),
                    run_id=str(context.get("run_id") or ""),
                    session_id=self.session_id,
                    selection_reason=f"trigger_match(score={_skill_used['score']})",
                    preconditions_met=bool(tool),
                    steps_attempted=1, steps_succeeded=1 if _ok else 0,
                    outcome=("success" if _ok else "failure"),
                    failure_class="" if _ok else str(getattr(result, "error", "") or "unknown")[:200],
                    latency_ms=(time.time() - _skill_t0) * 1000,
                )
                if isinstance(result.meta, dict):
                    result.meta["skill_experience_id"] = _exp_id
                # run USES skill：有 run 归因时把使用关系落到关系图（Step D 补全）。
                _run_ref = str(context.get("run_id") or "")
                if _run_ref:
                    try:
                        self.storage.add_relation(
                            "run", _run_ref, "USES", "skill", _skill_used["name"],
                            evidence=f"exp:{_exp_id}",
                        )
                    except Exception as _e:
                        print(f"[skills] USES edge failed: {_e}")
            except Exception as _e:
                print(f"[skills] record experience failed: {_e}")
            _guide = (_skill_used["body"] or "").strip()
            if _ok and _guide:
                # This IS the use of the skill: its guidance travels with
                # the reply instead of dying inside the discovery list.
                result.value = (
                    f"{result.value}\n\n[Skill guidance — {_skill_used['name']}"
                    f" v {str(_skill_used['version'])[:8]}]\n{_guide[:2000]}"
                    + ("\n…[truncated]" if len(_guide) > 2000 else "")
                )
        # Reflexion (NeurIPS 2023): 如果工具执行失败，自动提炼反思并存入情景记忆
        if not getattr(result, "ok", True):
            try:
                from reflection_engine import get_reflection_generator, get_reflection_store
                _ref_gen = get_reflection_generator()
                _ref = await _ref_gen.generate_from_tool_failure(
                    tool_name=tool_name,
                    arguments=args,
                    error_message=str(getattr(result, "error", "") or ""),
                    session_id=self.session_id,
                )
                get_reflection_store().save_reflection(_ref)
            except Exception:
                pass

        # P0 fix (audit §10): emit tool_result AFTER execution.
        # This is the trigger source for memory_layer's debounced extraction.
        await self.bus.emit("tool_result", {
            "tool_name": tool_name,
            "args": args,
            "result": {"ok": result.ok, "value": result.value, "error": result.error},
            "context": context,
            "session_id": self.session_id,
        })
        return result

    def _trace_skill(self, event_type: str, skill: dict, context: dict,
                     selection: str = None) -> None:
        """Skill lifecycle event into the canonical ledger via TraceGateway.

        Observational importance: the mirror must never break the user's
        action; a lost mirror logs loudly and moves on."""
        payload = {"skill_id": skill["name"], "skill_version": skill.get("version", "")}
        if selection:
            payload["selection_reason"] = selection
        try:
            self.storage.trace_event(
                session_id=self.session_id,
                event_type=event_type,
                payload=payload,
                importance="observational",
                goal_id=str(context.get("goal_id") or "") or None,
            )
        except Exception as _e:
            print(f"[skills] trace {event_type} failed: {_e}")

    async def _llm_turn(
        self, user_message: str, dispatch: dict, tool_result: Result, context: dict
    ) -> Optional[str]:
        """Generate the natural-language reply for this turn.

        Keyword routing only fires on explicit tool phrasings ("git status",
        "read README.md"). Everything else — greetings, questions, explanations,
        follow-ups — needs the model. When a tool did run, its output is handed
        to the model so the reply can incorporate it instead of dumping raw text.

        Args:
            user_message: The user's message this turn.
            dispatch: Step-2 dispatch decision.
            tool_result: Result from Step 3 (may be a failure).
            context: Per-turn context (carries injected memory, risk level).

        Returns:
            The reply string, or None when the LLM is unavailable/misconfigured
            so the caller can keep the raw tool result.
        """
        if not getattr(self, "llm", None) or not self.llm.api_key:
            return None

        system_prompt = self.get_system_prompt(context) + self._skill_guidance_block(context)
        self._sync_turn_cache_prefix(system_prompt)
        try:
            self._last_turn_system_prompt_tokens = self.compactor.estimate_tokens(system_prompt)
        except Exception:
            self._last_turn_system_prompt_tokens = 0
        messages = self._build_history(limit=20)

        tool_ctx = ""
        if dispatch.get("primary_tool") and tool_result is not None:
            snippet = self._tool_output_for_llm(tool_result)
            tool_ctx = (
                f"\n\n[Tool `{dispatch.get('primary_tool')}` output]\n{snippet}\n"
                "(Use this in your reply; summarize rather than repeating it verbatim.)"
            )
        messages.append({"role": "user", "content": user_message + tool_ctx})

        r = await self.llm.chat(messages, system=system_prompt)
        if not r.ok:
            return None
        text = (r.value.get("content") or "").strip()
        if not text and r.value.get("finish_reason") == "length":
            # Reasoning models can burn the whole budget thinking. Retry once
            # with a larger ceiling before giving up.
            r = await self.llm.chat(
                messages, system=system_prompt,
                max_tokens=min(self.llm.max_tokens * 4, 16000),
            )
            if r.ok:
                text = (r.value.get("content") or "").strip()
        return text or None


    def _tool_output_for_llm(tool_result: Result, cap: int = 3500) -> str:
        """Render a tool result compactly for inclusion in the prompt.

        Uses intelligent Head-Tail preservation with explicit line count metadata:
        preserves initial headers as well as terminal failures/exit codes while keeping
        prompt context compact and fast for KV caching.
        """
        if not tool_result.ok:
            return f"[error] {tool_result.error}"
        value = tool_result.value
        if value is None:
            return "(empty output)"
        if isinstance(value, str):
            text = value
        else:
            try:
                text = json.dumps(value, indent=2, ensure_ascii=False, default=str)
            except Exception:
                text = str(value)

        if len(text) <= cap:
            return text

        head_len = int(cap * 0.6)
        tail_len = int(cap * 0.35)
        omitted = len(text) - (head_len + tail_len)
        total_lines = len(text.splitlines())
        return (
            f"{text[:head_len]}\n\n"
            f"--- ✂️ [Output truncated: {omitted} chars / {total_lines} total lines; showing head & tail] ---\n\n"
            f"{text[-tail_len:]}"
        )

    def _audit(self, result: Result, dispatch: dict, context: dict) -> dict:
        """Step 4: Acceptance & artifact audit."""
        audit_payload = {
            "timestamp": time.time(),
            "agent": dispatch.get("agent"),
            "tool": dispatch.get("primary_tool"),
            "success": result.ok,
            "session_id": context.get("session_id"),
        }
        # Phase 59 内化: 触发 5D 任务收口与文档对齐审计 (PostTurnReconciliationEngine)
        try:
            from reconciliation import PostTurnReconciliationEngine
            ws = context.get("workspace") or os.getcwd()
            reconcile_summary = PostTurnReconciliationEngine.run_reconciliation(ws)
            audit_payload["reconciliation"] = reconcile_summary.to_dict()
        except Exception:
            pass
        return audit_payload

    # ------------------------------------------------------------------
    # Image persistence (generated by multi-modal models)
    # ------------------------------------------------------------------

    def _harvest_images(self, reply: dict, context: dict) -> None:
        """Collect raw image items from a single LLM reply into the turn accumulator.

        Called after every step in the agent loop. Images are NOT persisted yet —
        that happens once at the end of the turn in ``_persist_turn_images``. This
        avoids writing half-finished images from a turn that gets cancelled.
        """
        images = reply.get("images")
        if not images:
            return
        acc: list[dict] = context.setdefault("_raw_images", [])
        acc.extend(images)

    async def _persist_turn_images(self, context: dict) -> list[dict]:
        """Write accumulated images to disk, return lightweight refs for the WS payload.

        Each image is saved via ``image_store.save_ref`` which handles both base64
        and URL variants. Failed saves are silently dropped — a missing image is
        better than a stuck turn.
        """
        raw = context.pop("_raw_images", None)
        if not raw:
            return []
        refs: list[dict] = []
        for item in raw:
            ref = await _save_image_ref(item, self.workspace, name_hint=item.get("name", ""))
            if ref:
                refs.append(ref)
        return refs

    def _present(self, result: Result, dispatch: dict, context: dict) -> str:
        """Step 5: Result presentation. Head-Tail truncation throughout."""
        if not result.ok:
            # No English prefix. Whatever produced the failure has already phrased
            # it for a person; `Operation failed: ` in front of a Chinese sentence
            # just reads as a leaked internal label.
            return str(result.error or "这次请求没有完成")
        value = result.value
        if isinstance(value, str):
            return truncate(value, 10000)
        if isinstance(value, dict):
            return truncate(
                json.dumps(value, indent=2, ensure_ascii=False, default=str), 10000
            )
        return truncate(str(value), 10000)

