# -*- coding: utf-8 -*-
"""workflow_scheduler.py — Scheduled workflow execution engine with zero-dependency mini-cron.

Provides:
1. MiniCron: Pure-Python standard 5-field cron parser and fast forward next-run evaluator.
2. WorkflowScheduler: SQLite-persisted recurring workflow scheduler with drift protection,
   validation gates, and fail-open background loop.
"""
from __future__ import annotations

import asyncio
import datetime
import os
import re
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from result import Result
from workflow_recorder import Workflow, WorkflowReplayer, get_default_workflow_dir, load_workflow


# ── Zero-Dependency MiniCron Parser & Evaluator ──

_CRON_MACROS = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
}


def _parse_cron_field(raw: str, min_val: int, max_val: int, is_dow: bool = False) -> Set[int]:
    """Parses a single cron field into allowed integers."""
    raw = raw.strip()
    if not raw:
        raise ValueError("Empty cron field")

    values: Set[int] = set()
    parts = raw.split(",")
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if "/" in part:
            range_expr, step_str = part.split("/", 1)
            try:
                step = int(step_str)
            except ValueError:
                raise ValueError(f"Invalid step value in field: {part}")
            if step <= 0:
                raise ValueError(f"Step must be > 0: {part}")

            if range_expr == "*":
                start_val, end_val = min_val, max_val
            elif "-" in range_expr:
                s_str, e_str = range_expr.split("-", 1)
                start_val, end_val = int(s_str), int(e_str)
            else:
                start_val, end_val = int(range_expr), max_val

            if start_val < min_val or end_val > max_val or start_val > end_val:
                raise ValueError(f"Range [{start_val}, {end_val}] out of bounds [{min_val}, {max_val}]")

            for v in range(start_val, end_val + 1, step):
                values.add(0 if (is_dow and v == 7) else v)
        elif "-" in part:
            s_str, e_str = part.split("-", 1)
            start_val, end_val = int(s_str), int(e_str)
            if start_val < min_val or end_val > max_val or start_val > end_val:
                raise ValueError(f"Range [{start_val}, {end_val}] out of bounds [{min_val}, {max_val}]")
            for v in range(start_val, end_val + 1):
                values.add(0 if (is_dow and v == 7) else v)
        elif part == "*":
            for v in range(min_val, max_val + 1):
                values.add(0 if (is_dow and v == 7) else v)
        else:
            val = int(part)
            if is_dow and val == 7:
                val = 0
            if val < min_val or val > max_val:
                raise ValueError(f"Value {val} out of bounds [{min_val}, {max_val}]")
            values.add(val)

    if not values:
        raise ValueError(f"No valid values parsed from field: {raw}")
    return values


