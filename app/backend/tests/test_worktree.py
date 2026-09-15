"""Git worktree isolation for sub-agents."""
from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from work_copy import merge
from worktree import create, discard, repo_toplevel


def _git(cwd, *args):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True,
    )


@pytest.fixture
def git_workspace(tmp_path):
    if not shutil.which("git"):
        pytest.skip("git not on PATH")
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "README.md")
    _git(repo, "commit", "-m", "init")
    return repo


def test_repo_toplevel(git_workspace):
    assert os.path.normcase(repo_toplevel(str(git_workspace))) == os.path.normcase(
        str(git_workspace)
    )


def test_worktree_isolates_then_merges(git_workspace):
    parent = str(git_workspace)
    wt = create(parent, label="coder")
    assert wt is not None
    assert wt.kind == "worktree"
    assert os.path.isdir(wt.root)
    assert os.path.normcase(os.path.abspath(wt.root)) != os.path.normcase(
        os.path.abspath(parent)
    )

    target = os.path.join(wt.root, "from-child.txt")
    with open(target, "w", encoding="utf-8") as f:
        f.write("isolated\n")

    rows = wt.changes()
    assert any(r["rel"] == "from-child.txt" and r["kind"] == "write" for r in rows)
    assert not os.path.isfile(os.path.join(parent, "from-child.txt"))

    report = merge([wt])
    assert "from-child.txt" in report["applied"]
    assert (git_workspace / "from-child.txt").read_text(encoding="utf-8") == "isolated\n"

    discard(wt)
    assert not os.path.isdir(wt.wt_root)


def test_failed_create_on_non_repo(tmp_path, monkeypatch):
    # tmp_path 的位置随运行配置漂移（basetemp 可能被指到仓库内部，例如
    # "D:/Ovolve Agent/tmp_pytest_run"），"不是仓库"不能依赖目录恰好在仓库外。
    # GIT_CEILING_DIRECTORIES 让 git 的仓库发现在 tmp_path 之上止步：
    # git 只检查 tmp_path 自身（无 .git），向上即触顶失败——无论 tmp_path
    # 落在哪里，该目录对被测代码而言都"不是仓库"。
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path.parent))
    assert create(str(tmp_path), label="x") is None
