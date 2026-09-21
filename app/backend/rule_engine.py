"""rule_engine.py — Ovolve Layer 1 记忆：用户可编辑的规则库

# 规则装配体系

系统将用户与工作区编写的规则文件作为 prompt 上下文的一部分，让模型理解自然语言安全与编码约定。

宪法文档里那个 ``_evaluate_condition`` 用子串匹配写"if 'tool' in condition"
根本不可用（连 "tool" 这个词在条件里都识别不了几种情况）。

所以：本文件不做"引擎"，做**规则装配器**。
  · 扫描 ``rules/`` 目录下所有 ``*.md``
  · 每个文件 YAML frontmatter 声明 ``priority`` / ``enabled`` / ``scope``
  · 按优先级组装成一大段规则文本，塞进 system prompt
  · 模型读到 "删除前必须确认"，它自己就会遵守

# 分层存储

  · **WORKSPACE 级**：``<workspace>/.ovolve/rules/*.md`` —— 项目特有
  · **USER 级**：``~/.ovolve/rules/*.md`` —— 全局用户偏好，跨项目生效

用户级填补了 MemoryScope 里长期缺失的 USER 作用域。

# 与既有 AGENTS.md 的关系

``memory_layer._update_agents_md`` 会把提取出的记忆写到项目根的 AGENTS.md。
那是**机器产出**的沉淀。这里 ``rules/*.md`` 是**用户手写**的规范。
两者不冲突：AGENTS.md 是"关于项目"，rules/ 是"关于我怎么工作"。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional


#: 优先级从高到低。CRITICAL 永远最先注入，不可被忽略语义盖过。
PRIORITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}


@dataclass
class Rule:
    """一条规则 —— 来自一个 .md 文件的解析结果。"""
    id: str                          # 稳定 id：``{scope}:{stem}``
    title: str                       # 从 ``# H1`` 或 frontmatter.name 取
    body: str                        # markdown 正文（去掉 frontmatter 后的部分）
    priority: str = "MEDIUM"
    enabled: bool = True
    scope: str = "workspace"         # "workspace" | "user"
    source_path: str = ""            # 让用户能一眼看到规则出处

    def priority_value(self) -> int:
        return PRIORITY_ORDER.get(self.priority.upper(), 4)


#: 简易 YAML frontmatter 解析器 —— 只支持 ``key: value`` 单行键值对。
#: 不引 PyYAML 是刻意的：一层规则文件不该拉一整个 YAML 库进来。
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_KV_RE = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$")


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """返回 ``(meta_dict, body_without_frontmatter)``。"""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    block = m.group(1)
    body = text[m.end():]
    meta: dict[str, str] = {}
    for line in block.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        kv = _KV_RE.match(line)
        if kv:
            key, value = kv.group(1), kv.group(2)
            # 去掉包围引号
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            meta[key.lower()] = value
    return meta, body


def _extract_title(body: str, fallback: str) -> str:
    """优先取第一个 ``# H1``，否则用文件名兜底。"""
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
        # 空行继续；有内容但不是标题就停 —— 避免把正文首行当标题。
        if stripped:
            break
    return fallback


def _truthy(v: Optional[str]) -> bool:
    """接受 true/yes/on/1，忽略大小写。默认真。"""
    if v is None:
        return True
    return v.strip().lower() in {"true", "yes", "on", "1"}


