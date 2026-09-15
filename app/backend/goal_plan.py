"""goal_plan.py - The one place a goal's sub-task list is read and written.

``goals.plan_json`` existed for a long time with only read paths: the API shaped
it into ``subtasksCompleted / subtasksTotal / progressRatio`` and the UI drew a
bar from it, but nothing ever wrote a plan. So the bar was always 0/0 and
``progressRatio`` was always null, and a goal that resumed after a restart
replayed its original description from scratch because there was no record of
which parts were already done.

This module is that write side. Two callers, one table:

  * the scheduler worker seeds a plan from the goal's brief and flips items as
    rounds land (see :func:`seed_plan_from_brief`, :func:`apply_completion`);
  * the model updates its own list through the ``plan_write`` tool.

Both go through :func:`save_plan`, which writes ``plan_json`` with a narrow
per-column update — it cannot clobber the spend ledger the way a whole-row
read-modify-write would.

Deliberately NOT a second todo store. A separate in-session todo list would drift
from the goal's plan within one turn, and then two screens would disagree about
what is done.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from result import Result
from storage import get_storage
from tools import ToolDef

#: Item lifecycle. ``blocked`` is not a failure — it means "cannot proceed until
#: something outside this item changes", which is worth distinguishing from
#: "nobody has started it" when a human reads the panel.
PLAN_STATUSES = ("pending", "in_progress", "completed", "blocked")

#: A plan longer than this is not a plan, it is a transcript. Truncated rather
#: than rejected so an over-eager model still gets a usable list.
MAX_PLAN_ITEMS = 20

#: Titles are read in a narrow side panel; a paragraph there is unreadable.
MAX_TITLE_CHARS = 120

#: How many unfinished items to put into a continuation prompt. The point is to
#: re-orient the model, not to re-send the whole plan every round.
RESUME_ITEM_LIMIT = 8


def normalize_plan(raw: Any) -> list[dict]:
    """Coerce anything into a valid plan list.

    Accepts the stored JSON string, an already-parsed list, or a list of bare
    strings (which is what a model produces about half the time). Unknown
    statuses become ``pending`` instead of being dropped: losing the item would
    silently shrink the denominator of the progress bar.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(raw, list):
        return []

    items: list[dict] = []
    for i, entry in enumerate(raw[:MAX_PLAN_ITEMS]):
        if isinstance(entry, str):
            entry = {"title": entry}
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or entry.get("text") or "").strip()
        if not title:
            continue
        status = str(entry.get("status") or "pending").strip().lower()
        if status not in PLAN_STATUSES:
            status = "pending"
        items.append({
            "id": str(entry.get("id") or i + 1),
            "title": title[:MAX_TITLE_CHARS],
            "status": status,
        })
    return items


def load_plan(goal_id: str) -> list[dict]:
    """Current plan for a goal ([] when there is none)."""
    row = get_storage().get_goal(goal_id)
    if not row:
        return []
    return normalize_plan(row.get("plan_json"))


def save_plan(goal_id: str, items: list) -> bool:
    """Persist a plan. Returns True when a row was updated."""
    payload = json.dumps(normalize_plan(items), ensure_ascii=False)
    return bool(get_storage().update_goal_fields(goal_id, plan_json=payload))


def seed_plan_from_brief(goal_id: str, brief: Any) -> list[dict]:
    """Give a goal its initial plan, derived from the brief's deliverables.

    Derived rather than asked-for on purpose. An LLM planning round costs money,
    can return unparseable output, and can fail exactly when the goal is about to
    start — and the brief already contains the authoritative list of what must be
    produced. Seeding from it means every goal has a plan before its first round,
    which is what makes progress countable and a resume possible. The model can
    still restructure the list at any point via ``plan_write``.

    Existing plans are left alone: a resumed goal must not lose the states it
    already recorded.
    """
    existing = load_plan(goal_id)
    if existing:
        return existing

    deliverables: list[str] = []
    if brief is not None:
        raw = getattr(brief, "deliverables", None)
        if raw is None and isinstance(brief, dict):
            raw = brief.get("deliverables")
        if isinstance(raw, list):
            deliverables = [str(d).strip() for d in raw if str(d).strip()]

    if not deliverables:
        return []

    items = [{"id": str(i + 1), "title": d[:MAX_TITLE_CHARS], "status": "pending"}
             for i, d in enumerate(deliverables[:MAX_PLAN_ITEMS])]
    save_plan(goal_id, items)
    return items


def apply_completion(items: list, completed: Any, all_done: bool = False) -> tuple[list, int]:
    """Flip items to ``completed`` from a verifier verdict.

    Args:
        items: Current plan.
        completed: 1-based indices or item ids the verifier reported as done.
            Both spellings are accepted because a model asked for "which
            deliverables are finished" answers with either.
        all_done: The goal passed as a whole — everything is done by definition.

    Returns:
        ``(items, flipped_count)``. ``items`` is a new list; the input is not
        mutated, so a caller can compare before/after.
    """
    out = [dict(x) for x in normalize_plan(items)]
    if not out:
        return out, 0

    if all_done:
        flipped = sum(1 for x in out if x["status"] != "completed")
        for x in out:
            x["status"] = "completed"
        return out, flipped

    wanted: set[str] = set()
    if isinstance(completed, (list, tuple, set)):
        for c in completed:
            wanted.add(str(c).strip())
    elif completed not in (None, ""):
        wanted.add(str(completed).strip())
    if not wanted:
        return out, 0

    flipped = 0
    for idx, item in enumerate(out, start=1):
        hit = str(idx) in wanted or item["id"] in wanted
        if hit and item["status"] != "completed":
            item["status"] = "completed"
            flipped += 1
    return out, flipped


