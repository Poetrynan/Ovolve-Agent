"""
approvals_projection.py — 演化裁决页的只读投影。

聚合两类"自进化环在等人工拍板"的事项：

* skillCandidates     —— staged 状态的技能候选（学习环等待批准）
* evolutionProposals  —— pending 状态的演化提案（记忆/指导文件待批准）

ask_user 问题卡**不在**这里：它是会话进行中的临时交互，归属聊天流——卡片
本来就在对话里渲染与回答，进裁决列表只会弄混页面身份（产品决定，2026-08）。
投影是只读聚合，真相仍在各自的账本里。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def _open_evolution_proposals(engine=None) -> List[Dict[str, Any]]:
    """pending 提案列表。取不到就返回空——投影的其余部分不该被它拖垮。

    off 档一行不查：引擎关着的时候读库既无意义，也违反"没开就零 IO"。
    也不主动建引擎——只读投影不该成为"第一次建演化库"的那个调用者；服务启动时
    ``configure_from_config`` 已经建过，没建过就说明这个进程压根没在演化。
    """
    if engine is None:
        try:
            import evolution
            engine = getattr(evolution, "_engine", None)
        except Exception:
            return []
    if engine is None:
        return []
    try:
        if not engine.enabled():
            return []
        return engine.list_open()
    except Exception:
        return []


def pending_approvals(storage, *,
                      evolution_engine=None) -> Dict[str, Any]:
    """聚合演化环的全部待人工处理事项。"""
    staged = []
    try:
        staged = storage.list_skill_candidates(status="staged", limit=50)
    except Exception:
        staged = []

    proposals = _open_evolution_proposals(evolution_engine)

    return {
        "skillCandidates": staged,
        "evolutionProposals": proposals,
        "counts": {
            "skillCandidates": len(staged),
            "evolutionProposals": len(proposals),
            "total": len(staged) + len(proposals),
        },
    }
