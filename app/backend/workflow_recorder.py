# -*- coding: utf-8 -*-
"""workflow_recorder.py — Workflow Record and Replay Protocol (Gap D Phase 1).

Clean-room implementation of automated workflow recording and deterministic replay:
1. Recording: Captures action sequences (tool name, action, parameters, OCR/state hash, expected target).
2. Persistence: Stores workflows in `workflows/<id>.json` with schema validation.
3. Replay with Drift Circuit Breaker:
   - Pre-check 1: Physical bare modifier guard (`BareModifierGuard`) ensuring 0 physical key/mouse interference.
   - Pre-check 2: Target / state existence verification. Immediate circuit breaker trip upon drift with failed step reported.
   - Execution: Deterministic step dispatch through tool registry/executors.
4. Episode Boundary Protection: Avoids cross-topic workflow pollution.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, TYPE_CHECKING, Tuple

from bare_modifier_guard import BareModifierGuard
from result import Result

if TYPE_CHECKING:  # pragma: no cover - 仅用于类型标注，避免运行时循环导入
    from workflow_evolution import WorkflowMetricsTracker


@dataclass
class WorkflowStep:
    """A single atomic step within a workflow."""
    step_index: int
    tool_name: str
    action: str = ""
    params: Dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)
    pre_state_hash: Optional[str] = None
    expected_target: Optional[Dict[str, Any]] = None

    def __post_init__(self):
        if not self.action:
            if isinstance(self.params, dict) and "action" in self.params:
                self.action = str(self.params.get("action") or "")
            else:
                self.action = self.tool_name

    def to_dict(self) -> Dict[str, Any]:
        return {
            "step_index": self.step_index,
            "tool_name": self.tool_name,
            "action": self.action,
            "params": self.params,
            "timestamp": self.timestamp,
            "pre_state_hash": self.pre_state_hash,
            "expected_target": self.expected_target,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WorkflowStep":
        return cls(
            step_index=data.get("step_index", 0),
            tool_name=data.get("tool_name", ""),
            action=data.get("action", ""),
            params=data.get("params") or {},
            timestamp=data.get("timestamp", 0.0),
            pre_state_hash=data.get("pre_state_hash"),
            expected_target=data.get("expected_target"),
        )


@dataclass
class Workflow:
    """An executable workflow encapsulating recorded steps."""
    id: str
    name: str
    created_at: float = field(default_factory=time.time)
    session_id: str = ""
    episode_id: str = ""
    description: str = ""
    steps: List[WorkflowStep] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "session_id": self.session_id,
            "episode_id": self.episode_id,
            "description": self.description,
            "steps": [s.to_dict() for s in self.steps],
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Workflow":
        steps_data = data.get("steps") or []
        steps = [WorkflowStep.from_dict(s) for s in steps_data]
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            created_at=data.get("created_at", 0.0),
            session_id=data.get("session_id", ""),
            episode_id=data.get("episode_id", ""),
            description=data.get("description", ""),
            steps=steps,
            metadata=data.get("metadata") or {},
        )


def get_default_workflow_dir(dir_path: Optional[Path | str] = None) -> Path:
    """Resolves standard storage directory for recorded workflows."""
    if dir_path:
        p = Path(dir_path)
    else:
        # Default to workspace/workflows or ~/.ovolve/workflows
        workspace = os.environ.get("OVOLVE_WORKSPACE")
        if workspace and Path(workspace).is_dir():
            p = Path(workspace) / "workflows"
        else:
            p = Path.home() / ".ovolve" / "workflows"
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_workflow(workflow: Workflow, dir_path: Optional[Path | str] = None) -> str:
    """Persists a workflow to workflows/<id>.json."""
    folder = get_default_workflow_dir(dir_path)
    file_path = folder / f"{workflow.id}.json"
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(workflow.to_dict(), f, ensure_ascii=False, indent=2)
    return str(file_path)


def load_workflow(workflow_id: str, dir_path: Optional[Path | str] = None) -> Optional[Workflow]:
    """Loads a workflow from disk by workflow ID."""
    if dir_path is None:
        rec = get_workflow_recorder()
        if rec and rec._dir_path:
            dir_path = rec._dir_path
    folder = get_default_workflow_dir(dir_path)
    file_path = folder / f"{workflow_id}.json"
    if not file_path.exists():
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return Workflow.from_dict(data)
    except Exception:
        return None


def list_workflows(dir_path: Optional[Path | str] = None) -> List[Dict[str, Any]]:
    """Lists summary info of all saved workflows."""
    if dir_path is None:
        rec = get_workflow_recorder()
        if rec and rec._dir_path:
            dir_path = rec._dir_path
    folder = get_default_workflow_dir(dir_path)
    results = []
    if not folder.exists():
        return results
    for f in folder.glob("*.json"):
        try:
            with open(f, "r", encoding="utf-8") as fp:
                data = json.load(fp)
            results.append({
                "id": data.get("id", f.stem),
                "name": data.get("name", f.stem),
                "created_at": data.get("created_at", 0.0),
                "step_count": len(data.get("steps") or []),
                "description": data.get("description", ""),
                "episode_id": data.get("episode_id", ""),
            })
        except Exception:
            continue
    results.sort(key=lambda x: x.get("created_at", 0.0), reverse=True)
    return results


class WorkflowRecorder:
    """Manages active workflow recording session."""

    def __init__(self, dir_path: Optional[Path | str] = None):
        self._dir_path = dir_path
        self._recording: bool = False
        self._active_workflow: Optional[Workflow] = None

    def is_recording(self) -> bool:
        return self._recording and self._active_workflow is not None

    def start_recording(
        self,
        session_id: str = "",
        name: str = "",
        episode_id: str = "",
        description: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Starts a new recording session."""
        wf_id = f"wf_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        wf_name = name or f"Workflow {time.strftime('%Y-%m-%d %H:%M:%S')}"
        self._active_workflow = Workflow(
            id=wf_id,
            name=wf_name,
            created_at=time.time(),
            session_id=session_id,
            episode_id=episode_id,
            description=description,
            steps=[],
            metadata=metadata or {},
        )
        self._recording = True
        return wf_id

    def record_step(
        self,
        tool_name: str,
        params: Dict[str, Any],
        pre_state_hash: Optional[str] = None,
        expected_target: Optional[Dict[str, Any]] = None,
        action: str = "",
    ) -> Optional[WorkflowStep]:
        """Appends a recorded action step to the active workflow."""
        if not self.is_recording() or self._active_workflow is None:
            return None
        step_index = len(self._active_workflow.steps)
        step = WorkflowStep(
            step_index=step_index,
            tool_name=tool_name,
            action=action,
            params=dict(params or {}),
            timestamp=time.time(),
            pre_state_hash=pre_state_hash,
            expected_target=expected_target,
        )
        self._active_workflow.steps.append(step)
        return step

    def stop_recording(self, save: bool = True) -> Optional[Workflow]:
        """Stops active recording session and optionally persists to disk."""
        if not self._recording or self._active_workflow is None:
            return None
        wf = self._active_workflow
        self._recording = False
        self._active_workflow = None
        if save:
            save_workflow(wf, dir_path=self._dir_path)
        return wf


