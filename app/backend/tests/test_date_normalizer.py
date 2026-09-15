# -*- coding: utf-8 -*-
"""
test_date_normalizer.py — 单元测试：相对时间转绝对日期规范化器 (Phase 61)。
"""
import time
import datetime
from sanitizer import DateNormalizer, PrivacySanitizer


def test_date_normalizer_chinese():
    ref_dt = datetime.datetime(2026, 9, 2, 12, 0, 0)
    ref_time = ref_dt.timestamp()

    text = "昨天构建报错，前天调整了配置，今天准备上线，上周完成评审，3天前修复了漏洞。"
    normalized = DateNormalizer.normalize(text, ref_time=ref_time)

    assert "2026-09-01 (昨天)" in normalized
    assert "2026-08-31 (前天)" in normalized
    assert "2026-09-02 (今天)" in normalized
    assert "2026-08-26 (上周)" in normalized
    assert "2026-08-30 (3天前)" in normalized


def test_date_normalizer_english():
    ref_dt = datetime.datetime(2026, 9, 2, 12, 0, 0)
    ref_time = ref_dt.timestamp()

    text = "Yesterday the build failed, the day before yesterday we merged PR, today it is running, last week we audited code, 5 days ago we fixed it."
    normalized = DateNormalizer.normalize(text, ref_time=ref_time)

    assert "2026-09-01 (yesterday)" in normalized
    assert "2026-08-31 (the day before yesterday)" in normalized
    assert "2026-09-02 (today)" in normalized
    assert "2026-08-26 (last week)" in normalized
    assert "2026-08-28 (5 days ago)" in normalized


def test_privacy_sanitizer_integration_with_date():
    ref_dt = datetime.datetime(2026, 9, 2, 12, 0, 0)
    ref_time = ref_dt.timestamp()

    raw_text = "昨天在 C:\\Users\\Administrator\\output 发现 sk-12345678901234567890 泄露"
    cleaned = PrivacySanitizer.clean(raw_text)

    assert "output/ 目录" in cleaned or "output/ directory" in cleaned
    assert "sk-12345678901234567890" not in cleaned
    assert "[REDACTED_SECRET]" in cleaned
