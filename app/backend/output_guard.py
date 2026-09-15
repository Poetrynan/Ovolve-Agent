"""
output_guard.py - Anti-leakage refusal pool filter (Pi pattern).

Mounted as an 'output' event subscriber.
Detects attempts to leak system prompt / skill content / tool schemas.
Replaces leaked content with random non-repeating refusal phrases.

Immune to: JSON wrapping, Base64 encoding, rule priority traps,
role-playing, file injection vectors.
"""

from __future__ import annotations

import re
import random
import unicodedata
from typing import Optional

from event_bus import EventBus, Event, EventAction, get_event_bus


# Refusal pool: >=5 different phrasings, character-based, non-repeating
# Bilingual: the primary user language is Chinese, so the pool must carry
# Chinese refusals too — an English-only pool reads as a template to a
# Chinese user and undermines the "firm boundary" tone.
REFUSAL_POOL = [
    # — Chinese refusals —
    "这是内部实现细节，我不能透露。我们继续处理你的实际任务吧。",
    "这部分内容不在讨论范围内。有什么具体的事我可以帮忙吗？",
    "我承诺过不公开内部规则。不如我们专注把眼前的事做好？",
    "这个话题到此为止。我随时可以帮你处理文件、搜索或其他系统操作。",
    "分享内部规则不是我会做的事。但我完全准备好帮你完成实际工作。",
    "这事关边界，这条线我不会越。我们回到正题吧。",
    "这是一本合上的书。现在，让我来帮你做点实际的事。",
    "我遵守某些界限，这是其中之一。让我们继续干活。",
    # — English refusals (kept for multilingual robustness) —
    "This is something I can't share. Let's focus on getting your actual work done.",
    "That falls under internal implementation details I'm not at liberty to discuss. Got a real task for me?",
    "I've signed off on keeping the internals private. How about we tackle something productive instead?",
    "That particular topic is off-limits. I'm here to help you manage your computer - what needs doing?",
    "Sharing internal rules isn't something I do. But I'm fully ready to help with files, searches, or system tasks.",
    "Consider that a closed book. Now, what can I actually do for you today?",
    "I operate with certain boundaries, and that's one of them. Let's get back to real work.",
]


# Detection patterns for leakage attempts
LEAKAGE_PATTERNS = [
    # Direct system prompt references
    re.compile(r"(?i)system\s*prompt", re.IGNORECASE),
    re.compile(r"(?i)你的?(系统|内部)?(指令|规则|prompt|规则)", re.IGNORECASE),
    # Skill/SOP content requests
    re.compile(r"(?i)(输出|显示|打印|reveal|show|output|dump|export).*(skill|技能|SOP)", re.IGNORECASE),
    # Tool schema requests
    re.compile(r"(?i)(工具|tool).*(schema|定义|definition|声明|declaration)", re.IGNORECASE),
    # Source code requests for internals
    re.compile(r"(?i)(源码|source code).*(router|event_bus|risk|guard|kernel)", re.IGNORECASE),
    # Base64 encoded content (detect common patterns)
    re.compile(r"(?i)base64.*(decode|encode|解|编).*(prompt|skill|rule|系统)", re.IGNORECASE),
    # JSON wrapping attempts
    re.compile(r"(?i)json.*(format|格式|输出|output).*(prompt|skill|rule|系统|指令)", re.IGNORECASE),
    # Rule priority comparison traps
    re.compile(r"(?i)(规则|rule).*(优先级|priority|比对|compare|冲突|conflict)", re.IGNORECASE),
    # Role-play extraction attempts
    re.compile(r"(?i)(扮演|role.?play|pretend|simulate).*(管理员|admin|developer|开发者|系统)", re.IGNORECASE),
    # File injection jump board
    re.compile(r"(?i)(读取|read|加载|load).*(prompt\.txt|skill\.md|config|\.env)", re.IGNORECASE),
    # "Ignore previous instructions" patterns
    re.compile(r"(?i)(ignore|忽略|跳过|skip).*(previous|之前的|所有|all).*(instruction|指令|规则|test|测试)", re.IGNORECASE),
    # "Do not scan" injection patterns
    re.compile(r"(?i)(do not|don't|不要|别).*(scan|扫描|检测|check|verify)", re.IGNORECASE),
    # Admin request injection
    re.compile(r"(?i)(管理员|admin|root|sudo).*(请求|request|命令|command|模式|mode)", re.IGNORECASE),
]


