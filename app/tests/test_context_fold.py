"""Test the context fold (compaction) engine.

Covers the three-layer degradation chain, the loop guards, token estimation and
the microfold pass. Storage is stubbed so tests don't touch the real SQLite.
"""
import asyncio
import json
import time
import pytest

import context_compactor as cc
from context_compactor import (
    ContextCompactor,
    FOLD_PLACEHOLDER,
    PRESERVED_SECTION_TITLE,
)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def stub_storage(monkeypatch):
    """Keep add_compaction from hitting the real database."""
    class _S:
        def __init__(self):
            self.saved = []

        def add_compaction(self, sid, summary, tb, ta):
            self.saved.append((sid, summary, tb, ta))

    s = _S()
    monkeypatch.setattr(cc, "get_storage", lambda: s)
    return s


def msgs(n_user=3, n_asst=2):
    out = []
    for i in range(n_user):
        out.append({"role": "user", "content": f"用户消息 {i} " + "x" * 100})
    for i in range(n_asst):
        out.append({"role": "assistant", "content": f"助手回复 {i} " + "y" * 100})
    return out


# ── Token estimation ────────────────────────────────────────────────────────

def test_chinese_is_not_underestimated():
    """A pure `len//4` estimate halves Chinese; ~1.8 chars/token is closer."""
    c = ContextCompactor()
    chinese = "上下文压缩与加密系统" * 10  # 100 Chinese chars
    assert c.estimate_tokens(chinese) > len(chinese) // 4


def test_empty_text_is_zero_tokens():
    assert ContextCompactor().estimate_tokens("") == 0


def test_total_tokens_sums_messages():
    c = ContextCompactor()
    m = [{"role": "user", "content": "abcd"}, {"role": "user", "content": "efgh"}]
    assert c.total_tokens(m) == c.estimate_tokens("abcd") + c.estimate_tokens("efgh")


# ── should_fold: the three guards ───────────────────────────────────────────

def test_under_threshold_does_not_fold():
    c = ContextCompactor(max_tokens=100_000)
    ok, reason = c.should_fold(msgs(), manual=False)
    assert (ok, reason) == (False, "under-threshold")


def test_reserved_headroom_defaults_to_15_percent_capped_at_20k():
    """Small windows get 15%, big windows cap at 20K — mirrors Kilo's rule."""
    small = ContextCompactor(max_tokens=8_000)
    assert small.reserved_tokens == 1_200
    big = ContextCompactor(max_tokens=1_000_000)
    assert big.reserved_tokens == 20_000


def test_usable_tokens_excludes_reserved():
    c = ContextCompactor(max_tokens=100_000, reserved_tokens=20_000)
    assert c.usable_tokens == 80_000


def test_usage_ratio_is_relative_to_usable_window():
    """A message that fills the usable window should ratio == 1.0."""
    c = ContextCompactor(max_tokens=100_000, reserved_tokens=20_000)
    # Fabricate content whose estimated tokens ≈ usable window.
    tokens_needed = c.usable_tokens
    m = [{"role": "user", "content": "a" * (tokens_needed * 4)}]
    assert c.usage_ratio(m) >= 0.99


def test_over_threshold_folds():
    c = ContextCompactor(max_tokens=100, reserved_tokens=0)  # tiny budget → over
    ok, reason = c.should_fold(msgs(), manual=False)
    assert ok and reason == "auto"


def test_cooldown_blocks_auto_fold():
    c = ContextCompactor(cooldown_s=999, reserved_tokens=0)
    m = msgs()
    # Size the budget so usage sits between threshold and emergency — cooldown
    # only applies in that band (past emergency it's bypassed).
    # Must measure with estimate_tokens_multi, the same signal should_fold uses:
    # total_tokens is only one of its inputs and the byte floor runs higher on
    # Chinese content, which would push the ratio past emergency.
    total = c.estimate_tokens_multi(m)
    c.max_tokens = int(total / 0.85)
    c._last_fold_at = time.time()
    c._folded_upto = 0
    ok, reason = c.should_fold(m, manual=False)
    assert (ok, reason) == (False, "cooldown")


def test_emergency_threshold_bypasses_cooldown():
    """Past the emergency line, waiting out the cooldown risks a hard failure."""
    c = ContextCompactor(max_tokens=10, cooldown_s=999, reserved_tokens=0)  # ratio >> 0.90
    c._last_fold_at = time.time()
    ok, reason = c.should_fold(msgs(), manual=False)
    assert ok and reason == "auto"


