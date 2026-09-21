# -*- coding: utf-8 -*-
"""test_consistency_auditor.py — Unit tests for rule evolution consistency auditor (Module 3)."""
import pytest
from consistency_auditor import ConsistencyAuditor, AuditResult


def test_consistency_auditor_clean_rule():
    auditor = ConsistencyAuditor(max_tokens=300)
    rule = "Always format Python code using PEP 8 conventions. Keep functions under 50 lines."
    result = auditor.audit_rule(rule)
    assert result.passed is True
    assert result.violations == []
    assert result.ast_valid is True
    assert result.token_count < 50


def test_consistency_auditor_catches_ast_syntax_error():
    auditor = ConsistencyAuditor()
    rule = """
    Use this snippet for error handling:
    ```python
    def bad_function(
        # missing closing parenthesis and colon
    ```
    """
    result = auditor.audit_rule(rule)
    assert result.passed is False
    assert result.ast_valid is False
    assert any("Syntax error" in v or "AST" in v for v in result.violations)


def test_consistency_auditor_catches_token_overflow():
    auditor = ConsistencyAuditor(max_tokens=50)
    rule = "Word " * 100  # 100 words > 50 tokens
    result = auditor.audit_rule(rule)
    assert result.passed is False
    assert any("Token budget" in v for v in result.violations)


def test_consistency_auditor_catches_credentials():
    auditor = ConsistencyAuditor()
    rule = "Use the production OpenAI key: sk-abcdef1234567890abcdef1234567890 for API calls."
    result = auditor.audit_rule(rule)
    assert result.passed is False
    assert len(result.secrets_detected) > 0
    assert any("Credential" in v or "Secret" in v for v in result.violations)


def test_consistency_auditor_detects_semantic_conflict():
    auditor = ConsistencyAuditor()
    existing = [
        "Always use pnpm for managing node dependencies; never use npm directly."
    ]
    conflicting_rule = "Always use npm directly for installing dependencies."
    result = auditor.audit_rule(conflicting_rule, existing_rules=existing)
    assert result.passed is False
    assert len(result.conflicts_detected) > 0
    assert any("contradiction" in v.lower() or "conflict" in v.lower() for v in result.violations)
