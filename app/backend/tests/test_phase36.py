# -*- coding: utf-8 -*-
"""Phase 36 新增测试：token 账本 / 标准合规 / 跨会话过滤 / 巡逻目标抽取"""
import sys, os, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8")

import pytest

from skill_loader import check_open_standard_compliance
from evolution_review import _CHARS_PER_TOKEN_EST, _SWEEP_TOKEN_BUDGET
import red_team_patrol as rtp


# ── 开放技能标准合规 ──────────────────────────────────────────────────────────

def test_std_compliant_skill():
    r = check_open_standard_compliance({
        "name": "my-skill", "description": "One line.", "version": "1.0.0",
    })
    assert r["compliant"] and r["issues"] == []


def test_std_upper_name_rejected():
    r = check_open_standard_compliance({"name": "My_Skill"})
    assert not r["compliant"]
    assert any("name" in i for i in r["issues"])


def test_std_bad_version_rejected():
    r = check_open_standard_compliance({"name": "ok", "version": "abc"})
    assert not r["compliant"]
    assert any("version" in i for i in r["issues"])


def test_std_unknown_platform_rejected():
    r = check_open_standard_compliance({"name": "ok", "platforms": ["macos", "toaster"]})
    assert not r["compliant"]
    assert any("platforms" in i for i in r["issues"])


def test_std_multiline_description_rejected():
    r = check_open_standard_compliance({"name": "ok", "description": "line1\nline2"})
    assert not r["compliant"]


def test_std_missing_fields_pass():
    # 缺失不扣分（drop 规则负责缺失），合规只管"写了就要对"
    assert check_open_standard_compliance({})["compliant"]


# ── token 账本常量 ──────────────────────────────────────────────────────────

def test_token_budget_constants():
    assert _SWEEP_TOKEN_BUDGET > 0
    assert _CHARS_PER_TOKEN_EST > 0


# ── 巡逻目标抽取 ─────────────────────────────────────────────────────────────

def test_extract_learned_rules(tmp_path):
    f = tmp_path / "AGENTS.md"
    f.write_text(
        "# Project\n\n## Learned Rules (evolution)\n- 规则一：先检查再写\n- 规则二：路径必须校验\n\n## 其他小节\n- 这不是进化规则\n",
        encoding="utf-8",
    )
    rules = rtp._extract_learned_rules(str(f))
    assert rules == ["规则一：先检查再写", "规则二：路径必须校验"]


def test_extract_learned_rules_missing_file(tmp_path):
    assert rtp._extract_learned_rules(str(tmp_path / "nope.md")) == []


def test_sample_cap_applied():
    # 超长规则截断到 _SAMPLE_CAP（常量存在且为 int）
    assert isinstance(rtp._SAMPLE_CAP, int) and rtp._SAMPLE_CAP > 0
