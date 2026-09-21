"""
cron_manager.py - Cron scheduler and periodic automation manager.

Schedule recurring tasks with cron-like expressions.
Aligned with storage.py real API: save_cron_job / get_cron_jobs / update_cron_job.
"""
from __future__ import annotations
import uuid, time, json, asyncio
from typing import Any, Optional, Callable
from result import Result
from storage import get_storage
from telemetry import get_telemetry, SpanName


class CronStatus:
    ACTIVE = "active"
    PAUSED = "paused"
    STOPPED = "stopped"


class CronJob:
    def __init__(self, expression: str = "", task_name: str = "", task_data: dict = None,
                 *, prompt: str = None, delay_minutes: int = None, recurring: bool = True,
                 max_runs: int = None, bot_delivery_target: Any = None,
                 session_id: str = None):
        self.id = str(uuid.uuid4())
        self.expression = expression  # Cron expression: "*/5 * * * *"
        self.task_name = task_name
        self.task_data = task_data or {}
        # Automation fields: cron OR delay, recurring, maxRuns, delivery.
        self.prompt = prompt
        self.delay_minutes = delay_minutes
        self.recurring = recurring
        self.max_runs = max_runs
        self.bot_delivery_target = bot_delivery_target
        self.session_id = session_id
        self.status = CronStatus.ACTIVE
        self.created_at = time.time()
        self.last_run = 0.0
        self.next_run = 0.0
        self.run_count = 0

    def calculate_next_run(self) -> float:
        """Next run time from a cron expression OR a relative delay."""
        if not self.expression and self.delay_minutes is not None:
            return time.time() + self.delay_minutes * 60
        try:
            from croniter import croniter
            itr = croniter(self.expression, time.time())
            return itr.get_next(float)
        except ImportError:
            # Fallback: simplified calculation without croniter
            parts = self.expression.split()
            if len(parts) != 5:
                return time.time() + 3600  # Default: 1 hour
            # Check for */N step patterns in minute or hour
            for i, part in enumerate(parts[:2]):
                if "/" in part:
                    try:
                        step = int(part.split("/")[1])
                        if i == 0:  # minute field
                            return time.time() + step * 60
                        elif i == 1:  # hour field
                            return time.time() + step * 3600
                    except (ValueError, IndexError):
                        pass  # fail-open: 可选增强，失败不影响主流程
            # No step pattern, default to next hour
            return time.time() + 3600

    def should_run(self) -> bool:
        now = time.time()
        return self.status == CronStatus.ACTIVE and self.next_run and now >= self.next_run

    def mark_run(self):
        """Record a run, reschedule, and auto-pause when maxRuns is reached."""
        self.last_run = time.time()
        self.run_count += 1
        # maxRuns auto-pause.
        if self.max_runs and self.run_count >= self.max_runs:
            self.status = CronStatus.PAUSED
            self.next_run = 0.0
            return
        # One-shot (delay-only, non-recurring) jobs stop after firing once.
        if not self.recurring and not self.expression:
            self.status = CronStatus.STOPPED
            self.next_run = 0.0
            return
        self.next_run = self.calculate_next_run()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "expression": self.expression,
            "task_name": self.task_name,
            "task_data": self.task_data,
            "prompt": self.prompt,
            "delay_minutes": self.delay_minutes,
            "recurring": self.recurring,
            "max_runs": self.max_runs,
            "bot_delivery_target": self.bot_delivery_target,
            "status": self.status,
            "created_at": self.created_at,
            "last_run": self.last_run,
            "next_run": self.next_run,
            "run_count": self.run_count,
        }

    def to_storage_dict(self) -> dict:
        """Convert to storage.py field names (cron_jobs table schema)."""
        bdt = self.bot_delivery_target
        if bdt is not None and not isinstance(bdt, str):
            bdt = json.dumps(bdt, ensure_ascii=False)
        return {
            "id": self.id,
            "title": self.task_name,
            # prompt column carries the prompt string; when absent we fall
            # back to serialized task_data so nothing is lost.
            "prompt": self.prompt if self.prompt is not None else json.dumps(self.task_data, ensure_ascii=False),
            "cron_expr": self.expression,
            "delay_minutes": self.delay_minutes,
            "recurring": 1 if self.recurring else 0,
            "max_runs": self.max_runs,
            "next_run_at": int(self.next_run) if self.next_run else None,
            "last_run_at": int(self.last_run) if self.last_run else None,
            "run_count": self.run_count,
            "status": self.status,
            "bot_delivery_target": bdt,
            "session_id": self.session_id,
            "created_at": int(self.created_at),
        }

    @staticmethod
    def from_storage_row(row: dict) -> "CronJob":
        """Create CronJob from storage.py row (cron_jobs table)."""
        prompt_raw = row.get("prompt", "") or ""
        prompt = None
        task_data: dict = {}
        try:
            parsed = json.loads(prompt_raw) if prompt_raw else {}
            if isinstance(parsed, dict):
                task_data = parsed
            else:
                prompt = prompt_raw
        except (json.JSONDecodeError, TypeError):
            prompt = prompt_raw

        bdt = row.get("bot_delivery_target")
        if isinstance(bdt, str) and bdt.strip().startswith("{"):
            try:
                bdt = json.loads(bdt)
            except (json.JSONDecodeError, ValueError):
                pass  # fail-open: 可选增强，失败不影响主流程

        job = CronJob(
            expression=row.get("cron_expr", "") or "",
            task_name=row.get("title", ""),
            task_data=task_data,
            prompt=prompt,
            delay_minutes=row.get("delay_minutes"),
            recurring=bool(row.get("recurring", 1)),
            max_runs=row.get("max_runs"),
            bot_delivery_target=bdt,
            session_id=row.get("session_id"),
        )
        job.id = row.get("id", "")
        job.status = row.get("status", CronStatus.ACTIVE)
        job.created_at = row.get("created_at", 0) or 0
        job.last_run = row.get("last_run_at", 0) or 0
        job.next_run = row.get("next_run_at", 0) or 0
        job.run_count = row.get("run_count", 0) or 0
        return job


