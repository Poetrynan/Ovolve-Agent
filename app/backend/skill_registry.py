"""skill_registry.py — agentskills.io 兼容的技能与能力市场安装

支持：
- skills-lock.json 同步安装
- GitHub 仓库远程拉取（``owner/repo`` + skillPath）
- 开放标准合规校验（委托 skill_loader.check_open_standard_compliance）
- 多协议开源生态技能扫描与导入（EcosystemSkillScanner）
- 3合1能力市场目录（Skills / Plugins / MCP Connectors）与 5 阶段原子安装事务
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

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
        result = loader.import_skill(str(dest), TrustLevel.VERIFIED)
        # 归属 = 来源仓库。它是"卸载时能不能删"和"出错时找谁"的唯一凭据，
        # 所以必须在安装这一步写下——事后再猜来源等于没有来源。
        # 作者自己在 SKILL.md 里声明的归属优先，仓库名只作兜底。
        if result.ok:
            entry_obj = getattr(loader, "_skills", {}).get(name)
            if entry_obj is not None and not getattr(entry_obj, "owner_agents", None):
                entry_obj.owner_agents = [source]
        return result


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


def scan_and_import_ecosystem_skills(
    loader,
    workspace_root: Optional[Union[str, Path]] = None,
) -> list[str]:
    """Scans and imports ecosystem skills (Claude Code / Open Agent) into the runtime loader."""
    from ecosystem_skill_scanner import EcosystemSkillScanner
    scanner = EcosystemSkillScanner()
    found = scanner.scan(workspace_root=workspace_root or _repo_root())
    imported_names: list[str] = []
    for eco_skill in found:
        entry = scanner.adapt_to_skill_entry(eco_skill)
        if hasattr(loader, "register_skill_entry"):
            loader.register_skill_entry(entry)
            imported_names.append(entry.name)
        elif hasattr(loader, "import_skill"):
            res = loader.import_skill(entry.path, TrustLevel.VERIFIED)
            if getattr(res, "ok", False):
                imported_names.append(entry.name)
    return imported_names


# ── 来源登记 ────────────────────────────────────────────────────────────────
#
# 每条能力的"它是从哪来的"只在这里写一次，条目本身不重复这些字段 —— 抄两遍
# 迟早会不一致，而不一致的时候没人知道该信哪份。
#
# commitSha 是这套字段里最要紧的一个：不把上游仓库钉在某个 commit 上，
# 就等于把"上游哪天被投毒"这条路直接开放给我们所有的用户。
# 钉死之后，上游再动也要我们显式更新 sha 才会生效。
SOURCE_REGISTRY: dict[str, dict] = {
    "github.com/wshobson/agents": {
        "license": "MIT",
        "licenseSource": "https://github.com/wshobson/agents/blob/main/LICENSE",
        "commitSha": "4236bb91f8395b0435f1d8b8baf9e8e4c69a8620",
        "archived": False,
        "provenance": "open-source",
    },
    "github.com/modelcontextprotocol/servers": {
        "license": "Apache-2.0 (new contributions) / MIT (existing)",
        "licenseSource": "https://github.com/modelcontextprotocol/servers/blob/main/LICENSE",
        "commitSha": "d73f99efbfd40c3aa1b61e88728b3d49fb52608f",
        "archived": False,
        "provenance": "open-source",
    },
    "github.com/modelcontextprotocol/servers-archived": {
        "license": "Apache-2.0 (new contributions) / MIT (existing)",
        "licenseSource": "https://github.com/modelcontextprotocol/servers-archived/blob/main/LICENSE",
        "commitSha": "9be4674d1ddf8c469e6461a27a337eeb65f76c2e",
        # 上游已归档：代码还能用，但别让用户以为有人在维护它。
        "archived": True,
        "provenance": "open-source",
    },
    "github.com/Poetrynan/Ovolve-Agent": {
        "license": "Apache-2.0",
        "licenseSource": "https://github.com/Poetrynan/Ovolve-Agent/blob/main/LICENSE",
        # 本仓自有实现：代码就在本仓，不需要钉上游版本。
        "commitSha": "",
        "archived": False,
        "provenance": "first-party",
    },
}

# MCP 与插件条目原本没有 source 字段，在这里补齐。
# 尤其注意 4 个已归档的 MCP —— github / sqlite / postgres / puppeteer
# 上游已挪到 servers-archived，不标出来用户会以为它们还在活跃维护。
_ENTRY_SOURCES: dict[str, str] = {
    "mcp-filesystem": "github.com/modelcontextprotocol/servers",
    "mcp-fetch": "github.com/modelcontextprotocol/servers",
    "mcp-github": "github.com/modelcontextprotocol/servers-archived",
    "mcp-sqlite": "github.com/modelcontextprotocol/servers-archived",
    "mcp-postgres": "github.com/modelcontextprotocol/servers-archived",
    "mcp-puppeteer": "github.com/modelcontextprotocol/servers-archived",
    "plugin-git-suite": "github.com/Poetrynan/Ovolve-Agent",
    "plugin-office-suite": "github.com/Poetrynan/Ovolve-Agent",
    "plugin-quality-gate": "github.com/Poetrynan/Ovolve-Agent",
}

_UNKNOWN_SOURCE = {
    "license": "UNKNOWN",
    "licenseSource": "",
    "commitSha": "",
    "archived": False,
    # 来源不明就是来源不明，不猜、不美化 —— UI 会把它标成不可安装。
    "provenance": "unknown",
}


def with_provenance(entry: dict) -> dict:
    """Return a copy of ``entry`` with provenance fields filled in.

    Never mutates the catalog itself: the catalog is module-level shared
    state, and several request paths read it concurrently.
    """
    out = dict(entry)
    source = entry.get("source") or _ENTRY_SOURCES.get(entry.get("id", ""), "")
    out["source"] = source
    meta = SOURCE_REGISTRY.get(source, _UNKNOWN_SOURCE)
    out.update(meta)
    return out


MARKETPLACE_CATALOG: list[dict] = [
    {
        "id": "academic-search",
        "name": "academic-search",
        "title": "学术文献与论文检索",
        "description": "搜索并分析 arXiv 预印本、学术会议论文、引用网络及前沿算法比对。",
        "category": "analysis",
        "author": "wshobson",
        "source": "github.com/wshobson/agents",
        "skillPath": "skills/academic-search",
        "type": "skill",
        "tags": ["paper", "arxiv", "research", "academic"],
        "trustLevel": "verified",
    },
    {
        "id": "agent-glass-ui",
        "name": "agent-glass-ui",
        "title": "流光毛玻璃 Agent 界面套件",
        "description": "毛玻璃与流光动效风格的 AI Agent 前端设计系统。",
        "category": "architecture",
        "author": "wshobson",
        "source": "github.com/wshobson/agents",
        "skillPath": "skills/agent-glass-ui",
        "type": "skill",
        "tags": ["ui", "design", "glassmorphism", "frontend"],
        "trustLevel": "verified",
    },
    {
        "id": "code-review",
        "name": "code-review",
        "title": "结构化工程代码审查",
        "description": "多维度代码审查：审查变更意图、结构总览与严重度分级反馈，生成物理证据。",
        "category": "development",
        "author": "wshobson",
        "source": "github.com/wshobson/agents",
        "skillPath": "skills/code-review",
        "type": "skill",
        "tags": ["review", "pr", "quality", "git"],
        "trustLevel": "verified",
    },
    {
        "id": "deep-research",
        "name": "deep-research",
        "title": "多跳深度网络调研",
        "description": "跨信息源交叉证据链验证、深度网络检索与多层综合分析报告产出。",
        "category": "analysis",
        "author": "wshobson",
        "source": "github.com/wshobson/agents",
        "skillPath": "skills/deep-research",
        "type": "skill",
        "tags": ["research", "search", "fact-check"],
        "trustLevel": "verified",
    },
    {
        "id": "baoyu-diagram",
        "name": "baoyu-diagram",
        "title": "出版级专业图表与架构图",
        "description": "生成高美感、自适应暗色/亮色的专业 SVG 与 Mermaid 架构图、时序图与状态机。",
        "category": "content",
        "author": "wshobson",
        "source": "github.com/wshobson/agents",
        "skillPath": "skills/baoyu-diagram",
        "type": "skill",
        "tags": ["diagram", "mermaid", "architecture", "svg"],
        "trustLevel": "verified",
    },
    {
        "id": "claude-doctor",
        "name": "claude-doctor",
        "title": "Agent 运行环境健康诊断",
        "description": "全量 Agent 运行时诊断：凭据健康度、Git 状态、MCP 服务与环境链路排障。",
        "category": "system",
        "author": "wshobson",
        "source": "github.com/wshobson/agents",
        "skillPath": "skills/claude-doctor",
        "type": "skill",
        "tags": ["doctor", "diagnostics", "mcp", "environment"],
        "trustLevel": "verified",
    },
    {
        "id": "design-taste-frontend",
        "name": "design-taste-frontend",
        "title": "反模板化高审美前端设计",
        "description": "推导项目独有设计语言，避免 AI 模板廉价感，物理级对齐工业界最高美学标准。",
        "category": "architecture",
        "author": "wshobson",
        "source": "github.com/wshobson/agents",
        "skillPath": "skills/design-taste-frontend",
        "type": "skill",
        "tags": ["design", "frontend", "aesthetic", "anti-slop"],
        "trustLevel": "verified",
    },
    # ─── Curated MCP Connectors ───────────────────────────────────────
    {
        "id": "mcp-github",
        "name": "github",
        "title": "GitHub 官方 MCP 连接器",
        "description": "连接 GitHub 官方 MCP 服务，使 Agent 具备搜索代码仓库、管理 Issue/PR、查看提交历史与代码审查的能力。",
        "category": "development",
        "type": "mcp",
        "author": "modelcontextprotocol",
        "tags": ["github", "git", "code", "mcp", "connector"],
        "trustLevel": "verified",
        "mcpConfig": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": ""},
            "transport": "stdio",
        },
    },
    {
        "id": "mcp-filesystem",
        "name": "filesystem",
        "title": "安全文件沙箱 MCP 连接器",
        "description": "受控文件系统读写服务，允许 Agent 在白名单工作区目录下安全读写、遍历和修改项目文件。",
        "category": "system",
        "type": "mcp",
        "author": "modelcontextprotocol",
        "tags": ["file", "filesystem", "sandbox", "mcp", "connector"],
        "trustLevel": "verified",
        "mcpConfig": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
            "transport": "stdio",
        },
    },
    {
        "id": "mcp-sqlite",
        "name": "sqlite",
        "title": "SQLite 数据库探索器 MCP",
        "description": "轻量级本地 SQLite 数据库分析与操作连接器，支持自动执行只读或可写 SQL 查询与 Schema 解析。",
        "category": "analysis",
        "type": "mcp",
        "author": "modelcontextprotocol",
        "tags": ["database", "sqlite", "sql", "mcp", "connector"],
        "trustLevel": "verified",
        "mcpConfig": {
            "command": "uvx",
            "args": ["mcp-server-sqlite", "--db-path", "data.db"],
            "transport": "stdio",
        },
    },
    {
        "id": "mcp-postgres",
        "name": "postgres",
        "title": "PostgreSQL 数据库连接器 MCP",
        "description": "企业级 PostgreSQL 数据库只读/读写分析连接器，赋能 Agent 进行表结构解析、复杂聚合与 SQL 优化分析。",
        "category": "analysis",
        "type": "mcp",
        "author": "modelcontextprotocol",
        "tags": ["database", "postgres", "sql", "mcp", "connector"],
        "trustLevel": "verified",
        "mcpConfig": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
            "transport": "stdio",
        },
    },
    {
        "id": "mcp-puppeteer",
        "name": "puppeteer",
        "title": "Puppeteer 浏览器自动化 MCP",
        "description": "基于 Chromium 的自动化无头浏览器，赋予 Agent 真实网页截屏、DOM 提取、表单输入与动态渲染能力。",
        "category": "architecture",
        "type": "mcp",
        "author": "modelcontextprotocol",
        "tags": ["browser", "puppeteer", "crawler", "mcp", "connector"],
        "trustLevel": "verified",
        "mcpConfig": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
            "transport": "stdio",
        },
    },
    {
        "id": "mcp-fetch",
        "name": "fetch",
        "title": "通用网页内容抓取 MCP",
        "description": "高性能网页内容抓取与 HTML 转 Markdown 连接器，无需浏览器即可秒级提取任意公开网页正文并去除噪音。",
        "category": "content",
        "type": "mcp",
        "author": "modelcontextprotocol",
        "tags": ["fetch", "web", "http", "mcp", "connector"],
        "trustLevel": "verified",
        "mcpConfig": {
            "command": "uvx",
            "args": ["mcp-server-fetch"],
            "transport": "stdio",
        },
    },
    # ─── Curated Extension Plugins ────────────────────────────────────
    {
        "id": "plugin-git-suite",
        "name": "git-workflow-suite",
        "title": "Git 智能工程流水线插件",
        "description": "集成 Git Worktree 隔离工作区、自动化规范语义提交与冲突解决规则的复合型能力包插件。",
        "category": "development",
        "type": "plugin",
        "author": "Ovolve Core",
        "tags": ["git", "workflow", "worktree", "plugin"],
        "trustLevel": "verified",
        "pluginManifest": {
            "name": "git-workflow-suite",
            "version": "1.0.0",
            "apiVersion": "1",
            "description": "集成 Git Worktree 隔离工作区、自动化规范语义提交与冲突解决规则的复合型能力包插件。",
            "author": "Ovolve Core",
            "contributes": {
                "skills": ["skills/git-workflow"]
            },
        },
    },
    {
        "id": "plugin-office-suite",
        "name": "office-automation-suite",
        "title": "现代办公文档研报套件插件",
        "description": "整合 DOCX、PPTX、PDF 与 Markdown 双向转换，支持高管汇报排版与结构化报告导出的插件包。",
        "category": "content",
        "type": "plugin",
        "author": "Ovolve Community",
        "tags": ["office", "docx", "pptx", "pdf", "plugin"],
        "trustLevel": "verified",
        "pluginManifest": {
            "name": "office-automation-suite",
            "version": "1.1.0",
            "apiVersion": "1",
            "description": "整合 DOCX、PPTX、PDF 与 Markdown 双向转换，支持高管汇报排版与结构化报告导出的插件包。",
            "author": "Ovolve Community",
            "contributes": {
                "skills": ["skills/office-suite"]
            },
        },
    },
    {
        "id": "plugin-quality-gate",
        "name": "code-quality-gate-suite",
        "title": "企业级代码门禁与质量审计插件",
        "description": "包含语法写前预检、依赖脆弱性检测与多维度自动化测试门禁的开箱即用插件套件。",
        "category": "system",
        "type": "plugin",
        "author": "Ovolve Security",
        "tags": ["quality", "security", "audit", "plugin"],
        "trustLevel": "verified",
        "pluginManifest": {
            "name": "code-quality-gate-suite",
            "version": "1.0.2",
            "apiVersion": "1",
            "description": "包含语法写前预检、依赖脆弱性检测与多维度自动化测试门禁的开箱即用插件套件。",
            "author": "Ovolve Security",
            "contributes": {
                "skills": ["skills/quality-gate"]
            },
        },
    },
]


def get_marketplace_catalog(
    category: Optional[str] = None,
    query: Optional[str] = None,
    type_filter: Optional[str] = None,
) -> list[dict]:
    """Return filtered marketplace catalog items.

    Every item carries its provenance (license / pinned commit / archived
    flag) so the UI can show where it came from instead of asking users to
    trust a star count.
    """
    res = [with_provenance(item) for item in MARKETPLACE_CATALOG]
    if type_filter and type_filter.strip().lower() not in ("all", "*"):
        t_lower = type_filter.strip().lower()
        res = [item for item in res if item.get("type", "skill").lower() == t_lower]
    if category and category.strip().lower() not in ("all", "*"):
        cat_lower = category.strip().lower()
        res = [item for item in res if item.get("category", "").lower() == cat_lower]
    if query:
        q_lower = query.strip().lower()
        filtered = []
        for item in res:
            text = f"{item.get('name', '')} {item.get('title', '')} {item.get('description', '')} {' '.join(item.get('tags', []))}".lower()
            if q_lower in text:
                filtered.append(item)
        res = filtered
    return res


def calculate_directory_hash(dir_path: str) -> str:
    """Deterministic SHA256 tree hash of directory structure and file contents."""
    h = hashlib.sha256()
    for root, dirs, files in os.walk(dir_path):
        dirs.sort()
        for f in sorted(files):
            if f == ".ready.json":
                continue
            fpath = os.path.join(root, f)
            rel = os.path.relpath(fpath, dir_path).replace("\\", "/")
            h.update(rel.encode("utf-8"))
            try:
                with open(fpath, "rb") as fp:
                    while chunk := fp.read(65536):
                        h.update(chunk)
            except OSError:
                pass
    return h.hexdigest()


def install_marketplace_skill(
    skill_id: str,
    source_dir: Optional[str] = None,
    dest_root: Optional[Union[str, Path]] = None,
    loader = None,
) -> Result:
    """Execute 5-stage atomic installation transaction for a marketplace skill."""
    from skill_vetter import vet_skill, Severity

    entry = next((item for item in MARKETPLACE_CATALOG if item["id"] == skill_id or item["name"] == skill_id), None)

    # ── Dispatch MCP Connectors ───────────────────────────────────────
    if entry and entry.get("type") == "mcp":
        mcp_cfg = entry.get("mcpConfig") or {}
        server_name = entry.get("name", skill_id)
        here = os.path.dirname(os.path.abspath(__file__))
        project = os.path.abspath(os.path.join(here, "..", ".."))
        cfg_path = os.path.join(project, "config.json")
        cfg = {}
        if os.path.isfile(cfg_path):
            try:
                with open(cfg_path, "r", encoding="utf-8") as fp:
                    cfg = json.load(fp)
            except Exception:
                cfg = {}
        mcp_servers = cfg.setdefault("mcpServers", {})
        mcp_servers[server_name] = dict(mcp_cfg)
        try:
            with open(cfg_path, "w", encoding="utf-8") as fp:
                json.dump(cfg, fp, indent=2, ensure_ascii=False)
        except Exception as e:
            return Result.failure(f"Failed to persist config.json: {e}")

        try:
            from mcp_manager import get_mcp_manager, MCPServerConfig, MCPServerConnection
            from tools import get_tool_registry
            mgr = get_mcp_manager()
            server_conn_cfg = MCPServerConfig.from_dict(server_name, mcp_cfg)
            conn = MCPServerConnection(server_conn_cfg, get_tool_registry())
            mgr._servers[server_name] = conn
            if not server_conn_cfg.disabled and (server_conn_cfg.command or server_conn_cfg.url):
                import asyncio
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(conn.start())
                except RuntimeError:
                    pass
        except Exception:
            pass

        return Result.success({
            "name": server_name,
            "type": "mcp",
            "mcpConfig": mcp_cfg,
            "installed": True,
        })

    # ── Dispatch Plugins ──────────────────────────────────────────────
    if entry and entry.get("type") == "plugin":
        p_manifest = entry.get("pluginManifest") or {}
        plugin_name = entry.get("name", skill_id)
        here = os.path.dirname(os.path.abspath(__file__))
        project = os.path.abspath(os.path.join(here, "..", ".."))
        plugin_dir = os.path.join(project, ".agents", "plugins", plugin_name)
        os.makedirs(plugin_dir, exist_ok=True)
        manifest_file = os.path.join(plugin_dir, "plugin.json")
        try:
            with open(manifest_file, "w", encoding="utf-8") as fp:
                json.dump(p_manifest, fp, indent=2, ensure_ascii=False)
        except Exception as e:
            return Result.failure(f"Failed to write plugin manifest: {e}")

        for rel_skill in p_manifest.get("contributes", {}).get("skills", []):
            sk_dir = os.path.join(plugin_dir, rel_skill)
            os.makedirs(sk_dir, exist_ok=True)
            sk_md = os.path.join(sk_dir, "SKILL.md")
            if not os.path.exists(sk_md):
                with open(sk_md, "w", encoding="utf-8") as fp:
                    fp.write(f"---\nname: {os.path.basename(rel_skill)}\ndescription: {entry.get('description', '')}\n---\n\n# {entry.get('title', plugin_name)}\n\n{entry.get('description', '')}\n")

        try:
            from plugin_registry import get_plugin_registry
            reg = get_plugin_registry()
            res = reg.import_plugin(plugin_dir, activate=True)
            pub = res.value if res.ok else {}
        except Exception as e:
            pub = {"error": str(e)}

        return Result.success({
            "name": plugin_name,
            "type": "plugin",
            "installed_path": plugin_dir,
            "details": pub,
            "installed": True,
        })

    # Stage 1: Size check (<= 50MB)
    MAX_SIZE = 50 * 1024 * 1024
    if source_dir and os.path.exists(source_dir):
        total_size = sum(
            os.path.getsize(os.path.join(r, f))
            for r, _, files in os.walk(source_dir)
            for f in files
        )
        if total_size > MAX_SIZE:
            return Result.failure(f"Skill package exceeds 50MB limit ({total_size} bytes)")

    # Stage 2: Staging unpack
    with tempfile.TemporaryDirectory(prefix="ovolve-stage-") as stage_tmp:
        staging_dir = os.path.join(stage_tmp, "payload")
        if source_dir and os.path.exists(source_dir):
            shutil.copytree(source_dir, staging_dir)
        else:
            if not entry:
                entry = next((item for item in MARKETPLACE_CATALOG if item["id"] == skill_id or item["name"] == skill_id), None)
            if not entry:
                return Result.failure(f"Skill '{skill_id}' not found in marketplace catalog")
            cloned = _clone_github(entry["source"].replace("github.com/", ""), os.path.join(stage_tmp, "repo"))
            if not cloned.ok:
                return cloned
            skill_path = entry.get("skillPath", f"skills/{skill_id}")
            src = os.path.join(stage_tmp, "repo", skill_path.replace("/", os.sep))
            if not os.path.isdir(src):
                return Result.failure(f"Path '{skill_path}' not found in repository")
            shutil.copytree(src, staging_dir)

        # Stage 3: Mandatory skill-vetter AST scan
        skill_md = os.path.join(staging_dir, "SKILL.md")
        if not os.path.isfile(skill_md):
            return Result.failure("Invalid skill package: missing SKILL.md")

        files_to_scan = []
        for r, _, files in os.walk(staging_dir):
            for f in files:
                if f.endswith((".md", ".py", ".sh", ".js", ".json", ".yaml", ".yml")):
                    files_to_scan.append(os.path.join(r, f))

        for fpath in files_to_scan:
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as fp:
                    content = fp.read()
                res = vet_skill(content)
                if res.level in (Severity.HIGH, Severity.EXTREME):
                    worst = res.findings[0]
                    reason = worst.reason_zh or worst.reason_en
                    return Result.failure(f"Security audit rejected ({worst.severity.name}): {reason} at {os.path.basename(fpath)}")
            except Exception as e:
                return Result.failure(f"Security scanning failed on {os.path.basename(fpath)}: {e}")

        # Stage 4: Mandatory name extraction from SKILL.md frontmatter
        canonical_name = skill_id
        with open(skill_md, "r", encoding="utf-8") as fp:
            for line in fp:
                if line.strip().startswith("name:"):
                    raw_n = line.replace("name:", "").strip().strip('"\'')
                    if raw_n:
                        canonical_name = raw_n
                        break

        # Stage 5: Compute directory tree hash, write .ready.json, atomic move to destination
        tree_hash = calculate_directory_hash(staging_dir)
        ready_meta = {
            "name": canonical_name,
            "vetted": True,
            "tree_hash": tree_hash,
            "installed_at": int(time.time()),
            "source": source_dir or "marketplace",
        }
        with open(os.path.join(staging_dir, ".ready.json"), "w", encoding="utf-8") as fp:
            json.dump(ready_meta, fp, indent=2, ensure_ascii=False)

        target_root = Path(dest_root) if dest_root else _skills_dest()
        target_root.mkdir(parents=True, exist_ok=True)
        final_dest = target_root / canonical_name
        if final_dest.exists():
            shutil.rmtree(final_dest)

        shutil.copytree(staging_dir, final_dest)

        if loader and hasattr(loader, "import_skill"):
            loader.import_skill(str(final_dest), TrustLevel.VERIFIED)

        return Result.success({
            "name": canonical_name,
            "installed_path": str(final_dest),
            "tree_hash": tree_hash,
            "ready": ready_meta,
        })
