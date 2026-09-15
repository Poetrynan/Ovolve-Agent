"""
execution_provider.py — 执行环境选择（Phase 8，按修订版 §7.4：无 Docker 轻量隔离）。

v0.1 硬性约束：**不得依赖 Docker、容器镜像、VM 或远程沙箱**。执行环境复用仓库
既有的 workspace、worktree、path_policy、danger classifier 与 sandbox.popen_confined。

对外只有三种执行模式：
    read-only            只读/查询——自动执行
    workspace-write      改工作区文件/装依赖/跑测试——限制在 workspace/worktree 内
    danger-full-access   高风险旁路——非默认，必须显式人工确认且完整审计，
                         绝不用于后台自进化

选择规则（§7.4）映射风险等级：
    R0/R1 → read-only
    R2    → workspace-write（worktree 可用则优先隔离副本）
    R3    → workspace-write + 强制人工确认（有 worktree 则在副本里做）
    R4    → 仅当调用方携带显式人工确认才给 danger-full-access；
            未确认一律返回 refused——**没有 Docker 也绝不放宽权限**。

OS 原生加固的归属：Windows Job Objects/restricted token、macOS Seatbelt、
Linux Landlock 由 sandbox.py 的 popen_confined 层在上游统一施加；本模块只做
模式选择与可解释性，不重复实现进程隔离。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

RISK_LEVELS = ("R0", "R1", "R2", "R3", "R4")

MODE_READ_ONLY = "read-only"
MODE_WORKSPACE_WRITE = "workspace-write"
MODE_DANGER_FULL = "danger-full-access"
MODE_REFUSED = "refused"

#: 平台 → OS 原生加固种类的兜底标注。优先用 sandbox.describe_os_confinement()
#: 的探测结果（反映真实施加的隔离）；探测不可用时才落到这张静态表。
OS_CONFINEMENT_BY_PLATFORM = {
    "win32": "job_object",       # Windows Job Objects / restricted token
    "darwin": "seatbelt",        # macOS Seatbelt profile
    "linux": "landlock",         # Linux Landlock LSM
}
_CONFINEMENT_FALLBACK = "popen_confined"


def detect_os_confinement() -> str:
    """探测本机实际可用的隔离种类。绝不抛异常——审计字段不能成为故障点。"""
    try:
        from sandbox import describe_os_confinement
        return describe_os_confinement()
    except Exception:  # noqa: BLE001 — 声明失败退回平台查表，不撒谎也不炸
        return OS_CONFINEMENT_BY_PLATFORM.get(sys.platform, _CONFINEMENT_FALLBACK)


@dataclass
class ExecutionPlan:
    """一次执行的完整决定：模式、载体、理由与确认要求——全部可解释。"""
    mode: str                     # read-only | workspace-write | danger-full-access | refused
    provider: str                 # local | worktree
    reason: str                   # 为什么是这个决定（UI/审计直接引用）
    isolated: bool = False        # 是否与主工作区文件隔离（worktree 副本）
    requires_confirmation: bool = False
    os_confinement: str = "none"  # none|job_object|seatbelt|landlock|popen_confined
    meta: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # 声明性标注：除非调用方显式指定，否则按本机**实际可用**的隔离如实
        # 填写（sandbox.describe_os_confinement 探测），让每份审计记录携带的
        # 隔离等级与现实一致——探测失败才退回平台查表。
        if self.os_confinement == "none":
            self.os_confinement = detect_os_confinement()


def _normalize_risk(risk_level: str) -> str:
    risk = str(risk_level or "").upper()
    # 未知风险按最坏情况处理——这是安全缺省，不是方便缺省
    return risk if risk in RISK_LEVELS else "R4"


#: risk_control.RiskLevel.value → §7.4 风险等级。两个体系语义同构：
#: low=读(R1) · medium=改工作区(R2) · high=shell 等高危(R3) · critical=不可逆(R4)。
_LL_TO_R = {"low": "R1", "medium": "R2", "high": "R3", "critical": "R4"}


def risk_to_rlevel(risk_value: str) -> str:
    """把 risk_control 的 "low"/"medium"/"high"/"critical" 映射成 R0–R4。
    已是 R 等级的原样通过；未知值按最坏情况 R4——安全缺省，不是方便缺省。"""
    key = str(risk_value or "").strip()
    if key.upper() in RISK_LEVELS:
        return key.upper()
    return _LL_TO_R.get(key.lower(), "R4")


def select_execution(
    risk_level: str,
    *,
    worktree_available: bool = True,
    high_risk_confirmed: bool = False,
) -> ExecutionPlan:
    """按风险等级选执行模式。纯函数，便于测试与审计复核。"""
    risk = _normalize_risk(risk_level)

    if risk in ("R0", "R1"):
        return ExecutionPlan(
            MODE_READ_ONLY, "local",
            f"{risk} 只读或低危：直接在工作区执行，路径策略照常生效")

    if risk == "R2":
        if worktree_available:
            return ExecutionPlan(
                MODE_WORKSPACE_WRITE, "worktree",
                "R2 会改文件：优先在 worktree 副本里做，验证过再合并",
                isolated=True)
        return ExecutionPlan(
            MODE_WORKSPACE_WRITE, "local",
            "R2 且无可用 worktree：限定在选定 workspace 内执行，"
            "Git diff + validator + 回滚兜底")

    if risk == "R3":
        if worktree_available:
            return ExecutionPlan(
                MODE_WORKSPACE_WRITE, "worktree",
                "R3 高危改动：在隔离副本中执行，合并前必须人工确认",
                isolated=True, requires_confirmation=True)
        return ExecutionPlan(
            MODE_WORKSPACE_WRITE, "local",
            "R3 高危改动且无 worktree：限定 workspace 并强制人工确认",
            requires_confirmation=True)

    # R4：付款/发布/真实外发/改凭证/不可逆删除——必须人工确认，不存在自动档
    if high_risk_confirmed:
        return ExecutionPlan(
            MODE_DANGER_FULL, "local",
            "R4 已获显式人工确认：以 danger-full-access 执行并完整审计",
            requires_confirmation=True,
            meta={"audit": "danger-full-access"})
    return ExecutionPlan(
        MODE_REFUSED, "local",
        "R4 属高风险旁路：未经显式人工确认拒绝执行——没有 Docker 也不是放宽权限的理由",
        requires_confirmation=True,
        meta={"refused": True})
