"""
goal_scheduler.py - Background scheduler for autonomous goal execution.

Design principles (from industry research, 2026-08-11):
  - Manual trigger only: goals enter the run queue when the user clicks
    "Execute", not automatically on creation.
  - Concurrency cap = 2: no more than two goals run simultaneously so cost
    stays predictable and the LLM is not overloaded.
  - Per-goal cost cap = $5 (5_000_000 micros): if a goal exceeds this the
    scheduler moves it to ``ovolve_failed_final``.
  - Circuit breaker: max_iterations (default 10), same-action repeat detection
    (3), cost ceiling — any trigger stops the goal.
  - Progress = completed_subtasks / total_subtasks (discrete, never a made-up
    percentage).
  - Verification: uses the existing GoalManager.verify_completion(). When it
    fails and budget remains, the scheduler auto-continues. Otherwise
    ``ovolve_failed_final``.
  - Events: every state change emits ``goal_state_change`` on the event bus so
    the frontend can update in real time. Stage switches (plan → execute →
    verify) ride the same channel as an extra ``stage`` field, so the pipeline
    UI can light the current phase without a second event vocabulary.

  阶段事件接线

Architecture:
  GoalScheduler runs a persistent asyncio loop (``_tick`` every 2 s). When a
  goal is submitted for execution via ``enqueue(goal_id)``, it is claimed from
  the DB (atomic row-lock via storage.claim_goal). If the claim succeeds, a
  worker task is spawned (capped at ``max_workers``). The worker drives the
  Router.run_goal()-style loop itself so it can interleave cost accounting and
  interrupt checks.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid
from typing import Any, Callable, Optional

from result import Result
from storage import get_storage, PROCESS_GENERATION
from goal_manager import get_goal_manager, GoalStatus, ACTIVE_STATES
from event_types import EventType
import goal_plan
import verify_gate

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_WORKERS = 2
DEFAULT_COST_CAP_MICROS = 5_000_000  # $5
DEFAULT_MAX_ITERATIONS = 10
TICK_INTERVAL = 2.0  # seconds between scheduler sweeps
#: Legacy staleness window, kept ONLY for owner-less claims (tests and any
#: caller that has not been migrated to leases). The scheduler's own claims
#: are heartbeat leases judged by ``lease_until`` instead — see the constants
#: right below.
STALE_CLAIM_SEC = 900

#: Heartbeat lease (Kubernetes-Lease semantics compressed into one SQLite row).
#: The worker renews its claim every :data:`HEARTBEAT_INTERVAL_SEC`; a claim is
#: stealable only when ``lease_until`` has passed, i.e. after roughly
#: CLAIM_LEASE_SEC of missed heartbeats — not after N seconds of total runtime,
#: which is how the old static window misread a healthy long-running goal as a
#: dead one while still taking minutes to notice an actually-dead worker.
HEARTBEAT_INTERVAL_SEC = 10.0
CLAIM_LEASE_SEC = 45

#: How long Pause waits for a worker to actually finish unwinding before it
#: stops claiming success. Kubernetes-style: request the stop, kill what is
#: running, then wait a bounded grace period and report what really happened.
#: 5s is generous for the unwind path (a checkpoint write + a release), and the
#: point of the bound is that the user gets a truthful answer either way — a
#: hung stop must surface as a hung stop, not as "已暂停".
PAUSE_GRACE_SEC = 5.0


#: How many identical consecutive actions before we call it a stuck loop.
#: This is the AutoGPT failure mode: the model keeps "improving" the same file
#: forever because its own verifier never says stop.
MAX_SAME_ACTION_REPEATS = 3

#: Oscillation window. A model that alternates A-B-A-B is just as stuck as one
#: repeating A-A-A, but never trips a "same action N times" check — it was the
#: gap that let a goal burn its whole iteration budget flipping between two
#: edits. Stuck when the last ``STUCK_WINDOW`` rounds contain at most
#: ``STUCK_DISTINCT_MAX`` distinct action signatures.
STUCK_WINDOW = 4
STUCK_DISTINCT_MAX = 2

#: Cap on how many tool calls of a round go into its signature. A long round is
#: identified well enough by its opening moves, and an unbounded key would make
#: every round unique — which silently disables the whole check.
MAX_SIGNATURE_CALLS = 6

#: Charged for a round whose usage the provider did not report (no LLM
#: configured, keyword fallback, a stream that died before the usage frame).
#: Not zero: a round that bills nothing makes the cost cap unreachable, which is
#: exactly the bug the real accounting is here to fix. Small enough that a
#: correctly-reported run is never distorted by it.
FALLBACK_ROUND_MICROS = 2_000

#: Extra rounds a goal may spend fixing a failed machine verification (UA4).
#: Separate from `max_iterations` on purpose: feeding a test failure back in is a
#: round like any other, so sharing the budget would mean a goal that fails
#: verification twice silently loses two rounds of actual work. Re-exported from
#: verify_gate so there is one number, not two that can drift.
VERIFY_REPAIR_BUDGET = verify_gate.REPAIR_BUDGET


#: Statuses meaning "the user asked for this to run". Re-exported from
#: GoalStatus so there is exactly one spelling of these strings — the scheduler
#: writing "running" while goal_manager's ACTIVE_STATES didn't recognize it is
#: precisely how the continuation loop broke the first time.
QUEUED = GoalStatus.QUEUED
RUNNING = GoalStatus.RUNNING


def _plan_progress(plan_json: str) -> dict:
    """Derive discrete progress from the stored plan.

    Returns ``{completed, total, ratio}``. ``ratio`` is None when there is no
    plan — the UI then shows a state label instead of a bar, rather than
    inventing a number. This is the whole point: progress is counted, never
    guessed.
    """
    try:
        plan = json.loads(plan_json or "[]")
    except (json.JSONDecodeError, TypeError):
        plan = []
    if not isinstance(plan, list) or not plan:
        return {"completed": 0, "total": 0, "ratio": None}
    total = len(plan)
    done = sum(1 for s in plan if isinstance(s, dict) and s.get("status") == "completed")
    return {"completed": done, "total": total, "ratio": done / total}


#: Volatile bits of a reply that differ every round without the work differing:
#: timestamps, elapsed times, hex ids, line/byte counts.
_VOLATILE_RE = re.compile(r"\b(?:0x)?[0-9a-f]{6,}\b|\d+", re.IGNORECASE)


def _text_signature(text: str) -> str:
    """Stable digest of a round's reply, ignoring numbers and hex ids.

    Without the stripping, "wrote 41 lines" and "wrote 42 lines" look like two
    different actions and the loop check never fires on a model that is spinning
    on the same file.
    """
    norm = _VOLATILE_RE.sub("#", (text or "").lower())
    norm = " ".join(norm.split())[:400]
    return "text:" + hashlib.md5(norm.encode("utf-8")).hexdigest()[:12]


def _call_signature(row: dict) -> str:
    """``toolname:arghash`` for one tool call."""
    tool = str(row.get("tool") or "?")
    args = row.get("args")
    try:
        key = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        key = str(args)
    return f"{tool}:{hashlib.md5(key[:400].encode('utf-8')).hexdigest()[:8]}"


def round_signature(trace: Any, evidence: str = "") -> str:
    """What this round actually DID, as a comparable key.

    Built from the tool calls (name + hashed arguments) rather than from the
    reply text, because the reply is the model narrating and it rephrases itself
    every round even when it is repeating byte-identical edits. Rounds with no
    tool calls — pure prose replies — fall back to a normalized text digest,
    which is the only evidence available for them.
    """
    calls = [_call_signature(r) for r in (trace or []) if isinstance(r, dict)]
    if calls:
        return "|".join(calls[:MAX_SIGNATURE_CALLS])
    return _text_signature(evidence)


def is_stuck(signatures: list) -> str:
    """Why this run looks stuck, or "" when it does not.

    Two triggers, both needed:
      * the same signature ``MAX_SAME_ACTION_REPEATS`` times running — the
        classic "keeps re-editing the same file" loop;
      * at most ``STUCK_DISTINCT_MAX`` distinct signatures across the last
        ``STUCK_WINDOW`` rounds — the A-B-A-B oscillation, which the first check
        alone cannot see.
    """
    if len(signatures) >= MAX_SAME_ACTION_REPEATS:
        tail = signatures[-MAX_SAME_ACTION_REPEATS:]
        if len(set(tail)) == 1:
            return f"同一个动作连续重复了 {MAX_SAME_ACTION_REPEATS} 轮"
    if len(signatures) >= STUCK_WINDOW:
        window = signatures[-STUCK_WINDOW:]
        if len(set(window)) <= STUCK_DISTINCT_MAX:
            return (f"最近 {STUCK_WINDOW} 轮只在 {len(set(window))} 个动作之间来回，"
                    "没有新进展")
    return ""


# ── U5 交付语义提示（goal_scheduler 侧）──────────────
#
# 动作层（cua_actions）在元素信息等感知动作里按屏幕证据给出 delivery_hint——
# "这步构成交付物 / 需要用户接管"。本段把它聚合进 goal 验收链路，铁律只有
# 一条：**提示只能佐证，物理门禁永远终裁**。提示摸不到判据本身，拼进门禁
# 证据通道时还要过"空证据不拼接"护栏（见 evidence_with_hints）。

#: 工具结果 payload 里交付提示的契约键（与 CuaActionResult.to_dict 对齐，一字不改）。
DELIVERY_HINT_KEY = "delivery_hint"
DELIVERABLE_HINT = "deliverable"
HANDOFF_HINT = "handoff"
_HINT_DETAIL_KEYS = ("reason", "error", "summary", "feedback_note", "note",
                     "ocr_summary")
_HINT_DETAIL_LIMIT = 200
#: tool_trace 行里 payload 可能挂载的内层键——契约只钉了 payload 内部键名，
#: 没钉挂载点，扫描面覆盖所有合理挂载位置。
_HINT_NESTED_KEYS = ("result", "value", "output", "details")
_HINT_MAX_DEPTH = 2


def empty_delivery_hints() -> dict:
    """零值形态。每次新建，绝不共享可变默认。"""
    return {"deliverable_count": 0, "handoff_count": 0, "latest_handoff_detail": ""}


def _hint_detail_of(payload: dict) -> str:
    """从 payload 里按优先序取第一个能说明原因的非空文本，规范化后限量。"""
    for key in _HINT_DETAIL_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:_HINT_DETAIL_LIMIT]
    return ""


def _iter_hint_payloads(obj, depth: int = 0, seen=None):
    """摊平轨迹里可能的 payload 挂载点。

    轨迹形态：trace → 每轮一个行列表 → 行 dict（result/value/output/details
    内层挂载）。列表层是结构不是语义——透明穿过不耗深度；payload dict 嵌套
    才计深度（封顶防自引用）。seen 集合挡循环引用。
    """
    if seen is None:
        seen = set()
    if depth > _HINT_MAX_DEPTH:
        return
    if isinstance(obj, list):
        if id(obj) in seen:
            return
        seen.add(id(obj))
        for item in obj:
            yield from _iter_hint_payloads(item, depth, seen)
        return
    if not isinstance(obj, dict) or id(obj) in seen:
        return
    seen.add(id(obj))
    yield obj
    for key in _HINT_NESTED_KEYS:
        child = obj.get(key)
        if isinstance(child, (dict, list)):
            yield from _iter_hint_payloads(child, depth + 1, seen)


def collect_delivery_hints(trace: Any) -> dict:
    """扫描一轮 tool_trace（或整条轨迹），聚合动作层的交付语义提示。

    只有 payload dict 里键恰为 ``delivery_hint``、值恰为 deliverable|handoff
    才计数；空串/缺键/大小写不符/非法值/非 dict 一律当无提示。提示是佐证
    不是事实——收集器对任何脏输入都不抛异常。
    """
    hints = empty_delivery_hints()
    rows = trace if isinstance(trace, list) else [trace]
    for row in rows:
        for payload in _iter_hint_payloads(row):
            raw = payload.get(DELIVERY_HINT_KEY)
            if raw not in (DELIVERABLE_HINT, HANDOFF_HINT):
                continue
            if raw == DELIVERABLE_HINT:
                hints["deliverable_count"] += 1
            else:
                hints["handoff_count"] += 1
                detail = _hint_detail_of(payload)
                if detail:
                    hints["latest_handoff_detail"] = detail
    return hints


def merge_delivery_hints(base: dict, addend: dict) -> dict:
    """跨轮累计；latest_handoff_detail 取最新一条非空（新轮覆盖旧轮）。"""
    merged = dict(base if isinstance(base, dict) else empty_delivery_hints())
    add = addend if isinstance(addend, dict) else empty_delivery_hints()
    merged["deliverable_count"] = (int(merged.get("deliverable_count") or 0)
                                   + int(add.get("deliverable_count") or 0))
    merged["handoff_count"] = (int(merged.get("handoff_count") or 0)
                               + int(add.get("handoff_count") or 0))
    if str(add.get("latest_handoff_detail") or "").strip():
        merged["latest_handoff_detail"] = str(add["latest_handoff_detail"])
    return merged


def delivery_evidence_note(hints: dict) -> str:
    """佐证包渲染：拼进物理门禁的证据通道用，免责声明写死在文案里。"""
    h = hints if isinstance(hints, dict) else empty_delivery_hints()
    deliverable = int(h.get("deliverable_count") or 0)
    handoff = int(h.get("handoff_count") or 0)
    if not deliverable and not handoff:
        return ""
    detail = str(h.get("latest_handoff_detail") or "").strip()
    note = (f"[delivery-hints] 动作层语义提示（仅佐证，不构成验收依据）："
            f"deliverable×{deliverable}, handoff×{handoff}")
    if detail:
        note += f"；latest_handoff: {detail}"
    return note


def evidence_with_hints(evidence: str, hints: dict) -> str:
    """把佐证包拼进门禁证据——**空证据不拼接**（U5 铁律）。

    verify_completion 的 heuristic 判据是"有证据才算过"；若允许纯提示把空
    证据填成非空，提示就翻转了判据——恰好构成语义旁路。因此原始证据为空
    （全空白）时原样返回，一个字不加。
    """
    text = str(evidence or "")
    note = delivery_evidence_note(hints)
    if not note or not text.strip():
        return text
    return text + "\n" + note


def goal_view(row: dict) -> dict:
    """Shape a raw goals row into what the API/UI consumes.

    Keeps the money in dollars for display but leaves the authoritative integer
    micros in place, so the frontend never does currency arithmetic.
    """
    progress = _plan_progress(row.get("plan_json") or "[]")
    cost_micros = row.get("cost_micros") or 0
    cap_micros = row.get("cost_cap_micros") or DEFAULT_COST_CAP_MICROS
    verification = row.get("verification_result") or ""
    try:
        verification_obj = json.loads(verification) if verification else None
    except (json.JSONDecodeError, TypeError):
        verification_obj = None
    # Structured brief (D1). Old rows carry '{}' / NULL — surface None rather
    # than an empty object so the UI can tell "no contract" from "empty contract".
    brief_raw = row.get("brief_json") or ""
    try:
        brief_obj = json.loads(brief_raw) if brief_raw and brief_raw != "{}" else None
    except (json.JSONDecodeError, TypeError):
        brief_obj = None
    return {
        "id": row.get("id"),
        "description": row.get("description", ""),
        "status": row.get("status", GoalStatus.STARTED),
        "iteration": row.get("iteration") or 0,
        "maxIterations": row.get("max_iterations") or DEFAULT_MAX_ITERATIONS,
        "subtasksCompleted": progress["completed"],
        "subtasksTotal": progress["total"],
        "progressRatio": progress["ratio"],
        "plan": json.loads(row.get("plan_json") or "[]") if row.get("plan_json") else [],
        "costUsd": round(cost_micros / 1_000_000, 4),
        "costCapUsd": round(cap_micros / 1_000_000, 2),
        "tokensUsed": row.get("tokens_used") or 0,
        "lastError": row.get("last_error") or "",
        "verification": verification_obj,
        "brief": brief_obj,
        "category": row.get("category") or "unknown",
        "sessionId": row.get("session_id") or "",
        "createdAt": row.get("created_at") or 0,
        "updatedAt": row.get("updated_at") or 0,
        "startedAt": row.get("started_at") or 0,
    }


# ---------------------------------------------------------------------------
# GoalScheduler
# ---------------------------------------------------------------------------

class GoalScheduler:
    """Background scheduler that drives autonomous goal execution.

    Lifecycle:
      1. User clicks "Execute" → frontend POSTs to ``/api/goals/{id}/run``
      2. Handler calls ``scheduler.enqueue(goal_id)``
      3. Scheduler claims the goal (atomic DB lock) and spawns a worker
      4. Worker runs the plan-execute-verify loop, emitting WS events
      5. Goal lands in ``completed`` or ``ovolve_failed_final``

    The scheduler itself is NOT a background sweeper that auto-starts things.
    It only processes goals explicitly submitted via :meth:`enqueue`. This
    matches the user's choice: manual trigger, not automatic.
    """

    def __init__(self, router=None, bus=None, host=None, storage=None) -> None:
        #: Fallback router. Used when no `host` is supplied (CLI, tests) or when
        #: a goal row carries no session_id.
        self._router = router
        #: Optional SessionHost. When present, each goal executes in the Router
        #: of the session it was created in — so a goal born in project A does
        #: its file work in A even while the user is looking at project B.
        self._host = host
        self._bus = bus
        self._storage = storage if storage is not None else get_storage()
        self._goal_manager = get_goal_manager()
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._workers: dict[str, asyncio.Task] = {}  # goal_id → task
        #: Claim owner token per running goal. Every release/renew carries it,
        #: so a stale handle can no longer wipe the NEW holder's claim (the
        #: old unconditional ``claimed_at=0`` release was that race).
        self._owners: dict[str, str] = {}
        #: Heartbeat tasks keeping each claim's lease alive.
        self._heartbeats: dict[str, asyncio.Task] = {}
        self._running = False
        self._tick_task: Optional[asyncio.Task] = None

    def _router_for_goal(self, row: dict):
        """Resolve the Router a goal must execute in.

        Falls back to the scheduler's default router when there is no host or
        the goal predates session tagging — running somewhere is better than
        refusing to run, and the fallback matches the old behaviour exactly.
        """
        if self._host is None:
            return self._router
        sid = (row or {}).get("session_id")
        if not sid:
            return self._router
        try:
            return self._host.get_or_create(sid)
        except Exception as exc:  # noqa: BLE001
            print(f"[goal_scheduler] session resolve failed for {sid}: {exc}")
            return self._router


    @property
    def active_count(self) -> int:
        """How many goals are currently being executed."""
        return sum(1 for t in self._workers.values() if not t.done())

    def start(self, auto_resume: Optional[bool] = None) -> None:
        """Start the background tick loop and rehydrate interrupted goals."""
        self._running = True
        if self._tick_task is None or self._tick_task.done():
            self._tick_task = asyncio.create_task(self._tick_loop())
        self.rehydrate_interrupted_goals(auto_resume=auto_resume)

    def rehydrate_interrupted_goals(self, auto_resume: Optional[bool] = None) -> list[str]:
        """Scan and rehydrate interrupted/paused goals from prior crashes.

        If auto_resume is True (or enabled by OVOLVE_AUTO_RESUME_GOALS env var),
        automatically enqueues them for background execution.
        """
        import os
        should_resume = auto_resume if auto_resume is not None else (
            os.environ.get("OVOLVE_AUTO_RESUME_GOALS", "").lower() in ("1", "true", "yes")
        )
        recovered_ids: list[str] = []
        try:
            from recovery import recover_interrupted_goals
            demoted = recover_interrupted_goals(self._storage)
            for g in demoted:
                gid = str(g.get("id") or "")
                if gid:
                    recovered_ids.append(gid)
                    if should_resume and g.get("can_auto_resume"):
                        print(f"[goal_scheduler] auto-resuming interrupted goal {gid}")
                        self.enqueue(gid)
        except Exception as e:
            print(f"[goal_scheduler] rehydrate interrupted goals error: {e}")
        return recovered_ids

    async def stop(self) -> None:
        """Gracefully stop all workers and the tick loop.

        Shutdown used to fire-and-forget: cancel every task, clear the registry,
        return. The loop then closed under workers that were still unwinding, so
        the pause checkpoint each one writes on the way out could be lost — the
        exact information a restart needs. Now every worker gets the same
        treatment Pause gives it (kill in-flight commands, then a bounded wait).
        """
        self._running = False
        tasks = list(self._workers.items())
        for gid, _task in tasks:
            self._hard_cancel_router(gid)
        for _gid, task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait({t for _g, t in tasks}, timeout=PAUSE_GRACE_SEC)
        for gid, task in tasks:
            if not task.done():
                print(f"[goal_scheduler] worker for {gid} did not stop within "
                      f"{PAUSE_GRACE_SEC:g}s at shutdown")
            self._finish_worker(gid)
        self._workers.clear()
        if self._tick_task:
            self._tick_task.cancel()
            self._tick_task = None

    def enqueue(self, goal_id: str) -> Result:
        """Submit a goal for execution.

        Returns failure if the goal doesn't exist, is already running, is mid-
        stop or awaiting stop confirmation, or the concurrency cap is hit.
        The ``stopping``/``stop_timeout`` refusals matter as much as RUNNING:
        starting a second worker while a stop is unconfirmed is exactly the
        double-execution that state machine exists to prevent.
        """
        row = self._storage.get_goal(goal_id)
        if row is None:
            return Result.failure(f"Goal not found: {goal_id}")
        status = row.get("status")
        if status in (RUNNING, QUEUED):
            return Result.failure(f"Goal is already {status}")
        if status == GoalStatus.STOPPING:
            return Result.failure("目标正在停止中（stopping），等停止确认后再继续")
        if status == GoalStatus.STOP_TIMEOUT:
            return Result.failure(
                "上次停止未能确认（stop_timeout）：可能有工具仍在后台运行。"
                "请先确认停止（confirm-stopped）再继续")
        if self.active_count >= MAX_WORKERS:
            # Queue it — the tick loop will pick it up when a slot frees.
            self._storage.update_goal_fields(goal_id, status=QUEUED)
            self._queue.put_nowait(goal_id)
            self._emit_change(goal_id, QUEUED)
            return Result.success({"status": QUEUED, "position": self._queue.qsize()})
        # Start immediately.
        self._spawn_worker(goal_id)
        return Result.success({"status": RUNNING})

    async def confirm_stopped(self, goal_id: str) -> Result:
        """Resolve a ``stop_timeout`` once reality has been checked.

        The only sanctioned way out of ``stop_timeout`` back into claimable
        space. Succeeds only when the worker task is verifiably gone — at that
        point every asyncio-owned resource is dead and any surviving side
        effect is already sitting in the ledger as unknown. Refusing while a
        live handle remains is the whole point: confirming a stop that did not
        happen is how a goal ends up with two workers.
        """
        task = self._workers.get(goal_id)
        if task is not None and not task.done():
            return Result.failure(
                "worker 还在运行，不能确认已停止；可以再点一次暂停")
        row = self._storage.get_goal(goal_id) or {}
        if row.get("status") != GoalStatus.STOP_TIMEOUT:
            return Result.failure(
                f"目标不在等待停止确认的状态（当前 {row.get('status')}）")
        # Worker gone → drop any claim residue and rest at paused.
        self._workers.pop(goal_id, None)
        self._finish_worker(goal_id)
        self._storage.update_goal_fields(goal_id, status=GoalStatus.PAUSED)
        try:
            self._note_failure(goal_id, "goal.stop_confirmed", {
                "from_status": GoalStatus.STOP_TIMEOUT,
                "confirmed_at": int(time.time()),
            })
        except Exception:
            pass  # 记账失败不影响确认本身
        self._emit_change(goal_id, GoalStatus.PAUSED)
        return Result.success({"status": GoalStatus.PAUSED})

    async def pause(self, goal_id: str) -> Result:
        """Stop a running goal now; report the truth about whether it stopped.

        State machine: ``running → stopping → paused``; a stop that cannot be
        confirmed inside the grace window lands in ``stop_timeout``, NOT in
        ``paused``.

        1. **Kill what is running.** ``task.cancel()`` unwinds the coroutine;
           tool threads' child commands survive it. ``_hard_cancel_router``
           kills them and sets the router's cancel token so no further step
           starts.
        2. **Confirm, don't assume.** Only when the worker task has actually
           finished unwinding does the goal rest at ``paused``.
        3. **Stay honest on timeout.** The database status, the ledger note and
           the HTTP answer all say stop_timeout now. Writing paused here was
           how the UI ended up showing 已暂停 over work that was still running;
           resume stays blocked until :meth:`confirm_stopped` establishes that
           nothing really is.
        """
        task = self._workers.get(goal_id)
        if task is None or task.done():
            return Result.failure("Goal is not running")

        # Status first: it is also read by the worker's own re-check, so even a
        # worker that outlives the grace window will not start another round.
        self._storage.update_goal_fields(goal_id, status=GoalStatus.STOPPING)
        self._emit_change(goal_id, GoalStatus.STOPPING)
        hard = self._hard_cancel_router(goal_id)
        task.cancel()
        await asyncio.wait({task}, timeout=PAUSE_GRACE_SEC)

        if not task.done():
            self._storage.update_goal_fields(
                goal_id, status=GoalStatus.STOP_TIMEOUT)
            self._note_failure(goal_id, "goal.pause_timeout", {
                "grace_sec": PAUSE_GRACE_SEC,
                "killed_calls": hard["killed"],
                "live_calls": hard["live"][:8],
                "to_status": GoalStatus.STOP_TIMEOUT,
            })
            self._emit_change(goal_id, GoalStatus.STOP_TIMEOUT)
            return Result.failure(
                f"已请求停止并终止了 {hard['killed']} 个在跑的命令，但 worker 在 "
                f"{PAUSE_GRACE_SEC:g} 秒内还没停下"
                + (f"（仍在等：{', '.join(hard['live'][:3])}）" if hard["live"] else "")
                + f"。目标已标记为 {GoalStatus.STOP_TIMEOUT}：不会再开新一轮，"
                  "恢复前需先确认停止（confirm-stopped）。可以再点一次暂停。"
            )

        self._workers.pop(goal_id, None)
        self._finish_worker(goal_id)
        self._storage.update_goal_fields(goal_id, status=GoalStatus.PAUSED)
        self._emit_change(goal_id, GoalStatus.PAUSED)
        return Result.success({"status": GoalStatus.PAUSED,
                               "killedCalls": hard["killed"]})

    # ------------------------------------------------------------------
    # Claim lease / ownership plumbing
    # ------------------------------------------------------------------

    def _heartbeat_loop_factory(self, goal_id: str, owner: str):
        """Build the coroutine keeping our claim's lease alive while we run.

        Renewal failing means we no longer own the goal — our process missed
        every beat (frozen/suspended long enough for the lease to lapse) and
        someone else took over. The only safe response is to cancel OUR
        worker: continuing would put two workers on one goal, which every
        other guard here treats as the worst outcome.
        """
        async def _loop() -> None:
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL_SEC)
                ok = self._storage.renew_goal_claim(
                    goal_id, owner, CLAIM_LEASE_SEC)
                if not ok:
                    print(f"[goal_scheduler] claim lost for {goal_id} "
                          "(lease expired or taken over) — cancelling worker")
                    try:
                        self._note_failure(goal_id, "goal.claim_lost", {
                            "owner": owner,
                            "lease_sec": CLAIM_LEASE_SEC,
                        })
                    except Exception:
                        pass  # 记账失败不改变「必须停」这个结论
                    t = self._workers.get(goal_id)
                    if t is not None and not t.done():
                        t.cancel()
                    return

        return _loop()

    def _finish_worker(self, goal_id: str) -> None:
        """Stop the heartbeat, release the claim under our own identity.

        Single exit path for every way a worker ends (completed, failed,
        cancelled, paused, shutdown). The release is owner-conditioned, so a
        rejected release — somebody ELSE legitimately holds the goal now —
        surfaces as a ledger note instead of silently clobbering them (the
        old unconditional ``claimed_at=0`` was exactly that clobber).
        """
        hb = self._heartbeats.pop(goal_id, None)
        if hb is not None and not hb.done():
            hb.cancel()
        owner = self._owners.pop(goal_id, "")
        released = bool(self._storage.release_goal(goal_id, owner))
        if owner and not released:
            self._note_failure(goal_id, "goal.claim_release_rejected", {
                "owner": owner,
                "detail": "claim held by someone else; left untouched",
            })

    def _hard_cancel_router(self, goal_id: str) -> dict:
        """Make the stop immediate: cancel token + kill in-flight commands.

        Cancelling the worker task alone is not a stop. Tools are dispatched into
        worker threads, so unwinding the coroutine leaves the child command
        running — the build keeps building, the script keeps writing. Only
        ``executors.cancel_call`` (via ``Router.cancel_hard``) actually ends it.
        """
        info = {"killed": 0, "live": []}
        try:
            row = self._storage.get_goal(goal_id) or {}
            router = self._router_for_goal(row)
            info["live"] = list(getattr(router, "live_call_names", lambda: [])())
            hard = getattr(router, "cancel_hard", None)
            if callable(hard):
                info["killed"] = int(hard() or 0)
            else:  # a stub router in tests
                cancel = getattr(router, "cancel", None)
                if callable(cancel):
                    cancel()
        except Exception as exc:  # noqa: BLE001
            print(f"[goal_scheduler] hard cancel failed for {goal_id}: {exc}")
        return info

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _tick_loop(self) -> None:
        """Periodic loop: drain the queue into free worker slots."""
        while self._running:
            await asyncio.sleep(TICK_INTERVAL)
            # Reap finished tasks. A worker that ended WITHOUT going through
            # _finish_worker (an exception racing the cleanup, a task killed
            # from outside) would otherwise leave its heartbeat renewing a
            # claim forever — the safety net stops it and drops the claim.
            done_ids = [gid for gid, t in self._workers.items() if t.done()]
            for gid in done_ids:
                self._workers.pop(gid, None)
                hb = self._heartbeats.get(gid)
                if hb is not None and not hb.done():
                    self._finish_worker(gid)
                else:
                    self._heartbeats.pop(gid, None)
                    self._owners.pop(gid, None)
            # Fill free slots from queue.
            while self.active_count < MAX_WORKERS and not self._queue.empty():
                gid = self._queue.get_nowait()
                row = self._storage.get_goal(gid)
                if row and row.get("status") == QUEUED:
                    self._spawn_worker(gid)

    def _spawn_worker(self, goal_id: str) -> None:
        """Claim the goal and start an execution task."""
        # One live task per goal, enforced here rather than trusted upstream.
        #
        # `self._workers[goal_id] = task` below OVERWRITES the entry, and the
        # registry is the only handle pause()/stop() have (they look the task up
        # by goal_id). So a second spawn did not just double the work — it made
        # the first task unstoppable: Pause would return success while that task
        # kept running, kept spending budget and kept writing files, with no way
        # for the user to reach it short of quitting the app.
        #
        # Reachable today: PATCH /api/goals/{id} {"status":"active"} lands in the
        # blind-write branch (http_server.py:2455) without cancelling anything,
        # `active` still passes the worker's own status re-check
        # (see the `while` loop below), and enqueue() only refuses RUNNING/QUEUED.
        old = self._workers.get(goal_id)
        if old is not None and not old.done():
            return
        if self._heartbeats.get(goal_id) is not None \
                and not self._heartbeats[goal_id].done():
            # A live heartbeat means a claim is still being renewed — either a
            # previous worker never fully wound down or the registry lost the
            # handle. Either way, do not double-claim on top of it.
            return
        # Owned lease: identity + deadline instead of a static 15-minute window.
        # The heartbeat task keeps pushing ``lease_until`` forward; expiry of
        # THAT column is what makes an abandoned goal reclaimable.
        owner = f"{PROCESS_GENERATION}:{uuid.uuid4().hex[:8]}"
        if not self._storage.claim_goal(
                goal_id, STALE_CLAIM_SEC,
                owner=owner, lease_seconds=CLAIM_LEASE_SEC):
            return  # Another process got it, or its lease is still live — skip.
        self._owners[goal_id] = owner
        self._storage.update_goal_fields(
            goal_id, status=RUNNING, started_at=int(time.time())
        )
        self._emit_change(goal_id, RUNNING)
        task = asyncio.create_task(self._run_worker(goal_id))
        self._workers[goal_id] = task
        self._heartbeats[goal_id] = asyncio.create_task(
            self._heartbeat_loop_factory(goal_id, owner))

    def _ensure_plan(self, goal_id: str) -> list:
        """Make sure the goal has a sub-task list before its first round.

        Derived from the brief's deliverables (see
        :func:`goal_plan.seed_plan_from_brief`). Never overwrites an existing
        plan, so a goal resumed after a restart keeps the states it recorded.
        """
        try:
            brief = self._goal_manager.get_brief(goal_id)
            return goal_plan.seed_plan_from_brief(goal_id, brief)
        except Exception as exc:  # noqa: BLE001
            print(f"[goal_scheduler] plan seed failed for {goal_id}: {exc}")
            return []

    @staticmethod
    def _opening_prompt(description: str, plan: list) -> str:
        """First-round prompt: the goal, plus whatever is still unfinished.

        On a fresh goal this is the description followed by the full plan. On a
        resumed one the finished items are already marked, so the model is told
        what is left instead of being handed the original description to redo
        from scratch — which is what happened before the plan had a write side.
        """
        block = goal_plan.render_unfinished(plan)
        if not block:
            return description
        return f"{description}\n\n{block}"

    def _charge_round(self, goal_id: str, turn: Result) -> dict:
        """Bill one round's real spend to the goal's ledger.

        The figure comes from ``Result.meta['usage']``, which the router prices
        once at record time from the rate table. The old code charged a flat
        3000 micros per round regardless of model or size, so a $0.50 cap could
        never be reached in 15 rounds — the ceiling existed but never fired.

        Returns:
            ``{cost_micros, tokens, source, cost_micros_total, over_cap}``.
        """
        usage = (getattr(turn, "meta", None) or {}).get("usage") or {}
        try:
            micros = int(usage.get("cost_micros") or 0)
            tokens = int(usage.get("tokens") or 0)
        except (TypeError, ValueError):
            micros, tokens = 0, 0
        source = str(usage.get("cost_source") or "")
        if micros <= 0:
            micros, source = FALLBACK_ROUND_MICROS, "fallback"
        spend = self._storage.add_goal_spend(goal_id, micros, tokens=tokens)
        cap = spend.get("cost_cap_micros") or DEFAULT_COST_CAP_MICROS
        return {
            "cost_micros": micros,
            "tokens": tokens,
            "source": source,
            "cost_micros_total": spend.get("cost_micros", 0),
            "cost_cap_micros": cap,
            "over_cap": spend.get("cost_micros", 0) >= cap,
        }

    def _note_failure(self, goal_id: str, kind: str, detail: dict) -> None:
        """Put a bookkeeping failure in the ledger, not just on stdout.

        These are the failures that make later evidence untrustworthy (an anchor
        that did not advance, a round row that never landed). A print goes to a
        console nobody keeps; the ledger is where the goal's own trace is read
        from, so that is where the gap has to be visible.

        Reuses ``system.error_logged`` rather than minting an event type: the
        gateway rejects unknown types (trace_gateway.py:132), and ``kind`` in the
        payload carries the distinction without a vocabulary change.
        """
        try:
            self._storage.trace_event(
                session_id=self._session_of_goal(goal_id) or goal_id,
                event_type=EventType.SYSTEM_ERROR_LOGGED,
                payload={"kind": kind, "goal_id": goal_id, **detail},
                importance="critical",
                goal_id=goal_id,
            )
        except Exception as exc:  # noqa: BLE001
            # Losing the note must not take the round down with it.
            print(f"[goal_scheduler] could not record {kind} for {goal_id}: {exc}")

    def _record_round(self, goal_id: str, ordinal: int, started_at: int,
                      evidence: str, verdict: str, reason: str,
                      cost_micros: int, tokens: int) -> None:
        """Write this round's detail row. Never raises.

        The goals row only carries an iteration counter, which cannot answer
        "what did round 4 do" or "why was it rejected" — least of all after a
        restart, when the in-memory list is gone.
        """
        try:
            self._storage.add_goal_iteration(
                goal_id, ordinal, started_at=started_at, ended_at=int(time.time()),
                evidence=str(evidence), verdict=verdict, verdict_reason=reason,
                cost_micros=cost_micros, tokens=tokens,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[goal_scheduler] iteration row failed for {goal_id}#{ordinal}: {exc}")
            # A round whose evidence never landed is a hole in the trace. Say so
            # in the ledger, otherwise the round list just skips a number.
            self._note_failure(goal_id, "goal.round_record_failed",
                               {"ordinal": ordinal, "error": str(exc)})

    async def _machine_verify(self, workspace: str) -> dict:
        """Run the project's own checks. Never raises, never blocks the loop.

        A crash in here must degrade to "no machine verification", not to a
        failed goal: the checks are a stricter gate on completion, and a gate
        that breaks shut is worse than no gate.
        """
        try:
            return await verify_gate.verify(workspace)
        except Exception as exc:  # noqa: BLE001
            print(f"[goal_scheduler] verify gate failed: {exc}")
            return {"ran": False, "passed": False, "skipped": True,
                    "skipReason": f"验证没能执行：{exc}", "results": [], "summary": ""}

    async def _run_worker(self, goal_id: str) -> None:
        """The core execution loop for one goal.

        Mirrors Router.run_goal() but adds:
          - real per-round cost accounting against the cap
          - circuit breaker (cost cap, stuck-action detection, max iterations)
          - a machine verification gate on the model's own "done" (UA4)
          - a per-round detail row and a written plan
          - real-time WS events
        """
        storage = self._storage
        manager = self._goal_manager
        row = storage.get_goal(goal_id)
        if row is None:
            return

        description = row.get("description", "")
        max_iter = row.get("max_iterations") or DEFAULT_MAX_ITERATIONS
        cost_cap = row.get("cost_cap_micros") or DEFAULT_COST_CAP_MICROS
        # Resolve the goal's owning session once — the same Router runs every
        # iteration so workspace/session_id stay consistent across the loop.
        router = self._router_for_goal(row)

        # Mandatory checkpoint preflight (Continue-As-New keeps its meaning:
        # we never replay old messages into a model call — but a resumed run
        # must first prove its foundation is intact and learn what the ledger
        # says already landed / is unknown). A failed preflight refuses to
        # enter running rather than resuming on guesswork.
        pre_ok, pre_why, ledger_block = await self._preflight_checkpoint(
            goal_id, row)
        if not pre_ok:
            await self._fail(goal_id, pre_why)
            return

        # Pipeline stage 1/3: planning. Emits before the plan is (re)seeded so
        # the UI can light the 规划 chip for the brief moment this takes.
        self._emit_stage(goal_id, "plan",
                         iteration=int(row.get("iteration") or 0),
                         max_iterations=max_iter)
        plan = self._ensure_plan(goal_id)
        prompt = self._opening_prompt(description, plan)
        if ledger_block:
            prompt = f"{prompt}\n\n{ledger_block}"
        signatures: list[str] = []
        sig_window = max(STUCK_WINDOW, MAX_SAME_ACTION_REPEATS)
        # U5：跨轮累计的动作层交付语义提示（只佐证，不裁决）。
        hints_total = empty_delivery_hints()
        handoff_signaled = 0
        # UA4: rounds spent fixing a failed machine verification are counted
        # separately, so they can't eat the budget meant for the actual work.
        repairs_used = 0
        workspace = str(getattr(router, "workspace", "") or "")

        try:
            # 轮次是**累计**的，不是每次启动重新数。以前这里是 iteration = 0：
            # 断电重启后续跑的第一轮又拿 ordinal=1 去写 goal_iterations，而那张表
            # 对 (goal_id, ordinal) 是 UPDATE 幂等——断电前第 1 轮的证据就被无声
            # 覆盖掉了。同时轮次预算也跟着满血复活：goals.iteration 一直涨，
            # 每次续跑却又能再跑满 max_iter 轮，上限形同虚设（成本上限没这问题，
            # 它本来就按累计额判断）。
            rounds_done = int(row.get("iteration") or 0)
            iteration = rounds_done
            limit = max_iter
            # 本轮 worker 调用 = 一个 run：技能经验与 USES 关系边都按它归因。
            # 重启续跑会铸新 run_id——恢复后的工作和断电前的工作不会混账。
            run_id = uuid.uuid4().hex[:12]
            # 合同预算覆盖（Phase 3）：合同声明优先于全局常量；0 表示沿用默认。
            repair_budget = VERIFY_REPAIR_BUDGET
            try:
                from acceptance_contract import get_goal_contract
                _c0 = get_goal_contract(storage, goal_id)
                if _c0:
                    _b = _c0.get("budget") or {}
                    if int(_b.get("max_repair_attempts") or 0) > 0:
                        repair_budget = int(_b["max_repair_attempts"])
                    if int(_b.get("max_iterations") or 0) > 0:
                        limit = min(limit, int(_b["max_iterations"]))
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            if iteration >= limit:
                # 预算在上一次运行里就花完了。静默退出会让目标停在 running 却
                # 什么都不做；如实说清"已经跑了几轮"，用户才知道该调 max_iterations
                # 还是放弃。
                await self._fail(
                    goal_id,
                    f"轮次预算已用尽：累计已跑 {rounds_done} 轮，上限 {limit} 轮。"
                    f"要继续请提高 max_iterations。"
                )
                return
            stopped_externally = False
            while iteration < limit:
                iteration += 1
                # --- Check if paused or cancelled externally ---
                fresh = storage.get_goal(goal_id)
                if not fresh or fresh.get("status") not in (RUNNING, GoalStatus.ACTIVE, GoalStatus.STARTED):
                    stopped_externally = True
                    break

                # --- Execute one turn ---
                started_at = int(time.time())
                # Pipeline stage 2/3: executing this round's turn.
                self._emit_stage(goal_id, "execute", iteration, max_iter)
                # The context dict is shared with the router, which fills in
                # ``tool_trace`` as it runs. That is how this loop learns WHICH
                # actions a round took; ``goal_id`` going the other way is what
                # lets the model's plan_write calls land on this goal's row.
                turn_ctx: dict = {"goal_id": goal_id, "run_id": run_id}
                turn = await router.handle(prompt, turn_ctx)
                evidence = turn.value if turn.ok else f"[failed] {turn.error}"
                # The anchor (`goals.iteration`) and the round row are advanced by
                # two different calls. If this one fails while _record_round below
                # succeeds, the next resume reads the stale anchor
                # (`rounds_done` above), re-issues the SAME ordinal, and
                # add_goal_iteration's UPDATE branch overwrites that round's
                # evidence. Discarding this Result made that divergence silent —
                # the only single-process path to lost evidence.
                _it = manager.add_iteration(goal_id, str(evidence))
                if not getattr(_it, "ok", True):
                    self._note_failure(goal_id, "goal.anchor_desync", {
                        "ordinal": iteration,
                        "error": str(getattr(_it, "error", "") or ""),
                    })

                # --- Cost accounting (real tokens, priced at record time) ---
                charge = self._charge_round(goal_id, turn)
                if charge["over_cap"]:
                    self._record_round(goal_id, iteration, started_at, str(evidence),
                                       "cost_cap", "cost cap reached",
                                       charge["cost_micros"], charge["tokens"])
                    await self._fail(
                        goal_id,
                        f"Cost cap exceeded: ${charge['cost_micros_total'] / 1_000_000:.4f}"
                        f" >= ${cost_cap / 1_000_000:.2f}"
                    )
                    return

                # --- Stuck-loop circuit breaker ---
                signatures.append(round_signature(turn_ctx.get("tool_trace"), str(evidence)))
                if len(signatures) > sig_window:
                    signatures.pop(0)
                stuck = is_stuck(signatures)
                if stuck:
                    self._record_round(goal_id, iteration, started_at, str(evidence),
                                       "stuck", stuck,
                                       charge["cost_micros"], charge["tokens"])
                    await self._fail(goal_id, f"Stuck loop detected: {stuck}")
                    return

                # --- U5：收集本轮交付语义提示并跨轮累计 --------------------
                # 提示来自 tool_trace 里动作结果 payload 的 delivery_hint 键；
                # handoff 计数上升才发接管信号（按轮去重，detail 取最新）。
                round_hints = collect_delivery_hints(turn_ctx.get("tool_trace"))
                hints_total = merge_delivery_hints(hints_total, round_hints)
                if int(hints_total.get("handoff_count") or 0) > handoff_signaled:
                    handoff_signaled = int(hints_total["handoff_count"])
                    self._emit_change(
                        goal_id, RUNNING,
                        handoff_required=True,
                        handoff_detail=str(hints_total.get("latest_handoff_detail") or ""),
                        delivery_hints=dict(hints_total),
                    )

                # --- Emit progress + pipeline stage 3/3: verifying ---
                # The round's work is done and the verifier is next, so this
                # long-standing progress event IS the execute→verify boundary;
                # it now also names the stage for the pipeline UI — and carries
                # the delivery-hints 佐证聚合，让前端 verify 气泡有数可显。
                self._emit_stage(goal_id, "verify", iteration, max_iter,
                                 extra={"delivery_hints": dict(hints_total)})

                # --- Verify completion ---
                # U5：语义提示只能随既有证据通道佐证（evidence_with_hints 的
                # 空证据护栏保证提示翻不转 heuristic 判据）；物理门禁在下面
                # 独立裁决，判据一行未动。
                verdict = await manager.verify_completion(
                    goal_id, evidence=evidence_with_hints(str(evidence), hints_total))
                passed = bool(verdict.get("passed"))

                # UA4: the model's "done" is a claim, not a result. Before we
                # accept it, run the project's own checks. Only gate on a pass —
                # a rejection is already going to another round, and running the
                # test suite to confirm unfinished work is unfinished costs a
                # full suite for no information.
                gate: dict = {}
                if passed:
                    gate = await self._machine_verify(workspace)
                    if gate.get("ran") and not gate.get("passed"):
                        passed = False

                self._record_round(
                    goal_id, iteration, started_at, str(evidence),
                    "passed" if passed else ("verify_failed" if gate.get("ran") else "rejected"),
                    (gate.get("summary") or "") if gate.get("ran") and not passed
                    else str(verdict.get("reason") or ""),
                    charge["cost_micros"], charge["tokens"],
                )

                # Phase 2 checkpoint：每轮结束落一份自包含快照，断电后可答
                # "做到哪一步、哪些副作用不能重做"。
                try:
                    from checkpoint import build_checkpoint
                    build_checkpoint(
                        storage,
                        session_id=self._session_of_goal(goal_id),
                        goal_id=goal_id, run_id=run_id,
                        turn_state="running",
                        current_phase=f"iter:{iteration}",
                        scope=f"{goal_id}:{iteration}",
                    )
                except Exception as exc:
                    print(f"[goals] round checkpoint failed: {exc}")

                # Fold the verifier's judgement into the plan. On a pass every
                # item is done by definition; on a rejection only the items it
                # explicitly named are flipped, so progress can never run ahead
                # of what was actually verified.
                plan, flipped = goal_plan.apply_completion(
                    goal_plan.load_plan(goal_id), verdict.get("completed"), all_done=passed,
                )
                if flipped:
                    goal_plan.save_plan(goal_id, plan)

                if passed:
                    # Phase 3 合同门：机器验证通过 ≠ 可以宣布完成。合同里的
                    # 必交付物与验证计划还要全绿；人工确认要求如实记 skipped
                    # 并单独上抛，绝不伪装成自动证据。
                    try:
                        from acceptance_contract import (
                            check_completion,
                            get_goal_contract,
                        )
                        _contract = get_goal_contract(storage, goal_id)
                        if _contract:
                            _ok_c, _unmet, _vres = check_completion(
                                _contract, workspace or ".")
                            _sid = self._session_of_goal(goal_id) or goal_id
                            for _r in _vres:
                                storage.trace_event(
                                    session_id=_sid,
                                    event_type={
                                        "passed": "validator.passed",
                                        "skipped": "validator.skipped",
                                    }.get(_r["status"], "validator.failed"),
                                    payload={"validator_id": _r["validator_id"],
                                             "status": _r["status"],
                                             "evidence": _r["evidence"][:4]},
                                    importance=("observational"
                                                if _r["status"] in ("passed", "skipped")
                                                else "critical"),
                                    goal_id=goal_id,
                                )
                            if not _ok_c:
                                storage.update_goal_fields(
                                    goal_id,
                                    verification_result=json.dumps({
                                        "reason": ("acceptance contract unmet: "
                                                   + "; ".join(_unmet))[:400],
                                        "contract_version": _contract.get("version"),
                                    }),
                                )
                                passed = False
                    except Exception as exc:
                        print(f"[goals] contract gate error: {exc}")

                if passed:
                    # Phase 2 checkpoint：完成时刻的自包含快照入账
                    try:
                        from checkpoint import build_checkpoint
                        build_checkpoint(
                            storage,
                            session_id=self._session_of_goal(goal_id),
                            goal_id=goal_id, run_id=run_id,
                            turn_state="completed", scope=f"{goal_id}:done",
                        )
                    except Exception as exc:
                        print(f"[goals] completion checkpoint failed: {exc}")
                    storage.update_goal_fields(goal_id, status=GoalStatus.COMPLETED)
                    self._finish_worker(goal_id)
                    self._emit_change(goal_id, GoalStatus.COMPLETED, iteration=iteration,
                                      delivery_hints=dict(hints_total))
                    await self._bus.emit("goal_state_change", {
                        "goal_id": goal_id, "status": "completed", "iteration": iteration,
                        "session_id": row.get("session_id") or "",
                        "verified": bool(gate.get("ran")),
                        "verifySummary": str(gate.get("summary") or gate.get("skipReason") or ""),
                        "delivery_hints": dict(hints_total),
                    })
                    return

                # --- Machine verification rejected an otherwise-finished goal ---
                if gate.get("ran") and not gate.get("passed"):
                    repairs_used += 1
                    if repairs_used > repair_budget:
                        await self._fail(
                            goal_id,
                            f"验证命令连续 {repair_budget} 次没通过，已停下："
                            f"{gate.get('summary') or ''}"
                        )
                        return
                    # Repair rounds get their own allowance rather than eating
                    # the budget the actual work was given. 逐次 +1 而不是重算
                    # max_iter + repairs_used：后者会把合同压低过的 limit 又顶回
                    # 全局默认，也会在续跑（iteration 累计）时把上限算错。
                    limit += 1
                    prompt = verify_gate.repair_prompt(gate)
                    continue

                # --- Continue ---
                cont = await manager.continue_goal(goal_id, max_iterations=max_iter)
                if not cont.ok:
                    await self._fail(goal_id, cont.error)
                    return
                prompt = cont.value["system_reminder"]

            if stopped_externally:
                # A stop/cancel landed out-of-band: the row now reads stopping,
                # stop_timeout, paused or queued. Reporting "did not converge"
                # here would be a lie — the goal didn't run out of budget, it
                # was told to stop (and the stop may still be unconfirmed).
                # Leave a checkpoint, drop our claim, and let pause()/
                # confirm_stopped own the final state name.
                try:
                    from checkpoint import build_checkpoint
                    build_checkpoint(
                        storage,
                        session_id=self._session_of_goal(goal_id),
                        goal_id=goal_id, run_id=run_id,
                        turn_state="paused",
                        current_phase=f"iter:{iteration}",
                        scope=f"{goal_id}:stopped",
                    )
                except Exception as exc:
                    print(f"[goals] external-stop checkpoint failed: {exc}")
                self._finish_worker(goal_id)
                fresh = storage.get_goal(goal_id) or {}
                self._emit_change(
                    goal_id, fresh.get("status") or GoalStatus.PAUSED,
                    iteration=iteration)
                return

            # Exhausted iterations.
            await self._fail(
                goal_id,
                f"Did not converge within {limit} iterations "
                f"(cumulative; {rounds_done} were already spent before this run)"
                if rounds_done else f"Did not converge within {limit} iterations"
            )

        except asyncio.CancelledError:
            # Pause or shutdown — don't mark as failed.
            #
            # 但一定要留一份快照。暂停是**常规**操作（用户点一下就发生），
            # 而它恰好是最容易留下"派发了、结果未知"的副作用的时刻；以前这条
            # 路径一行都不写，续跑现场就得靠猜。
            try:
                from checkpoint import build_checkpoint
                build_checkpoint(
                    storage,
                    session_id=self._session_of_goal(goal_id),
                    goal_id=goal_id, run_id=run_id,
                    turn_state="paused",
                    current_phase=f"iter:{iteration}",
                    scope=f"{goal_id}:paused",
                )
            except Exception as exc:
                print(f"[goals] pause checkpoint failed: {exc}")
            self._finish_worker(goal_id)
            # Re-raise so the task really is cancelled. Swallowing it made the
            # task finish "normally": `task.cancelled()` was False, and Pause had
            # no way to tell a worker that stopped from one that ignored it —
            # which is what let it report success without confirmation.
            raise

        except Exception as exc:
            await self._fail(goal_id, f"Unhandled exception: {exc}")

    def _session_of_goal(self, goal_id: str) -> str:
        """The session a goal belongs to, for event routing.

        Goal events are broadcast on the process-wide bus, so without this tag
        the WS bridge cannot tell which window owns the goal and every window
        would light up for a goal running in someone else's workspace.
        """
        try:
            row = self._storage.get_goal(goal_id) or {}
        except Exception:  # noqa: BLE001
            return ""
        return row.get("session_id") or ""

    async def _preflight_checkpoint(self, goal_id: str, row: dict):
        """Load + verify the latest checkpoint before a run may start.

        Returns ``(ok, why, ledger_block)``. ``ok=False`` blocks the run: the
        checkpoint says the stream was truncated, a branch moved, or retained
        messages vanished — resuming anyway would be guessing, and guessing is
        how completed work gets done twice.

        On success the side-effect verdicts from the checkpoint are returned
        as a prompt block (dont_redo / verify_before_redo), and a
        ``goal.resumed_from_checkpoint`` event names exactly which checkpoint
        this new run was rebuilt from. Fresh goals with no checkpoint at all
        pass through with no block — there is nothing to verify yet.
        """
        sid = row.get("session_id") or ""
        try:
            from checkpoint import load_latest_checkpoint
            cp = load_latest_checkpoint(self._storage, goal_id=goal_id,
                                        session_id=sid)
        except Exception as exc:  # noqa: BLE001
            print(f"[goals] checkpoint load failed for {goal_id}: {exc}")
            cp = None
        if cp is None:
            return True, "", ""
        try:
            from checkpoint import resume_from_checkpoint
            res = resume_from_checkpoint(self._storage, cp)
        except Exception as exc:  # noqa: BLE001
            return False, f"checkpoint 预检崩溃，目标不得进入 running：{exc}", ""
        if not res.get("ok"):
            problems = "；".join(str(p) for p in (res.get("problems") or []))
            return False, (
                "checkpoint 预检未通过，目标不得进入 running："
                f"{problems or '未知原因'}"
            ), ""

        dont_redo = res.get("dont_redo") or []
        verify_first = res.get("verify_before_redo") or []
        ledger_block = ""
        if dont_redo or verify_first:
            ledger_block = (
                f"[checkpoint 预检 {str(cp.get('last_event_id') or '')}] "
                f"账本记录：已确认落地的副作用 {len(dont_redo)} 项——不要原样重做；"
                f"结果未知的副作用 {len(verify_first)} 项——动手前先核对当前状态。"
            )
        try:
            self._storage.trace_event(
                session_id=sid or goal_id,
                event_type=EventType.GOAL_RESUMED_FROM_CHECKPOINT,
                payload={
                    "goal_id": goal_id,
                    "checkpoint_event_seq": cp.get("checkpoint_event_seq"),
                    "checkpoint_last_event_id": str(cp.get("last_event_id") or ""),
                    "dont_redo_count": len(dont_redo),
                    "verify_before_redo_count": len(verify_first),
                    "context_snapshot_id": str(cp.get("context_snapshot_id") or ""),
                },
                importance="critical",
                goal_id=goal_id,
            )
        except Exception as exc:  # noqa: BLE001
            # The resume itself is verified; losing its announcement must not
            # stop it, but it cannot vanish silently either.
            print(f"[goals] resumed_from_checkpoint event failed: {exc}")
        return True, "", ledger_block

    async def _fail(self, goal_id: str, reason: str) -> None:
        """Terminal failure: persist, release, notify."""
        self._storage.update_goal_fields(
            goal_id, status=GoalStatus.FAILED_FINAL, last_error=reason
        )
        self._finish_worker(goal_id)
        self._emit_change(goal_id, GoalStatus.FAILED_FINAL, error=reason)
        await self._bus.emit("goal_state_change", {
            "goal_id": goal_id, "status": "ovolve_failed_final", "reason": reason,
            "session_id": self._session_of_goal(goal_id),
        })

    def _emit_change(self, goal_id: str, status: str, **extra) -> None:
        """Fire-and-forget WS broadcast via the event bus."""
        payload = {
            "goal_id": goal_id,
            "status": status,
            "session_id": self._session_of_goal(goal_id),
            **extra,
        }
        try:
            asyncio.get_event_loop().call_soon(
                lambda: asyncio.ensure_future(
                    self._bus.emit("goal_state_change", payload)
                )
            )
        except RuntimeError:
            pass  # no running loop (unit tests)

    def _emit_stage(self, goal_id: str, stage: str, iteration: int = 0,
                    max_iterations: int = 0,
                    extra: Optional[dict] = None) -> None:
        """Broadcast a fine-grained pipeline stage (plan / execute / verify).

        Rides the SAME ``goal_state_change`` channel the frontend already
        consumes — the WS bridge forwards the payload verbatim, so the new
        ``stage`` field flows through with zero bridge changes and old
        consumers (evolution only reacts to terminal statuses) ignore it.
        ``extra``（U5）把附加字段（如 delivery_hints 佐证聚合）平铺进同一
        枚事件；非 dict 一律当空，fail-open 与本方法其余部分一致。

        fail-open 双层：本方法自吞
        同步异常；_emit_change 分离派发的 emit 任务失败也绝不波及 worker
        状态机。终态（completed / ovolve_failed_final）与 spawn/pause 的既有
        事件一律不带 stage——stage 只是 running 的细分，不是新状态。

        Purely informational: any failure must not disturb the worker loop,
        which the fire-and-forget scheduling above already guarantees.
        """
        try:
            payload_extra = dict(extra) if isinstance(extra, dict) else {}
            self._emit_change(
                goal_id, RUNNING, stage=stage,
                iteration=int(iteration or 0),
                max_iterations=int(max_iterations or 0),
                ts=int(time.time()),
                **payload_extra,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[goal_scheduler] stage event failed for {goal_id}: {exc}")


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_scheduler: Optional[GoalScheduler] = None


def get_goal_scheduler(router=None, bus=None, host=None) -> GoalScheduler:
    """Get or create the global GoalScheduler singleton.

    `host` is the SessionHost; passing it makes each goal execute in the Router
    of the session that owns it instead of one shared router.
    """
    global _scheduler
    if _scheduler is None:
        if router is None or bus is None:
            raise RuntimeError(
                "GoalScheduler must be initialized with router and bus on first call"
            )
        _scheduler = GoalScheduler(router, bus, host=host)
    return _scheduler
