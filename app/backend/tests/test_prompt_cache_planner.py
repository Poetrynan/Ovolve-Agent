# -*- coding: utf-8 -*-
"""prompt_cache_planner 单元测试：断点布局、安全纪律、注册表与作用域。"""
import pytest

from prompt_cache_planner import (
    CACHE_BREAKPOINT_KINDS,
    StablePrefixRegistry,
    get_stable_prefix_registry,
    plan_cache_breakpoints,
    resolve_cache_scope,
)


def _msgs(n_turns=3):
    """构造一条 system + n 轮 user/assistant 的对话。"""
    msgs = [{"role": "system", "content": "SYS_HEAD_STABLE_BODY"}]
    for i in range(n_turns):
        msgs.append({"role": "user", "content": f"q{i}"})
        msgs.append({"role": "assistant", "content": f"a{i}"})
    return msgs


def _markers(msg):
    """取一条消息里的 cache_control 标记数。"""
    content = msg.get("content")
    if isinstance(content, str):
        return 1 if "cache_control" in content else 0
    if isinstance(content, list):
        return sum(1 for b in content if "cache_control" in b)
    return 0


def _all_markers(msgs):
    return [(i, _markers(m)) for i, m in enumerate(msgs) if _markers(m)]


# ── kind 白名单 ──────────────────────────────────────────────────────────────

def test_unknown_kind_is_noop():
    msgs = _msgs()
    plan = plan_cache_breakpoints(msgs, system_prefix="SYS_HEAD", kind="openai")
    assert plan.messages is msgs  # 原列表直接返回，连复制都不做
    assert plan.breakpoints == ()
    assert _all_markers(plan.messages) == []


def test_known_kinds_accepted():
    for kind in CACHE_BREAKPOINT_KINDS:
        plan = plan_cache_breakpoints(_msgs(3), system_prefix="SYS_HEAD", kind=kind)
        assert plan.breakpoints, f"{kind} should place breakpoints"


# ── system 前缀断点 ──────────────────────────────────────────────────────────

def test_system_prefix_breakpoint():
    msgs = _msgs(1)
    plan = plan_cache_breakpoints(msgs, system_prefix="SYS_HEAD", kind="anthropic")
    assert "system_prefix" in plan.breakpoints
    content = plan.messages[0]["content"]
    assert isinstance(content, list)
    assert content[0]["text"] == "SYS_HEAD"
    assert content[0]["cache_control"]["type"] == "ephemeral"
    assert content[1]["text"] == "_STABLE_BODY"
    assert "cache_control" not in content[1]


def test_prefix_mismatch_is_noop():
    msgs = _msgs(1)
    plan = plan_cache_breakpoints(msgs, system_prefix="NOT_A_PREFIX", kind="anthropic")
    assert "system_prefix" not in plan.breakpoints
    assert plan.messages[0]["content"] == "SYS_HEAD_STABLE_BODY"  # 原样


def test_prefix_consuming_whole_message_is_noop():
    plan = plan_cache_breakpoints(_msgs(1), system_prefix="SYS_HEAD_STABLE_BODY", kind="anthropic")
    assert "system_prefix" not in plan.breakpoints
    # 断点后必须还有内容，否则缓存了也没复用


def test_no_system_message_is_noop():
    msgs = [{"role": "user", "content": "hi"}]
    plan = plan_cache_breakpoints(msgs, system_prefix="anything", kind="anthropic")
    assert plan.breakpoints == ()


def test_structured_system_content_is_noop():
    # 已是 block 列表的消息不归我们布局
    msgs = [{"role": "system", "content": [{"type": "text", "text": "SYS_HEAD_X"}]}]
    plan = plan_cache_breakpoints(msgs, system_prefix="SYS_HEAD", kind="anthropic")
    assert "system_prefix" not in plan.breakpoints


# ── 对话尾部断点 ────────────────────────────────────────────────────────────

