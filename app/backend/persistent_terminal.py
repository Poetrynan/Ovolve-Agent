"""persistent_terminal.py — 持久化交互式终端会话管理器。

职责：
1. 为每个会话维护一个常驻的持久化 Shell 进程（Windows 下为 PowerShell，POSIX 下为 Bash）；
2. 跨步骤、跨 Turn 保持工作目录（`cd`）、环境变量（`$env:KEY=VAL`）和虚拟环境激活状态；
3. 基于唯一 Marker 锚定与严格的退出码（Exit Code）捕获，彻底避免无状态子进程的“每步重新初始化”顽疾；
4. 提供超时安全守卫与异常自动重置。
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import time
import uuid
from typing import Dict, Optional, Tuple


class PersistentShellSession:
    """单个会话的持久化 Shell 交互实例。"""

    def __init__(self, session_id: str, workspace_root: str = "."):
        self.session_id = session_id
        self.workspace_root = os.path.realpath(workspace_root or ".")
        self.is_windows = sys.platform == "win32"
        self.proc: Optional[subprocess.Popen] = None
        self._lock = asyncio.Lock()
        self._start_shell()

    def _start_shell(self) -> None:
        """启动底层的持久 Shell 进程。"""
        if self.proc is not None:
            self._close_shell()

        if self.is_windows:
            cmd = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]
        else:
            cmd = ["/bin/bash", "--norc"]

        try:
            self.proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                cwd=self.workspace_root,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except Exception as e:
            self.proc = None

    def _close_shell(self) -> None:
        """关闭底层 Shell。"""
        if self.proc:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.terminate()
            except Exception:
                pass
            self.proc = None

    async def execute(self, command: str, timeout_seconds: float = 60.0) -> Tuple[int, str]:
        """在当前持久会话中执行命令，保持状态并捕获输出与退出码。"""
        async with self._lock:
            if not self.proc or self.proc.poll() is not None:
                self._start_shell()

            if not self.proc or not self.proc.stdin:
                return -1, "Error: Failed to spawn persistent shell"

            marker_id = uuid.uuid4().hex[:12]
            start_marker = f"__OVOLVE_START_{marker_id}__"
            end_marker_prefix = f"__OVOLVE_END_{marker_id}__"

            if self.is_windows:
                # PowerShell 脚本封装
                wrapped_script = (
                    f"Write-Output '{start_marker}'\n"
                    f"{command}\n"
                    f"$__mb_exit = if ($?) {{ 0 }} else {{ 1 }}\n"
                    f"Write-Output '{end_marker_prefix}':$__mb_exit\n"
                )
            else:
                # Bash 脚本封装
                wrapped_script = (
                    f"echo '{start_marker}'\n"
                    f"{command}\n"
                    f"__mb_exit=$?\n"
                    f"echo '{end_marker_prefix}':$__mb_exit\n"
                )

            loop = asyncio.get_running_loop()

            def _sync_run() -> Tuple[int, str]:
                try:
                    self.proc.stdin.write(wrapped_script)
                    self.proc.stdin.flush()

                    captured_lines: list[str] = []
                    started = False
                    exit_code = 0
                    start_time = time.time()

                    while True:
                        if time.time() - start_time > timeout_seconds:
                            self._start_shell()  # 超时重置
                            return -1, f"Command timed out after {timeout_seconds}s (shell reset)"

                        line = self.proc.stdout.readline()
                        if not line:
                            break

                        stripped = line.strip()
                        if not started:
                            if start_marker in stripped:
                                started = True
                            continue

                        if end_marker_prefix in stripped:
                            # 提取退出码: __OVOLVE_END_xxx__:0
                            match = re.search(rf"{re.escape(end_marker_prefix)}:(\d+)", stripped)
                            if match:
                                exit_code = int(match.group(1))
                            break

                        captured_lines.append(line)

                    return exit_code, "".join(captured_lines)
                except Exception as e:
                    self._start_shell()
                    return -1, f"Execution failed: {e}"

            return await loop.run_in_executor(None, _sync_run)


class PersistentTerminalManager:
    """持久化终端会话池。"""

    def __init__(self):
        self._sessions: Dict[str, PersistentShellSession] = {}

    def get_or_create(self, session_id: str, workspace_root: str = ".") -> PersistentShellSession:
        if session_id not in self._sessions:
            self._sessions[session_id] = PersistentShellSession(session_id, workspace_root)
        return self._sessions[session_id]

    def close(self, session_id: str) -> None:
        sess = self._sessions.pop(session_id, None)
        if sess:
            sess._close_shell()

    def close_all(self) -> None:
        for s in list(self._sessions.values()):
            s._close_shell()
        self._sessions.clear()


# 全局单例
_terminal_manager = PersistentTerminalManager()

def get_terminal_manager() -> PersistentTerminalManager:
    return _terminal_manager
