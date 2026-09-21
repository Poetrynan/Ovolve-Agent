"""F5 M4c — JSON-RPC sidecar session layer for subprocess workers.

Newline-delimited JSON-RPC 2.0 over worker stdio. One long-lived worker
process can serve multiple ``run_turn`` invocations (prewarm pool reuses
these sessions).
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

JSONRPC_VERSION = "2.0"


def make_request(method: str, params: dict | None = None, *, req_id: str = "") -> dict:
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": req_id or uuid.uuid4().hex[:12],
        "method": method,
        "params": params or {},
    }


def make_response(req_id: str, result: Any = None, *, error: Optional[dict] = None) -> dict:
    msg: dict[str, Any] = {"jsonrpc": JSONRPC_VERSION, "id": req_id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    return msg


def make_event(event: str, payload: dict | None = None) -> dict:
    """Out-of-band notification (heartbeats, progress) — not a JSON-RPC response."""
    return {"type": event, **(payload or {})}


@dataclass
class SidecarSession:
    """Connected sidecar worker with async JSON-RPC over stdio."""

    proc: asyncio.subprocess.Process
    pid: int
    log_path: str
    _pending: dict[str, asyncio.Future] = field(default_factory=dict)
    _reader_task: Optional[asyncio.Task] = None
    _closed: bool = False
    job_handle: Any = None

    async def start_reader(self) -> None:
        if self._reader_task is None:
            self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        buf = b""
        while not self._closed:
            try:
                chunk = await self.proc.stdout.read(4096)
            except Exception:
                break
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
                req_id = str(msg.get("id") or "")
                if req_id and req_id in self._pending:
                    fut = self._pending.pop(req_id)
                    if not fut.done():
                        if "error" in msg:
                            fut.set_exception(RuntimeError(str(msg["error"])))
                        else:
                            fut.set_result(msg.get("result"))
                # Events (heartbeat, shutdown_response) are ignored here — callers
                # that care should attach a tap; prewarm health uses ping RPC.

    async def call(self, method: str, params: dict | None = None, *, timeout_s: float = 120.0) -> Any:
        if self._closed or self.proc.returncode is not None:
            raise RuntimeError("sidecar session is closed")
        await self.start_reader()
        req_id = uuid.uuid4().hex[:12]
        payload = make_request(method, params, req_id=req_id)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout=timeout_s)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise

    async def ping(self, timeout_s: float = 3.0) -> bool:
        try:
            result = await self.call("ping", {}, timeout_s=timeout_s)
            return bool((result or {}).get("ok"))
        except Exception:
            return False

    async def run_turn(self, spec: dict, *, timeout_s: float = 600.0) -> dict:
        result = await self.call("run_turn", {"spec": spec}, timeout_s=timeout_s)
        if not isinstance(result, dict):
            return {"type": "fatal", "ok": False, "error": "invalid run_turn result"}
        return result

    async def shutdown(self, *, reason: str = "pool_release", timeout_s: float = 5.0) -> bool:
        try:
            result = await self.call(
                "shutdown",
                {"reason": reason},
                timeout_s=timeout_s,
            )
            return bool((result or {}).get("ok"))
        except Exception:
            return False

    async def close(self, *, kill: bool = True) -> None:
        self._closed = True
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
        if kill and self.proc.returncode is None:
            from teammate_backend import kill_process
            kill_process(self.pid, job=self.job_handle)
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass
        if self.job_handle:
            from subprocess_isolation import close_job
            close_job(self.job_handle)
            self.job_handle = None


def parse_rpc_line(line: bytes) -> Optional[dict]:
    line = line.strip()
    if not line:
        return None
    try:
        return json.loads(line.decode("utf-8"))
    except json.JSONDecodeError:
        return None


async def dispatch_rpc_request(
    req: dict,
    *,
    run_turn_fn,
    shutdown_fn,
) -> Optional[dict]:
    """Worker-side dispatcher. Returns a JSON-RPC response or None for notifications."""
    if req.get("jsonrpc") != JSONRPC_VERSION:
        return None
    req_id = req.get("id")
    method = str(req.get("method") or "")
    params = req.get("params") or {}

    if method == "ping":
        return make_response(str(req_id), {"ok": True, "ts": time.time()})
    if method == "run_turn":
        spec = params.get("spec") or {}
        try:
            out = await run_turn_fn(spec)
            return make_response(str(req_id), out)
        except Exception as exc:
            return make_response(
                str(req_id),
                error={"code": -32000, "message": str(exc)},
            )
    if method == "shutdown":
        reason = str(params.get("reason") or "")
        try:
            out = await shutdown_fn(reason)
            return make_response(str(req_id), out)
        except Exception as exc:
            return make_response(
                str(req_id),
                error={"code": -32001, "message": str(exc)},
            )
    if req_id:
        return make_response(
            str(req_id),
            error={"code": -32601, "message": f"unknown method: {method}"},
        )
    return None


# ── 父进程自杀守护 (Task 2.4) ────────────────────────────────────────────────
import os
import threading
from typing import Callable


def is_parent_alive(parent_pid: Optional[int] = None) -> bool:
    """检查父进程是否仍然存活。跨平台支持 Windows 与 POSIX。"""
    if parent_pid is None:
        parent_pid = os.getppid()
    if parent_pid <= 0:
        return False

    if os.name != "nt":
        curr_ppid = os.getppid()
        if curr_ppid == 1 or curr_ppid != parent_pid:
            return False
        try:
            os.kill(parent_pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False
    else:
        try:
            import ctypes
            SYNCHRONIZE = 0x00100000
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(
                SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                False,
                parent_pid,
            )
            if not handle:
                return False
            try:
                WAIT_OBJECT_0 = 0
                res = ctypes.windll.kernel32.WaitForSingleObject(handle, 0)
                if res == WAIT_OBJECT_0:
                    # 句柄已置信触发，表明父进程已终止
                    return False
                return True
            finally:
                ctypes.windll.kernel32.CloseHandle(handle)
        except Exception:
            try:
                import psutil
                return psutil.pid_exists(parent_pid)
            except Exception:
                return True


def start_parent_death_watchdog(
    parent_pid: Optional[int] = None,
    interval_s: float = 1.0,
    on_parent_dead: Optional[Callable[[], None]] = None,
) -> threading.Thread:
    """启动子进程侧后台自杀守护线程。

    轮询父进程状态；一旦探测到父进程死亡，主动调用 on_parent_dead 并执行 os._exit(0)，
    杜绝孤儿进程泄漏。
    """
    if parent_pid is None:
        parent_pid = os.getppid()

    def _watchdog_loop():
        while True:
            time.sleep(interval_s)
            if not is_parent_alive(parent_pid):
                if on_parent_dead is not None:
                    try:
                        on_parent_dead()
                    except Exception:
                        pass
                os._exit(0)

    t = threading.Thread(target=_watchdog_loop, name="SidecarParentWatchdog", daemon=True)
    t.start()
    return t

