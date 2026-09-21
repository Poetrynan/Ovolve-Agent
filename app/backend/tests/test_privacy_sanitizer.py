"""
test_privacy_sanitizer.py — 物理隐私脱敏与敏感信息清洗管道单元测试。
"""
import pytest
import os
import sys

# Ensure app/backend is in sys.path
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from sanitizer import PrivacySanitizer


def test_sanitize_windows_paths():
    raw_text = "Screenshots are saved to C:\\Users\\Administrator\\Desktop\\Ovolve\\output\\test.png directory."
    cleaned_zh = PrivacySanitizer.clean(raw_text, lang="zh")
    assert "C:\\Users" not in cleaned_zh
    assert "项目 output/ 目录" in cleaned_zh or "output" in cleaned_zh

    cleaned_en = PrivacySanitizer.clean(raw_text, lang="en")
    assert "C:\\Users" not in cleaned_en
    assert "output/ directory" in cleaned_en or "output" in cleaned_en


def test_sanitize_api_keys_and_secrets():
    raw_text = "Connected with sk-1234567890abcdef1234567890abcdef and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    cleaned = PrivacySanitizer.clean(raw_text)
    assert "sk-1234567890abcdef" not in cleaned
    assert "ghp_ABCDEFGHIJKLMNOP" not in cleaned
    assert "[REDACTED_SECRET]" in cleaned


def test_sanitize_workspace_relative():
    ws = r"d:\Example Workspace"
    raw_text = r"Building bundle at d:\Example Workspace\dist\bundle.js"
    cleaned = PrivacySanitizer.clean(raw_text, workspace_root=ws, lang="zh")
    assert "d:\\Ovolve Agent" not in cleaned
    assert "项目根目录" in cleaned or "dist" in cleaned
