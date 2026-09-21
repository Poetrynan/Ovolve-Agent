"""
goal_brief.py - Structured Goal Brief contract + category derivation (D1).

Every goal entering the system MUST carry a GoalBrief that the router/scheduler
can inspect without parsing free-text prompts. This is the canonical shape for
"what should be done", distinct from the GoalManager lifecycle state machine
("is it done yet").

GoalBrief fields:
  summary           One-sentence plain language description (max 140 chars).
  assumptions       What the agent may take as given without asking.
  deliverables      Concrete outputs (file written, test passed, API called).
  acceptanceCriteria  Boolean predicates that define "done".
  verificationPlan  How to confirm acceptance criteria after execution.
  outOfScope        Boundaries: what the goal must NOT do.
  designStyle       Optional aesthetic / architectural preference string.

Category derivation:
  Rather than asking the user "what kind of task is this?", the router infers a
  ``GoalCategory`` from structural cues (tools needed, keywords, deliverable
  shape). The category gates which agent role gets the goal, which cost cap
  applies, and what the default max_iterations is.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class GoalCategory(str, Enum):
    """Derived goal taxonomy — each maps to a default agent profile + cost cap."""

    CODE = "code"               # writing / editing / reviewing source code
    RESEARCH = "research"       # web search, reading docs, comparing options
    FILE_OPS = "file-ops"       # bulk rename, move, compress, convert
    SYSTEM = "system"           # shell commands, process management, install
    BROWSER = "browser"         # navigation, scraping, form fill
    CREATIVE = "creative"       # writing prose, generating images
    GOAL_MGMT = "goal-mgmt"    # meta: managing other goals, planning
    UNKNOWN = "unknown"         # fallback when no signal matches


#: Default constraints per category. ``max_iter`` is the continuation cap;
#: ``cost_cap_micros`` is the hard spend limit (1 micro = $0.000001).
CATEGORY_DEFAULTS: dict[GoalCategory, dict] = {
    GoalCategory.CODE: {"max_iter": 15, "cost_cap_micros": 500_000, "agent": "file_agent"},
    GoalCategory.RESEARCH: {"max_iter": 8, "cost_cap_micros": 200_000, "agent": "search_agent"},
    GoalCategory.FILE_OPS: {"max_iter": 10, "cost_cap_micros": 100_000, "agent": "file_agent"},
    GoalCategory.SYSTEM: {"max_iter": 5, "cost_cap_micros": 150_000, "agent": "computer_agent"},
    GoalCategory.BROWSER: {"max_iter": 10, "cost_cap_micros": 300_000, "agent": "browser_agent"},
    GoalCategory.CREATIVE: {"max_iter": 6, "cost_cap_micros": 400_000, "agent": None},
    GoalCategory.GOAL_MGMT: {"max_iter": 3, "cost_cap_micros": 50_000, "agent": None},
    GoalCategory.UNKNOWN: {"max_iter": 10, "cost_cap_micros": 300_000, "agent": None},
}


@dataclass
class AcceptanceContract:
    """Versioned Goal Acceptance Contract (Enterprise Standard)."""
    version: str = "1"
    goal_id: str = ""
    deliverables: list[str] = field(default_factory=list)
    acceptance_criteria: list[str] = field(default_factory=list)
    required_artifacts: list[str] = field(default_factory=list)
    verification_plan: list[str] = field(default_factory=list)
    allowed_paths: list[str] = field(default_factory=list)
    forbidden_paths: list[str] = field(default_factory=list)
    human_acceptance_required: bool = False
    out_of_scope: list[str] = field(default_factory=list)
    max_iterations: int = 10

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "goalId": self.goal_id,
            "deliverables": self.deliverables,
            "acceptanceCriteria": self.acceptance_criteria,
            "requiredArtifacts": self.required_artifacts,
            "verificationPlan": self.verification_plan,
            "allowedPaths": self.allowed_paths,
            "forbiddenPaths": self.forbidden_paths,
            "humanAcceptanceRequired": self.human_acceptance_required,
            "outOfScope": self.out_of_scope,
            "maxIterations": self.max_iterations,
        }

    @staticmethod
    def from_dict(d: dict) -> "AcceptanceContract":
        vplan = d.get("verificationPlan") or d.get("verification_plan") or []
        if isinstance(vplan, str):
            vplan = [vplan] if vplan else []
        return AcceptanceContract(
            version=str(d.get("version", "1")),
            goal_id=d.get("goalId") or d.get("goal_id", ""),
            deliverables=d.get("deliverables") or [],
            acceptance_criteria=d.get("acceptanceCriteria") or d.get("acceptance_criteria") or [],
            required_artifacts=d.get("requiredArtifacts") or d.get("required_artifacts") or [],
            verification_plan=vplan,
            allowed_paths=d.get("allowedPaths") or d.get("allowed_paths") or [],
            forbidden_paths=d.get("forbiddenPaths") or d.get("forbidden_paths") or [],
            human_acceptance_required=bool(d.get("humanAcceptanceRequired") or d.get("human_acceptance_required", False)),
            out_of_scope=d.get("outOfScope") or d.get("out_of_scope") or [],
            max_iterations=int(d.get("maxIterations") or d.get("max_iterations", 10)),
        )


@dataclass
class GoalBrief:
    """Structured contract every goal must satisfy before scheduling.

    Validates completeness: summary and at least one deliverable are required.
    The rest have sensible defaults (empty lists / None) so a minimal brief is
    still expressible.
    """

    summary: str = ""
    assumptions: list[str] = field(default_factory=list)
    deliverables: list[str] = field(default_factory=list)
    acceptance_criteria: list[str] = field(default_factory=list)
    verification_plan: str = ""
    out_of_scope: list[str] = field(default_factory=list)
    design_style: str = ""
    category: GoalCategory = GoalCategory.UNKNOWN
    #: Raw user prompt that produced this brief (for audit / re-derivation).
    raw_prompt: str = ""

    def is_valid(self) -> tuple[bool, str]:
        """Check minimal completeness.

        Returns:
            ``(True, "")`` when valid; ``(False, reason)`` otherwise.
        """
        if not self.summary or not self.summary.strip():
            return False, "summary is required"
        if len(self.summary) > 300:
            return False, f"summary too long ({len(self.summary)} chars, max 300)"
        if not self.deliverables:
            return False, "at least one deliverable is required"
        return True, ""

    def to_dict(self) -> dict:
        return {
            "summary": self.summary,
            "assumptions": self.assumptions,
            "deliverables": self.deliverables,
            "acceptanceCriteria": self.acceptance_criteria,
            "verificationPlan": self.verification_plan,
            "outOfScope": self.out_of_scope,
            "designStyle": self.design_style,
            "category": self.category.value,
            "rawPrompt": self.raw_prompt,
        }

    @staticmethod
    def from_dict(d: dict) -> "GoalBrief":
        cat = d.get("category", "unknown")
        try:
            category = GoalCategory(cat)
        except ValueError:
            category = GoalCategory.UNKNOWN
        return GoalBrief(
            summary=d.get("summary", ""),
            assumptions=d.get("assumptions") or [],
            deliverables=d.get("deliverables") or [],
            acceptance_criteria=d.get("acceptanceCriteria") or d.get("acceptance_criteria") or [],
            verification_plan=d.get("verificationPlan") or d.get("verification_plan") or "",
            out_of_scope=d.get("outOfScope") or d.get("out_of_scope") or [],
            design_style=d.get("designStyle") or d.get("design_style") or "",
            category=category,
            raw_prompt=d.get("rawPrompt") or d.get("raw_prompt") or "",
        )

    def system_context(self) -> str:
        """Render the brief as a concise system-prompt block the agent sees."""
        parts = [f"## Goal: {self.summary}"]
        if self.assumptions:
            parts.append("Assumptions: " + "; ".join(self.assumptions))
        if self.deliverables:
            parts.append("Deliverables: " + "; ".join(self.deliverables))
        if self.acceptance_criteria:
            parts.append("Done when: " + "; ".join(self.acceptance_criteria))
        if self.verification_plan:
            parts.append(f"Verify: {self.verification_plan}")
        if self.out_of_scope:
            parts.append("Out of scope: " + "; ".join(self.out_of_scope))
        if self.design_style:
            parts.append(f"Style: {self.design_style}")
        return "\n".join(parts)

    def get_defaults(self) -> dict:
        """Return category-derived defaults (max_iter, cost_cap, agent)."""
        return CATEGORY_DEFAULTS.get(self.category, CATEGORY_DEFAULTS[GoalCategory.UNKNOWN])


# --------------------------------------------------------------------------- #
# Category derivation                                                         #
# --------------------------------------------------------------------------- #

#: Keyword signals for each category; order matters (first match wins when
#: multiple categories have similar scores, so put more specific first).
_CATEGORY_SIGNALS: list[tuple[GoalCategory, list[str]]] = [
    (GoalCategory.CODE, [
        "写代码", "写文件", "实现", "重构", "fix", "bug", "test", "测试",
        "编码", "代码", "function", "class", "编写", "修改代码", "review",
        "compile", "build", "lint", "格式化", "type check",
    ]),
    (GoalCategory.BROWSER, [
        "浏览器", "打开网页", "网站", "browser", "scrape", "navigate",
        "爬取", "填表", "form", "截图", "screenshot", "网页",
    ]),
    (GoalCategory.RESEARCH, [
        "搜索", "search", "查找", "研究", "compare", "对比", "调研",
        "了解", "学习", "文档", "documentation", "wiki", "论文",
    ]),
    (GoalCategory.SYSTEM, [
        "安装", "install", "卸载", "uninstall", "进程", "process",
        "服务", "service", "系统", "docker", "部署", "deploy", "环境",
    ]),
    (GoalCategory.FILE_OPS, [
        "批量", "batch", "rename", "重命名", "move", "移动", "压缩",
        "compress", "convert", "转换", "copy", "复制", "清理", "clean",
    ]),
    (GoalCategory.CREATIVE, [
        "写作", "write", "文案", "博客", "blog", "画图", "生成图",
        "image", "翻译", "translate", "设计", "design", "文章",
    ]),
    (GoalCategory.GOAL_MGMT, [
        "计划", "plan", "拆分", "分解", "goal", "目标", "子任务",
        "优先级", "priority", "排期", "schedule",
    ]),
]

#: Deliverable patterns that strongly indicate a category regardless of keywords.
_DELIVERABLE_PATTERNS: list[tuple[GoalCategory, re.Pattern]] = [
    (GoalCategory.CODE, re.compile(r"\.(py|ts|tsx|js|jsx|rs|go|java|c|cpp|h)\b", re.I)),
    (GoalCategory.FILE_OPS, re.compile(r"\b(zip|tar|gz|csv|pdf|docx|xlsx)\b", re.I)),
    (GoalCategory.BROWSER, re.compile(r"https?://", re.I)),
]


def derive_goal_category(
    summary: str,
    deliverables: list[str] | None = None,
    raw_prompt: str = "",
) -> GoalCategory:
    """Infer a GoalCategory from textual cues.

    Scoring: each matching keyword adds 1 point. Deliverable pattern matches add
    2 points. Highest total wins. Tie-breaking: the category that appears first
    in ``_CATEGORY_SIGNALS`` wins (i.e. more specific categories are preferred).

    Args:
        summary: The brief's one-line summary.
        deliverables: List of deliverable strings (may contain filenames/URLs).
        raw_prompt: The full user prompt if available for extra signal.

    Returns:
        The best-matching GoalCategory.
    """
    text = f"{summary} {raw_prompt}".lower()
    deliverable_text = " ".join(deliverables or []).lower()

    scores: dict[GoalCategory, int] = {cat: 0 for cat, _ in _CATEGORY_SIGNALS}

    # Keyword scoring.
    for cat, keywords in _CATEGORY_SIGNALS:
        for kw in keywords:
            if kw in text:
                scores[cat] += 1

    # Deliverable pattern bonus.
    for cat, pattern in _DELIVERABLE_PATTERNS:
        if pattern.search(deliverable_text) or pattern.search(text):
            scores[cat] += 2

    best_score = max(scores.values())
    if best_score == 0:
        return GoalCategory.UNKNOWN

    # First category with best_score wins (preserves _CATEGORY_SIGNALS order).
    for cat, _ in _CATEGORY_SIGNALS:
        if scores[cat] == best_score:
            return cat

    return GoalCategory.UNKNOWN


# --------------------------------------------------------------------------- #
# Brief builder (from raw user prompt, no LLM needed)                         #
# --------------------------------------------------------------------------- #

#: Sentence terminators for summary extraction. CJK marks (。！？) are
#: unambiguous, but a bare ASCII "." is usually part of a token in this domain
#: ("router.py", "1.5", "v2.0"), so it only counts as a terminator when followed
#: by whitespace or end-of-string. Without that guard, "重构 router.py 的工具分发"
#: became the summary "重构 router." — a truncated filename that also poisons
#: category derivation, since the `.py` signal is what marks it as a code goal.
_SENTENCE_END = re.compile(r"[。！？\n]|[.!?](?=\s|$)")


def build_brief_from_prompt(prompt: str) -> GoalBrief:
    """Build a minimal GoalBrief heuristically from a plain-language prompt.

    This is the "fast path" that doesn't require an LLM call. For a richer
    brief with proper assumptions/acceptance criteria decomposition, the router
    can call the LLM with a structured extraction prompt and then
    ``GoalBrief.from_dict()`` the result.

    The heuristic:
      - summary = first sentence (capped at 140 chars)
      - deliverables = ["完成用户请求的任务"] (placeholder)
      - category = derive_goal_category(summary, prompt)
    """
    sentence_end = _SENTENCE_END.search(prompt)
    if sentence_end and sentence_end.start() < 140:
        summary = prompt[: sentence_end.end()].strip()
    else:
        summary = prompt[:140].strip()
        if len(prompt) > 140:
            summary += "…"

    # Category is derived from the FULL prompt, not just the summary: the signal
    # that decides the category is often in a later sentence ("...然后加测试").
    category = derive_goal_category(summary, raw_prompt=prompt)

    return GoalBrief(
        summary=summary,
        deliverables=["完成用户请求的任务"],
        category=category,
        raw_prompt=prompt,
    )