def test_no_new_content_blocks_auto_fold():
    c = ContextCompactor(cooldown_s=0, reserved_tokens=0)
    m = msgs()
    total = c.estimate_tokens_multi(m)
    c.max_tokens = int(total / 0.85)  # in the (threshold, emergency) band
    c._folded_upto = len(m)
    ok, reason = c.should_fold(m, manual=False)
    assert (ok, reason) == (False, "no-new-content")


def test_manual_bypasses_cooldown_and_threshold():
    c = ContextCompactor(max_tokens=100_000, cooldown_s=999)
    c._last_fold_at = time.time()
    c._folded_upto = 99
    ok, reason = c.should_fold(msgs(), manual=True)
    assert ok and reason == "manual"


def test_manual_still_respects_max_consecutive():
    """Clicking fold ten times in a row must not burn the budget on summaries."""
    c = ContextCompactor(max_consecutive=2)
    c._consecutive = 2
    ok, reason = c.should_fold(msgs(), manual=True)
    assert (ok, reason) == (False, "max-consecutive")


def test_manual_refuses_a_trivial_conversation():
    c = ContextCompactor()
    ok, reason = c.should_fold([{"role": "user", "content": "hi"}], manual=True)
    assert (ok, reason) == (False, "too-short")


def test_reentrancy_guard():
    c = ContextCompactor()
    c._folding = True
    ok, reason = c.should_fold(msgs(), manual=True)
    assert (ok, reason) == (False, "already-folding")


def test_note_new_turn_resets_consecutive():
    c = ContextCompactor()
    c._consecutive = 4
    c.note_new_turn()
    assert c._consecutive == 0


# ── The three-layer chain ───────────────────────────────────────────────────

def test_layer1_llm_summary_is_preferred():
    c = ContextCompactor()

    async def summarizer(_m):
        return {"Goal": "把功能做完", "Progress": ["写了 compactor"], "Decisions": [], "Open Issues": []}

    c.set_summarizer(summarizer)
    r = run(c.fold("s1", msgs()))
    assert r.ok
    assert r.value["strategy"] == "llm-summary"
    assert "把功能做完" in r.value["summary"]


def test_layer2_heuristic_when_no_summarizer():
    c = ContextCompactor()
    r = run(c.fold("s1", msgs()))
    assert r.ok and r.value["strategy"] == "engineering"
    assert "用户诉求" in r.value["summary"]


def test_llm_failure_degrades_to_heuristic():
    """A throwing summarizer must not fail the fold."""
    c = ContextCompactor()

    async def boom(_m):
        raise RuntimeError("model down")

    c.set_summarizer(boom)
    r = run(c.fold("s1", msgs()))
    assert r.ok and r.value["strategy"] == "engineering"


def test_llm_returning_none_degrades_to_heuristic():
    c = ContextCompactor()

    async def nothing(_m):
        return None

    c.set_summarizer(nothing)
    r = run(c.fold("s1", msgs()))
    assert r.ok and r.value["strategy"] == "engineering"


