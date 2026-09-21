# -*- coding: utf-8 -*-
"""consistency_auditor.py — Evolution rule consistency and safety auditor (Module 3).

Implementation providing 4 quality gates for rule candidates:
1. AST syntax parsing for contained code blocks (ensures no broken snippets).
2. Token budget enforcement (<= 300 tokens).
3. Credential and secret leak scanning.
4. Semantic contradiction / conflict detection against active rules.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
import re
from typing import Sequence


@dataclass
class AuditResult:
    passed: bool
    reason: str
    violations: list[str] = field(default_factory=list)
    ast_valid: bool = True
    token_count: int = 0
    secrets_detected: list[str] = field(default_factory=list)
    conflicts_detected: list[str] = field(default_factory=list)


# Secret detection patterns
_SECRET_PATTERNS = [
    (re.compile(r"sk-[a-zA-Z0-9]{20,}", re.IGNORECASE), "OpenAI / API Key"),
    (re.compile(r"ghp_[a-zA-Z0-9]{30,}", re.IGNORECASE), "GitHub Personal Access Token"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AWS Access Key"),
    (re.compile(r"Bearer\s+[a-zA-Z0-9_\-\.]{20,}", re.IGNORECASE), "Bearer Token"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "Private Key Header"),
]

# Code block pattern
_CODE_BLOCK_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)

# Known mutually exclusive tool pairs / antithesis words for semantic conflict check
_CONFLICT_PAIRS = [
    (r"\balways use pnpm\b", r"\balways use npm\b"),
    (r"\balways use npm\b", r"\balways use pnpm\b"),
    (r"\bprefer pnpm\b", r"\bprefer npm\b"),
    (r"\bprefer npm\b", r"\bprefer pnpm\b"),
    (r"\benable (\w+)\b", r"\bdisable \1\b"),
    (r"\bdisable (\w+)\b", r"\benable \1\b"),
    (r"\balways (\w+)\b", r"\bnever \1\b"),
    (r"\bnever (\w+)\b", r"\balways \1\b"),
]


class ConsistencyAuditor:
    """Audits self-evolved rule candidates before promotion or persistent storage."""

    def __init__(self, max_tokens: int = 300):
        self.max_tokens = max(10, int(max_tokens))

    def estimate_tokens(self, text: str) -> int:
        """Estimate token count based on whitespace & character heuristic."""
        if not text:
            return 0
        words = len(text.split())
        chars = len(text) // 4
        return max(words, chars)

    def audit_rule(
        self,
        rule_text: str,
        existing_rules: Sequence[str] | None = None,
    ) -> AuditResult:
        """Audits a candidate rule across all 4 gates."""
        violations: list[str] = []
        ast_valid = True
        secrets_detected: list[str] = []
        conflicts_detected: list[str] = []

        clean_text = rule_text.strip() if rule_text else ""
        if not clean_text:
            return AuditResult(
                passed=False,
                reason="Rule text is empty",
                violations=["Empty rule text"],
                ast_valid=True,
                token_count=0,
            )

        # Gate 1: Token Budget
        token_count = self.estimate_tokens(clean_text)
        if token_count > self.max_tokens:
            violations.append(
                f"Token budget exceeded: {token_count} > {self.max_tokens}"
            )

        # Gate 2: AST Code Block Validation
        for block in _CODE_BLOCK_RE.findall(clean_text):
            stripped_block = block.strip()
            if not stripped_block:
                continue
            try:
                ast.parse(stripped_block)
            except SyntaxError as err:
                ast_valid = False
                violations.append(f"AST Syntax error in code block: {err}")

        # Gate 3: Credential Scrubber
        for pattern, desc in _SECRET_PATTERNS:
            matches = pattern.findall(clean_text)
            if matches:
                masked_match = matches[0][:8] + "..." if len(matches[0]) > 8 else "***"
                secrets_detected.append(f"{desc} ({masked_match})")
                violations.append(f"Credential / Secret leak detected: {desc}")

        # Gate 4: Semantic Conflict Detection
        if existing_rules:
            lower_candidate = clean_text.lower()
            for existing in existing_rules:
                if not existing:
                    continue
                lower_existing = existing.lower()
                for pat1, pat2 in _CONFLICT_PAIRS:
                    m1 = re.search(pat1, lower_candidate)
                    if m1:
                        if r"\1" in pat2 and m1.groups():
                            target = pat2.replace(r"\1", re.escape(m1.group(1)))
                        else:
                            target = pat2
                        if re.search(target, lower_existing):
                            conflict_msg = (
                                f"Semantic contradiction: '{m1.group(0)}' conflicts "
                                f"with existing rule stating '{existing[:80]}...'"
                            )
                            conflicts_detected.append(conflict_msg)
                            violations.append(conflict_msg)
                            break

        passed = (len(violations) == 0)
        reason = "OK" if passed else "; ".join(violations)

        return AuditResult(
            passed=passed,
            reason=reason,
            violations=violations,
            ast_valid=ast_valid,
            token_count=token_count,
            secrets_detected=secrets_detected,
            conflicts_detected=conflicts_detected,
        )
