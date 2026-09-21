# -*- coding: utf-8 -*-
"""Phase 35 三项测试：缓存 TTL 档位 / 压缩谱系作用域 / MoA 会诊组件。"""
import asyncio
import pytest

from prompt_cache_planner import plan_cache_breakpoints, CACHE_TTLS
from context_compactor import ContextCompactor
from moa import (
    AdvisorOpinion,
    build_council_block,
    select_advisors,
    strip_moa_prefix,
    MOA_PREFIX,
)


# ── 1h TTL 档位 ──────────────────────────────────────────────────────────────

def _msgs():
    return [
        {"role": "system", "content": "STABLE_HEAD tail_here"},
        {"role": "user", "content": "q0"},
        {"role": "assistant", "content": "a0"},
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "q2"},
    ]


def test_default_ttl_is_plain_ephemeral():
    plan = plan_cache_breakpoints(_msgs(), system_prefix="STABLE_HEAD", kind="anthropic")
    content = plan.messages[0]["content"]
    assert content[0]["cache_control"] == {"type": "ephemeral"}
    assert "ttl" not in content[0]["cache_control"]


def test_1h_ttl_lands_on_markers():
    plan = plan_cache_breakpoints(
        _msgs(), system_prefix="STABLE_HEAD", kind="anthropic", ttl="1h",
    )
    content = plan.messages[0]["content"]
    assert content[0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    # 尾部断点也带 ttl（排除 system 消息）
    tail_marked = [m for m in plan.messages[1:] if _has_ttl(m)]
    assert len(tail_marked) == 2


def _has_ttl(msg):
    c = msg.get("content")
    if isinstance(c, list):
        return any(b.get("cache_control", {}).get("ttl") == "1h" for b in c)
    return False


def test_bad_ttl_is_noop():
    msgs = _msgs()
    plan = plan_cache_breakpoints(msgs, system_prefix="STABLE_HEAD", kind="anthropic", ttl="99h")
    assert plan.breakpoints == () and plan.messages is msgs


def test_ttl_whitelist():
    assert CACHE_TTLS == {"", "1h"}


# ── 压缩谱系作用域 ───────────────────────────────────────────────────────────

def test_cache_scope_defaults_to_session():
    c = ContextCompactor()
    c.session_id = "sess-1"
    assert c.cache_scope() == "sess-1"


def test_cache_scope_lineage_overrides():
    c = ContextCompactor()
    c.session_id = "sess-rotated"
    c._lineage_root = "root-original"
    assert c.cache_scope() == "root-original"


def test_note_folded_increments():
    c = ContextCompactor()
    c.note_folded(); c.note_folded()
    assert c._fold_count == 2


# ── MoA 组件 ────────────────────────────────────────────────────────────────

def test_strip_moa_prefix():
    ok, rest = strip_moa_prefix("/moa 设计一个缓存方案")
    assert ok is True and rest == "设计一个缓存方案"
    ok2, rest2 = strip_moa_prefix("/MOA uppercase trigger")
    assert ok2 is True and rest2 == "uppercase trigger"
    ok3, rest3 = strip_moa_prefix("普通消息 /moa 在中间不算")
    assert ok3 is False and rest3 == "普通消息 /moa 在中间不算"
    ok4, rest4 = strip_moa_prefix("/moa")
    assert ok4 is True and rest4 == ""


def test_select_advisors_excludes_same_provider():
    cands = [
        {"provider_id": "p1", "model_id": "main-1"},
        {"provider_id": "p1", "model_id": "main-1-lite"},
        {"provider_id": "p2", "model_id": "rival"},
        {"provider_id": "p3", "model_id": "third"},
    ]
    picked = select_advisors(cands, "main-1", limit=2)
    # 主模型的 provider 整体排除（同厂血统，观点相关性高）
    assert [c["model_id"] for c in picked] == ["rival", "third"]


def test_select_advisors_empty_pool():
    assert select_advisors([], "anything") == []
    assert select_advisors(None, "anything") == []


def test_council_block_skips_failed():
    ops = [
        AdvisorOpinion("good-model", "p1", ok=True, text="先验证再实施"),
        AdvisorOpinion("dead-model", "p2", ok=False, error="timeout"),
    ]
    block = build_council_block(ops)
    assert "先验证再实施" in block and "good-model" in block
    assert "dead-model" not in block
    assert "非标准答案" in block  # 批判性采纳的框架指令必须在


def test_council_block_empty_when_all_failed():
    ops = [AdvisorOpinion("m", "p", ok=False, error="boom")]
    assert build_council_block(ops) == ""


def test_council_block_all_ok():
    ops = [
        AdvisorOpinion("a", "p1", ok=True, text="one"),
        AdvisorOpinion("b", "p2", ok=True, text="two"),
    ]
    block = build_council_block(ops)
    assert "one" in block and "two" in block
