# -*- coding: utf-8 -*-
"""
test_worktree_manager.py — 单元测试：Git Worktree 物理隔离多代理调度 (Phase 63)。
"""
import os
import subprocess
import tempfile
import pytest
from worktree_manager import WorktreeManager


def _run(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, check=True)


def test_worktree_lifecycle_and_isolation():
    with tempfile.TemporaryDirectory() as tmp_dir:
        repo_dir = os.path.join(tmp_dir, "test_repo")
        os.makedirs(repo_dir, exist_ok=True)

        # 1. 初始化临时 Git 仓库
        _run(["git", "init", "-b", "main"], cwd=repo_dir)
        _run(["git", "config", "user.name", "TestUser"], cwd=repo_dir)
        _run(["git", "config", "user.email", "test@example.com"], cwd=repo_dir)

        # 创建初始文件与 commit
        main_file = os.path.join(repo_dir, "main.txt")
        with open(main_file, "w", encoding="utf-8") as f:
            f.write("Initial main content\n")
        _run(["git", "add", "main.txt"], cwd=repo_dir)
        _run(["git", "commit", "-m", "Initial commit"], cwd=repo_dir)

        # 2. 验证 is_git_repo
        assert WorktreeManager.is_git_repo(repo_dir) is True

        # 3. 创建隔离 Worktree
        branch_name = "subagent-feature-branch"
        ok, wt_path, msg = WorktreeManager.create_isolated_worktree(repo_dir, branch_name)
        assert ok is True
        assert os.path.exists(wt_path)

        # 4. 列出活跃 Worktrees
        wts = WorktreeManager.list_active_worktrees(repo_dir)
        assert len(wts) >= 2

        # 5. 在隔离工作区修改文件，验证主工作区不受影响 (物理隔离验证)
        wt_file = os.path.join(wt_path, "feature.txt")
        with open(wt_file, "w", encoding="utf-8") as f:
            f.write("Feature built in isolation\n")

        # 主目录里应该不存在 feature.txt
        assert not os.path.exists(os.path.join(repo_dir, "feature.txt"))

        # 6. 在 worktree 中提交
        _run(["git", "add", "feature.txt"], cwd=wt_path)
        _run(["git", "commit", "-m", "Add feature in worktree"], cwd=wt_path)

        # 7. 合并回主分支
        merge_ok, merge_msg = WorktreeManager.merge_worktree_branch(repo_dir, branch_name, target_branch="main")
        assert merge_ok is True
        # 合并后主目录出现 feature.txt
        assert os.path.exists(os.path.join(repo_dir, "feature.txt"))

        # 8. 清理 Worktree
        clean_ok, clean_msg = WorktreeManager.cleanup_worktree(repo_dir, wt_path, branch_name=branch_name)
        assert clean_ok is True
        assert not os.path.exists(wt_path)
