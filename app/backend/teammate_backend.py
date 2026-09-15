"""F5 — Teammate execution backends (in-process vs subprocess worker).



Subprocess mode uses a detached-process model (fork, log file, SIGTERM→SIGKILL)

without re-forking the whole Ovolve CLI. A lightweight ``ovolve_subagent_worker``

child reads one JSON spec from stdin and streams JSON lines on stdout.

"""

from __future__ import annotations



import asyncio

import json

import logging

import os

import sys

import time

from dataclasses import dataclass, field

from enum import Enum

from pathlib import Path

from typing import Any, Optional, Protocol



log = logging.getLogger(__name__)



_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

_WORKER_MODULE = "ovolve_subagent_worker"

_KILL_GRACE_S = 5.0

WORKER_HEARTBEAT_INTERVAL_S = 5.0

WORKER_HEARTBEAT_LOST_S = float(os.environ.get("OVOLVE_WORKER_HEARTBEAT_LOST_S", "15"))





class SubagentExecMode(str, Enum):

    INPROCESS = "inprocess"

    SUBPROCESS = "subprocess"





@dataclass

class TeammateSpawnSpec:

    subagent_id: str

    subagent_type: str

    label: str

    prompt: str

    child_session: str

    parent_session_id: str

    workspace_root: str

    system_prompt: str

    permission: str = "auto"

    model: Optional[str] = None

    model_role: str = "inherit"

    allowed_tools: Optional[list[str]] = None

    max_turns: Optional[int] = None

    subagent_depth: int = 0

    handoffs: list[str] = field(default_factory=list)

    dry_run: bool = False

    #: F5 M4c — parent session id for permission bridge (leaderEndpoint analogue).

    leader_endpoint: Optional[str] = None





@dataclass

class TeammateSpawnResult:

    ok: bool

    backend_id: str

    backend_type: str

    pid: Optional[int] = None

    log_path: Optional[str] = None

    text: str = ""

    error: str = ""

    meta: dict = field(default_factory=dict)

    lost: bool = False





@dataclass

class SubprocessHandle:

    subagent_id: str

    backend_id: str

    proc: asyncio.subprocess.Process

    log_path: str

    pid: int

    reader_task: Optional[asyncio.Task] = None

    last_heartbeat: float = field(default_factory=time.time)

    result: Optional[dict] = None

    job_handle: Any = None

    log_fh: Any = None





class TeammateBackend(Protocol):

    @property

    def backend_type(self) -> str: ...



    async def is_available(self) -> bool: ...



    async def run(self, spec: TeammateSpawnSpec) -> TeammateSpawnResult: ...



    async def kill(self, backend_id: str) -> bool: ...



    async def is_alive(self, backend_id: str) -> bool: ...





def resolve_exec_mode(

    definition,

    *,

    task_exec_mode: str = "",

    parent_ctx: Optional[dict] = None,

) -> SubagentExecMode:

    """Pick inprocess vs subprocess.



    Precedence:

    1. Explicit inprocess in task spec / persona / env

    2. Agent Teams workflow (user picked expert team) → subprocess even if

       ``OVOLVE_DISABLE_SUBPROCESS`` is set

    3. Explicit subprocess in task / persona / env / subprocess_swarm

    4. ``OVOLVE_DISABLE_SUBPROCESS`` → inprocess

    5. Default inprocess

    """

    task_raw = str(task_exec_mode or "").strip().lower()

    if task_raw in ("inprocess", "in-process", "in_process"):

        return SubagentExecMode.INPROCESS



    from team_collab import resolve_agent_teams_subprocess, subprocess_globally_disabled



    team_force = resolve_agent_teams_subprocess(parent_ctx)

    if team_force is True:

        persona_raw = str(getattr(definition, "exec_mode", "") or "").strip().lower()

        env_raw = os.environ.get("OVOLVE_SUBAGENT_EXEC_MODE", "").strip().lower()

        if task_raw in ("subprocess", "sub"):

            return SubagentExecMode.SUBPROCESS

        if persona_raw in ("subprocess", "sub"):

            return SubagentExecMode.SUBPROCESS

        if env_raw in ("subprocess", "sub"):

            return SubagentExecMode.SUBPROCESS

        if parent_ctx and str(parent_ctx.get("subprocess_swarm") or "").lower() in (

            "1", "true", "yes",

        ):

            return SubagentExecMode.SUBPROCESS

        # Team workflow without explicit mode → subprocess for isolation

        return SubagentExecMode.SUBPROCESS



    if subprocess_globally_disabled():

        return SubagentExecMode.INPROCESS



    for raw in (

        task_raw,

        str(getattr(definition, "exec_mode", "") or "").strip().lower(),

        os.environ.get("OVOLVE_SUBAGENT_EXEC_MODE", "").strip().lower(),

    ):

        if raw in ("subprocess", "sub"):

            return SubagentExecMode.SUBPROCESS

        if raw in ("inprocess", "in-process", "in_process"):

            return SubagentExecMode.INPROCESS



    if parent_ctx and str(parent_ctx.get("subprocess_swarm") or "").lower() in (

        "1", "true", "yes",

    ):

        return SubagentExecMode.SUBPROCESS



    return SubagentExecMode.INPROCESS





