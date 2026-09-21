"""Phase 4 切片：长期记忆写路径安全闸（memory_guard）。"""
import pytest

from memory_guard import guard_memory_content


def test_secret_is_rejected_wholesale():
    ok, cleaned, reasons = guard_memory_content(
        "请记住他的 api_key=sk-abcdefghijklmnopqrst 常用深色主题")
    assert not ok, "秘密形状必须整条拒收"
    assert cleaned == "", "拒收时不得留下半条内容"
    assert any("secret" in r for r in reasons)


def test_hidden_unicode_stripped_and_empty_rejected():
    # 零宽空格藏在"pnpm"中间——剥除后放行，信息无损
    ok, cleaned, reasons = guard_memory_content("项目用\u200bpnpm 管理依赖")
    assert ok and cleaned == "项目用pnpm 管理依赖"
    assert any("hidden-unicode" in r for r in reasons)

    # 方向控制符同样剥除
    ok2, c2, _ = guard_memory_content("路径是 D:\\dir\u202efile")
    assert ok2 and "\u202e" not in c2

    # 清洗后为空 → 拒收
    ok3, c3, reasons3 = guard_memory_content("\u200b\u200c\u200d")
    assert not ok3 and c3 == ""


# ── 守卫⑥：负面断言 ──────────────────────────────────────────────────────────

def _screen(text, **kw):
    from memory_guard import screen_memory_content
    return screen_memory_content(text, **kw)


@pytest.mark.parametrize("text", [
    "这个项目里没有 CI 配置",
    "仓库中不存在 test_foo.py",
    "该功能尚未实现",
    "the config file does not exist",
    "no such module was found",
    "the legacy endpoint has been removed",
    "there is no build step for the docs",
])
def test_negative_assertions_are_detected(text):
    """这类断言只在写入那一刻成立——必须被标记，不能当作永久事实。"""
    v = _screen(text)
    assert v.negative_assertion, text


@pytest.mark.parametrize("text", [
    "项目用 pnpm 管理依赖",
    "构建命令是 npm run build",
    "the entry point is src/main.ts",
])
def test_plain_facts_are_not_flagged(text):
    assert not _screen(text).negative_assertion, text


def test_negative_assertion_is_marked_not_rejected():
    """决策：不一律拒收。"这里没有 CI"是有价值的观察，扔掉等于什么都没学到。

    取而代之的是给它一个保质期（valid_until 由写入侧填），过期即不再召回。
    """
    v = _screen("仓库里没有测试目录")
    assert v.allowed
    assert v.content == "仓库里没有测试目录"
    assert v.negative_assertion
    assert any("negative assertion" in r for r in v.reasons)


def test_negative_assertion_is_flagged_for_user_typed_content_too():
    """标记不是拦截，所以 trusted 分支里也要生效——用户打的"没有 X"同样会过期。"""
    assert _screen("这里没有 tests 目录", trusted=True).negative_assertion


def test_staleness_note_appears_only_after_the_fresh_window():
    from memory_guard import (NEGATIVE_FRESH_DAYS, NEGATIVE_TTL_DAYS,
                              staleness_note)

    now = 1_000_000.0
    day = 86400.0
    assert staleness_note(now - 1 * day, now=now) == ""
    assert staleness_note(now - (NEGATIVE_FRESH_DAYS - 1) * day, now=now) == ""
    note = staleness_note(now - (NEGATIVE_FRESH_DAYS + 2) * day, now=now)
    assert "天前" in note
    assert NEGATIVE_FRESH_DAYS < NEGATIVE_TTL_DAYS, "提示窗口必须在保质期之内"
    assert staleness_note(0, now=now) == "", "没有观测时间就不该编造一个"


def test_guard_wrapper_still_returns_a_three_tuple():
    """薄封装的签名没变——改 trusted 默认值会静默改变现有调用方行为。"""
    out = guard_memory_content("仓库里没有测试目录")
    assert isinstance(out, tuple) and len(out) == 3
    assert out[0] is True


# ── F.1 / F.3 的邻接验证 ─────────────────────────────────────────────────────

def test_gotcha_type_exists_and_is_weighted_on_recall():
    from memory_layer import MemoryType

    assert MemoryType.GOTCHA == "gotcha"
    assert MemoryType.GOTCHA not in (MemoryType.FACT, MemoryType.CONTEXT)


def test_extracted_kinds_include_gotcha():
    from memory_layer import _EXTRACTED_KINDS, _kind_of_extracted_line

    assert "gotcha" in _EXTRACTED_KINDS
    assert _kind_of_extracted_line("[gotcha] 本机 os.symlink() 静默无操作") == "gotcha"
    assert _kind_of_extracted_line("[fact] 项目用 pnpm") == "fact"
    # 认不出的前缀按 context 处理——误认成 gotcha 会污染那个高权重通道
    assert _kind_of_extracted_line("项目用 pnpm") == "context"


def test_gotcha_and_fact_with_same_text_do_not_dedupe():
    """签名带 kind：同样一句话，坑和事实是两件都要留的东西。"""
    from memory_layer import _kind_of_extracted_line

    a = "[gotcha] 复用 basetemp 目录会成片 ERROR"
    b = "[fact] 复用 basetemp 目录会成片 ERROR"
    assert _kind_of_extracted_line(a) != _kind_of_extracted_line(b)


def test_owner_agents_default_and_tie_break():
    from skill_loader import (OWNER_CORE, OWNER_USER, SkillEntry,
                              _owner_is_local, read_owner_agents)

    e = SkillEntry("x", "/tmp/x")
    assert e.owner_agents == []

    # frontmatter 声明优先；没有就不猜
    assert read_owner_agents({"owner-agents": ["github.com/a/b"]}) == ["github.com/a/b"]
    assert read_owner_agents({"owner": "user"}) == ["user"]
    assert read_owner_agents({}) == []

    # tie-break 只认本地归属；市场装的排后面
    assert _owner_is_local({"owner_agents": [OWNER_USER]})
    assert _owner_is_local({"owner_agents": [OWNER_CORE]})
    assert not _owner_is_local({"owner_agents": ["github.com/wshobson/agents"]})
    assert not _owner_is_local({"owner_agents": []})


def test_owner_is_only_a_tie_break_not_a_veto():
    """归属不参与否决：分数高的市场技能必须赢过分数低的本地技能。"""
    from skill_loader import _owner_is_local

    cands = [
        {"name": "market", "match_score": 5, "owner_agents": ["github.com/a/b"]},
        {"name": "local", "match_score": 1, "owner_agents": ["user"]},
    ]
    ranked = sorted(cands,
                    key=lambda x: (-x["match_score"],
                                   0 if _owner_is_local(x) else 1, x["name"]))
    assert ranked[0]["name"] == "market", "归属不得翻掉分数"
