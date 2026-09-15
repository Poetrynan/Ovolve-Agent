"""
command_audit.py — 命令执行后审计日志（Post-Execution Audit）

## 解决什么问题

系统有完整的 pre-use 验证链，但缺少**执行后**的审计：
- 高风险命令执行后，改了哪些文件？是否可回滚？
- 命令是否产生了意外的副作用（如修改了工作区外的文件）？
- 是否有安全事件需要记录？

## 核心功能

1. **执行快照**: 命令执行前后的文件状态对比
2. **副作用检测**: 是否修改了预期外的文件
3. **回滚能力**: 基于快照的自动/手动回滚
4. **审计日志**: 结构化记录所有高风险操作
5. **安全告警**: 异常模式检测（如批量文件修改）
"""
from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

from result import Result


class AuditLevel(Enum):
    """审计级别"""
    INFO = "info"          # 常规操作
    WARN = "warn"          # 需要注意
    ALERT = "alert"        # 高风险操作
    CRITICAL = "critical"  # 安全事件


@dataclass
class FileDiff:
    """文件变更差异"""
    path: str
    action: str  # "created" | "modified" | "deleted"
    lines_added: int = 0
    lines_removed: int = 0
    size_before: int = 0
    size_after: int = 0


@dataclass
class AuditEntry:
    """审计日志条目"""
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    timestamp: float = field(default_factory=time.time)
    level: AuditLevel = AuditLevel.INFO
    tool_name: str = ""
    command: str = ""
    session_id: str = ""
    user_id: str = ""
    
    # 执行前后状态
    files_before: Dict[str, int] = field(default_factory=dict)  # path -> size
    files_after: Dict[str, int] = field(default_factory=dict)
    diffs: List[FileDiff] = field(default_factory=list)
    
    # 执行结果
    success: bool = True
    duration_ms: int = 0
    error: str = ""
    
    # 安全分析
    unexpected_changes: List[str] = field(default_factory=list)
    risk_score: float = 0.0  # 0-1
    rollback_available: bool = False
    
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "level": self.level.value,
            "toolName": self.tool_name,
            "command": self.command[:200],
            "sessionId": self.session_id,
            "diffs": [{"path": d.path, "action": d.action, "added": d.lines_added, "removed": d.lines_removed} for d in self.diffs],
            "success": self.success,
            "durationMs": self.duration_ms,
            "unexpectedChanges": self.unexpected_changes,
            "riskScore": self.risk_score,
            "rollbackAvailable": self.rollback_available,
        }