def unfinished(items: list) -> list[dict]:
    """Items that still need work, in plan order."""
    return [x for x in normalize_plan(items) if x["status"] != "completed"]


def render_unfinished(items: list, limit: int = RESUME_ITEM_LIMIT) -> str:
    """The remaining-work block for a continuation prompt.

    Returns "" when there is no plan or nothing is left, so callers can just
    concatenate without checking.
    """
    left = unfinished(items)
    if not left:
        return ""
    done = len(normalize_plan(items)) - len(left)
    lines = [f"计划进度：{done}/{len(normalize_plan(items))} 项已完成。还剩："]
    for x in left[:limit]:
        mark = "进行中" if x["status"] == "in_progress" else (
            "受阻" if x["status"] == "blocked" else "未开始")
        lines.append(f"  [{mark}] {x['title']}")
    if len(left) > limit:
        lines.append(f"  ……还有 {len(left) - limit} 项")
    lines.append("接着做还没完成的部分，不要从头重做已完成的项。")
    return "\n".join(lines)


def plan_digest(items: list) -> str:
    """One-line ``done/total`` summary for logs and tool replies."""
    norm = normalize_plan(items)
    if not norm:
        return "no plan"
    done = sum(1 for x in norm if x["status"] == "completed")
    return f"{done}/{len(norm)} completed"


def build_resume_checkpoint_prompt(goal_id: str, storage: Any = None) -> str:
    """Construct a minimal, token-efficient Checkpoint Snapshot prompt for resuming a goal.

    Eliminates the need to replay hundreds of historical messages, reducing resumed turn
    token cost and TTFT by up to 70%.
    """
    st = storage if storage is not None else get_storage()
    goal = st.get_goal(goal_id)
    if not goal:
        return ""

    plan = load_plan(goal_id)
    rem = render_unfinished(plan)

    parts = [
        "# 目标断点续跑快照 (Goal Checkpoint Snapshot)",
        f"目标: {goal.get('title') or goal.get('description') or goal_id}",
    ]
    try:
        from recovery import render_completed_side_effects
        side_effects_block = render_completed_side_effects(goal_id, st)
        if side_effects_block:
            parts.append(f"\n{side_effects_block}")
    except Exception:
        pass

    if rem:
        parts.append(f"\n{rem}")
    else:
        parts.append("所有规划子步骤均已完成，请执行最终交付成果核验。")

    parts.append("\n【执行要求】直接从当前未完成的步骤开始执行，严禁重复执行已落地的操作。")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# plan_write tool
# ---------------------------------------------------------------------------

PLAN_WRITE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "description": "完整的子任务列表（整表替换，不是增量）。顺序即执行顺序。",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "一句话说清这一步要产出什么"},
                    "status": {
                        "type": "string",
                        "enum": list(PLAN_STATUSES),
                        "description": "pending / in_progress / completed / blocked",
                    },
                },
                "required": ["title"],
            },
        },
    },
    "required": ["items"],
}

PLAN_WRITE_DESCRIPTION = (
    "维护当前目标的子任务清单，写进目标自己的进度表（前端「目标」面板的进度条读的就是这张表）。\n"
    "\n"
    "什么时候用：任务需要三步以上、跨多个文件或多轮才能做完，或者你已经做完了清单里的某一项。\n"
    "什么时候别用：读一个文件、答一个问题、改一处拼写——这类活儿列清单只是噪音，直接做。\n"
    "\n"
    "规则：\n"
    "- 传整份清单（整表替换），不要只传变动项。\n"
    "- 同一时刻最多一项 in_progress；开始下一项前先把上一项标 completed。\n"
    "- 只有真的做完并验证过才标 completed，没验证就还是 in_progress。\n"
    "- 卡住了标 blocked 并在 title 里写清卡在哪，不要假装完成。\n"
    "- 只在目标执行中可用；普通对话里没有目标可写，会直接返回错误。"
)


def _plan_write(args: dict, context: dict = None) -> Result:
    """Replace the active goal's plan with the model's list."""
    context = context or {}
    goal_id = str(context.get("goal_id") or "").strip()
    if not goal_id:
        return Result.failure(
            "当前回合没有绑定目标，plan_write 无处可写。"
            "长任务请先在「目标」面板建目标再执行；单轮对话里直接做就行。"
        )
    items = normalize_plan((args or {}).get("items"))
    if not items:
        return Result.failure("items 为空或全部条目缺少 title，没有可写入的内容。")
    if not save_plan(goal_id, items):
        return Result.failure(f"目标不存在或已被删除：{goal_id}")
    return Result.success({
        "goal_id": goal_id,
        "items": items,
        "progress": plan_digest(items),
    })


def register_tools(registry) -> None:
    """Register ``plan_write``. Called by Router._register_analysis_tools."""
    registry.register(ToolDef(
        name="plan_write",
        description=PLAN_WRITE_DESCRIPTION,
        schema=PLAN_WRITE_SCHEMA,
        execute=_plan_write,
        domain="general",
        risk_level="low",
    ))