class MiniCron:
    """Pure-Python standard 5-field cron parser and evaluator."""

    def __init__(self, expr: str) -> None:
        self.expr = expr.strip()
        expanded = _CRON_MACROS.get(self.expr, self.expr)
        tokens = expanded.split()
        if len(tokens) != 5:
            raise ValueError(f"Cron expression must contain exactly 5 fields, got {len(tokens)}: '{expr}'")

        self.min_raw, self.hour_raw, self.dom_raw, self.mon_raw, self.dow_raw = tokens
        self.minutes = _parse_cron_field(self.min_raw, 0, 59)
        self.hours = _parse_cron_field(self.hour_raw, 0, 23)
        self.days = _parse_cron_field(self.dom_raw, 1, 31)
        self.months = _parse_cron_field(self.mon_raw, 1, 12)
        self.dows = _parse_cron_field(self.dow_raw, 0, 7, is_dow=True)

        self.dom_is_wildcard = self.dom_raw == "*"
        self.dow_is_wildcard = self.dow_raw == "*"

    def get_next_run(self, after: Optional[float | datetime.datetime] = None) -> float:
        """Calculates the next matching timestamp strictly greater than `after`."""
        if after is None:
            after = time.time()
        if isinstance(after, (int, float)):
            base = datetime.datetime.fromtimestamp(after).replace(microsecond=0)
        else:
            base = after.replace(microsecond=0)

        # Advance by 1 minute to start candidate evaluation
        curr = base.replace(second=0) + datetime.timedelta(minutes=1)

        # Look up to 5 years ahead
        max_steps = 5 * 366 * 24 * 60
        for _ in range(max_steps):
            if curr.month not in self.months:
                if curr.month == 12:
                    curr = datetime.datetime(curr.year + 1, 1, 1, 0, 0)
                else:
                    curr = datetime.datetime(curr.year, curr.month + 1, 1, 0, 0)
                continue

            cron_dow = (curr.weekday() + 1) % 7
            if self.dom_is_wildcard and self.dow_is_wildcard:
                day_match = True
            elif not self.dom_is_wildcard and self.dow_is_wildcard:
                day_match = curr.day in self.days
            elif self.dom_is_wildcard and not self.dow_is_wildcard:
                day_match = cron_dow in self.dows
            else:
                day_match = (curr.day in self.days) or (cron_dow in self.dows)

            if not day_match:
                curr = (curr + datetime.timedelta(days=1)).replace(hour=0, minute=0)
                continue

            if curr.hour not in self.hours:
                curr = (curr + datetime.timedelta(hours=1)).replace(minute=0)
                continue

            if curr.minute in self.minutes:
                return curr.timestamp()

            curr += datetime.timedelta(minutes=1)

        raise ValueError(f"No matching run time found within 5 years for cron: {self.expr}")


def validate_cron(cron_expr: str) -> Tuple[bool, str]:
    """Validates whether a string is a well-formed 5-field cron or recognized macro."""
    try:
        MiniCron(cron_expr)
        return True, ""
    except Exception as exc:
        return False, str(exc)


def get_next_run(cron_expr: str, after: Optional[float | datetime.datetime] = None) -> float:
    """Convenience evaluator returning next run timestamp."""
    return MiniCron(cron_expr).get_next_run(after)


# ── Workflow Eligibility Validation ──

def is_workflow_eligible_for_scheduling(wf: Workflow) -> Tuple[bool, str]:
    """Checks whether a workflow is sufficiently mature or promoted for recurring automation."""
    # 1. Skill Loader status
    try:
        from skill_loader import SkillStatus, get_skill_loader
        loader = get_skill_loader()
        for candidate_name in [wf.id, f"wf-{wf.id}", wf.name]:
            entry = loader.get_skill(candidate_name)
            if entry and (entry.status == SkillStatus.IMPORTED or getattr(entry.status, "value", None) == "imported"):
                return True, ""
    except Exception:
        pass

    # 2. Workflow metadata promotion status
    meta = wf.metadata or {}
    if meta.get("status") in ("imported", "promoted", "active"):
        return True, ""
    if meta.get("promoted") is True:
        return True, ""

    # 3. Workflow metrics candidate status
    try:
        from workflow_evolution import WorkflowMetricsTracker
        tracker = WorkflowMetricsTracker()
        metrics = tracker.get_metrics(wf.id)
        if metrics and metrics.is_promotion_candidate:
            return True, ""
    except Exception:
        pass

    return False, (
        f"Workflow `{wf.id}` is not eligible for scheduled execution: must be imported as a skill, "
        "marked as imported in metadata, or qualified as a promotion candidate."
    )


# ── WorkflowScheduler Service ──