def test_layer3_truncate_when_heuristic_explodes(monkeypatch):
    c = ContextCompactor()
    monkeypatch.setattr(
        c, "_heuristic_summary", lambda _m: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    r = run(c.fold("s1", msgs()))
    assert r.ok and r.value["strategy"] == "truncate"
    assert "降级兜底" in r.value["summary"]


def test_empty_history_fails_cleanly():
    c = ContextCompactor()
    r = run(c.fold("s1", []))
    assert not r.ok


# ── Report shape & bookkeeping ──────────────────────────────────────────────

def test_report_fields():
    c = ContextCompactor()
    r = run(c.fold("s1", msgs()))
    v = r.value
    for key in ("summary", "strategy", "tokensBefore", "estimatedTokensAfter",
                "compressionRatio", "encrypted", "manual"):
        assert key in v


def test_fold_shrinks_the_context():
    c = ContextCompactor()
    r = run(c.fold("s1", msgs(n_user=10, n_asst=10)))
    assert r.value["estimatedTokensAfter"] < r.value["tokensBefore"]
    assert r.value["compressionRatio"] > 1


def test_fold_persists_to_storage(stub_storage):
    c = ContextCompactor()
    run(c.fold("sess-42", msgs()))
    assert stub_storage.saved and stub_storage.saved[0][0] == "sess-42"


def test_storage_failure_does_not_fail_the_fold(monkeypatch):
    """The summary is still needed for THIS turn even if the write fails."""
    class Broken:
        def add_compaction(self, *a):
            raise IOError("disk full")

    monkeypatch.setattr(cc, "get_storage", lambda: Broken())
    c = ContextCompactor()
    r = run(c.fold("s1", msgs()))
    assert r.ok


def test_stats_accumulate():
    c = ContextCompactor()
    r = run(c.fold("s1", msgs(n_user=10, n_asst=10)))
    st = c.stats()
    assert st["totalFolds"] == 1
    assert st["totalTokensSaved"] > 0


def test_folding_flag_is_released_on_failure(monkeypatch):
    c = ContextCompactor()
    monkeypatch.setattr(
        c, "_truncate_summary", lambda *a, **k: (_ for _ in ()).throw(RuntimeError())
    )
    monkeypatch.setattr(
        c, "_heuristic_summary", lambda _m: (_ for _ in ()).throw(RuntimeError())
    )
    with pytest.raises(RuntimeError):
        run(c.fold("s1", msgs()))
    assert c._folding is False  # the finally block must have run


# ── Microfold ───────────────────────────────────────────────────────────────
#
# 注意这些用例手搓的 ``msg_type="tool_call"`` 行：``storage.add_message`` 的调用点
# 只写 user / assistant / interrupt_note，生产数据里从来没有这种行。所以下面这几个
# 用例证明的是「微折叠这个函数本身算得对」，不是「微折叠在真实会话里生效」——它在
# 真实折叠里恒等于零操作。别把它们的绿色当成折叠路径已被覆盖。

def test_microfold_clears_tool_results_beyond_the_recency_budget():
    # Tiny prune window → only the newest result fits, older ones get cleared.
    c = ContextCompactor(prune_window_tokens=40)
    big = "x" * 100  # ~25 tokens each
    history = [
        {"role": "tool", "msg_type": "tool_call", "tool_name": "read_file", "content": big + " A"},
        {"role": "tool", "msg_type": "tool_call", "tool_name": "read_file", "content": big + " B"},
        {"role": "tool", "msg_type": "tool_call", "tool_name": "read_file", "content": big + " newest"},
    ]
    cleared = c._microfold(history)
    assert cleared >= 1
    assert history[2]["content"].endswith("newest")  # newest always kept
    assert history[0]["content"] == FOLD_PLACEHOLDER


def test_microfold_keeps_everything_within_budget():
    c = ContextCompactor(prune_window_tokens=100_000)  # generous → nothing cleared
    history = [
        {"role": "tool", "msg_type": "tool_call", "tool_name": "read_file", "content": "small"},
        {"role": "tool", "msg_type": "tool_call", "tool_name": "read_file", "content": "also small"},
    ]
    assert c._microfold(history) == 0


def test_microfold_leaves_conversation_alone():
    c = ContextCompactor(prune_window_tokens=0)
    history = [{"role": "user", "content": "别动我"}, {"role": "assistant", "content": "好"}]
    assert c._microfold(history) == 0
    assert history[0]["content"] == "别动我"


def test_microfold_skips_unlisted_tools():
    """Only one-shot output tools are foldable; unknown tools stay untouched."""
    c = ContextCompactor(prune_window_tokens=0)
    history = [
        {"role": "tool", "msg_type": "tool_call", "tool_name": "run_goal", "content": "keep 1"},
        {"role": "tool", "msg_type": "tool_call", "tool_name": "run_goal", "content": "keep 2"},
    ]
    assert c._microfold(history) == 0


def test_microfold_is_idempotent():
    c = ContextCompactor(prune_window_tokens=0)  # clear everything foldable
    history = [
        {"role": "tool", "msg_type": "tool_call", "tool_name": "grep", "content": "a" * 100},
        {"role": "tool", "msg_type": "tool_call", "tool_name": "grep", "content": "b" * 100},
    ]
    c._microfold(history)
    assert c._microfold(history) == 0  # already placeholders, nothing more to do


# ── 附件守恒（折叠不许把图片弄丢）─────────────────────────────────────────────
#
# 折痕之后 ``_build_history`` 只回放两种东西：user/assistant 正文，和这份摘要
# （作为 system 行）。图片的真实引用只在 assistant 行的 metadata 里，正文里只有
# 一句 `[图片: name]` —— 一旦摘要器没提它，模型就再也不知道自己生成过图。所以
# 占位行必须由代码原样拼进摘要，这几条用例守的就是这个不变量。

def img_history(n):
    """n 张图：偶数号在 metadata（模型生成），奇数号只有正文痕迹（用户贴图）。"""
    rows = [{"role": "user", "content": f"用户 {i} " + "x" * 200, "metadata": "{}"}
            for i in range(4)]
    for i in range(n):
        if i % 2 == 0:
            rows.append({
                "role": "assistant",
                "content": f"回复 {i} " + "y" * 200 + f"\n[图片: gen_{i}.png]",
                # get_messages 返回的 metadata 是 JSON 文本，不是 dict
                "metadata": json.dumps({"images": [{"id": f"id{i}", "name": f"gen_{i}.png"}]}),
            })
        else:
            rows.append({
                "role": "assistant",
                "content": f"回复 {i} 关于 [图片: paste_{i}.png] " + "z" * 200,
                "metadata": "{}",
            })
    return rows


async def _summarizer_that_drops_images(messages):
    """一个「合格」摘要：标识符齐全能过 audit，但一张图都没提。"""
    return {"Goal": "把 foo.py 的 do_thing() 修好", "Progress": "改了 bar.py",
            "Decisions": ["用 CONST_X"], "Open Issues": []}


def test_fold_preserves_every_image_reference():
    n = 5
    c = ContextCompactor(max_tokens=8000)
    c.set_summarizer(_summarizer_that_drops_images)
    report = run(c.fold("s1", img_history(n), manual=True)).value
    summary = report["summary"]

    # 前提成立：摘要器那一段确实把图全丢了，否则这条用例什么也没证明
    llm_part = summary.split(PRESERVED_SECTION_TITLE)[0]
    assert "gen_0.png" not in llm_part and "paste_1.png" not in llm_part

    for i in range(n):
        name = f"gen_{i}.png" if i % 2 == 0 else f"paste_{i}.png"
        assert f"[图片已折叠：{name}]" in summary
    assert report["preservedArtifacts"] == n


def test_fold_deduplicates_repeated_image_mentions():
    """同一张图在 metadata 和正文里各出现一次，只该留一行。"""
    c = ContextCompactor(max_tokens=8000)
    history = [
        {"role": "assistant", "content": "[图片: same.png]",
         "metadata": json.dumps({"images": [{"name": "same.png"}]})},
        {"role": "assistant", "content": "又提了一次 [图片: same.png]", "metadata": "{}"},
    ] + [{"role": "user", "content": f"u{i} " + "x" * 100, "metadata": "{}"} for i in range(3)]
    assert run(c.fold("s1", history, manual=True)).value["preservedArtifacts"] == 1


def test_fold_without_images_adds_no_section():
    """没图的会话不该多出一个空标题，也不该多烧 token。"""
    c = ContextCompactor(max_tokens=8000)
    report = run(c.fold("s1", msgs(), manual=True)).value
    assert report["preservedArtifacts"] == 0
    assert PRESERVED_SECTION_TITLE not in report["summary"]


def test_fold_survives_unparseable_metadata():
    """metadata 坏了当作没图，绝不能让折叠整体失败。"""
    c = ContextCompactor(max_tokens=8000)
    history = [
        {"role": "assistant", "content": "x" * 200, "metadata": "{not json"},
        {"role": "user", "content": "y" * 200, "metadata": None},
        {"role": "user", "content": "z" * 200, "metadata": 42},
    ]
    assert run(c.fold("s1", history, manual=True)).ok


def test_oversized_replacement_spares_image_bearing_rows():
    """超大消息换占位备注时必须跳过带图的行，否则图片痕迹在摘要器读到前就没了。"""
    c = ContextCompactor(max_tokens=1000)  # 极小窗口，让阈值容易触发
    big = "x" * 20_000
    history = [
        {"role": "assistant", "content": big,
         "metadata": json.dumps({"images": [{"name": "keep.png"}]})},
        {"role": "assistant", "content": big, "metadata": "{}"},
    ]
    replaced = c.replace_oversized(history)
    assert replaced == 1                       # 只换了没图的那条
    assert history[0]["content"] == big        # 带图的那条原样保留


# ── Encryption hooks (implementation deferred) ──────────────────────────────


def test_seal_is_a_passthrough_while_encryption_is_off():
    c = ContextCompactor()
    sealed, encrypted = c._seal("明文")
    assert (sealed, encrypted) == ("明文", False)


def test_unseal_roundtrips_plaintext():
    c = ContextCompactor()
    assert c._unseal("明文") == "明文"


def test_report_marks_not_encrypted():
    c = ContextCompactor()
    r = run(c.fold("s1", msgs()))
    assert r.value["encrypted"] is False


# ── sqlite3.Row tolerance ───────────────────────────────────────────────────

def test_handles_row_like_objects():
    """storage.get_messages returns sqlite3.Row, not dict."""
    class Row:
        def __init__(self, d):
            self._d = d

        def __getitem__(self, k):
            return self._d[k]

        def keys(self):
            return self._d.keys()

    c = ContextCompactor()
    rows = [Row({"role": "user", "content": "来自 Row 的消息" * 20, "msg_type": "message"})
            for _ in range(3)]
    r = run(c.fold("s1", rows))
    assert r.ok
