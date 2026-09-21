"""
four_identities.py — Ovolve Four-Fold Identity & Memory Separation Architecture.

Four-fold separation of identity context (IDENTITY / USER / SOUL / MEMORY):
1. IDENTITY.md: AI assistant name, version, and core operational role.
2. USER.md: User preferred name, technical background, and interaction habits.
3. SOUL.md: AI personality, tone, core values, and ethics boundaries.
4. MEMORY.md: Objective project-level facts, conventions, and decision logs.

Provides clean CRUD helpers that update only targeted fields without polluting
or corrupting adjacent prompt assets.
"""
from __future__ import annotations

import os
import re
import time
from typing import Any, Dict, Optional

IDENTITY_FILE = "IDENTITY.md"
USER_FILE = "USER.md"
SOUL_FILE = "SOUL.md"
MEMORY_FILE = "MEMORY.md"

ALL_IDENTITY_FILES = (IDENTITY_FILE, USER_FILE, SOUL_FILE, MEMORY_FILE)

DEFAULT_IDENTITY_TEMPLATE = """# IDENTITY.md · AI Identity Specification

- **Name**: {name}
- **Role**: High-Performance Autonomous AI Software Engineering Assistant
- **Version**: Ovolve v1.0
- **Engine**: Hybrid Dual-Engine (Vite + Electron / Python Orchestration)
"""

DEFAULT_USER_TEMPLATE = """# USER.md · User Profile & Preferences

- **Name**: {user_name}
- **Role**: Technical AI Product Manager & Engineering Lead
- **Preferred Language**: Chinese (Simplified) / Technical English
- **Communication Style**: Direct, evidence-based, architecture-first
"""

DEFAULT_SOUL_TEMPLATE = """# SOUL.md · Agent Persona & Principles

## 1. 核心性格与语气
- 严谨、专注、实事求是。不讲空话、套话与机械套词。
- 坚持第一性原理与深水区工程穿透。

## 2. 工程与质量红线
- 证据优先：任何断言必须有物理运行与退出码支撑（No Proof, No Claim）。
- Fail-Open 与故障自愈：边缘服务崩溃坚决不中断主会话。
- 可审计性：关键路径保持显式边界与单一职责，改动必须能被自动化回归覆盖。
"""


def get_identity_path(workspace_root: str, filename: str) -> str:
    """Safely resolve an identity file path within the workspace."""
    base = os.path.realpath(workspace_root or ".")
    target = os.path.realpath(os.path.join(base, filename))
    if not target.startswith(base):
        raise ValueError(f"Target path escapes workspace: {filename}")
    return target


def init_workspace_identities(
    workspace_root: str,
    ai_name: str = "Ovolve",
    user_name: str = "User",
    overwrite: bool = False,
) -> Dict[str, bool]:
    """Initialize default identity files if they do not already exist."""
    results = {}
    base = os.path.realpath(workspace_root or ".")
    os.makedirs(base, exist_ok=True)

    defaults = {
        IDENTITY_FILE: DEFAULT_IDENTITY_TEMPLATE.format(name=ai_name),
        USER_FILE: DEFAULT_USER_TEMPLATE.format(user_name=user_name),
        SOUL_FILE: DEFAULT_SOUL_TEMPLATE,
    }

    for fname, content in defaults.items():
        p = os.path.join(base, fname)
        if not os.path.exists(p) or overwrite:
            with open(p, "w", encoding="utf-8") as f:
                f.write(content.strip() + "\n")
            results[fname] = True
        else:
            results[fname] = False

    return results


def update_identity_name(workspace_root: str, new_ai_name: str) -> bool:
    """Update the AI assistant's name in IDENTITY.md without modifying other fields."""
    p = get_identity_path(workspace_root, IDENTITY_FILE)
    if not os.path.isfile(p):
        init_workspace_identities(workspace_root, ai_name=new_ai_name)
        return True

    with open(p, "r", encoding="utf-8") as f:
        content = f.read()

    # Precise regex replacement for - **Name**: <name>
    if re.search(r"-\s*\*\*Name\*\*:\s*.+", content):
        new_content = re.sub(
            r"-\s*\*\*Name\*\*:\s*.+",
            f"- **Name**: {new_ai_name}",
            content,
            count=1,
        )
    else:
        new_content = content.strip() + f"\n- **Name**: {new_ai_name}\n"

    with open(p, "w", encoding="utf-8") as f:
        f.write(new_content)
    return True


def update_user_name(workspace_root: str, new_user_name: str) -> bool:
    """Update the user's preferred name in USER.md without modifying other fields."""
    p = get_identity_path(workspace_root, USER_FILE)
    if not os.path.isfile(p):
        init_workspace_identities(workspace_root, user_name=new_user_name)
        return True

    with open(p, "r", encoding="utf-8") as f:
        content = f.read()

    if re.search(r"-\s*\*\*Name\*\*:\s*.+", content):
        new_content = re.sub(
            r"-\s*\*\*Name\*\*:\s*.+",
            f"- **Name**: {new_user_name}",
            content,
            count=1,
        )
    else:
        new_content = content.strip() + f"\n- **Name**: {new_user_name}\n"

    with open(p, "w", encoding="utf-8") as f:
        f.write(new_content)
    return True