def subprocess_log_path(workspace_root: str, subagent_id: str) -> str:

    root = Path(workspace_root or ".")

    log_dir = root / ".ovolve" / "subprocess-logs"

    log_dir.mkdir(parents=True, exist_ok=True)

    return str(log_dir / f"{subagent_id}.log")





def _worker_env(log_path: str, name: str) -> dict[str, str]:

    env = dict(os.environ)

    backend_dir = _BACKEND_DIR

    env["PYTHONPATH"] = (

        backend_dir + os.pathsep + env.get("PYTHONPATH", "")

    ).rstrip(os.pathsep)

    env.setdefault("PYTHONUNBUFFERED", "1")

    env["OVOLVE_WORKER_KIND"] = "subprocess"

    env["OVOLVE_WORKER_NAME"] = name

    env["OVOLVE_WORKER_LOG"] = log_path

    return env





def _popen_kwargs() -> dict[str, Any]:

    from subprocess_isolation import popen_isolation_kwargs

    return popen_isolation_kwargs()





def is_process_running(pid: int) -> bool:

    from subprocess_isolation import is_process_running as _iso_running

    return _iso_running(pid)





def kill_process(pid: int, *, grace_s: float = _KILL_GRACE_S, job: Any = None) -> bool:

    from subprocess_isolation import kill_process_tree

    return kill_process_tree(pid, job=job, grace_s=grace_s)





def spec_to_worker_json(spec: TeammateSpawnSpec) -> dict:

    return {

        "v": 1,

        "subagent_id": spec.subagent_id,

        "subagent_type": spec.subagent_type,

        "label": spec.label,

        "prompt": spec.prompt,

        "child_session": spec.child_session,

        "parent_session_id": spec.parent_session_id,

        "workspace_root": spec.workspace_root,

        "system_prompt": spec.system_prompt,

        "permission": spec.permission,

        "model": spec.model,

        "model_role": spec.model_role,

        "allowed_tools": spec.allowed_tools,

        "max_turns": spec.max_turns,

        "subagent_depth": spec.subagent_depth,

        "handoffs": spec.handoffs,

        "dry_run": spec.dry_run,

        "leader_endpoint": spec.leader_endpoint or spec.parent_session_id,

    }





