"""
recovery.py — what happens to in-flight work when the process dies.

Why this exists
---------------
A process crash strands two kinds of state: goals the scheduler was mid-run
on (still `running`/`queued`, holding a claim nobody will ever release) and
sub-agents whose asyncio tasks evaporated with the loop. Before Phase 2 both
were silently demoted in the database — correct, but invisible: the event
ledger never learned a recovery had happened, so a replayed session showed a
turn that simply stopped, with no terminal fact at all.

This module centralizes boot-time recovery so it is testable without booting
a server:

  * :func:`recover_interrupted_goals` — demote mid-run goals to ``paused``
    (the user decides whether to resume; auto-resuming background agents
    after a restart would surprise the operator and spend budget without
    consent) and record SYSTEM_RECOVERY_INITIATED per goal in the ledger.
  * :func:`record_reaped_subagents` — mirror each reaped orphan sub-agent
    into the ledger as SUBAGENT_FAILED with the honest cause.
  * :func:`render_completed_side_effects` — the resume advisory: the
    already-landed side effects for a goal, so a resumed run is told what
    NOT to redo (the durable half of "completed side effects never repeat").
  * :func:`render_unknown_side_effects` — the other half: effects whose
    outcome nobody knows, so a resumed run verifies instead of redoing.

Everything here is best-effort by policy: recovery code must never be the
reason a server fails to boot. Failures are logged loudly, never raised.
"""
from __future__ import annotations

import logging
from typing import List

from event_types import EventType
from trace_gateway import TraceGateway, OBSERVATIONAL

log = logging.getLogger(__name__)

#: Cap the advisory list: it rides inside the continuation prompt, and a
#: hundred-entry dump would crowd out the actual remaining work.
_MAX_ADVISORY_ENTRIES = 20


def recover_interrupted_goals(storage, auto_resume: bool = False) -> List[dict]:
    """Demote goals stranded mid-run by a dead process; record each in the ledger.

    ``running``/``queued`` are the classic strands, but ``stopping`` and
    ``stop_timeout`` rows from a previous process belong here too: the worker
    that was being stopped (or that refused to confirm its stop) died with the
    process, so nothing is running any more and the honest resting state is
    paused. Claims are force-reaped via :meth:`reap_goal_claim`, which only
    ever touches claims owned by a DIFFERENT process generation.

    Returns the demoted goal rows (id/status/session_id/can_auto_resume).
    Safe to call repeatedly: goals already paused are skipped.
    """
    gateway = TraceGateway(storage.get_event_store())
    demoted: List[dict] = []
    try:
        stranded = [g for g in storage.list_goals()
                    if g.get("status") in ("running", "queued",
                                           "stopping", "stop_timeout")]
    except Exception:
        log.exception("recovery: could not list goals — skipping goal recovery")
        return demoted

    for g in stranded:
        gid = g.get("id") or ""
        if not gid:
            continue
        from_status = g.get("status") or "running"
        can_auto_resume = from_status in ("running", "queued")
        try:
            storage.update_goal_fields(
                gid, status="paused", last_error="Interrupted by server restart")
            storage.reap_goal_claim(gid)
        except AttributeError:
            # Older storage without generation-aware reaping: fall back to the
            # ownerless release rather than stranding the claim forever.
            try:
                storage.release_goal(gid)
            except Exception:
                log.exception("recovery: claim release failed for goal %s", gid)
        except Exception:
            log.exception("recovery: failed to demote goal %s", gid)
            continue
        try:
            gateway.append(
                session_id=g.get("session_id") or gid,
                event_type=EventType.SYSTEM_RECOVERY_INITIATED,
                payload={
                    "goal_id": gid,
                    "from_status": from_status,
                    "to_status": "paused",
                    "can_auto_resume": can_auto_resume,
                    "cause": "server restart",
                },
                importance=OBSERVATIONAL,
                idempotency_key=f"recovery:goal:{gid}",
                goal_id=gid,
                actor="system",
            )
        except Exception:
            log.exception("recovery: ledger write failed for goal %s", gid)
        demoted.append({
            **g,
            "from_status": from_status,
            "can_auto_resume": can_auto_resume,
        })
    return demoted


def record_reaped_subagents(storage, rows: List[dict]) -> int:
    """Write a SUBAGENT_FAILED ledger event per reaped orphan row.

    The DB row already says ``killed``; the event makes the fact part of the
    session's replayable stream. Returns the number of events written.
    """
    if not rows:
        return 0
    gateway = TraceGateway(storage.get_event_store())
    written = 0
    for row in rows:
        try:
            gateway.append(
                session_id=row.get("parent_session_id") or row.get("child_session_id") or "subagents",
                event_type=EventType.SUBAGENT_FAILED,
                payload={
                    "subagent_id": row.get("subagent_id", ""),
                    "subagent_type": row.get("subagent_type", ""),
                    "label": row.get("label", ""),
                    "cause": "Interrupted by server restart",
                    "reaped": True,
                },
                importance=OBSERVATIONAL,
                idempotency_key=f"recovery:subagent:{row.get('subagent_id', '')}",
                actor="system",
            )
            written += 1
        except Exception:
            log.exception("recovery: ledger write failed for subagent %s",
                          row.get("subagent_id"))
    return written


