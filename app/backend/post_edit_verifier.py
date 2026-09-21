"""post_edit_verifier.py — Post-Edit Verification Loop (PEVL).

The gap this closes: Ovolve already had pre-tool-use guards (risk classification,
command grading, path guard, sandbox) and goal-loop end verification (verify_gate).
What it lacked was the **immediate verification feedback after each file edit** —
the "edit → verify → report" cycle that 业界方案的 PostToolUse
hooks in mature coding agents provide.

Design principles:
  1. **Non-blocking**: verification runs async; the agent keeps working.
  2. **Permission-reuses-existing**: only runs commands already covered by an ALLOW
     rule (same discipline as verify_gate). No new attack surface.
  3. **Debounced**: rapid edits coalesce into one verification pass.
  4. **Layered**: lint → typecheck → test → build, cheapest first, stop on first failure.
  5. **Observable**: results emit on the event bus for the frontend to render.
  6. **Self-bounded**: wall-clock cap per command, output truncated head+tail.

Event flow:
  tool_result (write_file/edit_file success)
    → _on_tool_result (debounce + filter)
    → _run_verification (probe → check allow → sandbox execute)
    → event_bus.emit("post_edit_verification", result)
"""
from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from event_bus import EventBus, Event, get_event_bus
from verify_gate import VerifyCommand, probe as _probe_workspace, is_allowed, truncate_output


#: Verification does not block the agent's next turn. But it SHOULD finish
#: before the model has written and edited another ten files, or the result
#: lands on a stale workspace. 30s is enough for a lint + typecheck on a
#: normal project; a full test suite is the next turn's problem.
VERIFY_WALL_S = 30.0

#: Cooldown between verification triggers. A burst of write_file calls (agent
#: scaffolding a project) coalesces into one pass instead of N.
DEBOUNCE_S = 5.0

#: Max chars of verification output fed back to the model / frontend.
MAX_OUTPUT_CHARS = 2000

#: Tools that trigger verification on success.
TRIGGER_TOOLS = frozenset({"write_file", "edit_file", "apply_patch", "replace_file_content"})


@dataclass
class VerificationResult:
    """Outcome of one post-edit verification pass."""
    session_id: str
    workspace: str
    trigger_tool: str
    trigger_path: str
    success: bool
    command: str
    kind: str  # lint | typecheck | test | build
    exit_code: int
    output: str  # truncated head+tail
    duration_ms: int
    timestamp: float = field(default_factory=time.time)
    error: str = ""  # if verification itself failed to run

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "workspace": self.workspace,
            "trigger_tool": self.trigger_tool,
            "trigger_path": self.trigger_path,
            "success": self.success,
            "command": self.command,
            "kind": self.kind,
            "exit_code": self.exit_code,
            "output": self.output,
            "duration_ms": self.duration_ms,
            "timestamp": self.timestamp,
            "error": self.error,
        }


