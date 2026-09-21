# -*- coding: utf-8 -*-
"""
worktree_manager.py — Git Worktree 物理隔离多代理调度管理器 (Phase 63 核心硬内化)。

1. 子代理在并发执行写操作时，绝对禁止直接在主工作区修改；
2. 自动通过 `git worktree add` 创建独立的临时工作区 (.worktrees/<branch_name>)；
3. 子代理在独立沙盒内执行与测试，100% 绿灯后安全 3-Way Merge 回主分支；
4. 若失败或被取消，通过 `git worktree remove` 物理销毁临时工作区，主目录一尘不染。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import logging
from typing import Optional

log = logging.getLogger(__name__)


class WorktreeManager:
    """生产级 Git Worktree 临时沙盒与生命周期管理器。"""

    @staticmethod
    def _run_git(args: list[str], cwd: str) -> tuple[int, str, str]:
        """执行底层 git 命令并捕获返回码与标准输出。"""
        try:
            res = subprocess.run(
                ["git"] + args,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                timeout=30
            )
            return res.returncode, res.stdout.strip(), res.stderr.strip()
        except Exception as exc:
            return -1, "", str(exc)

    @classmethod
    def is_git_repo(cls, root_dir: str) -> bool:
        """检查指定目录是否为合法的 Git 仓库。"""
        if not root_dir or not os.path.exists(root_dir):
            return False
        code, out, _ = cls._run_git(["rev-parse", "--is-inside-work-tree"], cwd=root_dir)
        return code == 0 and out == "true"

    @classmethod
    def create_isolated_worktree(
        cls,
        root_dir: str,
        branch_name: str,
        base_ref: str = "HEAD"
    ) -> tuple[bool, str, str]:
        """创建独立的物理临时 Git Worktree 工作区。
        
        Args:
            root_dir: 主项目根目录
            branch_name: 临时分支名 (如 subagent-auth-fix)
            base_ref: 基础分支/提交哈希
            
        Returns:
            (success: bool, worktree_path: str, message: str)
        """
        if not cls.is_git_repo(root_dir):
            return False, "", f"Target directory '{root_dir}' is not a valid Git repository."

        # 规范化工作区路径: <root_dir>/.worktrees/<branch_name>
        worktrees_base = os.path.join(root_dir, ".worktrees")
        os.makedirs(worktrees_base, exist_ok=True)
        worktree_path = os.path.join(worktrees_base, branch_name)

        if os.path.exists(worktree_path):
            # 已存在时尝试直接重用或清理
            cls._run_git(["worktree", "remove", "--force", worktree_path], cwd=root_dir)
            if os.path.exists(worktree_path):
                shutil.rmtree(worktree_path, ignore_errors=True)

        # 检查分支是否已存在
        code, _, _ = cls._run_git(["show-ref", "--verify", f"refs/heads/{branch_name}"], cwd=root_dir)
        if code == 0:
            # 分支已存在，直接挂载
            add_args = ["worktree", "add", worktree_path, branch_name]
        else:
            # 创建新分支并挂载
            add_args = ["worktree", "add", "-b", branch_name, worktree_path, base_ref]

        rc, stdout, stderr = cls._run_git(add_args, cwd=root_dir)
        if rc != 0:
            return False, "", f"Failed to create git worktree: {stderr or stdout}"

        log.info("[WorktreeManager] Created isolated worktree at %s (branch: %s)", worktree_path, branch_name)
        return True, worktree_path, f"Isolated worktree created at '{worktree_path}' on branch '{branch_name}'."

    @classmethod
    def cleanup_worktree(
        cls,
        root_dir: str,
        worktree_path: str,
        branch_name: str = "",
        delete_branch: bool = True
    ) -> tuple[bool, str]:
        """物理销毁临时工作区并清理分支。"""
        if not cls.is_git_repo(root_dir):
            return False, f"Not a git repo: {root_dir}"

        # 1. git worktree remove
        rc, stdout, stderr = cls._run_git(["worktree", "remove", "--force", worktree_path], cwd=root_dir)
        
        # 2. 物理兜底清理
        if os.path.exists(worktree_path):
            shutil.rmtree(worktree_path, ignore_errors=True)

        # 3. 运行 prune 清理工作区引用
        cls._run_git(["worktree", "prune"], cwd=root_dir)

        # 4. 删除临时分支
        if delete_branch and branch_name:
            cls._run_git(["branch", "-D", branch_name], cwd=root_dir)

        log.info("[WorktreeManager] Cleaned up worktree at %s", worktree_path)
        return True, f"Cleaned up worktree '{worktree_path}'."

    @classmethod
    def merge_worktree_branch(
        cls,
        root_dir: str,
        branch_name: str,
        target_branch: str = "main"
    ) -> tuple[bool, str]:
        """将子代理临时分支安全合并回目标主分支。"""
        if not cls.is_git_repo(root_dir):
            return False, f"Not a git repo: {root_dir}"

        # 确保在主工作区执行 merge
        rc, stdout, stderr = cls._run_git(
            ["merge", "--no-ff", branch_name, "-m", f"chore: merge subagent worktree branch '{branch_name}'"],
            cwd=root_dir
        )
        if rc != 0:
            # 冲突时自动回滚合并，杜绝脏状态
            cls._run_git(["merge", "--abort"], cwd=root_dir)
            return False, f"Merge conflict detected when merging '{branch_name}': {stderr or stdout}"

        return True, f"Successfully merged branch '{branch_name}' into target branch."

    @classmethod
    def list_active_worktrees(cls, root_dir: str) -> list[dict]:
        """列出当前仓库所有活跃的 Git Worktrees。"""
        if not cls.is_git_repo(root_dir):
            return []

        rc, stdout, _ = cls._run_git(["worktree", "list", "--porcelain"], cwd=root_dir)
        if rc != 0 or not stdout:
            return []

        worktrees = []
        current = {}
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                if current:
                    worktrees.append(current)
                    current = {}
                continue
            if line.startswith("worktree "):
                current["path"] = line.split(" ", 1)[1]
            elif line.startswith("HEAD "):
                current["head"] = line.split(" ", 1)[1]
            elif line.startswith("branch "):
                current["branch"] = line.split(" ", 1)[1].replace("refs/heads/", "")
            elif line == "bare":
                current["bare"] = True

        if current:
            worktrees.append(current)

        return worktrees
