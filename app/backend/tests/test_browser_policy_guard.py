# -*- coding: utf-8 -*-
"""test_browser_policy_guard.py - 浏览器脚本分级与安全策略单元测试"""
import pytest
from browser_policy_guard import BrowserPolicyGuard, ScriptExecutionTier


def test_classify_read_only_scripts():
    tier, _ = BrowserPolicyGuard.classify_script("document.title")
    assert tier == ScriptExecutionTier.READ_ONLY

    tier, _ = BrowserPolicyGuard.classify_script("document.querySelector('h1').textContent")
    assert tier == ScriptExecutionTier.READ_ONLY


def test_classify_mutating_scripts():
    tier, _ = BrowserPolicyGuard.classify_script("document.querySelector('#submit-btn').click()")
    assert tier == ScriptExecutionTier.MUTATING

    tier, _ = BrowserPolicyGuard.classify_script("document.getElementById('input').value = 'hello'")
    assert tier == ScriptExecutionTier.MUTATING


def test_classify_dangerous_scripts():
    tier, reason = BrowserPolicyGuard.classify_script("console.log(document.cookie)")
    assert tier == ScriptExecutionTier.BLOCKED_DANGEROUS
    assert "document.cookie" in reason

    tier, _ = BrowserPolicyGuard.classify_script("eval('alert(1)')")
    assert tier == ScriptExecutionTier.BLOCKED_DANGEROUS


def test_validate_url():
    ok, _ = BrowserPolicyGuard.validate_url("https://www.baidu.com")
    assert ok is True

    ok, err = BrowserPolicyGuard.validate_url("javascript:alert(1)")
    assert ok is False
    assert "Blocked unsafe" in err


def test_browser_agent_evaluate_blocks_dangerous_scripts():
    from browser_agent import _evaluate
    class MockClient:
        def call(self, action, params):
            return Result.success("should not be called")
    class MockAgent:
        def get_client(self):
            return MockClient()
    ctx = {"_agent": MockAgent()}
    res = _evaluate({"code": "document.cookie"}, ctx)
    assert not res.ok
    assert "浏览器脚本执行安全拦截" in res.error


def test_browser_agent_navigate_blocks_dangerous_url():
    from browser_agent import _navigate
    res = _navigate({"url": "javascript:alert(1)"}, {})
    assert not res.ok
    assert "URL 安全校验拦截" in res.error