def render_completed_side_effects(goal_id: str, storage) -> str:
    """The 'already landed — do not redo' block for a continuation prompt.

    Empty string when nothing completed (the common fresh-goal case), so the
    prompt is untouched unless there is something real to say.
    """
    try:
        rows = storage.completed_side_effects(goal_id)
    except Exception:
        return ""
    if not rows:
        return ""
    lines = ["Side effects that already COMPLETED for this goal (do NOT redo them):"]
    for r in rows[:_MAX_ADVISORY_ENTRIES]:
        lines.append(
            f"  - {r.get('tool_name', '?')} (call {r.get('call_id', '?')[:8]},"
            f" args#{str(r.get('args_hash', ''))[:8]})"
        )
    if len(rows) > _MAX_ADVISORY_ENTRIES:
        lines.append(f"  ... and {len(rows) - _MAX_ADVISORY_ENTRIES} more")
    return "\n".join(lines)


def _verdict_suffix(row: dict) -> str:
    """What the file system says about one unresolved effect, in one clause.

    The ledger row says "we dispatched this and never heard back". That is worth
    printing, but it is not what the model needs: it needs to know whether the
    change is already there. For a typed effect (0012) we can answer that by
    looking — ``effects.reconcile`` compares the target's current state against
    the state recorded before the attempt and the state a success would have
    produced. Untyped rows get nothing extra rather than a guess.
    """
    kind = str(row.get("effect_kind") or "")
    target = str(row.get("target") or "")
    if not (kind and target):
        return ""
    try:
        import effects
        rec = effects.reconcile(kind, target,
                               str(row.get("pre_hash") or ""),
                               str(row.get("planned_hash") or ""))
    except Exception:
        return ""
    label = {
        "landed": "现场核对：目标**已经是**这次要写成的样子——重做等于写第二遍",
        "not_started": "现场核对：目标与动手前逐字节相同——可以放心重做一次",
        "conflict": "现场核对：目标变成了第三种样子（中间被别人改过）——先读再决定，别覆盖",
        "unknown": "现场核对：证据不足，无法判断是否已生效",
    }.get(rec["status"], "")
    if kind in getattr(effects, "GIT_KINDS", ()):
        # A repo is not a file: "byte-identical" and "would overwrite" say
        # nothing here, and the action to take is to read git log, not the file.
        label = {
            "landed": "现场核对：这次 git 操作**已经生效**（提交已在 HEAD／已推到远端）"
                      "——重做会多一次",
            "not_started": "现场核对：HEAD 和暂存区与动手前一致——这一步没做成，可以重做",
            "conflict": "现场核对：仓库被别人动过（HEAD 不是我们这次的提交）"
                        "——先看 git log 再决定",
            "unknown": "现场核对：证据不足，无法判断这次 git 操作是否已生效",
        }.get(rec["status"], "")
    if not label:
        return ""
    short = target.rsplit("/", 1)[-1] or target
    return f"\n      {label}（{short}）"


def render_unknown_side_effects(goal_id: str, storage) -> str:
    """The 'outcome unknown — verify before redoing' block for a continuation prompt.

    The counterpart to :func:`render_completed_side_effects`, and the more
    dangerous half. A call that was dispatched and then interrupted (pause,
    cancel, crash between dispatch and settle) left the ledger with no
    verdict: the write may have landed, may not have. Telling a resumed run
    only about what *completed* leaves these invisible, and invisible means
    redone.

    Empty string when there is nothing unresolved, so the usual prompt is
    untouched.
    """
    try:
        rows = storage.unknown_side_effects(goal_id)
    except Exception:
        return ""
    if not rows:
        return ""
    lines = ["状态未知：可能已生效，续跑前请先核对，不要直接重做："]
    for r in rows[:_MAX_ADVISORY_ENTRIES]:
        lines.append(
            f"  - {r.get('tool_name', '?')} (call {str(r.get('call_id', '?'))[:8]},"
            f" args#{str(r.get('args_hash', ''))[:8]}, {r.get('status', '?')})"
            + _verdict_suffix(r)
        )
    if len(rows) > _MAX_ADVISORY_ENTRIES:
        lines.append(f"  ... 另有 {len(rows) - _MAX_ADVISORY_ENTRIES} 条")
    return "\n".join(lines)