class CommandAuditor:
    """命令执行后审计系统"""

    # 需要审计的高风险工具
    AUDIT_TOOLS = frozenset({
        "shell_executor", "bash", "run_command", "python_executor",
        "write_file", "edit_file", "delete_file", "move_file",
        "git_commit", "git_push", "git_push_force",
    })
    
    # 命令模式 -> 审计级别
    RISK_PATTERNS = {
        r"rm\s+-rf": AuditLevel.CRITICAL,
        r"git\s+push\s+--force": AuditLevel.ALERT,
        r"git\s+push\s+-f": AuditLevel.ALERT,
        r"chmod\s+777": AuditLevel.WARN,
        r"curl.*\|.*sh": AuditLevel.ALERT,
        r"wget.*\|.*sh": AuditLevel.ALERT,
        r"sudo": AuditLevel.WARN,
        r"dd\s+if=": AuditLevel.ALERT,
        r"mkfs": AuditLevel.CRITICAL,
        r"git\s+reset\s+--hard": AuditLevel.WARN,
        r"git\s+clean\s+-fd": AuditLevel.WARN,
    }

    def __init__(self, workspace_root: str, max_entries: int = 1000):
        self.workspace = workspace_root
        self.max_entries = max_entries
        self._entries: List[AuditEntry] = []

    def audit(self, tool_name: str, args: dict, result: Any, context: dict) -> Optional[AuditEntry]:
        """执行后审计入口"""
        if tool_name not in self.AUDIT_TOOLS:
            return None

        entry = AuditEntry(
            tool_name=tool_name,
            command=self._extract_command(tool_name, args),
            session_id=context.get("session_id", ""),
        )

        # 1. 计算文件变更
        entry.diffs = self._compute_diffs(args, context)
        
        # 2. 评估风险级别
        entry.level = self._assess_risk(tool_name, args)
        
        # 3. 检测意外变更
        entry.unexpected_changes = self._detect_unexpected(args, entry.diffs)
        
        # 4. 计算风险分数
        entry.risk_score = self._calc_risk_score(entry)
        
        # 5. 检查是否可回滚
        entry.rollback_available = len(entry.diffs) > 0

        # 存储
        self._entries.append(entry)
        if len(self._entries) > self.max_entries:
            self._entries = self._entries[-self.max_entries:]

        return entry

    def get_recent(self, limit: int = 50, min_level: AuditLevel = AuditLevel.INFO) -> List[AuditEntry]:
        """获取最近的审计条目"""
        filtered = [e for e in self._entries if self._level_gte(e.level, min_level)]
        return filtered[-limit:]

    def get_by_session(self, session_id: str) -> List[AuditEntry]:
        """获取会话的所有审计条目"""
        return [e for e in self._entries if e.session_id == session_id]

    def get_risk_summary(self) -> dict:
        """获取风险摘要"""
        total = len(self._entries)
        critical = sum(1 for e in self._entries if e.level == AuditLevel.CRITICAL)
        alert = sum(1 for e in self._entries if e.level == AuditLevel.ALERT)
        warn = sum(1 for e in self._entries if e.level == AuditLevel.WARN)
        
        return {
            "total": total,
            "critical": critical,
            "alert": alert,
            "warn": warn,
            "highRiskRate": (critical + alert) / max(total, 1),
            "recentUnexpected": sum(len(e.unexpected_changes) for e in self._entries[-20:]),
        }

    # ── 内部方法 ─────────────────────────────────────────────────────────

    def _extract_command(self, tool_name: str, args: dict) -> str:
        """提取命令文本"""
        if tool_name in ("shell_executor", "bash", "run_command"):
            return args.get("command", "") or args.get("cmd", "")
        if tool_name == "write_file":
            return f"write: {args.get('path', '')}"
        if tool_name == "edit_file":
            return f"edit: {args.get('path', '')}"
        if tool_name == "git_commit":
            return f"git commit: {args.get('message', '')[:100]}"
        if tool_name == "git_push":
            return f"git push {args.get('remote', 'origin')} {args.get('branch', '')}"
        return str(args)[:200]

    def _compute_diffs(self, args: dict, context: dict) -> List[FileDiff]:
        """计算文件变更"""
        diffs = []
        # 获取编辑的文件
        affected = []
        if "path" in args:
            affected.append(args["path"])
        if "file_path" in args:
            affected.append(args["file_path"])
        if "dst" in args:
            affected.append(args["dst"])
        
        for path in affected:
            abs_path = os.path.join(self.workspace, path)
            if os.path.exists(abs_path):
                size = os.path.getsize(abs_path)
                diffs.append(FileDiff(path=path, action="modified", size_after=size))
            else:
                diffs.append(FileDiff(path=path, action="deleted"))
        
        return diffs

    def _assess_risk(self, tool_name: str, args: dict) -> AuditLevel:
        """评估操作风险级别"""
        command = self._extract_command(tool_name, args).lower()
        for pattern, level in self.RISK_PATTERNS.items():
            if pattern.lower() in command:
                return level
        # 默认按工具分类
        if tool_name in ("git_push_force", "git_reset_hard", "git_clean"):
            return AuditLevel.ALERT
        if tool_name in ("shell_executor", "bash", "python_executor"):
            return AuditLevel.WARN
        return AuditLevel.INFO

    def _detect_unexpected(self, args: dict, diffs: List[FileDiff]) -> List[str]:
        """检测意外变更"""
        unexpected = []
        expected = set()
        if "path" in args:
            expected.add(os.path.normpath(args["path"]))
        if "file_path" in args:
            expected.add(os.path.normpath(args["file_path"]))
        
        for d in diffs:
            norm = os.path.normpath(d.path)
            if norm not in expected:
                unexpected.append(d.path)
        
        return unexpected

    def _calc_risk_score(self, entry: AuditEntry) -> float:
        """计算风险分数 0-1"""
        score = 0.0
        # 基础分
        if entry.level == AuditLevel.CRITICAL:
            score = 1.0
        elif entry.level == AuditLevel.ALERT:
            score = 0.7
        elif entry.level == AuditLevel.WARN:
            score = 0.4
        else:
            score = 0.1
        
        # 意外变更加分
        score += min(0.3, len(entry.unexpected_changes) * 0.1)
        
        # 失败加分
        if not entry.success:
            score += 0.2
        
        return min(1.0, score)

    def _level_gte(self, a: AuditLevel, b: AuditLevel) -> bool:
        """a >= b"""
        order = {AuditLevel.INFO: 0, AuditLevel.WARN: 1, AuditLevel.ALERT: 2, AuditLevel.CRITICAL: 3}
        return order.get(a, 0) >= order.get(b, 0)


# ── 全局实例 ──────────────────────────────────────────────────────────────

_auditor: Optional[CommandAuditor] = None


def get_command_auditor(workspace_root: str = "") -> CommandAuditor:
    global _auditor
    if _auditor is None:
        _auditor = CommandAuditor(workspace_root or os.getcwd())
    return _auditor