@dataclass
class WorkflowSchedule:
    id: str
    workflow_id: str
    cron_expr: str
    session_id: str = ""
    enabled: int = 1
    last_run: Optional[float] = None
    next_run: float = 0.0
    created_at: float = field(default_factory=time.time)
    error_count: int = 0
    last_error: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class WorkflowScheduler:
    """Manages scheduled workflow tasks with SQLite persistence and an asyncio polling loop."""

    def __init__(
        self,
        db_path: Optional[str] = None,
        poll_interval_s: float = 15.0,
        workflow_dir: Optional[str | Path] = None,
    ) -> None:
        if db_path is None:
            try:
                from user_dirs import db_dir
                resolved_dir = db_dir()
            except Exception:
                resolved_dir = str(Path.home() / ".ovolve" / "db")
            os.makedirs(resolved_dir, exist_ok=True)
            self.db_path = str(Path(resolved_dir) / "workflow_schedules.db")
        else:
            self.db_path = db_path
            if db_path != ":memory:":
                os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)

        self.poll_interval_s = poll_interval_s
        self.workflow_dir = workflow_dir
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._init_db()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._get_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS workflow_schedules (
                    id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    cron_expr TEXT NOT NULL,
                    session_id TEXT DEFAULT '',
                    enabled INTEGER DEFAULT 1,
                    last_run REAL DEFAULT NULL,
                    next_run REAL NOT NULL,
                    created_at REAL NOT NULL,
                    error_count INTEGER DEFAULT 0,
                    last_error TEXT DEFAULT ''
                );
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_workflow_schedules_next_run ON workflow_schedules(enabled, next_run);"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_workflow_schedules_wf_id ON workflow_schedules(workflow_id);"
            )
            conn.commit()

    def create_schedule(
        self,
        workflow_id: str,
        cron_expr: str,
        session_id: str = "",
        require_promoted: bool = True,
    ) -> Result:
        """Creates and registers a recurring schedule for a workflow."""
        valid, err = validate_cron(cron_expr)
        if not valid:
            return Result.failure(f"Invalid cron expression '{cron_expr}': {err}")

        wf = load_workflow(workflow_id, dir_path=self.workflow_dir)
        if not wf:
            return Result.failure(f"Workflow `{workflow_id}` not found on disk")
        if not wf.steps:
            return Result.failure(f"Workflow `{workflow_id}` has no executable steps")

        if require_promoted:
            eligible, reason = is_workflow_eligible_for_scheduling(wf)
            if not eligible:
                return Result.failure(reason)

        next_run = get_next_run(cron_expr)
        sched_id = f"sched_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        now = time.time()

        schedule = WorkflowSchedule(
            id=sched_id,
            workflow_id=workflow_id,
            cron_expr=cron_expr,
            session_id=session_id,
            enabled=1,
            last_run=None,
            next_run=next_run,
            created_at=now,
            error_count=0,
            last_error="",
        )

        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO workflow_schedules (id, workflow_id, cron_expr, session_id, enabled, last_run, next_run, created_at, error_count, last_error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    schedule.id,
                    schedule.workflow_id,
                    schedule.cron_expr,
                    schedule.session_id,
                    schedule.enabled,
                    schedule.last_run,
                    schedule.next_run,
                    schedule.created_at,
                    schedule.error_count,
                    schedule.last_error,
                ),
            )
            conn.commit()

        return Result.success(schedule.to_dict())

    def list_schedules(self, enabled_only: bool = False) -> List[Dict[str, Any]]:
        """Lists all registered workflow schedules."""
        query = "SELECT * FROM workflow_schedules"
        params: List[Any] = []
        if enabled_only:
            query += " WHERE enabled = 1"
        query += " ORDER BY created_at DESC"

        with self._get_conn() as conn:
            cursor = conn.execute(query, params)
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def get_schedule(self, schedule_id: str) -> Optional[Dict[str, Any]]:
        """Retrieves a single schedule by ID."""
        with self._get_conn() as conn:
            cursor = conn.execute("SELECT * FROM workflow_schedules WHERE id = ?", (schedule_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def delete_schedule(self, schedule_id: str) -> Result:
        """Removes a schedule by ID."""
        with self._get_conn() as conn:
            cursor = conn.execute("DELETE FROM workflow_schedules WHERE id = ?", (schedule_id,))
            conn.commit()
            if cursor.rowcount > 0:
                return Result.success({"deleted": True, "schedule_id": schedule_id})
        return Result.failure(f"Schedule `{schedule_id}` not found")

    def set_enabled(self, schedule_id: str, enabled: bool) -> Result:
        """Enables or disables an existing schedule."""
        sched = self.get_schedule(schedule_id)
        if not sched:
            return Result.failure(f"Schedule `{schedule_id}` not found")

        int_enabled = 1 if enabled else 0
        update_next_run = sched["next_run"]
        if enabled and sched["next_run"] <= time.time():
            update_next_run = get_next_run(sched["cron_expr"])

        with self._get_conn() as conn:
            conn.execute(
                "UPDATE workflow_schedules SET enabled = ?, next_run = ? WHERE id = ?",
                (int_enabled, update_next_run, schedule_id),
            )
            conn.commit()

        return Result.success({"schedule_id": schedule_id, "enabled": bool(int_enabled)})

    def trigger_due(
        self,
        now: Optional[float] = None,
        replayer: Optional[WorkflowReplayer] = None,
    ) -> List[Dict[str, Any]]:
        """Finds all due schedules, executes their workflows, and advances next_run."""
        eval_time = now if now is not None else time.time()
        results: List[Dict[str, Any]] = []

        with self._get_conn() as conn:
            cursor = conn.execute(
                "SELECT * FROM workflow_schedules WHERE enabled = 1 AND next_run <= ?",
                (eval_time,),
            )
            due_rows = [dict(r) for r in cursor.fetchall()]

        for row in due_rows:
            sched_id = row["id"]
            wf_id = row["workflow_id"]
            cron_expr = row["cron_expr"]
            session_id = row.get("session_id") or ""
            error_count = row.get("error_count") or 0

            wf = load_workflow(wf_id, dir_path=self.workflow_dir)
            if not wf:
                err_msg = f"Workflow `{wf_id}` missing from disk during scheduled replay"
                new_next = get_next_run(cron_expr, after=eval_time)
                with self._get_conn() as conn:
                    conn.execute(
                        """
                        UPDATE workflow_schedules
                        SET last_run = ?, next_run = ?, error_count = ?, last_error = ?
                        WHERE id = ?
                        """,
                        (eval_time, new_next, error_count + 1, err_msg, sched_id),
                    )
                    conn.commit()
                results.append({"schedule_id": sched_id, "workflow_id": wf_id, "ok": False, "error": err_msg})
                continue

            active_replayer = replayer or WorkflowReplayer()
            replay_res = active_replayer.replay(wf, stop_on_drift=True, session_id=session_id)

            new_next = get_next_run(cron_expr, after=eval_time)
            is_ok = bool(replay_res.ok)
            err_text = "" if is_ok else str(replay_res.error)
            new_error_count = error_count if is_ok else error_count + 1

            with self._get_conn() as conn:
                conn.execute(
                    """
                    UPDATE workflow_schedules
                    SET last_run = ?, next_run = ?, error_count = ?, last_error = ?
                    WHERE id = ?
                    """,
                    (eval_time, new_next, new_error_count, err_text, sched_id),
                )
                conn.commit()

            results.append({
                "schedule_id": sched_id,
                "workflow_id": wf_id,
                "ok": is_ok,
                "error": err_text,
                "next_run": new_next,
            })

        return results

    def start(self) -> None:
        """Starts the background asyncio polling loop."""
        if self._running:
            return
        self._running = True
        try:
            loop = asyncio.get_running_loop()
            self._task = loop.create_task(self._run_loop())
        except RuntimeError:
            pass

    def stop(self) -> None:
        """Stops the background asyncio polling loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None

    async def _run_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.poll_interval_s)
                if not self._running:
                    break
                self.trigger_due()
            except asyncio.CancelledError:
                break
            except Exception:
                pass


# ── Global Singleton Access ──

_default_scheduler: Optional[WorkflowScheduler] = None


def get_workflow_scheduler(db_path: Optional[str] = None) -> WorkflowScheduler:
    global _default_scheduler
    if _default_scheduler is None:
        _default_scheduler = WorkflowScheduler(db_path=db_path)
    return _default_scheduler


def set_default_workflow_scheduler(scheduler: Optional[WorkflowScheduler]) -> None:
    global _default_scheduler
    _default_scheduler = scheduler
