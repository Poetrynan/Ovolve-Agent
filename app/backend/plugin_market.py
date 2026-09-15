"""
plugin_market.py - GitHub-as-Registry 插件安装客户端.

从 GitHub 仓库安装插件的一键安装器。设计要点：

1. GitHub-as-Registry：不建市场服务器，官方索引仓库只存 manifest 摘要，
   install = git clone + hash 校验 + 复制到插件根目录。
   和 skills-lock.json 里已有的 "source": "owner/repo" 完全同构。
2. 安全不降级：安装完的插件走 PluginRegistry 既有信任分级（默认 untrusted），
   权限声明原样保留——市场分发不等于信任提升。
3. 失败可恢复：hash 不匹配即拒绝安装；版本冲突时保留本地修改并提示。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Any, Optional

from result import Result
from plugin_registry import get_plugin_registry, MANIFEST_NAME, HOST_PLUGIN_API_VERSION

DEFAULT_INDEX_REPO = "ovolve-agent/plugins"          # 官方索引仓库
USER_PLUGIN_ROOT = os.path.expanduser(os.path.join("~", ".agents", "plugins"))
REGISTRY_TIMEOUT = 120                                # git 操作超时（秒）


@dataclass
class MarketEntry:
    """索引仓库里的一个插件条目（即远程 manifest 的摘要）。"""
    name: str
    repo: str            # "owner/repo"
    subpath: str         # 仓库内插件目录
    description: str
    api_version: str
    trust: str
    version: str
    content_hash: str    # 上游 plugin.json 的 sha256，防篡改
    downloads: int = 0   # 热度（由索引 CI 维护）

    @classmethod
    def from_dict(cls, d: dict) -> "MarketEntry | None":
        if not isinstance(d, dict):
            return None
        name = str(d.get("name") or "").strip()
        repo = str(d.get("repo") or "").strip()
        if not name or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            return None
        return cls(
            name=name,
            repo=repo,
            subpath=str(d.get("path") or "").strip("/"),
            description=str(d.get("description") or ""),
            api_version=str(d.get("apiVersion") or "1"),
            trust=str(d.get("trust") or "untrusted"),
            version=str(d.get("version") or "0.0.0"),
            content_hash=str(d.get("contentHash") or ""),
            downloads=int(d.get("downloads") or 0),
        )


def _gh_url(repo: str) -> str:
    """owner/repo → 可克隆 URL。优先 https，私有仓库用户可自行换 ssh。"""
    if repo.startswith(("http://", "https://", "git@")):
        return repo
    return f"https://github.com/{repo}.git"


def _safe_subpath(subpath: str) -> Optional[str]:
    """校验 subpath 不含路径遍历。返回清洗后的 subpath，不安全时返回 None。"""
    if not subpath:
        return ""
    # 拒绝绝对路径和路径遍历碎片
    if subpath.startswith("/") or subpath.startswith("\\"):
        return None
    if ".." in subpath.split("/"):
        return None
    # 只允许安全字符：字母、数字、连字符、下划线、斜杠
    if not re.fullmatch(r"[\w\-/]+", subpath):
        return None
    return subpath.strip("/")


def _fetch_index(repo: str = DEFAULT_INDEX_REPO) -> Result:
    """拉取官方索引仓库的 registry.json。"""
    url = _gh_url(repo)
    try:
        with tempfile.TemporaryDirectory(prefix="ovolve-market-") as tmp:
            r = subprocess.run(
                ["git", "clone", "--depth", "1", "--filter=blob:none", url, tmp],
                capture_output=True, text=True, timeout=REGISTRY_TIMEOUT,
            )
            if r.returncode != 0:
                return Result.failure(f"clone index failed: {r.stderr.strip()[:200]}")
            idx_path = os.path.join(tmp, "registry.json")
            if not os.path.isfile(idx_path):
                return Result.failure(f"{repo} 不是索引仓库（缺 registry.json）")
            with open(idx_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict) or not isinstance(data.get("plugins"), list):
                return Result.failure("registry.json 格式错误（应为 {plugins: [...]}）")
            return Result.success(data)
    except subprocess.TimeoutExpired:
        return Result.failure(f"clone index timed out after {REGISTRY_TIMEOUT}s")
    except json.JSONDecodeError as exc:
        return Result.failure(f"registry.json invalid: {exc}")
    except OSError as exc:
        return Result.failure(f"io error: {exc}")


def search(keyword: str = "", repo: str = DEFAULT_INDEX_REPO, limit: int = 30) -> Result:
    """搜索插件市场。返回 Result(list[dict])。"""
    idx = _fetch_index(repo)
    if not idx.ok:
        return idx
    kw = keyword.lower().strip()
    entries = []
    for raw in idx.value["plugins"]:
        e = MarketEntry.from_dict(raw)
        if e is None:
            continue
        if kw and kw not in e.name.lower() and kw not in e.description.lower():
            continue
        entries.append({
            "name": e.name, "repo": e.repo, "path": e.subpath,
            "description": e.description, "version": e.version,
            "trust": e.trust, "downloads": e.downloads,
        })
    entries.sort(key=lambda x: -x["downloads"])
    return Result.success(entries[:limit])


def install(source: str, *, repo: str = DEFAULT_INDEX_REPO, force: bool = False) -> Result:
    """一键安装插件。

    source 支持：
      - "web-search"                → 从官方索引按名字查找
      - "owner/repo"                → 直接装仓库根目录
      - "owner/repo@path/subdir"    → 装仓库内的子目录
      - "https://github.com/..."    → 任意 git URL
    """
    # ── 1. 解析来源 → (repo_url, subpath) ──
    if "@" in source and not source.startswith("http"):
        repo_part, subpath = source.split("@", 1)
        subpath = _safe_subpath(subpath)
        if subpath is None:
            return Result.failure(f"illegal subpath in source {source!r}")
    else:
        repo_part, subpath = source, ""

    expected_hash: Optional[str] = None
    if source.startswith("http") or re.fullmatch(r"[\w.-]+/[\w.-]+", source):
        clone_url = _gh_url(repo_part)
    else:
        # 按名字从索引查
        found = search(source, repo=repo, limit=5)
        if not found.ok:
            return found
        hits = [e for e in found.value if e["name"] == source] or found.value
        if not hits:
            return Result.failure(f"market: no plugin named {source!r}")
        h = hits[0]
        clone_url = _gh_url(h["repo"])
        subpath = h["path"]
        # 索引条目携带了 contentHash 时，安装后必须校验——防上游 manifest 被篡改
        expected_hash = str(h.get("contentHash") or "").strip() or None

    # ── 2. clone（浅克隆 + 子路径稀疏检出） ──
    try:
        with tempfile.TemporaryDirectory(prefix="ovolve-install-") as tmp:
            r = subprocess.run(
                ["git", "clone", "--depth", "1", "--filter=blob:none",
                 "--sparse", clone_url, tmp],
                capture_output=True, text=True, timeout=REGISTRY_TIMEOUT,
            )
            if r.returncode != 0:
                return Result.failure(f"clone failed: {r.stderr.strip()[:200]}")
            if subpath:
                r2 = subprocess.run(
                    ["git", "sparse-checkout", "set", subpath],
                    cwd=tmp, capture_output=True, text=True, timeout=60,
                )
                if r2.returncode != 0:
                    return Result.failure(f"sparse checkout failed: {r2.stderr.strip()[:200]}")
            plugin_dir = os.path.join(tmp, subpath) if subpath else tmp
            manifest_path = os.path.join(plugin_dir, MANIFEST_NAME)
            if not os.path.isfile(manifest_path):
                return Result.failure(f"{MANIFEST_NAME} not found in {clone_url}/{subpath}")
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            name = str(manifest.get("name") or "").strip()
            if not name:
                return Result.failure("manifest missing 'name'")
            # API 兼容门控：版本不匹配在这里就拒绝，避免把不兼容的文件
            # 复制到插件根目录后才发现加载不了。
            min_host = manifest.get("minHostApiVersion")
            try:
                min_host_v = int(str(min_host).strip())
            except (TypeError, ValueError):
                min_host_v = 0
            if min_host_v > HOST_PLUGIN_API_VERSION:
                return Result.failure(
                    f"plugin {name!r} requires host API >= {min_host_v}, "
                    f"but this host implements API {HOST_PLUGIN_API_VERSION}")

            # ── 3. hash 校验（有索引条目时才校验，直装任意仓库跳过） ──
            content = open(manifest_path, "rb").read()
            sha = hashlib.sha256(content).hexdigest()
            if expected_hash and sha != expected_hash:
                return Result.failure(
                    f"hash mismatch for {name!r}: expected {expected_hash[:12]}..., "
                    f"got {sha[:12]}... — manifest may have been tampered with")

            # ── 4. 目标位置冲突处理 ──
            dest = os.path.join(USER_PLUGIN_ROOT, name)
            if os.path.exists(dest) and not force:
                return Result.failure(
                    f"plugin {name!r} already installed at {dest} (use force=True to overwrite)")
            if os.path.exists(dest):
                shutil.rmtree(dest)

            # ── 5. 复制（排除 .git） ──
            os.makedirs(USER_PLUGIN_ROOT, exist_ok=True)
            shutil.copytree(plugin_dir, dest,
                            ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))

    except subprocess.TimeoutExpired:
        return Result.failure(f"git operation timed out after {REGISTRY_TIMEOUT}s")
    except (OSError, json.JSONDecodeError) as exc:
        return Result.failure(f"install failed: {exc}")

    # ── 6. 走既有 PluginRegistry 注册（信任=untrusted，权限原样） ──
    reg = get_plugin_registry()
    imported = reg.import_plugin(dest, activate=False)   # 默认不激活，由用户审权限后开启
    if not imported.ok:
        return imported
    return Result.success({
        "name": name,
        "dest": dest,
        "sha256": sha,
        "trust": manifest.get("trust", "untrusted"),
        "activated": False,
        "note": "installed as untrusted & inactive — review permissions, then enable",
    })


def uninstall(name: str) -> Result:
    """卸载插件（同时清掉注册表条目）。"""
    reg = get_plugin_registry()
    removed = reg.remove(name)
    dest = os.path.join(USER_PLUGIN_ROOT, name)
    if os.path.isdir(dest):
        shutil.rmtree(dest, ignore_errors=True)
    return removed if removed.ok else Result.success({"name": name, "removed": True})


def installed() -> list:
    """已安装插件列表。"""
    return get_plugin_registry().list_plugins()