class CronManager:
    """Manage cron jobs with scheduling and execution."""

    def __init__(self):
        self.storage = get_storage()
        self.telemetry = get_telemetry()
        self._jobs: dict[str, CronJob] = {}
        self._running = False
        self._task_handlers: dict[str, Callable] = {}

    def register_handler(self, task_name: str, handler: Callable):
        """Register a task handler for a task type."""
        self._task_handlers[task_name] = handler

    def create_cron(self, expression: str, task_name: str, task_data: dict = None) -> CronJob:
        """Create a new cron job (legacy positional API)."""
        job = CronJob(expression, task_name, task_data)
        job.next_run = job.calculate_next_run()
        # Use storage.py real API: save_cron_job
        self.storage.save_cron_job(job.to_storage_dict())
        self._jobs[job.id] = job
        return job

    def create(self, title: str, prompt: str, cron_expr: str = None,
               delay_minutes: int = None, recurring: bool = True,
               max_runs: int = None, bot_delivery_target: Any = None,
               task_name: str = None, task_data: dict = None,
               session_id: str = None) -> Result:
        """Create a scheduled automation.

        Provide either ``cron_expr`` (5-field cron) or ``delay_minutes``
        (relative one-shot). ``max_runs`` auto-pauses after N fires;
        ``bot_delivery_target`` routes the result to an IM chat.

        Returns:
            Result carrying the job dict, or a failure when neither schedule
            is supplied.
        """
        if not cron_expr and delay_minutes is None:
            return Result.failure("Provide either cron_expr or delay_minutes")
        job = CronJob(
            expression=cron_expr or "",
            task_name=task_name or title,
            task_data=task_data or {},
            prompt=prompt,
            delay_minutes=delay_minutes,
            recurring=recurring,
            max_runs=max_runs,
            bot_delivery_target=bot_delivery_target,
            session_id=session_id,
        )
        job.next_run = job.calculate_next_run()
        self.storage.save_cron_job(job.to_storage_dict())
        self._jobs[job.id] = job
        return Result.success(job.to_dict())

    def get_cron(self, cron_id: str) -> Result:
        """Get a single cron job by ID."""
        all_jobs = self.storage.get_cron_jobs(active=False)
        for row in all_jobs:
            if row.get("id") == cron_id:
                job = CronJob.from_storage_row(row)
                return Result.success(job.to_dict())
        return Result.failure(f"Cron job not found: {cron_id}")

    def list_crons(self, status: str = None) -> list[dict]:
        """List all cron jobs, optionally filtered by status."""
        if status:
            all_rows = self.storage.get_cron_jobs(active=False)
            filtered = [r for r in all_rows if r.get("status") == status]
        else:
            all_rows = self.storage.get_cron_jobs(active=False)
        return [CronJob.from_storage_row(r).to_dict() for r in all_rows]

    def pause_cron(self, cron_id: str) -> Result:
        return self._update_status(cron_id, CronStatus.PAUSED)

    def resume_cron(self, cron_id: str) -> Result:
        r = self._update_status(cron_id, CronStatus.ACTIVE)
        if r.ok and cron_id in self._jobs:
            self._jobs[cron_id].next_run = self._jobs[cron_id].calculate_next_run()
            self.storage.update_cron_job(cron_id, next_run_at=int(self._jobs[cron_id].next_run))
        return r

    def stop_cron(self, cron_id: str) -> Result:
        return self._update_status(cron_id, CronStatus.STOPPED)

    def delete_cron(self, cron_id: str) -> Result:
        """Delete cron job from storage and active manager cache."""
        self.storage.delete_cron_job(cron_id)
        if cron_id in self._jobs:
            del self._jobs[cron_id]
        return Result.success(f"Cron job {cron_id} deleted")

    def _update_status(self, cron_id: str, status: str) -> Result:
        """Update cron job status."""
        self.storage.update_cron_job(cron_id, status=status)
        if cron_id in self._jobs:
            self._jobs[cron_id].status = status
        return Result.success(f"Status updated to {status}")

    async def start_scheduler(self):
        """Start the scheduler loop."""
        self._running = True
        await self._load_jobs()
        # §14 账本语义：上一进程死在任务执行中时，running_since 还挂着——
        # 开机如实标记"被打断"，而不是让账本沉默。
        try:
            now = int(time.time())
            c = self.storage._db("cron")
            rows = c.execute(
                "SELECT id FROM cron_jobs WHERE running_since > 0"
            ).fetchall()
            for r in rows:
                self.storage.update_cron_job(
                    r["id"], running_since=0,
                    last_error=f"interrupted by restart (was running since {now})",
                )
            if rows:
                print(f"[cron] marked {len(rows)} job(s) interrupted by restart")
        except Exception as e:
            print(f"[cron] lease sweep skipped: {e}")
        while self._running:
            for job in list(self._jobs.values()):
                if job.should_run():
                    await self._execute_job(job)
            await asyncio.sleep(10)

    def stop_scheduler(self):
        self._running = False

    async def _execute_job(self, job: CronJob):
        span = self.telemetry.start_span(SpanName.CRON_EXECUTE, cron_id=job.id, task_name=job.task_name)
        # 执行租约（§10 overlap lock）：防双调度器重入，也让崩溃可判。
        self.storage.update_cron_job(job.id, running_since=int(time.time()))
        _err = ""
        try:
            handler = self._task_handlers.get(job.task_name) or self._task_handlers.get("*")
            if handler:
                payload = {"prompt": job.prompt, "task_data": job.task_data,
                           "job_id": job.id, "bot_delivery_target": job.bot_delivery_target}
                result = await handler(payload)
                job.mark_run()
                # Persist run bookkeeping AND the (possibly auto-paused) status.
                self.storage.update_cron_job(
                    job.id,
                    last_run_at=int(job.last_run),
                    next_run_at=int(job.next_run) if job.next_run else 0,
                    run_count=job.run_count,
                    status=job.status,
                )
                if job.bot_delivery_target:
                    await self._deliver_to_bot(job, result)
            else:
                span.set_error(f"No handler for task: {job.task_name}")
                _err = f"no handler for task: {job.task_name}"
        except Exception as e:
            span.set_error(str(e))
            _err = str(e)[:400]
        finally:
            self.storage.update_cron_job(job.id, running_since=0, last_error=_err)
            self.telemetry.end_span(span)

    async def _deliver_to_bot(self, job: CronJob, result: Any) -> None:
        """Route a cron result to an IM chat (best-effort delivery)."""
        try:
            from bot_remote import get_bot_controller
            target = job.bot_delivery_target
            if isinstance(target, dict):
                platform = target.get("provider") or target.get("platform", "")
                user_id = target.get("providerUserId") or target.get("user_id", "")
            else:
                platform, _, user_id = str(target).partition(":")
            if platform and user_id:
                text = f"[Scheduled: {job.task_name}]\n{str(result)[:2000]}"
                await get_bot_controller().send_message(platform, user_id, text)
        except Exception as e:
            # Delivery is best-effort; a missing/unconfigured bot must not crash
            # the scheduler loop. But a silent loss looks like "job ran, nothing
            # happened" — leave one loud line for whoever debugs it.
            print(f"[cron] result delivery failed for job '{job.task_name}': {e}")

    async def _load_jobs(self):
        """Load active cron jobs from storage."""
        active_rows = self.storage.get_cron_jobs(active=True)
        for row in active_rows:
            job = CronJob.from_storage_row(row)
            self._jobs[job.id] = job


_manager: Optional[CronManager] = None
def get_cron_manager() -> CronManager:
    global _manager
    if _manager is None:
        _manager = CronManager()
    return _manager