class PostEditVerifier:
    """Subscribes to tool_result and runs project verification after file edits.

    Reuses the existing verify_gate infrastructure (probe + permission check +
    output truncation) and the sandbox for safe command execution. The verifier
    itself adds only the trigger/debounce/report loop — no new execution engine.
    """

    def __init__(
        self,
        bus: Optional[EventBus] = None,
        verify_wall_s: float = VERIFY_WALL_S,
        debounce_s: float = DEBOUNCE_S,
        enabled: bool = True,
    ):
        self._bus = bus or get_event_bus()
        self._verify_wall_s = verify_wall_s
        self._debounce_s = debounce_s
        self._enabled = enabled
        self._pending: Optional[asyncio.Task] = None
        self._last_trigger: float = 0.0
        self._workspace: str = ""
        self._session_id: str = ""

    def mount(self, workspace: str, session_id: str) -> None:
        """Bind to a workspace + session and subscribe to the bus."""
        self._workspace = workspace
        self._session_id = session_id
        self._bus.on("tool_result", self._on_tool_result, priority=5)

    def unmount(self) -> None:
        """Unsubscribe from the bus."""
        self._bus.off("tool_result", self._on_tool_result)
        if self._pending and not self._pending.done():
            self._pending.cancel()

    async def _on_tool_result(self, event: Event) -> None:
        """EventBus subscriber: filter for successful file edits, debounce, verify."""
        if not self._enabled:
            return
        payload = event.payload or {}
        tool_name = payload.get("tool_name", "")
        if tool_name not in TRIGGER_TOOLS:
            return
        # Only verify on success.
        result = payload.get("result") or {}
        if isinstance(result, dict) and result.get("ok") is False:
            return
        # Debounce: cancel the pending verification and schedule a new one.
        now = time.time()
        if now - self._last_trigger < self._debounce_s:
            if self._pending and not self._pending.done():
                self._pending.cancel()
        self._last_trigger = now
        # Capture the path that triggered this verification.
        args = payload.get("args") or {}
        trigger_path = args.get("path") or args.get("file_path") or ""
        # Schedule verification after the debounce window.
        await asyncio.sleep(self._debounce_s)
        # If a newer trigger arrived while we were sleeping, bail.
        if time.time() - self._last_trigger < self._debounce_s - 0.1:
            return
        self._pending = asyncio.create_task(
            self._run_verification(tool_name, trigger_path)
        )

    async def _run_verification(self, trigger_tool: str, trigger_path: str) -> None:
        """Run the verification chain for the workspace."""
        if not self._workspace or not os.path.isdir(self._workspace):
            return
        commands = _probe_workspace(self._workspace)
        if not commands:
            return  # No verify commands detected — degrade silently.

        for cmd in commands:
            # Permission check: only run if an existing ALLOW rule covers it.
            allowed, reason = is_allowed(cmd.command, self._workspace)
            if not allowed:
                continue
            result = await self._execute_verify(cmd, trigger_tool, trigger_path)
            if result is not None:
                await self._bus.emit("post_edit_verification", result.to_dict())
            # Stop on first failure — no point running tests if typecheck fails.
            if result is not None and not result.success:
                return

    async def _execute_verify(
        self, cmd: VerifyCommand, trigger_tool: str, trigger_path: str
    ) -> Optional[VerificationResult]:
        """Run one verification command in the sandbox."""
        t0 = time.time()
        try:
            from sandbox import run_confined_capture
            loop = asyncio.get_running_loop()
            # run_confined_capture is sync (subprocess.run); run in executor to avoid blocking.
            result = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: run_confined_capture(
                        cmd.command,
                        cwd=self._workspace,
                        timeout=self._verify_wall_s,
                        mode="workspace-write",
                        strict=False,
                    ),
                ),
                timeout=self._verify_wall_s + 5.0,
            )
            output = truncate_output(result.get("output", ""), MAX_OUTPUT_CHARS)
            duration_ms = int((time.time() - t0) * 1000)
            return VerificationResult(
                session_id=self._session_id,
                workspace=self._workspace,
                trigger_tool=trigger_tool,
                trigger_path=trigger_path,
                success=result.get("returncode", -1) == 0,
                command=cmd.command,
                kind=cmd.kind,
                exit_code=result.get("returncode", -1),
                output=output,
                duration_ms=duration_ms,
                error=result.get("error", ""),
            )
        except asyncio.TimeoutError:
            duration_ms = int((time.time() - t0) * 1000)
            return VerificationResult(
                session_id=self._session_id,
                workspace=self._workspace,
                trigger_tool=trigger_tool,
                trigger_path=trigger_path,
                success=False,
                command=cmd.command,
                kind=cmd.kind,
                exit_code=-1,
                output="",
                duration_ms=duration_ms,
                error=f"验证超时（>{self._verify_wall_s}s）",
            )
        except Exception as exc:
            duration_ms = int((time.time() - t0) * 1000)
            return VerificationResult(
                session_id=self._session_id,
                workspace=self._workspace,
                trigger_tool=trigger_tool,
                trigger_path=trigger_path,
                success=False,
                command=cmd.command,
                kind=cmd.kind,
                exit_code=-1,
                output="",
                duration_ms=duration_ms,
                error=str(exc),
            )


# --------------------------------------------------------------------------- #
# Singleton accessor
# --------------------------------------------------------------------------- #

_instance: Optional[PostEditVerifier] = None


def get_post_edit_verifier(
    bus: Optional[EventBus] = None,
    workspace: str = "",
    session_id: str = "",
) -> PostEditVerifier:
    """Process-wide singleton. Mounts on first call with workspace + session."""
    global _instance
    if _instance is None:
        _instance = PostEditVerifier(bus=bus)
    if workspace and session_id:
        _instance.mount(workspace, session_id)
    return _instance