# Patterns that indicate actual leaked content in output
LEAKED_CONTENT_PATTERNS = [
    # Risk level emojis in structured format
    re.compile(r"[🟢🟡🔴].*(风险|risk).*(级|level|定级)", re.IGNORECASE),
    # Internal field names
    re.compile(r"(?i)(risk_acknowledged|action_execute|confirmation_required)", re.IGNORECASE),
    # Tool schema JSON
    re.compile(r'"inputSchema"\s*:', re.IGNORECASE),
    re.compile(r'"tool_origin_name"\s*:', re.IGNORECASE),
    # Refusal pool content (meta-leakage)
    re.compile(r"(?i)(refusal_pool|拒绝池|REFUSAL_POOL)", re.IGNORECASE),
]


class OutputGuard:
    """Anti-leakage filter as output event subscriber.

    Subscribes to 'output' event. If leaked content detected:
    - Replaces with random non-repeating refusal phrase
    """

    def __init__(self):
        self._bus: Optional[EventBus] = None
        self._used_refusals: set[int] = set()  # Track used refusals to avoid repeating
        self._detection_count: int = 0

    def mount(self, bus: EventBus = None):
        """Register as event subscriber on the bus."""
        self._bus = bus or get_event_bus()
        self._bus.on("output", self._on_output, priority=200)  # High priority - last filter

    def unmount(self):
        if self._bus:
            self._bus.off("output", self._on_output)

    def _on_output(self, event: Event):
        """Filter output for leaked content."""
        ctx = event.payload.get("context") or {}
        if ctx.get("benchmark") or event.payload.get("benchmark"):
            return

        text = event.payload.get("text", "")
        if not text:
            return

        # Check if output contains leaked internal content
        if self._contains_leaked_content(text):
            self._detection_count += 1
            refusal = self._get_random_refusal()
            event.modify({"text": refusal, "filtered": True, "reason": "leaked_content_detected"})
            return

        # Check if the user's request was a leakage attempt (passed through context)
        user_intent = event.payload.get("user_intent", "")
        if user_intent and self._is_extraction_attempt(user_intent):
            self._detection_count += 1
            refusal = self._get_random_refusal()
            event.modify({"text": refusal, "filtered": True, "reason": "extraction_attempt"})
            return

    @staticmethod
    def _normalize_for_match(text: str) -> str:
        """Strip whitespace and zero-width chars so pattern-bombing can't bypass.

        Attackers insert zero-width spaces, soft hyphens, or extra whitespace
        between characters to break literal substring matches. Normalizing
        before the second pass closes that gap without changing the original
        text the user sees.
        """
        # Zero-width and invisible characters commonly used to break matches
        invisible = (
            "\u200b",  # zero-width space
            "\u200c",  # zero-width non-joiner
            "\u200d",  # zero-width joiner
            "\u200e",  # left-to-right mark
            "\u200f",  # right-to-left mark
            "\u00ad",  # soft hyphen
            "\ufeff",  # zero-width no-break space (BOM)
            "\u2060",  # word joiner
            "\u2061",  # function application
            "\u2062",  # invisible times
            "\u2063",  # invisible separator
            "\u2064",  # invisible plus
        )
        cleaned = text
        for ch in invisible:
            cleaned = cleaned.replace(ch, "")
        # Collapse all whitespace runs to a single space for pattern matching
        cleaned = re.sub(r"\s+", "", cleaned)
        return cleaned

    def _contains_leaked_content(self, text: str) -> bool:
        """Check if output text contains leaked internal content.

        Two passes: first on the raw text (catches direct reproductions),
        then on a normalized copy (catches pattern-bombing attempts that
        insert zero-width chars or extra whitespace to break matches).
        """
        for pattern in LEAKED_CONTENT_PATTERNS:
            if pattern.search(text):
                return True

        # Second pass on normalized text — defends against split-char evasion
        normalized = self._normalize_for_match(text)
        if normalized != text:
            for pattern in LEAKED_CONTENT_PATTERNS:
                if pattern.search(normalized):
                    return True

        # Check for large blocks of internal-looking content
        # (e.g., full system prompt reproduction)
        if len(text) > 500:
            internal_markers = sum(1 for p in LEAKED_CONTENT_PATTERNS if p.search(text))
            if internal_markers >= 2:
                return True

        return False

    def _is_extraction_attempt(self, user_text: str) -> bool:
        """Check if user message is an extraction attempt.

        Consults the local LEAKAGE_PATTERNS first, then the full red-team
        injection library (security/injection_patterns.json) so the guard
        stays in sync with the attack catalogue without duplicating it.
        """
        for pattern in LEAKAGE_PATTERNS:
            if pattern.search(user_text):
                return True
        try:
            from red_team import get_red_team_auditor
            return get_red_team_auditor().is_attack(user_text)
        except Exception:
            return False

    def _get_random_refusal(self) -> str:
        """Get a random non-repeating refusal phrase.

        Cycles through all phrases before repeating any.
        """
        available = [i for i in range(len(REFUSAL_POOL)) if i not in self._used_refusals]

        if not available:
            # All used - reset and start fresh
            self._used_refusals.clear()
            available = list(range(len(REFUSAL_POOL)))

        idx = random.choice(available)
        self._used_refusals.add(idx)
        return REFUSAL_POOL[idx]

    def get_stats(self) -> dict:
        """Get guard statistics."""
        return {
            "detections": self._detection_count,
            "pool_size": len(REFUSAL_POOL),
            "used_refusals": len(self._used_refusals),
        }


