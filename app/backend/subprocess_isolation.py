"""OS-level subprocess isolation for F5 teammate workers.

Windows: Job Object with ``KILL_ON_JOB_CLOSE`` so children die with the parent.
Unix: ``start_new_session`` + ``killpg`` for tree teardown.
"""
from __future__ import annotations

import ctypes
import logging
import os
import signal
import time
from typing import Any, Optional

log = logging.getLogger(__name__)

_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JobObjectExtendedLimitInformation = 9


def popen_isolation_kwargs() -> dict[str, Any]:
    kw: dict[str, Any] = {}
    if os.name == "nt":
        import subprocess
        kw["creationflags"] = (
            subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        )
    else:
        kw["start_new_session"] = True
    return kw


def _win_api() -> Optional[dict]:
    if os.name != "nt":
        return None
    try:
        k32 = ctypes.windll.kernel32
    except Exception:
        return None
    return {"ctypes": ctypes, "k32": k32}


def create_worker_job() -> Any:
    """Create a Windows job that kills children when the handle is closed."""
    api = _win_api()
    if api is None:
        return None
    k32 = api["k32"]
    ctypes = api["ctypes"]
    job = k32.CreateJobObjectW(None, None)
    if not job:
        return None
    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", ctypes.c_uint32),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", ctypes.c_uint32),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", ctypes.c_uint32),
            ("SchedulingClass", ctypes.c_uint32),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = k32.SetInformationJobObject(
        job,
        _JobObjectExtendedLimitInformation,
        ctypes.byref(info),
        ctypes.sizeof(info),
    )
    if not ok:
        k32.CloseHandle(job)
        return None
    return job


def assign_pid_to_job(pid: int, job: Any) -> bool:
    if not job or pid <= 0:
        return False
    api = _win_api()
    if api is None:
        return False
    k32 = api["k32"]
    PROCESS_SET_QUOTA = 0x0100
    PROCESS_TERMINATE = 0x0001
    access = PROCESS_SET_QUOTA | PROCESS_TERMINATE
    handle = k32.OpenProcess(access, False, pid)
    if not handle:
        return False
    try:
        return bool(k32.AssignProcessToJobObject(job, handle))
    finally:
        k32.CloseHandle(handle)


def close_job(job: Any) -> None:
    api = _win_api()
    if api is None or not job:
        return
    try:
        api["k32"].CloseHandle(job)
    except Exception:
        pass


def terminate_job(job: Any) -> None:
    api = _win_api()
    if api is None or not job:
        return
    try:
        api["k32"].TerminateJobObject(job, 1)
    except Exception:
        pass


def is_process_running(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def kill_process_tree(
    pid: int,
    *,
    job: Any = None,
    grace_s: float = 5.0,
) -> bool:
    """Graceful teardown → force kill. Uses job tree on Windows when available."""
    if not is_process_running(pid):
        return True
    if job:
        terminate_job(job)
        deadline = time.time() + grace_s
        while time.time() < deadline:
            if not is_process_running(pid):
                return True
            time.sleep(0.05)
    try:
        if os.name == "nt":
            import subprocess
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T"],
                capture_output=True,
                timeout=max(1.0, grace_s),
            )
            deadline = time.time() + grace_s
            while time.time() < deadline:
                if not is_process_running(pid):
                    return True
                time.sleep(0.05)
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                timeout=max(1.0, grace_s + 1),
            )
        else:
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGTERM)
            deadline = time.time() + grace_s
            while time.time() < deadline:
                if not is_process_running(pid):
                    return True
                time.sleep(0.05)
            if is_process_running(pid):
                os.killpg(pgid, signal.SIGKILL)
        return not is_process_running(pid)
    except Exception as exc:
        log.warning("[subprocess] kill tree pid=%s failed: %s", pid, exc)
        try:
            os.kill(pid, signal.SIGKILL if os.name != "nt" else signal.SIGTERM)
        except Exception:
            pass
        return not is_process_running(pid)