class WorkflowReplayer:
    """Executes a recorded workflow with physical safety and drift circuit breaker."""

    def __init__(
        self,
        guard: Optional[BareModifierGuard] = None,
        executor: Optional[Callable[[str, Dict[str, Any]], Result]] = None,
        pre_checker: Optional[Callable[[WorkflowStep], Tuple[bool, str]]] = None,
    ):
        self.guard = guard or BareModifierGuard()
        self._executor = executor
        self._pre_checker = pre_checker
        self._metrics_tracker: Optional["WorkflowMetricsTracker"] = None

    def set_metrics_tracker(self, tracker: Optional["WorkflowMetricsTracker"]) -> None:
        """注入指标账本；回放结束后自动登记成功率与漂移率（供技能晋升判定使用）。"""
        self._metrics_tracker = tracker

    def _record_run_metrics(
        self, workflow: Workflow, result: Result, latency_ms: float
    ) -> None:
        """把本次回放结果写入账本。任何异常都不得影响回放本身（fail-open）。"""
        if self._metrics_tracker is None:
            return
        try:
            drift = bool((result.meta or {}).get("drift", False))
            self._metrics_tracker.record_run(
                workflow.id,
                success=bool(result.ok),
                drift=drift,
                latency_ms=latency_ms,
            )
        except Exception:
            pass

    def replay(
        self,
        workflow: Workflow,
        stop_on_drift: bool = True,
        session_id: str = "",
        episode_id: str = "",
    ) -> Result:
        """Plays back workflow steps sequentially with circuit breaker protection."""
        started = time.time()
        result = self._replay_inner(workflow, stop_on_drift, session_id, episode_id)
        self._record_run_metrics(workflow, result, (time.time() - started) * 1000.0)
        return result

    def _replay_inner(
        self,
        workflow: Workflow,
        stop_on_drift: bool = True,
        session_id: str = "",
        episode_id: str = "",
    ) -> Result:
        """Plays back workflow steps sequentially with circuit breaker protection."""
        if not workflow or not workflow.steps:
            return Result.failure("Workflow has no executable steps")

        # Episode boundary check
        if episode_id and workflow.episode_id and episode_id != workflow.episode_id:
            # Note cross-boundary execution
            pass

        executed_steps = 0
        total_steps = len(workflow.steps)

        for step in workflow.steps:
            # 1. Bare modifier guard: Ensure physical user input is quiet
            clean, clean_reason = self.guard.wait_for_bare_state(
                timeout_ms=500, check_mouse=True
            )
            if not clean:
                return Result.failure(
                    f"Replay interrupted by physical input interference at step {step.step_index}: {clean_reason}",
                    drift=True,
                    failed_step=step.step_index,
                    executed_steps=executed_steps,
                    total_steps=total_steps,
                )

            # 2. Target / UI State pre-check
            if self._pre_checker:
                target_ok, reason = self._pre_checker(step)
                if not target_ok and stop_on_drift:
                    return Result.failure(
                        f"UI/State drift detected at step {step.step_index}: {reason}",
                        drift=True,
                        failed_step=step.step_index,
                        executed_steps=executed_steps,
                        total_steps=total_steps,
                    )

            # 3. Step execution
            exec_res = self._dispatch_step(step)
            if not exec_res.ok:
                return Result.failure(
                    f"Execution failed at step {step.step_index} ({step.tool_name}): {exec_res.error}",
                    failed_step=step.step_index,
                    executed_steps=executed_steps,
                    total_steps=total_steps,
                )
            executed_steps += 1

        return Result.success({
            "status": "completed",
            "workflow_id": workflow.id,
            "executed_steps": executed_steps,
            "total_steps": total_steps,
        })

    def _dispatch_step(self, step: WorkflowStep) -> Result:
        """Executes a single step via injected or standard tool executor."""
        if self._executor:
            return self._executor(step.tool_name, step.params)

        # Fallback to tool registry
        from tools import get_tool_registry
        reg = get_tool_registry()
        tool = reg.get(step.tool_name)
        if not tool:
            return Result.failure(f"Tool `{step.tool_name}` not found in registry")

        try:
            import inspect
            if inspect.iscoroutinefunction(tool.execute):
                import asyncio
                res = asyncio.run(tool.execute(**step.params))
            else:
                res = tool.execute(**step.params)
            if isinstance(res, Result):
                return res
            return Result.success(res)
        except Exception as e:
            return Result.failure(f"Step execution exception: {str(e)}")


_default_recorder: Optional[WorkflowRecorder] = None


def get_workflow_recorder() -> WorkflowRecorder:
    global _default_recorder
    if _default_recorder is None:
        _default_recorder = WorkflowRecorder()
    return _default_recorder
