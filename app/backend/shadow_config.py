"""shadow_config.py — 影子工作区运行时配置（config.json + 环境变量）"""
from __future__ import annotations

import os
from typing import Optional

# 由 config.json 热加载；环境变量优先级更高
_runtime_mode: Optional[str] = None
_runtime_precheck: Optional[bool] = None


def apply_from_config(config: dict | None) -> None:
    """从 config.json 的 ``shadow`` 段加载；启动与设置热更新时调用。"""
    global _runtime_mode, _runtime_precheck
    sh = (config or {}).get("shadow") or {}
    mode = str(sh.get("mode") or "staged").strip().lower()
    if mode not in ("off", "validate", "staged"):
        mode = "staged"
    _runtime_mode = mode
    _runtime_precheck = sh.get("precheck", True) is not False


def get_mode() -> str:
    env = os.environ.get("OVOLVE_SHADOW_MODE", "").strip().lower()
    if env:
        return env
    return _runtime_mode or "staged"


def shadow_enabled() -> bool:
    return get_mode() not in ("off", "0", "false", "no")


def shadow_staged() -> bool:
    return shadow_enabled() and get_mode() == "staged"


def shadow_validate_only() -> bool:
    return shadow_enabled() and get_mode() == "validate"


def precheck_enabled() -> bool:
    env = os.environ.get("OVOLVE_SHADOW_PRECHECK", "").strip().lower()
    if env:
        return env not in ("0", "false", "no", "off")
    if _runtime_precheck is None:
        return True
    return bool(_runtime_precheck)


def apply_patch(patch: dict) -> dict:
    """合并设置页 patch，返回规范化后的 shadow 配置。"""
    global _runtime_mode, _runtime_precheck
    out: dict = {}
    if "mode" in patch:
        mode = str(patch["mode"] or "staged").strip().lower()
        if mode not in ("off", "validate", "staged"):
            mode = "staged"
        _runtime_mode = mode
        out["mode"] = mode
    if "precheck" in patch:
        val = patch["precheck"] is not False
        _runtime_precheck = val
        out["precheck"] = val
    return out