class RuleEngine:
    """扫描 rules/ 目录并把规则渲染成 system prompt 片段。

    Args:
        workspace_dir: 项目根目录。会读 ``<workspace>/.ovolve/rules/``。
        user_home: 用户主目录（默认 ``~``）。会读 ``<home>/.ovolve/rules/``。
    """

    #: WORKSPACE 规则默认放在项目根的这个相对路径下。
    WORKSPACE_SUBDIR = ".ovolve/rules"
    #: USER 全局规则的路径。
    USER_SUBDIR = ".ovolve/rules"

    def __init__(self, workspace_dir: Optional[str] = None, user_home: Optional[str] = None):
        self.workspace_dir = os.path.abspath(workspace_dir) if workspace_dir else None
        self.user_home = user_home or os.path.expanduser("~")

    # ── 加载 ─────────────────────────────────────────────────────────────

    def _dirs(self) -> list[tuple[Path, str]]:
        """返回 ``[(path, scope), ...]``。USER 优先扫，让 WORKSPACE 规则能压过它。"""
        out: list[tuple[Path, str]] = []
        user_dir = Path(self.user_home) / self.USER_SUBDIR
        if user_dir.is_dir():
            out.append((user_dir, "user"))
        if self.workspace_dir:
            ws_dir = Path(self.workspace_dir) / self.WORKSPACE_SUBDIR
            if ws_dir.is_dir():
                out.append((ws_dir, "workspace"))
        return out

    def load(self) -> list[Rule]:
        """扫描并返回启用的规则，按优先级排序。禁用规则会被过滤。"""
        rules: list[Rule] = []
        for dirpath, scope in self._dirs():
            for md in sorted(dirpath.glob("*.md")):
                try:
                    text = md.read_text(encoding="utf-8")
                except OSError:
                    continue
                meta, body = _parse_frontmatter(text)
                enabled = _truthy(meta.get("enabled"))
                if not enabled:
                    continue
                priority = (meta.get("priority") or "MEDIUM").upper()
                if priority not in PRIORITY_ORDER:
                    priority = "MEDIUM"
                title = meta.get("name") or _extract_title(body, md.stem)
                rules.append(Rule(
                    id=f"{scope}:{md.stem}",
                    title=title,
                    body=body.strip(),
                    priority=priority,
                    enabled=True,
                    scope=scope,
                    source_path=str(md),
                ))
        # 稳定排序：优先级 > 作用域 > id。同优先级下 workspace 排在 user 前，
        # 因为项目规则更贴近当下手头的事，模型看到得早。
        scope_key = {"workspace": 0, "user": 1}
        rules.sort(key=lambda r: (r.priority_value(), scope_key.get(r.scope, 9), r.id))
        return rules

    # ── 渲染 ─────────────────────────────────────────────────────────────

    def render_for_prompt(self, rules: Optional[Iterable[Rule]] = None) -> str:
        """把规则渲染成一段可直接拼进 system prompt 的文本。

        空规则集返回空串 —— 让上游能用 ``if block: ...`` 干净跳过。
        """
        rules = list(rules) if rules is not None else self.load()
        if not rules:
            return ""
        lines: list[str] = [
            "## 规则库（用户手写，必须遵守）",
            "",
            "以下规则来自项目 `.ovolve/rules/` 和用户全局 `~/.ovolve/rules/`，"
            "按优先级从高到低排列。CRITICAL 规则不可忽略。",
            "",
        ]
        for r in rules:
            badge = f"[{r.priority}]"
            scope_tag = "项目" if r.scope == "workspace" else "全局"
            lines.append(f"### {badge} {r.title}  <sub>{scope_tag} · {r.id}</sub>")
            lines.append("")
            if r.body:
                lines.append(r.body)
                lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    # ── 快照（给 UI 用）──────────────────────────────────────────────────

    def snapshot(self) -> dict:
        """把当前规则库序列化成 dict，方便 IPC / WS 传给前端。"""
        rules = self.load()
        return {
            "rules": [
                {
                    "id": r.id,
                    "title": r.title,
                    "priority": r.priority,
                    "scope": r.scope,
                    "sourcePath": r.source_path,
                    "excerpt": r.body[:200],
                }
                for r in rules
            ],
            "count": len(rules),
        }


_engine: Optional[RuleEngine] = None


def get_rule_engine(workspace_dir: Optional[str] = None) -> RuleEngine:
    """全局单例。第一次调用时确定 workspace_dir，之后 lazy 重载。"""
    global _engine
    if _engine is None:
        _engine = RuleEngine(workspace_dir=workspace_dir)
    elif workspace_dir and _engine.workspace_dir != os.path.abspath(workspace_dir):
        # 切换工作区时重建（避免旧 workspace 的规则残留）
        _engine = RuleEngine(workspace_dir=workspace_dir)
    return _engine
