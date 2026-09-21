"""
checkpoint.py — 自包含检查点（Phase 2 收口）。

总指令 §5.2：checkpoint 必须能回答——当前在哪一步、哪些工具已完成、哪些
副作用不能重做、恢复后如何继续。它不是一段聊天文本。

落点：以 SYSTEM_CHECKPOINT_CREATED 事件写入既有 EventStore（幂等键 =
checkpoint:{scope}:{last_seq}），与事实源同库同链，天然可回放。

接线现状（别再猜）
------------------
`build_checkpoint` 有生产调用者：每轮结束、完成时刻、以及暂停/取消路径
（goal_scheduler.py 三处）。`resume_from_checkpoint` 自 2026-08 起是**续跑前的
强制 preflight**：scheduler 在把目标置为 running 之前先加载最近一份
checkpoint（`load_latest_checkpoint`，按 goal_id 维度查事件流）并跑完整校验，
任何一条不过目标就不得进入 running。它仍然不「从快照里恢复执行」——本仓每轮
都是一次 LLM 调用，天然非确定，「从事件 47 精确恢复」在 Temporal 那种确定性
重放的意义上不可实现；生产语义保持 Continue-As-New：校验通过后写
``goal.resumed_from_checkpoint`` 事件、铸新 run_id、用账本核对结果重排下一轮
提示词，再进 worker。
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional


def rebuild_tail_from_events(storage, sid: str, upto_seq: int = 0,
                             n: int = 8) -> list:
    """§5.3 replay 语义：从事件流**投影**重建对话尾部。

    复用既有的确定性投影器（SessionProjector）——消息正文本就在事件里
    （user.message_submitted / llm.response_completed），这正是"一个真实 turn
    可以通过事件完整重建"验收的直接收益。只读、零副作用。
    """
    from projection_engine import ProjectedSessionState, SessionProjector

    state = ProjectedSessionState(session_id=sid)
    projector = SessionProjector()
    for e in storage.get_event_store().read_stream(sid):
        if upto_seq and e.seq > upto_seq:
            break
        state = projector.apply_event(state, e)
    return state.messages[-n:] if n else []


def load_latest_checkpoint(storage, *, goal_id: str = "",
                           session_id: str = "") -> Optional[Dict[str, Any]]:
    """Newest ``system.checkpoint_created`` event for this goal, as a dict.

    This is the read half of the preflight contract: the write side has been
    landing checkpoints into the ledger all along (per round / completion /
    pause), so "load the latest checkpoint before resuming" is a query, not a
    new store. Prefers the goal dimension — a goal that paused and resumed
    across sessions writes its checkpoints under one ``goal_id`` but several
    session streams — and falls back to scanning one stream when only a
    session id is known. Returns None when nothing was ever written (a fresh
    goal), which callers treat as "no preflight needed", not as an error.
    """
    if not (goal_id or session_id):
        return None
    try:
        if goal_id:
            events = storage.get_event_store().read_by_dimension(
                "goal_id", str(goal_id), limit=2000,
            )
        else:
            events = storage.get_event_store().read_stream(str(session_id))
    except Exception:
        return None
    picked = None
    for ev in events:
        if getattr(ev, "event_type", "") != "system.checkpoint_created":
            continue
        payload = ev.payload or {}
        if goal_id and str(payload.get("goal_id") or "") != str(goal_id):
            continue
        if picked is None or getattr(ev, "seq", 0) > getattr(picked, "seq", 0):
            picked = ev
    if picked is None:
        return None
    cp = dict(picked.payload or {})
    # The event row is authoritative about where the checkpoint lives; older
    # payloads may have blanked these.
    cp.setdefault("session_id", getattr(picked, "session_id", "") or "")
    cp["checkpoint_event_seq"] = getattr(picked, "seq", None)
    return cp


def resume_from_checkpoint(storage, checkpoint: dict) -> Dict[str, Any]:
    """§5.3 resume：从 checkpoint 重建恢复现场。**只读**——绝不触发副作用工具。

    校验三件事，任何一件不过都如实报告而不是盲续：
    1. 流可读且 last_event_seq 仍在流中（流被截断/分支切换则拒绝）；
    2. 对话尾部优先从事件流投影重建（§5.3 replay 正源）；事件层没有消息的
       旧流退回存储直读，且尾部每条仍要能对上（消息被删则提示）；
    3. dont_redo 清单原样上抛——调用方拿它去抑制重复副作用。
    """
    problems: list = []
    sid = str(checkpoint.get("session_id") or "")
    seq = int(checkpoint.get("last_event_seq") or 0)
    if not sid:
        return {"ok": False, "problems": ["checkpoint 缺 session_id"],
                "messages": [], "rebuild_source": "none",
                "dont_redo": [], "verify_before_redo": [], "goal_snapshot": {}}

    try:
        events = storage.get_event_store().read_stream(sid)
        seqs = {getattr(e, "seq", 0) for e in events}
    except Exception as e:
        return {"ok": False, "problems": [f"stream unreadable: {e}"],
                "messages": [], "rebuild_source": "none",
                "dont_redo": [], "verify_before_redo": [], "goal_snapshot": {}}
    if seq and seq not in seqs:
        problems.append(f"checkpoint seq {seq} 不在当前流中——分支可能已移动")

    # 尾部重建：主源 = 事件流投影；兜底 = 存储直读（并校验尾部仍可寻）
    tail = checkpoint.get("retained_tail") or []
    rebuilt: list = []
    source = "none"
    try:
        rebuilt_evt = rebuild_tail_from_events(
            storage, sid, upto_seq=seq, n=max(len(tail) or 8, 8))
        if rebuilt_evt:
            rebuilt, source = rebuilt_evt, "events"
    except Exception as e:
        # 主源失败会静默降级到存储直读——恢复质量悄悄变差必须留痕，
        # 否则"为什么恢复出来的上下文和当时看到的不一样"永远查无实据。
        print(f"[checkpoint] event-projection rebuild failed for {sid}, "
              f"falling back to storage tail: {e}")

    missing = 0
    if not rebuilt and tail:
        source = "storage"
        stored: list = []
        try:
            stored = [dict(m) for m in storage.get_messages(sid, limit=200)]
        except Exception:
            stored = []
        for t in tail:
            hit = next((m for m in stored
                        if str(m.get("content") or "")[:500] ==
                           str(t.get("content") or "")), None)
            if hit is None:
                missing += 1
            else:
                rebuilt.append(hit)

    if tail and not rebuilt:
        problems.append("对话尾既无法从事件投影也无法从存储找回")
    if missing:
        problems.append(f"retained_tail 有 {missing} 条在存储中找不到"
                        "（可能已被用户删除）")

    return {
        "ok": not problems,
        "problems": problems,
        "session_id": sid,
        "messages": rebuilt,
        "rebuild_source": source,
        "dont_redo": list(checkpoint.get("completed_side_effects") or []),
        # 未知态单独一条通道。混进 dont_redo 会把"先核对"降级成"别做"，
        # 而这两条指令在一个可能没生效的写操作面前是相反的建议。
        "verify_before_redo": list(checkpoint.get("unresolved_side_effects") or []),
        "goal_snapshot": checkpoint.get("goal_snapshot") or {},
    }


def build_checkpoint(storage, *, session_id: str, goal_id: str = "",
                     run_id: str = "", turn_state: str = "",
                     current_phase: str = "", scope: str = "") -> Optional[Dict[str, Any]]:
    """从既有事实源拼装一份自包含 checkpoint。取不到任何流时返回 None。"""
    try:
        events = storage.get_event_store().read_stream(session_id)
    except Exception:
        events = []
    if not events:
        return None

    last = events[-1]
    completed_side_effects: list[str] = []
    try:
        completed_side_effects = [
            e["call_id"] for e in storage.completed_side_effects(goal_id)
        ] if goal_id else []
    except Exception:
        pass  # fail-open: 可选增强，失败不影响主流程

    # 结果未知的副作用。和 completed 分开存：一个说"别重做"，一个说"先核对"。
    # 只记 completed 的话，恰好是最危险的那一类（派发出去、被打断、不知道有没
    # 有生效）在恢复现场里完全看不见——看不见就会被重做。
    unresolved_side_effects: list = []
    if goal_id:
        try:
            unresolved_side_effects = [
                {"call_id": r.get("call_id", ""), "tool_name": r.get("tool_name", ""),
                 "status": r.get("status", "")}
                for r in storage.unknown_side_effects(goal_id)
            ]
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    goal_snapshot: Dict[str, Any] = {}
    if goal_id:
        try:
            row = storage.get_goal(goal_id) or {}
            goal_snapshot = {
                "status": row.get("status"),
                "iteration": row.get("iteration"),
                "plan_json": row.get("plan_json"),
                "contract_json": (row.get("contract_json") or "")[:4000],
                "budget_used_last_error": row.get("last_error"),
            }
        except Exception:
            goal_snapshot = {}

    # §5.2 retained_tail / context_snapshot_id（Phase 9 收口）：保留尾部是
    # 恢复后模型最先看到的对话；快照 id 是它的确定性指纹——内容变，id 变。
    retained_tail: list = []
    context_snapshot_id = ""
    try:
        msgs = storage.get_messages(session_id, limit=8)
        for m in msgs:
            if not isinstance(m, dict):
                m = dict(m)
            retained_tail.append({
                "role": str(m.get("role") or ""),
                "content": str(m.get("content") or "")[:500],
                "ts": m.get("timestamp") or m.get("created_at") or "",
            })
    except Exception:
        retained_tail = []
    if retained_tail:
        import hashlib
        import json as _json
        digest_src = _json.dumps(retained_tail, ensure_ascii=False, sort_keys=True)
        context_snapshot_id = "ctx:" + hashlib.sha256(
            digest_src.encode("utf-8")).hexdigest()[:16]

    checkpoint = {
        "run_id": run_id,
        "turn_id": "",
        "goal_id": goal_id,
        "session_id": session_id,
        "last_event_seq": getattr(last, "seq", None),
        "last_event_id": f"{session_id}:{getattr(last, 'seq', '')}",
        "turn_state": turn_state,
        "current_phase": current_phase,
        "pending_tool_calls": [],
        "completed_side_effects": completed_side_effects,
        "unresolved_side_effects": unresolved_side_effects,
        "goal_snapshot": goal_snapshot,
        "context_snapshot_id": context_snapshot_id,
        "retained_tail": retained_tail,
        "usage_snapshot": {},
        "policy_snapshot": {},
        "created_at": int(time.time()),
    }
    try:
        storage.trace_event(
            session_id=session_id,
            event_type="system.checkpoint_created",
            payload=checkpoint,
            importance="critical",
            idempotency_key=f"checkpoint:{scope or goal_id or session_id}:{checkpoint['last_event_seq']}",
            run_id=run_id or None,
            goal_id=goal_id or None,
        )
    except Exception as e:
        print(f"[checkpoint] emit failed: {e}")
        return None
    return checkpoint
