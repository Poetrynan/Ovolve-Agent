"""F5 — lightweight subprocess worker for one sub-agent turn.

Modes:
  default   — read one JSON spec from stdin, run one turn, exit
  --sidecar — JSON-RPC session loop (prewarm pool reuses these processes)

Invoked as ``python -m ovolve_subagent_worker``.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time


def _emit(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def _heartbeat_loop(stop: asyncio.Event, interval: float = 5.0) -> None:
    while not stop.is_set():
        _emit({"type": "heartbeat", "ts": time.time()})
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass


async def _mailbox_shutdown_poll(
    child_session: str,
    stop: asyncio.Event,
    *,
    interval: float = 1.0,
) -> None:
    """Poll child mailbox for shutdown_request; respond and signal stop."""
    if not child_session:
        return
    box = f"mailbox:{child_session}"
    while not stop.is_set():
        try:
            from storage import get_storage
            from mailbox import KIND_CONTROL, ORIGIN_FRAMEWORK, drain, send

            storage = get_storage()
            for msg in drain(storage, box, limit=10):
                payload = msg.get("payload") or {}
                if payload.get("type") != "shutdown_request":
                    continue
                request_id = str(payload.get("request_id") or "")
                send(
                    storage,
                    box,
                    "ovolve_subagent_worker",
                    kind=KIND_CONTROL,
                    origin=ORIGIN_FRAMEWORK,
                    payload={
                        "type": "shutdown_response",
                        "request_id": request_id,
                        "ok": True,
                        "reason": str(payload.get("reason") or ""),
                    },
                )
                _emit({
                    "type": "shutdown_response",
                    "request_id": request_id,
                    "ok": True,
                })
                stop.set()
                return
        except Exception:
            pass
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass


def _install_permission_bridge(spec: dict) -> None:
    leader = str(spec.get("leader_endpoint") or spec.get("parent_session_id") or "")
    if leader and os.environ.get("OVOLVE_PERMISSION_BRIDGE", "1") not in ("0", "false"):
        from permission_bridge import install_worker_bridge_hook
        install_worker_bridge_hook(leader)


async def _run_turn(spec: dict) -> dict:
    if spec.get("dry_run"):
        stop = asyncio.Event()
        hb = asyncio.create_task(_heartbeat_loop(stop))
        child_session = str(spec.get("child_session") or "")
        shutdown_poll = asyncio.create_task(
            _mailbox_shutdown_poll(child_session, stop),
        )
        try:
            await asyncio.sleep(0.15)
            if stop.is_set():
                return {
                    "type": "result",
                    "ok": False,
                    "text": "",
                    "error": "shutdown requested",
                    "meta": {"shutdown": True},
                }
            return {
                "type": "result",
                "ok": True,
                "text": "dry-run ok",
                "error": "",
                "meta": {"dry_run": True},
            }
        finally:
            stop.set()
            hb.cancel()
            shutdown_poll.cancel()
            for t in (hb, shutdown_poll):
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    from risk_control import coerce_permission
    from router import Router
    from subagent_runtime import (
        _CTX_DIGEST_CONTRACT,
        _read_workspace_rules,
        extract_context_digest,
        render_context_digest,
        strip_final_marker,
    )
    from subagent_runtime import resolve_child_allowlist
    from subagent_registry import SubagentDef

    _install_permission_bridge(spec)

    prompt = str(spec.get("prompt") or "")
    child_session = str(spec.get("child_session") or "")
    workspace = str(spec.get("workspace_root") or "") or None
    parent_session = str(spec.get("parent_session_id") or "")
    depth = int(spec.get("subagent_depth") or 0)
    handoffs = frozenset(str(h) for h in (spec.get("handoffs") or []))

    system_prompt = str(spec.get("system_prompt") or "")
    if handoffs:
        targets = ", ".join(sorted(handoffs))
        system_prompt += (
            f"\nHand-off: you may delegate ONCE, via the `task` tool, "
            f"to: {targets}.\n"
        )
    system_prompt += _CTX_DIGEST_CONTRACT
    rules = _read_workspace_rules(workspace or "")
    if rules:
        system_prompt += (
            "\n<parent-context>\n"
            "Workspace rules that apply to this task (follow them "
            "whenever they touch your work):\n"
            f"{rules}\n"
            "</parent-context>\n"
        )

    stub = SubagentDef(
        name=str(spec.get("subagent_type") or "worker"),
        description="",
        system_prompt=system_prompt,
        allowed_tools=(
            frozenset(spec["allowed_tools"])
            if spec.get("allowed_tools") else None
        ),
        permission=str(spec.get("permission") or "auto"),
        handoffs=handoffs,
    )

    router = Router(
        workspace=workspace,
        system_prompt=system_prompt,
        session_id=child_session,
        mount_shared=False,
    )
    router.is_subagent = True
    router.allowed_tools = resolve_child_allowlist(stub, "")
    router.subagent_handoffs = handoffs
    router.subagent_depth = depth + 1
    max_turns = spec.get("max_turns")
    if max_turns is not None and int(max_turns) > 0:
        router.max_agent_steps = int(max_turns)
    else:
        router.max_agent_steps = 0  # 0 indicates unbounded execution
    router.permission = coerce_permission(stub.permission)
    model = spec.get("model")
    if model:
        try:
            router._bind_turn_model(str(model))
        except Exception:
            pass

    leader = str(spec.get("leader_endpoint") or parent_session or "")
    child_ctx = {
        "session_id": child_session,
        "workspace_root": workspace,
        "is_subagent": True,
        "parent_session_id": parent_session,
        "leader_endpoint": leader,
        "permission": stub.permission,
        "subagent_depth": depth + 1,
    }

    stop = asyncio.Event()
    hb = asyncio.create_task(_heartbeat_loop(stop))
    shutdown_poll = asyncio.create_task(
        _mailbox_shutdown_poll(child_session, stop),
    )

    try:
        result = await router.handle(prompt, child_ctx)
        if stop.is_set():
            return {
                "type": "result",
                "ok": False,
                "text": "",
                "error": "shutdown requested",
                "meta": {"shutdown": True},
            }
        raw_text = (result.value if getattr(result, "ok", False) else "") or ""
        ok = bool(getattr(result, "ok", False))
        err = "" if ok else (getattr(result, "error", "") or "sub-agent failed")
        meta = dict(getattr(result, "meta", None) or {})
        text, marker_seen = strip_final_marker(str(raw_text))
        text, ctx_digest = extract_context_digest(text)
        if ctx_digest:
            rendered = render_context_digest(ctx_digest)
            if rendered:
                text = rendered + "\n\n" + text
        stopped_incomplete = ok and bool(meta.get("incomplete"))
        if stopped_incomplete:
            text = (
                "[STALE — sub-agent ran out of steps without declaring done]\n\n"
                + text
            )
            err = meta.get("stop_reason", "step_cap")
        return {
            "type": "result",
            "ok": ok and not stopped_incomplete,
            "text": text,
            "error": err,
            "meta": {
                **meta,
                "final_marker": marker_seen,
                "context_digest": ctx_digest,
                "stale": stopped_incomplete,
                "model_role": spec.get("model_role") or "inherit",
            },
        }
    finally:
        stop.set()
        hb.cancel()
        shutdown_poll.cancel()
        for t in (hb, shutdown_poll):
            try:
                await t
            except asyncio.CancelledError:
                pass
        try:
            if hasattr(router, "teardown"):
                router.teardown()
        except Exception:
            pass


async def _sidecar_loop() -> int:
    from worker_sidecar import dispatch_rpc_request, make_response, parse_rpc_line

    shutting_down = asyncio.Event()

    async def _shutdown_fn(reason: str) -> dict:
        shutting_down.set()
        _emit({"type": "shutdown_response", "ok": True, "reason": reason})
        return {"ok": True, "reason": reason}

    buf = b""
    while not shutting_down.is_set():
        chunk = await asyncio.get_event_loop().run_in_executor(
            None, sys.stdin.buffer.read1, 4096,
        )
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            req = parse_rpc_line(line)
            if req is None:
                continue
            resp = await dispatch_rpc_request(
                req,
                run_turn_fn=_run_turn,
                shutdown_fn=_shutdown_fn,
            )
            if resp is not None:
                _emit(resp)
            if shutting_down.is_set():
                return 0
    return 0


async def _main_async() -> int:
    try:
        from worker_sidecar import start_parent_death_watchdog
        start_parent_death_watchdog()
    except Exception:
        pass

    if os.environ.get("OVOLVE_WORKER_SIDECAR") == "1" or "--sidecar" in sys.argv:
        return await _sidecar_loop()

    raw = sys.stdin.read()
    if not raw.strip():
        _emit({"type": "fatal", "ok": False, "error": "empty worker spec"})
        return 1
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as exc:
        _emit({"type": "fatal", "ok": False, "error": f"invalid spec json: {exc}"})
        return 1

    if os.environ.get("OVOLVE_WORKER_HANG") == "1":
        await asyncio.sleep(3600)
        _emit({"type": "fatal", "ok": False, "error": "worker hang test mode"})
        return 1

    stop = asyncio.Event()
    child_session = str(spec.get("child_session") or "")
    hb = asyncio.create_task(_heartbeat_loop(stop))
    shutdown_poll = asyncio.create_task(
        _mailbox_shutdown_poll(child_session, stop),
    )
    try:
        out = await _run_turn(spec)
        _emit(out)
        return 0 if out.get("ok") else 1
    except Exception as exc:
        _emit({"type": "fatal", "ok": False, "error": f"worker crashed: {exc}"})
        return 1
    finally:
        stop.set()
        hb.cancel()
        shutdown_poll.cancel()
        for t in (hb, shutdown_poll):
            try:
                await t
            except asyncio.CancelledError:
                pass


def main() -> None:
    if "--sidecar" in sys.argv:
        os.environ.setdefault("OVOLVE_WORKER_SIDECAR", "1")
    raise SystemExit(asyncio.run(_main_async()))


if __name__ == "__main__":
    main()
