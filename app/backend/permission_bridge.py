"""F5 M4c — Permission bridge (Ovolve leaderEndpoint equivalent).

Subprocess workers cannot surface approval UI directly.  When
``leader_endpoint`` (parent session id) is set on the spawn spec, tool
approval asks are relayed parent ↔ child via SQLite mailbox:

  child  → ``mailbox:bridge:{parent_session_id}``   (approval_request)
  parent → ``mailbox:{child_session_id}``             (approval_response)
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Optional

log = logging.getLogger(__name__)

BRIDGE_BOX_FMT = "mailbox:bridge:{parent_session_id}"
BRIDGE_POLL_S = 0.25
DEFAULT_APPROVAL_TIMEOUT_S = float(
    __import__("os").environ.get("OVOLVE_BRIDGE_APPROVAL_TIMEOUT_S", "120")
)


def bridge_box_id(parent_session_id: str) -> str:
    return BRIDGE_BOX_FMT.format(parent_session_id=str(parent_session_id or ""))


def send_approval_request(
    storage,
    *,
    parent_session_id: str,
    child_session_id: str,
    call_id: str,
    tool_name: str,
    args: dict,
    prompt: str,
) -> str:
    from mailbox import KIND_CONTROL, ORIGIN_FRAMEWORK, send

    request_id = uuid.uuid4().hex[:12]
    send(
        storage,
        bridge_box_id(parent_session_id),
        child_session_id,
        kind=KIND_CONTROL,
        origin=ORIGIN_FRAMEWORK,
        payload={
            "type": "approval_request",
            "request_id": request_id,
            "call_id": call_id,
            "tool_name": tool_name,
            "args": args or {},
            "prompt": str(prompt or "")[:2000],
            "child_session": child_session_id,
        },
    )
    return request_id


def send_approval_response(
    storage,
    *,
    child_session_id: str,
    request_id: str,
    decision: str,
    reason: str = "",
) -> str:
    from mailbox import KIND_CONTROL, ORIGIN_FRAMEWORK, send

    return send(
        storage,
        f"mailbox:{child_session_id}",
        "permission_bridge",
        kind=KIND_CONTROL,
        origin=ORIGIN_FRAMEWORK,
        payload={
            "type": "approval_response",
            "request_id": request_id,
            "decision": decision,
            "reason": reason,
        },
    )


def drain_approval_requests(storage, parent_session_id: str, *, limit: int = 20) -> list[dict]:
    from mailbox import drain

    return drain(storage, bridge_box_id(parent_session_id), limit=limit)


def find_approval_response(
    storage,
    child_session_id: str,
    request_id: str,
) -> Optional[dict]:
    from mailbox import unread

    for msg in unread(storage, f"mailbox:{child_session_id}", limit=50):
        payload = msg.get("payload") or {}
        if (
            payload.get("type") == "approval_response"
            and str(payload.get("request_id") or "") == request_id
        ):
            from mailbox import consume
            consume(storage, str(msg.get("id") or ""))
            return payload
    return None


async def wait_approval_response(
    storage,
    child_session_id: str,
    request_id: str,
    *,
    timeout_s: float = DEFAULT_APPROVAL_TIMEOUT_S,
) -> Optional[dict]:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        resp = find_approval_response(storage, child_session_id, request_id)
        if resp is not None:
            return resp
        await asyncio.sleep(BRIDGE_POLL_S)
    return None


async def bridge_permission_event(event) -> None:
    """Event-bus hook: worker asks leader for approval via mailbox."""
    payload = event.payload or {}
    context = payload.get("context") or {}
    leader = str(context.get("leader_endpoint") or context.get("parent_session_id") or "")
    child_session = str(context.get("session_id") or "")
    if not leader or not child_session:
        return

    try:
        from storage import get_storage
        storage = get_storage()
    except Exception:
        event.modify({**payload, "hook_decision": "deny"})
        return

    request_id = send_approval_request(
        storage,
        parent_session_id=leader,
        child_session_id=child_session,
        call_id=str(payload.get("call_id") or ""),
        tool_name=str(payload.get("tool_name") or ""),
        args=dict(payload.get("args") or {}),
        prompt=str(payload.get("reason") or ""),
    )
    resp = await wait_approval_response(storage, child_session, request_id)
    if resp is None:
        event.modify({**payload, "hook_decision": "deny"})
        return
    decision = str(resp.get("decision") or "deny").lower()
    hook = "allow" if decision in ("approve", "approve_always", "allow") else "deny"
    event.modify({**payload, "hook_decision": hook})


class LeaderBridgeHost:
    """Parent-side poller: forwards bridge approval requests to risk / auto-approve."""

    def __init__(self, parent_session_id: str, *, auto_approve: bool = False) -> None:
        self.parent_session_id = parent_session_id
        self.auto_approve = auto_approve
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task is None:
            self._stop.clear()
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None

    async def _loop(self) -> None:
        try:
            from storage import get_storage
            storage = get_storage()
        except Exception:
            return
        while not self._stop.is_set():
            try:
                for msg in drain_approval_requests(storage, self.parent_session_id):
                    await self._handle_request(storage, msg)
            except Exception as exc:
                log.debug("[permission_bridge] poll error: %s", exc)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=BRIDGE_POLL_S)
            except asyncio.TimeoutError:
                pass

    async def _handle_request(self, storage, msg: dict) -> None:
        payload = msg.get("payload") or {}
        if payload.get("type") != "approval_request":
            return
        child_session = str(payload.get("child_session") or msg.get("sender") or "")
        request_id = str(payload.get("request_id") or "")
        tool_name = str(payload.get("tool_name") or "")
        args = dict(payload.get("args") or {})
        call_id = str(payload.get("call_id") or "")

        decision = "deny"
        if self.auto_approve:
            decision = "approve"
        else:
            try:
                from risk_control import get_risk_controller
                risk = get_risk_controller()
                if risk.has_grant(tool_name, args, {"session_id": self.parent_session_id}):
                    decision = "approve"
                else:
                    # Forward to parent's pending queue — user answers on parent UI.
                    risk.record_pending(
                        call_id or request_id,
                        tool_name,
                        args,
                        str(payload.get("prompt") or f"子代理请求: {tool_name}"),
                        self.parent_session_id,
                    )
                    return  # wait for explicit resolve via resolve_bridge_pending
            except Exception:
                decision = "deny"

        send_approval_response(
            storage,
            child_session_id=child_session,
            request_id=request_id,
            decision=decision,
        )

    def resolve_pending(
        self,
        storage,
        *,
        call_id: str,
        decision: str,
        child_session_id: str = "",
        request_id: str = "",
    ) -> bool:
        """Called when parent user approves a bridged ask."""
        send_approval_response(
            storage,
            child_session_id=child_session_id,
            request_id=request_id or call_id,
            decision=decision,
        )
        return True


def install_worker_bridge_hook(leader_endpoint: str) -> None:
    """Register permission_request hook in worker process (idempotent)."""
    if not leader_endpoint:
        return
    try:
        from event_bus import get_event_bus

        bus = get_event_bus()
        if getattr(bus, "_ovolve_bridge_hook_installed", False):
            return

        async def _hook(event):
            ctx = (event.payload or {}).get("context") or {}
            if not ctx.get("leader_endpoint"):
                event.payload = {**(event.payload or {}), "context": {
                    **ctx, "leader_endpoint": leader_endpoint,
                }}
            await bridge_permission_event(event)

        bus.on("permission_request", _hook, priority=100)
        bus._ovolve_bridge_hook_installed = True  # type: ignore[attr-defined]
    except Exception as exc:
        log.debug("[permission_bridge] hook install failed: %s", exc)
