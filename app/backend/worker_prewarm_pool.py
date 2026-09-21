"""F5 M4c — Prewarm pool for sidecar subprocess workers.



Keeps N idle ``ovolve_subagent_worker --sidecar`` processes warm to avoid

1–3s cold-start per spawn.  Pool miss falls back to one-shot spawn (M4a).

"""

from __future__ import annotations



import asyncio

import logging

import os

import sys

import time

from dataclasses import dataclass, field

from typing import Any, Optional



log = logging.getLogger(__name__)



_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

_WORKER_MODULE = "ovolve_subagent_worker"

DEFAULT_POOL_SIZE = int(os.environ.get("OVOLVE_WORKER_POOL_SIZE", "0"))

PREWARM_HEALTH_S = float(os.environ.get("OVOLVE_WORKER_POOL_HEALTH_S", "30"))





@dataclass

class _PoolEntry:

    session: Any  # SidecarSession

    idle_since: float = field(default_factory=time.time)

    uses: int = 0





class WorkerPrewarmPool:

    """Process pool of warm sidecar workers."""



    def __init__(self, pool_size: int = DEFAULT_POOL_SIZE) -> None:

        self.pool_size = max(0, int(pool_size))

        self._entries: list[_PoolEntry] = []

        self._lock = asyncio.Lock()

        self._started = False

        self._health_task: Optional[asyncio.Task] = None



    @property

    def enabled(self) -> bool:

        return self.pool_size > 0



    async def ensure_started(self) -> None:

        if self._started or not self.enabled:

            return

        async with self._lock:

            if self._started:

                return

            self._started = True

            await self._fill_to_target()

            self._health_task = asyncio.create_task(self._health_loop())



    async def _fill_to_target(self) -> None:

        while len(self._entries) < self.pool_size:

            entry = await self._spawn_idle()

            if entry is None:

                break

            self._entries.append(entry)



    async def _spawn_idle(self) -> Optional[_PoolEntry]:

        from subprocess_isolation import assign_pid_to_job, create_worker_job, popen_isolation_kwargs

        from worker_sidecar import SidecarSession



        log_path = os.path.join(

            _BACKEND_DIR, ".ovolve", "prewarm-logs",

            f"prewarm-{int(time.time() * 1000)}.log",

        )

        os.makedirs(os.path.dirname(log_path), exist_ok=True)

        env = dict(os.environ)

        env["PYTHONPATH"] = (

            _BACKEND_DIR + os.pathsep + env.get("PYTHONPATH", "")

        ).rstrip(os.pathsep)

        env.setdefault("PYTHONUNBUFFERED", "1")

        env["OVOLVE_WORKER_SIDECAR"] = "1"

        env["OVOLVE_WORKER_KIND"] = "sidecar"



        job = create_worker_job()

        try:

            proc = await asyncio.create_subprocess_exec(

                sys.executable,

                "-m",

                _WORKER_MODULE,

                "--sidecar",

                stdin=asyncio.subprocess.PIPE,

                stdout=asyncio.subprocess.PIPE,

                stderr=open(log_path, "a", encoding="utf-8"),  # noqa: SIM115

                env=env,

                **popen_isolation_kwargs(),

            )

        except Exception as exc:

            log.warning("[prewarm] spawn failed: %s", exc)

            if job:

                from subprocess_isolation import close_job

                close_job(job)

            return None



        if proc.stdin is None or proc.stdout is None or proc.pid is None:

            if job:

                from subprocess_isolation import close_job

                close_job(job)

            return None



        if job and not assign_pid_to_job(proc.pid, job):

            from subprocess_isolation import close_job

            close_job(job)

            job = None



        session = SidecarSession(proc=proc, pid=proc.pid, log_path=log_path, job_handle=job)

        await session.start_reader()

        if not await session.ping(timeout_s=5.0):

            await session.close(kill=True)

            return None

        return _PoolEntry(session=session)



    async def acquire(self) -> Optional[Any]:

        """Take an idle warm worker, or None on pool miss."""

        if not self.enabled:

            return None

        await self.ensure_started()

        async with self._lock:

            for entry in self._entries:

                if entry.session._closed:

                    continue

                entry.uses += 1

                entry.idle_since = 0.0

                return entry.session

            entry = await self._spawn_idle()

            if entry is None:

                return None

            entry.uses = 1

            self._entries.append(entry)

            return entry.session



    async def release(self, session: Any, *, healthy: bool = True) -> None:

        """Return worker to pool or kill if unhealthy / pool full."""

        if session is None:

            return

        async with self._lock:

            if not healthy or len(self._entries) >= self.pool_size * 2:

                await session.close(kill=True)

                self._entries = [e for e in self._entries if e.session is not session]

                return

            entry = next((e for e in self._entries if e.session is session), None)

            if entry is None:

                self._entries.append(_PoolEntry(session=session))

            entry = next((e for e in self._entries if e.session is session), None)

            if entry:

                entry.idle_since = time.time()

            alive = await session.ping(timeout_s=2.0)

            if not alive:

                await session.close(kill=True)

                self._entries = [e for e in self._entries if e.session is not session]

                await self._fill_to_target()



    async def _health_loop(self) -> None:

        while True:

            await asyncio.sleep(PREWARM_HEALTH_S)

            async with self._lock:

                survivors: list[_PoolEntry] = []

                for entry in self._entries:

                    if entry.session._closed:

                        continue

                    if not await entry.session.ping(timeout_s=2.0):

                        await entry.session.close(kill=True)

                        continue

                    survivors.append(entry)

                self._entries = survivors

                await self._fill_to_target()



    async def shutdown(self) -> None:

        if self._health_task:

            self._health_task.cancel()

            try:

                await self._health_task

            except asyncio.CancelledError:

                pass

        async with self._lock:

            for entry in self._entries:

                try:

                    await entry.session.shutdown(reason="pool_shutdown")

                except Exception:

                    pass

                await entry.session.close(kill=True)

            self._entries.clear()

        self._started = False





_pool: Optional[WorkerPrewarmPool] = None





def get_worker_prewarm_pool() -> WorkerPrewarmPool:

    global _pool

    if _pool is None:

        _pool = WorkerPrewarmPool()

    return _pool

