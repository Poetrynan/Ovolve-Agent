"""plan_artifact.py — Plan 模式的一等产物：方案合同存储 / 批准 / 渲染。

permission=plan 的轮次产出方案后，方案不再只是一段聊天文本：
save → 审批卡 → approve → 执行轮注入合同，四步闭环。
存储走 storage kv（ns="plan_artifact"），Fail-open：本模块任何异常
都不得阻断主轮次（调用方负责 try/except）。
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Optional

_KV_NS = "plan_artifact"
_MAX_CHARS = 40_000


def _kv_key(plan_id: str) -> str:
    return f"pa:{plan_id}"


def _session_index_key(session_id: str) -> str:
    return f"pa_idx:{session_id}"


def save_plan_artifact(session_id: str, plan_md: str, meta: Optional[dict] = None) -> dict:
    """把一份方案文本存为一等产物（status=ready），返回完整 artifact。"""
    from storage import get_storage
    st = get_storage()
    plan_md = str(plan_md or "").strip()
    artifact = {
        "plan_id": f"pa_{uuid.uuid4().hex[:12]}",
        "session_id": session_id,
        "plan_md": plan_md[:_MAX_CHARS],
        "status": "ready",            # ready -> approved | discarded
        "created_at": time.time(),
        "chars": min(len(plan_md), _MAX_CHARS),
        "meta": dict(meta or {}),
    }
    st.kv_set(_kv_key(artifact["plan_id"]), json.dumps(artifact, ensure_ascii=False), ns=_KV_NS)
    idx = st.kv_get(_session_index_key(session_id), ns=_KV_NS, default=[])
    if not isinstance(idx, list):
        idx = []
    idx.append(artifact["plan_id"])
    # 单会话上限 50 份：防长期会话把 kv 索引刷爆；旧方案按需 get_plan_artifact 直取。
    st.kv_set(_session_index_key(session_id), json.dumps(idx[-50:]), ns=_KV_NS)
    return artifact


def get_plan_artifact(plan_id: str) -> Optional[dict]:
    if not plan_id:
        return None
    from storage import get_storage
    try:
        raw = get_storage().kv_get(_kv_key(plan_id), ns=_KV_NS)
    except Exception:
        return None
    if not raw:
        return None
    # kv_get 对字符串值会自动 json.loads——存进去的 JSON 串取出来已是 dict；
    # 兼容两种形态，不重复解码。
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def latest_ready_for_session(session_id: str) -> Optional[dict]:
    """该会话最新一份仍为 ready 的方案（已批准/已放弃的不返回）。"""
    from storage import get_storage
    try:
        raw = get_storage().kv_get(_session_index_key(session_id), ns=_KV_NS, default=[])
        ids = raw if isinstance(raw, list) else json.loads(raw)
    except Exception:
        return None
    for pid in reversed(ids if isinstance(ids, list) else []):
        art = get_plan_artifact(pid)
        if art and art.get("status") == "ready":
            return art
    return None


def approve_plan_artifact(plan_id: str, approved_with: str) -> Optional[dict]:
    """ready -> approved，原子防重：二次批准返回 None（一个方案只许触发一次执行轮）。"""
    art = get_plan_artifact(plan_id)
    if not art or art.get("status") != "ready":
        return None
    art["status"] = "approved"
    art["approved_with"] = str(approved_with or "auto")
    art["approved_at"] = time.time()
    from storage import get_storage
    get_storage().kv_set(_kv_key(plan_id), json.dumps(art, ensure_ascii=False), ns=_KV_NS)
    return art


def discard_plan_artifact(plan_id: str) -> bool:
    """ready -> discarded。discarded 是终态：不可再批准。"""
    art = get_plan_artifact(plan_id)
    if not art or art.get("status") != "ready":
        return False
    art["status"] = "discarded"
    from storage import get_storage
    get_storage().kv_set(_kv_key(plan_id), json.dumps(art, ensure_ascii=False), ns=_KV_NS)
    return True


def render_contract(artifact: dict) -> str:
    """把已批准方案渲染成执行轮开头的合同文本。"""
    md = str(artifact.get("plan_md") or "").strip()
    return (
        "[方案合同] 以下是已获用户批准的执行方案，请严格按其分步执行；\n"
        "每完成一步在回复中标注对应步骤状态（todo/in_progress/done/failed/skipped，"
        "与 PlanStepStatus 一致），遇阻如实报告，不要擅自扩大范围：\n\n"
        f"{md}\n\n"
        "[方案合同结束] 超出方案范围的新增改动，先说明并征求用户同意。"
    )


def extract_plan_block(text: str) -> str:
    """从模型输出提取 ```plan 围栏内容；无围栏回退全文（去空白）。"""
    text = str(text or "")
    marker = "```plan"
    start = text.find(marker)
    if start == -1:
        return text.strip()
    body_start = text.find("\n", start)
    if body_start == -1:
        return ""
    end = text.find("```", body_start + 1)
    body = text[body_start + 1: end if end != -1 else len(text)]
    return body.strip()
