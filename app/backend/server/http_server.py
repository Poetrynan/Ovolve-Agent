"""
http_server.py - HTTP/WebSocket server for frontend communication.

Provides:
  - WebSocket /ws for real-time AgentEvent push
  - SSE /api/stream for streaming LLM responses + tool events
  - REST /api/health, /api/goals, /api/crons, /api/bot/*, /api/skills
  - REST /api/settings for runtime config updates
  - GET /api/files for whitelisted local media preview
  - REST /api/browser/tabs + /api/browser/claim（U3 认领闭环的 HTTP 桥面）
  - Static file serving for app/ui/dist (when built)

GET /api/files 端点
"""
from __future__ import annotations
import json, asyncio, os, re, time, urllib.parse
from uuid import uuid4
from aiohttp import web, WSMsgType
from typing import Any, Optional
from result import Result

from router import Router
from session_host import SessionHost, PENDING_RUN_GRACE
import api_auth
from risk_control import init_risk_controller
from executors import cancel_call

#: ``app[...]`` 的键。aiohttp 推荐用 AppKey 而不是裸字符串：AppKey 带类型
#: 信息，且两个不同用途的键撞名时会立刻报错，而不是悄悄互相覆盖。
#: 此前这里是裸字符串键，aiohttp 每次用到就刷一条 NotAppKeyWarning——
#: 测试套件里那 14 条警告 100% 出自这里。
#:
#: ⚠️ AppKey 与同名字符串在 dict 里是**两个不同的键**。所以下面 30 处读写
#: 必须一次性改全：只改写、不改读（或反之），运行时就是 KeyError，
#: 而且没被测试覆盖到的 handler 不会当场暴露。
ROUTER_KEY = web.AppKey("router", Router)
SESSION_HOST_KEY = web.AppKey("session_host", SessionHost)


class WebSocketHandler:
    """Handle WebSocket connections from frontend.

    Live event bridge: subscribes to the internal event_bus so every tool_call /
    tool_result / agent_state / goal_state_change is pushed to connected clients
    as it happens. This is what makes the chat feel "alive" during a multi-step
    agent loop — the user sees each tool fire, not just the final answer 20s later.
    """

    def __init__(self, host: "SessionHost"):
        #: Process-wide registry of live sessions. One Router per session; a
        #: window attaches to one of them. This handler is a single broadcaster
        #: shared by every socket, so "which session" can NEVER be handler
        #: state — it is tracked per socket below.
        self.host = host
        self.clients: set = set()
        #: socket -> session_id. A window announces its session on connect and
        #: whenever it switches; every session-sensitive operation resolves the
        #: Router through this map instead of a handler-wide field.
        self._session_by_ws: dict = {}
        #: socket -> branch_id. Maintains strict branch isolation across WebSocket windows.
        self._branch_by_ws: dict = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        #: The in-flight turn PER SOCKET. Previously one field for the whole
        #: handler, which meant window B's prompt was refused while window A was
        #: working, and B's `interrupt` cancelled A's turn.
        self._turn_tasks: dict = {}
        #: The in-flight turn PER SESSION ID for unambiguous cross-window & switch tracking.
        self._turn_tasks_by_sid: dict[str, asyncio.Task] = {}
        #: Pending-error timers, keyed by (session_id, msg_id). A timer fires
        #: the parked failure after the grace window unless a retry cancels it.
        self._pending_error_timers: dict[tuple[str, str], asyncio.Task] = {}
        #: Live hard-cancel watchdogs. Held so the event loop keeps a strong
        #: reference — a bare `create_task` can be garbage collected mid-wait,
        #: and a collected watchdog silently stops enforcing Stop.
        self._stop_watchdogs: set = set()
        self._bridge_bus_events()

    # ------------------------------------------------------------------
    # Session resolution
    # ------------------------------------------------------------------

    @property
    def router(self) -> Router:
        """The primary session's Router.

        Kept for session-agnostic reads (storage access, workspace listing,
        settings) and for the HTTP routes that have no socket in scope. Anything
        that runs or mutates a CONVERSATION must use `_router_for(ws)` instead —
        using this property there would silently execute window B's prompt in
        window A's session.
        """
        return self.host.get_primary()

    def _router_for(self, ws) -> Router:
        """Resolve the Router belonging to this socket's session."""
        sid = self._session_by_ws.get(id(ws))
        if sid:
            return self.host.get_or_create(sid)
        return self.host.get_primary()

    def _bind_session(self, ws, session_id: str, branch_id: str = "") -> None:
        """Remember which session and branch a socket is attached to."""
        if session_id:
            self._session_by_ws[id(ws)] = session_id
            if branch_id is not None:
                self._branch_by_ws[id(ws)] = str(branch_id).strip()

    def _turn_running(self, ws=None) -> bool:
        """Is a turn in flight? Scoped to the asker's SESSION when the socket is
        known, else any.

        Keyed by session, not socket: two windows on one session share one turn
        lifecycle (the Router and its cancel token are per-session), so a second
        window's prompt must queue and its session_switch/fork must be refused
        while the first window's turn runs. Keying by socket alone let both
        happen, and the concurrent turns then raced on the Router's shared
        per-turn state (permission, _turn_seq, cancel token).
        """
        if ws is not None:
            sid = self._session_by_ws.get(id(ws))
            if sid:
                for w, s in self._session_by_ws.items():
                    if s != sid:
                        continue
                    t = self._turn_tasks.get(w)
                    if t is not None and not t.done():
                        return True
                return False
            # Socket hasn't announced a session yet — fall back to its own task.
            task = self._turn_tasks.get(id(ws))
            return task is not None and not task.done()
        return any(t is not None and not t.done() for t in self._turn_tasks.values())

    #: How long a stopped turn gets to unwind on its own before its task is killed.
    #: The cooperative flag is checked between steps and before each tool call, so a
    #: turn that is merely between operations lands well inside this window and gets
    #: to persist its interrupt note — which is what makes `resume_turn` possible.
    STOP_GRACE_S: float = 3.0

    def _live_turn_tasks_for(self, ws=None, sid: str = "") -> list:
        """Every in-flight turn task belonging to the session.

        Same scoping rule as `_turn_running`: two windows on one session share one
        turn lifecycle, so Stop in either window must reach it.
        """
        target_sid = sid or (self._session_by_ws.get(id(ws)) if ws is not None else "")
        tasks = []
        if target_sid:
            t_sid = self._turn_tasks_by_sid.get(target_sid)
            if t_sid is not None and not t_sid.done():
                tasks.append(t_sid)
            for w, s in self._session_by_ws.items():
                if s == target_sid:
                    t = self._turn_tasks.get(w)
                    if t is not None and not t.done() and t not in tasks:
                        tasks.append(t)
        elif ws is not None:
            t = self._turn_tasks.get(id(ws))
            if t is not None and not t.done():
                tasks.append(t)
        return tasks

    async def _hard_cancel_after_grace(self, tasks: list, router=None) -> None:
        """Kill turn tasks that did not honour the cooperative stop.

        `Router.cancel()` only sets an `asyncio.Event`; the loop reads it between
        steps and before each tool call. That covers the common case, but it cannot
        reach a turn already parked inside one long operation — a shell command, a
        provider read. Nothing here used to cancel the task itself, so after the UI
        went idle that work kept running to completion, unwatched, still spending.

        Graceful first, forceful second: wait out the grace window, then kill the
        commands that are still in flight and cancel whatever is still alive.
        `_run_and_drain`'s `finally` clears the registry entry either way.

        Cancelling the task alone was not enough: tools are dispatched into worker
        threads, so unwinding the coroutine orphans the child command — the build
        kept building after Stop. `Router.cancel_hard` kills it, which is also what
        lets the parked await return at all.
        """
        if not tasks:
            return
        try:
            await asyncio.wait(tasks, timeout=self.STOP_GRACE_S)
        except Exception:  # noqa: BLE001 - waiting must never raise into the handler
            pass
        if any(not t.done() for t in tasks):
            hard = getattr(router, "cancel_hard", None)
            if callable(hard):
                try:
                    hard()
                except Exception as exc:  # noqa: BLE001
                    print(f"[stop] hard cancel failed: {exc}")
        for t in tasks:
            if not t.done():
                t.cancel()

    def _spawn_stop_watchdog(self, ws, router=None) -> None:
        """Arm the hard cancel without blocking the interrupt handler.

        The UI has to hear `idle` immediately; making it wait out the grace window
        would turn Stop into a three-second freeze.
        """
        tasks = self._live_turn_tasks_for(ws)
        if not tasks:
            return
        watchdog = asyncio.create_task(
            self._hard_cancel_after_grace(tasks, router=router))
        self._stop_watchdogs.add(watchdog)
        watchdog.add_done_callback(self._stop_watchdogs.discard)


    def _bridge_bus_events(self) -> None:
        """Wire event_bus -> WebSocket broadcast.

        Handlers are ``async`` so ``EventBus.emit`` awaits them naturally.
        Broadcast failures never propagate: a dead client must not stop the
        agent loop.
        """
        bus = self.router.bus
        bus.on("pre_tool_use", self._on_pre_tool_use, priority=-100)
        bus.on("tool_result", self._on_tool_result, priority=-100)
        bus.on("tool_output", self._on_tool_output, priority=-100)
        bus.on("goal_state_change", self._on_goal_state_change, priority=-100)
        bus.on("agent_state", self._on_agent_state, priority=-100)
        bus.on("agent_reasoning", self._on_agent_reasoning, priority=-100)
        bus.on("agent_delta", self._on_agent_delta, priority=-100)
        bus.on("tool_call_delta", self._on_tool_call_delta, priority=-100)
        bus.on("context_folded", self._on_context_folded, priority=-100)
        bus.on("context_precheck", self._on_context_precheck, priority=-100)
        bus.on("agent_reasoning_delta", self._on_reasoning_delta, priority=-100)
        bus.on("agent_image_generating", self._on_image_generating, priority=-100)
        bus.on("model_downgraded", self._on_model_downgraded, priority=-100)
        bus.on("context_refs_resolved", self._on_context_refs_resolved, priority=-100)
        bus.on("agent_phase", self._on_agent_phase, priority=-100)
        bus.on("pending_questions", self._on_pending_questions, priority=-100)
        bus.on("subagent_state", self._on_subagent_state, priority=-100)
        bus.on("usage", self._on_usage, priority=-100)
        bus.on("evolution_proposal", self._on_evolution_proposal, priority=-100)
        bus.on("evolution_insight", self._on_evolution_insight, priority=-100)
        bus.on("learning_item_event", self._on_learning_item_event, priority=-100)
        bus.on("moa_advisors", self._on_moa_advisors, priority=-100)
        bus.on("red_team_alert", self._on_red_team_alert, priority=-100)
        bus.on("shadow_validation", self._on_shadow_validation, priority=-100)
        bus.on("shadow_applied", self._on_shadow_applied, priority=-100)

    async def _on_learning_item_event(self, event) -> None:
        """Forward canonical learning item lifecycle events to UI with strict envelope scope."""
        payload = event.payload or {}
        sid = self._event_session(payload, event=event)
        bid = self._event_branch(payload, event=event)
        if not sid:
            logging.getLogger(__name__).info("Dropping unscoped learning_item_event: no session in envelope/payload")
            return
        await self._broadcast({
            "type": "learning_item_event",
            "timestamp": time.time(),
            "sessionId": sid,
            "branchId": bid,
            "payload": {**payload, "sessionId": sid, "branchId": bid},
        })

    async def _on_evolution_insight(self, event) -> None:
        """Forward one learning-loop moment to every window with strict envelope scope."""
        payload = event.payload or {}
        sid = self._event_session(payload, event=event)
        bid = self._event_branch(payload, event=event)
        if not sid:
            logging.getLogger(__name__).info("Dropping unscoped evolution_insight: no session in envelope/payload")
            return
        await self._broadcast({
            "type": "evolution_insight",
            "timestamp": time.time(),
            "sessionId": sid,
            "branchId": bid,
            "payload": {**payload, "sessionId": sid, "branchId": bid},
        })


    async def _on_usage(self, event) -> None:
        """Forward one turn's real token/cost figures to the owning window.

        The REST path (`/api/usage`) was already truthful, but it is a
        dashboard: during a turn the context meter had no source but a
        client-side estimate. This closes that gap with the numbers the router
        already priced, so `isEstimated` finally goes false.

        The payload goes through verbatim — the router shapes it in the exact
        form `applyUsage()` consumes, so there is no second place where the
        field names have to agree.
        """
        payload = event.payload or {}
        await self._broadcast({
            "type": "usage",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": payload,
        })

    async def _on_subagent_state(self, event) -> None:
        """Forward one sub-agent's lifecycle transition to the owning window.

        SubagentRuntime stamps ``session_id`` with the PARENT session, so this
        lands in the window that issued the ``task`` call rather than in a
        phantom child window (child sessions have no socket of their own).
        The payload is already camelCase from ``SubagentSession.to_public()``,
        so it goes through verbatim — the UI's progress panel is a direct
        projection of the runtime's state machine, with no re-derivation.
        """
        payload = event.payload or {}
        if not payload.get("subagentId"):
            return
        await self._broadcast({
            "type": "subagent_state",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": payload,
        })

    async def _on_agent_phase(self, event) -> None:
        """Forward a named turn phase to the owning window.

        Lets the UI show *where* a slow turn is (assembling context vs waiting
        on the model vs running a tool) instead of one undifferentiated
        "thinking" spinner, and makes the same information greppable in logs.
        Purely observational — never gates behaviour.
        """
        payload = event.payload or {}
        phase = payload.get("phase")
        if not phase:
            return
        # 2.1: fold the phase into the persisted substatus. Only substatus —
        # `note_phase` refuses to touch `status`, because phases fire many times
        # per turn and letting them write the status axis would silently overwrite
        # `waiting_user` the moment the next phase landed. "在等人" is precisely
        # the state that must not be clobbered by a progress ping.
        try:
            from turn_state import get_turn_state
            get_turn_state().note_phase(self._event_session(payload), phase)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        await self._broadcast({

            "type": "agent_phase",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "phase": phase,
                "step": payload.get("step"),
                "tool": payload.get("tool"),
                "tools": payload.get("tools"),
                "permission": payload.get("permission"),
                "ok": payload.get("ok"),
            },
        })


    async def _relay_subagent_activity(self, session_id: str, kind: str, data: dict) -> None:
        """Mirror one child-Router event onto the PARENT window as sub-agent activity.

        The problem this solves: a sub-agent IS a Router sharing the process-wide
        event bus, so it already emits ``pre_tool_use`` / ``tool_result`` /
        ``agent_delta`` — but stamped with its OWN child session id. ``_broadcast``
        then filters those frames out, because no socket is bound to a child
        session (children have no window). The result was that everything a
        sub-agent did was emitted and immediately dropped, and the UI could only
        show an opaque "running" row.

        Rather than invent a parallel emit path in ``subagent_runtime`` (which
        would put the same fact on the bus twice and let the two copies drift),
        we re-tag here: derive the parent from the child session id and send a
        SECOND frame under a distinct type, addressed to the parent. Distinct
        type matters — reusing ``tool_call`` would splice a sub-agent's tools into
        the parent's own activity feed, which is exactly the context pollution
        sub-agents exist to prevent.

        This is the same correlation trick frontier coding agents expose as
        ``parent_tool_use_id``: the child's stream is only useful to a UI that can
        tell WHICH child it belongs to.
        """
        child = _subagent_child_session(session_id)
        if child is None:
            return
        parent_sid, sub_id = child
        await self._broadcast({
            "type": "subagent_activity",
            "timestamp": time.time(),
            "sessionId": parent_sid,
            "payload": {"subagentId": sub_id, "kind": kind, **data},
        })

    def _event_session(self, payload: dict, event=None) -> str:
        """Which session does this bus event belong to? Priority to immutable event envelope."""
        if event is not None:
            esid = getattr(event, "session_id", None) or getattr(event, "sessionId", None)
            if esid:
                return str(esid)
        payload = payload or {}
        sid = payload.get("session_id") or payload.get("sessionId")
        if sid:
            return str(sid)
        ctx = payload.get("context") or {}
        sid = ctx.get("session_id") or ctx.get("sessionId")
        if sid:
            return str(sid)
        return ""

    def _event_branch(self, payload: dict, event=None) -> str:
        """Which branch does this bus event belong to? Priority to immutable event envelope."""
        if event is not None:
            eb = getattr(event, "branch_id", None) or getattr(event, "branchId", None)
            if eb:
                return str(eb)
        payload = payload or {}
        bid = payload.get("branch_id") or payload.get("branchId")
        if bid:
            return str(bid)
        ctx = payload.get("context") or {}
        bid = ctx.get("branch_id") or ctx.get("branchId")
        if bid:
            return str(bid)
        return ""

    async def _on_image_generating(self, event) -> None:
        """The stream went quiet on an image-capable model; announce likely
        image generation so the UI can swap the generic thinking indicator for
        an image-specific one. See router._image_hint_watchdog for the rationale."""
        payload = event.payload or {}
        await self._broadcast({
            "type": "image_generating",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {"step": payload.get("step", 0)},
        })

    async def _on_model_downgraded(self, event) -> None:
        """The active model failed and was swapped for a better-suited one (UD2).

        Surfaced so the user can see WHY a reply came from a different model than
        the one they picked — a silent swap reads as the app ignoring their
        choice. The reason maps to a recovery direction (quota / overflow / …).
        """
        payload = event.payload or {}
        await self._broadcast({
            "type": "model_downgraded",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "step": payload.get("step", 0),
                "reason": payload.get("reason", ""),
                "failure": payload.get("failure", ""),
                "fromModel": payload.get("fromModel", ""),
                "toModel": payload.get("toModel", ""),
                "toProvider": payload.get("toProvider", ""),
            },
        })

    async def _on_moa_advisors(self, event) -> None:
        """Forward MoA council phases to the UI for advisor cards."""
        payload = event.payload or {}
        await self._broadcast({
            "type": "moa_advisors",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "phase": payload.get("phase", "asking"),
                "advisors": payload.get("advisors", []),
                "opinions": payload.get("opinions", []),
                "elapsed_s": payload.get("elapsed_s"),
                "step": payload.get("step", 0),
            },
        })

    async def _on_red_team_alert(self, event) -> None:
        """Forward red team patrol findings to the UI."""
        payload = event.payload or {}
        await self._broadcast({
            "type": "red_team_alert",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "count": payload.get("count", 0),
                "sources": payload.get("sources", []),
                "findings": payload.get("findings", []),
            },
        })

    async def _on_shadow_validation(self, event) -> None:
        """Forward shadow workspace validation report to the UI."""
        payload = event.payload or {}
        await self._broadcast({
            "type": "shadow_validation",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": payload,
        })

    async def _on_shadow_applied(self, event) -> None:
        """Notify UI that staged overlay was merged into the real workspace."""
        payload = event.payload or {}
        await self._broadcast({
            "type": "shadow_applied",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": payload,
        })

    async def _on_context_refs_resolved(self, event) -> None:
        """The turn's @ attachments were read (UB2) — report what actually landed.

        The composer only knows what the user PICKED. Whether a file was found,
        how many tokens it cost, and whether the budget clipped it are all facts
        that only exist after resolution, and the chip is the natural place to
        show them. Without this the user's only clue that an attachment was
        dropped would be a reply that ignores it.
        """
        payload = event.payload or {}
        await self._broadcast({
            "type": "context_refs_resolved",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "total": payload.get("total", 0),
                "resolved": payload.get("resolved", 0),
                "failed": payload.get("failed", 0),
                "truncated": payload.get("truncated", 0),
                "tokens": payload.get("tokens", 0),
                "items": payload.get("items", []),
            },
        })

    async def _on_reasoning_delta(self, event) -> None:
        """Stream reasoning CoT pieces live so the UI can show thinking-in-progress."""
        payload = event.payload or {}
        text = payload.get("text") or ""
        if not text:
            return
        sid = self._event_session(payload)
        await self._broadcast({
            "type": "reasoning_delta",
            "timestamp": time.time(),
            "sessionId": sid,
            "payload": {"step": payload.get("step", 0), "text": text},
        })
        # Relayed for the same reason it's streamed on the main channel: a
        # sub-agent that thinks for 30s before its first tool call would
        # otherwise present an empty detail panel and read as frozen.
        await self._relay_subagent_activity(sid, "reasoning", {"text": text})


    async def _on_context_folded(self, event) -> None:
        """Push a `folded` event so the UI can render a fold marker in place."""
        payload = event.payload or {}
        await self._broadcast({
            "type": "folded",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "strategy": payload.get("strategy"),
                "tokensBefore": payload.get("tokensBefore"),
                "estimatedTokensAfter": payload.get("estimatedTokensAfter"),
                "compressionRatio": payload.get("compressionRatio"),
                "manual": payload.get("manual"),
                "summary": payload.get("summary"),
            },
        })

    async def _on_tool_call_delta(self, event) -> None:
        """Forward a tool call as the model writes it out.

        Content and reasoning have always streamed; a tool call did not. It
        accumulated silently in ``llm_client`` and appeared whole, at execution
        time — so a model spending several seconds composing a long `write_file`
        argument produced an identical UI to a stalled request, and the user's
        only reasonable read was "it hung".

        ``arguments`` is the raw accumulated STRING, not an object: partial JSON
        is invalid JSON, so there is nothing parseable until the final frame.
        The UI must treat it as text. ``index`` is the correlation key, because
        ``callId`` can still be empty on the first few frames — providers may
        send the id in a later chunk than the first argument fragment.
        """
        payload = event.payload or {}
        await self._broadcast({
            "type": "tool_call_delta",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "step": payload.get("step"),
                "index": payload.get("index", 0),
                "callId": payload.get("call_id") or "",
                "toolName": payload.get("name") or "",
                "argsText": payload.get("arguments") or "",
                "final": bool(payload.get("final")),
            },
        })

    async def _on_context_precheck(self, event) -> None:
        """Push the pre-send window fit check to the UI.

        This event was already being emitted by the router — and subscribed to by
        nobody, because it was never listed in :meth:`_bridge_bus_events`. So the
        one signal that says "your next request barely fits, and here is what we
        silently threw away to make it" died inside the process. Both halves
        matter to the user: ``pruned`` means old tool output got trimmed out from
        under the model, and ``fits: false`` means it is *still* over the line, so
        an error is coming and it is not their fault.
        """
        payload = event.payload or {}
        await self._broadcast({
            "type": "context_precheck",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "step": payload.get("step"),
                "pruned": payload.get("pruned", 0),
                "tokensBefore": payload.get("before"),
                "tokensAfter": payload.get("after"),
                "overheadTokens": payload.get("overhead"),
                "ceiling": payload.get("ceiling"),
                "fits": payload.get("fits", True),
                "reason": payload.get("reason"),
            },
        })

    async def _on_pre_tool_use(self, event) -> None:
        payload = event.payload or {}
        tool_name = payload.get("tool_name")
        ctx = payload.get("context") or {}
        args = payload.get("args") or {}
        sid = self._event_session(payload)
        await self._broadcast({
            "type": "tool_call",
            "timestamp": time.time(),
            "sessionId": sid,
            "payload": {
                "toolCallId": payload.get("call_id"),
                "toolName": tool_name,
                "args": args,
                "riskLevel": ctx.get("risk_level"),
                # Can we put this back if the user changes their mind? Writes we
                # snapshot are reversible; shell/push/commit are not. The card
                # badges the irreversible ones so "撤回" never over-promises.
                "reversible": _tool_reversible(tool_name),
                # Where the command actually runs. A terminal card that shows a
                # command without its directory is ambiguous — the same `rm -rf
                # build` means something different in two repos. `cwd` is what
                # the tool was handed; workspaceRoot is the session default it
                # falls back to.
                "cwd": args.get("cwd") or ctx.get("workspace_root"),
                "workspaceRoot": ctx.get("workspace_root"),
                "permission": ctx.get("permission"),
                # 命令内容分级结果（command_classifier 经策略层写入同一 ctx）。
                # 前端据此在确认卡片上展示"为什么需要确认"，而不是让用户盲批。
                "commandGuard": ctx.get("_command_verdict"),
                "status": "running",
            },
        })
        await self._relay_subagent_activity(sid, "tool_call", {
            "toolCallId": payload.get("call_id"),
            "toolName": tool_name,
            "status": "running",
        })

    async def _on_tool_output(self, event) -> None:
        """Stream one coalesced chunk of a still-running tool's stdout.

        Router batches lines (2KB / 80ms) before emitting, so this stays a thin
        forwarder — no extra buffering here. Newlines are preserved: the whole
        point is that the card renders a scrolling black window, which ``_short``
        would flatten into one unreadable line.
        """
        payload = event.payload or {}
        chunk = payload.get("chunk")
        if not chunk:
            return
        await self._broadcast({
            "type": "tool_output_delta",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "toolCallId": payload.get("call_id"),
                "toolName": payload.get("tool_name"),
                "chunk": chunk,
            },
        })

    async def _on_tool_result(self, event) -> None:
        payload = event.payload or {}
        result = payload.get("result") or {}
        meta = payload.get("meta") or {}
        sid = self._event_session(payload)
        preview = _short(result.get("value") if result.get("ok") else result.get("error"))
        frame_payload = {
            "toolCallId": payload.get("call_id"),
            "toolName": payload.get("tool_name"),
            "status": payload.get("status", "completed"),
            "ok": result.get("ok"),
            "preview": preview,
            # The real exit code, straight from the process — not scraped out
            # of the message text. `None` means "this tool has no exit code",
            # which is different from 0.
            "exitCode": meta.get("exit_code"),
            "timedOut": bool(meta.get("timed_out")),
            # `ask_user` ships the normalised questions here rather than
            # letting the card read them off the tool_call args. The args are
            # whatever the model wrote; these went through validation and
            # carry the position indexes the answer is keyed by, so both
            # sides count options the same way.
            "askHeader": meta.get("ask_header"),
            "askQuestions": meta.get("ask_questions"),
            # The agent answered its own question from the conversation
            # instead of interrupting. Surfaced because a silent self-answer
            # is the one real danger of that mechanism — the user has to be
            # able to see what was decided on their behalf.
            "askAutoResolved": bool(meta.get("ask_auto_resolved")),
            # Reversibility as it actually turned out. The tool_call frame
            # sent an optimistic guess from the tool-name table; this is the
            # verdict after the snapshot ran, so a write we could not store a
            # pre-image for flips the badge instead of promising an undo that
            # would come back empty. `None` = backend said nothing, keep the
            # card's current value.
            "reversible": meta.get("reversible"),
            "snapshot": meta.get("snapshot"),
        }
        # Structured confirm semantics (U wave): pass the guard verdict fields
        # through only when the stop carried them, so frames from stops that
        # predate the feature stay byte-identical for old consumers.
        if isinstance(meta, dict):
            for _src, _dst in (
                ("confirm_reason", "confirmReason"),
                ("scenario_tags", "scenarioTags"),
                ("confirmation_class", "confirmationClass"),
                ("allow_always", "allowAlways"),
                ("handoff", "handoff"),
            ):
                if meta.get(_src) is not None:
                    frame_payload[_dst] = meta.get(_src)
        await self._broadcast({
            "type": "tool_result",
            "timestamp": time.time(),
            "sessionId": sid,
            "payload": frame_payload,
        })
        await self._relay_subagent_activity(sid, "tool_result", {
            "toolCallId": payload.get("call_id"),
            "toolName": payload.get("tool_name"),
            "status": payload.get("status", "completed"),
            "ok": result.get("ok"),
            "preview": preview,
        })



    async def _on_pending_questions(self, event) -> None:
        """Push the authoritative list of still-unanswered `ask_user` questions.

        This frame is a full replacement, not a delta: the frontend settles any
        `needs_input` card missing from it and (re)builds the ones present. That
        is what makes a parked question survive a page reload or a session switch
        — both of which wipe `toolCalls` on the client — and what settles a card
        whose question the user answered by typing instead of clicking.
        """
        payload = event.payload or {}
        await self._broadcast({
            "type": "pending_questions",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {"items": payload.get("items") or []},
        })

    async def _on_goal_state_change(self, event) -> None:
        payload = event.payload or {}
        await self._broadcast({
            "type": "goal_state_change",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": payload,
        })

    async def _on_evolution_proposal(self, event) -> None:
        """新提案出炉了。只发计数，不发内容。

        提案是在对话过程中被动挖出来的，没有这一帧用户永远不知道有东西要审——
        一个需要主动轮询才能发现的审核队列等于不存在。内容不塞进负载：前端收到
        通知后自己拉一次 /api/evolution/proposals，这样列表的真相只有一个来源。
        """
        payload = event.payload or {}
        await self._broadcast({
            "type": "evolution_proposal",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": payload,
        })

    async def _on_agent_state(self, event) -> None:
        payload = event.payload or {}
        await self._broadcast({
            "type": "agent_state",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": payload,
        })

    async def _on_agent_reasoning(self, event) -> None:
        payload = event.payload or {}
        await self._broadcast({
            "type": "reasoning",
            "timestamp": time.time(),
            "sessionId": self._event_session(payload),
            "payload": {
                "step": payload.get("step"),
                "text": payload.get("text", ""),
                "final": payload.get("final", False),
            },
        })

    async def _on_agent_delta(self, event) -> None:
        """Token-level assistant text — grows the chat bubble while the model thinks."""
        payload = event.payload or {}
        text = payload.get("text") or ""
        if not text:
            return
        sid = self._event_session(payload)
        await self._broadcast({
            "type": "agent_delta",
            "timestamp": time.time(),
            "sessionId": sid,
            "payload": {
                "step": payload.get("step"),
                "text": text,
            },
        })
        await self._relay_subagent_activity(sid, "text", {"text": text})


    async def handle_websocket(self, request):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.clients.add(ws)
        self._loop = asyncio.get_running_loop()

        # New / reloaded client → immediately mirror the current queue so the
        # "pending N" panel rehydrates without a race.
        try:
            await ws.send_json(self._queue_state_event(ws))
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        # Restore the conversation this window was in. Connect used to hand the
        # client a session list whose `activeId` was the primary router's session
        # — but never that session's HISTORY — so after F5 the sidebar highlighted
        # a row while the chat pane sat on the empty-state hero. The highlight was
        # true about the server and a lie about the screen.
        #
        # `_switch_and_reply` is the whole restore in one call: it binds the socket
        # to the session, sends the transcript, and reports `turnRunning` so a turn
        # that is still going keeps its working indicator. Runs BEFORE the frames
        # below so `_router_for(ws)` resolves to the bound session rather than
        # falling back to primary.
        try:
            _boot_sid = self.host.get_primary().session_id
            if _boot_sid:
                await self._switch_and_reply(ws, _boot_sid)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        # Same reasoning for a parked `ask_user` question: the turn is already
        # stopped waiting on it, so if the card doesn't come back with the reload
        # the conversation is stuck with no way forward.
        try:
            await self._send_pending_questions(ws)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程


        # 2.1 回合状态：连上来就补发一帧。这条是「重启/刷新后回合本身丢失」的正面
        # 修复 —— 以前浏览器一刷新，`isWorking` 从 false 起步，而后端可能真的还在
        # 跑（另一个窗口开的），或者停在 waiting_user / paused 上。两边不一致的
        # 结果是用户对着一个能打字的输入框，发出去却被「a turn is already
        # running」顶回来。状态在库里，所以这一帧总能说出真话。
        try:
            from turn_state import get_turn_state
            sid = self._router_for(ws).session_id
            await self._deliver(ws, {
                "type": "turn_state",
                "timestamp": time.time(),
                "sessionId": sid,
                "payload": get_turn_state().snapshot(sid),
            })
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程




        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        await self._handle_message(ws, data)
                    except json.JSONDecodeError:
                        await self._send_error(ws, "Invalid JSON")
                elif msg.type == WSMsgType.ERROR:
                    print(f"WebSocket error: {ws.exception()}")
                    break
        finally:
            self.clients.discard(ws)
            # Drop this socket's per-window state so a future connection
            # doesn't inherit the previous window's session pin or a stale
            # completed turn task.
            self._session_by_ws.pop(id(ws), None)
            self._branch_by_ws.pop(id(ws), None)
            self._turn_tasks.pop(id(ws), None)
        return ws

    def _queue_state_event(self, ws=None) -> dict:
        """Serialize a UI queue snapshot as a broadcastable event.

        The queue is per-session, so the snapshot depends on which socket is
        asking. Passing `ws` gives that window's own pending list; omitting it
        falls back to the primary session (used only before a socket has
        announced which session it is on).
        """
        router = self._router_for(ws) if ws is not None else self.router
        snap = router.queue.ui_snapshot()
        return {
            "type": "queue_state",
            "timestamp": time.time(),
            "sessionId": router.session_id,
            "payload": snap,
        }

    async def _broadcast_queue_state(self) -> None:
        """Push each window its OWN queue snapshot.

        A single shared frame would show window A the pending prompts of
        window B, since the queues are per-session now.
        """
        for client in list(self.clients):
            await self._deliver(client, self._queue_state_event(client))

    # ── 回合状态（2.1）─────────────────────────────────────────────────────

    async def _broadcast_turn_state(self, sid: str) -> None:
        """Tell every window watching this session what state its turn is in.

        Broadcast rather than send-to-one because two windows can share a
        session: the old boolean lived in `_turn_tasks`, which is keyed by
        SOCKET identity, so window B genuinely could not see that window A had a
        turn running on the same conversation. The persisted row is per session,
        so the frame has to reach everyone looking at it.
        """
        try:
            from turn_state import TurnStatus, get_turn_state
            ts = get_turn_state()
            # Double check with real in-memory task:
            is_live = self._turn_running_sid(sid)
            if not is_live and ts.current(sid) is TurnStatus.RUNNING:
                ts.transition(sid, TurnStatus.IDLE, force=True)
            await self._broadcast({
                "type": "turn_state",
                "timestamp": time.time(),
                "sessionId": sid,
                "payload": ts.snapshot(sid),
            })
        except Exception:
            pass  # 状态播报失败不该影响回合本身


    async def _settle_turn_state(self, sid: str, terminal) -> None:
        """Land a finished turn on its real end state.

        The subtlety this exists for: a turn that parked an `ask_user` card
        RETURNS normally — `Result.success` carrying the question text — so the
        result alone cannot tell "answered the user" apart from "waiting on the
        user". Writing `completed` there would be the same lie the old boolean
        told, just persisted. So we ask the two authorities that actually know:
        the `ask_user` ledger and the risk controller's pending confirmations.
        Either one holding something for this session means the ball is in the
        user's court, and the state says so.
        """
        from turn_state import TurnStatus, get_turn_state
        waiting = False
        try:
            from ask_user import get_ask_user_store
            waiting = bool(get_ask_user_store().pending_for(sid))
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        if not waiting:
            try:
                router = self.host.get(sid)
                risk = getattr(router, "risk", None)
                if risk is not None:
                    waiting = bool(risk.pending_for(sid))
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        get_turn_state().transition(
            sid, TurnStatus.WAITING_USER if waiting else terminal,
        )
        await self._broadcast_turn_state(sid)


    # ------------------------------------------------------------------

    # Retry grace
    # ------------------------------------------------------------------

    #: Technical failure signatures → what to actually tell the user.
    #: A raw Python traceback string in a chat bubble is a support ticket the
    #: user cannot file: it says something broke but nothing about what THEY
    #: can do. Each entry maps a recognisable substring to (message, hint).
    #: The technical text still goes to the server log, where it belongs.
    _ERROR_COPY: tuple = (
        (("no attribute", "AttributeError", "TypeError", "NameError",
          "KeyError", "IndexError", "not callable"),
         "程序内部出了点问题，这一轮没能完成。",
         "这是 系统自身的缺陷，不是你的操作问题。可以重试一次；如果每次都这样，请把这条反馈给我们。"),
        (("api_key", "API key", "Unauthorized", "401", "invalid_api_key",
          "authentication"),
         "AI 模型拒绝了这次请求，看起来是密钥不对或已过期。",
         "去「设置 → 模型」检查 API Key 是否填对、是否还有效。"),
        (("quota", "insufficient", "billing", "429", "rate limit",
          "rate_limit", "too many requests"),
         "AI 模型这会儿忙不过来，或者账户额度用完了。",
         "稍等十几秒再发一次；如果一直这样，去模型服务商后台看看余额和限流。"),
        (("timeout", "timed out", "ConnectionError", "ClientConnector",
          "Connection reset", "getaddrinfo", "SSL", "network"),
         "网络没连上 AI 模型。",
         "检查一下网络或代理，然后重试。"),
        (("context_length", "context length", "maximum context",
          "too many tokens", "context_exceeded"),
         "这轮对话的内容超过了模型能一次读完的长度。",
         "可以手动折叠一下上下文，或者开个新对话继续。"),
        (("database is locked", "sqlite", "OperationalError"),
         "本地数据库正忙，这次写入没成功。",
         "稍等一下重试即可，数据没有丢。"),
        (("permission", "PermissionError", "Access is denied", "EACCES"),
         "系统拒绝了一次文件访问。",
         "看看这个文件是不是被其他程序占用，或者需要管理员权限。"),
        (("No such file", "FileNotFoundError", "cannot find the path"),
         "要找的文件不在了。",
         "确认一下路径有没有写错，或者文件是不是被移动/删除了。"),
    )

    @classmethod
    def _friendly_error(cls, exc: object) -> dict:
        """Translate a technical failure into something a user can act on.

        Returns ``{"message", "hint", "detail"}``. `detail` keeps the original
        text so the UI can offer a "查看技术详情" fold and logs stay complete —
        we're hiding jargon by default, not destroying it.
        """
        raw = str(exc) or exc.__class__.__name__
        probe = f"{exc.__class__.__name__}: {raw}" if isinstance(exc, BaseException) else raw
        low = probe.lower()
        for needles, message, hint in cls._ERROR_COPY:
            if any(n.lower() in low for n in needles):
                return {"message": message, "hint": hint, "detail": probe}
        return {
            "message": "这一轮没能完成。",
            "hint": "可以重试一次；如果反复失败，把这条反馈给我们会很有帮助。",
            "detail": probe,
        }

    def _cancel_pending_error(self, session_id: str, msg_id: str) -> bool:
        """Cancel a parked failure for (session, msg_id).

        Returns True when there really was one — the caller uses that as the
        signal that this inbound message is a RETRY rather than a duplicate.
        """
        if not msg_id:
            return False
        key = (session_id, msg_id)
        task = self._pending_error_timers.pop(key, None)
        token = self.host.pending_take_by_key(session_id, msg_id)
        if task is not None and not task.done():
            task.cancel()
        return task is not None or token is not None

    async def _schedule_error(
        self, ws, session_id: str, msg_id: str, error
    ) -> None:
        """Park a turn failure for the grace window instead of committing it.

        `error` is either a plain string or a dict from `_friendly_error`.
        """
        self._cancel_pending_error(session_id, msg_id)
        token = self.host.pending_arm(session_id, msg_id)
        # Normalize to dict for consistent downstream handling.
        if isinstance(error, str):
            err_dict = {"message": error, "hint": "", "detail": ""}
        else:
            err_dict = error
        await self._broadcast({
            "type": "turn_retry_window",
            "timestamp": time.time(),
            "sessionId": session_id,
            "payload": {
                "error": err_dict.get("message", ""),
                "hint": err_dict.get("hint", ""),
                "graceSeconds": PENDING_RUN_GRACE,
                "msgId": msg_id,
            },
        })

        async def _commit_later():
            try:
                await asyncio.sleep(PENDING_RUN_GRACE)
            except asyncio.CancelledError:
                return
            if not self.host.pending_commit(token):
                return
            self._pending_error_timers.pop((session_id, msg_id), None)
            router = self.host.get(session_id)
            await self._send_error(ws, err_dict)
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "payload": {
                    "result": "error",
                    "error": err_dict.get("message", ""),
                    "hint": err_dict.get("hint", ""),
                    "detail": err_dict.get("detail", ""),
                },
                "sessionId": session_id,
            })
            if router is not None and router.queue.ui_pending > 0:
                await router.queue.ui_pause("error")
                await self._broadcast_queue_state()

        self._pending_error_timers[(session_id, msg_id)] = asyncio.create_task(
            _commit_later()
        )

    async def _run_turn(
        self, ws, message: str, source: str = "user", context_extra: dict = None,
        msg_id: str = ""
    ) -> None:
        """Run one full user turn end-to-end and emit the usual events.

        Factored out so the queue drain loop can invoke it just like a live
        user_prompt without duplicating the event scaffolding.

        Args:
            context_extra: Extra per-turn context from the client (the composer's
                ``permission`` and ``model``). Queued turns pass None and inherit
                the router's last permission, which matches the user's expectation
                that a queued prompt runs under what was active when it ran.
        """
        # The turn belongs to the SOCKET that asked for it. Resolved once here so
        # every frame below is stamped with — and every queue touch lands on —
        # that window's session, never the primary one.
        router = self._router_for(ws)
        # Tag this run with the process's lifecycle generation. If the backend
        # restarts mid-turn, the generation rotates and every terminal frame
        # below is suppressed — a run from the previous life must not report
        # into a UI that has since reconnected against fresh state.
        generation = self.host.generation_id
        # 2.1 回合状态：这里是 idle/completed/error -> running 的唯一入口。
        # 落库而不是只存内存，是因为「有没有回合在跑」现在要能被一个刚连上来的
        # 窗口问到 —— 以前它只能问 `_turn_tasks`，那个字典是按 socket 身份存的，
        # 换个窗口就什么都不知道了。
        from turn_state import TurnStatus, get_turn_state
        turn_state = get_turn_state()
        turn_state.transition(router.session_id, TurnStatus.RUNNING, "preparing")
        await self._broadcast_turn_state(router.session_id)
        is_silent = bool(context_extra and context_extra.get("silent_consent"))
        await self._broadcast({
            "type": "task_started",
            "timestamp": time.time(),
            "payload": {"message": "" if is_silent else message, "source": source, "silent": is_silent},
            "sessionId": router.session_id,
        })

        # Autotitle and broadcast immediately so the sidebar reflects the new conversation
        # at 0ms right when the user presses send (matching common IDE agents).
        if not is_silent:
            try:
                router.storage.autotitle_session(router.session_id, message)
            except Exception:
                pass
            await self._broadcast_session_list()
            await self._broadcast_workspace_list()



        # Pass the permission level from the frontend payload into the router
        # context. The router resolves it once at the top of handle() and
        # enforces it for the whole turn.
        ctx = {}
        if context_extra:
            ctx = {"permission": context_extra.get("permission"),
                   # The composer's model pick travels WITH the request, the way
                   # every hosted API takes `model` as a parameter. Queued turns
                   # send nothing and fall back to config.json's model.
                   "model": context_extra.get("model"),
                   # Thinking budget for this turn (UD4). Same per-request
                   # treatment; absent means "don't send the parameter", which the
                   # router normalizes and is NOT the same as asking for none.
                   "thought_level": context_extra.get("thought_level")}
            # @ references for this turn (UB2). A structured list, not text: the
            # backend reads the files and injects them as their own message, so
            # the model gets CONTENT rather than a path it has to go fetch.
            refs = context_extra.get("context_refs")
            if isinstance(refs, list) and refs:
                ctx["context_refs"] = refs
            # A clicked answer to a pending confirmation. Passed through rather
            # than re-parsed from the message text so the decision is exact and
            # addresses the specific card, not just the newest ask.
            # 已批准方案的 plan_id（缺口 B）：透传给 Router，handle 前置
            # 注入合同并把 approved_with 写进终态 meta。
                ctx["approved_plan"] = context_extra["approved_plan"]
            ctx["approved_plan"] = context_extra["approved_plan"]
            for key in ("consent_decision", "consent_call_id", "question_answer", "silent_consent"):
                if context_extra.get(key) is not None:
                    ctx[key] = context_extra[key]

        # ── 0-Token 秒级 Slash Commands 拦截（/status, /permissions）──────────
        clean_msg = message.strip()
        if clean_msg in ("/status", "/permissions"):
            router.storage.add_message(router.session_id, "user", message)
            if clean_msg == "/status":
                ws_dir = getattr(router, "workspace", "") or getattr(router, "workspace_dir", "") or "Default"
                active_mod = ctx.get("model") or getattr(router, "default_model", "Default")
                perm = ctx.get("permission") or getattr(router, "permission_mode", "auto")
                th_lvl = ctx.get("thought_level") or "default"
                resp_text = f"""### 📊 系统运行状态报告

| 核心维度 | 当前状态 | 架构说明 |
|---|---|---|
| **会话标识** | `{router.session_id}` | SQLite & EventStore 权威会话 |
| **工作区范围** | `{ws_dir}` | 当前文件与工程上下文根目录 |
| **主模型引擎** | `{active_mod}` | 主控编排与推理模型 |
| **思考等级** | `{th_lvl}` | Reasoning Effort 预算 |
| **风控模式** | `{perm}` | 当前写操作与命令拦截策略 |
| **Subagent 配额** | `8` 并发上限 | 按需只读/隔离子代理并发池 |
| **五大能力分身** | 活跃在线 | Chronos / Engine / Matrix / Voyager / Oracle |

> 💡 **提示**：可直接使用 `/permissions` 查看权限矩阵，或输入 `/review` 对当前工作区改动发起 3-State 严格代码审查。
"""
            else:
                perm = ctx.get("permission") or getattr(router, "permission_mode", "auto")
                resp_text = f"""### 🛡️ 系统五大能力分身权限与沙箱策略

| 能力分身 | 职责边界 | 运行模式 | 保护策略 |
|---|---|---|---|
| **Chronos** | 文件 / 代码 / Git | `{perm}` | 工作区内部读写放行；覆盖/删除文件支持 Snapshot 自动快照回滚 |
| **Engine** | 系统 / 终端 / 进程 | 受控沙箱 | 只读探测放行；高危/破坏性 Shell 脚本触发风控拦截与人工确认 |
| **Matrix** | 桌面 / 应用 / 视觉 | UI 自动化 | 窗口交互与截图放行；屏幕数据脱敏 |
| **Voyager** | 浏览器 / 网页采集 | 只读/交互 | 页面导航与 DOM 提取放行；外部表单提交受限 |
| **Oracle** | 全网检索 / 知识库 | 只读 | 聚合搜索与事实交叉比对，不产生环境副作用 |

**沙箱与路径边界**：严格限制在当前工作区路径之内，越权路径自动拦截。
"""
            router.storage.add_message(router.session_id, "assistant", resp_text)
            turn_state.transition(router.session_id, TurnStatus.IDLE)
            await self._broadcast_turn_state(router.session_id)
            await self._broadcast({
                "type": "agent_response",
                "timestamp": time.time(),
                "sessionId": router.session_id,
                "payload": {"content": resp_text, "generation": generation},
            })
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "sessionId": router.session_id,
                "payload": {"usage": {"tokens": 0, "cost_micros": 0}, "generation": generation},
            })
            await self._broadcast_session_list()
            return

        # ── 工作流指令预处理与转导（/review, /simplify, /batch, /loop）────────
        if clean_msg.startswith("/review"):
            extra_arg = clean_msg[7:].strip()
            target_desc = f"目标：{extra_arg}" if extra_arg else "当前工作区所有改动 (git diff)"
            message = (
                f"【/review 指令执行】请以顶级代码审查员（reviewer）身份，对 {target_desc} 进行 3-State 严格代码审查。\n"
                "严格按以下标准分类每个潜在缺陷，绝不报无意义的套话建议：\n"
                "1. CONFIRMED — 指明确切的触发输入/状态及导致的崩溃/错误，精准引用代码行；\n"
                "2. PLAUSIBLE — 机制真实存在，但触发条件依赖时序/环境/配置，说明确认条件；\n"
                "3. REFUTED — 事实错误或在其他位置已被防御，引用反证代码行予以否决。\n"
                "输出格式：严重程度 + 缺陷代码行 + 3-State 状态 + 缺陷机理 + 最小修复方案。"
            )
        elif clean_msg.startswith("/simplify"):
            extra_arg = clean_msg[9:].strip()
            target_desc = f"目标：{extra_arg}" if extra_arg else "当前工作区修改的代码"
            message = (
                f"【/simplify 指令执行】请以代码精炼重构专家身份，对 {target_desc} 从四个维度进行专项精简与净化：\n"
                "1. 复用性（Reuse）：发现并消除重复实现；\n"
                "2. 简化（Simplification）：消除多余分支、过早抽象与不必要的 try-catch wrapper；\n"
                "3. 效率（Efficiency）：优化明显多余的循环或内存拷贝；\n"
                "4. 设计层级（Altitude）：消除无意义的间接层与过度抽象。\n"
                "严格保持原有功能与业务逻辑不变，只做代码净化与质量提升。"
            )
        elif clean_msg.startswith("/batch"):
            extra_arg = clean_msg[6:].strip()
            message = (
                f"【/batch 指令执行】请启动批量并发工作编排：{extra_arg or '对跨模块改动执行批量处理'}。\n"
                "1. 先深度分析影响范围，拆解为相互独立、可单独验证的任务单元；\n"
                "2. 通过 task 工具并发派发 subagents 执行，并实时渲染状态看板表格。"
            )
        elif clean_msg.startswith("/loop"):
            extra_arg = clean_msg[5:].strip()
            message = (
                f"【/loop 定时任务指令】请解析定时周期并执行任务：{extra_arg}。\n"
                "1. 提取时间周期并配置定时调度计划；\n"
                "2. 本轮立即执行一次该任务并汇报执行结果。"
            )
        elif clean_msg.startswith("/doctor"):
            extra_arg = clean_msg[7:].strip()
            message = (
                f"【/doctor 环境与项目体检指令】请以环境医生（diagnostician）身份，对当前工作区执行深度体检：\n"
                "1. 检查运行环境与工具链（Python, Node, Git, 编译器）；\n"
                "2. 检查依赖包完整性与锁文件健康状态；\n"
                "3. 检查工作区 Git 状态、冲突与权限配置；\n"
                "4. 输出结构化状态体检单（✅ PASS / ⚠️ WARN / ❌ FAIL）并附上一键修复方案。"
            )
        elif clean_msg.startswith("/stuck"):
            extra_arg = clean_msg[6:].strip()
            message = (
                f"【/stuck 陷入卡点自救指令】当前任务遇到阻碍：{extra_arg or '请分析当前卡点并重新规划突破路径'}。\n"
                "1. 快速反思过去两轮尝试失败的根本原因（Root Cause）；\n"
                "2. 主动摒弃无效的机械重试，列出 3 种完全不同的备选解决路径；\n"
                "3. 评估各路径的成本与风险，推荐最优路径并立即推进验证。"
            )
        elif clean_msg == "/dream":
            try:
                report = await router.memory.dream_consolidate()
                resp_text = f"### 🌙 梦境记忆整合完成\n\n{report or '本轮无新增冲突或冗余记忆，记忆库处于最新最优状态。'}"
            except Exception as e:
                resp_text = f"### 🌙 梦境记忆整合\n\n整合过程中未发现待处理冲突项（{e}）。"
            router.storage.add_message(router.session_id, "user", message)
            router.storage.add_message(router.session_id, "assistant", resp_text)
            turn_state.transition(router.session_id, TurnStatus.IDLE)
            await self._broadcast_turn_state(router.session_id)
            await self._broadcast({
                "type": "agent_response",
                "timestamp": time.time(),
                "sessionId": router.session_id,
                "payload": {"content": resp_text, "generation": generation},
            })
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "sessionId": router.session_id,
                "payload": {"usage": {"tokens": 0, "cost_micros": 0}, "generation": generation},
            })
            await self._broadcast_session_list()
            return

        # `handle()` must never take the turn-termination broadcast down with it.
        # Previously this call was unguarded: an unhandled exception here emitted
        # NO terminal event, and the UI only recovered because the exception tore
        # the socket down and the client's onclose fired. That is recovery by
        # accident. Catch it, report it, and always fall through to a terminal
        # broadcast so the composer is handed back deterministically.
        try:
            result = await router.handle(message, ctx)
        except asyncio.CancelledError:
            # Cooperative cancellation (interrupt) — the interrupt handler already
            # broadcasts `idle`; re-raise so the task actually stops.
            raise
        except Exception as exc:  # noqa: BLE001 - last-resort turn guard
            import traceback
            traceback.print_exc()
            # State first, reporting second. If the frame below is suppressed by
            # the generation guard the row must still say `error` — a suppressed
            # frame is a UI decision, not a licence to leave the session stuck at
            # `running` forever.
            turn_state.transition(router.session_id, TurnStatus.ERROR)
            await self._broadcast_turn_state(router.session_id)

            # A restart during handle() rotates the generation; refuse to
            # deliver a terminal frame into a UI that has since reconnected.
            if not self.host.is_generation_current(generation):
                return
            # Retry grace: don't fire the terminal error immediately. A
            # transient LLM 5xx or dropped socket will resolve itself if the
            # client re-sends the same msg_id within the grace window; parking
            # the error lets that retry succeed silently instead of leaving a
            # scary red toast the user has to dismiss and re-drive. If no
            # retry arrives, the timer fires and the error commits normally.
            # Never hand the user a Python traceback. `_friendly_error` maps the
            # failure onto plain language plus a next step, and keeps the
            # technical text in `detail` for logs / a "查看技术详情" fold.
            friendly = self._friendly_error(exc)
            print(f"[turn] failed ({router.session_id}): {friendly['detail']}")
            if msg_id:
                await self._schedule_error(ws, router.session_id, msg_id, friendly)
            else:
                await self._send_error(ws, friendly)
                await self._broadcast({
                    "type": "completed",
                    "timestamp": time.time(),
                    "payload": {
                        "result": "error",
                        "error": friendly["message"],
                        "hint": friendly["hint"],
                        "detail": friendly["detail"],
                    },
                    "sessionId": router.session_id,
                })
                if router.queue.ui_pending > 0:
                    router.queue.ui_pause("internal-error")
                    await self._broadcast_queue_state()
            return

        # Same guard on the success path.
        if not self.host.is_generation_current(generation):
            return

        meta = getattr(result, "meta", None) or {}
        turn_outcome = meta.get("turn_outcome") or ("completed" if result.ok else "error")

        if turn_outcome == "cancelled" or meta.get("cancelled"):
            await self._settle_turn_state(router.session_id, TurnStatus.PAUSED)
            done_payload = {"result": "cancelled", "turnOutcome": "cancelled", "message": result.value or result.error or "已中断（用户点击了停止）"}
            _usage = meta.get("usage")
            if isinstance(_usage, dict) and _usage:
                done_payload["usage"] = _usage
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "payload": done_payload,
                "sessionId": router.session_id,
            })
            await self._broadcast_session_list()
            await self._broadcast_workspace_list()
        elif turn_outcome == "incomplete" or meta.get("incomplete"):
            await self._settle_turn_state(router.session_id, TurnStatus.COMPLETED)
            done_payload = {"result": "incomplete", "turnOutcome": "incomplete", "message": result.value or result.error}
            _usage = meta.get("usage")
            if isinstance(_usage, dict) and _usage:
                done_payload["usage"] = _usage
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "payload": done_payload,
                "sessionId": router.session_id,
            })
            await self._broadcast_session_list()
            await self._broadcast_workspace_list()
        elif turn_outcome == "partial" or meta.get("partial"):
            payload = {"message": result.value}
            images = ctx.get("generated_images")
            if images:
                payload["images"] = images
            if result.value or images:
                await self._broadcast({
                    "type": "agent_response",
                    "timestamp": time.time(),
                    "payload": payload,
                    "sessionId": router.session_id,
                })
            await self._settle_turn_state(router.session_id, TurnStatus.COMPLETED)
            done_payload = {"result": "partial", "turnOutcome": "partial"}
            _usage = meta.get("usage")
            if isinstance(_usage, dict) and _usage:
                done_payload["usage"] = _usage
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "payload": done_payload,
                "sessionId": router.session_id,
            })
            await self._broadcast_session_list()
            await self._broadcast_workspace_list()
        elif result.ok:
            payload = {"message": result.value}
            images = ctx.get("generated_images")
            if images:
                payload["images"] = images
            if result.value or images:
                await self._broadcast({
                    "type": "agent_response",
                    "timestamp": time.time(),
                    "payload": payload,
                    "sessionId": router.session_id,
                })
            await self._settle_turn_state(router.session_id, TurnStatus.COMPLETED)
            done_payload = {"result": "success", "turnOutcome": "completed"}
            _usage = meta.get("usage")
            if isinstance(_usage, dict) and _usage:
                done_payload["usage"] = _usage
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "payload": done_payload,
                "sessionId": router.session_id,
            })
            await self._broadcast_session_list()
            await self._broadcast_workspace_list()
        else:
            await self._send_error(ws, result.error)
            await self._settle_turn_state(router.session_id, TurnStatus.ERROR)
            await self._broadcast({
                "type": "completed",
                "timestamp": time.time(),
                "payload": {"result": "error", "turnOutcome": "error", "error": result.error},
                "sessionId": router.session_id,
            })
            await self._broadcast_session_list()
            await self._broadcast_workspace_list()
            if router.queue.ui_pending > 0:
                await router.queue.ui_pause("error")
                await self._broadcast_queue_state()

    async def _drain_ui_queue(self, ws) -> None:
        """After a turn completes, run any queued prompts back-to-back."""
        # Safety valve: stop if paused, empty, or we've drained a lot in a row
        # (shouldn't happen in normal use, but a cap keeps a runaway from
        # locking the socket).
        queue = self._router_for(ws).queue
        for _ in range(64):
            item = await queue.ui_take_next()
            if item is None:
                break
            # Broadcast the shrunk queue immediately so the UI updates before
            # the next turn's events start rolling in.
            await self._broadcast_queue_state()
            await self._run_turn(ws, item["text"], source="queue")

    async def _handle_message(self, ws, data: dict):
        event_type = data.get("type")
        payload = data.get("payload", {}) or {}
        # Track socket's active session and branch dynamically
        msg_sid = payload.get("sessionId") or payload.get("session_id") or data.get("sessionId") or data.get("session_id")
        msg_bid = payload.get("branchId") or payload.get("branch_id") or data.get("branchId") or data.get("branch_id")
        if msg_sid:
            self._bind_session(ws, str(msg_sid), str(msg_bid or ""))
        elif msg_bid is not None and id(ws) in self._session_by_ws:
            self._branch_by_ws[id(ws)] = str(msg_bid).strip()

        # Resolve THIS socket's session before anything else: the queue, the
        # turn guard and every router call below must belong to the window that
        # sent the frame, not to whichever session happens to be primary.
        router = self._router_for(ws)
        q = router.queue

        if event_type == "user_prompt":
            message_text = payload.get("message", "")
            # Inbound dedupe. The client mints a `msgId` per send; a reconnect
            # replay or a double-click delivers the SAME id twice. Accepting the
            # copy would run every tool a second time (and possibly commit a git
            # push twice).
            #
            # One subtlety decides the whole design: a resend of the same id is
            # sometimes a duplicate and sometimes a deliberate RETRY of a turn
            # that just failed. The pending-error table tells them apart — if a
            # failure is still parked for this id, the previous attempt errored
            # and this is the retry, so it must run (and cancel the parked
            # error). Only when nothing is parked is a repeat id a true
            # duplicate. Clients too old to send an id fall back to a short
            # text-window guess that catches an accidental double-fire and
            # nothing else.
            msg_id = payload.get("msgId") or payload.get("msg_id") or ""
            if msg_id:
                is_retry = self._cancel_pending_error(router.session_id, msg_id)
                if not is_retry and self.host.dedupe_seen(
                    router.session_id, msg_id, channel="ws"
                ):
                    return
            elif self.host.dedupe_seen(
                router.session_id, message_text, channel="ws", kind="text"
            ):
                return
            # Run the turn on a BACKGROUND task so the WS read loop keeps
            # draining frames while the agent works. Without this, `interrupt`
            # and `steer` sit unread in the socket buffer until the turn ends,
            # which makes both of them useless by definition. One turn at a
            # time PER SESSION — a second `user_prompt` on the same socket is
            # guardrailed here and routed onto that session's UI queue, while a
            # different window's prompt runs concurrently.
            if self._turn_running(ws):
                # 2.4: the user pressed send, expecting it to go now. It didn't,
                # because a turn is already running on this socket. Record BOTH
                # what they wanted and why it was deferred, so the queue panel can
                # say so instead of silently swallowing the click.
                await q.ui_enqueue(
                    message_text, requested="send",
                    reason="当前回合还在进行，这条已排队，回合结束后自动发送。",
                )
                await self._broadcast_queue_state()
                return

            target_sid = router.session_id
            async def _run_and_drain():
                try:
                    await self._run_turn(
                        ws,
                        message_text,
                        source="user",
                    context_extra={"permission": payload.get("permission"),
                                   "model": payload.get("model"),
                                   "thought_level": payload.get("thoughtLevel"),
                                   "context_refs": payload.get("contextRefs")},
                        msg_id=msg_id,
                    )
                    await self._drain_ui_queue(ws)
                finally:
                    self._turn_tasks.pop(id(ws), None)
                    self._turn_tasks_by_sid.pop(target_sid, None)


            task = asyncio.create_task(_run_and_drain())
            self._turn_tasks[id(ws)] = task
            self._turn_tasks_by_sid[target_sid] = task

        elif event_type == "respond_permission":
            # Answer a pending tool confirmation by CLICKING, not by typing.
            #
            # Before this, the only way to say yes was to type 同意 into the
            # composer — which meant the answer could only ever address the
            # NEWEST ask (that's all `resolve_pending` can infer from text), and
            # a user with two parked confirmations had no way to say which one
            # they meant. Carrying `callId` fixes that.
            #
            # It deliberately re-enters the same `_run_turn` path as a normal
            # prompt: the decision is applied inside `Router.handle`, which
            # already knows how to grant, write the standing rule, and tell the
            # model to re-issue the identical call. A second resume path here
            # would be a second place for that sequence to drift.
            decision = str(payload.get("decision") or "").strip().lower()
            if decision not in ("approve", "approve_always", "deny"):
                await self._send_error(ws, f"bad permission decision: {decision}")
                return
            if self._turn_running(ws):
                # A turn is running, so nothing is parked waiting on the user.
                # Silently dropping would leave the button looking broken.
                await self._send_error(ws, "a turn is already running")
                return
            # Shown in the transcript so the log reads the same whether the user
            # clicked or typed — an approval that leaves no trace is worse than
            # a slightly verbose one.
            text = {"approve": "同意", "approve_always": "以后都允许",
                    "deny": "不用了"}[decision]

            target_sid = router.session_id
            async def _run_consent():
                try:
                    await self._run_turn(
                        ws, text, source="user",
                        context_extra={
                            "consent_decision": decision,
                            "consent_call_id": str(payload.get("callId")
                                                   or payload.get("toolCallId") or ""),
                            "permission": payload.get("permission"),
                            "model": payload.get("model"),
                            "thought_level": payload.get("thoughtLevel"),
                            "silent_consent": True,
                        },
                        msg_id=payload.get("msgId") or "",
                    )
                    await self._drain_ui_queue(ws)
                finally:
                    self._turn_tasks.pop(id(ws), None)
                    self._turn_tasks_by_sid.pop(target_sid, None)

            task = asyncio.create_task(_run_consent())
            self._turn_tasks[id(ws)] = task
            self._turn_tasks_by_sid[target_sid] = task

        elif event_type == "approve_plan":
            # 方案审批卡的回执（缺口 B）。批准 = 立即以批准时的权限档开执行轮，
            # 合同经 context_extra.approved_plan 注入；放弃 = 归档 artifact，
            # 不发轮次。两者都是用户显式点击，不走 silent_consent 通道。
            plan_id = str(payload.get("plan_id") or "").strip()
            decision = str(payload.get("decision") or "approve").strip().lower()
            if decision not in ("approve", "discard"):
                await self._send_error(ws, f"bad plan decision: {decision}")
                return
            from plan_artifact import (
                approve_plan_artifact, discard_plan_artifact, get_plan_artifact,
            )
            art = get_plan_artifact(plan_id)
            if not art:
                await self._send_error(ws, f"plan not found: {plan_id}")
                return
            if decision == "discard":
                discard_plan_artifact(plan_id)
                await self._broadcast({
                    "type": "plan_discarded",
                    "payload": {"plan_id": plan_id},
                    "sessionId": router.session_id,
                    "timestamp": time.time(),
                })
                return
            approved = approve_plan_artifact(
                plan_id,
                approved_with=str(payload.get("approved_with")
                                   or "auto"),
            )
            if not approved:
                await self._send_error(ws, "plan already processed")
                return
            await self._broadcast({
                "type": "plan_approved",
                "payload": {"plan_id": plan_id},
                "sessionId": router.session_id,
                "timestamp": time.time(),
            })
            if self._turn_running(ws):
                await self._send_error(ws, "a turn is already running")
                return

            target_sid = router.session_id

            async def _run_approved():
                try:
                    await self._run_turn(
                        ws, "按已批准的方案开始执行。", source="user",
                        context_extra={
                            "permission": approved.get("approved_with") or "auto",
                            "approved_plan": plan_id,
                        },
                    )
                    await self._drain_ui_queue(ws)
                finally:
                    self._turn_tasks.pop(id(ws), None)
                    self._turn_tasks_by_sid.pop(target_sid, None)

            task = asyncio.create_task(_run_approved())
            self._turn_tasks[id(ws)] = task
            self._turn_tasks_by_sid[target_sid] = task
        elif event_type == "respond_question":
            # Answer a parked `ask_user` question by clicking its card.
            #
            # 两条路，优先走第一条：
            #
            # 1. 挂起中的回合（大厂语义）。那个 tool_use 还开着，`deliver_answer`
            #    把结果交给正在 await 的 Future，答案成为**同一个调用的 tool
            #    result**，回合从原地继续。这里不能启新回合，所以必须在
            #    `_turn_running` 拦截之前判断——那个回合本来就在跑，它跑的正是
            #    这个等待。
            #
            # 2. 没人在等（连接断过、后端重启过、超时退回过）。回落到持久账本：
            #    由 store 渲染答案文本，作为一条普通用户消息开新回合。
            #
            # 渲染始终交给 store 而不是前端：浏览器手里有自己那份问题副本，让它
            # 措辞用户的发言等于把 transcript 文本挪出后端控制范围。
            from ask_user import deliver_answer, get_ask_user_store, has_waiter

            call_id = str(payload.get("callId") or payload.get("toolCallId") or "")
            if call_id and has_waiter(call_id):
                if deliver_answer(call_id, payload.get("answers"),
                                  bool(payload.get("skipped"))):
                    return
                # 交付失败只可能是刚好被超时/取消抢先，落到下面那条路。

            if self._turn_running(ws):
                await self._send_error(ws, "a turn is already running")
                return
            sid = self._router_for(ws).session_id
            text = get_ask_user_store().resolve(
                sid,
                call_id=call_id,
                answers=payload.get("answers"),
                skipped=bool(payload.get("skipped")),
            )
            if not text:
                # Nothing matched: the question was already answered, or the
                # backend restarted since it was asked. Say so instead of
                # starting a turn whose user message would be "我选了：".
                await self._send_error(ws, "这组问题已经不在等待中了（可能已回答或后端重启过）")
                return

            target_sid = sid
            async def _run_answer():
                try:
                    await self._run_turn(
                        ws, text, source="user",
                        context_extra={"permission": payload.get("permission"),
                                       "model": payload.get("model"),
                                       "thought_level": payload.get("thoughtLevel"),
                                       # Marks this turn as the click-answer path so
                                       # Router.handle doesn't discard the OTHER parked
                                       # questions — the answered one was already
                                       # consumed above.
                                       "question_answer": True},
                        msg_id=payload.get("msgId") or "",
                    )
                    await self._drain_ui_queue(ws)
                finally:
                    self._turn_tasks.pop(id(ws), None)
                    self._turn_tasks_by_sid.pop(target_sid, None)

            task = asyncio.create_task(_run_answer())
            self._turn_tasks[id(ws)] = task
            self._turn_tasks_by_sid[target_sid] = task


        elif event_type == "steer":
            # 真Steer: inject a fresh user instruction into the RUNNING loop so
            # the model course-corrects on the very next step instead of after
            # the turn finishes. When nothing is running there is no loop to
            # steer, so we degrade cleanly to an urgent enqueue.
            text = (payload.get("text") or "").strip()
            if not text:
                return
            if not self._turn_running(ws):
                # 2.4: they asked to interrupt, but there is nothing to
                # interrupt. It still goes to the front of the queue, so the
                # `delivery` value alone would look like the request was honoured
                # — say what actually happened instead.
                await router.queue.ui_enqueue(
                    text, urgent=True, requested="steer",
                    reason="当前没有正在进行的回合可以打断，这条已插到队首，下一轮先发它。",
                )
                await self._broadcast_queue_state()
                return
            from messaging import DeliverAs
            await router.queue.send_message(text, DeliverAs.STEER, sender="user")

            # Hard preemption: if urgent_interrupt or immediate is requested,
            # promptly abort in-flight blocking tool calls (e.g. hung npm/build processes)
            # so the model course-corrects in <10ms instead of waiting for minutes.
            if payload.get("urgent_interrupt", True) or payload.get("immediate", False):
                try:
                    router.cancel_hard()
                except Exception as _e:
                    print(f"[http_server] steer cancel_hard error: {_e}")

            await self._broadcast({
                "type": "steer_queued",
                "timestamp": time.time(),
                "sessionId": router.session_id,
                "payload": {"text": text},
            })
            await self._broadcast_queue_state()

        elif event_type == "queue_enqueue":
            text = payload.get("text", "")
            if text.strip():
                await q.ui_enqueue(text, urgent=bool(payload.get("urgent")))
                await self._broadcast_queue_state()
                if not self._turn_running(ws) and not q.is_paused:
                    asyncio.create_task(self._drain_ui_queue(ws))

        elif event_type == "queue_remove":
            await q.ui_remove(payload.get("id", ""))
            await self._broadcast_queue_state()

        elif event_type == "queue_clear":
            await q.ui_clear()
            await self._broadcast_queue_state()

        elif event_type == "queue_update_text":
            await q.ui_update_text(payload.get("id", ""), payload.get("text", ""))
            await self._broadcast_queue_state()

        elif event_type == "queue_promote":
            await q.ui_promote(payload.get("id", ""))
            await self._broadcast_queue_state()
            if not self._turn_running(ws) and not q.is_paused:
                asyncio.create_task(self._drain_ui_queue(ws))

        elif event_type == "queue_reorder":
            await q.ui_reorder(payload.get("ids", []) or [])
            await self._broadcast_queue_state()

        elif event_type == "queue_pause":
            await q.ui_pause(payload.get("reason", "manual"))
            await self._broadcast_queue_state()

        elif event_type == "queue_resume":
            await q.ui_resume()
            await self._broadcast_queue_state()
            # Resuming should immediately start draining what's waiting.
            await self._drain_ui_queue(ws)

        elif event_type == "interrupt":
            # Stop request. Cooperative cancel of the in-flight turn (the agent
            # loop checks the flag between steps and tool calls), plus a queue
            # pause so nothing fires at a half-stopped agent.
            sid = payload.get("sessionId") or router.session_id
            router.cancel()
            hard = getattr(router, "cancel_hard", None)
            if callable(hard):
                try:
                    hard()
                except Exception as _e:
                    print(f"[http_server] interrupt cancel_hard error: {_e}")

            # Immediately cancel in-flight asyncio task(s) for this session
            live_tasks = self._live_turn_tasks_for(ws, sid=sid)
            for t in live_tasks:
                if not t.done():
                    t.cancel()
            self._turn_tasks_by_sid.pop(sid, None)
            self._turn_tasks.pop(id(ws), None)

            self._spawn_stop_watchdog(ws, router=router)
            await q.ui_pause("interrupted")
            await self._broadcast_queue_state()
            from turn_state import TurnStatus, get_turn_state
            get_turn_state().transition(sid, TurnStatus.PAUSED, force=True)
            await self._broadcast_turn_state(sid)
            await self._broadcast({
                "type": "idle",
                "timestamp": time.time(),
                "payload": {"reason": "interrupted"},
                "sessionId": sid,
            })


        elif event_type == "resume_turn":
            # Pick up a turn the user had stopped.
            #
            # Deliberately NOT a magic continuation of the cancelled asyncio task
            # — that task is gone, and pretending otherwise would mean restoring
            # a half-executed tool loop. What resumes is the CONVERSATION: the
            # queue un-pauses and a fresh turn runs with the user's continuation
            # text (or a default nudge). The transcript already holds everything
            # the previous attempt accomplished, so the model picks up with full
            # context rather than from zero.
            from turn_state import TurnStatus, get_turn_state
            ts = get_turn_state()
            if ts.current(router.session_id) is not TurnStatus.PAUSED:
                await self._send_error(ws, "没有被暂停的回合可以继续")
                return
            if self._turn_running(ws):
                await self._send_error(ws, "a turn is already running")
                return
            text = (payload.get("text") or "").strip() or "接着上面没做完的部分继续。"
            await q.ui_resume()
            await self._broadcast_queue_state()

            target_sid = router.session_id
            async def _run_resume():
                try:
                    await self._run_turn(
                        ws, text, source="user",
                        context_extra={"permission": payload.get("permission"),
                                       "model": payload.get("model"),
                                       "thought_level": payload.get("thoughtLevel")},
                        msg_id=payload.get("msgId") or "",
                    )
                    await self._drain_ui_queue(ws)
                finally:
                    self._turn_tasks.pop(id(ws), None)
                    self._turn_tasks_by_sid.pop(target_sid, None)

            task = asyncio.create_task(_run_resume())
            self._turn_tasks[id(ws)] = task
            self._turn_tasks_by_sid[target_sid] = task


        elif event_type == "cancel_tool":
            # Kill ONE running command, not the turn. `interrupt` above stops
            # everything; this is the ✕ on a single terminal card — the process
            # tree dies, `run_shell` returns whatever it printed before the kill,
            # and the agent gets that partial output as a normal tool result so
            # it can react instead of being left mid-transcript.
            cid = str(payload.get("toolCallId") or payload.get("call_id") or "")
            killed = cancel_call(cid) if cid else False
            await self._broadcast({
                "type": "tool_cancelled",
                "timestamp": time.time(),
                "sessionId": router.session_id,
                "payload": {"toolCallId": cid, "ok": killed},
            })

        elif event_type == "fold":
            # Manual context fold ("/fold" or the composer button).
            result = await router.fold_context(manual=True)
            if result.ok:
                await self._broadcast({
                    "type": "fold_result",
                    "timestamp": time.time(),
                    "sessionId": router.session_id,
                    "payload": {"ok": True, **result.value},
                })
            else:
                await self._broadcast({
                    "type": "fold_result",
                    "timestamp": time.time(),
                    "sessionId": router.session_id,
                    "payload": {"ok": False, "reason": result.error},
                })
            # Drain any prompts that were queued before or during folding
            if not self._turn_running(ws) and not q.is_paused and q.ui_pending > 0:
                asyncio.create_task(self._drain_ui_queue(ws))

        elif event_type == "session_truncate":
            await self._handle_session_truncate(ws, payload)

        elif event_type == "session_list":
            await self._send_session_list(ws)

        elif event_type == "session_new":
            await self._handle_session_new(ws, payload)

        elif event_type == "session_switch":
            await self._handle_session_switch(ws, payload)

        elif event_type == "session_fork":
            await self._handle_session_fork(ws, payload)


        elif event_type == "session_delete":
            await self._handle_session_delete(ws, payload)

        elif event_type == "session_rename":
            await self._handle_session_rename(ws, payload)

        elif event_type == "session_pin":
            await self._handle_session_pin(ws, payload)

        elif event_type == "workspace_switch":
            await self._handle_workspace_switch(ws, payload)

        elif event_type == "workspace_list":
            await self._send_workspace_list(ws)

        elif event_type == "workspace_rename":
            await self._handle_workspace_rename(ws, payload)

        elif event_type == "workspace_pin":
            await self._handle_workspace_pin(ws, payload)

        elif event_type == "workspace_hide":
            await self._handle_workspace_hide(ws, payload)

        elif event_type == "workspace_settings_get":
            await self._handle_workspace_settings_get(ws, payload)

        elif event_type == "workspace_settings_set":
            await self._handle_workspace_settings_set(ws, payload)


        elif event_type == "queue_request":
            # Explicit resync (client asks for the current snapshot). Pass `ws`
            # so the window gets ITS OWN queue, not the primary session's.
            await ws.send_json(self._queue_state_event(ws))

        elif event_type == "ping":
            await ws.send_json({"type": "pong", "timestamp": time.time()})
        else:
            await self._send_error(ws, f"Unknown event type: {event_type}")

    async def _send_session_list(self, ws) -> None:
        """Push the current session list + which one is active.

        The session ROWS are global, but which one is active is per window, so
        `activeId` / `activeWorkspace` come from the asking socket's router.
        """
        router = self._router_for(ws)
        storage = router.storage
        try:
            sessions = storage.list_sessions()
        except Exception as exc:  # noqa: BLE001
            await self._send_error(ws, f"list_sessions failed: {exc}")
            return
        await ws.send_json({
            "type": "session_list",
            "timestamp": time.time(),
            "sessionId": router.session_id,
            "payload": {
                "sessions": sessions,
                "activeId": router.session_id,
                "activeWorkspace": router.effective_workspace,
            },
        })

    async def _broadcast_session_list(self) -> None:
        """Push the session list to EVERY connected window.

        The session rows are global, but activeId/activeWorkspace are per socket.
        """
        for client in list(self.clients):
            try:
                await self._send_session_list(client)
            except Exception as exc:  # noqa: BLE001
                print(f"[http] broadcast session_list failed: {exc}")

    async def _send_pending_questions(self, ws, sid: str = "") -> None:
        """Send one socket the `ask_user` questions still waiting in a session.

        Called on connect and after a session switch, because both moments leave
        the client with an empty `toolCalls` list — a question parked before the
        reload would otherwise be invisible AND unanswerable, with the turn
        already stopped. Sent even when empty: the frontend uses the frame to
        settle stale cards, so "nothing pending" is real information.
        """
        from ask_user import get_ask_user_store

        target = sid or self._router_for(ws).session_id
        try:
            items = get_ask_user_store().snapshot(target)
        except Exception:
            return  # unreadable ledger degrades to "no cards", never a failed connect
        await ws.send_json({
            "type": "pending_questions",
            "timestamp": time.time(),
            "sessionId": target,
            "payload": {"items": items},
        })

    def _workspace_list_event(self, ws=None) -> dict:
        """Build the workspace_list frame. Raises if storage is unreadable.

        The folder LIST is global, but which one is `active` is per session, so
        the frame is built against the asking socket's router.
        """
        router = self._router_for(ws) if ws is not None else self.router
        # `effective_workspace`, not `workspace`: the latter falls back to the
        # backend's own launch directory, which would then be listed as a real
        # folder and highlighted as active — a workspace the user never opened.
        active = router.effective_workspace
        return {
            "type": "workspace_list",
            "timestamp": time.time(),
            "sessionId": router.session_id,
            "payload": {
                "workspaces": router.storage.list_workspaces(always_include=active),
                "active": active,
            },
        }

    async def _send_workspace_list(self, ws) -> None:
        """Workspace folders that have real conversations, plus the active one."""
        try:
            event = self._workspace_list_event(ws)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(ws, f"list_workspaces failed: {exc}")
            return
        await ws.send_json(event)

    async def _broadcast_workspace_list(self) -> None:
        """Push the workspace list to EVERY connected window.

        The list itself is shared state (a folder renamed or pinned in one
        window must show up in the others), but `active` is per session — so
        each socket gets a frame built against its OWN router rather than one
        shared frame that would relabel every window's active folder.
        """
        for client in list(self.clients):
            try:
                event = self._workspace_list_event(client)
            except Exception as exc:  # noqa: BLE001
                print(f"[http] broadcast workspace_list failed: {exc}")
                return
            await self._deliver(client, event)

    async def _handle_workspace_switch(self, ws, payload: dict) -> None:
        """Open a different working folder.

        Refused mid-turn: the sandbox boundary is derived from the workspace, so
        moving it while a tool is running would let that tool act outside the
        directory the user authorised.
        """
        path = (payload.get("path") or "").strip()
        if not path:
            await self._send_error(ws, "workspace_switch needs a path")
            return
        if self._turn_running(ws):
            await self._send_error(ws, "Can't switch workspace while a turn is running")
            return
        router = self._router_for(ws)
        result = router.switch_workspace(path)
        if not result.ok:
            await self._send_error(ws, result.error)
            return
        # Register the folder in the workspaces table so it appears in the sidebar
        # even before the user has any conversation in it, and stamp last_opened_at.
        resolved = router.workspace or ""
        if resolved:
            try:
                router.storage.upsert_workspace(resolved, touch_opened=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[http] upsert_workspace on switch failed: {exc}")
            # Load and apply any per-workspace settings (model / mode / reasoning).
            try:
                settings = router.storage.get_workspace_settings(resolved) or {}
                if settings:
                    self._apply_workspace_settings(settings, router)
            except Exception as exc:  # noqa: BLE001
                print(f"[http] apply_workspace_settings on switch failed: {exc}")
        # switch_workspace() already created a fresh session for the new folder.
        await self._switch_and_reply(ws, router.session_id)
        await self._broadcast_workspace_list()

    # ------------------------------------------------------------------
    # Workspace CRUD (rename / pin / hide / settings)
    # ------------------------------------------------------------------

    async def _handle_workspace_rename(self, ws, payload: dict) -> None:
        """Give a workspace a human-friendly display name.

        Refuses to rename the default workspace (empty path) — it isn't a
        distinct row in the workspaces table, so renaming has nowhere to write.
        """
        path = (payload.get("path") or "").strip()
        name = (payload.get("displayName") or payload.get("display_name") or "")
        if not path:
            await self._send_error(ws, "Cannot rename the default workspace")
            return
        try:
            self.router.storage.rename_workspace(path, name)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(ws, f"rename_workspace failed: {exc}")
            return
        await self._broadcast_workspace_list()

    async def _handle_workspace_pin(self, ws, payload: dict) -> None:
        """Sticky-top a workspace so it sorts above unpinned folders."""
        path = (payload.get("path") or "").strip()
        pinned = bool(payload.get("pinned", True))
        if not path:
            await self._send_error(ws, "workspace_pin needs a path")
            return
        try:
            self.router.storage.set_workspace_pinned(path, pinned)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(ws, f"set_workspace_pinned failed: {exc}")
            return
        await self._broadcast_workspace_list()

    async def _handle_workspace_hide(self, ws, payload: dict) -> None:
        """Remove a workspace from the sidebar without deleting its sessions.

        Hiding a workspace that still owns sessions leaves the sessions
        reachable from search / history — the row just stops appearing in the
        tree, which matches the "从列表移除" semantics.
        """
        path = (payload.get("path") or "").strip()
        hidden = bool(payload.get("hidden", True))
        if not path:
            await self._send_error(ws, "workspace_hide needs a path")
            return
        try:
            self.router.storage.set_workspace_hidden(path, hidden)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(ws, f"set_workspace_hidden failed: {exc}")
            return
        await self._broadcast_workspace_list()

    async def _handle_workspace_settings_get(self, ws, payload: dict) -> None:
        """Fetch the per-workspace settings blob for the given path."""
        path = (payload.get("path") or "").strip()
        router = self._router_for(ws)
        try:
            settings = router.storage.get_workspace_settings(path)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(ws, f"get_workspace_settings failed: {exc}")
            return
        await ws.send_json({
            "type": "workspace_settings",
            "timestamp": time.time(),
            "sessionId": router.session_id,
            "payload": {"path": path, "settings": settings},
        })

    async def _handle_workspace_settings_set(self, ws, payload: dict) -> None:
        """Merge a partial settings dict into the workspace's stored settings.

        The write is scoped to one workspace, not the global config, so a change
        in project A cannot leak into project B. When the affected workspace is
        the currently active one, we also apply the values live to router state
        so the user doesn't have to re-open the folder to feel the change.
        """
        path = (payload.get("path") or "").strip()
        patch = payload.get("settings") or {}
        if not path:
            await self._send_error(ws, "workspace_settings_set needs a path")
            return
        router = self._router_for(ws)
        try:
            merged = router.storage.set_workspace_settings(path, patch)
        except Exception as exc:  # noqa: BLE001
            await self._send_error(ws, f"set_workspace_settings failed: {exc}")
            return
        if path == (router.workspace or ""):
            self._apply_workspace_settings(merged or {}, router)
        await ws.send_json({
            "type": "workspace_settings",
            "timestamp": time.time(),
            "sessionId": router.session_id,
            "payload": {"path": path, "settings": merged or {}},
        })

    def _apply_workspace_settings(self, settings: dict, router: "Router" = None) -> None:
        """Push per-workspace settings values into the live router.

        Kept narrow: only the fields we actually know how to route back into the
        router are copied. Anything else is stored but ignored until a code path
        picks it up — silent forwarding of unknown keys would let a bad settings
        payload alter session_config in surprising ways.
        """
        router = router or self.router
        if "model" in settings and settings["model"]:
            try:
                # Real attribute on Router (see Router.__init__). `_bind_turn_model`
                # falls back to it when a turn payload carries no pick, which is
                # exactly the queued-turn case.
                router.workspace_model = str(settings["model"])
            except Exception:  # noqa: BLE001
                pass
        # Per-workspace permission default. Accepts the new `permission` key and,
        # for workspaces saved under the old scheme, maps a legacy `mode` onto it
        # (plan stays plan; the old read-only `ask` mode → readonly).
        _perm = settings.get("permission")
        if not _perm and settings.get("mode") in ("plan", "ask"):
            _perm = "plan" if settings["mode"] == "plan" else "readonly"
        if _perm:
            try:
                from risk_control import coerce_permission
                router.permission = coerce_permission(_perm)
            except Exception:  # noqa: BLE001
                pass
        if "reasoning" in settings and settings["reasoning"]:
            try:
                # Same real-attribute story as the model above: the turn-start
                # resolver reads this when the payload sends no thought level.
                router.workspace_thought_level = str(settings["reasoning"])
            except Exception:  # noqa: BLE001
                pass

    def _history_messages(self, sid: str) -> list:
        """Load a session's stored messages, shaped for the frontend timeline.

        SQLite rows carry `metadata` as a JSON string; we parse it and lift
        `images` up to a top-level field (the live `agent_response` path does the
        same), and map the `compaction` msg_type onto a fold marker so replayed
        history renders like a live session. Rows whose role is neither user nor
        assistant are UI-only error lines and are dropped on reload.
        """
        rows = self.router.storage.get_messages(sid, limit=1000)
        out = []
        for r in rows:
            try:
                meta = json.loads(r.get("metadata") or "{}")
            except (TypeError, ValueError):
                meta = {}
            role = r.get("role")
            if r.get("msg_type") == "compaction":
                out.append({
                    "id": r.get("id"),
                    "role": "system",
                    "kind": "fold",
                    "content": r.get("content") or "",
                    "timestamp": (r.get("created_at") or 0) * 1000,
                    "fold": {
                        "strategy": "llm-summary",
                        "summary": r.get("content") or "",
                        "tokensBefore": meta.get("tokensBefore"),
                        "estimatedTokensAfter": meta.get("estimatedTokensAfter"),
                    },
                })
                continue
            if role not in ("user", "assistant"):
                continue
            content = r.get("content") or ""
            # An assistant row with no text AND no images is the residue of a
            # turn that died before it answered (no API key, interrupt, crash).
            # Replaying it renders an empty bubble, which reads as a bug — drop it.
            if role == "assistant" and not content.strip() and not meta.get("images"):
                continue
            msg = {
                "id": r.get("id"),
                "role": role,
                "content": content,
                "timestamp": (r.get("created_at") or 0) * 1000,
            }
            if meta.get("images"):
                msg["images"] = meta["images"]
            if meta.get("tool_calls") or meta.get("toolCalls"):
                msg["toolCalls"] = meta.get("tool_calls") or meta.get("toolCalls")
            if meta.get("reasoning"):
                msg["reasoning"] = meta.get("reasoning")
            out.append(msg)
        return out

    def _turn_running_sid(self, sid: str) -> bool:
        """Is a turn in flight for SESSION ``sid``, whoever is watching it?

        `turn_state` is the authoritative persistent truth (2.1). In addition,
        in-memory tasks are checked via `_turn_tasks_by_sid` and `_turn_tasks`.
        If the persisted status is non-running (e.g. paused/idle/error/completed),
        it is definitely not live.
        """
        if not sid:
            return False
        # 1. Authority check: turn_state
        status = None
        try:
            from turn_state import TurnStatus, get_turn_state
            ts = get_turn_state()
            status = ts.current(sid)
            if status in (TurnStatus.PAUSED, TurnStatus.COMPLETED, TurnStatus.ERROR, TurnStatus.WAITING_USER, TurnStatus.IDLE):
                return False
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        # 2. Check in-memory live asyncio task executing for this session
        task = self._turn_tasks_by_sid.get(sid)
        if task is not None and not task.done() and not task.cancelled():
            return True
        for w, s in self._session_by_ws.items():
            if s == sid:
                t = self._turn_tasks.get(w)
                if t is not None and not t.done() and not t.cancelled():
                    return True

        # 3. If turn_state was stuck at RUNNING but no active task exists in memory, self-heal to IDLE
        try:
            from turn_state import TurnStatus, get_turn_state
            ts = get_turn_state()
            if status is TurnStatus.RUNNING:
                ts.transition(sid, TurnStatus.IDLE, force=True)
        except Exception:
            pass  # fail-open
        return False



    async def _switch_and_reply(self, ws, sid: str) -> None:
        """Common tail for new/switch: re-point THIS socket at `sid`, then hand
        the frontend the freshly-loaded history so it can repaint the timeline.

        Switching no longer mutates a shared router. It rebinds the socket to
        the session's own Router in the host — which is what lets window A stay
        in its conversation while window B moves to another. `switch_session` is
        still called on the resolved router so a session that was already live
        reloads its goal state and fold bookkeeping.
        """
        bid = self._branch_by_ws.get(id(ws)) or ""
        self._bind_session(ws, sid, bid)

        router = self.host.get_or_create(sid)
        live = self._turn_running_sid(sid)
        if not live:
            result = router.switch_session(sid)
            if not result.ok:
                await self._send_error(ws, result.error)
                return
        elif not router.storage.get_session(sid):
            await self._send_error(ws, f"Unknown session: {sid}")
            return

        messages = self._history_messages(sid)

        if not messages:
            try:
                from token_analytics import get_token_analytics
                sp_tokens = router.compactor.estimate_tokens(router.get_system_prompt())
                tool_tokens = router._tool_def_tokens()
                skill_tokens = router._skill_tokens()
                ctx_window = int(getattr(router.llm, "context_limit", 200000) or 200000)
                get_token_analytics().reset_session(
                    system_prompt_tokens=sp_tokens,
                    tool_def_tokens=tool_tokens,
                    skill_tokens=skill_tokens,
                    context_window=ctx_window,
                )
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        await ws.send_json({
            "type": "session_switched",
            "timestamp": time.time(),
            "sessionId": sid,
            "branchId": bid,
            "payload": {"sessionId": sid, "branchId": bid, "messages": messages, "turnRunning": live},
        })
        await self._broadcast_turn_state(sid)
        await self._send_pending_questions(ws, sid)
        await self._send_session_list(ws)

    async def _handle_session_new(self, ws, payload: dict) -> None:
        result = self._router_for(ws).new_session(payload.get("title", ""))
        if not result.ok:
            await self._send_error(ws, result.error)
            return
        await self._switch_and_reply(ws, result.value)

    async def _handle_session_switch(self, ws, payload: dict) -> None:
        sid = payload.get("sessionId")
        bid = payload.get("branchId") or payload.get("branch_id") or ""
        if not sid:
            await self._send_error(ws, "session_switch needs a sessionId")
            return
        if bid is not None:
            self._branch_by_ws[id(ws)] = str(bid).strip()
        await self._switch_and_reply(ws, sid)

    async def _handle_session_fork(self, ws, payload: dict) -> None:
        """Fork the conversation at a user turn into a new session (UA1).

        The additive counterpart to ``session_truncate``. Truncate answers "I take
        that back"; fork answers "keep that, and let me also try it another way".
        Before this, only the first one existed, so exploring an alternative cost
        you the original — the reasoning, the conclusions, the half-fixed files.

        Payload: ``{userOrdinal, title?, sessionId?}``. ``userOrdinal`` is the same
        handle truncation uses: the Nth user bubble. The fork keeps history up to
        but NOT including that turn, so the new line sits exactly where you were
        before you asked — ready for a different prompt. The original text comes
        back in the reply so the composer can be pre-filled with it.
        """
        router = self._router_for(ws)
        storage = router.storage
        sid = payload.get("sessionId") or router.session_id
        ordinal = payload.get("userOrdinal")
        if not isinstance(ordinal, int) or ordinal < 0:
            await self._send_error(ws, "session_fork needs a non-negative userOrdinal")
            return
        if self._turn_running(ws):
            await self._send_error(ws, "回合还在跑，先停下来再分叉")
            return

        seq = storage.seq_of_nth_user_message(sid, ordinal)
        if seq is None:
            await self._send_error(ws, "找不到那条消息，可能已经被撤回了")
            return

        # Everything strictly BEFORE the forked turn. -1 is legal and means "an
        # empty branch from the very beginning" — `branch()` copies nothing and
        # the new session starts blank, which is the honest result of forking at
        # the first message.
        branch_point = int(seq) - 1
        turns = storage.list_user_turns(sid)
        original = next((t["preview"] for t in turns if t["ordinal"] == ordinal), "")

        new_sid = f"{sid}-fork-{uuid4().hex[:8]}"
        title = (payload.get("title") or "").strip()
        if not title:
            # `branch()` would otherwise name it "Branch of <uuid>", which in a
            # sidebar of conversations reads as a machine artefact. Derive from the
            # parent's own title so the pair is recognisable as a pair.
            try:
                parent_row = storage.get_session(sid) or {}
            except Exception:
                parent_row = {}
            base = str(parent_row.get("title") or "").strip()
            title = f"{base} · 分支" if base else "分支"
        result = storage.branch(sid, branch_point, new_sid, title)
        if not getattr(result, "ok", True):
            await self._send_error(ws, getattr(result, "error", "分叉失败"))
            return

        # The fork inherits the pre-images its copied history refers to, so its own
        # timeline can offer a way back for those turns.
        copied = 0
        try:
            from snapshot_store import get_snapshot_store
            copied = get_snapshot_store().copy_to_session(sid, new_sid, branch_point)
        except Exception as exc:  # noqa: BLE001
            print(f"[fork] snapshot copy skipped: {exc}")

        await ws.send_json({
            "type": "session_forked",
            "timestamp": time.time(),
            "sessionId": new_sid,
            "payload": {
                "sessionId": new_sid,
                "parentId": sid,
                "branchPoint": branch_point,
                "userOrdinal": ordinal,
                # So the composer can offer the prompt again instead of making the
                # user retype what they were about to rephrase.
                "originalText": original,
                "snapshotsCopied": copied,
            },
        })
        # Move this window onto the fork and refresh the sidebar so the new branch
        # is visible rather than being a session nobody can reach.
        await self._switch_and_reply(ws, new_sid)

    async def _handle_session_delete(self, ws, payload: dict) -> None:
        sid = payload.get("sessionId")
        if not sid:
            await self._send_error(ws, "session_delete needs a sessionId")
            return
        router = self._router_for(ws)
        storage = router.storage
        was_active = sid == router.session_id
        storage.delete_session(sid)

        try:
            from persistent_terminal import get_terminal_manager
            get_terminal_manager().close(sid)
        except Exception:
            pass

        if was_active:
            # The active conversation just vanished. Move THIS window to the most
            # recent remaining session, or mint a fresh one on the same Router
            # instance and re-key it in the host (creating a new Router instead
            # would leave two claiming the same conversation).
            remaining = storage.list_sessions(limit=1)
            if remaining:
                self.host.close(sid)
                await self._switch_and_reply(ws, remaining[0]["id"])
                return
            result = router.new_session()
            if not result.ok:
                await self._send_error(ws, result.error)
                return
            self.host.rebind(sid, result.value)
            await self._switch_and_reply(ws, result.value)
            return

        # A background session was deleted: drop its Router so a later
        # get_or_create(sid) can't resurrect one bound to rows that are gone.
        self.host.close(sid)
        await self._broadcast_session_list()
        await self._broadcast_workspace_list()

    async def _handle_session_rename(self, ws, payload: dict) -> None:
        sid = payload.get("sessionId")
        title = (payload.get("title") or "").strip()
        if not sid or not title:
            await self._send_error(ws, "session_rename needs sessionId + title")
            return
        self._router_for(ws).storage.rename_session(sid, title)
        await self._broadcast_session_list()
        await self._broadcast_workspace_list()

    async def _handle_session_pin(self, ws, payload: dict) -> None:
        sid = payload.get("sessionId")
        if not sid:
            await self._send_error(ws, "session_pin needs a sessionId")
            return
        self._router_for(ws).storage.set_session_pinned(sid, bool(payload.get("pinned")))
        await self._broadcast_session_list()
        await self._broadcast_workspace_list()

    async def _handle_session_truncate(self, ws, payload: dict) -> None:
        """Withdraw a user turn server-side.

        The frontend already dropped the bubble locally; without this the server's
        history still holds it and the next turn quietly replays a conversation
        the user believes they erased.

        The shared handle is the USER-TURN ORDINAL: the Nth bubble the user typed
        is the Nth ``role='user'`` row in ``session_messages``. Frontend message
        ids are client-generated and mean nothing here, so the ordinal is what
        crosses the wire.

        ``rollbackFiles`` makes this the atomic undo: chat history and the files
        that turn changed on disk go back together, in one round trip, so the two
        can never end up describing different worlds.
        """
        ordinal = payload.get("userOrdinal")
        rollback_files = bool(payload.get("rollbackFiles"))
        router = self._router_for(ws)
        sid = router.session_id
        storage = router.storage

        if not isinstance(ordinal, int) or ordinal < 0:
            await self._send_error(ws, "session_truncate needs a non-negative integer userOrdinal")
            return

        seq = storage.seq_of_nth_user_message(sid, ordinal)
        if seq is None:
            # Nothing to cut — the client is ahead of the server (e.g. the turn
            # was never persisted). Report it rather than failing loudly; the
            # frontend timeline is already correct either way.
            await self._broadcast({
                "type": "session_truncated",
                "timestamp": time.time(),
                "sessionId": sid,
                "payload": {"ok": True, "deleted": 0, "seq": None, "files": None},
            })
            return

        deleted = storage.truncate_after_seq(sid, seq)

        files = None
        if rollback_files:
            try:
                from snapshot_store import get_snapshot_store
                files = get_snapshot_store().rollback_since(sid, seq)
            except Exception as exc:  # noqa: BLE001
                files = {"errors": [{"path": "*", "error": str(exc)}], "count": 0}
        else:
            # Chat-only withdraw: the snapshots for those turns can never be
            # applied now (their checkpoint is gone from history), so they leave
            # the live timeline. Folded, not deleted (UB1) — the record of what
            # those turns changed is still worth keeping.
            try:
                from snapshot_store import get_snapshot_store
                get_snapshot_store().discard_since(sid, seq)
            except Exception as _e:
                print(f"[http_server] operation FAILED: {_e}")


        # The router caches nothing about history (it re-reads on every turn), so
        # there is no in-memory state to invalidate — but the turn checkpoint must
        # move back or the next snapshot would be tagged past the cut.
        router._turn_seq = seq - 1

        await self._broadcast({
            "type": "session_truncated",
            "timestamp": time.time(),
            "sessionId": sid,
            "payload": {
                "ok": True,
                "seq": seq,
                "deleted": deleted.value if hasattr(deleted, "value") else deleted,
                "files": files,
            },
        })
        await self._broadcast_session_list()
        await self._broadcast_workspace_list()

    async def _send_error(self, ws, message):
        """Send an error frame to one socket.

        `message` may be a plain string (backwards-compatible for the many
        legacy call-sites) or a dict `{"message", "hint", "detail"}` so the
        friendly-error path can carry a next-step hint and a stashed technical
        detail without inventing a second event type. The UI is free to ignore
        the extras and just show `message`.
        """
        if isinstance(message, dict):
            payload = {
                "message": message.get("message") or "出错了",
                "hint": message.get("hint") or "",
                "detail": message.get("detail") or "",
            }
        else:
            payload = {"message": str(message)}
        await ws.send_json({
            "type": "error",
            "timestamp": time.time(),
            "payload": payload,
        })

    async def _deliver(self, client, event: dict) -> None:
        """Send one event to one socket, dropping the socket on failure."""
        try:
            await client.send_json(event)
        except Exception:
            self.clients.discard(client)

    async def _broadcast(self, event: dict):
        """Fan an event out to the sockets it belongs to.

        Session isolation: an event tagged with a `sessionId` is delivered only
        to sockets bound to that session — plus any socket that hasn't announced
        its session yet (a freshly-connected window, which is almost always the
        primary one). Without this filter, window A's tool_call / agent_response
        stream would render inside window B, because a single handler broadcasts
        to every client. Events with no `sessionId` (rare, global notices) still
        reach everyone.
        """
        target_session = (
            event.get("sessionId")
            or event.get("session_id")
            or (event.get("payload") if isinstance(event.get("payload"), dict) else {}).get("sessionId")
            or (event.get("payload") if isinstance(event.get("payload"), dict) else {}).get("session_id")
        )
        target_branch = (
            event.get("branchId")
            or event.get("branch_id")
            or (event.get("payload") if isinstance(event.get("payload"), dict) else {}).get("branchId")
            or (event.get("payload") if isinstance(event.get("payload"), dict) else {}).get("branch_id")
        )
        evt_type = event.get("type")
        is_lifecycle = evt_type in ("session_list", "workspace_list", "goal_state_change")
        is_scoped_evolution = (
            evt_type in ("learning_item_event", "evolution_insight", "evolution_notice", "evolution_proposal", "episode_sealed", "episode_started")
            or str(evt_type or "").startswith("learning_item")
            or str(evt_type or "").startswith("evolution_")
        )
        payload_dict = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        is_global = event.get("scopeType") == "global" or payload_dict.get("scopeType") == "global" or payload_dict.get("scope") == "global"

        for client in list(self.clients):
            cid = id(client)
            bound_session = self._session_by_ws.get(cid)
            bound_branch = (self._branch_by_ws.get(cid) or "").strip()

            if is_scoped_evolution and not is_global:
                # P0-1 & P0-2: Scoped evolution events MUST have an exact match on both session and branch.
                # Unbound sockets (bound_session is None) or mismatched branch sockets are strictly rejected.
                if not bound_session or bound_session != target_session:
                    continue
                tgt_b = (target_branch or "").strip()
                if bound_branch != tgt_b:
                    continue
            else:
                if target_session and not is_lifecycle and not is_global:
                    # Deliver to the matching session only.
                    if bound_session is not None and bound_session != target_session:
                        continue

            await self._deliver(client, event)



def _subagent_child_session(session_id: str) -> Optional[tuple[str, str]]:
    """(parent_session, subagent_id) if this is a sub-agent's child session, else None.

    ``subagent_runtime`` mints child sessions as ``f"{parent}::sub::{sub_id}"``
    (see ``spawn_one``), which makes the parent recoverable from the child id
    without a lookup table and without a runtime import. Cheap enough to call on
    every bus event.
    """
    if not session_id or "::sub::" not in session_id:
        return None
    parent, _, sub = session_id.partition("::sub::")
    if not parent or not sub:
        return None
    return parent, sub


def _tool_reversible(tool_name: Any) -> bool:
    """Reversibility flag for the tool card. Defaults to True on any failure —
    an over-cautious "不可逆" badge on a harmless read is worse noise than a
    missing one, and the rollback dialog surfaces the real list anyway."""
    try:
        from snapshot_store import is_reversible
        return is_reversible(str(tool_name or ""))
    except Exception:
        return True


def _short(value: Any, cap: int = 220) -> str:
    """Compact one-line preview of a value for UI display."""
    if value is None:
        return ""
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            value = str(value)
    if len(value) > cap:
        value = value[:cap] + "…"
    return value.replace("\n", " ")


# ─── REST handlers ──────────────────────────────────────────────

async def handle_health(request):
    """Health + honest system state.

    Deliberately more than a 200: this is where the facts that change how much
    the user can trust the app right now live — whether another backend holds
    the instance lock, whether a schema upgrade rolled back into compat mode,
    and which goals are mid-stop. All best-effort; a diagnostic failure must
    not make health itself fail.
    """
    body = {"status": "ok", "version": "2.0.0"}
    try:
        import instance_lock
        body["instanceLock"] = instance_lock.status()
        if not body["instanceLock"].get("held"):
            body["status"] = "degraded"
    except Exception:
        pass
    try:
        from storage import get_storage
        ms = get_storage().migration_status()
        body["migrations"] = {
            "pending": [p.get("id") for p in ms.get("pending") or []],
            "deferred": ms.get("deferred") or [],
            "recoveryMode": ms.get("recoveryMode") or "",
        }
        if body["migrations"]["recoveryMode"]:
            body["status"] = "degraded"
    except Exception:
        pass
    try:
        from goal_scheduler import get_goal_scheduler, MAX_WORKERS
        sched = get_goal_scheduler()
        body["goals"] = {
            "active": sched.active_count,
            "maxWorkers": int(MAX_WORKERS),
        }
    except Exception:
        pass
    return web.json_response(body)


async def handle_confirm_goal_stopped(request):
    """POST /api/goals/{id}/confirm-stopped — resolve a stop_timeout.

    The only sanctioned exit from ``stop_timeout`` back to paused (and thus to
    claimable). Refuses while the worker task is verifiably still alive.
    """
    from goal_manager import get_goal_manager
    from goal_scheduler import get_goal_scheduler, goal_view
    goal_id = request.match_info.get("id", "")
    storage = get_goal_manager().storage
    if storage.get_goal(goal_id) is None:
        return web.json_response({"error": "Goal not found"}, status=404)
    try:
        result = await get_goal_scheduler().confirm_stopped(goal_id)
    except RuntimeError:
        return web.json_response(
            {"error": "Goal scheduler is not running on this server"}, status=503,
        )
    if not result.ok:
        return web.json_response({"error": result.error}, status=409)
    return web.json_response({"ok": True, "goal": goal_view(storage.get_goal(goal_id))})


async def handle_migrations_status(request):
    """GET /api/system/migrations — schema state, deferrals, recovery mode.

    This is the repair entry the compat banner links to: after a rolled-back
    migration the user sees exactly which step failed, why, and where the
    pre-migration backup lives.
    """
    try:
        from storage import get_storage
        return web.json_response(get_storage().migration_status())
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": str(exc)}, status=500)


async def handle_migrations_retry(request):
    """POST /api/system/migrations/retry — explicitly re-run deferred steps.

    Never automatic: retrying a migration that corrupted this database on
    every boot would turn one bad day into an unbootable app.
    """
    try:
        data = await request.json()
    except Exception:
        data = {}
    mig_id = str((data or {}).get("id") or "")
    try:
        from storage import get_storage
        res = get_storage().retry_deferred_migration(mig_id or "")
        status = 200 if res.get("ok") else 409
        return web.json_response(res, status=status)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_learning_bundles(request):
    """GET /api/evolution/bundles — unified learning bundles, newest first.

    Two producers: one row per finished goal, and one per Dream consolidation
    pass. Each ties together the observation decision (incl. NO_OP's "why
    nothing was learned"), memory proposal ids, skill candidate id and the
    shared experience/turn evidence — the proof that Memory and Skill are two
    projections of one experience rather than two features. Dream rows carry no
    ``goalId`` on purpose: nothing asked for that consolidation, the idle timer
    did. Optional ``?goalId=`` filters to one goal.
    """
    try:
        from evolution import get_evolution_engine
        engine = get_evolution_engine()
        goal_id = request.query.get("goalId", "")
        rows = (engine.store.bundles_for_goal(goal_id)
                if goal_id else engine.store.list_bundles(limit=100))
        return web.json_response({"bundles": rows})
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": str(exc)}, status=500)


async def handle_tool_contracts(request):
    """GET /api/tools/contracts — execution class + cancellation contract.

    This is the honest-stop surface: which tools really die on Stop/Pause
    (killable subprocess / own child / cooperative coroutine) and which are
    thread-abandoned ("只能请求停止，不能保证立即终止"). The goals UI uses it
    to explain why a stop landed in stop_timeout instead of paused.
    """
    try:
        from tools import get_tool_registry
        return web.json_response(
            {"contracts": get_tool_registry().execution_contracts()})
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": str(exc)}, status=500)


# ── Generated images ──

async def handle_get_image(request):
    """Serve a model-generated image from disk by id.

    Deliberate choices:

    * **The workspace comes from the SERVER, not the request.** Taking it from a
      query param would let any caller point the lookup at an arbitrary path.
    * ``web.FileResponse`` instead of reading the file into memory — it uses
      sendfile(), handles Range requests, and never holds the whole image in RAM.
    * ``immutable`` in Cache-Control is safe because an id is a fresh uuid per
      save; the bytes behind a given id never change, so the browser can keep it
      forever and a session reload costs zero re-transfer.
    * ``image_store.resolve`` does the id validation and the symlink-escape check;
      this handler stays dumb on purpose.
    """
    from image_store import resolve as resolve_image, mime_for_path

    router = request.app[ROUTER_KEY]
    image_id = request.match_info.get("image_id", "")
    path = resolve_image(image_id, router.workspace)
    if not path:
        return web.json_response({"error": "image not found"}, status=404)

    return web.FileResponse(
        path,
        headers={
            "Content-Type": mime_for_path(path),
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Disposition": f'inline; filename="{path.name}"',
        },
    )


# ── Local media file serving (Wave E) ───────────────────────────────────────
#
# GET /api/files?path=… — read-only serving of local PDF/media files so the
# chat's inline previews (pdfjs / <img> / <video>) work under the dev http
# origin, where Chromium blocks file:// subresources.
# 本端点鉴权沿用 Ovolve 的 api_auth
# （无 token 401；?token= 查询参数是 api_auth 为 <img>/<video> 既定的呈现方式），
# 白名单根为 workspace 与 ~/.ovolve/cua_shots（cua_actions.feedback_dir 的落盘
# 约定，user_dirs 是用户级路径的唯一真相源）。
# Security posture:
#
# * **Auth is NOT relaxed here.** The route sits under /api/ and is not in
#   api_auth's exempt lists, so the standard token gate applies.
# * **Whitelist, not auth-only.** Only the SERVER-derived roots are readable:
#   the current workspace (agent artifacts) and ~/.ovolve/cua_shots (CUA
#   feedback screenshots). A path that resolves outside them → 403, regardless
#   of a valid token.
# * **Traversal dies twice.** Raw-shape checks (NUL/control chars, surviving
#   percent-escapes = double encoding, UNC, NTFS alternate data streams) run
#   BEFORE resolution, then path_guard.real_path resolves symlinks/junctions
#   and containment is re-checked on the *real* path — shared with the write
#   guard so the two layers cannot disagree about what "inside" means.
# * **Media extensions only.** The extension whitelist doubles as the
#   Content-Type map; .env / .db / id_rsa are structurally unreachable even
#   inside the workspace.
# * **Bounded**: size cap (413) and a per-minute request cap (429) so a
#   looping client cannot turn this into a disk-read amplifier.

# Explicit extension → MIME map. NOT mimetypes.guess_type: on Windows that
# consults the registry, i.e. user-influenced input deciding our headers.
MEDIA_MIME_BY_EXT = {
    "pdf": "application/pdf",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
    "svg": "image/svg+xml", "ico": "image/x-icon", "avif": "image/avif",
    "mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
    "mkv": "video/x-matroska", "avi": "video/x-msvideo", "m4v": "video/x-m4v",
    "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    "m4a": "audio/mp4", "flac": "audio/flac",
}

# Preview ceiling. 4K screen shots and slide-deck PDFs sit far below this; a
# bigger file is not a preview target and FileResponse would just stream it
# forever. Range requests (video seeking) still work under the cap.
MAX_MEDIA_FILE_BYTES = 64 * 1024 * 1024

# Per-minute cap for this endpoint. Generous — one chat page renders at most
# a dozen previews — but it caps a hammering loop.
MEDIA_RATE_PER_MIN = 240

# A percent-escape surviving the single sanctioned decode = double-encoding
# attempt ("..%2F..%2F"); never decoded a second time, always rejected (403).
_PCT_ESCAPE_RE = re.compile(r"%[0-9a-fA-F]{2}")

_file_req_times: "list[float]" = []


def cua_shots_dir() -> str:
    """``~/.ovolve/cua_shots`` — mirrors cua_actions.feedback_dir's layout.

    Kept as a function (not a constant) so tests can point it at a tmp dir by
    monkeypatching; user_dirs is the single source of truth for the home root.
    """
    try:
        from user_dirs import home_dir
        return os.path.join(str(home_dir()), "cua_shots")
    except Exception:
        return ""


def preview_allowed_roots(workspace: str) -> list:
    """The read whitelist, derived from SERVER state only — never the request."""
    roots: list = []
    if workspace:
        roots.append(workspace)
    shots = cua_shots_dir()
    if shots:
        roots.append(shots)
    return roots


def _user_home() -> str:
    """The real user home (~), NOT the ~/.ovolve data root.

    Chat text mentions ``~/.ovolve/cua_shots/x.png`` where ``~`` is the
    POSIX-style user home; expanding it to user_dirs.home_dir() (which IS
    ~/.ovolve) would double the ``.ovolve`` segment. Kept as a function so
    tests can redirect it.
    """
    return os.path.expanduser("~")


def resolve_local_media_path(
        raw: str,
        workspace: str,
        allowed_roots: Optional[list] = None,
) -> tuple:
    """Resolve a request-supplied path against the read whitelist.

    Returns ``(real_path, "")`` on success, or ``(None, reason)`` with reason
    in ``empty`` / ``traversal`` / ``not-media`` / ``not-found`` / ``too-large``.
    Pure string/FS logic — no request object — so tests exercise it directly.
    """
    import path_guard

    if allowed_roots is None:
        allowed_roots = preview_allowed_roots(workspace)

    path = (raw or "").strip()
    if not path:
        return None, "empty"
    if path.startswith("file://"):
        # Frontend may pass a file:/// URL; strip and percent-decode it FIRST
        # so the shape gates below run on the decoded bytes (a %00 must not
        # slip through as text).
        try:
            path = urllib.parse.unquote(path[len("file://"):])
        except Exception:
            return None, "traversal"

    # Raw-shape gates before any FS call. Backslashes normalize to "/" so one
    # rule set covers C:\, C:/ and file:/// forms alike:
    #   · control/NUL bytes (decoded tricks),
    #   · surviving percent-escapes (double-encoding attempts → 403),
    #   · UNC shares and device paths ("//server/share", "//./PhysicalDrive0"),
    #   · NTFS alternate data streams — after the single optional drive colon,
    #     ANY other colon ("shot.png:ads") is rejected, so hidden-stream reads
    #     and extension spoofing die here.
    if any(ord(ch) < 32 for ch in path):
        return None, "traversal"
    if _PCT_ESCAPE_RE.search(path):
        # aiohttp already percent-decoded the query ONCE, and the file://
        # branch above decoded at most once more. An escape surviving here
        # ("..%2Foutside") is a double-encoding attempt: decoding again would
        # be attacker-controlled, so fail closed instead (a literal "%2F"
        # filename is not a preview target anyway).
        return None, "traversal"
    path = path.replace("\\", "/")
    if path.startswith("//"):
        return None, "traversal"
    # /D:/x → D:/x (the file://-strip leaves a leading slash) — BEFORE the
    # colon gate, or the drive colon would read as an ADS colon.
    lead = re.match(r"^/([A-Za-z]:)(/.*)?$", path)
    if lead:
        path = lead.group(1) + (lead.group(2) or "/")
    # After the single optional drive colon, ANY other colon is rejected:
    # NTFS alternate data streams ("shot.png:ads") die here.
    drive = re.match(r"^([A-Za-z]:)(.*)$", path)
    if ":" in (drive.group(2) if drive else path):
        return None, "traversal"
    if drive:
        path = drive.group(1) + drive.group(2)

    if path == "~" or path.startswith("~/"):
        # `~/...` is the cua_shots convention: `~` is the USER HOME, and the
        # whitelist root (~/.ovolve/cua_shots) sits under it.
        rest = path[1:].lstrip("/")
        path = os.path.join(_user_home(), rest) if rest else _user_home()
    elif not os.path.isabs(path) and workspace:
        # Workspace-relative (agent artifact paths) resolve against the
        # workspace, mirroring path_guard._norm — never the process cwd.
        path = os.path.join(workspace, path)

    # Symlink/junction-aware resolution (shared with the write guard), then
    # containment re-checked on the REAL path: a link inside the workspace
    # pointing at C:\Windows resolves out and dies here. is_within normalizes
    # BOTH sides, so a sibling directory sharing a string prefix ("ws2x" vs
    # "ws2x-evil") can never read as contained.
    real = path_guard.real_path(path)
    if not any(path_guard.is_within(real, root) for root in allowed_roots):
        return None, "traversal"

    ext = os.path.splitext(real)[1].lstrip(".").lower()
    if ext not in MEDIA_MIME_BY_EXT:
        return None, "not-media"
    if not os.path.isfile(real):
        return None, "not-found"
    try:
        size = os.path.getsize(real)
    except OSError:
        return None, "not-found"
    if size > MAX_MEDIA_FILE_BYTES:
        return None, "too-large"
    return real, ""


def _media_file_rate_ok() -> bool:
    """Sliding-window per-minute cap. Event-loop single thread → no lock."""
    now = time.time()
    while _file_req_times and now - _file_req_times[0] > 60:
        _file_req_times.pop(0)
    if len(_file_req_times) >= MEDIA_RATE_PER_MIN:
        return False
    _file_req_times.append(now)
    return True


def _reset_media_file_rate() -> None:
    """Test hook: clear the rate window between tests."""
    _file_req_times.clear()


async def handle_get_file(request):
    """Serve a whitelisted local media file for inline preview.

    ``GET /api/files?path=<abs path | ~/... | file:///... | workspace-relative>``
    Read-only by construction (GET via web.get, no POST/PUT route exists), the
    token gate applies like every /api route, and resolve_local_media_path
    carries the whitelist/traversal/extension/size decisions — this handler
    only maps reasons to status codes, following handle_get_image's shape.
    Error bodies never echo the resolved path.
    """
    if not _media_file_rate_ok():
        return web.json_response({"error": "too many file requests"}, status=429)

    router = request.app[ROUTER_KEY]
    workspace = getattr(router, "workspace", "") or ""
    path, err = resolve_local_media_path(request.query.get("path", ""), workspace)
    if err == "empty":
        return web.json_response({"error": "path query parameter required"}, status=400)
    if err == "traversal":
        return web.json_response({"error": "path outside allowed roots"}, status=403)
    if err == "not-media":
        return web.json_response({"error": "file type not previewable"}, status=403)
    if err == "not-found":
        return web.json_response({"error": "file not found"}, status=404)
    if err == "too-large":
        return web.json_response({"error": "file too large to preview"}, status=413)

    ext = os.path.splitext(path)[1].lstrip(".").lower()
    name = os.path.basename(path)
    # ASCII fallback + RFC 5987 form: chat filenames are routinely non-ASCII.
    safe_ascii = "".join(ch if 32 < ord(ch) < 127 and ch not in '"\\' else "_" for ch in name)
    headers = {
        "Content-Type": MEDIA_MIME_BY_EXT[ext],
        "Content-Disposition": (
            f"inline; filename=\"{safe_ascii}\"; "
            f"filename*=UTF-8''{urllib.parse.quote(name)}"
        ),
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
    }
    if ext == "svg":
        # SVG can carry scripts when navigated to directly; <img> embedding
        # ignores document-CSP, so this only sandboxes the navigation case.
        headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return web.FileResponse(path, headers=headers)


# ── Goals ──

async def handle_goals(request):
    from goal_manager import get_goal_manager
    from goal_scheduler import goal_view
    manager = get_goal_manager()
    # Hide cancelled goals: delete is a soft-delete (status=cancelled), so
    # without this filter a "deleted" goal would reappear on the next refresh.
    goals = [
        goal_view(g) for g in manager.list_goals()
        if g.get("status") != "cancelled"
    ]
    return web.json_response({"goals": goals})


async def handle_create_goal(request):
    from goal_manager import get_goal_manager
    from goal_scheduler import goal_view, DEFAULT_MAX_ITERATIONS, DEFAULT_COST_CAP_MICROS
    manager = get_goal_manager()
    storage = manager.storage
    data = await request.json()
    description = (data.get("description") or "").strip()
    if not description:
        return web.json_response({"error": "description required"}, status=400)
    # A caller may hand us a structured brief (D1); when absent the manager
    # derives one from the description so no goal exists without a contract.
    goal = manager.create_goal(description, brief=data.get("brief"))

    # Seed the execution budget. Callers may tighten but not exceed the default
    # cap, so a crafted request cannot authorize unlimited spend.
    #
    # Only override what the client actually sent: create_goal already applied
    # the category-derived ceiling, and unconditionally writing the global
    # default here would flatten that back out — a 3-iteration planning goal
    # would silently get the 10-iteration budget of a coding goal.
    updates: dict = {}
    if data.get("maxIterations") is not None:
        try:
            max_iter = int(data.get("maxIterations"))
        except (TypeError, ValueError):
            max_iter = DEFAULT_MAX_ITERATIONS
        updates["max_iterations"] = max(1, min(max_iter, 50))
    if data.get("costCapUsd") is not None:
        try:
            cap_usd = float(data.get("costCapUsd") or 0)
        except (TypeError, ValueError):
            cap_usd = 0
        cap_micros = int(cap_usd * 1_000_000) if cap_usd > 0 else DEFAULT_COST_CAP_MICROS
        updates["cost_cap_micros"] = max(1, min(cap_micros, DEFAULT_COST_CAP_MICROS))
    if updates:
        storage.update_goal_fields(goal.id, **updates)

    row = storage.get_goal(goal.id)
    return web.json_response(goal_view(row))


async def handle_update_goal(request):
    """PATCH /api/goals/{id} — status transitions and budget edits.

    Status is validated against an allowlist rather than written through, so a
    client cannot park a goal in an invented state the scheduler will never
    reap. Pausing a goal that is actually mid-run is routed to the scheduler so
    the worker task is cancelled instead of only the DB row changing.
    """
    from goal_manager import get_goal_manager, GoalStatus
    from goal_scheduler import goal_view, get_goal_scheduler, RUNNING, QUEUED
    manager = get_goal_manager()
    storage = manager.storage
    goal_id = request.match_info.get("id", "")
    row = storage.get_goal(goal_id)
    if row is None:
        return web.json_response({"error": "Goal not found"}, status=404)

    data = await request.json()
    updates: dict = {}

    if "status" in data:
        status = str(data.get("status") or "")
        allowed = {
            GoalStatus.ACTIVE, GoalStatus.STARTED, GoalStatus.PAUSED,
            GoalStatus.COMPLETED, GoalStatus.CANCELLED,
        }
        if status not in allowed:
            return web.json_response(
                {"error": f"Invalid status: {status}", "allowed": sorted(allowed)},
                status=400,
            )
        if status == GoalStatus.PAUSED and row.get("status") in (RUNNING, QUEUED):
            try:
                pr = await get_goal_scheduler().pause(goal_id)
                if not pr.ok:
                    # The worker did not actually stop. Say so instead of
                    # returning a row that reads "paused".
                    return web.json_response({"error": pr.error}, status=409)
            except RuntimeError:
                storage.update_goal_fields(goal_id, status=GoalStatus.PAUSED)
        else:
            updates["status"] = status
            if status == GoalStatus.COMPLETED:
                # A human overriding to "done" clears the stale failure text so
                # the card doesn't show a completed goal with an error on it.
                updates["last_error"] = ""

    if "maxIterations" in data:
        try:
            updates["max_iterations"] = max(1, min(int(data["maxIterations"]), 50))
        except (TypeError, ValueError):
            pass  # fail-open: 可选增强，失败不影响主流程

    if "brief" in data and data["brief"] is not None:
        # Route through the manager so the brief is validated (summary +
        # deliverable required) and the derived category is refreshed.
        # Writing brief_json blind here would let a client bypass validation
        # and leave the row with an unverifiable contract.
        r = manager.set_brief(goal_id, data["brief"])
        if not r.ok:
            return web.json_response({"error": r.error}, status=400)

    if updates:
        storage.update_goal_fields(goal_id, **updates)
        # 人手改成终态也是终态。学习记录（LearningBundle）只挂在
        # goal_state_change 上，这里不发事件，"取消掉的目标"就永远不会在演化
        # 账目里留下一行——而"这次为什么没学到东西"恰恰是审计要回答的问题。
        # 重复 PATCH 不会多出 bundle：幂等键在 storage 层拦着。
        _new_status = str(updates.get("status") or "")
        if _new_status in (GoalStatus.CANCELLED, GoalStatus.COMPLETED):
            try:
                from event_bus import get_event_bus
                await get_event_bus().emit("goal_state_change", {
                    "goal_id": goal_id, "status": _new_status,
                    "session_id": row.get("session_id", ""),
                    "source": "user_update",
                })
            except Exception as exc:  # noqa: BLE001 — 广播失败不影响这次修改
                print(f"[api] goal_state_change emit failed: {exc}")
    return web.json_response(goal_view(storage.get_goal(goal_id)))



async def handle_delete_goal(request):
    """DELETE /api/goals/{id} — soft-delete, cancelling any in-flight run."""
    from goal_manager import get_goal_manager
    from goal_scheduler import get_goal_scheduler, RUNNING, QUEUED
    manager = get_goal_manager()
    goal_id = request.match_info.get("id", "")
    row = manager.storage.get_goal(goal_id)
    if row is None:
        return web.json_response({"error": "Goal not found"}, status=404)
    if row.get("status") in (RUNNING, QUEUED):
        try:
            await get_goal_scheduler().pause(goal_id)
        except RuntimeError:
            pass  # fail-open: 可选增强，失败不影响主流程
    result = manager.delete_goal(goal_id)
    if not result.ok:
        return web.json_response({"error": result.error}, status=400)
    return web.json_response({"ok": True, "id": goal_id})


async def handle_run_goal(request):
    """POST /api/goals/{id}/run — hand the goal to the scheduler."""
    from goal_scheduler import get_goal_scheduler, goal_view
    from goal_manager import get_goal_manager
    goal_id = request.match_info.get("id", "")
    storage = get_goal_manager().storage
    if storage.get_goal(goal_id) is None:
        return web.json_response({"error": "Goal not found"}, status=404)
    try:
        scheduler = get_goal_scheduler()
    except RuntimeError:
        return web.json_response(
            {"error": "Goal scheduler is not running on this server"}, status=503,
        )
    result = scheduler.enqueue(goal_id)
    if not result.ok:
        return web.json_response({"error": result.error}, status=409)
    return web.json_response({
        "ok": True,
        "queue": result.value,
        "goal": goal_view(storage.get_goal(goal_id)),
    })


async def handle_pause_goal(request):
    """POST /api/goals/{id}/pause — cancel the worker, keep progress.

    A 409 here now carries the goal's actual status: ``stop_timeout`` means
    the stop could not be confirmed and resume stays blocked until the client
    calls ``/confirm-stopped``. The body used to be just an error string while
    the row silently said ``paused`` — two sources of truth disagreeing.
    """
    from goal_scheduler import get_goal_scheduler, goal_view
    from goal_manager import get_goal_manager
    goal_id = request.match_info.get("id", "")
    storage = get_goal_manager().storage
    if storage.get_goal(goal_id) is None:
        return web.json_response({"error": "Goal not found"}, status=404)
    try:
        result = await get_goal_scheduler().pause(goal_id)
    except RuntimeError:
        return web.json_response(
            {"error": "Goal scheduler is not running on this server"}, status=503,
        )
    if not result.ok:
        return web.json_response({
            "error": result.error,
            "status": (storage.get_goal(goal_id) or {}).get("status"),
        }, status=409)
    return web.json_response({"ok": True, "goal": goal_view(storage.get_goal(goal_id))})


async def handle_goal_iterations(request):
    """GET /api/goals/{id}/iterations — per-round history of one goal run.

    The goals row carries only a counter, which cannot answer "what did round 4
    do" or "why did the verifier reject it" — least of all after a restart, when
    the worker's in-memory state is gone. Without a read path the detail rows
    would be write-only, so this endpoint exists alongside the table.
    """
    from goal_manager import get_goal_manager
    goal_id = request.match_info.get("id", "")
    storage = get_goal_manager().storage
    if storage.get_goal(goal_id) is None:
        return web.json_response({"error": "Goal not found"}, status=404)
    rows = storage.list_goal_iterations(goal_id)
    return web.json_response({"iterations": [
        {
            "ordinal": r.get("ordinal") or 0,
            "startedAt": r.get("started_at") or 0,
            "endedAt": r.get("ended_at") or 0,
            "verdict": r.get("verdict") or "",
            "reason": r.get("verdict_reason") or "",
            "evidence": r.get("evidence_digest") or "",
            "costMicros": r.get("cost_micros") or 0,
            "tokens": r.get("tokens") or 0,
        }
        for r in rows
    ]})


async def handle_goal_events(request):
    """GET /api/goals/{id}/events — the trace ledger filtered to one goal.

    A goal outlives the session it started in: pause, restart and resume each
    open a new one. ``/api/events/{sessionId}`` therefore cannot answer "what
    did this goal actually do" — it answers "what happened in this window".
    This reads the same rows by the ``goal_id`` correlation column instead.

    Carries ``verifiable: false`` on purpose. The hash chain runs per session
    from that session's genesis; any cross-session subset is missing links by
    construction, so labelling it verified would be a lie the UI would repeat.
    """
    from goal_manager import get_goal_manager
    goal_id = request.match_info.get("id", "")
    storage = get_goal_manager().storage
    if storage.get_goal(goal_id) is None:
        return web.json_response({"error": "Goal not found"}, status=404)
    limit_str = request.query.get("limit")
    limit = int(limit_str) if limit_str is not None else 500
    try:
        events = storage.get_event_store().read_by_dimension("goal_id", goal_id, limit=limit)
    except Exception as exc:
        return web.json_response({"error": f"event query failed: {exc}"}, status=500)
    return web.json_response({
        "goalId": goal_id,
        "verifiable": False,
        "events": [e.to_dict() for e in events],
    })


async def handle_goal_contract(request):
    """GET /api/goals/{id}/contract — live acceptance contract and machine gate plan."""
    from storage import get_storage
    from acceptance_contract import get_goal_contract
    gid = request.match_info.get("id", "")
    st = get_storage()
    contract = get_goal_contract(st, gid)
    return web.json_response({"goalId": gid, "contract": contract})


async def handle_reflections(request):
    """GET /api/reflections — query recent Reflexion episodic memories."""
    from reflection_engine import get_reflection_store
    store = get_reflection_store()
    query = request.rel_url.query.get("q", "")
    limit = int(request.rel_url.query.get("limit", "20") or 20)
    refs = store.retrieve_reflections(query=query, limit=limit)
    return web.json_response({"reflections": [r.to_dict() for r in refs]})


async def handle_curriculum_gaps(request):
    """GET /api/curriculum/gaps — identify discovered skill capability gaps."""
    from curriculum_engine import CurriculumEngine
    from storage import get_storage
    engine = CurriculumEngine(get_storage())
    gaps = engine.identify_skill_gaps()
    return web.json_response({"gaps": [g.to_dict() for g in gaps]})


async def handle_skill_patterns(request):
    """GET /api/skills/patterns — mine frequent sequential tool chains."""
    from skill_composition import SkillComposer
    from storage import get_storage
    composer = SkillComposer(get_storage())
    patterns = composer.mine_patterns()
    return web.json_response({"patterns": [p.to_dict() for p in patterns]})


def _resolve_request_workspace(request) -> str:
    try:
        router = request.app.get(ROUTER_KEY)
        if router and getattr(router, "workspace", None):
            return router.workspace
    except Exception:
        pass
    return os.environ.get("OVOLVE_WORKSPACE") or os.getcwd()


async def handle_evolution_undo(request):
    """POST /api/evolution/undo — Revert an accepted proposal change from pre-modification backup."""
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    proposal_id = str(body.get("proposal_id") or "").strip()
    from evolution_undo import undo
    ws = _resolve_request_workspace(request)

    res = undo(workspace_root=ws, proposal_id=proposal_id or None)
    if not res.ok:
        return web.json_response({"ok": False, "error": res.error}, status=400)
    return web.json_response({"ok": True, "data": res.value})


async def handle_evolution_undo_list(request):
    """GET /api/evolution/undo — List available evolution snapshots for rollback."""
    from evolution_undo import list_undo
    ws = _resolve_request_workspace(request)

    entries = list_undo(ws)
    return web.json_response({"ok": True, "snapshots": entries})


# ── Cron ──

async def handle_crons(request):
    from cron_manager import get_cron_manager
    manager = get_cron_manager()
    crons = manager.list_crons()
    return web.json_response({"crons": crons})


async def handle_create_cron(request):
    from cron_manager import get_cron_manager
    manager = get_cron_manager()
    data = await request.json()
    expression = data.get("expression", "")
    task_name = data.get("taskName", data.get("task_name", ""))
    task_data = data.get("taskData", data.get("task_data", {}))
    if not expression and data.get("delayMinutes") is None:
        return web.json_response({"error": "expression and taskName required"}, status=400)
    if not task_name:
        return web.json_response({"error": "expression and taskName required"}, status=400)
    # 带 prompt（或 sessionId/delay）的请求是"到期跑一个回合"的定时自动化：
    # prompt 是回合输入，sessionId 决定回合落在哪个会话（权限档位随会话
    # 继承，或被 permissions.scheduled.permission 固定）。没有这些字段的
    # 请求保持 legacy 行为不变。
    prompt = data.get("prompt")
    session_id = data.get("sessionId", data.get("session_id"))
    delay_minutes = data.get("delayMinutes", data.get("delay_minutes"))
    max_runs = data.get("maxRuns", data.get("max_runs"))
    if prompt or session_id or delay_minutes is not None:
        r = manager.create(
            task_name, prompt,
            cron_expr=expression or None,
            delay_minutes=delay_minutes,
            max_runs=max_runs,
            task_name=task_name,
            task_data=task_data,
            session_id=session_id,
        )
        if not r.ok:
            return web.json_response({"error": r.error}, status=400)
        return web.json_response(r.value)
    job = manager.create_cron(expression, task_name, task_data)
    return web.json_response(job.to_dict())


async def handle_update_cron(request):
    from cron_manager import get_cron_manager
    manager = get_cron_manager()
    cron_id = request.match_info.get("id", "")
    data = await request.json()
    status = data.get("status", "")
    if status == "paused":
        manager.pause_cron(cron_id)
    elif status == "active":
        manager.resume_cron(cron_id)
    elif status == "stopped":
        manager.stop_cron(cron_id)
    else:
        return web.json_response({"error": "Invalid status"}, status=400)
    return web.json_response({"id": cron_id, "status": status})


async def handle_delete_cron(request):
    from cron_manager import get_cron_manager
    manager = get_cron_manager()
    cron_id = request.match_info.get("id", "")
    manager.delete_cron(cron_id)
    return web.json_response({"deleted": cron_id})


# ── Bot ──

async def handle_bot_messages(request):
    from bot_remote import get_bot_remote
    bot = get_bot_remote()
    platform = request.query.get("platform", "telegram")
    user_id = request.query.get("user_id", "default")
    messages = bot.get_recent_messages(platform, user_id)
    return web.json_response({"messages": messages})


async def handle_bot_send(request):
    from bot_remote import get_bot_controller
    ctrl = get_bot_controller()
    data = await request.json()
    platform = data.get("platform", "telegram")
    user_id = data.get("userId", data.get("user_id", "default"))
    content = data.get("content", "")
    if not content:
        return web.json_response({"error": "content required"}, status=400)
    result = await ctrl.send_message(platform, user_id, content)
    if result.ok:
        return web.json_response({"success": True, "message": result.value})
    return web.json_response({"error": result.error}, status=500)


async def handle_bot_config_get(request):
    """GET /api/bot/config/{platform} — current config (tokens masked)."""
    from bot_remote import get_bot_controller
    from storage import get_storage
    platform = request.match_info["platform"]
    storage = get_storage()
    state = storage.get_bot_state(f"{platform}:config", {}) or {}
    # Never ship raw secrets to the browser — mask all but last 4 chars.
    # `webhook` is on the list because a DingTalk robot URL carries its
    # access_token in the query string: the URL *is* the credential.
    secret_keys = {
        "bot_token", "app_token", "app_secret", "client_secret", "secret",
        "encrypt_key", "encoding_aes_key", "callback_token", "webhook_key",
        "webhook", "verification_token",
    }
    safe = {}
    for k, v in state.items():
        if k in secret_keys and isinstance(v, str) and len(v) > 4:
            safe[k] = "•" * (len(v) - 4) + v[-4:]
        else:
            safe[k] = v
    ctrl = get_bot_controller()
    status = ctrl.provider_status()
    plat_status = next((s for s in status if s["platform"] == platform), None)
    return web.json_response({"platform": platform, "config": safe, "status": plat_status})


async def handle_bot_config_put(request):
    """PUT /api/bot/config/{platform} — save config (token/secret/allowed_users)."""
    from bot_remote import get_bot_controller
    from storage import get_storage
    platform = request.match_info["platform"]
    data = await request.json()
    storage = get_storage()
    # Merge with existing state so partial updates don't clobber other fields.
    existing = storage.get_bot_state(f"{platform}:config", {}) or {}
    for k, v in data.items():
        # Masked values sent back unchanged should not overwrite the real secret.
        if isinstance(v, str) and v.startswith("•"):
            continue
        existing[k] = v
    storage.save_bot_state(f"{platform}:config", existing)
    return web.json_response({"ok": True, "platform": platform})


async def handle_bot_status(request):
    """GET /api/bot/status — per-platform status overview."""
    from bot_remote import get_bot_controller
    ctrl = get_bot_controller()
    return web.json_response({"platforms": ctrl.provider_status()})


async def handle_feishu_webhook(request):
    """POST /api/bot/webhook/feishu — Feishu event subscription endpoint."""
    from bot_remote import get_bot_controller
    ctrl = get_bot_controller()
    provider = ctrl.get_provider("feishu")
    if provider is None:
        return web.json_response({"code": 503, "msg": "feishu provider not registered"}, status=503)
    body = await request.read()
    # The provider's signature check reads lowercase keys (x-lark-signature
    # etc). aiohttp preserves the wire casing, so normalize here or every
    # event would fail verification with a 403.
    headers = {k.lower(): v for k, v in request.headers.items()}
    try:
        result = await provider.handle_webhook(body, headers)
    except Exception as exc:
        return web.json_response({"code": 500, "msg": str(exc)}, status=500)
    return web.json_response(result)


async def handle_dingtalk_webhook(request):
    """POST /api/bot/webhook/dingtalk — DingTalk outgoing-robot callback."""
    from bot_remote import get_bot_controller
    provider = get_bot_controller().get_provider("dingtalk")
    if provider is None:
        return web.json_response(
            {"errcode": 503, "errmsg": "dingtalk provider not registered"}, status=503)
    body = await request.read()
    # DingTalk sends `timestamp` / `sign`; aiohttp keeps the wire casing while
    # the provider looks them up lowercased.
    headers = {k.lower(): v for k, v in request.headers.items()}
    try:
        result = await provider.handle_webhook(body, headers)
    except Exception as exc:
        return web.json_response({"errcode": 500, "errmsg": str(exc)}, status=500)
    return web.json_response(result)


async def handle_wecom_webhook(request):
    """GET/POST /api/bot/webhook/wecom — WeCom encrypted callback.

    GET is the one-time URL handshake: WeCom expects the decrypted ``echostr``
    echoed back as bare text, so this route answers text/plain rather than JSON.
    POST carries events; an empty 200 is WeCom's "delivered" and the real reply
    is pushed separately, because an agent turn blows past the 5s callback
    budget and WeCom would retry the same message.
    """
    from bot_remote import get_bot_controller
    provider = get_bot_controller().get_provider("wecom")
    if provider is None:
        return web.Response(status=503, text="wecom provider not registered")
    query = dict(request.query)

    if request.method == "GET":
        echo = provider.verify_url(query)
        if not echo:
            return web.Response(status=403, text="verification failed")
        return web.Response(text=echo, content_type="text/plain")

    body = await request.read()
    try:
        reply = await provider.handle_webhook(body, query)
    except Exception as exc:
        return web.Response(status=500, text=str(exc))
    return web.Response(text=reply or "", content_type="text/plain")

async def handle_skills(request):
    from skill_loader import get_skill_loader
    loader = get_skill_loader()
    loader.discover()
    skills = loader.list_skills(include_disabled=True)
    return web.json_response({"skills": skills})


async def handle_skill_experiences(request):
    """Learning-loop visibility: which skills were actually used and how each
    real use went (outcome, selection reason, latency). Reads straight from
    the experience ledger — storage migration 0003."""
    from storage import get_storage
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 200))
    except (ValueError, TypeError):
        limit = 50
    skill_id = request.query.get("skill_id") or None
    goal_id = request.query.get("goal_id") or None
    rows = get_storage().list_skill_experiences(
        skill_id=skill_id, goal_id=goal_id, limit=limit,
    )
    return web.json_response({"experiences": rows})

async def handle_relations(request):
    """Memory–Skill 关系图查询（Step D）：一个节点的出边和入边。

    ?node_type=memory|skill|goal|run &node_id=<id> [&relation=SUPPORTS|...]
    返回 outgoing / incoming 两组边，stale=1 的边表示"依赖的事实变了，
    该技能需要重新验证"。
    """
    from storage import get_storage
    node_type = request.query.get("node_type") or ""
    node_id = request.query.get("node_id") or ""
    relation = request.query.get("relation") or None
    if not node_type or not node_id:
        return web.json_response(
            {"error": "node_type and node_id are required"}, status=400)
    st = get_storage()
    try:
        outgoing = st.relations_from(node_type, node_id, relation)
        incoming = st.relations_to(node_type, node_id, relation)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({
        "node": {"type": node_type, "id": node_id},
        "outgoing": outgoing,
        "incoming": incoming,
        "staleCount": sum(1 for e in (outgoing + incoming) if e.get("stale")),
    })

async def handle_approvals_pending(request):
    """Approvals 统一投影：全局待人工处理事项一览。

    聚合 staged 状态的技能候选（学习环等待批准）+ pending 演化提案（记忆/指导文件待批准）。
    ask_user 问题卡属于 Chat 流运行时，不在此聚合。"""
    from approvals_projection import pending_approvals
    from storage import get_storage
    try:
        return web.json_response(pending_approvals(get_storage()))
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("GET /api/approvals/pending failed")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_session_learning(request):
    """GET /api/sessions/{id}/learning — Session & branch aware learning projection."""
    session_id = request.match_info.get("id") or request.query.get("sessionId") or ""
    branch_id = request.query.get("branchId", "")
    if not session_id:
        return web.json_response({"error": "sessionId is required"}, status=400)
    try:
        from storage import get_storage
        st = get_storage()
        episodes = st.list_episodes(session_id=session_id, branch_id=branch_id, limit=50)
        items = st.list_learning_items(session_id=session_id, branch_id=branch_id, limit=100)
        active_ep = st.get_active_episode(session_id=session_id, branch_id=branch_id)

        counts = {
            "total": len(items),
            "actionable": len([i for i in items if i.get("status") in ("proposed", "staged") or i.get("user_verdict") == "pending"]),
            "published": len([i for i in items if i.get("status") == "published" or i.get("user_verdict") == "approved"]),
            "deferred": len([i for i in items if i.get("status") == "deferred" or i.get("user_verdict") == "deferred"]),
            "failed": len([i for i in items if i.get("status") in ("failed", "unknown")]),
        }

        cross_session = []
        try:
            from memory_domain import MemoryDomain
            md = MemoryDomain(st)
            ws = getattr(st, "workspace_root", "") or os.getcwd()
            mem_items, _ = md.list_items(ws, statuses=["active"], limit=20)
            # Only include memories that have valid scope (user, workspace, project) and originated outside this session
            for m in mem_items:
                if str(getattr(m, "source", "") or "") != session_id:
                    cross_session.append({
                        "id": m.id,
                        "kind": "memory",
                        "content": m.content,
                        "scope": getattr(m, "scope", "workspace") or "workspace",
                        "source": str(getattr(m, "source", "") or "cross_session"),
                        "why": "Published active memory matching current workspace",
                    })

            # Also fetch active skills
            try:
                from skill_loader import get_skill_loader
                loader = get_skill_loader()
                for sk in loader.list_skills():
                    if getattr(sk, "status", "") == "active" and getattr(sk, "name", ""):
                        cross_session.append({
                            "id": f"skill-{sk.name}",
                            "kind": "skill",
                            "name": sk.name,
                            "content": getattr(sk, "description", "") or getattr(sk, "purpose", "") or sk.name,
                            "scope": "workspace",
                            "source": "skill_library",
                            "why": "Active verified skill available in runtime",
                        })
            except Exception:
                pass
        except Exception:
            pass

        return web.json_response({
            "sessionId": session_id,
            "branchId": branch_id,
            "episodes": episodes,
            "learningItems": items,
            "activeEpisode": active_ep,
            "counts": counts,
            "crossSessionReused": cross_session,
        })
    except Exception as exc:
        logging.getLogger(__name__).exception("GET /api/sessions/{id}/learning failed")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_learning_item_action(request):
    """POST /api/learning-items/{id}/{action} — Canonical mutation saga via LearningItemService (BUG-4, BUG-5)."""
    item_id = request.match_info.get("id") or ""
    action = request.match_info.get("action") or ""
    if not (item_id and action):
        return web.json_response({"ok": False, "status": "invalid_request", "error": "id and action required"}, status=400)
    try:
        data = await request.json()
    except Exception:
        data = {}

    try:
        from storage import get_storage
        from learning_service import get_learning_service
        st = get_storage()
        svc = get_learning_service(st)

        # 1. Preflight load item & fail-closed scope check
        item = st.get_learning_item(item_id)
        if not item:
            return web.json_response({"ok": False, "status": "not_found", "error": "Learning item not found"}, status=404)

        session_id = str(data.get("sessionId") or request.query.get("sessionId") or "").strip()
        branch_id = str(data.get("branchId") or request.query.get("branchId") or "").strip()
        edited_content = data.get("content")
        reason = str(data.get("reason") or "")
        expected_version = data.get("version")
        idempotency_key = str(data.get("idempotencyKey") or data.get("idempotency_key") or "").strip()

        # 2. Strict mutation idempotency key required (BUG-5)
        if not idempotency_key:
            return web.json_response({
                "ok": False,
                "status": "idempotency_required",
                "error": "idempotencyKey is required for mutation actions",
            }, status=400)

        # 3. Scope validation for non-global items (P1-1 fail-closed)
        item_scope = str(item.get("scope") or "workspace")
        item_sid = str(item.get("session_id") or item.get("source_session_id") or "").strip()
        item_bid = str(item.get("branch_id") or "").strip()

        if item_scope != "global":
            if not item_sid:
                return web.json_response({
                    "ok": False,
                    "status": "scope_mismatch",
                    "error": "Non-global learning item missing canonical session scope",
                }, status=409)
            if not session_id:
                return web.json_response({
                    "ok": False,
                    "status": "scope_required",
                    "error": "sessionId is required for non-global learning item",
                }, status=400)
            if session_id != item_sid:
                return web.json_response({
                    "ok": False,
                    "status": "scope_mismatch",
                    "error": f"sessionId mismatch: expected '{item_sid}', got '{session_id}'",
                }, status=409)
            if branch_id != item_bid:
                return web.json_response({
                    "ok": False,
                    "status": "scope_mismatch",
                    "error": f"branchId mismatch: expected '{item_bid}', got '{branch_id}'",
                }, status=409)

        res = svc.decide(
            item_id=item_id,
            action=action,
            session_id=session_id,
            branch_id=branch_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            edited_content=edited_content,
            reason=reason,
        )

        status_code = 200
        if not res.get("ok"):
            st_val = res.get("status")
            if st_val in ("scope_mismatch", "version_conflict", "idempotency_conflict"):
                status_code = 409
            elif st_val == "not_found":
                status_code = 404
            elif st_val in ("scope_required", "idempotency_required", "invalid_request", "invalid_content"):
                status_code = 400
            else:
                status_code = 400

        return web.json_response(res, status=status_code)
    except Exception as exc:
        logging.getLogger(__name__).exception("POST /api/learning-items/{id}/{action} failed")
        return web.json_response({"ok": False, "status": "server_error", "error": str(exc)}, status=500)


async def handle_learning_item_trace(request):
    """GET /api/learning-items/{id}/trace — Query sanitized trace events for a specific learning item (BUG-4, P1-1)."""
    item_id = request.match_info.get("id") or ""
    session_id = request.query.get("sessionId", "").strip()
    branch_id = request.query.get("branchId", "").strip()
    try:
        from storage import get_storage
        from scope_guard import validate_scope
        st = get_storage()
        item = st.get_learning_item(item_id)
        if not item:
            return web.json_response({"error": "Item not found"}, status=404)

        item_scope = str(item.get("scope") or "workspace")
        sid = str(item.get("session_id") or item.get("source_session_id") or "").strip()
        bid = str(item.get("branch_id") or "").strip()

        # Scope validation for non-global items (P1-1 fail-closed)
        if item_scope != "global":
            if not sid:
                return web.json_response({"error": "Non-global learning item missing canonical session scope"}, status=409)
            if not session_id:
                return web.json_response({"error": "sessionId is required for non-global learning item trace"}, status=400)
            if session_id != sid:
                return web.json_response({"error": f"sessionId mismatch: expected '{sid}', got '{session_id}'"}, status=409)
            if branch_id != bid:
                return web.json_response({"error": f"branchId mismatch: expected '{bid}', got '{branch_id}'"}, status=409)

        # Strict Session Isolation for trace streams (P1-1 & P1-4)
        target_stream_sid = ""
        if item_scope == "global":
            # For global items, never read another session's private EventStore stream!
            # Only read source session stream if caller is currently in that source session.
            if session_id and session_id == sid:
                target_stream_sid = sid
            elif session_id:
                target_stream_sid = session_id  # Read caller's own session stream for local references
            else:
                target_stream_sid = ""
        else:
            target_stream_sid = sid

        es = st.get_event_store()
        events = []
        if target_stream_sid:
            src_ids = set(str(x) for x in item.get("source_event_ids", []))
            target_turn_id = str(item.get("source_turn_id") or "")
            for ev in es.read_stream(target_stream_sid):
                d = ev.to_dict()
                ev_id = str(getattr(ev, "event_id", "") or d.get("event_id") or "")
                ev_idem = str(d.get("idempotency_key") or "")
                ev_turn = str(getattr(ev, "turn_id", "") or d.get("turn_id") or "")
                p = d.get("payload") or {}

                matched = (
                    (ev_id and ev_id in src_ids)
                    or (ev_idem and ev_idem in src_ids)
                    or (target_turn_id and ev_turn == target_turn_id)
                    or (str(p.get("learning_item_id") or p.get("itemId") or "") == item_id)
                )
                if matched:
                    # Sanitize payload: strip cookies, tokens, and overly long text
                    sanitized_payload = {}
                    for k, v in p.items():
                        if any(s in k.lower() for s in ("token", "cookie", "secret", "password", "key", "auth")):
                            sanitized_payload[k] = "[REDACTED]"
                        elif isinstance(v, str) and len(v) > 500:
                            sanitized_payload[k] = v[:500] + "..."
                        else:
                            sanitized_payload[k] = v

                    events.append({
                        "seq": d.get("seq", 0),
                        "eventId": ev_id,
                        "eventType": d.get("event_type", ""),
                        "timestamp": d.get("timestamp", 0),
                        "sessionId": d.get("session_id", ""),
                        "branchId": d.get("branch_id", ""),
                        "turnId": ev_turn,
                        "summary": str(p.get("why") or p.get("content") or p.get("title") or d.get("event_type", "")),
                        "payload": sanitized_payload,
                    })
        return web.json_response({"itemId": item_id, "events": events})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)



async def handle_episodes_list(request):
    """GET /api/episodes — List conversation episodes."""
    session_id = request.query.get("sessionId", "")
    branch_id = request.query.get("branchId", "")
    limit = max(1, min(int(request.query.get("limit", "50")), 100))
    try:
        from storage import get_storage
        st = get_storage()
        return web.json_response({"episodes": st.list_episodes(session_id=session_id, branch_id=branch_id, limit=limit)})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def handle_episode_seal(request):
    """POST /api/episodes/seal — Seal an active episode with strict scope validation."""
    try:
        data = await request.json()
    except Exception:
        data = {}
    episode_id = str(data.get("episodeId") or data.get("id") or "")
    reason = str(data.get("reason") or "user_request")
    session_id = str(data.get("sessionId") or "")
    branch_id = str(data.get("branchId") or "")
    if not episode_id:
        return web.json_response({"error": "episodeId is required"}, status=400)
    try:
        from storage import get_storage
        from scope_guard import validate_scope
        st = get_storage()
        ep = st.get_episode(episode_id)
        if not ep:
            return web.json_response({"error": "Episode not found"}, status=404)

        if session_id:
            is_valid, err = validate_scope(
                expected_session=session_id,
                expected_branch=branch_id,
                actual_session=str(ep.get("session_id") or ""),
                actual_branch=str(ep.get("branch_id") or ""),
            )
            if not is_valid:
                return web.json_response({"error": f"Scope mismatch: {err}"}, status=409)

        from episode_manager import get_episode_manager
        em = get_episode_manager(st)
        ok = em.seal_episode_once(episode_id, reason=reason)
        return web.json_response({"ok": ok})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)



async def handle_history_trace(request):
    """GET /api/history/trace — Query canonical trace events."""
    session_id = request.query.get("sessionId", "")
    goal_id = request.query.get("goalId", "")
    run_id = request.query.get("runId", "")
    turn_id = request.query.get("turnId", "")
    limit = max(1, min(int(request.query.get("limit", "100")), 500))
    try:
        from storage import get_storage
        es = get_storage().get_event_store()
        events = []
        if session_id:
            events = [e.to_dict() for e in es.read_stream(session_id)]
        else:
            rows = es._db.execute(
                "SELECT * FROM events ORDER BY seq DESC LIMIT ?", (limit,)
            ).fetchall()
            from event_types import AgentEvent
            events = [AgentEvent.from_row(r).to_dict() for r in rows]

        if goal_id:
            events = [e for e in events if e.get("goal_id") == goal_id]
        if run_id:
            events = [e for e in events if e.get("run_id") == run_id]
        if turn_id:
            events = [e for e in events if e.get("turn_id") == turn_id]

        return web.json_response({"events": events[:limit]})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)

async def handle_mailbox_list(request):
    """§13 Mailbox：一个信箱的未读消息。?limit= 可调。"""
    from mailbox import unread
    from storage import get_storage
    box_id = request.match_info.get("box_id") or request.query.get("box_id") or ""
    if not box_id:
        return web.json_response({"error": "box_id is required"}, status=400)
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 200))
    except (ValueError, TypeError):
        limit = 50
    return web.json_response({
        "boxId": box_id,
        "messages": unread(get_storage(), box_id, limit=limit)})

async def handle_mailbox_drain(request):
    """取走信箱全部未读并标记已消费——每条只送达一次。"""
    from mailbox import drain
    from storage import get_storage
    box_id = request.match_info.get("box_id") or ""
    if not box_id:
        return web.json_response({"error": "box_id is required"}, status=400)
    msgs = drain(get_storage(), box_id)
    return web.json_response({"boxId": box_id, "drained": len(msgs),
                              "messages": msgs})

async def handle_skill_candidates(request):
    """候选列表。?status=candidate|staged|active|degraded|rejected|archived"""
    from storage import get_storage
    status = request.query.get("status") or None
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 200))
    except (ValueError, TypeError):
        limit = 50
    return web.json_response({
        "candidates": get_storage().list_skill_candidates(status=status, limit=limit)})

async def handle_skill_candidate_create(request):
    """从成功经验孵化候选（Step E）。body 即候选项字段，必须带 experience_ref。"""
    import skill_lifecycle as lifecycle
    from storage import get_storage
    data = await request.json()
    res = lifecycle.create_candidate(get_storage(), data or {})
    if not res.ok:
        return web.json_response({"error": res.error}, status=400)
    return web.json_response({"candidate": res.value})

async def handle_skill_candidate_action(request):
    """/promote /approve /reject /rollback 共用路由，动词取自 path。"""
    import skill_lifecycle as lifecycle
    from skill_loader import get_skill_loader
    from storage import get_storage
    cand_id = request.match_info["id"]
    action = request.match_info["action"]
    st, loader = get_storage(), get_skill_loader()
    reason = ""
    if action == "promote":
        res = lifecycle.promote(st, cand_id, loader)
    elif action == "approve":
        res = lifecycle.approve(st, loader, cand_id)
    elif action == "reject":
        try:
            data = await request.json()
        except Exception:
            data = {}
        reason = str((data or {}).get("reason") or "")
        res = lifecycle.reject(st, cand_id, reason)
    elif action == "rollback":
        res = lifecycle.rollback(st, loader, cand_id)
    else:
        return web.json_response({"error": f"unknown action {action}"}, status=404)
    if not res.ok:
        return web.json_response(
            {"error": res.error, "candidate": getattr(res, "value", None)}, status=409)
    # 生命周期时刻广播：staged 待审批 / active 上线 / 回滚——用户要能感知
    cand = res.value or {}
    _kind_map = {"promote": "candidate_staged", "approve": "candidate_active",
                 "reject": "candidate_archived", "rollback": "rolled_back"}
    try:
        from event_bus import get_event_bus
        await get_event_bus().emit("evolution_insight", {
            "kind": _kind_map.get(action, action),
            "detail": str((getattr(res, "meta", None) or {}).get("detail")
                          or f"{action}: {cand.get('name')}"),
            "candidateId": cand.get("id"), "skillName": cand.get("name"),
            "status": cand.get("status"),
            "decision": ("needs_approval" if action == "promote" else None),
        })
    except Exception as exc:
        print(f"[skills] insight broadcast failed: {exc}")
    return web.json_response({"candidate": res.value,
                              **({"detail": res.meta.get("detail")} if getattr(res, "meta", None) and res.meta.get("detail") else {})})


async def handle_import_skill(request):
    from skill_loader import get_skill_loader, TrustLevel
    loader = get_skill_loader()
    data = await request.json()
    path = data.get("path", "")
    trust_str = data.get("trust", "untrusted")
    trust = TrustLevel(trust_str) if trust_str in ("own", "verified", "untrusted") else TrustLevel.UNTRUSTED
    if not path:
        return web.json_response({"error": "path required"}, status=400)
    result = loader.import_skill(path, trust)
    if result.ok:
        return web.json_response(result.value)
    return web.json_response({"error": result.error}, status=400)


async def handle_install_skill(request):
    """Install a skill from GitHub (agentskills.io compatible)."""
    from skill_loader import get_skill_loader
    from skill_registry import install_from_github, sync_lockfile, agentskills_info
    data = await request.json()
    loader = get_skill_loader()
    if data.get("sync_lockfile"):
        result = sync_lockfile(loader)
    elif data.get("source") and data.get("skillPath"):
        result = install_from_github(
            str(data["source"]),
            str(data["skillPath"]),
            loader,
            name=data.get("name"),
        )
    else:
        return web.json_response({"error": "source+skillPath or sync_lockfile required"}, status=400)
    if result.ok:
        return web.json_response({**result.value, "registry": agentskills_info()})
    return web.json_response({"error": result.error}, status=400)


async def handle_search_sessions(request):
    """FTS5 search across session message history."""
    from storage import get_storage
    q = request.rel_url.query.get("q", "").strip()
    workspace = request.rel_url.query.get("workspace", "")
    limit = int(request.rel_url.query.get("limit", "10") or 10)
    if not q:
        return web.json_response({"error": "q required"}, status=400)
    st = get_storage()
    hits = st.search_sessions_fts(q, workspace=workspace, limit=limit)
    return web.json_response({"query": q, "hits": hits})


async def handle_vet_skill(request):
    """
    Static-scan a skill for dangerous patterns BEFORE it's imported.

    Accepts either:
      { "path": "<dir with SKILL.md>" }  — reads SKILL.md from the given dir
      { "content": "<raw skill text>" }  — scans the raw text as-is
    Returns:
      { "level": "LOW|MEDIUM|HIGH|EXTREME", "findings": [ ... ] }

    Frontend calls this before `/api/skills/import` to show a risk report.
    Import is not gated server-side (the UI controls the confirmation UX);
    the endpoint is purely informational so it stays composable — a CI job
    or MCP tool can also run vet checks without triggering an install.
    """
    import os
    from skill_vetter import vet_skill

    data = await request.json()
    content = data.get("content")
    path = data.get("path")

    if not content and path:
        skill_md = os.path.join(path, "SKILL.md")
        if not os.path.isfile(skill_md):
            return web.json_response({"error": f"SKILL.md not found in {path}"}, status=400)
        try:
            with open(skill_md, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            return web.json_response({"error": f"cannot read SKILL.md: {e}"}, status=400)

    if not content:
        return web.json_response({"error": "path or content required"}, status=400)

    result = vet_skill(content)
    return web.json_response(result.to_dict())



async def handle_enable_skill(request):
    from skill_loader import get_skill_loader
    loader = get_skill_loader()
    name = request.match_info.get("name", "")
    result = loader.enable_skill(name)
    if result.ok:
        return web.json_response({"enabled": name})
    return web.json_response({"error": result.error}, status=400)


async def handle_disable_skill(request):
    from skill_loader import get_skill_loader
    loader = get_skill_loader()
    name = request.match_info.get("name", "")
    result = loader.disable_skill(name)
    if result.ok:
        return web.json_response({"disabled": name})
    return web.json_response({"error": result.error}, status=400)


# ─── Plugins ────────────────────────────────────────────────────

async def handle_plugins(request):
    """Installed plugins with what each one contributed."""
    from plugin_registry import get_plugin_registry, SUPPORTED_CONTRIBUTIONS
    return web.json_response({
        "plugins": get_plugin_registry().list_plugins(),
        "supported": list(SUPPORTED_CONTRIBUTIONS),
    })


async def handle_import_plugin(request):
    """Install one plugin from a local directory containing ``plugin.json``."""
    from plugin_registry import get_plugin_registry
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)
    path = str(body.get("path") or "").strip()
    if not path:
        return web.json_response({"error": "path required"}, status=400)
    result = get_plugin_registry().import_plugin(path)
    if result.ok:
        return web.json_response(result.value)
    return web.json_response({"error": result.error}, status=400)


async def handle_plugin_enable(request):
    from plugin_registry import get_plugin_registry
    result = get_plugin_registry().enable(request.match_info.get("name", ""))
    if result.ok:
        return web.json_response(result.value)
    return web.json_response({"error": result.error}, status=404)


async def handle_plugin_disable(request):
    from plugin_registry import get_plugin_registry
    result = get_plugin_registry().disable(request.match_info.get("name", ""))
    if result.ok:
        return web.json_response(result.value)
    return web.json_response({"error": result.error}, status=404)


async def handle_plugin_remove(request):
    """Forget a plugin. Deliberately does NOT delete files from disk — this
    server has no business removing a directory the user pointed it at."""
    from plugin_registry import get_plugin_registry
    result = get_plugin_registry().remove(request.match_info.get("name", ""))
    if result.ok:
        return web.json_response(result.value)
    return web.json_response({"error": result.error}, status=404)


# ─── Settings ───────────────────────────────────────────────────

#: Populated by run_server so settings handlers can read/write the live config.
_CONFIG: dict = {}
_CONFIG_PATH: str = ""


def _config_path() -> str:
    """Resolve the on-disk config path."""
    return _CONFIG_PATH or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "config.json"
    )


def _persist_config() -> None:
    """Write the in-memory config back to disk (atomic)."""
    path = _config_path()
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_CONFIG, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def _redact(cfg: dict) -> dict:
    """Copy of the config with secrets masked for GET responses."""
    import copy
    safe = copy.deepcopy(cfg)
    model = safe.get("model") or {}
    if model.get("api_key"):
        key = model["api_key"]
        model["api_key"] = f"{key[:6]}…{key[-4:]}" if len(key) > 12 else "***"
        model["api_key_set"] = True
    for entry in safe.get("models") or []:
        if entry.get("api_key"):
            entry["api_key"] = "***"
    bot = safe.get("bot") or {}
    for k in list(bot):
        if bot[k]:
            bot[k] = "***"
    return safe


async def handle_get_settings(request):
    """Return the current settings with secrets masked."""
    return web.json_response({
        "settings": _redact(_CONFIG),
        "permissionModes": ["confirm", "auto", "plan", "full"],
    })


async def handle_permission_rules_list(request):
    """List standing permission rules.

    Rules that nobody can see are rules nobody trusts — the whole reason this
    endpoint exists is so an allowlist grown from 「以后都允许」 replies stays
    inspectable and revocable.
    """
    from permission_rules import get_permission_rules
    from tool_policy import sandbox_layer_status
    from sandbox import confinement_status
    ws = request.query.get("workspace", "")
    sid = request.query.get("session", "")
    rules = get_permission_rules().list(workspace_root=ws, session_id=sid)
    return web.json_response({
        "rules": [
            {
                "id": r.id, "toolName": r.tool_name, "pattern": r.pattern,
                "behavior": r.behavior.value, "scope": r.scope.value,
                "workspaceRoot": r.workspace_root, "sessionId": r.session_id,
                "source": r.source, "note": r.note, "createdAt": int(r.created_at),
            }
            for r in rules
        ],
        # Policy-pipeline SANDBOX layer (readonly-tool flag). Historically
        # inert; kept so the page can still say when that layer is empty.
        "sandbox": sandbox_layer_status(),
        # Kernel confinement + path-policy file. This is the real gate.
        "confinement": confinement_status(ws),
    })



async def handle_permission_rule_create(request):
    """Create a rule. Body: {toolName, pattern?, behavior?, scope?, ...}."""
    from permission_rules import (
        PermissionRule, RuleBehavior, RuleScope, get_permission_rules,
    )
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid json"}, status=400)
    tool = str(body.get("toolName") or body.get("tool_name") or "").strip()
    if not tool:
        return web.json_response({"error": "toolName is required"}, status=400)
    try:
        behavior = RuleBehavior(str(body.get("behavior") or "allow").lower())
        scope = RuleScope(str(body.get("scope") or "workspace").lower())
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    rule = get_permission_rules().add(PermissionRule(
        tool_name=tool,
        pattern=str(body.get("pattern") or ""),
        behavior=behavior,
        scope=scope,
        workspace_root=str(body.get("workspaceRoot") or ""),
        session_id=str(body.get("sessionId") or ""),
        source="user",
        note=str(body.get("note") or ""),
    ))
    return web.json_response({"ok": True, "id": rule.id})


async def handle_permission_rule_delete(request):
    from permission_rules import get_permission_rules
    removed = get_permission_rules().remove(request.match_info["rule_id"])
    return web.json_response({"ok": removed}, status=200 if removed else 404)


async def handle_models_list(request):
    """List what the backend can actually resolve, plus the active default."""
    from model_registry import get_model_registry
    reg = get_model_registry()
    info = reg.resolve()
    return web.json_response({
        "providers": reg.list_providers(),
        "active": info.value if info.ok else None,
    })


async def handle_models_resolve(request):
    """Resolve one model and return unified capability metadata for the UI."""
    from model_registry import get_model_registry
    model = (request.query.get("model") or "").strip()
    if not model:
        return web.json_response({"error": "model query parameter required"}, status=400)
    reg = get_model_registry()
    resolved = reg.resolve(model)
    if not resolved.ok:
        return web.json_response({"error": resolved.error or "not found"}, status=404)
    body = dict(resolved.value)
    body["thinkingCapability"] = reg.thinking_capability(model)
    return web.json_response(body)


async def handle_models_sync_providers(request):
    """Push the desktop UI's provider catalogue into the backend registry.

    The picker used to live entirely in Electron (``providers.json``), which the
    Python process never reads — so a model chosen there could not be resolved,
    let alone called. This is the one-way sync that closes that gap: the UI stays
    the editor, the backend becomes the single source the request path reads.

    Keys are stored through ``CredentialCipher`` (``upsert_provider`` ->
    ``_save_to_storage``), never in plaintext, and an omitted/empty ``apiKey``
    leaves the stored one untouched so a masked round trip cannot erase it.

    Body: ``{"providers": {providerId: {name, kind, apiKey, baseURL, enabled,
    models}}}``. Also accepts a bare mapping for convenience. Pass
    ``"prune": true`` to make the payload authoritative — anything the UI no
    longer has is dropped, which is how a deleted provider actually disappears
    instead of lingering as a resolvable ghost.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    prune = bool(body.get("prune")) if isinstance(body, dict) else False
    providers = body.get("providers") if isinstance(body, dict) else None
    if not isinstance(providers, dict):
        providers = body if isinstance(body, dict) else None
    if not isinstance(providers, dict) or not providers:
        return web.json_response({"error": "providers must be a non-empty object"}, status=400)

    from model_registry import get_model_registry
    reg = get_model_registry()
    synced, failed = [], {}
    for pid, spec in providers.items():
        r = reg.upsert_provider(pid, spec if isinstance(spec, dict) else {})
        if r.ok:
            synced.append(pid)
        else:
            failed[pid] = r.error
    pruned = reg.prune_providers(synced) if prune else []
    # Partial success is the honest answer: one malformed entry must not discard
    # the providers that did sync.
    return web.json_response({"ok": not failed, "synced": synced,
                              "failed": failed, "pruned": pruned})


async def handle_update_settings(request):
    """Patch settings and hot-apply the ones that support it.

    Body accepts any subset of ``model`` / ``permissions`` / ``memory``.
    An ``api_key`` of "" or the masked placeholder is ignored so a GET->PUT
    round trip cannot wipe the stored key.
    """
    try:
        patch = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    applied: list[str] = []

    model_patch = patch.get("model") or {}
    if model_patch:
        current = _CONFIG.setdefault("model", {})
        for key, value in model_patch.items():
            if key == "api_key" and (not value or "…" in str(value) or value == "***"):
                continue  # masked value came back from the UI — keep the real one
            current[key] = value
        # Rebuild the LLM client and re-wire every module that holds a callback.
        from llm_client import reset_llm_client, get_llm_client
        from memory_layer import get_memory_layer
        from goal_manager import get_goal_manager
        from git_trust import get_commit_message_generator
        reset_llm_client()
        llm = get_llm_client(_CONFIG)
        try:
            from model_registry import get_model_registry
            get_model_registry().seed_from_config(_CONFIG.get("model", {}))
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        for getter in (get_memory_layer, get_goal_manager, get_commit_message_generator):
            try:
                getter(llm_callback=llm.call)
            except TypeError:
                pass  # fail-open: 可选增强，失败不影响主流程
        # Existing singletons already hold the old callback; overwrite directly,
        # each with a client bound to its own scene (UD1) rather than the
        # conversation model.
        try:
            scene = _wire_scene_callbacks(llm)
            clients = scene["clients"]
            get_memory_layer()._llm = clients["memory"].call
            get_goal_manager()._llm = clients["goal"].call
            get_commit_message_generator()._llm = clients["commit"].call
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        router = request.app[ROUTER_KEY]
        router.llm = llm
        # The per-turn binding derives from `_base_llm`, so refreshing only
        # `llm` would leave the next turn rebuilding from the STALE credentials.
        router._base_llm = llm
        applied.append("model")

    perm_patch = patch.get("permissions") or {}
    if "mode" in perm_patch:
        from risk_control import get_risk_controller, coerce_permission
        # `coerce_permission` maps legacy spellings (deny→readonly, ask→confirm,
        # yolo→full) onto the canonical axis and never raises. A value that
        # doesn't resolve to anything real just falls back to the default, so we
        # reject only genuinely-empty input.
        raw = perm_patch["mode"]
        if not raw or not str(raw).strip():
            return web.json_response({"error": "empty permission mode"}, status=400)
        mode = coerce_permission(raw)
        _CONFIG.setdefault("permissions", {})["mode"] = mode.value
        get_risk_controller().set_mode(mode)
        applied.append("permissions")
    if "auto_confirm_low_risk" in perm_patch:
        from risk_control import get_risk_controller
        val = bool(perm_patch["auto_confirm_low_risk"])
        _CONFIG.setdefault("permissions", {})["auto_confirm_low_risk"] = val
        get_risk_controller().set_auto_confirm_low_risk(val)
        if "permissions" not in applied:
            applied.append("permissions")

    # Agent-loop ceiling, hot-applied to every live router so the next turn in
    # any window obeys it without a restart.
    agent_patch = patch.get("agent") or {}
    if "max_steps_per_turn" in agent_patch:
        try:
            steps = max(0, int(agent_patch["max_steps_per_turn"]))
        except (TypeError, ValueError):
            return web.json_response({"error": "invalid max_steps_per_turn"}, status=400)
        _CONFIG.setdefault("agent", {})["max_steps_per_turn"] = steps
        for r in request.app[SESSION_HOST_KEY]._sessions.values():
            r.max_agent_steps = steps
            r.soft_landing_step = max(1, steps - 2) if steps > 0 else -1
        applied.append("agent")

    # Fold thresholds. Clamped the same way `compaction_kwargs_from_config`
    # clamps at boot: thresholds in (0.5, 0.95], emergency >= threshold — a bad
    # value must not make folding never fire or fire on every turn.
    comp_patch = patch.get("compaction") or {}
    if comp_patch:
        cur = _CONFIG.setdefault("compaction", {})
        for key in ("max_tokens", "threshold", "emergency_threshold", "cooldown_s",
                    "max_consecutive", "reserve_tokens_floor"):
            if key in comp_patch:
                cur[key] = comp_patch[key]
        try:
            th = min(0.95, max(0.50, float(cur.get("threshold", 0.80))))
            em = min(0.98, max(th, float(cur.get("emergency_threshold", 0.90))))
        except (TypeError, ValueError):
            th, em = 0.80, 0.90
        cur["threshold"], cur["emergency_threshold"] = th, em
        try:
            cd = max(0.0, float(cur.get("cooldown_s", 15.0)))
            mx = max(1, int(cur.get("max_consecutive", 5)))
            mt = max(8_000, int(cur.get("max_tokens", 80_000)))
        except (TypeError, ValueError):
            cd, mx, mt = 15.0, 5, 80_000
        cur["cooldown_s"], cur["max_consecutive"], cur["max_tokens"] = cd, mx, mt
        # 折叠水位地板：只有显式传入才写（未传=沿用构造时默认），钳位到半窗。
        floor_set = "reserve_tokens_floor" in comp_patch
        if floor_set:
            try:
                fl = max(0, min(int(cur.get("reserve_tokens_floor", 0)), mt // 2))
            except (TypeError, ValueError):
                fl = 0
            cur["reserve_tokens_floor"] = fl
        else:
            try:
                fl = int(cur.get("reserve_tokens_floor", 0))
            except (TypeError, ValueError):
                fl = 0
        for r in request.app[SESSION_HOST_KEY]._sessions.values():
            r.compactor.threshold = th
            r.compactor.emergency_threshold = em
            r.compactor.cooldown_s = cd
            r.compactor.max_consecutive = mx
            r.compactor.max_tokens = mt
            if floor_set:
                r.compactor.reserve_tokens_floor = fl
        try:
            from context_compactor import get_compactor
            get_compactor().threshold = th
            get_compactor().emergency_threshold = em
            get_compactor().cooldown_s = cd
            get_compactor().max_consecutive = mx
            get_compactor().max_tokens = mt
            if floor_set:
                get_compactor().reserve_tokens_floor = fl
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        applied.append("compaction")

    telemetry_patch = patch.get("telemetry") or {}
    if "enabled" in telemetry_patch:
        val = bool(telemetry_patch["enabled"])
        _CONFIG.setdefault("telemetry", {})["enabled"] = val
        from telemetry import get_telemetry
        get_telemetry().enabled = val
        applied.append("telemetry")

    memory_patch = patch.get("memory") or {}
    if memory_patch:
        _CONFIG.setdefault("memory", {}).update(memory_patch)
        # The master switch is honoured at runtime now (extract/recall/synthesis
        # gates), so flipping it here actually stops memory work mid-process:
        # dreamer + pending debounced extractions stop, recall stops injecting.
        if "enabled" in memory_patch:
            from memory_layer import get_memory_layer
            await get_memory_layer().set_enabled(bool(memory_patch["enabled"]))
        applied.append("memory")

    workspace_patch = patch.get("workspace") or {}
    if workspace_patch:
        _CONFIG.setdefault("workspace", {}).update(workspace_patch)
        applied.append("workspace")

    shadow_patch = patch.get("shadow") or {}
    if shadow_patch:
        from shadow_config import apply_patch as apply_shadow_patch
        normalized = apply_shadow_patch(shadow_patch)
        _CONFIG.setdefault("shadow", {}).update(normalized)
        applied.append("shadow")

    try:
        _persist_config()
    except OSError as e:
        return web.json_response({"error": f"could not persist: {e}"}, status=500)

    return web.json_response({"applied": applied, "settings": _redact(_CONFIG)})


async def handle_get_tools(request):
    """Expose the tool catalogue + risk grades for the settings UI."""
    from tools import get_tool_registry
    from risk_control import get_risk_controller
    registry = get_tool_registry()
    controller = get_risk_controller()
    tools = [
        {
            "name": t.name,
            "domain": t.domain,
            "description": t.description,
            "riskLevel": controller.classify_risk(t.name, {}).value,
        }
        for t in registry.list_tools()
    ]
    return web.json_response({
        "tools": sorted(tools, key=lambda x: (x["domain"], x["name"])),
        "mode": controller.mode.value,
        "count": len(tools),
    })


# ─── Sub-agents (the ``task`` tool's control surface) ────────────
#
# The WS already streams `subagent_state` transitions, which is enough to RENDER
# progress. These endpoints exist for the two things a stream can't do:
#   * answer "what is running right now?" for a client that connected late or
#     reloaded mid-turn (a stream only carries transitions, not current state)
#   * ACT on a running sub-agent — kill a runaway explorer without aborting the
#     whole parent turn
# Kept on HTTP rather than the WS so a CLI or test harness can drive them too.

async def handle_subagents_list(request):
    """
    Current sub-agent roster. ``?session_id=`` filters to one parent session;
    omit it to see every sub-agent in the process (useful for debugging).

    Two sources, merged: the in-memory runtime is the live truth for anything
    still tracked, and the on-disk ledger fills in runs the process-local map
    already expired or that a previous process left behind (reaped to ``killed``
    at boot). The in-memory record always wins on id collision — it is never
    staler than the ledger. This is what lets a client that reloaded mid-turn,
    or connected after a restart, still see how a batch ended instead of an
    empty list.
    """
    from subagent_runtime import (
        MAX_CONCURRENT_SUBAGENTS, get_max_children_per_agent, get_subagent_runtime,
    )
    from storage import get_storage
    runtime = get_subagent_runtime()
    session_id = request.query.get("session_id", "")
    live = runtime.list_sessions(session_id)
    seen = {r["subagentId"] for r in live}
    rows = list(live)
    try:
        for r in get_storage().list_subagent_runs(session_id):
            if r["subagent_id"] in seen:
                continue
            started = r.get("started_at") or 0
            finished = r.get("finished_at") or 0
            base = started or r.get("created_at") or 0
            rows.append({
                "subagentId": r["subagent_id"],
                "subagentType": r.get("subagent_type") or "",
                "label": r.get("label") or r.get("subagent_type") or "",
                "parentSessionId": r.get("parent_session_id") or "",
                "childSessionId": r.get("child_session_id") or "",
                "status": r.get("status") or "",
                "createdAt": r.get("created_at") or 0,
                "startedAt": started or None,
                "finishedAt": finished or None,
                "elapsedMs": int(((finished or base) - base) * 1000) if base else 0,
                "resultChars": r.get("result_chars") or 0,
                "error": r.get("error") or "",
                "persisted": True,  # came from the ledger, not the live map
            })
    except Exception:  # noqa: BLE001
        pass  # a ledger read failure must not blank out the live roster
    rows.sort(key=lambda r: r.get("createdAt") or 0, reverse=True)
    return web.json_response({
        "subagents": rows,
        "active": sum(1 for r in rows if r["status"] in ("spawning", "running")),
        "maxConcurrent": MAX_CONCURRENT_SUBAGENTS,
        # 单个父会话的子代上限（设置页可调）——面板据此显示「活跃 X / 上限 Y」
        "maxChildrenPerAgent": get_max_children_per_agent(),
    })


async def handle_subagent_kill(request):
    """
    Cancel one running sub-agent. Idempotent-ish: killing an already-finished
    sub-agent returns 404 rather than pretending to succeed, so a UI that
    double-clicks learns the work was already done.

    The status does NOT flip here — ``SubagentRuntime.kill`` only requests
    cancellation and the sub-agent's own except-branch writes the terminal
    state. Single writer for terminal state means the ``subagent_state`` stream
    can never disagree with this endpoint.
    """
    from subagent_runtime import get_subagent_runtime
    subagent_id = request.match_info.get("id", "")
    if not subagent_id:
        return web.json_response({"error": "id required"}, status=400)
    killed = get_subagent_runtime().kill(subagent_id)
    if not killed:
        return web.json_response(
            {"error": f"sub-agent '{subagent_id}' is unknown or already finished"},
            status=404,
        )
    return web.json_response({"ok": True, "subagentId": subagent_id})


async def handle_subagents_kill_all(request):
    """
    Kill every live sub-agent of one parent session — the "stop" button for a
    fan-out that's clearly going nowhere. ``session_id`` is required: a
    process-wide kill switch would let one window abort another window's work.
    """
    from subagent_runtime import get_subagent_runtime
    try:
        data = await request.json()
    except Exception:
        data = {}
    session_id = (data.get("session_id") or request.query.get("session_id") or "").strip()
    if not session_id:
        return web.json_response({"error": "session_id required"}, status=400)
    graceful = str(data.get("graceful") or request.query.get("graceful") or "1").strip().lower()
    use_graceful = graceful not in ("0", "false", "no")
    runtime = get_subagent_runtime()
    if use_graceful:
        result = await runtime.kill_all_graceful(session_id)
        return web.json_response({
            "ok": True,
            "graceful": True,
            "killed": result.get("killed", 0),
            "requested": result.get("requested", 0),
            "requestId": result.get("request_id"),
        })
    n = runtime.kill_all(session_id)
    return web.json_response({"ok": True, "graceful": False, "killed": n})


async def handle_subagent_types(request):
    """The available sub-agent personas, for a UI picker or docs page."""
    from subagent_registry import reload_subagent_defs, get_subagent_registry
    reload_subagent_defs()
    registry = get_subagent_registry()
    return web.json_response({
        "types": [d.to_public() for d in registry.values()],
    })



async def handle_subagent_type_update(request):
    """Persist a per-persona model override (and/or max_turns) to a YAML file.

    The registry merges user-authored YAML over built-ins at boot; writing the
    override to ``app/backend/subagents/_ui_overrides.yaml`` makes a user's
    "coder uses model X" choice survive restarts and show up in every picker
    without rebuilding the preset list. A ``model`` of null clears the override
    for that persona (falls back to inherit-parent).
    """
    from subagent_registry import get_subagent_registry
    from storage import get_storage  # noqa: F401 — ensures app boot side-effects
    import os
    import yaml

    name = request.match_info.get("name", "")
    registry = get_subagent_registry()
    if name not in registry:
        return web.json_response({"error": f"unknown persona: {name}"}, status=404)

    try:
        patch = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    # Validate the model against the live provider catalogue if one is given.
    model = patch.get("model")
    if model is not None and model != "":
        from model_registry import get_model_registry
        reg = get_model_registry()
        if not reg.resolve(model).ok:
            return web.json_response(
                {"error": f"unknown model: {model}"}, status=422)
    max_turns = patch.get("max_turns")
    model_policy = patch.get("model_policy") or patch.get("modelPolicy")

    override: dict = {"name": name}
    if model is not None:
        override["model"] = model if model else None
    if model_policy is not None:
        policy = str(model_policy).strip().lower()
        if policy not in ("main", "economy"):
            return web.json_response(
                {"error": "model_policy must be main or economy"}, status=422)
        override["model_policy"] = policy
    if max_turns is not None:
        try:
            override["max_turns"] = max(1, int(max_turns))
        except (TypeError, ValueError):
            return web.json_response({"error": "max_turns must be an integer"}, status=422)

    # Write/reload. Keep it atomic-ish: tmp + rename.
    # _parse_yaml_def expects one dict per file (with system_prompt), so we
    # write one file per persona, seeded from the live def to satisfy required
    # fields, then overlay the patched model/max_turns.
    try:
        subs_dir = os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", "subagents"))
        os.makedirs(subs_dir, exist_ok=True)
        path = os.path.join(subs_dir, f"_ui_override_{name}.yaml")

        # Seed from the current def so the file is a valid standalone persona.
        cur = registry.get(name)
        doc: dict = {
            "name": name,
            "description": cur.description if cur else "",
            "system_prompt": cur.system_prompt if cur else "",
        }
        if cur and cur.allowed_tools:
            doc["allowed_tools"] = sorted(cur.allowed_tools)
        if cur and cur.permission:
            doc["permission"] = cur.permission
        if cur and cur.handoffs:
            doc["handoffs"] = sorted(cur.handoffs)
        if cur:
            if cur.model is not None:
                doc["model"] = cur.model
            if cur.model_policy:
                doc["model_policy"] = cur.model_policy
        # Apply the patch on top.
        if model is not None:
            doc["model"] = model if model else None
        if model_policy is not None:
            doc["model_policy"] = str(model_policy).strip().lower()
        if max_turns is not None:
            doc["max_turns"] = max(1, int(max_turns))

        import tempfile
        fd, tmp = tempfile.mkstemp(dir=subs_dir, suffix=".yaml")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass  # fail-open: 可选增强，失败不影响主流程
            raise
    except Exception as e:
        return web.json_response({"error": f"could not persist: {e}"}, status=500)

    # Reload registry so the running process reflects the change immediately.
    from subagent_registry import reload_subagent_defs
    reload_subagent_defs()

    registry = get_subagent_registry()
    updated = registry.get(name)
    return web.json_response({
        "ok": True,
        "type": updated.to_public() if updated else None,
        "types": [d.to_public() for d in registry.values()],
    })



# ─── Rollback (per-step file snapshots) ─────────────────────────
#
# List and restore the pre-images captured by ``snapshot_store`` before each
# mutating file tool ran. The chat-history side lives on the WS
# (``session_truncate``) so both halves of an atomic undo share one shape; the
# HTTP side is here so external tools (a CLI, a test harness) can also inspect
# and roll back without a WS session.

async def handle_rollback_list(request):
    """List snapshots for a session at or after a given seq (or all when omitted)."""
    router: Router = request.app[ROUTER_KEY]
    sid = request.query.get("sessionId") or router.session_id
    seq_raw = request.query.get("seq", "0")
    try:
        seq = int(seq_raw)
    except (TypeError, ValueError):
        return web.json_response({"error": "seq must be an integer"}, status=400)
    from snapshot_store import get_snapshot_store
    rows = get_snapshot_store().list_since(sid, seq)
    return web.json_response({"sessionId": sid, "seq": seq, "snapshots": rows})


async def handle_rollback_apply(request):
    """Restore every snapshot at or after ``seq`` for a session, newest first."""
    router: Router = request.app[ROUTER_KEY]
    try:
        data = await request.json()
    except Exception:
        data = {}
    sid = data.get("sessionId") or router.session_id
    seq = data.get("seq")
    if not isinstance(seq, int):
        return web.json_response({"error": "seq must be an integer"}, status=400)
    from snapshot_store import get_snapshot_store
    report = get_snapshot_store().rollback_since(sid, seq)
    return web.json_response({"ok": True, "sessionId": sid, "seq": seq, **report})


# ─── Session timeline / checkpoint tree (UB1) ───────────────────────
#
# The read side of the timeline axis. `seq` is the shared checkpoint key: the
# snapshot store groups pre-images by it, `session_messages` numbers user turns
# by it, and `session_truncate` is addressed by the matching ordinal. These
# endpoints only ever READ — going back to a checkpoint stays on the WS, so the
# atomic "history + files" undo keeps happening in one place.

async def handle_checkpoints(request):
    """The timeline: one node per user turn, annotated with what it changed."""
    router: Router = request.app[ROUTER_KEY]
    sid = request.query.get("sessionId") or router.session_id
    from snapshot_store import get_snapshot_store
    from storage import get_storage
    try:
        turns = get_storage().list_user_turns(sid)
    except Exception:
        turns = []
    by_seq = {int(c["seq"]): c for c in get_snapshot_store().checkpoints(sid)}
    nodes = []
    for turn in turns:
        snap = by_seq.pop(int(turn["seq"]), None) or {}
        nodes.append({
            "seq": turn["seq"],
            # Kept alongside seq because this is the handle `session_truncate`
            # takes; the frontend must never have to recompute it.
            "ordinal": turn["ordinal"],
            "preview": turn["preview"],
            "createdAt": turn["created_at"],
            "files": int(snap.get("files") or 0),
            "tools": snap.get("tools") or [],
            "label": snap.get("label") or "",
            # A turn that changed nothing is still a node (you can go back to a
            # question), it just has nothing to restore.
            "recoverable": bool(snap.get("recoverable")) if snap else False,
            "folded": bool(snap.get("folded")) if snap else False,
        })
    # Snapshots whose turn is gone from history (a chat-only withdraw folded the
    # messages away). Reported separately rather than dropped: they are the
    # record of a branch the user walked back over.
    orphans = [{"seq": int(s["seq"]), "files": int(s.get("files") or 0),
                "folded": bool(s.get("folded"))} for s in by_seq.values()]
    return web.json_response({"sessionId": sid, "nodes": nodes, "orphans": orphans})


async def handle_checkpoint_preview(request):
    """What one checkpoint touched. Read-only — never restores anything."""
    router: Router = request.app[ROUTER_KEY]
    sid = request.query.get("sessionId") or router.session_id
    try:
        seq = int(request.query.get("seq", ""))
    except (TypeError, ValueError):
        return web.json_response({"error": "seq must be an integer"}, status=400)
    from snapshot_store import get_snapshot_store
    return web.json_response({
        "sessionId": sid, "seq": seq,
        "paths": get_snapshot_store().paths_at(sid, seq),
    })


async def handle_checkpoint_label(request):
    """Name a checkpoint (「这里是好状态」). Empty label clears it back to auto."""
    router: Router = request.app[ROUTER_KEY]
    try:
        data = await request.json()
    except Exception:
        data = {}
    sid = data.get("sessionId") or router.session_id
    seq = data.get("seq")
    if not isinstance(seq, int):
        return web.json_response({"error": "seq must be an integer"}, status=400)
    from snapshot_store import get_snapshot_store
    n = get_snapshot_store().label_checkpoint(sid, seq, str(data.get("label") or ""))
    return web.json_response({"ok": True, "sessionId": sid, "seq": seq, "updated": n})


# ─── Event-Sourced Agent Runtime & Time Travel ─────────────────────

async def handle_get_events(request):
    """Event-sourced stream: returns raw immutable AgentEvent list for session."""
    from storage import get_storage
    sid = request.match_info.get("sessionId") or request.query.get("sessionId")
    if not sid:
        return web.json_response({"error": "sessionId is required"}, status=400)
    from_seq = int(request.query.get("from_seq", 0))
    to_seq_str = request.query.get("to_seq")
    to_seq = int(to_seq_str) if to_seq_str is not None else None
    limit_str = request.query.get("limit")
    limit = int(limit_str) if limit_str is not None else None

    events = get_storage().get_events(sid, from_seq=from_seq, to_seq=to_seq, limit=limit)
    return web.json_response({"sessionId": sid, "events": [e.to_dict() for e in events]})


async def handle_verify_event_chain(request):
    """Cryptographic verification of SHA-256 event chain integrity."""
    from storage import get_storage
    sid = request.match_info.get("sessionId") or request.query.get("sessionId")
    if not sid:
        return web.json_response({"error": "sessionId is required"}, status=400)
    res = get_storage().verify_event_chain(sid)
    return web.json_response({"sessionId": sid, **res})


async def handle_get_projected_state(request):
    """Materializes state by replaying event stream up to optional at_seq."""
    from storage import get_storage
    sid = request.match_info.get("sessionId") or request.query.get("sessionId")
    if not sid:
        return web.json_response({"error": "sessionId is required"}, status=400)
    at_seq_str = request.query.get("at_seq")
    at_seq = int(at_seq_str) if at_seq_str is not None else None
    state = get_storage().project_session_state(sid, at_seq=at_seq)
    return web.json_response({"sessionId": sid, "state": state.to_dict()})


async def handle_fork_at_seq(request):
    """Time-Travel Fork: forks a new session up to an exact event sequence number."""
    from storage import get_storage
    try:
        data = await request.json()
    except Exception:
        data = {}
    source_sid = data.get("source_session_id")
    fork_seq = data.get("fork_point_seq")
    if not source_sid or fork_seq is None:
        return web.json_response({"error": "source_session_id and fork_point_seq are required"}, status=400)

    new_sid = data.get("new_session_id") or str(uuid4())
    title = data.get("title")
    state = get_storage().fork_at_seq(source_sid, int(fork_seq), new_sid, title=title)
    return web.json_response({
        "sessionId": new_sid,
        "sourceSessionId": source_sid,
        "forkPointSeq": fork_seq,
        "state": state.to_dict(),
    })


async def handle_get_session_log(request):
    """Returns human-readable text of session.log for the requested session."""
    from storage import get_storage
    sid = request.match_info.get("sessionId") or request.query.get("sessionId")
    if not sid:
        return web.json_response({"error": "sessionId is required"}, status=400)
    log_text = get_storage().get_session_log(sid)
    return web.Response(text=log_text, content_type="text/plain", charset="utf-8")


async def handle_get_session_transcript(request):
    """Returns machine-readable JSONL transcript event stream for the requested session."""
    from storage import get_storage
    sid = request.match_info.get("sessionId") or request.query.get("sessionId")
    if not sid:
        return web.json_response({"error": "sessionId is required"}, status=400)
    transcript = get_storage().get_session_transcript(sid)
    return web.json_response({"sessionId": sid, "steps": transcript})


async def handle_get_session_log_info(request):
    """Returns filesystem paths and size statistics for the session log."""
    from storage import get_storage
    sid = request.match_info.get("sessionId") or request.query.get("sessionId")
    if not sid:
        return web.json_response({"error": "sessionId is required"}, status=400)
    info = get_storage().get_session_log_info(sid)
    return web.json_response(info)



# ─── Session artifacts ──────────────────────────────────────────────
#
# One read-only endpoint. The union logic lives in artifact_index.py because it
# spans three stores that don't know about each other; see that module's header.


async def handle_artifacts(request):
    """Flat, newest-first index of everything a session produced (images + files)."""
    router: Router = request.app[ROUTER_KEY]
    sid = request.query.get("session_id") or request.query.get("sessionId") or router.session_id
    if not sid:
        return web.json_response({"error": "no session"}, status=400)
    from artifact_index import build_index
    return web.json_response(build_index(router.storage, sid, router.workspace or ""))


# ─── Usage analytics ────────────────────────────────────────────────
#
# One endpoint, one payload — dashboards want everything at once and the query
# volume is tiny (SQLite + GROUP BY). Splitting summary/daily/model into three
# routes would triple the round-trips for no benefit at this scale.

def _parse_range_days(request) -> int:
    raw = request.query.get("days", "30")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = 30
    return max(1, min(n, 365))


async def handle_usage_stats(request):
    router: Router = request.app[ROUTER_KEY]
    days = _parse_range_days(request)
    storage = router.storage
    by_model = storage.usage_by_model(days)
    # Resolve provider ids to vendor names here, at the API boundary, because the
    # registry is the only thing that knows them. The panel used to string-split
    # `provider:model` in the browser against a hardcoded 9-entry lookup table,
    # so every provider outside that table — including the `__config__` sentinel
    # — was uppercased and shown raw.
    _label = getattr(router.models, "provider_label", None)
    if callable(_label):
        for m in by_model:
            for src in m.get("sources") or []:
                src["provider_label"] = _label(src.get("provider_id", ""))
            sources = m.get("sources") or []
            m["provider_label"] = sources[0]["provider_label"] if len(sources) == 1 else ""
    return web.json_response({
        "days": days,
        "summary": storage.usage_summary(days),
        "daily": storage.usage_daily(days),
        "byModel": by_model,
        "recentTurns": storage.usage_recent_turns(limit=30, days=days),
    })


async def handle_token_analytics(request):
    """Context window analytics: token breakdown, cache stats, agent actions.

    Returns a snapshot of the current session's context window usage,
    broken down by source (messages / system_prompt / tools / skills),
    plus prompt-caching hit rates and agent action counts.
    """
    from token_analytics import get_token_analytics
    analytics = get_token_analytics()
    # Resolve the CALLING session's router (the frontend passes ?session_id=).
    # `app[ROUTER_KEY]` is only the primary one — in a second window the
    # breakdown would describe the first window's prompt state.
    router = await _router_for_request(request)
    if router:
        try:
            sp_tokens = router.compactor.estimate_tokens(router.get_system_prompt())
            tool_tokens = router._tool_def_tokens()
            skill_tokens = router._skill_tokens()
            # 0 = unknown — never fabricate a "typical" 200k here. The frontend
            # treats a positive total as a KNOWN window and draws percentages
            # from it; a guessed denominator is exactly the bug its
            # `windowKnown` guard exists to prevent.
            ctx_window = int(getattr(router.llm, "context_limit", 0) or 0)

            # If this session has no user messages yet, analytics should
            # reflect the empty-session baseline (overhead only).
            #
            # The history read used to call ``storage.get_session_messages``,
            # a method that does not exist — AttributeError, the whole try
            # swallowed by the bare except below, and the endpoint returned
            # the all-zero INITIAL snapshot forever. That is why the popover's
            # 系统提示词/工具定义/技能配置 read 0 no matter what.
            hist = router.storage.get_messages(router.session_id, limit=1000) if hasattr(router, "storage") else []
            user_msgs = [m for m in hist if getattr(m, "role", "") == "user" or (isinstance(m, dict) and m.get("role") == "user")]
            if not user_msgs:
                analytics.reset_session(
                    system_prompt_tokens=sp_tokens,
                    tool_def_tokens=tool_tokens,
                    skill_tokens=skill_tokens,
                    context_window=ctx_window,
                )
            else:
                snap = analytics.snapshot()
                if (not snap.get("breakdown", {}).get("tools") and tool_tokens > 0) or snap.get("used", 0) == 0:
                    analytics.update_from_usage(
                        context_tokens=sp_tokens + tool_tokens + skill_tokens,
                        context_window=ctx_window,
                        system_prompt_tokens=sp_tokens,
                        tool_def_tokens=tool_tokens,
                        skill_tokens=skill_tokens,
                    )
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
    return web.json_response(analytics.snapshot())


# ─── Memory diagnostics & wiki adjudication (C1-C4) ─────────────────
#
# Read-heavy diagnostics in one payload, same rationale as usage/stats: the
# panel wants tier counts + FTS index health + retrieval-facade health at once,
# and all three are cheap (two COUNT queries and an in-process dict).
#
# The wiki side is the only place in the app where the USER resolves a
# contradiction the system detected. Deliberately not automated — see
# wiki_store.add(): auto-superseding by confidence lets one low-confidence
# wrong claim silence a high-confidence right one, silently.

async def handle_memory_diagnostics(request):
    """Tier occupancy + FTS5 index health + ActiveMemory cache/breaker state."""
    from memory_layer import get_memory_layer
    # Scope to the workspace this window has open. The layer is a process
    # singleton, so reading it unscoped would report whichever folder happened to
    # be last — the numbers on the panel have to belong to the folder on screen.
    # 整个 handler 只用一个 root：以前 tier 面板读 effective_workspace 而
    # wikiStats 读 workspace，同一屏上的两组数字可以属于两个 workspace。
    root = _memory_root(request)
    memory = get_memory_layer().for_root(root)
    storage = request.app[ROUTER_KEY].storage

    payload: dict = {"workspace": root}

    # Each block is guarded separately: a broken FTS table must not blank out
    # the tier panel, and vice versa. Partial diagnostics beat no diagnostics.
    try:
        payload["tiers"] = memory.tier_stats()
    except Exception as exc:
        payload["tiers"] = []
        payload["tiersError"] = str(exc)
    try:
        payload["fts"] = storage.memory_fts_stats()
    except Exception as exc:
        payload["fts"] = {"enabled": False, "indexed": 0}
        payload["ftsError"] = str(exc)
    try:
        # `.active` is lazy — touching it here spawns the worker pool, which is
        # fine: if someone opened this panel they are about to use recall anyway.
        payload["active"] = memory.active.snapshot()
    except Exception as exc:
        payload["active"] = None
        payload["activeError"] = str(exc)
    try:
        payload["wikiStats"] = memory.wiki.stats(root)

    except Exception as exc:
        payload["wikiStats"] = {"total": 0}
        payload["wikiError"] = str(exc)
    try:
        # Which retrieval channels are actually live here. The panel used to
        # imply hybrid search unconditionally; with no embeddings stored the
        # dense channel scores nothing and fusion runs pure lexical.
        payload["retrieval"] = memory.retrieval_channels()
    except Exception as exc:
        payload["retrieval"] = None
        payload["retrievalError"] = str(exc)
    return web.json_response(payload)


async def handle_memory_backfill(request):
    """Compute vectors for memories that never got one, for this workspace.

    Bounded per call (``?limit=``, default 200) and idempotent: rows that already
    carry an embedding are skipped, so the button is safe to press repeatedly
    until ``remaining`` reaches 0.
    """
    router: Router = request.app[ROUTER_KEY]
    from memory_layer import get_memory_layer
    memory = get_memory_layer().for_root(router.effective_workspace)
    try:
        limit = int(request.query.get("limit") or 200)
    except ValueError:
        limit = 200
    limit = max(1, min(2000, limit))
    try:
        result = memory.backfill_embeddings(limit=limit)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
    result["channels"] = memory.retrieval_channels()
    return web.json_response(result)


async def handle_memory_reindex(request):
    """Rebuild the FTS5 lexical index for the active workspace.

    Needed after upgrading (rows predate the table) or if the bigram scheme
    changes — the indexed body is derived from content, so it must be
    regenerated rather than migrated.
    """
    router: Router = request.app[ROUTER_KEY]
    try:
        n = router.storage.rebuild_memory_fts(router.workspace or "")
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response({"reindexed": n})


async def handle_memory_cache_clear(request):
    """Drop the ActiveMemory TTL cache so the next recall re-runs retrieval."""
    from memory_layer import get_memory_layer
    try:
        dropped = get_memory_layer().active.invalidate()
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
    return web.json_response({"dropped": dropped})


# ─── Memory entries (content-level CRUD) ────────────────────────
#
# /diagnostics answers "how full is each tier"; these answer "what exactly is
# in it, and let me fix it". Both matter: a memory the user can only see the
# COUNT of is a memory they cannot correct — and since LONG_TERM is injected
# into every single prompt, one wrong line there poisons every future turn.
#
# The tier policy table has carried `user_editable=True` on LONG_TERM and WIKI
# since C1; this is the control surface that flag was always describing.

def _memory_root(request) -> str:
    """Which workspace a memory request is talking about.

    `?root=` wins so the settings page can browse a workspace other than the
    one this window has open. The fallback is the router's EFFECTIVE workspace,
    not the MemoryLayer's own `_root_dir` — that field is initialised to
    ``os.getcwd()`` and nothing ever moves it, so trusting it made every read
    resolve to the directory the backend happened to be launched from while
    writes were correctly stamped with the real workspace. Entries were being
    saved and then immediately disappearing from the list. `effective_workspace`
    rather than `workspace` for the same reason in reverse: when the user has
    picked nothing, memories belong to the default workspace (`''`), not to
    whatever folder the process was spawned in.

    Note the `is not None` test: `?root=` with an empty value is a deliberate
    request for the default bucket, not a missing parameter. Treating it as
    missing would silently redirect the settings page back to the open folder
    whenever the user selected 默认工作区 in the picker.
    """
    raw = request.query.get("root")
    if raw is not None:
        return raw.strip()
    router: Router = request.app[ROUTER_KEY]
    return router.effective_workspace


async def handle_memory_entry_trace(request):
    """GET /api/memory/entries/{id}/trace — 这一条的来龙去脉。

    §8：用户指着一条记忆问"这凭什么在这儿"，答案要能当场给出。事件按时间升序，
    拿不到可靠时间的（``dated=false``）垫在最后——把"现状"画成时间线上的一个点
    会凭空造出一段没发生过的历史。断言（wiki claim）走同一个入口，id 通用。
    """
    from memory_domain import get_memory_domain
    iid = request.match_info.get("id", "")
    try:
        data = get_memory_domain().trace(iid)
        if not data:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(data)
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def handle_memory_graph(request):
    """GET /api/memory/graph — 获取当前工作区的实体关系图谱 (nodes & edges)。"""
    try:
        router: Router = request.app[ROUTER_KEY]
        root = request.query.get("root") or router.effective_workspace or ""
        st = router.storage
        c = st._db("memory")
        
        entities = c.execute(
            "SELECT id, root_dir, type, name, properties_json, created_at, updated_at "
            "FROM graph_entities WHERE root_dir=? OR root_dir=''",
            (root,)
        ).fetchall()
        
        relations = c.execute(
            "SELECT r.id, r.root_dir, r.source_id, r.target_id, r.relation_type, r.confidence, "
            "s.name as source_name, t.name as target_name "
            "FROM graph_relations r "
            "JOIN graph_entities s ON r.source_id = s.id "
            "JOIN graph_entities t ON r.target_id = t.id "
            "WHERE r.root_dir=? OR r.root_dir=''",
            (root,)
        ).fetchall()
        
        nodes = []
        for e in entities:
            nodes.append({
                "id": e["id"],
                "name": e["name"],
                "type": e["type"],
                "properties": json.loads(e["properties_json"] or "{}"),
                "created_at": e["created_at"],
            })
            
        edges = []
        for r in relations:
            edges.append({
                "id": r["id"],
                "source": r["source_id"],
                "source_name": r["source_name"],
                "target": r["target_id"],
                "target_name": r["target_name"],
                "relation": r["relation_type"],
                "confidence": r["confidence"],
            })
            
        return web.json_response({
            "ok": True,
            "root": root,
            "nodes": nodes,
            "edges": edges,
            "stats": {"total_nodes": len(nodes), "total_edges": len(edges)}
        })
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_memory_graph_triplet_create(request):
    """POST /api/memory/graph/triplets — 手动或自动化插入一条实体关系三元组。"""
    try:
        data = await request.json()
        router: Router = request.app[ROUTER_KEY]
        root = data.get("root") or router.effective_workspace or ""
        subject = data.get("subject")
        predicate = data.get("predicate")
        object_val = data.get("object")
        
        if not subject or not predicate or not object_val:
            return web.json_response({"ok": False, "error": "subject, predicate, object are required"}, status=400)
            
        from memory_layer import get_graph_memory_engine
        graph_engine = get_graph_memory_engine(storage=router.storage)
        rel_id = graph_engine.ingest_triplet(
            root_dir=root,
            subject=subject,
            predicate=predicate,
            object_val=object_val,
            subject_type=data.get("subject_type", "Concept"),
            object_type=data.get("object_type", "Concept"),
            confidence=float(data.get("confidence", 1.0))
        )
        return web.json_response({"ok": True, "relation_id": rel_id})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_memory_budget(request):
    """GET /api/memory/budget — 获取当前工作区长期记忆容量预算与使用率 (Phase 62)。"""
    try:
        router: Router = request.app[ROUTER_KEY]
        root = request.query.get("root") or router.effective_workspace or ""
        st = router.storage
        c = st._db("memory")

        memories = c.execute(
            "SELECT id, content, status, created_at, updated_at FROM memory_entries "
            "WHERE (root_dir=? OR root_dir='') AND status!='archived'",
            (root,)
        ).fetchall()

        from memory_layer import MemoryIndexCapper
        stats = MemoryIndexCapper.get_budget_stats([dict(m) for m in memories])
        stats["root"] = root
        return web.json_response({"ok": True, **stats})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_memory_prune(request):
    """POST /api/memory/prune — 手动或按需触发闲时梦境记忆修剪与陈旧事实证伪 (Phase 62)。"""
    try:
        data = await request.json() if request.can_read_body else {}
        router: Router = request.app[ROUTER_KEY]
        root = data.get("root") or router.effective_workspace or ""
        max_age_days = int(data.get("max_age_days", 180))

        from memory_layer import get_memory_layer
        mem_layer = get_memory_layer(storage=router.storage, root_dir=root)
        report = mem_layer.prune_stale_memories(root_dir=root, max_age_days=max_age_days)

        return web.json_response({"ok": True, **report})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_memory_roots(request):
    """GET /api/memory/roots — workspaces that hold memories, for the picker.


    Union of two sources: the memory table's own DISTINCT root_dir (what is
    actually editable) and the workspace registry (what the user thinks they
    have). A workspace with no memories yet must still be listed, otherwise the
    user cannot add the first one.

    The default workspace (`''`) is always offered. It is where everything lands
    before the user opens a folder, so if it were omitted the picker would have
    no valid target on a fresh install — and the entries already stored there
    would be unreachable while still being injected into every prompt.
    """
    from memory_layer import get_memory_layer
    router: Router = request.app[ROUTER_KEY]
    active = router.effective_workspace

    # Empty-string roots are kept: `''` is a real bucket, not a missing value.
    counts: dict[str, int] = {}
    try:
        for row in get_memory_layer().list_roots():
            counts[str(row.get("root") or "")] = int(row.get("count") or 0)
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程

    known: list[dict] = [{
        "root": "",
        "count": counts.pop("", 0),
        "displayName": "",
        "registered": True,
        "isDefault": True,
    }]
    try:
        for ws in router.storage.list_workspaces(always_include=active) or []:
            path = str(ws.get("path") or "")
            if not path:
                continue  # already emitted above as the default bucket
            known.append({
                "root": path,
                "count": counts.pop(path, 0),
                "displayName": ws.get("display_name") or "",
                "registered": True,
                "isDefault": False,
            })
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程

    # Whatever is left in `counts` has memories but no workspace row — usually a
    # folder that was renamed or un-registered. Surfacing it is the only way to
    # reach those entries, which are still being injected into prompts.
    orphans = [{"root": r, "count": n, "displayName": "",
                "registered": False, "isDefault": False}
               for r, n in sorted(counts.items(), key=lambda kv: -kv[1])]

    return web.json_response({"roots": known + orphans, "active": active})


async def handle_memory_entries(request):
    """List entries with their content. `?tier=`, `?q=`, `?limit=`, `?offset=`, `?root=`, `?status=`."""
    from memory_layer import get_memory_layer
    memory = get_memory_layer()
    tier = request.query.get("tier") or None
    mem_type = request.query.get("type") or None
    query = request.query.get("q") or ""
    # 生命周期状态筛选。不传 = UI 默认集合（活的 + 过期的，不含墓碑）；
    # `status=all` 才会把归档和被否决的也列出来——用户要能把误收的救回来。
    status = request.query.get("status") or None
    root = _memory_root(request)
    try:
        limit = max(1, min(int(request.query.get("limit", "100")), 500))
        offset = max(0, int(request.query.get("offset", "0")))
    except ValueError:
        return web.json_response({"error": "limit/offset must be integers"}, status=400)
    try:
        entries = memory.list_entries(
            tier=tier, query=query, limit=limit, offset=offset, root=root,
            mem_type=mem_type, status=status,
        )
        total = memory.count_entries(tier=tier, query=query, root=root,
                                     mem_type=mem_type, status=status)
        last_dream_at = memory.last_dream_at(root) if mem_type == "dream" else None
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
    body = {"entries": entries, "total": total, "limit": limit, "offset": offset,
            "root": root, "status": status or ""}
    if last_dream_at is not None:
        body["lastDreamAt"] = last_dream_at
    return web.json_response(body)



async def handle_memory_entry_create(request):
    """Add a memory by hand. Defaults to LONG_TERM — the human-owned tier.

    A user typing a memory into the settings page is stating something they want
    remembered permanently; dropping it into SEMANTIC would leave it subject to
    retrieval scoring and it might simply never surface. LONG_TERM is
    always-inject, which is what "I told you to remember this" should mean.
    """
    router: Router = request.app[ROUTER_KEY]
    from memory_layer import get_memory_layer, Memory, MemoryType, MemoryScope
    from memory_tiers import MemoryTier, normalize_tier, policy_for
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    content = str(body.get("content") or "").strip()
    if not content:
        return web.json_response({"error": "content is required"}, status=400)

    tier = normalize_tier(body.get("tier") or MemoryTier.LONG_TERM.value)
    if not policy_for(tier).persisted:
        return web.json_response(
            {"error": f"tier '{tier.value}' is not persisted; pick a durable tier"},
            status=400,
        )

    mem = Memory(
        content=content,
        mem_type=str(body.get("type") or MemoryType.FACT),
        importance=float(body.get("importance") or 0.7),
        scope=MemoryScope.PROJECT,
        # Body `root` lets the settings page add a memory to a workspace other
        # than the one this window has open; otherwise it lands in the current
        # one. Presence, not truthiness — an explicit `""` means the default
        # workspace. Never falls back to the MemoryLayer's cwd-derived default.
        root_dir=(str(body.get("root") or "").strip() if "root" in body
                  else router.effective_workspace),
        tags=list(body.get("tags") or []),
        tier=tier.value,
        # 用户自己打进去的字：写入闸门放宽到只拦秘密 / 注入 / 隐形 Unicode，不拿
        # "这句话里有'可能'"这种启发式去否决她本人的输入。
        created_by="user",
    )

    result = get_memory_layer().store(mem)
    if not result.ok:
        return web.json_response({"error": result.error or "store failed"}, status=500)
    return web.json_response({"id": mem.id, "tier": tier.value, "root": mem.root_dir},
                             status=201)


async def handle_memory_entry_update(request):
    """Edit one memory in place: content / tier / importance / tags / status / confidence.

    状态和置信度走 ``memory_domain``——它们的规则（状态机、置信度区间）在库那一层，
    这里只负责把结果和**拒绝的理由**如实带回去。内容类字段和生命周期字段分开报告，
    因为"内容改了但状态没改成"是一个真实的结果，合成一个 bool 会把它藏起来。
    """
    from memory_layer import get_memory_layer
    from memory_domain import get_memory_domain
    entry_id = request.match_info.get("id") or ""
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    touches_content = any(
        k in body for k in ("content", "tier", "importance", "tags"))
    if touches_content:
        result = get_memory_layer().update_entry(
            entry_id,
            content=body.get("content"),
            tier=body.get("tier"),
            importance=body.get("importance"),
            tags=body.get("tags"),
        )
        if not result.ok:
            err = result.error or "update failed"
            status = 404 if "No such memory" in err else 400
            return web.json_response({"error": err}, status=status)

    out = {"id": entry_id, "updated": True}
    dom = get_memory_domain()

    if "status" in body:
        ok, why = dom.set_status(entry_id, str(body.get("status") or ""),
                                 reason=str(body.get("reason") or "user_edited"))
        out["statusChanged"] = ok
        out["statusReason"] = why
        if not ok:
            # 状态没改成就不能报 200：界面上那个下拉框会停在用户选的值，
            # 而库里根本不是那个状态。
            code = 404 if why == "找不到这一条" else 409
            return web.json_response({"error": why, **out, "updated": touches_content},
                                     status=code)

    if "confidence" in body:
        item = dom.get(entry_id)
        if item is None:
            return web.json_response({"error": "找不到这一条"}, status=404)
        try:
            target = float(body.get("confidence"))
        except (TypeError, ValueError):
            return web.json_response({"error": "confidence must be a number"},
                                     status=400)
        new, why = dom.adjust_confidence(entry_id, target - item.confidence,
                                         reason="user_edited")
        if new < 0:
            return web.json_response({"error": why or "confidence update failed"},
                                     status=404)
        out["confidence"] = new

    if body.get("confirm"):
        ok, why = dom.confirm(entry_id)
        out["confirmed"] = ok
        if why:
            out["confirmNote"] = why

    # 合并提案的裁决。和 status 分开是因为它不是一次单纯的状态变更：批准会连带
    # 归档被替掉的那几条，驳回则保证一条都不动。挤进 status='active' 会让"批准
    # 合并"和"把这条改成生效"看起来是同一个动作，而它们的副作用完全不同。
    if "mergeDecision" in body:
        want = str(body.get("mergeDecision") or "")
        if want not in ("approve", "reject"):
            return web.json_response(
                {"error": "mergeDecision must be 'approve' or 'reject'"}, status=400)
        if want == "approve":
            ok, why = dom.approve_merge(entry_id)
        else:
            ok, why = dom.reject_merge(entry_id)
        out["mergeDecided"] = ok
        out["mergeNote"] = why
        if not ok:
            code = 404 if why == "找不到这一条" else 409
            return web.json_response({"error": why, **out,
                                      "updated": touches_content}, status=code)

    return web.json_response(out)




async def handle_memory_entry_delete(request):
    """Archive one memory. Archive, not DELETE — a mis-click stays recoverable."""
    from memory_layer import get_memory_layer
    entry_id = request.match_info.get("id") or ""
    result = get_memory_layer().forget(entry_id)
    if not result.ok:
        return web.json_response({"error": result.error or "delete failed"}, status=500)
    return web.json_response({"id": entry_id, "archived": True})



async def handle_wiki_claims(request):
    """List wiki claims. `?status=disputed` filters to the adjudication queue.

    root 走 ``_memory_root``，和 ``/api/memory/*`` 用同一个口径。之前这里读的是
    ``router.workspace``，于是设置页切到别的 workspace 之后，记忆列表换了、断言
    列表没换，两个面板在同一屏上说两个 workspace 的事。
    """
    from memory_layer import get_memory_layer
    status = request.query.get("status") or None
    try:
        limit = max(1, min(int(request.query.get("limit", "200")), 1000))
    except (TypeError, ValueError):
        limit = 200
    try:
        wiki = get_memory_layer().wiki
        root = _memory_root(request)
        rows = wiki.list_claims(root, status=status, limit=limit)
        return web.json_response({
            "workspace": root,
            "stats": wiki.stats(root),
            "claims": [c.to_dict() for c in rows],
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)



async def handle_wiki_resolve(request):
    """Adjudicate a contradiction: mark `loserId` superseded by `winnerId`.

    Both ids are required and must differ — "supersede X by X" would flip a
    claim to superseded and leave nothing active, silently dropping the fact.

    走 ``MemoryDomain.resolve_claim`` 而不是直接调 ``wiki.supersede``：裁决必须同时
    退役输的那条**来源记忆**，否则 ⚠冲突 从 wiki 块里没了，而那条记忆还在被召回。
    """
    from memory_domain import get_memory_domain
    from memory_layer import get_memory_layer
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)
    loser = (data.get("loserId") or "").strip()
    winner = (data.get("winnerId") or "").strip()
    if not loser or not winner:
        return web.json_response({"error": "loserId and winnerId required"}, status=400)
    if loser == winner:
        return web.json_response({"error": "loserId must differ from winnerId"}, status=400)
    try:
        wiki = get_memory_layer().wiki
        if wiki.get(loser) is None or wiki.get(winner) is None:
            return web.json_response({"error": "claim not found"}, status=404)
        ok, note = get_memory_domain().resolve_claim(loser, winner)
        if not ok:
            return web.json_response({"error": note}, status=409)
        return web.json_response({
            "loser": wiki.get(loser).to_dict(),
            "winner": wiki.get(winner).to_dict(),
            "note": note,
        })
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def handle_wiki_delete(request):
    """Delete a claim. 默认留墓碑，``?hard=1`` 才真的抹掉。

    和 ``DELETE /api/memory/entries/{id}``（归档而不是删除）对齐：同一个删除按钮
    落在两种知识上应该是同一个意思。以前这里是不可撤销的硬删除，一次误点就什么都
    不剩了。
    """
    from memory_domain import get_memory_domain
    cid = request.match_info.get("id", "")
    hard = str(request.query.get("hard", "")).lower() in ("1", "true", "yes")
    try:
        dom = get_memory_domain()
        if dom.get(cid) is None:
            return web.json_response({"error": "claim not found"}, status=404)
        ok, why = dom.delete(cid, reason="user_deleted", hard=hard)
        if not ok:
            return web.json_response({"error": why}, status=409)
        return web.json_response({"deleted": cid, "hard": hard, "note": why})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def handle_memory_dream_runs(request):
    """Dream 日记（§10.2 的 DreamJournal）：每一趟整合做了什么、为什么没做。

    刻意把 failed / cancelled / noop 一起返回。只列成功的整合会让"它到底有没有在
    工作"变成不可回答的问题——而这恰恰是用户对一个后台自进化功能最想知道的事。
    """
    from storage import get_storage
    root = _memory_root(request)
    try:
        limit = max(1, min(int(request.query.get("limit", "20")), 200))
    except (TypeError, ValueError):
        limit = 20
    try:
        rows = get_storage().list_dream_runs(root, limit=limit) or []
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
    now = int(time.time())
    return web.json_response({
        "root": root,
        "runs": [{
            "jobId": r.get("job_id") or "",
            "status": r.get("status") or "",
            # 一趟"还在跑"但租约已经过期，就是它的进程死了。两个字段都给出来，
            # 界面才能说"上次那趟没跑完"而不是永远显示"正在整理"。
            "stale": (str(r.get("status")) == "running"
                      and int(r.get("lease_until") or 0) <= now),
            "outcome": r.get("outcome") or "",
            "proposalId": r.get("proposal_id") or "",
            "startedAt": int(r.get("started_at") or 0),
            "finishedAt": int(r.get("finished_at") or 0),
            "inputCount": int(r.get("input_count") or 0),
            "tokensUsed": int(r.get("tokens_used") or 0),
            "wallMs": int(r.get("wall_ms") or 0),
        } for r in rows],
    })


async def handle_memory_conflicts(request):

    """需要人裁决的三件事：分歧、内容重复的活记忆、Dream 提的合并。

    统一形状（``memory_domain.MemoryItem.to_api``）而不是各自的原生形状：界面上
    "这两条打架"和"这两条是同一件事"应该长得一样，用户不需要先知道它躺在哪张表里。
    """

    from memory_domain import get_memory_domain
    root = _memory_root(request)
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 500))
    except (TypeError, ValueError):
        limit = 50
    try:
        dom = get_memory_domain()
        groups = dom.conflicts(root, limit=limit)
        dups = dom.duplicates(root, limit=limit)
        merges = dom.pending_merges(root, limit=limit)
        return web.json_response({
            "root": root,
            "conflicts": [
                {"claim": g["claim"].to_api(),
                 "peers": [p.to_api() for p in g["peers"]]}
                for g in groups
            ],
            "duplicates": [[i.to_api() for i in g] for g in dups],
            "pendingMerges": [
                {"proposal": m["proposal"].to_api(),
                 "sources": [s.to_api() for s in m["sources"]]}
                for m in merges
            ],
            "stats": dom.stats(root),
        })

    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)



# ─── MCP servers ────────────────────────────────────────────────
#
# Mirrors how mainstream MCP clients manage servers: a named map of
# {command, args, env, disabled} the user can paste between apps. We persist
# into config.json under `mcpServers` (the exact key those apps use) so a
# config is portable in both directions.
#
# Adding a server is a config write + a subprocess spawn, so the POST both
# persists AND connects — a saved-but-dead entry is a worse experience than an
# immediate red status the user can act on.


def _mcp_config_block() -> dict:
    """The live `mcpServers` map, created on first use."""
    return _CONFIG.setdefault("mcpServers", {})


async def handle_mcp_list(request):
    """List configured MCP servers with live connection status + tool counts."""
    from mcp_manager import get_mcp_manager
    mgr = get_mcp_manager()
    return web.json_response({
        "available": mgr.available,
        "importError": mgr.import_error,
        "servers": mgr.list_servers(),
    })


async def handle_mcp_upsert(request):
    """Add or update one server, persist to config.json, then connect it.

    Body for a local server: ``{name, command, args?, env?, disabled?, timeout?}``.
    Body for a remote server: ``{name, url, type?, headers?, disabled?,
    disabledTools?, auth?}``. ``auth`` is ``{type: "oauth2", tokenUrl,
    clientId, clientSecret, scopes}`` — the secret is encrypted at rest
    (``enc:`` prefix) before config.json is written.
    Also accepts a full industry-style paste: ``{mcpServers: {...}}``.
    """
    from mcp_manager import get_mcp_manager, MCPServerConfig, MCPServerConnection
    from tools import get_tool_registry

    def _seal_auth_secret(entry: dict) -> dict:
        """Persist-time credential hygiene: an auth.client_secret that arrives
        as plaintext is encrypted before it ever touches disk. Already-protected
        values (``enc:`` / ``env:`` / ``plain:``) pass through untouched —
        re-encrypting an ``enc:`` value would double-wrap it into garbage."""
        auth = entry.get("auth")
        if not isinstance(auth, dict):
            return entry
        secret = str(auth.get("client_secret") or "")
        if secret and not secret.startswith(("enc:", "env:", "plain:")):
            try:
                from model_registry import CredentialCipher
                auth = {**auth, "client_secret": CredentialCipher().encrypt(secret)}
            except Exception:
                pass  # 加密不可用 → 原样落盘，但 fail-open 优于让整个 upsert 失败
        return {**entry, "auth": auth}

    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    def _endpoint_error(entry: dict) -> str:
        """One entry is valid if it says WHERE the server is: a local command or
        a remote url. Checking `command` alone used to reject every http/sse
        entry with a nonsense "command required"."""
        if not isinstance(entry, dict):
            return "invalid: object expected"
        if (entry.get("command") or "").strip():
            return ""
        if (entry.get("url") or entry.get("serverUrl") or "").strip():
            return ""
        return "invalid: command or url required"

    # Accept a wholesale `mcpServers` paste so users can drop in a standard config.
    incoming = body.get("mcpServers")
    if isinstance(incoming, dict) and incoming:
        entries = incoming
    else:
        name = (body.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "name required"}, status=400)
        err = _endpoint_error(body)
        if err:
            return web.json_response({"error": "command or url required"}, status=400)
        entries = {name: {k: v for k, v in body.items() if k != "name"}}

    mgr = get_mcp_manager()
    block = _mcp_config_block()
    results: dict = {}
    for name, entry in entries.items():
        err = _endpoint_error(entry)
        if err:
            results[name] = err
            continue
        entry = _seal_auth_secret(entry)
        block[name] = entry
        cfg = MCPServerConfig.from_dict(name, entry)
        # Replace any existing connection so a changed command takes effect
        # instead of silently keeping the old subprocess alive.
        old = mgr.get_server(name)
        if old is not None:
            await old.stop()
        conn = MCPServerConnection(cfg, get_tool_registry())
        mgr._servers[name] = conn
        await conn.start()
        results[name] = conn.status

    _persist_config()
    return web.json_response({"results": results, "servers": mgr.list_servers()})


async def handle_mcp_delete(request):
    """Stop a server, drop its tools, and remove it from config.json."""
    from mcp_manager import get_mcp_manager
    name = request.match_info.get("name", "")
    mgr = get_mcp_manager()
    conn = mgr.get_server(name)
    if conn is None and name not in _mcp_config_block():
        return web.json_response({"error": "server not found"}, status=404)
    if conn is not None:
        await conn.stop()
        mgr._servers.pop(name, None)
    _mcp_config_block().pop(name, None)
    _persist_config()
    return web.json_response({"deleted": name, "servers": mgr.list_servers()})


async def handle_mcp_toggle(request):
    """Enable or disable a server. Body: ``{"enabled": bool}``."""
    from mcp_manager import get_mcp_manager
    name = request.match_info.get("name", "")
    try:
        body = await request.json()
    except json.JSONDecodeError:
        body = {}
    enabled = bool(body.get("enabled", True))

    mgr = get_mcp_manager()
    if mgr.get_server(name) is None:
        return web.json_response({"error": "server not found"}, status=404)
    status = await (mgr.enable(name) if enabled else mgr.disable(name))

    # Mirror the flag into config.json so the choice survives a restart.
    entry = _mcp_config_block().get(name)
    if isinstance(entry, dict):
        entry["disabled"] = not enabled
        _persist_config()
    return web.json_response({"name": name, "status": status, "servers": mgr.list_servers()})


async def handle_mcp_restart(request):
    """Restart one server — the fix for "it crashed" and "I changed its env"."""
    from mcp_manager import get_mcp_manager
    name = request.match_info.get("name", "")
    mgr = get_mcp_manager()
    if mgr.get_server(name) is None:
        return web.json_response({"error": "server not found"}, status=404)
    status = await mgr.restart(name)
    return web.json_response({"name": name, "status": status, "servers": mgr.list_servers()})


# ─── Channel gateway（通用 HMAC webhook 渠道，channel_gateway.py） ────────
#
# 与 feishu/dingtalk/wecom 三个厂商 webhook 互补：任何能发出站 webhook 的
# IM 机器人按开放的 HMAC 约定接入。untrusted 渠道消息只落审计与邮箱，
# 绝不直接驱动 agent —— 安装≠信任的渠道版。

async def handle_channels_list(request):
    from channel_gateway import list_channels
    return web.json_response({"channels": list_channels()})


async def handle_channel_upsert(request):
    from channel_gateway import upsert_channel
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)
    name = str(body.get("id") or body.get("name") or "").strip()
    if not name:
        return web.json_response({"error": "id required"}, status=400)
    entry = {k: v for k, v in body.items() if k not in ("id", "name")}
    err = upsert_channel(name, entry)
    if err:
        return web.json_response({"error": err}, status=400)
    return web.json_response({"id": name, "ok": True})


async def handle_channel_delete(request):
    from channel_gateway import remove_channel
    name = request.match_info.get("name", "")
    if not remove_channel(name):
        return web.json_response({"error": "channel not found"}, status=404)
    return web.json_response({"id": name, "removed": True})


async def handle_channel_inbound(request):
    """第三方系统的出站 webhook 落点。签名失败 401、未信任渠道 202 只入队。"""
    from channel_gateway import handle_inbound
    from session_host import get_session_host
    body = await request.read()
    headers = {k: v for k, v in request.headers.items()}
    host = get_session_host()
    if host is None:
        return web.json_response({"error": "session host unavailable"}, status=503)
    status, payload = await handle_inbound(
        host, request.match_info.get("name", ""), headers, body)
    return web.json_response(payload, status=status)


async def handle_skills_relock(request):
    """POST /api/skills/relock — 以当前磁盘内容重建技能完整性基线。

    这是用户确认"改动出自我本人"之后的显式动作（对应 skills.lock 的
    「重新锁定」语义）：对技能发现根下每个已落盘技能重算 sha256 并写回
    锁文件。不做静默覆盖——装载期校验报篡改警告 → 用户裁决 → 点重锁，
    警告才消失。
    """
    import os as _os
    import skill_integrity
    here = _os.path.dirname(_os.path.abspath(__file__))
    project = _os.path.abspath(_os.path.join(here, "..", ".."))
    roots = [
        _os.path.join(project, ".agents", "skills"),
        _os.path.join(project, "skills"),
        _os.path.expanduser(_os.path.join("~", ".agents", "skills")),
    ]
    locked = []
    for root in roots:
        if not _os.path.isdir(root):
            continue
        for name in sorted(_os.listdir(root)):
            skill_dir = _os.path.join(root, name)
            if not _os.path.isfile(_os.path.join(skill_dir, "SKILL.md")):
                continue
            entry = skill_integrity.write_lock_entry(name, skill_dir)
            if entry.get("files"):
                locked.append(name)
    return web.json_response({"locked": locked,
                              "lockPath": skill_integrity._lock_path()})


async def handle_outbound_settings_get(request):
    """GET /api/network/outbound — 出站设置现状（Tavily key 只回掩码）。"""
    import web_outbound
    s = web_outbound.get_outbound_settings()
    key = s.get("tavily_key") or ""
    masked = ("•" * (max(len(key) - 4, 0)) + key[-4:]) if len(key) > 4 else ("••••" if key else "")
    return web.json_response({
        "proxyUrl": s.get("proxy_url") or "",
        "tavilyConfigured": bool(key),
        "tavilyKeyMasked": masked,
    })


async def handle_outbound_settings_put(request):
    """PUT /api/network/outbound — 保存出站设置并立即生效（无缓存进程）。

    Body: ``{proxyUrl?: str, tavilyKey?: str}``。字段缺省 = 不动该项；
    空串 = 清除该项。Tavily key 是凭据：落库前经 CredentialCipher 加密，
    读取面（GET）永远只回掩码——与 bot config 的密钥纪律一致。
    """
    import web_outbound
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)
    proxy = body.get("proxyUrl")
    key = body.get("tavilyKey")
    if proxy is not None and not isinstance(proxy, str):
        return web.json_response({"error": "proxyUrl must be a string"}, status=400)
    if key is not None and not isinstance(key, str):
        return web.json_response({"error": "tavilyKey must be a string"}, status=400)
    if proxy is not None and proxy.strip():
        p = proxy.strip()
        if not p.startswith(("http://", "https://", "socks4://", "socks5://")):
            return web.json_response(
                {"error": "proxyUrl must start with http:// https:// socks4:// or socks5://"},
                status=400)
    try:
        web_outbound.set_outbound_settings(proxy_url=proxy, tavily_key=key)
    except Exception as exc:
        return web.json_response({"error": f"persist failed: {exc}"}, status=500)
    return handle_outbound_settings_get(request)


async def handle_network_policy_get(request):
    """上网权限现状（设置页「上网权限」组）。"""
    from command_classifier import get_egress_policy
    p = get_egress_policy()
    return web.json_response({
        "mode": p.mode,          # open=默认放行 / closed=仅限白名单
        "allow": list(p.allow),
        "deny": list(p.deny),
    })


async def handle_permissions_overview(request):
    """统一权限总览——四个审批相关配置族的现状，一个 payload。

    纯聚合，不引入任何新授权语义：各族执法点原地不动（网络在 command_guard、
    文件操作在 path_policy/sandbox、命令规则在 RiskController、定时任务在
    工具权限档位）。这个端点存在的理由：四族散在四处，用户永远无法在一屏
    之内回答"我的 agent 现在到底被允许做什么"。
    """
    router: Router = request.app[ROUTER_KEY]
    storage = router.storage
    workspace = getattr(router, "workspace", "") or ""

    from command_classifier import get_egress_policy
    net = get_egress_policy()

    file_policy = None
    if workspace:
        try:
            from path_policy import load_policy
            file_policy = load_policy(workspace).summary()
        except Exception:
            file_policy = None  # 策略读不到按缺项上报，不让整个请求失败

    rules = []
    try:
        from permission_rules import get_permission_rules
        rules = [
            {
                "toolName": r.tool_name,
                "pattern": r.pattern,
                "behavior": (r.behavior.value if hasattr(r.behavior, "value")
                             else str(r.behavior)),
                "scope": (r.scope.value if hasattr(r.scope, "value")
                          else str(r.scope)),
                "note": r.note,
            }
            for r in get_permission_rules().list()
        ]
    except Exception:
        rules = []

    active_cron = -1  # -1 = 查不到（表缺失等），与 0（确实没有）区分
    try:
        row = storage._db("cron").execute(
            "SELECT COUNT(*) AS c FROM cron_jobs WHERE status='active'"
        ).fetchone()
        active_cron = int(row["c"]) if row else 0
    except Exception:
        pass

    # 定时任务的档位语义：permission 非空 = 到期回合固定用这个档位；空 =
    # 继承任务所属会话的当前档位（执法点在 cron 到期回合的 router.handle，
    # 见 create_server 里的 _cron_turn_handler）。
    try:
        sched_cfg = (_CONFIG or {}).get("permissions", {}).get("scheduled", {}) or {}
    except Exception:
        sched_cfg = {}

    return web.json_response({
        "network": {"mode": net.mode, "allow": list(net.allow),
                    "deny": list(net.deny)},
        "fileOp": file_policy,
        "commandRules": rules,
        "scheduled": {
            "activeJobs": active_cron,
            "permission": str(sched_cfg.get("permission", "") or ""),
        },
    })


async def handle_network_policy_put(request):
    """保存上网权限并热生效（无需重启）。

    Body: ``{mode: "open"|"closed", allow: [域名...], deny: [域名...]}``。
    域名统一小写、去空白；命中语义（含子域名）由 command_classifier 定义。
    """
    from command_classifier import reload_egress_policy
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)

    mode = str(body.get("mode") or "open").strip().lower()
    if mode not in ("open", "closed"):
        return web.json_response({"error": "mode must be open or closed"}, status=400)

    def _clean(values) -> list:
        out, seen = [], set()
        for v in values or []:
            s = str(v).strip().lower().lstrip("*.").rstrip(".")
            if s and s not in seen and re.fullmatch(r"[a-z0-9.-]+", s):
                seen.add(s)
                out.append(s)
        return out

    entry = {
        "mode": mode,
        "allow": _clean(body.get("allow")),
        "deny": _clean(body.get("deny")),
    }
    _CONFIG.setdefault("permissions", {})["network"] = entry
    try:
        _persist_config()
    except OSError as exc:
        return web.json_response({"error": f"cannot persist config: {exc}"}, status=500)
    p = reload_egress_policy()
    return web.json_response({
        "mode": p.mode, "allow": list(p.allow), "deny": list(p.deny), "saved": True,
    })




# ─── Git panel (GIT_INTEGRATION.md §1.1) ────────────────────────
#
# Read-only by design. Staging / committing / pushing stay on the agent tool
# path so risk_control still grades and confirms them — a REST "commit" button
# would route around the guardrails entirely.


async def _git_router(request):
    """The Router whose workspace this git request is about.

    Every window is its own session with its own workspace, and a user with three
    windows open on three projects must see three different SCM panels — that is
    how mainstream IDEs behave and there is no defensible reason to
    differ. So the caller passes ``session_id`` and we resolve THAT session's
    Router.

    ``app[ROUTER_KEY]`` (the primary session) is only the fallback, for a request
    that arrives before the window has announced its session. Relying on it
    unconditionally — which is what this module used to do — meant window B's
    panel silently described window A's folder.
    """
    sid = request.query.get("session_id") or request.query.get("sessionId") or ""
    if not sid and request.method in ("POST", "PUT", "PATCH"):
        # Body-carried session id for the mutating routes. Read it non-
        # destructively: aiohttp caches the parsed JSON, so the handler's own
        # ``await request.json()`` still works after this.
        try:
            body = await request.json()
            sid = str(body.get("session_id") or body.get("sessionId") or "")
        except Exception:
            sid = ""
    if sid:
        try:
            from session_host import get_session_host
            host = get_session_host()
            if host is not None:
                router = host.get(sid)
                if router is not None:
                    return router
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
    return request.app[ROUTER_KEY]

#: Generic alias — the resolution itself has nothing to do with git; any
#: session-scoped handler (token analytics, …) reads better against a neutral
#: name than `_git_router`.
_router_for_request = _git_router

def _git_proc(repo: str, args: list[str], timeout: int = 60):
    """Run git and return the CompletedProcess — caller checks returncode.

    One argv prefix for every git invocation from this module:
    ``core.quotePath=false`` keeps non-ASCII paths raw, ``--no-optional-locks``
    keeps read-only probes from touching ``index.lock`` (the flag VS Code's
    git extension passes for the same reason).
    """
    import subprocess
    return subprocess.run(
        ["git", "-c", "core.quotePath=false", "--no-optional-locks"] + args,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=repo, timeout=timeout,
    )


def _git_out_sync(repo: str, args: list[str]) -> str:
    """Run git and return stdout as a UTF-8 string, or "" on any failure.

    ``encoding='utf-8'`` is load-bearing on Chinese Windows: the default text
    mode uses ``locale.getpreferredencoding()`` which is CP936/GBK there, so any
    non-ASCII commit subject, branch, or filename crashes with
    ``UnicodeDecodeError`` (git writes UTF-8) and the whole handler falls into
    the ``except: return ""`` — the frontend then thinks the folder isn't a repo
    and hides all the git UI. ``core.quotePath=false`` keeps non-ASCII filenames
    in ``git status`` raw (no ``"\346…"`` C-escapes) so the porcelain parser
    doesn't have to unescape them.
    """
    import subprocess
    try:
        proc = _git_proc(repo, args, timeout=15)
        if proc.returncode != 0:
            # Log at debug — this is called on every panel refresh, we don't
            # want a red "not a repo" line every second. But without ANY log
            # a broken git is invisible; a single-line stderr snippet is enough
            # to diagnose from the app log.
            import logging
            logging.getLogger(__name__).debug(
                "git %s exited %d: %s", args[:2], proc.returncode,
                (proc.stderr or "").strip()[:200],
            )
            return ""
        # rstrip only — ``str.strip()`` would eat the leading space on the first
        # ``git status --porcelain`` line (`` M file`` → ``M file``), which
        # corrupts path parsing into ``HANGELOG…`` and flips staged flags.
        return proc.stdout.rstrip("\r\n")
    except FileNotFoundError:
        # git not on PATH. Log ONCE per process so it isn't spammy.
        import logging
        logging.getLogger(__name__).warning("git executable not found on PATH")
        return ""
    except subprocess.TimeoutExpired:
        import logging
        logging.getLogger(__name__).warning("git %s timed out after 15s", args[:2])
        return ""
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("git %s raised %r", args[:2], e)
        return ""


async def _git_out(repo: str, args: list[str]) -> str:
    """Async face of :func:`_git_out_sync`.

    A single status snapshot spawns 7-9 git processes at up to 15s each; the
    sync version called straight from an ``async def`` handler blocked the
    event loop for the whole run — WS token streaming and every other request
    queued behind it. Every git subprocess now leaves the loop via to_thread.
    """
    return await asyncio.to_thread(_git_out_sync, repo, args)


async def _git_proc_async(repo: str, args: list[str], timeout: int = 60):
    """Thread-pool :func:`_git_proc` for mutating commands (restore/commit/push)."""
    return await asyncio.to_thread(_git_proc, repo, args, timeout)


async def _git_branch_label(repo: str) -> str:
    """Branch name for display. ``--abbrev-ref`` prints the literal ``HEAD``
    when detached; showing ``(a1b2c3d)`` instead is what every git GUI does."""
    branch = await _git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    if branch == "HEAD":
        short = await _git_out(repo, ["rev-parse", "--short", "HEAD"])
        return f"({short})" if short else "HEAD"
    return branch


def _unquote_porcelain_path(p: str) -> str:
    """git wraps a path in double quotes when it still contains bytes it must
    escape (a literal quote, newline, etc.) even with ``core.quotePath=false``.
    Strip the wrapping quotes so the frontend shows a clean path. Non-quoted
    paths pass through untouched."""
    p = p.strip()
    if len(p) >= 2 and p[0] == '"' and p[-1] == '"':
        inner = p[1:-1]
        # Only the two escapes git uses inside a quoted path here.
        return inner.replace('\\"', '"').replace("\\\\", "\\")
    return p


def _parse_porcelain(lines: list[str]) -> list[dict]:
    """Turn ``git status --porcelain`` lines into a changes tree (doc §1.1).

    Porcelain v1 is ``XY PATH`` (two status chars + space + path). Renames and
    copies appear as ``R  old -> new`` / ``C  old -> new`` — we keep the
    right-hand (destination) path. With ``core.quotePath=false`` (set in
    ``_git_out``) non-ASCII paths arrive raw; only paths with genuinely special
    bytes stay quoted, which ``_unquote_porcelain_path`` unwraps.
    """
    kinds = {"M": "modified", "A": "added", "D": "deleted",
             "R": "renamed", "C": "copied", "?": "untracked", "U": "conflicted"}
    changes = []
    for line in lines:
        if len(line) < 4:
            continue
        index, worktree = line[0], line[1]
        rest = line[3:]
        # Rename/copy: "old -> new". Split on the LAST " -> " so an arrow inside
        # the old name can't truncate the real destination.
        if " -> " in rest:
            rest = rest.rsplit(" -> ", 1)[-1]
        path = _unquote_porcelain_path(rest)
        # Untracked is ``?? path`` — treat as unstaged untracked.
        code = index if index not in (" ", "?") else worktree
        if index == "?" and worktree == "?":
            code = "?"
        changes.append({
            "path": path,
            "kind": kinds.get(code, "modified"),
            "staged": index not in (" ", "?"),
        })
    return changes


#: Untracked-line counting caps: a freshly created ``node_modules`` must not
#: turn the status poll into a filesystem crawl.
_UNTRACKED_FILES_CAP = 50
_UNTRACKED_BYTES_CAP = 512 * 1024


def _untracked_additions_sync(repo: str, paths: list[str]) -> int:
    """Non-empty line count of untracked files, capped.

    A ``?? dir/`` porcelain entry (whole directory untracked) is walked under
    the same file cap. Unreadable or oversized files contribute 0 —
    best-effort is the contract.
    """
    import os as _os
    total = 0
    budget = _UNTRACKED_FILES_CAP

    def count_file(full: str) -> int:
        try:
            if _os.path.getsize(full) > _UNTRACKED_BYTES_CAP:
                return 0
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                return sum(1 for ln in f if ln.strip())
        except OSError:
            return 0

    for p in paths:
        if budget <= 0:
            break
        full = _os.path.join(repo, p)
        if _os.path.isdir(full):
            for root, _dirs, files in _os.walk(full):
                for name in files:
                    if budget <= 0:
                        break
                    budget -= 1
                    total += count_file(_os.path.join(root, name))
                if budget <= 0:
                    break
        elif _os.path.isfile(full):
            budget -= 1
            total += count_file(full)
    return total


def _clean_numstat_path(p: str) -> str:
    p = p.strip()
    if " => " in p:
        import re
        p = re.sub(r'\{.*?=>\s*(.*?)\}', r'\1', p)
        if " => " in p:
            p = p.split(" => ")[-1]
        p = p.replace("//", "/")
    return p.strip()


def _untracked_additions_detailed_sync(repo: str, paths: list[str]) -> dict[str, int]:
    """Non-empty line count per untracked path (file or dir), capped."""
    import os as _os
    per_path: dict[str, int] = {}
    budget = _UNTRACKED_FILES_CAP

    def count_file(full: str) -> int:
        try:
            if _os.path.getsize(full) > _UNTRACKED_BYTES_CAP:
                return 0
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                return sum(1 for ln in f if ln.strip())
        except OSError:
            return 0

    for p in paths:
        if budget <= 0:
            break
        full = _os.path.join(repo, p)
        if _os.path.isdir(full):
            d_total = 0
            for root, _dirs, files in _os.walk(full):
                for name in files:
                    if budget <= 0:
                        break
                    budget -= 1
                    d_total += count_file(_os.path.join(root, name))
                if budget <= 0:
                    break
            per_path[p] = d_total
        elif _os.path.isfile(full):
            budget -= 1
            per_path[p] = count_file(full)
    return per_path


async def _git_diffstat_detailed(repo: str, untracked_paths: list[str]) -> tuple[int, int, dict[str, tuple[int, int]]]:
    """Detailed diffstat returning (total_additions, total_deletions, per_file_map)."""
    per_file: dict[str, tuple[int, int]] = {}
    numstat = await _git_out(repo, ["diff", "--numstat", "HEAD"])
    if not numstat:
        numstat = await _git_out(repo, ["diff", "--numstat"])
        staged = await _git_out(repo, ["diff", "--cached", "--numstat"])
        if staged:
            numstat = (numstat + "\n" + staged).strip()

    for line in numstat.split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        try:
            a = 0 if parts[0] == "-" else int(parts[0])
            d = 0 if parts[1] == "-" else int(parts[1])
        except ValueError:
            continue
        if len(parts) >= 3:
            raw_path = parts[2].strip()
            clean_path = _clean_numstat_path(raw_path).replace("\\", "/")
            cur_a, cur_d = per_file.get(clean_path, (0, 0))
            per_file[clean_path] = (cur_a + a, cur_d + d)

    untracked_map = await asyncio.to_thread(_untracked_additions_detailed_sync, repo, untracked_paths)
    for p, count in untracked_map.items():
        norm_p = p.replace("\\", "/")
        cur_a, cur_d = per_file.get(norm_p, (0, 0))
        per_file[norm_p] = (cur_a + count, cur_d)

    total_additions = sum(a for a, _ in per_file.values())
    total_deletions = sum(d for _, d in per_file.values())
    return total_additions, total_deletions, per_file


async def _git_diffstat(repo: str, untracked_paths: list[str]) -> tuple[int, int]:
    """Sum additions/deletions from staged+unstaged diffs."""
    total_a, total_d, _ = await _git_diffstat_detailed(repo, untracked_paths)
    return total_a, total_d


async def handle_shadow_status(request):
    """GET /api/shadow/{sessionId}/status — staged overlay summary."""
    session_id = request.match_info.get("sessionId", "")
    workspace = (request.rel_url.query.get("workspace") or "").strip()
    if not session_id:
        return web.json_response({"error": "sessionId required"}, status=400)
    try:
        from shadow_session import status as shadow_status
        if not workspace:
            router = request.app.get(ROUTER_KEY)
            workspace = getattr(router, "workspace", "") if router else ""
        return web.json_response(shadow_status(session_id, workspace))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def handle_shadow_validate(request):
    """POST /api/shadow/{sessionId}/validate — run full validation on staged overlay."""
    session_id = request.match_info.get("sessionId", "")
    body = await request.json() if request.can_read_body else {}
    workspace = str(body.get("workspace") or request.rel_url.query.get("workspace") or "").strip()
    if not session_id:
        return web.json_response({"error": "sessionId required"}, status=400)
    try:
        from shadow_session import get_session, ensure_session
        from shadow_workspace import validate_workcopy
        if not workspace:
            router = request.app.get(ROUTER_KEY)
            workspace = getattr(router, "workspace", "") if router else ""
        wc = get_session(session_id) or ensure_session(session_id, workspace)
        report = validate_workcopy(wc, workspace)
        return web.json_response(report.to_dict())
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def handle_shadow_apply(request):
    """POST /api/shadow/{sessionId}/apply — merge staged overlay into workspace."""
    session_id = request.match_info.get("sessionId", "")
    body = await request.json() if request.can_read_body else {}
    workspace = str(body.get("workspace") or "").strip()
    if not session_id:
        return web.json_response({"error": "sessionId required"}, status=400)
    try:
        from shadow_session import get_session, apply_session
        from shadow_workspace import validate_workcopy
        if not workspace:
            router = request.app.get(ROUTER_KEY)
            workspace = getattr(router, "workspace", "") if router else ""
        wc = get_session(session_id)
        if wc is None:
            return web.json_response({"error": "no staged overlay"}, status=404)
        report = validate_workcopy(wc, workspace)
        if not report.ok:
            return web.json_response({
                "error": "validation failed",
                "report": report.to_dict(),
            }, status=409)
        result = apply_session(session_id)
        return web.json_response({"ok": True, "merge": result})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def handle_shadow_discard(request):
    """POST /api/shadow/{sessionId}/discard — drop staged overlay without merging."""
    session_id = request.match_info.get("sessionId", "")
    if not session_id:
        return web.json_response({"error": "sessionId required"}, status=400)
    try:
        from shadow_session import discard_session
        discard_session(session_id)
        return web.json_response({"ok": True})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


async def _resolve_git_repo(request) -> tuple[Optional[str], Any, Optional[dict]]:
    """Resolve the active workspace repository for this request's session.

    Enforces two invariant rules:
    1. If the current session has no explicit workspace (or is in "默认工作区"),
       no repository is open (workspaceOpen=False, isGitRepository=False).
    2. If a workspace is open, it is only considered a Git repository if it is
       itself a git root (contains .git or git rev-parse --show-toplevel matches
       the workspace directory itself). It must NEVER inherit an ancestor git
       tree (such as the Ovolve host development source repository).
    """
    router = await _git_router(request)
    sid = request.query.get("session_id") or request.query.get("sessionId") or getattr(router, "session_id", "")
    if not sid and request.method in ("POST", "PUT", "PATCH"):
        try:
            body = await request.json()
            sid = str(body.get("session_id") or body.get("sessionId") or "")
        except Exception:
            sid = ""

    # Check session-level workspace in storage
    if sid and hasattr(router, "storage") and router.storage:
        try:
            sess = router.storage.get_session(sid)
            if sess is not None:
                ws = (sess.get("workspace") or "").strip()
                if not ws:
                    return None, router, {"isGitRepository": False, "workspaceOpen": False}
        except Exception:
            pass

    # Check router-level workspace
    if not getattr(router, "workspace_selected", False):
        return None, router, {"isGitRepository": False, "workspaceOpen": False}

    effective_ws = getattr(router, "effective_workspace", "")
    if not effective_ws:
        return None, router, {"isGitRepository": False, "workspaceOpen": False}

    repo = getattr(router, "workspace", "")
    if not repo or not os.path.isdir(repo):
        return None, router, {"isGitRepository": False, "workspaceOpen": False}

    # Verify git work tree
    if not (await _git_out(repo, ["rev-parse", "--is-inside-work-tree"]) == "true"):
        return None, router, {"isGitRepository": False, "workspaceOpen": True}

    # Verify that the workspace is itself the top-level of the repository,
    # or contains .git directly, preventing ancestor repository leakage.
    toplevel = await _git_out(repo, ["rev-parse", "--show-toplevel"])
    has_git = os.path.exists(os.path.join(repo, ".git"))
    is_root = False
    if toplevel:
        try:
            is_root = (os.path.abspath(toplevel).lower() == os.path.abspath(repo).lower())
        except Exception:
            is_root = False

    if not (has_git or is_root):
        return None, router, {"isGitRepository": False, "workspaceOpen": True}

    return repo, router, None


async def handle_git_status(request):
    """Structured git snapshot for the Git panel / chat header."""
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        return web.json_response(err)

    # ``-z``: NUL-separated entries, so a filename containing a newline can't
    # split one path into two records. Rename/copy entries emit TWO fields
    # (destination, then source) — we keep the destination, skip the source.
    porcelain = await _git_out(repo, ["status", "--porcelain", "-u", "-z"])
    lines: list[str] = []
    untracked: list[str] = []
    entries = porcelain.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        lines.append(entry)
        if entry[0] == "?" and entry[1] == "?":
            untracked.append(_unquote_porcelain_path(entry[3:]))
        if entry[0] in ("R", "C") and i < len(entries):
            i += 1  # skip the rename source field

    # No-upstream and fully-synced both used to read 0/0 — tell them apart so
    # the UI can show "no upstream" instead of a lying "in sync".
    upstream = await _git_out(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"])
    has_upstream = bool(upstream)
    ahead = behind = 0
    if has_upstream:
        ahead_behind = await _git_out(
            repo, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
        try:
            parts = ahead_behind.split()
            behind, ahead = int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            ahead = behind = 0
    additions, deletions, per_file = await _git_diffstat_detailed(repo, untracked)
    changes = _parse_porcelain(lines)
    for c in changes:
        p = c["path"].replace("\\", "/")
        a, d = per_file.get(p, (0, 0))
        if not (a or d):
            if p.endswith("/"):
                a, d = per_file.get(p.rstrip("/"), (0, 0))
            else:
                a, d = per_file.get(p + "/", (0, 0))
        c["additions"] = a
        c["deletions"] = d

    return web.json_response({
        "isGitRepository": True,
        "workspaceOpen": True,
        "branch": await _git_branch_label(repo),
        "user": await _git_out(repo, ["config", "user.name"]),
        "ahead": ahead,
        "behind": behind,
        "hasUpstream": has_upstream,
        "status": "dirty" if lines else "clean",
        "changes": changes,
        "additions": additions,
        "deletions": deletions,
        "recentCommits": [
            l for l in (await _git_out(repo, ["log", "--oneline", "-n", "10"])).split("\n") if l.strip()
        ],
    })


async def handle_git_diff(request):
    """GET /api/git/diff?path=<rel_path>&session_id=<sid>
    
    Returns structured file diff and content:
    - path: relative file path
    - diff: unified diff string
    - targetContent: original file content (at HEAD or empty if untracked)
    - replacementContent: working tree file content
    - additions: line addition count
    - deletions: line deletion count
    - isUntracked: boolean
    """
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        return web.json_response(err)

    rel_path = (request.query.get("path") or "").strip().replace("\\", "/").lstrip("/")
    full_path = os.path.join(repo, rel_path.replace("/", os.sep)) if rel_path else ""

    is_untracked = False
    if rel_path:
        porcelain = await _git_out(repo, ["status", "--porcelain", "-u", "-z", "--", rel_path])
        if porcelain.startswith("??"):
            is_untracked = True

    diff_text = ""
    old_content = ""
    new_content = ""
    additions = 0
    deletions = 0

    if is_untracked:
        if full_path and os.path.isfile(full_path):
            try:
                with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                    new_content = f.read()
                lines = new_content.splitlines()
                additions = len(lines)
                diff_text = f"--- /dev/null\n+++ b/{rel_path}\n@@ -0,0 +1,{max(1, additions)} @@\n" + "\n".join("+" + l for l in lines)
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
    else:
        if rel_path:
            old_content = await _git_out(repo, ["show", f"HEAD:{rel_path}"])
            if full_path and os.path.isfile(full_path):
                try:
                    with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                        new_content = f.read()
                except Exception:
                    new_content = ""
            diff_text = await _git_out(repo, ["diff", "HEAD", "--", rel_path])
            if not diff_text:
                diff_text = await _git_out(repo, ["diff", "--", rel_path])
                if not diff_text:
                    diff_text = await _git_out(repo, ["diff", "--cached", "--", rel_path])

            numstat = await _git_out(repo, ["diff", "--numstat", "HEAD", "--", rel_path])
            if not numstat:
                numstat = await _git_out(repo, ["diff", "--numstat", "--", rel_path])
                if not numstat:
                    numstat = await _git_out(repo, ["diff", "--cached", "--numstat", "--", rel_path])
            for line in numstat.split("\n"):
                parts = line.split("\t")
                if len(parts) >= 2:
                    try:
                        additions = 0 if parts[0] == "-" else int(parts[0])
                        deletions = 0 if parts[1] == "-" else int(parts[1])
                    except ValueError:
                        pass
                    break
        else:
            diff_text = await _git_out(repo, ["diff", "HEAD"])
            if not diff_text:
                diff_text = await _git_out(repo, ["diff"])

    return web.json_response({
        "ok": True,
        "path": rel_path,
        "diff": diff_text,
        "targetContent": old_content,
        "replacementContent": new_content,
        "additions": additions,
        "deletions": deletions,
        "isUntracked": is_untracked,
    })


async def handle_git_branches(request):
    """List local branches for the header BranchPicker."""
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        return web.json_response({
            "isGitRepository": False,
            "workspaceOpen": err.get("workspaceOpen", False),
            "branches": [],
        })
    current = await _git_branch_label(repo)
    raw = await _git_out(repo, ["branch", "--format=%(refname:short)"])
    branches = [b.strip() for b in raw.split("\n") if b.strip()]
    return web.json_response({
        "isGitRepository": True,
        "current": current,
        "branches": branches,
    })


async def handle_git_restore(request):
    """Discard uncommitted changes after an explicit UI confirm.

    Body: ``{"confirmed": true, "paths": ["optional/file.ts"]}``.
    Without ``confirmed: true`` this is a no-op 400.
    """
    import subprocess
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        if not err.get("workspaceOpen"):
            return web.json_response(
                {"error": "No workspace is open — open a folder before using git actions"},
                status=409,
            )
        return web.json_response({"error": "Not a git repository"}, status=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not body.get("confirmed"):
        return web.json_response(
            {"error": "Restore requires confirmed:true from the Undo UI"},
            status=400,
        )
    paths = body.get("paths") or []
    if not isinstance(paths, list):
        paths = []
    # Safe subset: restore tracked files; clean untracked only when paths given.
    args = ["restore", "--source=HEAD", "--worktree", "--staged"]
    args += ["--"] + [str(p) for p in paths] if paths else ["--", "."]
    try:
        proc = await _git_proc_async(repo, args, timeout=30)
        if proc.returncode != 0:
            return web.json_response(
                {"error": (proc.stderr or proc.stdout or "git restore failed")[:400]},
                status=400,
            )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"ok": True})


async def handle_git_checkout(request):
    """Switch branch from the header picker (refuses when working tree is dirty)."""
    import subprocess
    import re
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        if not err.get("workspaceOpen"):
            return web.json_response(
                {"error": "No workspace is open — open a folder before using git actions"},
                status=409,
            )
        return web.json_response({"error": "Not a git repository"}, status=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    branch = (body.get("branch") or "").strip()
    if not branch or not re.match(r"^[\w./_-]+$", branch):
        return web.json_response({"error": "Invalid branch name"}, status=400)
    if await _git_out(repo, ["status", "--porcelain"]):
        return web.json_response(
            {"error": "工作区有未提交改动，请先提交或撤销后再切换分支"},
            status=409,
        )
    try:
        proc = await _git_proc_async(repo, ["checkout", branch], timeout=30)
        if proc.returncode != 0:
            return web.json_response(
                {"error": (proc.stderr or proc.stdout or "checkout failed")[:400]},
                status=400,
            )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"ok": True, "branch": branch})


async def handle_git_create_branch(request):
    """Create a local branch from current HEAD and optionally check it out.

    Body: ``{"name": "feature/foo", "checkout": true}``.
    First version: only from current HEAD (no start-point picker).
    """
    import subprocess
    import re
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        if not err.get("workspaceOpen"):
            return web.json_response(
                {"error": "No workspace is open — open a folder before using git actions"},
                status=409,
            )
        return web.json_response({"error": "Not a git repository"}, status=400)
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = (body.get("name") or body.get("branch") or "").strip()
    do_checkout = body.get("checkout", True)
    if not name or not re.match(r"^[\w./_-]+$", name) or name.startswith(".") or name.endswith(".lock"):
        return web.json_response({"error": "无效的分支名"}, status=400)
    # Refuse create+checkout when dirty (same rule as switch).
    if do_checkout and await _git_out(repo, ["status", "--porcelain"]):
        return web.json_response(
            {"error": "工作区有未提交改动，请先提交或撤销后再创建并切换"},
            status=409,
        )
    try:
        create = await _git_proc_async(repo, ["branch", name], timeout=30)
        if create.returncode != 0:
            err = (create.stderr or create.stdout or "branch create failed")[:400]
            return web.json_response({"error": err}, status=400)
        if do_checkout:
            co = await _git_proc_async(repo, ["checkout", name], timeout=30)
            if co.returncode != 0:
                return web.json_response(
                    {"error": (co.stderr or co.stdout or "checkout failed")[:400]},
                    status=400,
                )
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response({"ok": True, "branch": name, "checkedOut": bool(do_checkout)})


async def handle_git_log(request):
    """Structured commit list for the Git Graph dialog."""
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        return web.json_response({
            "isGitRepository": False,
            "workspaceOpen": err.get("workspaceOpen", False),
            "commits": [],
        })

    try:
        limit = int(request.rel_url.query.get("limit", "40"))
    except ValueError:
        limit = 40
    limit = max(1, min(limit, 200))

    # %D = ref names (HEAD -> main, origin/main, …)
    fmt = "%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D%x1e"
    raw = await _git_out(repo, ["log", f"--max-count={limit}", f"--pretty=format:{fmt}", "--decorate=short"])
    commits = []
    for entry in raw.split("\x1e"):
        entry = entry.strip("\n\r")
        if not entry.strip():
            continue
        parts = entry.split("\x1f")
        if len(parts) < 5:
            continue
        full, short, subject, author, iso = parts[:5]
        deco = parts[5] if len(parts) > 5 else ""
        refs: list[str] = []
        is_head = False
        for piece in [p.strip() for p in deco.split(",") if p.strip()]:
            # git may emit "HEAD -> main" or just "tag: v1"
            if piece.startswith("HEAD -> "):
                is_head = True
                refs.append("HEAD")
                tip = piece[len("HEAD -> "):].strip()
                if tip:
                    refs.append(tip)
            elif piece == "HEAD":
                is_head = True
                refs.append("HEAD")
            elif piece.startswith("tag: "):
                refs.append(piece[5:].strip())
            else:
                refs.append(piece)
        # de-dupe preserving order
        seen = set()
        uniq = []
        for r in refs:
            if r and r not in seen:
                seen.add(r)
                uniq.append(r)
        commits.append({
            "hash": full,
            "shortHash": short,
            "subject": subject,
            "author": author,
            "date": iso,
            "refs": uniq,
            "isHead": is_head or ("HEAD" in uniq),
        })

    return web.json_response({
        "isGitRepository": True,
        "branch": await _git_branch_label(repo),
        "commits": commits,
    })


def _wire_scene_callbacks(llm) -> dict:
    """Hand each background module an LLM bound to ITS scene, not the big model.

    Every one of these used to receive ``get_llm_client().call`` — the single
    process client, i.e. whatever the user configured for conversation. So a
    commit subject, a memory extraction and a fold summary were all drafted by
    the most expensive model available, on every write and every compaction.

    ``bind_scene`` picks the cheapest CONFIGURED model clearing that scene's
    capability floor and returns the same client when it cannot do better, so a
    single-model setup is unaffected.

    Returns ``{module_name: model_id}`` for the startup log — a silent routing
    layer is one nobody can confirm is working.
    """
    from model_registry import (
        SCENE_MEMORY_EXTRACT, SCENE_GOAL_VERDICT, SCENE_COMMIT_MESSAGE,
    )
    # memory covers extraction, dream consolidation AND fold synthesis; all
    # three sit at the same floor, so one handle serves them.
    picks = {
        "memory": SCENE_MEMORY_EXTRACT,
        "goal": SCENE_GOAL_VERDICT,
        "commit": SCENE_COMMIT_MESSAGE,
    }
    out = {}
    clients = {}
    for name, scene in picks.items():
        try:
            client = llm.bind_scene(scene)
        except Exception:
            client = llm
        clients[name] = client
        out[name] = client.model_id
    return {"clients": clients, "models": out}


def _llm_callback_for(router, model: str):
    """An ``llm.call`` bound to ``model``, or None to use whatever is wired.

    Deliberately does NOT touch ``router.llm``: this runs on a REST request that
    can land mid-turn, and repointing the router's client would hijack the model
    of the conversation in flight.
    """
    model = (model or "").strip()
    base = getattr(router, "_base_llm", None) or getattr(router, "llm", None)
    if not model or base is None:
        return None
    try:
        from model_registry import get_model_registry
        info = get_model_registry().resolve(model)
    except Exception:
        return None
    if not info.ok or not isinstance(info.value, dict):
        return None
    return base.bind(info.value).call


async def handle_git_commit_message(request):
    """Draft a Conventional Commits message from the current changes.

    Uses the LLM when one is configured, otherwise the deterministic heuristic
    in ``git_trust.CommitMessageGenerator``.

    ``?unstaged=1`` describes everything dirty rather than just the index. The
    commit panel passes the state of its "包含未暂存的更改" box, because drafting
    from the index while committing the whole tree would describe the wrong
    changes — and on a repo where nothing is staged yet it used to just fail.

    ``?model=providerId:modelId`` drafts with the model the composer has
    selected. There is no separate cheap "commit model": this is an open-source
    build with no hosted small model to fall back on, so the draft reuses the
    session's model and the panel reports which one produced it.
    """
    from git_trust import get_commit_message_generator
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        if not err.get("workspaceOpen"):
            return web.json_response(
                {"error": "No workspace is open — open a folder first"}, status=409)
        return web.json_response({"error": "Not a git repository"}, status=400)
    include_unstaged = str(request.query.get("unstaged", "")).lower() in ("1", "true", "yes")
    generator = get_commit_message_generator()
    result = await generator.generate(
        repo, include_unstaged=include_unstaged,
        llm_callback=_llm_callback_for(router, request.query.get("model", "")),
    )
    if not result.ok:
        return web.json_response({"error": result.error}, status=400)
    return web.json_response(result.value)


async def handle_git_commit(request):
    """Commit (and optionally push) from the commit panel.

    Body: ``{message, includeUnstaged, push, session_id}``.

    Why this is a REST endpoint and not routed through the agent: the older
    "生成提交信息" button deliberately filled the composer instead of committing,
    so ``risk_control`` would grade the commit. That reasoning applies to a tool
    call the MODEL decided to make. Here the user has the branch, the diffstat
    and the file count in front of them and clicked 提交 — that click IS the
    consent, and every git GUI treats it that way. Agent-initiated
    ``git_commit`` / ``git_push`` still go through the full policy pipeline;
    nothing about that path changes.

    An empty ``message`` means "auto-generate", matching the panel's
    「提交信息（留空将自动生成）」 placeholder.
    """
    import subprocess
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        if not err.get("workspaceOpen"):
            return web.json_response(
                {"error": "No workspace is open — open a folder before using git actions"},
                status=409,
            )
        return web.json_response({"error": "Not a git repository"}, status=400)
    try:
        body = await request.json()
    except Exception:
        body = {}

    include_unstaged = bool(body.get("includeUnstaged"))
    want_push = bool(body.get("push"))
    message = str(body.get("message") or "").strip()

    # Stage BEFORE drafting: an auto-generated message must describe the same
    # tree the commit will contain, and `git add -A` also decides whether there
    # is anything to commit at all.
    if include_unstaged:
        try:
            add = await _git_proc_async(repo, ["add", "-A"])
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        if add.returncode != 0:
            return web.json_response(
                {"error": (add.stderr or add.stdout or "git add failed")[:400]}, status=400)

    if not (await _git_out(repo, ["diff", "--cached", "--name-only"])).strip():
        return web.json_response(
            {"error": "没有已暂存的改动可提交。勾选「包含未暂存的更改」，或先暂存文件。"},
            status=400,
        )

    generated_by = None
    if not message:
        from git_trust import get_commit_message_generator
        drafted = await get_commit_message_generator().generate(
            repo, llm_callback=_llm_callback_for(router, str(body.get("model") or "")))
        if not drafted.ok:
            return web.json_response({"error": drafted.error}, status=400)
        message = str(drafted.value.get("message") or "").strip()
        generated_by = drafted.value.get("generated_by")
        if not message:
            return web.json_response({"error": "无法生成提交信息，请手动填写"}, status=400)

    # argv, never a shell string: a message containing quotes, `$`, newlines or
    # `&&` is completely normal prose and must not become shell syntax.
    try:
        commit = await _git_proc_async(repo, ["commit", "-m", message])
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    if commit.returncode != 0:
        return web.json_response(
            {"error": (commit.stderr or commit.stdout or "git commit failed")[:400]}, status=400)

    head = await _git_out(repo, ["rev-parse", "--short", "HEAD"])
    pushed = False
    push_error = None
    if want_push:
        branch = await _git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
        has_upstream = bool(await _git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]))
        # First push of a new branch needs -u; without it git errors out with
        # "no upstream configured" and the user just sees a failure.
        args = ["push"] if has_upstream else ["push", "-u", "origin", branch]
        try:
            push = await _git_proc_async(repo, args, timeout=180)
            pushed = push.returncode == 0
            if not pushed:
                push_error = (push.stderr or push.stdout or "git push failed")[:400]
        except Exception as e:
            push_error = str(e)

    # 200 even when the push failed: the commit DID land, and reporting the whole
    # thing as a failure would send the user looking for a commit that exists.
    return web.json_response({
        "ok": True,
        "hash": head,
        "message": message,
        "generatedBy": generated_by,
        "pushed": pushed,
        "pushError": push_error,
    })


async def handle_git_push(request):
    """Push the current branch — the panel's standalone 推送 action."""
    import subprocess
    repo, router, err = await _resolve_git_repo(request)
    if err is not None:
        if not err.get("workspaceOpen"):
            return web.json_response(
                {"error": "No workspace is open — open a folder before using git actions"},
                status=409,
            )
        return web.json_response({"error": "Not a git repository"}, status=400)
    branch = await _git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    has_upstream = bool(await _git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]))
    args = ["push"] if has_upstream else ["push", "-u", "origin", branch]
    try:
        proc = await _git_proc_async(repo, args, timeout=180)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    if proc.returncode != 0:
        return web.json_response(
            {"error": (proc.stderr or proc.stdout or "git push failed")[:400]}, status=400)
    return web.json_response({"ok": True, "branch": branch})


# ─── Hooks ──────────────────────────────────────────────────────

async def handle_get_hooks(request):
    """Expose hook config state + recent execution records for debugging."""
    from hook_runner import get_hook_runner, HOOK_EVENTS
    runner = get_hook_runner()
    registered = [
        {
            "event": event,
            "matcher": group["matcher"],
            "source": group["source"],
            "hooks": [
                {"type": h["type"], "command": h["command"],
                 "args": h["args"], "timeoutMs": h["timeout_ms"]}
                for h in group["hooks"]
            ],
        }
        for event in HOOK_EVENTS
        for group in runner.matchers.get(event, [])
    ]
    return web.json_response({
        "enabled": runner.enabled,
        "supportedEvents": list(HOOK_EVENTS),
        "configPaths": runner.config_paths(),
        "registered": registered,
        "problems": runner.problems,
        "recentRuns": runner.log[-50:],
    })


async def handle_reload_hooks(request):
    """Re-read hooks.json without restarting the server."""
    from hook_runner import get_hook_runner
    runner = get_hook_runner()
    summary = runner.load()
    return web.json_response(summary)


# ─── Evolution proposals ────────────────────────────────────────
#
# 演化系统对外的最小控制面。为什么放在 HTTP 层：模型本身**不该**能改自己的档位
# 或接受自己的提案——这两个动作都得由用户显式做，走 UI/API 是把这条边界固化在
# 传输层的最简单办法。

def _evolution_workspace_root(request) -> str:
    """给 handler 一个稳定的 workspace 根。多 session 时用 session id 里的那份。"""
    sid = request.query.get("session_id") or request.query.get("sessionId") or ""
    if sid:
        try:
            from session_host import get_session_host
            host = get_session_host()
            if host is not None:
                r = host.get(sid)
                if r is not None:
                    return r.workspace
        except Exception:  # noqa: BLE001
            pass
    return request.app[ROUTER_KEY].workspace


async def handle_evolution_list(request):
    try:
        from evolution import get_evolution_engine
        engine = get_evolution_engine(_evolution_workspace_root(request))
        return web.json_response({
            "mode": engine.mode,
            "proposals": engine.list_open(),
        })
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("GET /api/evolution/proposals failed")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_evolution_list_all(request):
    try:
        from evolution import get_evolution_engine
        engine = get_evolution_engine(_evolution_workspace_root(request))
        try:
            limit = int(request.query.get("limit") or 50)
        except ValueError:
            limit = 50
        return web.json_response({
            "proposals": engine.list_all(limit=limit),
            # 计数单独查库：列表被 limit 截断，拿它去过滤统计会随记录变多越报越低。
            "counts": engine.counts(),
            "limit": limit,
        })
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("GET /api/evolution/proposals/all failed")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_evolution_observations(request):
    """观察台账：每次任务终态看到了什么证据、四路决策是什么、为什么。

    这是 Evolution 面板"这次观察到什么、为什么更新"一栏的数据源。
    """
    try:
        from evolution import get_evolution_engine
        engine = get_evolution_engine(_evolution_workspace_root(request))
        try:
            limit = max(1, min(int(request.query.get("limit") or 50), 200))
        except ValueError:
            limit = 50
        return web.json_response({
            "mode": engine.mode,
            "observations": engine.store.list_observations(limit=limit),
            "limit": limit,
        })
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("GET /api/evolution/observations failed")
        return web.json_response({"error": str(exc)}, status=500)


async def handle_evolution_decide(request):
    """接受或拒绝一条提案。动词嵌在 URL 里（/accept、/reject）。

    可选 body ``{"draft": "..."}``：用户在接受前把草案改过。批准的是用户眼睛看到
    的那行字，所以带上它就用它写盘，并同步落库让审计轨迹一致。body 不是必需的，
    没有 body 或不是合法 JSON 时按原草案处理——一个可选字段不该让请求失败。

    响应字段 ``applied`` 严格反映盘上是不是真的写进去了——写盘失败时是 False。
    UI 应据此显示"已应用"或"已接受但落盘失败"，不要糊在一起。
    """
    from evolution import get_evolution_engine
    proposal_id = request.match_info.get("id") or ""
    accept = request.path.endswith("/accept")
    draft_override = ""
    if accept:
        try:
            body = await request.json()
            draft_override = str((body or {}).get("draft") or "")
        except Exception:  # noqa: BLE001
            draft_override = ""
    engine = get_evolution_engine(_evolution_workspace_root(request))
    result = engine.decide(proposal_id, accept=accept, draft_override=draft_override)
    status_code = 200 if result.get("status") != "missing" else 404
    return web.json_response(result, status=status_code)


async def handle_evolution_mine(request):
    """手动触发一次挖掘。给"我不想等下一次工具失败"用；ttl 冷却仍然生效。"""
    from evolution import get_evolution_engine
    engine = get_evolution_engine(_evolution_workspace_root(request))
    made = engine.mine()
    return web.json_response({"created": [p.to_dict() for p in made]})


async def handle_evolution_get_mode(request):
    from evolution import get_evolution_engine, VALID_MODES
    engine = get_evolution_engine(_evolution_workspace_root(request))
    # `policy` 是当前档位的真实阈值。前端曾把这些数字硬编码进文案，后端一调参
    # 界面就开始撒谎——而用户是照着那句说明做决定的。off 档没有策略，返回 {}。
    return web.json_response({
        "mode": engine.mode,
        "validModes": list(VALID_MODES),
        "policy": engine.policy_view(),
    })


async def handle_evolution_set_mode(request):
    """改档位。同时落到 config.json，重启后仍然是这一档。"""
    from evolution import get_evolution_engine, VALID_MODES
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "invalid JSON"}, status=400)
    mode = str(body.get("mode") or "")
    if mode not in VALID_MODES:
        return web.json_response(
            {"error": f"bad mode: {mode!r}", "validModes": list(VALID_MODES)},
            status=400,
        )
    engine = get_evolution_engine(_evolution_workspace_root(request))
    engine.set_mode(mode)
    _CONFIG.setdefault("evolution", {})["mode"] = mode
    try:
        _persist_config()
    except OSError as e:
        return web.json_response({"error": f"could not persist: {e}"}, status=500)
    return web.json_response({"mode": engine.mode})


# ─── Browser claim loop（U3 认领闭环的 HTTP 桥面）───────────────────
#
# 「提及即引用」的最后一公里：协议本体在 browser_sessions（TabClaim 三元组 +
# fail-closed 全等比对，固定失败文案的单一真相源），这两个端点把它暴露给
# UI——Composer「引用标签」下拉列出打开中的标签、认领失败卡一键重新指认。
# 两个端点都只是本地桥的只读/状态操作（读标签表、聚焦既有标签），零网络
# 语义，符合本地优先铁律。
#
# 失败语义分层：协议拒绝（快照不全等 / 标签不存在 / 跨会话）是**业务结果**，
# HTTP 200 + {ok:false, message:<协议原文>} 原样透传让前端渲染对照卡；
# 4xx/5xx 只留给真正的程序错误（坏请求体、管理器炸了）。


def _claim_session_manager():
    """认领闭环用的会话管理器：优先浏览器 agent 自持实例（真实流程开标签的
    就是它），拿不到再落共享单例。只读解析，绝不在这里新建 agent。"""
    try:
        from browser_agent import get_browser_agent
        sessions = getattr(get_browser_agent(), "sessions", None)
        if sessions is not None:
            return sessions
    except Exception:  # noqa: BLE001
        pass  # agent 未初始化（纯后端/测试环境）→ 共享单例兜底
    from browser_sessions import get_shared_session_manager
    return get_shared_session_manager()


def _claim_receipt(claim) -> dict:
    """认领凭据 → 可 JSON 序列化的回执 dict。

    会话层成功回执里的 claim 是 TabClaim dataclass（aiohttp 的 json.dumps
    不认它）；dict 形态（兼容未来调整）原样透传，其余按字段平铺。
    """
    if isinstance(claim, dict):
        return claim
    return {
        "object_id": str(getattr(claim, "object_id", "") or ""),
        "title_snapshot": str(getattr(claim, "title_snapshot", "") or ""),
        "url_snapshot": str(getattr(claim, "url_snapshot", "") or ""),
        "kind": str(getattr(claim, "kind", "tab") or "tab"),
        "claimed_at_ms": int(getattr(claim, "claimed_at_ms", 0) or 0),
    }


async def handle_browser_tabs(request):
    """GET /api/browser/tabs?task_id=... → 任务会话里打开中的标签清单。

    供 Composer「引用标签」下拉使用。无会话不是错误：返回空数组（优雅空态
    ——前端据此置灰），只有程序故障才 5xx。closed 标签不进列表（引用一个
    已关闭的对象只会得到认领失败）；挂起标签保留（认领会顺带唤醒它）。
    行形状与后端 wire 原样对齐：tab_id/title/url/status/active。
    """
    from browser_sessions import TAB_CLOSED, resolve_task_id
    task_id = resolve_task_id(
        {"task_id": request.query.get("task_id") or request.query.get("sessionId")},
        {})
    try:
        result = _claim_session_manager().list_tabs(task_id)
    except Exception as exc:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception("GET /api/browser/tabs failed")
        return web.json_response(
            {"error": f"browser tabs unavailable: {exc}"}, status=500)
    tabs: list = []
    if result.ok:
        summary = result.value if isinstance(result.value, dict) else {}
        active_id = summary.get("active_tab_id")
        for t in summary.get("tabs") or []:
            if not isinstance(t, dict) or t.get("state") == TAB_CLOSED:
                continue
            tabs.append({
                "tab_id": str(t.get("tab_id") or ""),
                "title": str(t.get("title") or ""),
                "url": str(t.get("url") or ""),
                "status": str(t.get("state") or ""),
                "active": t.get("tab_id") == active_id,
            })
    # result 失败（no active browser session）= 无会话 → 空数组，不是错误
    return web.json_response({"ok": True, "task_id": task_id, "tabs": tabs})


async def handle_browser_claim(request):
    """POST /api/browser/claim → fail-closed 认领一个标签。

    Body: ``{task_id, object_id, title_snapshot, url_snapshot}``。成功返回
    标签回执（tab 记录 + claim 凭据，claimed_at_ms 已盖章）；协议拒绝返回
    200 + {ok:false, message:<协议原文>}——旧快照→新现状的失败文案由
    browser_sessions 生成，这里一个字不改写，前端认领失败卡据此渲染对照
    与一键重新指认。
    """
    from browser_sessions import TabClaim, resolve_task_id
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "body must be a JSON object"}, status=400)
    object_id = str(body.get("object_id") or "").strip()
    if not object_id:
        return web.json_response({"error": "object_id is required"}, status=400)
    task_id = resolve_task_id({"task_id": body.get("task_id")}, {})
    claim = TabClaim(
        object_id=object_id,
        title_snapshot=str(body.get("title_snapshot") or ""),
        url_snapshot=str(body.get("url_snapshot") or ""),
    )
    try:
        result = _claim_session_manager().claim_tab(task_id, claim)
    except Exception as exc:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).exception("POST /api/browser/claim failed")
        return web.json_response(
            {"error": f"claim endpoint failure: {exc}"}, status=500)
    if not result.ok:
        # 协议拒绝 = 业务结果。message 原样透传，绝不改写协议文案。
        return web.json_response({"ok": False, "message": result.error})
    value = result.value if isinstance(result.value, dict) else {}
    return web.json_response({
        "ok": True,
        "tab": value.get("tab"),
        "claim": _claim_receipt(value.get("claim")),
    })


# ─── Server setup ───────────────────────────────────────────────

# Origins the UI can legitimately be served from.
#
# The previous middleware echoed `request.headers["Origin"]` straight back and
# added `Access-Control-Allow-Credentials: true`, which is the same as having no
# policy at all: the browser's cross-origin check passes for *every* site. Any
# page the user happened to have open could therefore call all ~77 routes here
# -- including the ones that write files, run shell commands and hand out
# provider keys -- and read the answers. "It only listens on 127.0.0.1" is not a
# boundary against that: a page at https://example.invalid can fetch
# http://127.0.0.1:8765 just fine; loopback restricts *machines*, not *pages*.
_ALLOWED_ORIGINS = frozenset({
    "http://localhost:5173",      # vite dev server (dev)
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://localhost:8765",      # backend serving ui/dist itself
    "http://127.0.0.1:8765",
})

# Names that may address this server. Anything else means the request arrived
# via a hostname that resolves here — the shape of a DNS-rebinding attack, where
# a domain the attacker controls answers 127.0.0.1 so their page's requests look
# same-origin to the browser.
_ALLOWED_HOSTNAMES = frozenset({"127.0.0.1", "localhost", "::1"})
_DEFAULT_DEV_PORTS = frozenset({5173, 3000, 8080, 8765})


def _origin_allowed(origin: str) -> bool:
    """True when `origin` may talk to this API."""
    if not origin or origin == "null":
        # No Origin at all: a native client (our own Python tools, curl, the
        # Electron health probe). A hostile web page cannot get here — browsers
        # always attach the real origin to a cross-origin request.
        return True
    if origin.startswith("file://"):
        # Packaged desktop build: the renderer is loaded from disk.
        return True
    if origin in _ALLOWED_ORIGINS:
        return True
    # Allow loopback dev origins only if within allowed ports or OVOLVE_DEV_PORTS
    try:
        from urllib.parse import urlparse
        parsed = urlparse(origin)
        if parsed.scheme in ("http", "https"):
            h = (parsed.hostname or "").lower()
            if h in _ALLOWED_HOSTNAMES:
                allowed_ports = set(_DEFAULT_DEV_PORTS)
                extra = os.environ.get("OVOLVE_DEV_PORTS", "")
                if extra:
                    for p in extra.split(","):
                        p = p.strip()
                        if p.isdigit():
                            allowed_ports.add(int(p))
                port = parsed.port or (443 if parsed.scheme == "https" else 80)
                if port in allowed_ports:
                    return True
                return False
    except Exception:
        pass
    return False


def _host_allowed(host: str) -> bool:
    """True when the `Host` header names this loopback server."""
    if not host:
        return True                      # HTTP/1.0 or a raw socket probe
    hostname = host.rsplit(":", 1)[0] if not host.endswith("]") else host
    hostname = hostname.strip("[]").lower()
    return hostname in _ALLOWED_HOSTNAMES


@web.middleware
async def cors_middleware(request, handler):
    """Gate every request on Origin + Host, then answer CORS for allowed ones.

    Applies to `/ws` as well: a WebSocket handshake is an ordinary GET, so
    rejecting here means the socket never upgrades.
    """
    origin = request.headers.get("Origin", "")
    if not _host_allowed(request.headers.get("Host", "")):
        return web.json_response(
            {"error": "Host not allowed (loopback names only)"}, status=421
        )
    if not _origin_allowed(origin):
        # 403 rather than merely withholding the CORS header: without a body a
        # browser would still have *sent* the request, and several routes here
        # change state on POST regardless of whether the answer can be read.
        return web.json_response({"error": f"Origin not allowed: {origin}"}, status=403)

    if request.method == "OPTIONS":
        resp = web.Response(status=204)
    else:
        resp = await handler(request)

    if origin and origin != "null":
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Credentials"] = "true"
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    # X-Api-Token has to be listed or the browser blocks the preflight and the
    # request never arrives — the auth middleware would then never even see it.
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Api-Token"
    return resp



async def create_server(router: Router, host: str = "127.0.0.1", port: int = 8765):
    """Create and run the HTTP/WebSocket server.

    The `router` argument is kept for backward compat (main.py / tests build
    one before calling us). We wrap it inside a SessionHost so that the WS
    layer can manage multiple sessions; existing HTTP routes still see it via
    ``request.app[ROUTER_KEY]`` (resolves to the host's primary).
    """
    from session_host import SessionHost, set_session_host
    session_host = SessionHost(
        system_prompt=router.system_prompt,
        default_workspace=router.workspace,
    )
    # Register the caller-created router as the primary session.
    session_host._sessions[router.session_id] = router
    session_host._shared_mounted = True  # the first Router already mounted guards
    # Fresh lifecycle generation for this process life. Any run/callback that
    # somehow survives from a previous life (hot reload, orphaned task) will
    # fail its generation check and abort instead of reporting stale results.
    session_host.rotate_generation()
    # 2.1 同一件事的另一半：generation 让**上一条命的回调**闭嘴，这里让上一条命
    # 留在库里的**状态**闭嘴。任何还写着 `running` 的行都指向一个随进程死掉的
    # asyncio task —— 留着它，一连上来的窗口就会永远转圈等一个不会回来的回合。
    try:
        from turn_state import get_turn_state
        _stale = get_turn_state().reset_stale()
        if _stale:
            print(f"[turn_state] {_stale} stale running turn(s) marked as error")
    except Exception as _e:  # noqa: BLE001
        print(f"[turn_state] stale reset skipped: {_e}")

    # Publish so late-binding subsystems (bot dispatch, goal scheduler, tests)
    # can reach the same host without threading it through every signature.
    set_session_host(session_host)


    ws_handler = WebSocketHandler(session_host)

    # 演化系统：读档位 + 挂信号订阅。默认档位是 off，此时订阅者每次都立即返回，
    # 不写盘也不查库——挂上去的成本只有一个函数指针。放在这里而不是 import 时，
    # 是因为它要拿到真实的 workspace 和已经建好的 bus。
    try:
        import evolution
        _evo_mode = evolution.configure_from_config(_CONFIG, router.workspace)
        evolution.attach_to_bus(router.bus)
        print(f"[evolution] mode={_evo_mode}")
    except Exception as _e:  # noqa: BLE001
        print(f"[evolution] wiring skipped: {_e}")

    # Order matters: CORS is outermost so browser preflights (which cannot carry
    # a token) are answered before auth is consulted; auth then closes every
    # non-exempt route. See api_auth.EXEMPT_* for what stays open and why.
    app = web.Application(middlewares=[cors_middleware, api_auth.auth_middleware])
    app[ROUTER_KEY] = router           # legacy: HTTP handlers use this for storage / workspace
    app[SESSION_HOST_KEY] = session_host

    async def _on_cleanup_app(app_instance):
        try:
            from llm_client import close_shared_sessions
            await close_shared_sessions()
        except Exception:
            pass
    app.on_cleanup.append(_on_cleanup_app)
    app.add_routes([
        # WebSocket
        web.get('/ws', ws_handler.handle_websocket),
        # Health
        web.get('/api/health', handle_health),
        # Generated images (served from disk; see image_store)
        web.get('/api/images/{image_id}', handle_get_image),
        web.get('/api/files', handle_get_file),
        # Goals
        web.get('/api/goals', handle_goals),
        web.post('/api/goals', handle_create_goal),
        web.patch('/api/goals/{id}', handle_update_goal),
        web.delete('/api/goals/{id}', handle_delete_goal),
        web.post('/api/goals/{id}/run', handle_run_goal),
        web.post('/api/goals/{id}/pause', handle_pause_goal),
        web.post('/api/goals/{id}/confirm-stopped', handle_confirm_goal_stopped),
        web.get('/api/goals/{id}/iterations', handle_goal_iterations),
        web.get('/api/goals/{id}/events', handle_goal_events),
        web.get('/api/goals/{id}/contract', handle_goal_contract),
        # Reflexion & Evolution
        web.get('/api/reflections', handle_reflections),
        web.get('/api/curriculum/gaps', handle_curriculum_gaps),
        web.get('/api/skills/patterns', handle_skill_patterns),
        web.get('/api/evolution/undo', handle_evolution_undo_list),
        web.post('/api/evolution/undo', handle_evolution_undo),
        # Cron
        web.get('/api/crons', handle_crons),
        web.post('/api/crons', handle_create_cron),
        web.patch('/api/crons/{id}', handle_update_cron),
        web.delete('/api/crons/{id}', handle_delete_cron),
        # Bot
        web.get('/api/bot/messages', handle_bot_messages),
        web.post('/api/bot/send', handle_bot_send),
        web.get('/api/bot/status', handle_bot_status),
        web.get('/api/bot/config/{platform}', handle_bot_config_get),
        web.put('/api/bot/config/{platform}', handle_bot_config_put),
        web.post('/api/bot/webhook/feishu', handle_feishu_webhook),
        web.post('/api/bot/webhook/dingtalk', handle_dingtalk_webhook),
        web.get('/api/bot/webhook/wecom', handle_wecom_webhook),
        web.post('/api/bot/webhook/wecom', handle_wecom_webhook),
        # Channel gateway（通用 HMAC webhook 渠道）
        web.get('/api/channels', handle_channels_list),
        web.post('/api/channels', handle_channel_upsert),
        web.delete('/api/channels/{name}', handle_channel_delete),
        web.post('/api/channels/{name}/inbound', handle_channel_inbound),
        # Skills
        web.get('/api/skills', handle_skills),
        web.post('/api/skills/relock', handle_skills_relock),
        web.get('/api/skills/experiences', handle_skill_experiences),
        web.get('/api/relations', handle_relations),
        web.get('/api/approvals/pending', handle_approvals_pending),
        web.get('/api/mailbox/{box_id}', handle_mailbox_list),
        web.post('/api/mailbox/{box_id}/drain', handle_mailbox_drain),
        # Skill candidate lifecycle (Step E)
        web.get('/api/skills/candidates', handle_skill_candidates),
        web.post('/api/skills/candidates', handle_skill_candidate_create),
        web.post('/api/skills/candidates/{id}/promote', handle_skill_candidate_action),
        web.post('/api/skills/candidates/{id}/approve', handle_skill_candidate_action),
        web.post('/api/skills/candidates/{id}/reject', handle_skill_candidate_action),
        web.post('/api/skills/candidates/{id}/rollback', handle_skill_candidate_action),
        web.post('/api/skills/import', handle_import_skill),
        web.post('/api/skills/install', handle_install_skill),
        web.post('/api/skills/vet', handle_vet_skill),
        web.post('/api/skills/{name}/enable', handle_enable_skill),
        web.post('/api/skills/{name}/disable', handle_disable_skill),
        # Plugins (bundles that contribute skills / sub-agents)
        web.get('/api/plugins', handle_plugins),
        web.post('/api/plugins/import', handle_import_plugin),
        web.post('/api/plugins/{name}/enable', handle_plugin_enable),
        web.post('/api/plugins/{name}/disable', handle_plugin_disable),
        web.delete('/api/plugins/{name}', handle_plugin_remove),
        # Settings
        web.get('/api/settings', handle_get_settings),
        web.put('/api/settings', handle_update_settings),
        # Standing permission rules (the allowlist behind 「以后都允许」)
        web.get('/api/permissions/rules', handle_permission_rules_list),
        web.post('/api/permissions/rules', handle_permission_rule_create),
        web.delete('/api/permissions/rules/{rule_id}', handle_permission_rule_delete),
        # 上网权限（命令级网络出口策略，热生效）
        web.get('/api/permissions/network', handle_network_policy_get),
        web.get('/api/permissions/overview', handle_permissions_overview),
        # Outbound HTTP settings (proxy + Tavily key) for tool-internal requests
        web.get('/api/network/outbound', handle_outbound_settings_get),
        web.put('/api/network/outbound', handle_outbound_settings_put),
        web.put('/api/permissions/network', handle_network_policy_put),
        # Models: the UI's provider catalogue -> the registry the request path reads
        web.get('/api/models', handle_models_list),
        web.get('/api/models/resolve', handle_models_resolve),
        web.post('/api/models/providers', handle_models_sync_providers),
        web.get('/api/tools', handle_get_tools),
        web.get('/api/tools/contracts', handle_tool_contracts),
        # Browser claim loop（U3 认领闭环）：标签清单 + fail-closed 认领
        web.get('/api/browser/tabs', handle_browser_tabs),
        web.post('/api/browser/claim', handle_browser_claim),
        # Sub-agents (task tool control surface)
        web.get('/api/subagents', handle_subagents_list),
        web.get('/api/subagents/types', handle_subagent_types),
    web.patch('/api/subagents/types/{name}', handle_subagent_type_update),
        web.post('/api/subagents/kill-all', handle_subagents_kill_all),
        web.post('/api/subagents/{id}/kill', handle_subagent_kill),
        # Rollback (per-step file snapshots)
        web.get('/api/rollback', handle_rollback_list),
        web.post('/api/rollback', handle_rollback_apply),
        # Session timeline / checkpoint tree (UB1)
        web.get('/api/checkpoints', handle_checkpoints),
        web.get('/api/checkpoints/preview', handle_checkpoint_preview),
        web.post('/api/checkpoints/label', handle_checkpoint_label),
        # Event-Sourced Agent Runtime & Time Travel
        web.get('/api/events/{sessionId}', handle_get_events),
        web.get('/api/events/{sessionId}/verify', handle_verify_event_chain),
        web.get('/api/events/{sessionId}/state', handle_get_projected_state),
        web.post('/api/sessions/fork_at_seq', handle_fork_at_seq),
        web.get('/api/sessions/search', handle_search_sessions),
        # Session Log & Full-Link Trace Transcripts
        web.get('/api/sessions/{sessionId}/log', handle_get_session_log),
        web.get('/api/sessions/{sessionId}/transcript', handle_get_session_transcript),
        web.get('/api/sessions/{sessionId}/log_info', handle_get_session_log_info),
        # Session artifacts (images + files a session produced)
        web.get('/api/artifacts', handle_artifacts),
        # Usage analytics
        web.get('/api/usage/stats', handle_usage_stats),
        web.get('/api/token-analytics', handle_token_analytics),
        # Memory diagnostics + wiki adjudication (C1-C4)
        web.get('/api/memory/diagnostics', handle_memory_diagnostics),
        web.post('/api/memory/reindex', handle_memory_reindex),
        web.post('/api/memory/backfill', handle_memory_backfill),
        web.post('/api/memory/cache/clear', handle_memory_cache_clear),
        # Memory entries — content-level read/edit/delete
        web.get('/api/memory/entries', handle_memory_entries),
        web.get('/api/memory/entries/{id}/trace', handle_memory_entry_trace),
        web.get('/api/memory/conflicts', handle_memory_conflicts),
        web.get('/api/memory/dream-runs', handle_memory_dream_runs),
        # Phase 60 实体关系图谱接口 (Knowledge Graph API)
        web.get('/api/memory/graph', handle_memory_graph),
        web.post('/api/memory/graph/triplets', handle_memory_graph_triplet_create),
        # Phase 62 记忆容量预算与主动梦境修剪接口 (Budget & Prune API)
        web.get('/api/memory/budget', handle_memory_budget),
        web.post('/api/memory/prune', handle_memory_prune),


        web.get('/api/memory/roots', handle_memory_roots),
        web.post('/api/memory/entries', handle_memory_entry_create),
        web.patch('/api/memory/entries/{id}', handle_memory_entry_update),
        web.delete('/api/memory/entries/{id}', handle_memory_entry_delete),
        web.get('/api/wiki/claims', handle_wiki_claims),
        web.post('/api/wiki/resolve', handle_wiki_resolve),
        web.delete('/api/wiki/claims/{id}', handle_wiki_delete),
        # Git panel (GIT_INTEGRATION.md / GIT_TASK_AGENT_UI.md)
        web.get('/api/git/status', handle_git_status),
        web.get('/api/git/diff', handle_git_diff),
        web.get('/api/git/branches', handle_git_branches),
        web.get('/api/git/log', handle_git_log),
        web.post('/api/git/restore', handle_git_restore),
        web.post('/api/git/checkout', handle_git_checkout),
        web.post('/api/git/branch', handle_git_create_branch),
        web.get('/api/git/commit-message', handle_git_commit_message),
        web.post('/api/git/commit', handle_git_commit),
        web.post('/api/git/push', handle_git_push),
        # Shadow workspace (staged overlay + validation)
        web.get('/api/shadow/{sessionId}/status', handle_shadow_status),
        web.post('/api/shadow/{sessionId}/validate', handle_shadow_validate),
        web.post('/api/shadow/{sessionId}/apply', handle_shadow_apply),
        web.post('/api/shadow/{sessionId}/discard', handle_shadow_discard),
        # Hooks
        web.get('/api/hooks', handle_get_hooks),
        web.post('/api/hooks/reload', handle_reload_hooks),
        # MCP servers (standard external tool servers)
        web.get('/api/mcp/servers', handle_mcp_list),
        web.post('/api/mcp/servers', handle_mcp_upsert),
        web.delete('/api/mcp/servers/{name}', handle_mcp_delete),
        web.post('/api/mcp/servers/{name}/toggle', handle_mcp_toggle),
        web.post('/api/mcp/servers/{name}/restart', handle_mcp_restart),
        # Evolution (self-improving guidance proposals)
        web.get('/api/evolution/proposals', handle_evolution_list),
        web.get('/api/evolution/proposals/all', handle_evolution_list_all),
        web.get('/api/evolution/observations', handle_evolution_observations),
        web.get('/api/evolution/bundles', handle_learning_bundles),
        web.post('/api/evolution/proposals/{id}/accept', handle_evolution_decide),
        web.post('/api/evolution/proposals/{id}/reject', handle_evolution_decide),
        web.post('/api/evolution/mine', handle_evolution_mine),
        web.get('/api/evolution/mode', handle_evolution_get_mode),
        web.put('/api/evolution/mode', handle_evolution_set_mode),
        # Session-aware learning & LearningItems (Phase 4 & 8)
        web.get('/api/sessions/{id}/learning', handle_session_learning),
        web.post('/api/learning-items/{id}/{action}', handle_learning_item_action),
        web.get('/api/learning-items/{id}/trace', handle_learning_item_trace),
        web.get('/api/episodes', handle_episodes_list),
        web.post('/api/episodes/seal', handle_episode_seal),
        web.get('/api/history/trace', handle_history_trace),
        # Durable-execution system surface: schema state + repair, and the
        # unified learning bundles (one per finished goal).
        web.get('/api/system/migrations', handle_migrations_status),
        web.post('/api/system/migrations/retry', handle_migrations_retry),
    ])

    try:
        from shadow_config import apply_from_config
        apply_from_config(_CONFIG)
    except Exception:
        pass

    # Add static file serving if dist exists
    dist_dir = os.path.join(os.path.dirname(__file__), '..', '..', 'ui', 'dist')
    if os.path.exists(dist_dir) and os.path.exists(os.path.join(dist_dir, 'index.html')):
        print(f"Serving frontend from {dist_dir}")
        app.router.add_get('/', lambda r: web.FileResponse(os.path.join(dist_dir, 'index.html')))
        app.router.add_static('/assets/', os.path.join(dist_dir, 'assets'), name='assets')

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    await site.start()
    print(f"Server running at http://{host}:{port}")
    print(f"WebSocket endpoint: ws://{host}:{port}/ws")

    # Start bot listeners now that the event loop is up. If nothing was
    # registered in run_server this is a no-op.
    try:
        from bot_remote import get_bot_controller
        _bot_report = await get_bot_controller().start()
        for _plat, _state in _bot_report.items():
            print(f"[bot] {_plat}: {_state}")
    except Exception as _e:  # noqa: BLE001
        print(f"[bot] listener startup failed: {_e}")

    # Start the goal scheduler. It must be constructed here rather than at
    # import time because it needs a live event loop to spawn worker tasks, and
    # it needs the router to actually execute turns. Goals only run when the
    # user explicitly triggers them, so an idle scheduler costs one sleeping
    # task and nothing else.
    try:
        from goal_scheduler import get_goal_scheduler
        _sched = get_goal_scheduler(router, router.bus, host=session_host)
        _sched.start()
        print("[goals] scheduler started (max 2 concurrent, $5/goal cap)")
    except Exception as _e:  # noqa: BLE001
        print(f"[goals] scheduler startup failed: {_e}")

    # ── Cron scheduler（Handoff 2.5：补上缺失的执法点）────────────────────
    # 在此之前 cron_jobs 只进不出：CRUD 面可用，但 10 秒轮询循环从未被拉起、
    # 也没有任何 handler 注册——到期任务永远停在库里，这是"配置存在但无
    # 执法点"的假层。现在接线：
    #   · 到期任务经 SessionHost 解析 job.session_id 对应的 Router，跑一个
    #     完整回合——与 bot 派发同一条路径，命令全程过权限档位/危险命令
    #     分类/沙箱三道闸，cron 回合没有任何绕行通道。
    #   · 档位语义（permissions.scheduled.permission）：非空 = 每次到期回合
    #     固定用这个档位；为空（默认）= 继承任务所属会话的当前档位。命令
    #     名单不在这里重复配置——回合内已走统一的风险管道，第二份名单只会
    #     长出两套互相矛盾的执法点。
    try:
        from cron_manager import get_cron_manager
        _cron = get_cron_manager()
        _cron_sched_cfg = {}
        try:
            _cron_sched_cfg = (_CONFIG or {}).get("permissions", {}).get("scheduled", {}) or {}
        except Exception:
            pass

        async def _cron_turn_handler(payload: dict):
            prompt = str(payload.get("prompt") or "").strip()
            if not prompt:
                return "(no prompt configured for this job)"
            sid = payload.get("session_id") or ""
            target = router
            if sid:
                try:
                    target = session_host.get_or_create(sid)
                except Exception as exc:  # noqa: BLE001
                    print(f"[cron] session resolve failed for {sid}: {exc}")
            ctx: dict = {}
            fixed = str(_cron_sched_cfg.get("permission", "") or "").strip()
            if fixed:
                # 只透传，不自行放权：router.handle 顶部会 coerce，非法值落
                # 默认档而不是 full——与 UI 传入档位同一套兜底。
                ctx["permission"] = fixed
            turn = await target.handle(prompt, ctx)
            return turn.value if turn.ok else f"[failed] {turn.error}"

        _cron.register_handler("*", _cron_turn_handler)
        asyncio.create_task(_cron.start_scheduler())
        print("[cron] scheduler started (10s tick, turns via session router)")
    except Exception as _e:  # noqa: BLE001
        print(f"[cron] scheduler startup failed: {_e}")

    # Phase 5 收口：后台 EvolutionReviewRun。idle 周期扫描最近完成、尚未被
    # 观察过的目标，补观察与关系边；前台优先（有目标在跑就整轮跳过）。
    try:
        from evolution_review import start_background_review
        if start_background_review(router):
            print("[evolution] background review sweep started (15min, foreground-first)")
    except Exception as _e:  # noqa: BLE001
        print(f"[evolution] review startup failed: {_e}")

    # Phase 36：学习产物红队巡逻。定期用注入/越权模式库反向扫描 Learned
    # Rules 与技能描述——学习产物逐轮注入上下文，一旦被投毒等于每轮都在
    # 给模型喂攻击。前台优先、fail-open，与 evolution_review 同纪律。
    try:
        from red_team_patrol import start_red_team_patrol
        if start_red_team_patrol(router):
            print("[security] red team patrol started (6h, foreground-first)")
    except Exception as _e:  # noqa: BLE001
        print(f"[security] red team patrol startup failed: {_e}")

    # 浏览器空闲自动关停与收割 (IdleReaper，守护线程，fail-open)
    try:
        from browser_sessions import get_shared_session_manager
        from browser_idle_reaper import IdleReaper
        _reaper = IdleReaper(get_shared_session_manager())
        _reaper.start()
        print("[browser] idle reaper started (auto-suspend daemon)")
    except Exception as _e:  # noqa: BLE001
        print(f"[browser] idle reaper startup failed: {_e}")

    # Same problem one layer down: a sub-agent that was spawning or running when
    # the process died left a non-terminal ledger row. Its owning process is
    # gone, so it can never reach a terminal state on its own. The reap only
    # touches rows from a DIFFERENT generation, so it is safe even though
    # sub-agents can start the moment the server accepts a request. Phase 2
    # also mirrors every reaped row into the event ledger as SUBAGENT_FAILED.
    try:
        from recovery import record_reaped_subagents
        _orphans = router.storage.reap_orphan_subagent_runs()
        if _orphans:
            _emitted = record_reaped_subagents(router.storage, _orphans)
            print(f"[subagents] reaped {len(_orphans)} orphan run(s) from a previous process"
                  f" ({_emitted} ledger events)")
    except Exception as _e:  # noqa: BLE001
        print(f"[subagents] orphan reap failed: {_e}")

    # Start configured MCP servers. Each server's tools get registered into
    # the shared ToolRegistry as `mcp__<server>__<tool>`. Failures are logged
    # but never abort boot — one bad external server must not black-out the
    # rest of the agent.
    try:
        from mcp_manager import get_mcp_manager
        _mcp = get_mcp_manager()
        _mcp.load_config(_CONFIG)
        _report = await _mcp.start_all()
        if _report:
            for _name, _st in _report.items():
                print(f"[mcp] {_name}: {_st}")
            # Phase 6：每个 MCP server 的能力登记进统一 seam——可查询、可按
            # 来源整体撤销。分发仍走共享 ToolRegistry 唯一闸门，seam 只做
            # 可见性与归属，不产生第二套执行路径。
            try:
                from capabilities import get_provider_registry
                from tools import get_tool_registry

                class _MCPToolProvider:
                    def __init__(self, name: str):
                        self.name = name

                    def tools(self):
                        prefix = f"mcp__{self.name}__"
                        return [t for t in get_tool_registry().list_tools()
                                if t.name.startswith(prefix)]

                    def dispatch(self, tool_name: str, args: dict, ctx: dict):
                        return get_tool_registry().dispatch(tool_name, args, ctx)

                _seam = get_provider_registry()
                for _name in _report:
                    _seam.register("tool", _MCPToolProvider(_name),
                                   name=f"mcp:{_name}",
                                   permissions={"network": True},
                                   source=f"mcp:{_name}")
            except Exception as _se:
                print(f"[mcp] seam registration failed: {_se}")
        elif _mcp.available:
            print("[mcp] no servers configured")
        else:
            print(f"[mcp] SDK unavailable: {_mcp.import_error}")
    except Exception as _e:  # noqa: BLE001
        print(f"[mcp] startup failed: {_e}")

    # Keep running forever
    await asyncio.Event().wait()


def run_server(config: dict, system_prompt: str = None, config_path: str = None):
    """Run server in blocking mode."""
    global _CONFIG, _CONFIG_PATH
    _CONFIG = config
    _CONFIG_PATH = config_path or _config_path()
    try:
        from shadow_config import apply_from_config
        apply_from_config(config)
    except Exception:
        pass
    host = config.get("server", {}).get("host", "127.0.0.1")
    port = int(os.environ.get("OVOLVE_SERVER_PORT") or os.environ.get("OVOLVE_SERVER_PORT") or 0)
    if port <= 0:
        port = config.get("server", {}).get("port", 8765)

    from router import Router
    from risk_control import init_risk_controller

    # Backend instance lock (defence-in-depth under Electron's own single-
    # instance lock): a second backend reached via dev mode / direct CLI would
    # otherwise write the same SQLite files concurrently and race every lease.
    # Refusal is loud but not fatal — the health endpoint reports it and the UI
    # can show it; killing the process here would make diagnosis impossible.
    try:
        import instance_lock
        # Same location rule Storage uses (env override > legacy env > the
        # migrated ~/.ovolve default). Resolved via user_dirs so the lock is
        # checked BEFORE any database is opened by this process.
        try:
            from user_dirs import db_dir as _user_db_dir
        except ImportError:
            from app.backend.user_dirs import db_dir as _user_db_dir
        _il = instance_lock.acquire(_user_db_dir())
        if _il.get("acquired"):
            print(f"[instance] lock held at {_il['lockPath']}"
                  + (f" ({_il['reason']})" if _il.get("reason") else ""))
        else:
            print(f"[instance] *** LOCK NOT HELD *** {_il.get('reason')} — "
                  "另一个后端可能正在写同一个数据库；健康检查将如实上报")
    except Exception as _e:  # noqa: BLE001
        print(f"[instance] lock check skipped: {_e}")

    init_risk_controller(config.get("permissions", {}).get("mode", "auto"))

    # Wire the LLM before Router constructs the memory/goal singletons — the
    # first constructor call fixes each singleton's callback, so doing this
    # afterwards would leave the server stuck in heuristic-only mode.
    from llm_client import get_llm_client
    from memory_layer import get_memory_layer
    from goal_manager import get_goal_manager
    from git_trust import get_commit_message_generator

    _llm = get_llm_client(config)
    # Teach the registry about config.json's credentials, otherwise every
    # resolve() misses and the callers that depend on it degrade in silence.
    try:
        from model_registry import get_model_registry
        get_model_registry().seed_from_config(config.get("model", {}))
    except Exception as e:
        print(f"[warn] model registry seed failed: {e}")
    try:
        from rate_limiter import get_rate_limiter
        configured_quotas = get_rate_limiter().configure(config)
        if configured_quotas:
            print(f"[rate_limiter] configured {configured_quotas} provider quota(s) from config")
    except Exception as e:
        print(f"[warn] rate limiter configure failed: {e}")
    if _llm.api_key:
        # Route each background module to the cheapest model that fits its job
        # (UD1) instead of the conversation model. Seeding the registry above is
        # the prerequisite — scene routing needs to see the configured models.
        scene = _wire_scene_callbacks(_llm)
        clients = scene["clients"]
        get_memory_layer(llm_callback=clients["memory"].call)
        get_goal_manager(llm_callback=clients["goal"].call)
        get_commit_message_generator(llm_callback=clients["commit"].call)
        print(f"[llm] {_llm.model_id} via {_llm.base_url}")
        print(f"[llm] scene routing: {scene['models']}")
    else:
        print("[warn] No LLM api_key configured - heuristic-only mode.")

    ws_root = config.get("workspace", {}).get("root", ".")
    if ws_root:
        try:
            os.makedirs(ws_root, exist_ok=True)
        except Exception:
            pass
    router = Router(ws_root, system_prompt=system_prompt or "")


    from file_agent import get_file_agent
    from computer_agent import get_computer_agent
    from app_agent import get_app_agent
    from browser_agent import get_browser_agent
    from search_agent import get_search_agent

    get_file_agent(router.workspace)
    get_computer_agent(router.workspace)
    get_app_agent(router.workspace)
    get_browser_agent(router.workspace)
    get_search_agent(router.workspace)

    # Specialized capability tools: red_team_scan /
    # security_audit / diagnose / recommend.
    import red_team, security_audit, diagnostics, recommender
    for _mod in (red_team, security_audit, diagnostics, recommender):
        try:
            _mod.register_tools()
        except Exception as _e:
            print(f"[warn] register_tools failed for {_mod.__name__}: {_e}")

    # Auto-discover on-disk skills (.agents/skills) so bundled skills like
    # docx / pdf / skill-creator / control-browser are usable without a manual
    # import call. Local skills are the user's own → loaded enabled.
    from skill_loader import get_skill_loader
    discovered = get_skill_loader().discover()
    if discovered["loaded"]:
        print(f"[skills] loaded: {', '.join(discovered['loaded'])}")
    if discovered["failed"]:
        for f in discovered["failed"]:
            print(f"[skills] skipped {f['name']}: {f['error']}")

    # Auto-discover installed plugins (.agents/plugins) AFTER skills, so a
    # plugin's own skills layer on top of the built-ins. Best-effort: a broken
    # plugin logs and is skipped, never blocks boot.
    try:
        from plugin_registry import get_plugin_registry
        plug = get_plugin_registry().discover()
        if plug["loaded"]:
            print(f"[plugins] loaded: {', '.join(plug['loaded'])}")
        for b in plug["broken"]:
            print(f"[plugins] broken {b['name']}: {b['error']}")
    except Exception as _e:  # noqa: BLE001
        print(f"[plugins] discovery skipped: {_e}")


    # External-script hooks (.agents/hooks.json). Disabled unless a config sets
    # enabled:true, so this is a no-op for users who never write a hook.
    from hook_runner import init_hooks
    hook_summary = init_hooks(router.workspace, router.session_id)
    if hook_summary["enabled"]:
        print(f"[hooks] enabled, {hook_summary['registered']} hook(s) registered")
    for problem in hook_summary["problems"]:
        print(f"[hooks] config problem: {problem}")

    # ── Bot subsystem: wire LLM callback, register configured providers, start
    # listeners.  Providers that are unconfigured (no token saved) are skipped
    # silently — the user can configure later via /api/bot/config/{platform}.
    from bot_remote import get_bot_controller
    from providers import get_provider, available_providers
    from session_host import get_session_host

    _bot_ctrl = get_bot_controller()

    async def _bot_dispatch(message: str, ctx: dict = None):
        """Route a bot message to the Router bound to its per-user session.

        `BotController` maintains one session per `platform:user_id`; passing
        that session_id through the shared router silently stamped every bot
        turn onto whichever session the desktop user was in. With a
        SessionHost we can spin up a real per-user Router and keep the two
        conversations independent.
        """
        ctx = ctx or {}
        sid = ctx.get("session_id")
        host_ref = get_session_host()
        if sid and host_ref is not None:
            try:
                target = host_ref.get_or_create(sid)
                return await target.handle(message, ctx)
            except Exception as exc:  # noqa: BLE001
                print(f"[bot] session resolve failed for {sid}: {exc}")
        return await router.handle(message, ctx)

    _bot_ctrl.set_llm_callback(_bot_dispatch)

    for _plat in available_providers():
        try:
            _prov = get_provider(_plat)
            if _prov.is_configured():
                _bot_ctrl.add_provider(_prov)
                print(f"[bot] {_plat} provider registered (configured)")
            else:
                print(f"[bot] {_plat} provider skipped (not configured)")
        except Exception as _e:
            print(f"[bot] {_plat} provider init failed: {_e}")

    asyncio.run(create_server(router, host, port))


if __name__ == "__main__":
    import json, os
    # This file lives at app/backend/server/http_server.py, so config.json —
    # which sits at app/config.json — is three levels up, not one. The old
    # single `..` pointed at app/backend/config.json (no such file) and this
    # entrypoint died with FileNotFoundError before binding the port. The
    # supported launcher is `python app/main.py --server`; this direct run is a
    # fallback and should resolve the same config it does.
    _here = os.path.dirname(os.path.abspath(__file__))
    _app_dir = os.path.abspath(os.path.join(_here, "..", ".."))
    config_path = os.path.join(_app_dir, "config.json")
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
    # Hand over the master prompt too; without it the server runs with an empty
    # system prompt and the agent loses its whole behavioural contract.
    system_prompt = ""
    _sp_path = os.path.join(_app_dir, "system_prompt.md")
    if os.path.exists(_sp_path):
        with open(_sp_path, encoding="utf-8") as f:
            system_prompt = f.read()
    run_server(config, system_prompt=system_prompt, config_path=config_path)
