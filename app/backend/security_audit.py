"""
security_audit.py - Security hardening self-check + red-team closed loop (pattern 05).

Loads ``security/vulns.json`` (the hardening checklist) and:
  - ``self_check()``          verifies each vuln's owner module is present on disk
  - ``red_team_closed_loop()`` replays the attack examples from
                               ``injection_patterns.json`` through the output
                               guard and reports catch coverage
  - ``full_report()``         combines both into one report (config + red team)

This closes pattern 05 (5.1 vulns.json, 5.3 red-team closed loop) by binding
the "attack" library (pattern 06/08) to the "defense" (output_guard) and
measuring that the loop actually holds.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from result import Result

SECURITY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "security")
VULNS_FILE = os.path.join(SECURITY_DIR, "vulns.json")
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


class SecurityAuditor:
    """Run the hardening checklist and the red-team closed loop."""

    def __init__(self, vulns_path: str = None) -> None:
        self.checks: list[dict] = []
        self._load(vulns_path or VULNS_FILE)

    def _load(self, path: str) -> None:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.checks = data.get("checks", [])
        except (OSError, json.JSONDecodeError):
            self.checks = []

    def self_check(self) -> dict:
        """Confirm every vuln's owner module is present in the backend."""
        results = []
        present = 0
        for chk in self.checks:
            owner = chk.get("owner_module", "")
            module_present = bool(owner) and os.path.isfile(os.path.join(BACKEND_DIR, owner))
            if module_present:
                present += 1
            results.append({
                "id": chk.get("id"),
                "title": chk.get("title"),
                "severity": chk.get("severity"),
                "category": chk.get("category"),
                "owner_module": owner,
                "module_present": module_present,
            })
        total = len(self.checks)
        return {
            "total": total,
            "modules_present": present,
            "coverage": round(present / total, 3) if total else 0.0,
            "checks": results,
        }

    def red_team_closed_loop(self) -> dict:
        """Fire the attack library at the live defense and report coverage.

        Delegates to ``red_team.RedTeam.closed_loop`` (the canonical
        attack↔defense loop, pattern 05 §5.3) which merges the embedded default
        categories with ``injection_patterns.json`` and checks each example
        against both the injection scanner and ``output_guard``.
        """
        try:
            from red_team import get_red_team
            loop = get_red_team().closed_loop()
        except Exception as e:
            return {"total": 0, "caught": 0, "coverage": 0.0, "error": str(e)}
        # Normalize key name so callers see a stable ``coverage`` + ``total``.
        return {
            "total": loop.get("total_attacks", 0),
            "caught": loop.get("caught", 0),
            "coverage": loop.get("coverage", 0.0),
            "missed": [m.get("example", "")[:80] for m in loop.get("missed", [])][:10],
        }

    def full_report(self) -> dict:
        sc = self.self_check()
        rt = self.red_team_closed_loop()
        return {
            "self_check": sc,
            "red_team_closed_loop": rt,
            "healthy": sc["coverage"] >= 0.9 and rt["coverage"] >= 0.6,
        }


def _security_audit_impl(args, ctx):
    return Result.success(get_security_auditor().full_report())


def register_tools(registry=None) -> None:
    """Register the ``security_audit`` tool."""
    from tools import ToolDef, get_tool_registry
    registry = registry or get_tool_registry()
    registry.register(ToolDef(
        "security_audit",
        "Run the hardening self-check + red-team closed loop; report coverage.",
        {"type": "object", "properties": {}, "required": []},
        _security_audit_impl, domain="computer", risk_level="low",
    ))


_auditor: Optional[SecurityAuditor] = None


def get_security_auditor() -> SecurityAuditor:
    global _auditor
    if _auditor is None:
        _auditor = SecurityAuditor()
    return _auditor