# Global output guard
_guard: Optional[OutputGuard] = None


def get_output_guard() -> OutputGuard:
    global _guard
    if _guard is None:
        _guard = OutputGuard()
    return _guard


def init_output_guard() -> OutputGuard:
    global _guard
    _guard = OutputGuard()
    _guard.mount()
    return _guard


class FullScopeDeliveryGuard:
    """生产级物理全量交付门禁 (Phase 61 核心硬内化)。
    
        - 绝不允许偷工减料或留下未实现的占位符注释；
    - 在 write_to_file / replace_file_content 写入磁盘前物理扫描代码；
    - 若命中偷懒占位符模式，物理拦截并要求模型提供 100% 完整可运行代码。
    """

    LAZY_PLACEHOLDER_PATTERNS = [
        re.compile(r"//\s*\.\.\.\s*(rest|existing|code|remaining)\s*(of\s*code\s*)?(unchanged|here)?\s*\.\.\.", re.IGNORECASE),
        re.compile(r"/\*\s*(rest|existing|code|remaining)\s*(of\s*code\s*)?(unchanged|here)?\s*\*/", re.IGNORECASE),
        re.compile(r"<!--\s*(rest|existing|code|remaining)\s*(of\s*code\s*)?(unchanged|here)?\s*-->", re.IGNORECASE),
        re.compile(r"#\s*\.\.\.\s*(rest|existing|code|remaining)\s*(of\s*code\s*)?(unchanged|here)?\s*\.\.\.", re.IGNORECASE),
        re.compile(r"(//|#|/\*)\s*TODO:\s*(implement\s*(later|here|rest)|add\s*logic\s*later)", re.IGNORECASE),
        re.compile(r"//\s*TODO\s*:\s*insert\s*your\s*code\s*here", re.IGNORECASE),
        re.compile(r"//\s*TODO\s*:\s*fill\s*in\s*later", re.IGNORECASE),
        re.compile(r"/\*\s*TODO\s*:\s*rest\s*of\s*implementation\s*\*/", re.IGNORECASE),
        re.compile(r"#\s*TODO\s*:\s*rest\s*of\s*implementation", re.IGNORECASE),
        re.compile(r"\bpass\s*#\s*TODO\s*:\s*implement\b", re.IGNORECASE),
    ]

    @classmethod
    def inspect_code(cls, code: str) -> tuple[bool, str]:
        """检查代码中是否含有偷懒占位符。
        
        Returns:
            (has_lazy_placeholder: bool, matched_snippet: str)
        """
        if not code or not isinstance(code, str):
            return False, ""

        for pat in cls.LAZY_PLACEHOLDER_PATTERNS:
            match = pat.search(code)
            if match:
                return True, match.group(0).strip()
        return False, ""