async def spawn_worker(

    spec: TeammateSpawnSpec,

    *,

    log_path: str,

) -> SubprocessHandle:

    from subprocess_isolation import assign_pid_to_job, create_worker_job



    name = f"teammate-{spec.parent_session_id}-{spec.label or spec.subagent_type}"

    env = _worker_env(log_path, name)

    log_fh = open(log_path, "a", encoding="utf-8")  # noqa: SIM115

    job = create_worker_job()

    try:

        proc = await asyncio.create_subprocess_exec(

            sys.executable,

            "-m",

            _WORKER_MODULE,

            stdin=asyncio.subprocess.PIPE,

            stdout=asyncio.subprocess.PIPE,

            stderr=log_fh,

            cwd=spec.workspace_root or None,

            env=env,

            **_popen_kwargs(),

        )

    except Exception:

        log_fh.close()

        if job:

            from subprocess_isolation import close_job

            close_job(job)

        raise



    if proc.stdin is None or proc.stdout is None:

        log_fh.close()

        if job:

            from subprocess_isolation import close_job

            close_job(job)

        raise RuntimeError("worker subprocess missing stdio pipes")

    if proc.pid is None:

        log_fh.close()

        if job:

            from subprocess_isolation import close_job

            close_job(job)

        raise RuntimeError("worker subprocess has no PID")



    if job and not assign_pid_to_job(proc.pid, job):

        log.warning("[subprocess] AssignProcessToJobObject failed for pid=%s", proc.pid)

        from subprocess_isolation import close_job

        close_job(job)

        job = None



    payload = json.dumps(spec_to_worker_json(spec), ensure_ascii=False)

    proc.stdin.write(payload.encode("utf-8"))

    await proc.stdin.drain()

    proc.stdin.close()

    try:

        log_fh.close()

    except Exception:

        pass



    backend_id = f"{spec.label or spec.subagent_type}@{spec.parent_session_id}"

    return SubprocessHandle(

        subagent_id=spec.subagent_id,

        backend_id=backend_id,

        proc=proc,

        log_path=log_path,

        pid=proc.pid,

        job_handle=job,

        log_fh=None,

    )





async def read_worker_until_result(

    handle: SubprocessHandle,

    *,

    timeout_s: float,

) -> dict:

    """Read stdout JSON lines until ``result`` or ``fatal``; detect heartbeat loss."""

    assert handle.proc.stdout is not None

    deadline = time.time() + timeout_s

    buf = b""



    def _heartbeat_lost() -> bool:

        return (

            time.time() - handle.last_heartbeat > WORKER_HEARTBEAT_LOST_S

            and handle.proc.returncode is None

        )



    while time.time() < deadline:

        if _heartbeat_lost():

            kill_process(handle.pid, job=handle.job_handle)

            await handle.proc.wait()

            return {

                "type": "fatal",

                "ok": False,

                "lost": True,

                "error": (

                    f"contact lost: no worker heartbeat for "

                    f"{WORKER_HEARTBEAT_LOST_S:.0f}s"

                ),

            }

        try:

            chunk = await asyncio.wait_for(

                handle.proc.stdout.read(4096),

                timeout=min(1.0, max(0.1, deadline - time.time())),

            )

        except asyncio.TimeoutError:

            if handle.proc.returncode is not None:

                break

            continue

        if not chunk:

            break

        buf += chunk

        while b"\n" in buf:

            line, buf = buf.split(b"\n", 1)

            line = line.strip()

            if not line:

                continue

            try:

                msg = json.loads(line.decode("utf-8"))

            except json.JSONDecodeError:

                continue

            if msg.get("type") == "heartbeat":

                handle.last_heartbeat = time.time()

                continue

            if msg.get("type") in ("result", "fatal"):

                handle.result = msg

                return msg



    if _heartbeat_lost():

        kill_process(handle.pid, job=handle.job_handle)

        await handle.proc.wait()

        return {

            "type": "fatal",

            "ok": False,

            "lost": True,

            "error": (

                f"contact lost: no worker heartbeat for "

                f"{WORKER_HEARTBEAT_LOST_S:.0f}s"

            ),

        }



    rc = handle.proc.returncode

    if rc is None:

        kill_process(handle.pid, job=handle.job_handle)

        await handle.proc.wait()

        rc = handle.proc.returncode

    if handle.result:

        return handle.result

    return {

        "type": "fatal",

        "ok": False,

        "error": f"worker exited without result (code={rc})",

    }





