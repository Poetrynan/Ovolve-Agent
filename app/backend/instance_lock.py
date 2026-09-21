"""instance_lock.py — 后端进程的单实例防线（advisory lock）。

## 为什么 Electron 锁之外还要这一层

Electron 的 ``requestSingleInstanceLock()`` 只保护"从 Electron 正常启动"的
路径。开发模式、命令行直启 Python、未来的多窗口改造、打包异常路径——任何
绕过 Electron 的启动都会得到两个后端进程写同一批 SQLite 库：WAL 互相踩、
goal 租约互相抢、端口静默漂移。这层锁不替代 Electron，它是最后一道诊断
防线：第二个进程**拿不到锁就明确说出来**，而不是带着一个健康检查永远解释
不了的并行世界继续跑。

跨平台语义：
* Windows/POSIX 都用 ``O_CREAT | O_EXCL`` 独占创建锁文件——原子性由文件
  系统保证，不需要 fcntl/msvcrt 的字节锁。
* 文件内容是 ``{pid, started_at, argv0}``。已存在的锁先验 PID 活性：持锁
  进程死了（崩溃没来得及释放），新进程接管并重写锁文件；活着则拒绝。
* 正常退出释放；崩溃由上面的 PID 检查兜底。PID 回收的误判窗口存在，但
  需要恰好回收 + 恰好同时启动，概率远低于它防住的事故。
"""
from __future__ import annotations

import json
import os
import sys
import time

LOCK_FILE_NAME = "backend.lock"

_state: dict = {"lock_path": "", "acquired": False}


def lock_path_for(db_dir: str) -> str:
    return os.path.join(db_dir or "", LOCK_FILE_NAME)


def _pid_alive(pid: int) -> bool:
    """PID 是否对应一个活着的进程。检查失败按活着处理（宁可不接管）。"""
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                return False
            try:
                code = ctypes.c_ulong()
                if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return code.value == STILL_ACTIVE
                return True  # 查询失败：当作还活着
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return True
    else:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True  # 存在但属于别人
        except OSError:
            return True


def _read_lock(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def acquire(db_dir: str, *, component: str = "backend") -> dict:
    """尝试获取实例锁。

    Returns:
        ``{"acquired": bool, "lockPath": str, "reason": str,
           "existing": {pid, startedAt} | None}``。
        绝不抛异常也绝不静默退出——调用方（HTTP 启动路径）负责把拒绝变成
        日志、health 字段和 UI 提示。
    """
    path = lock_path_for(db_dir)
    info = {"acquired": False, "lockPath": path, "reason": "",
            "existing": None}
    if not db_dir:
        info["reason"] = "no db_dir given"
        return info
    try:
        os.makedirs(db_dir, exist_ok=True)
        payload = json.dumps({
            "pid": os.getpid(),
            "component": component,
            "started_at": int(time.time()),
            "argv0": sys.argv[0] if sys.argv else "",
        })
        # 先快速路径：文件不存在时 O_EXCL 直接成功。
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
            _state.update({"lock_path": path, "acquired": True})
            info["acquired"] = True
            return info
        except FileExistsError:
            pass
        existing = _read_lock(path)
        pid = int(existing.get("pid") or 0)
        if pid == os.getpid():
            # 本进程已持有（或至少写过）这把锁。静默接管会让"第二个持有者"
            # 检查形同虚设——如实拒绝，并把 pid 写进原因：这个模块存在的意义
            # 就是让"谁占着"可被一眼看出，一句不带身份的拒绝等于没说。
            info["reason"] = f"lock already held by this process (pid={pid})"
            info["existing"] = {"pid": pid,
                                "startedAt": existing.get("started_at"),
                                "argv0": existing.get("argv0")}
            return info
        if pid and _pid_alive(pid):
            info["reason"] = (
                f"另一个 {component} 进程正在运行（pid={pid}，"
                f"自 {_read_lock(path).get('started_at', '?')} 起）")
            info["existing"] = {"pid": pid,
                                "startedAt": existing.get("started_at"),
                                "argv0": existing.get("argv0")}
            return info
        # 持锁者已死（或锁文件损坏）：接管。先删再建，中间仍有竞窗——两个
        # 新进程同时接管的概率极小，且 SQLite 层的租约仍能兜底。
        try:
            os.unlink(path)
        except OSError as exc:
            info["reason"] = f"stale lock file could not be removed: {exc}"
            return info
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        _state.update({"lock_path": path, "acquired": True})
        info["acquired"] = True
        info["reason"] = f"took over stale lock from dead pid={pid}"
        return info
    except Exception as exc:  # noqa: BLE001
        info["reason"] = f"instance lock error: {exc}"
        return info


def release() -> bool:
    """正常退出时释放自己的锁。别人的锁不动。"""
    path = _state.get("lock_path") or ""
    acquired = _state.get("acquired")
    if not path or not acquired:
        return False
    try:
        os.unlink(path)
        _state["acquired"] = False
        return True
    except OSError:
        return False


def status() -> dict:
    """当前进程与锁的关系，给 /api/health 用。"""
    path = _state.get("lock_path") or ""
    out = {"held": bool(_state.get("acquired")), "lockPath": path}
    if path and not _state.get("acquired"):
        holder = _read_lock(path)
        if holder.get("pid"):
            out["heldBy"] = {
                "pid": holder.get("pid"),
                "startedAt": holder.get("started_at"),
            }
    return out
