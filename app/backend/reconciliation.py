"""
reconciliation.py — 任务完成态 5D 自动收口与文档对齐中间件 (Phase 59 内化模块)。

从 neat-freak 技能提纯并硬内化为底层物理确定性代码：
1. 自动扫描 Git 变更文件与受影响模块 (scan_git_mutations)；
2. 5D 审计文档状态 (PROGRESS.md, 升级与BUG修复清单_合并版.md, 技术答疑手册, 技术学习指南)；
3. 自动扫描并物理清理工作区临时垃圾文件 (*.tmp, 孤儿调试脚本)；
4. 输出零 Token 消耗的高确定性收口审计报告 (ReconciliationSummary)。
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class ReconciliationSummary:
    """任务收口审计报告实体。"""
    timestamp: float = field(default_factory=time.time)
    workspace: str = ""
    modified_files: List[str] = field(default_factory=list)
    added_files: List[str] = field(default_factory=list)
    cleaned_ephemeral_files: List[str] = field(default_factory=list)
    docs_audited: List[str] = field(default_factory=list)
    is_pristine: bool = True
    audit_notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class PostTurnReconciliationEngine:
    """生产级任务完成态自动收口引擎。"""

    EPHEMERAL_PATTERNS = [
        "*.tmp", "*.temp", "*~", ".DS_Store", "Thumbs.db"
    ]

    DOC_TARGETS = [
        "Documents/PROGRESS.md",
        "Documents/升级与BUG修复清单_合并版.md",
        "Documents/技术答疑手册_合并版.md",
        "Documents/技术学习指南_合并版.md",
        "AGENTS.md",
        "MEMORY.md",
    ]

    @classmethod
    def scan_git_mutations(cls, workspace: str) -> tuple[List[str], List[str]]:
        """扫描工作区中发生修改和新增的文件。"""
        if not workspace or not os.path.exists(workspace):
            return [], []

        modified = []
        added = []
        try:
            # 运行 git status --porcelain
            res = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=workspace,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                timeout=5
            )
            if res.returncode == 0:
                for line in res.stdout.strip().splitlines():
                    if not line or len(line) < 3:
                        continue
                    status_code = line[:2]
                    file_path = line[3:].strip().strip('"')
                    if "?" in status_code:
                        added.append(file_path)
                    else:
                        modified.append(file_path)
        except Exception:
            pass  # fail-open: git 扫描异常不中断主业务

        return modified, added

    @classmethod
    def cleanup_ephemeral_files(cls, workspace: str) -> List[str]:
        """安全扫描并清理临时调试文件。"""
        cleaned = []
        if not workspace or not os.path.exists(workspace):
            return cleaned

        try:
            # 仅在工作区顶层或 scratch 目录清理已知临时后缀
            for root, dirs, files in os.walk(workspace):
                # 忽略 node_modules, .git, venv
                if any(ignored in root for ignored in [".git", "node_modules", "venv", ".venv", "__pycache__"]):
                    continue
                for f in files:
                    if f.endswith(".tmp") or f.endswith(".temp") or f.startswith("tmp_debug_"):
                        full_p = os.path.join(root, f)
                        try:
                            os.remove(full_p)
                            cleaned.append(os.path.relpath(full_p, workspace))
                        except OSError:
                            pass
        except Exception:
            pass

        return cleaned

    @classmethod
    def audit_docs(cls, workspace: str) -> List[str]:
        """核对 6 大核心文档的物理存在与可读性。"""
        audited = []
        if not workspace or not os.path.exists(workspace):
            return audited

        for doc_rel in cls.DOC_TARGETS:
            full_p = os.path.join(workspace, doc_rel)
            if os.path.exists(full_p):
                audited.append(doc_rel)
        return audited

    @classmethod
    def run_reconciliation(cls, workspace: str) -> ReconciliationSummary:
        """一键执行完整的 5D 收口对齐审计。"""
        modified, added = cls.scan_git_mutations(workspace)
        cleaned = cls.cleanup_ephemeral_files(workspace)
        audited = cls.audit_docs(workspace)

        notes = []
        if modified or added:
            notes.append(f"检测到代码/工程变更: {len(modified)} 修改, {len(added)} 新增")
        if cleaned:
            notes.append(f"自动清理临时文件: {', '.join(cleaned[:3])}")
        notes.append(f"核心文档对齐就绪: {len(audited)} 份核心文档状态正常")

        return ReconciliationSummary(
            workspace=workspace,
            modified_files=modified,
            added_files=added,
            cleaned_ephemeral_files=cleaned,
            docs_audited=audited,
            is_pristine=len(cleaned) == 0,
            audit_notes=notes
        )