def test_tail_breakpoints_on_second_and_third_last():
    msgs = _msgs(3)  # system + 6 条
    plan = plan_cache_breakpoints(msgs, kind="anthropic")
    tail = [b for b in plan.breakpoints if b.startswith("tail:")]
    assert len(tail) == 2
    # 倒数第 2、3 条非 system（索引 4、5：a1、q2），最末条 a2(6) 不打
    marked = {i for i, _ in _all_markers(plan.messages)}
    assert marked == {4, 5}
    # 最末条不加断点
    assert _markers(plan.messages[-1]) == 0


def test_tail_breakpoints_skip_when_few_turns():
    plan = plan_cache_breakpoints(_msgs(1), kind="anthropic")  # 2 条非 system
    assert not [b for b in plan.breakpoints if b.startswith("tail:")]
    plan = plan_cache_breakpoints(_msgs(0), kind="anthropic")  # 0 条
    assert not [b for b in plan.breakpoints if b.startswith("tail:")]


def test_plan_does_not_mutate_input():
    msgs = _msgs(3)
    snapshot = [dict(m) for m in msgs]
    plan_cache_breakpoints(msgs, system_prefix="SYS_HEAD", kind="anthropic")
    assert msgs == snapshot  # 原列表逐条不变


def test_system_tail_breakpoint_opt_in():
    plan = plan_cache_breakpoints(_msgs(1), kind="anthropic", system_tail=True)
    assert "system_tail" in plan.breakpoints
    content = plan.messages[0]["content"]
    assert content[-1]["cache_control"]["type"] == "ephemeral"


def test_system_tail_default_off():
    plan = plan_cache_breakpoints(_msgs(1), kind="anthropic")
    assert "system_tail" not in plan.breakpoints


# ── 注册表 ───────────────────────────────────────────────────────────────────

def test_registry_register_get():
    reg = StablePrefixRegistry(max_entries=8, max_total_chars=10000)
    reg.register("skill:alpha", "STATIC_SCAFFOLD_A")
    assert reg.get("skill:alpha") == "STATIC_SCAFFOLD_A"
    assert reg.get("missing") == ""


def test_registry_rerun_refreshes():
    reg = StablePrefixRegistry(max_entries=8, max_total_chars=10000)
    reg.register("k", "OLD")
    reg.register("k", "NEW_LONGER")
    assert reg.get("k") == "NEW_LONGER"
    assert reg.size() == 1


def test_registry_lru_eviction_by_count():
    reg = StablePrefixRegistry(max_entries=3, max_total_chars=10000)
    for i in range(4):
        reg.register(f"k{i}", f"PREFIX_{i}")
    assert reg.size() == 3
    assert reg.get("k0") == ""  # 最旧被逐出
    assert reg.get("k3") == "PREFIX_3"


def test_registry_eviction_by_total_chars_keeps_newest():
    reg = StablePrefixRegistry(max_entries=100, max_total_chars=30)
    reg.register("big1", "X" * 20)
    reg.register("big2", "Y" * 20)  # 总量 40 > 30 → 逐出 big1
    assert reg.size() == 1
    assert reg.get("big2") == "Y" * 20
    reg.register("big3", "Z" * 20)
    assert reg.get("big3") == "Z" * 20  # 最新一条永远保留


def test_registry_longest_match():
    reg = StablePrefixRegistry(max_entries=8, max_total_chars=10000)
    reg.register("short", "ABC")
    reg.register("long", "ABCDEF")
    key, prefix = reg.longest_match("ABCDEFGHIJ")
    assert key == "long" and prefix == "ABCDEF"
    assert reg.longest_match("XYZ") == ("", "")


def test_global_registry_singleton():
    assert get_stable_prefix_registry() is get_stable_prefix_registry()


# ── 作用域 ───────────────────────────────────────────────────────────────────

def test_cache_scope_defaults_to_session():
    assert resolve_cache_scope("sess-1") == "sess-1"
    assert resolve_cache_scope("sess-1", lineage_root="root-0") == "root-0"
    assert resolve_cache_scope("") == ""
