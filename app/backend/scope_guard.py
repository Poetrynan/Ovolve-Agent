"""
scope_guard.py — Session & Branch 作用域上下文与硬隔离守卫。

§13.4 & §13.5:
1. 建立唯一的 ScopeContext 结构，杜绝各 handler 自行拼接过滤条件；
2. 所有消息、轮次、工具结果、记忆提取、技能经验、Episode、LearningItem、EventStore 事件
   都必须携带并在读写时校验 session_id 与 branch_id；
3. 本地单用户环境也必须保证对象归属校验，跨会话/分支操作返回 409 scope_mismatch。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class ScopeContext:
    """标准的作用域上下文。"""
    session_id: str
    branch_id: str = ""
    workspace_root: str = ""
    user_id: str = "local_user"
    current_goal_id: str = ""
    current_run_id: str = ""
    current_turn_id: str = ""
    current_episode_id: str = ""

    def matches(self, target_session_id: str, target_branch_id: str = "") -> bool:
        """校验目标对象是否处于当前作用域内（严格 exact match）。"""
        if not self.session_id or not target_session_id:
            return False
        if self.session_id.strip() != target_session_id.strip():
            return False
        # 严格校验分支：双方规范化后必须完全一致
        cur_b = (self.branch_id or "").strip()
        tgt_b = (target_branch_id or "").strip()
        if cur_b != tgt_b:
            return False
        return True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sessionId": self.session_id,
            "branchId": self.branch_id,
            "workspaceRoot": self.workspace_root,
            "userId": self.user_id,
            "goalId": self.current_goal_id,
            "runId": self.current_run_id,
            "turnId": self.current_turn_id,
            "episodeId": self.current_episode_id,
        }


def validate_scope(
    expected_session: str,
    expected_branch: str,
    actual_session: str,
    actual_branch: str = "",
) -> tuple[bool, str]:
    """严格校验 session 与 branch 是否匹配（exact match）。

    Returns:
        (is_valid, error_message)
    """
    exp_s = (expected_session or "").strip()
    act_s = (actual_session or "").strip()
    if not exp_s or not act_s:
        return False, "missing_session_id"
    if exp_s != act_s:
        return False, f"session_mismatch: expected '{exp_s}' but got '{act_s}'"

    exp_b = (expected_branch or "").strip()
    act_b = (actual_branch or "").strip()
    if exp_b != act_b:
        return False, f"branch_mismatch: expected '{exp_b}' but got '{act_b}'"
    return True, ""
