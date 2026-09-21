"""F5/F6 — Team collaboration runtime helpers (Ovolve-native).



Implements mailbox + SubagentRuntime primitives for multi-agent coordination

(shutdown_request/response, message origin tagging).

"""

from __future__ import annotations



import asyncio

import logging

import os

import time

import uuid

from typing import Any, Optional



log = logging.getLogger(__name__)



# ── Agent Teams policy (resolveAgentTeamsEnv analogue) ─────────────────────



_TEAM_WORKFLOW_KEYS = (

    "team_mode",

    "agent_team",

    "multi_agent_workflow",

    "agent_teams",

)



_TEAM_WORKFLOW_VALUES = frozenset({

    "1", "true", "yes", "team", "expert_team", "agent_team", "agent_teams",

})





def team_workflow_active(parent_ctx: Optional[dict]) -> bool:

    """True when the user explicitly chose a multi-agent / expert-team workflow."""

    if not parent_ctx:

        return False

    for key in _TEAM_WORKFLOW_KEYS:

        val = str(parent_ctx.get(key) or "").strip().lower()

        if val in _TEAM_WORKFLOW_VALUES:

            return True

    if parent_ctx.get("multi_agent_workflow") is True:

        return True

    return False





def subprocess_globally_disabled() -> bool:

    return os.environ.get("OVOLVE_DISABLE_SUBPROCESS", "").strip().lower() in (

        "1", "true", "yes",

    )





def resolve_agent_teams_subprocess(parent_ctx: Optional[dict]) -> Optional[bool]:

    """Whether Agent Teams workflow should force subprocess mode.



    Returns:

        True  — team workflow overrides OVOLVE_DISABLE_SUBPROCESS

        False — never (only explicit inprocess in task/persona blocks)

        None  — defer to normal resolve_exec_mode precedence

    """

    if team_workflow_active(parent_ctx):

        return True

    return None





# ── Graceful shutdown (shutdown_request / shutdown_response) ─────────────────



SHUTDOWN_DEFAULT_TIMEOUT_S = float(os.environ.get("OVOLVE_SHUTDOWN_TIMEOUT_S", "10"))

SHUTDOWN_POLL_S = 0.25





def _graceful_shutdown_enabled() -> bool:

    return os.environ.get("OVOLVE_GRACEFUL_SHUTDOWN", "1").strip().lower() not in (

        "0", "false", "no",

    )





def _send_shutdown_request(

    storage,

    *,

    child_session_id: str,

    subagent_id: str,

    request_id: str,

    reason: str,

    deadline_s: float,

) -> None:

    from mailbox import KIND_CONTROL, ORIGIN_FRAMEWORK, send



    send(

        storage,

        f"mailbox:{child_session_id}",

        "team_collab",

        kind=KIND_CONTROL,

        origin=ORIGIN_FRAMEWORK,

        payload={

            "type": "shutdown_request",

            "request_id": request_id,

            "subagent_id": subagent_id,

            "reason": reason,

            "deadline_s": deadline_s,

        },

    )





async def graceful_shutdown_team(

    runtime,

    parent_session_id: str,

    *,

    reason: str = "user_stop",

    timeout_s: float | None = None,

) -> dict[str, Any]:

    """Two-phase shutdown: control mailbox → cooperative cancel → hard kill."""

    timeout_s = SHUTDOWN_DEFAULT_TIMEOUT_S if timeout_s is None else float(timeout_s)

    request_id = uuid.uuid4().hex[:12]

    active_before = runtime.list_active(parent_session_id)

    if not active_before:

        return {

            "ok": True,

            "request_id": request_id,

            "requested": 0,

            "graceful": 0,

            "killed": 0,

        }



    try:

        from storage import get_storage

        storage = get_storage()

    except Exception:

        storage = None



    if storage is not None:

        for row in active_before:

            child_sid = str(row.get("childSessionId") or "")

            sid = str(row.get("subagentId") or "")

            if child_sid:

                try:

                    _send_shutdown_request(

                        storage,

                        child_session_id=child_sid,

                        subagent_id=sid,

                        request_id=request_id,

                        reason=reason,

                        deadline_s=timeout_s,

                    )

                except Exception as exc:

                    log.warning("[team_collab] shutdown_request failed for %s: %s", sid, exc)

        try:

            from mailbox import KIND_INFO, ORIGIN_FRAMEWORK, send



            send(

                storage,

                f"mailbox:{parent_session_id}",

                "team_collab",

                kind=KIND_INFO,

                origin=ORIGIN_FRAMEWORK,

                payload={

                    "event": "shutdown_requested",

                    "request_id": request_id,

                    "reason": reason,

                    "count": len(active_before),

                    "deadline_s": timeout_s,

                },

            )

        except Exception:

            pass



    # Cooperative: router.cancel / subprocess SIGTERM path via kill()

    for row in active_before:

        sid = str(row.get("subagentId") or "")

        if sid:

            runtime.kill(sid)



    deadline = time.time() + timeout_s

    while time.time() < deadline:

        if not runtime.list_active(parent_session_id):

            break

        await asyncio.sleep(SHUTDOWN_POLL_S)



    remaining = runtime.list_active(parent_session_id)

    killed = 0

    if remaining:

        killed = runtime.kill_all(parent_session_id, graceful=False)



    return {

        "ok": not remaining or killed > 0,

        "request_id": request_id,

        "requested": len(active_before),

        "graceful": len(active_before) - len(remaining) - killed,

        "killed": killed,

        "remaining": len(remaining) - killed if remaining else 0,

    }





# ── TeammateIdleTracker (F6 idle_since consumer) ─────────────────────────────



class TeammateIdleTracker:

    """Surface teammates that have been terminal-idle longer than a threshold."""



    def __init__(self, idle_threshold_s: float = 60.0) -> None:

        self.idle_threshold_s = float(idle_threshold_s)



    def scan(self, runtime, parent_session_id: str) -> list[dict[str, Any]]:

        now = time.time()

        out: list[dict[str, Any]] = []

        for row in runtime.list_sessions(parent_session_id):

            idle_since = row.get("idleSince")

            if not idle_since:

                continue

            elapsed = now - float(idle_since)

            if elapsed >= self.idle_threshold_s:

                out.append({**row, "idleElapsedS": int(elapsed)})

        return out

