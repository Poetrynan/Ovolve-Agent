"""skill_registry.py — agentskills.io 兼容的技能市场安装

支持：
- skills-lock.json 同步安装
- GitHub 仓库远程拉取（``owner/repo`` + skillPath）
- 开放标准合规校验（委托 skill_loader.check_open_standard_compliance）
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from result import Result
from skill_loader import TrustLevel

_GITHUB_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
_AGENTS_SKILLS_API = "https://agentskills.io"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _skills_dest() -> Path:
    dest = _repo_root() / ".agents" / "skills"
    dest.mkdir(parents=True, exist_ok=True)
    return dest


def load_lockfile(path: Optional[str] = None) -> dict:
    path = path or str(_repo_root() / "skills-lock.json")
    if not os.path.isfile(path):
        return {"version": 1, "skills": {}}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_lockfile(data: dict, path: Optional[str] = None) -> None:
    path = path or str(_repo_root() / "skills-lock.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _clone_github(source: str, dest_dir: str) -> Result:
    if not _GITHUB_RE.match(source):
        return Result.failure(f"invalid github source: {source}")
    url = f"https://github.com/{source}.git"
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", url, dest_dir],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return Result.success(dest_dir)
    except subprocess.TimeoutExpired:
        return Result.failure("git clone timed out")
    except subprocess.CalledProcessError as e:
        return Result.failure((e.stderr or e.stdout or str(e))[:500])


def install_from_lock_entry(name: str, entry: dict, loader) -> Result:
    """Install one skill described in skills-lock.json."""
    source = str(entry.get("source") or "")
    source_type = str(entry.get("sourceType") or "github")
    skill_path = str(entry.get("skillPath") or f"skills/{name}")
    if source_type != "github":
        return Result.failure(f"unsupported sourceType: {source_type}")
    with tempfile.TemporaryDirectory(prefix="ovolve-skill-") as tmp:
        cloned = _clone_github(source, os.path.join(tmp, "repo"))
        if not cloned.ok:
            return cloned
        src = os.path.join(tmp, "repo", skill_path.replace("/", os.sep))
        if os.path.isfile(src):
            src = os.path.dirname(src)
        if not os.path.isdir(src) or not os.path.isfile(os.path.join(src, "SKILL.md")):
            return Result.failure(f"SKILL.md not found at {skill_path} in {source}")
        dest = _skills_dest() / name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        return loader.import_skill(str(dest), TrustLevel.VERIFIED)


def install_from_github(source: str, skill_path: str, loader, name: Optional[str] = None) -> Result:
    """Install a skill directly from a GitHub repo path."""
    skill_name = name or Path(skill_path).parent.name or Path(skill_path).stem
    entry = {"source": source, "sourceType": "github", "skillPath": skill_path}
    result = install_from_lock_entry(skill_name, entry, loader)
    if result.ok:
        lock = load_lockfile()
        lock.setdefault("skills", {})[skill_name] = entry
        save_lockfile(lock)
    return result


def sync_lockfile(loader) -> Result:
    """Install all skills listed in skills-lock.json."""
    lock = load_lockfile()
    skills = lock.get("skills") or {}
    installed, errors = [], []
    for name, entry in skills.items():
        r = install_from_lock_entry(name, entry, loader)
        if r.ok:
            installed.append(name)
        else:
            errors.append(f"{name}: {r.error}")
    if errors and not installed:
        return Result.failure("; ".join(errors[:5]))
    return Result.success({"installed": installed, "errors": errors})


def agentskills_info() -> dict:
    return {
        "standard": "agentskills.io",
        "api": _AGENTS_SKILLS_API,
        "lockfile": str(_repo_root() / "skills-lock.json"),
    }
