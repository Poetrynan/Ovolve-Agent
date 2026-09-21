# -*- coding: utf-8 -*-
"""
test_secret_scan.py — 单元测试：三层密钥与凭据泄漏防护引擎 (P3-1)。
"""
import pytest
from pathlib import Path
from secret_scan import (
    scan_text,
    scan_tree,
    generate_leak_report,
    shannon_entropy,
    is_allowlisted_or_low_entropy,
)
from tool_hooks import get_tool_hooks, reset_tool_hooks
from danger_classifier import classify_write, DENY, CONFIRM, ALLOW


def test_shannon_entropy_calculation():
    # 纯单字符熵为 0
    assert shannon_entropy("aaaaaaaa") == 0.0
    # 低熵
    assert shannon_entropy("abababab") == 1.0
    # 高熵随机 base64/hex
    high_entropy_str = "K9jF2pL8xM4vQ7wR1tY5zC3bN6mD0sH"
    assert shannon_entropy(high_entropy_str) > 4.0


def test_allowlist_and_low_entropy_filtering():
    # 占位符必须被排除
    assert is_allowlisted_or_low_entropy("YOUR_API_KEY_HERE_12345678") is True
    assert is_allowlisted_or_low_entropy("example_secret_token_1234") is True
    assert is_allowlisted_or_low_entropy("dummy_token_placeholder") is True
    # 纯重复字符必须被排除
    assert is_allowlisted_or_low_entropy("000000000000000000") is True
    # 真实高熵密钥不可被排除
    real_key = "aB3$kL9#mP0!qR8&xZ1*vT5@nC7^"
    assert is_allowlisted_or_low_entropy(real_key) is False


def test_pem_private_key_detection():
    pem = """
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1234567890abcdefghijklmnopqrstuvwxyzABCDEFGH
-----END RSA PRIVATE KEY-----
"""
    matches = scan_text(pem)
    assert len(matches) == 1
    assert matches[0].rule_name == "pem_private_key"
    assert matches[0].confidence == "high"
    assert matches[0].is_pem is True
    assert "[REDACTED]" in matches[0].redacted


def test_aws_credentials_detection():
    # AWS Access Key ID
    content_id = "AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLE"
    matches = scan_text(content_id)
    assert any(m.rule_name == "aws_access_key" for m in matches)

    # AWS Secret Access Key
    content_sec = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    matches = scan_text(content_sec)
    assert any(m.rule_name == "aws_secret_key" for m in matches)


def test_google_slack_stripe_github_tokens_detection():
    sample = """
    GOOGLE_KEY = "AIzaSyD-1234567890abcdefghijklmnopqrst"
    SLACK_BOT = "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx"
    STRIPE_KEY = "sk_live_51A1B2C3D4E5F6G7H8I9J0K1L2"
    GITHUB_PAT = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"
    """
    matches = scan_text(sample)
    rule_names = {m.rule_name for m in matches}
    assert "google_api_key" in rule_names
    assert "slack_token" in rule_names
    assert "stripe_secret_key" in rule_names
    assert "github_token" in rule_names


def test_database_connection_url_detection():
    url_text = 'DATABASE_URL="postgres://app_user:sUp3rS3cr3tP@ssw0rd!@db.production.internal:5432/main_db"'
    matches = scan_text(url_text)
    assert any(m.rule_name == "db_connection_url" for m in matches)


def test_generic_high_entropy_assignment_and_false_positive_elimination():
    # 真实高熵赋值应检出
    text_real = 'API_SECRET = "kX9$mP2!vL8#qR5&bT1*zC7@"'
    matches_real = scan_text(text_real)
    assert any(m.rule_name == "generic_credential_assignment" for m in matches_real)

    # 占位符/简单测试串不应误报
    text_fake = 'API_SECRET = "YOUR_API_KEY_HERE"'
    matches_fake = scan_text(text_fake)
    assert len(matches_fake) == 0


def test_scan_tree_clean_directory(tmp_path):
    # 模拟正常代码库目录结构
    src = tmp_path / "src"
    src.mkdir()
    (src / "math_utils.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (src / "config.py").write_text("DEBUG = True\nHOST = '127.0.0.1'\nPORT = 8080\n", encoding="utf-8")

    matches = scan_tree(tmp_path)
    assert len(matches) == 0


def test_tool_hook_blocks_pem_write():
    reset_tool_hooks()
    hooks = get_tool_hooks()

    pem_payload = {
        "TargetFile": "d:/server.key",
        "CodeContent": "-----BEGIN EC PRIVATE KEY-----\nB3cR3tD4t4...\n-----END EC PRIVATE KEY-----"
    }
    result = hooks.run_pre("write_to_file", pem_payload, {})
    assert result["blocked"] is True
    assert "高风险私钥/凭据" in result["reason"]
    assert "pem_private_key" in result["reason"]

    # 干净代码写入放行
    clean_payload = {
        "TargetFile": "d:/service.py",
        "CodeContent": "def run_server():\n    print('Server started')\n"
    }
    result_clean = hooks.run_pre("write_to_file", clean_payload, {})
    assert result_clean["blocked"] is False


def test_classify_write_risk_levels():
    # 1. 写入高危 PEM -> DENY
    pem_content = "-----BEGIN RSA PRIVATE KEY-----\nFakeKey\n-----END RSA PRIVATE KEY-----"
    v_pem = classify_write("test.pem", pem_content)
    assert v_pem.level == DENY
    assert "私钥" in v_pem.what

    # 2. 写入数据库连接串 (中置信凭据) -> CONFIRM (走现有用户确认流程)
    db_content = 'DATABASE_URL="mysql://root:ComplexP@ssw0rd99!@10.0.0.1:3306/db"'
    v_db = classify_write("db_config.py", db_content)
    assert v_db.level == CONFIRM
    assert "凭据" in v_db.what

    # 3. 普通干净代码 -> ALLOW (如果是普通 py 文件)
    clean_content = "def hello():\n    return 'world'"
    v_clean = classify_write("hello.py", clean_content)
    assert v_clean.level == ALLOW


def test_generate_leak_report():
    text = "AIzaSyD-1234567890abcdefghijklmnopqrst"
    matches = scan_text(text)
    report = generate_leak_report(matches)
    assert "敏感密钥/凭据泄漏风险" in report
    assert "google_api_key" in report


def test_tool_hook_blocks_git_push_with_staged_secrets(monkeypatch):
    import subprocess
    reset_tool_hooks()
    hooks = get_tool_hooks()

    class FakeProc:
        stdout = "+ AWS_SECRET_KEY = AKIAIOSFODNN7EXAMPLE\n"
        stderr = ""
        returncode = 0

    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: FakeProc())

    # 模拟执行 git push 命令
    cmd_payload = {
        "command": "git push origin master",
        "Cwd": "d:/repo"
    }
    result = hooks.run_pre("run_command", cmd_payload, {})
    assert result["blocked"] is True
    assert "待推送的代码" in result["reason"]
    assert "aws_access_key" in result["reason"]