class SubprocessBackend:

    """Run one sub-agent turn in a child Python worker process."""



    backend_type = "subprocess"



    def __init__(self) -> None:

        self._handles: dict[str, SubprocessHandle] = {}



    async def is_available(self) -> bool:

        return True



    def get_handle(self, backend_id: str) -> Optional[SubprocessHandle]:

        return self._handles.get(backend_id)



    def get_handle_by_subagent(self, subagent_id: str) -> Optional[SubprocessHandle]:

        for h in self._handles.values():

            if h.subagent_id == subagent_id:

                return h

        return None



    async def run(

        self,

        spec: TeammateSpawnSpec,

        *,

        log_path: str,

        timeout_s: float,

    ) -> TeammateSpawnResult:

        bridge_host = None

        pool_session = None

        msg: dict = {}

        use_bridge = (

            bool(spec.parent_session_id)

            and os.environ.get("OVOLVE_PERMISSION_BRIDGE", "1").strip().lower()

            not in ("0", "false", "no")

        )

        if use_bridge:

            try:

                from permission_bridge import LeaderBridgeHost

                bridge_host = LeaderBridgeHost(

                    spec.parent_session_id,

                    auto_approve=str(spec.permission or "").lower() == "auto",

                )

                await bridge_host.start()

            except Exception as exc:

                log.debug("[subprocess] bridge host skipped: %s", exc)

                bridge_host = None



        if spec.leader_endpoint is None and use_bridge:

            spec.leader_endpoint = spec.parent_session_id



        try:

            try:

                from worker_prewarm_pool import get_worker_prewarm_pool

                pool = get_worker_prewarm_pool()

                if pool.enabled:

                    pool_session = await pool.acquire()

                    if pool_session is not None:

                        msg = await pool_session.run_turn(

                            spec_to_worker_json(spec),

                            timeout_s=timeout_s,

                        )

                        lost = bool(msg.get("lost"))

                        ok = bool(msg.get("ok")) and not lost

                        return TeammateSpawnResult(

                            ok=ok,

                            backend_id=(

                                f"{spec.label or spec.subagent_type}"

                                f"@{spec.parent_session_id}"

                            ),

                            backend_type=self.backend_type,

                            pid=pool_session.pid,

                            log_path=pool_session.log_path,

                            text=str(msg.get("text") or ""),

                            error=str(msg.get("error") or ""),

                            meta={**(msg.get("meta") or {}), "prewarm": True},

                            lost=lost,

                        )

            except Exception as exc:

                log.debug("[subprocess] prewarm miss: %s", exc)

                pool_session = None



            handle = await spawn_worker(spec, log_path=log_path)

            self._handles[handle.backend_id] = handle

            try:

                msg = await read_worker_until_result(handle, timeout_s=timeout_s)

                lost = bool(msg.get("lost"))

                ok = bool(msg.get("ok")) and not lost

                return TeammateSpawnResult(

                    ok=ok,

                    backend_id=handle.backend_id,

                    backend_type=self.backend_type,

                    pid=handle.pid,

                    log_path=log_path,

                    text=str(msg.get("text") or ""),

                    error=str(msg.get("error") or ""),

                    meta=dict(msg.get("meta") or {}),

                    lost=lost,

                )

            finally:

                self._handles.pop(handle.backend_id, None)

                if handle.proc.returncode is None:

                    try:

                        await asyncio.wait_for(handle.proc.wait(), timeout=2.0)

                    except asyncio.TimeoutError:

                        kill_process(handle.pid, job=handle.job_handle)

                if handle.job_handle:

                    from subprocess_isolation import close_job

                    close_job(handle.job_handle)

                    handle.job_handle = None

        finally:

            if pool_session is not None:

                try:

                    from worker_prewarm_pool import get_worker_prewarm_pool

                    await get_worker_prewarm_pool().release(

                        pool_session,

                        healthy=bool(msg.get("ok")),

                    )

                except Exception:

                    pass

            if bridge_host is not None:

                await bridge_host.stop()



    async def kill(self, backend_id: str) -> bool:

        handle = self._handles.get(backend_id)

        if handle is None:

            return False

        kill_process(handle.pid, job=handle.job_handle)

        if handle.job_handle:

            from subprocess_isolation import close_job

            close_job(handle.job_handle)

            handle.job_handle = None

        self._handles.pop(backend_id, None)

        return True



    async def is_alive(self, backend_id: str) -> bool:

        handle = self._handles.get(backend_id)

        if handle is None:

            return False

        return is_process_running(handle.pid)



    def any_alive_for_parent(self, parent_session_id: str) -> bool:

        prefix = f"@{parent_session_id}"

        for bid, handle in self._handles.items():

            if bid.endswith(prefix) and is_process_running(handle.pid):

                return True

        return False

