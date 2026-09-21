"""
diagnostics.py - Diagnosable agent and system telemetry.

Produces the two-view diagnostic report:
  1. Config-state report  (system view: which providers/MCP/Bot/Hook/Skill/… are configured)
  2. Feature-availability matrix (user view: which capabilities are usable + why)

Plus the six-step skill localization method exposed via
``diagnose_skill`` so "loaded != triggerable" problems can be walked through.

Registered as the ``diagnose`` tool.
"""
from __future__ import annotations

import importlib.util
import json
import os
from typing import Optional

from result import Result

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.abspath(os.path.join(BACKEND_DIR, ".."))
PROJECT_DIR = os.path.abspath(os.path.join(APP_DIR, ".."))

# Six-step skill localization method (reference text for reports).
SIX_STEP_METHOD = [
    "1. 子系统开关：功能总开关开了吗（memory/compact/skill/mcp/hook）？",
    "2. 是否被发现：文件在发现路径吗（用户 > 工作区 > 内置）？",
    "3. 加载是否失败：frontmatter 合法吗？description 空/超长会被丢弃。",
    "4. 谁赢了 (shadow)：更高优先级有同名副本吗？首个同名生效。",
    "5. 是否被禁用：插件禁用状态 / 配置里的 disable 覆盖？",
    "6. 触发词是否弱：description 前 ~250 字写清'何时用'了吗？",
]


def _module_available(mod: str) -> bool:
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


class Diagnostics:
    """Config-state + feature-availability + six-step skill diagnosis."""

    def __init__(self, config: dict = None) -> None:
        self.config = config if config is not None else self._load_config()

    def _load_config(self) -> dict:
        path = os.path.join(APP_DIR, "config.json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {}

    # ── config-state (system view) ────────────────────────────────

    def config_state(self) -> list[dict]:
        cfg = self.config
        model = cfg.get("model", {}) or {}
        mcp = cfg.get("mcp", {}) or {}
        bot = cfg.get("bot", {}) or {}
        memory = cfg.get("memory", {}) or {}

        hooks_path = os.path.join(PROJECT_DIR, ".agents", "hooks.json")
        skills_dir = os.path.join(PROJECT_DIR, ".agents", "skills")
        skill_count = 0
        if os.path.isdir(skills_dir):
            skill_count = sum(
                1 for e in os.listdir(skills_dir)
                if os.path.isfile(os.path.join(skills_dir, e, "SKILL.md"))
            )

        return [
            {"category": "Provider", "configured": bool(model.get("api_key")),
             "detail": model.get("model_id", "") or "no model_id"},
            {"category": "MCP", "configured": bool(mcp.get("gateway_url")),
             "detail": mcp.get("gateway_url", "") or "gateway_url empty"},
            {"category": "Bot", "configured": bool(
                bot.get("telegram_token") or bot.get("feishu_app_id")),
             "detail": "telegram/feishu credentials"},
            {"category": "Hook", "configured": os.path.isfile(hooks_path),
             "detail": hooks_path if os.path.isfile(hooks_path) else "no .agents/hooks.json"},
            {"category": "Skill", "configured": skill_count > 0,
             "detail": f"{skill_count} skill(s) on disk"},
            {"category": "Memory", "configured": bool(memory.get("enabled")),
             "detail": f"embedding={memory.get('embedding_model', 'n/a')}"},
        ]

    # ── feature-availability (user view) ──────────────────────────

    def feature_matrix(self) -> list[dict]:
        cfg = self.config
        model = cfg.get("model", {}) or {}
        mcp = cfg.get("mcp", {}) or {}
        bot = cfg.get("bot", {}) or {}
        memory = cfg.get("memory", {}) or {}
        hooks_path = os.path.join(PROJECT_DIR, ".agents", "hooks.json")

        def row(feature, available, depends):
            return {"feature": feature, "available": bool(available), "depends_on": depends}

        return [
            row("AI 对话", model.get("api_key"), "Provider api_key"),
            row("文件读写", True, "built-in tools"),
            row("系统/进程管理", True, "built-in tools"),
            row("浏览器自动化", _module_available("selenium"), "selenium + control-browser skill"),
            row("深度搜索", True, "search_agent (arxiv/web built-in)"),
            row("定时任务", _module_available("croniter"), "croniter + CronCreate"),
            row("长程目标", True, "goal_manager"),
            row("记忆系统", memory.get("enabled"), "memory.enabled + storage"),
            row("自动化 Hook", os.path.isfile(hooks_path), ".agents/hooks.json"),
            row("外部 MCP", mcp.get("gateway_url"), "mcp.gateway_url"),
            row("远程控制", bot.get("telegram_token") or bot.get("feishu_app_id"), "Bot 配置"),
        ]

    # ── six-step skill diagnosis ──────────────────────────────────

    def diagnose_skill(self, name: str) -> dict:
        """Walk the six-step method for one skill and report where it stands."""
        from skill_loader import get_skill_loader, SkillStatus
        loader = get_skill_loader()
        entry = loader.get_skill(name)
        steps = []

        found = entry is not None
        steps.append({"step": 2, "check": "discovered", "pass": found,
                      "note": "on disk & imported" if found else "not found in loader"})
        if not found:
            return {"skill": name, "found": False, "steps": steps,
                    "method": SIX_STEP_METHOD}

        loaded = entry.status != SkillStatus.DROPPED
        steps.append({"step": 3, "check": "loaded (frontmatter ok)", "pass": loaded,
                      "note": "; ".join(entry.errors) or "ok"})
        enabled = entry.status != SkillStatus.DISABLED
        steps.append({"step": 5, "check": "enabled", "pass": enabled,
                      "note": entry.status.value})
        strong_trigger = len((entry.description or "").strip()) >= 30
        steps.append({"step": 6, "check": "trigger words", "pass": strong_trigger,
                      "note": f"description length={len(entry.description or '')}"})
        return {
            "skill": name,
            "found": True,
            "status": entry.status.value,
            "steps": steps,
            "method": SIX_STEP_METHOD,
        }

    def report(self) -> dict:
        cfg_state = self.config_state()
        matrix = self.feature_matrix()
        return {
            "config_state": cfg_state,
            "feature_matrix": matrix,
            "available_features": sum(1 for m in matrix if m["available"]),
            "total_features": len(matrix),
            "six_step_method": SIX_STEP_METHOD,
        }


def _diagnose_impl(args, ctx):
    diag = get_diagnostics()
    skill = args.get("skill")
    if skill:
        return Result.success(diag.diagnose_skill(skill))
    return Result.success(diag.report())


def register_tools(registry=None) -> None:
    """Register the ``diagnose`` tool."""
    from tools import ToolDef, get_tool_registry
    registry = registry or get_tool_registry()
    registry.register(ToolDef(
        "diagnose",
        "Diagnose the agent: config-state report + feature-availability matrix. "
        "Pass 'skill' to run the six-step method on one skill.",
        {"type": "object", "properties": {"skill": {"type": "string"}}, "required": []},
        _diagnose_impl, domain="computer", risk_level="low",
    ))


_diag: Optional[Diagnostics] = None


def get_diagnostics(config: dict = None) -> Diagnostics:
    global _diag
    if _diag is None:
        _diag = Diagnostics(config)
    return _diag
