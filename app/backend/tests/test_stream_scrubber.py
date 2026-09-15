# -*- coding: utf-8 -*-
"""stream_scrubber 单元测试：跨 delta 边界、状态切换、flush 语义。"""
import random
import pytest

from stream_scrubber import StreamingThinkScrubber, scrub_static


def feed_all(parts):
    """按片段喂流，返回 (拼接正文, 拼接思考)。"""
    s = StreamingThinkScrubber()
    vis, th = [], []
    for p in parts:
        v, r = s.feed(p)
        if v: vis.append(v)
        if r: th.append(r)
    v, r = s.flush()
    if v: vis.append(v)
    if r: th.append(r)
    return "".join(vis), "".join(th)


def test_single_delta_complete_block():
    v, r = feed_all(["<think>abc</think>hello"])
    assert v == "hello"
    assert r == "abc"


def test_tag_split_across_deltas():
    # <think> 切在两个 delta 边界
    v, r = feed_all(["<th", "ink>reasoning here</thi", "nk>answer"])
    assert v == "answer"
    assert r == "reasoning here"


def test_close_tag_split_across_deltas():
    v, r = feed_all(["<think>abc</th", "ink>done"])
    assert v == "done"
    assert r == "abc"


def test_prose_before_and_after():
    v, r = feed_all(["hi <think>deep", " thought</think> bye"])
    assert v == "hi  bye"
    assert r == "deep thought"


def test_partial_tag_prefix_is_held_then_released():
    # 结尾像 <think> 前缀但其实是正文——flush 必须原样吐回
    v, r = feed_all(["the temperature < th", "an 100 is fine"])
    assert v == "the temperature < than 100 is fine"
    assert r == ""


def test_unclosed_block_flushes_as_reasoning():
    v, r = feed_all(["<think>truncated mid-thought"])
    assert v == ""
    assert r == "truncated mid-thought"


def test_multiple_blocks():
    v, r = feed_all(["A<think>x</think>B<think>y</think>C"])
    assert v == "ABC"
    assert r == "xy"


def test_pure_prose_untouched():
    v, r = feed_all(["no tags at all, just plain text"])
    assert v == "no tags at all, just plain text"
    assert r == ""


def test_empty_deltas_ignored():
    s = StreamingThinkScrubber()
    assert s.feed("") == ("", "")
    assert s.feed("<think>x</think>ok") == ("ok", "x")  # 同一次 drain 可同时交付两侧
    v, r = s.flush()
    assert v == "" and r == ""  # 'ok' 已在同一次 feed 交付


def test_think_inside_prose_word_not_triggered():
    # "thinking" 里的 "think" 不是标签——标签匹配必须精确
    v, r = feed_all(["I am thinking out loud"])
    assert v == "I am thinking out loud"
    assert r == ""


def test_random_splitting_preserves_semantics():
    """把若干已知样本随机切块喂流，结果必须与整串喂入一致。"""
    random.seed(42)
    samples = [
        ("A<think>x</think>B", "AB", "x"),
        ("<think>long reasoning</think>final", "final", "long reasoning"),
        ("<think>a</think><think>b</think>ok", "ok", "ab"),
        ("pre <think>mid</think> post", "pre  post", "mid"),
    ]
    for text, want_v, want_r in samples:
        for _ in range(20):
            # 随机切点
            cuts = sorted(random.sample(range(1, len(text)), min(3, len(text) - 1)))
            parts, prev = [], 0
            for c in cuts:
                parts.append(text[prev:c]); prev = c
            parts.append(text[prev:])
            assert feed_all(parts) == (want_v, want_r), (parts,)


# ── 非流式 ──────────────────────────────────────────────────────────────────

def test_scrub_static_basic():
    v, r = scrub_static("answer <think>hidden</think> tail")
    assert v == "answer  tail"
    assert r == "hidden"


def test_scrub_static_unclosed():
    v, r = scrub_static("text <think>leaked")
    # 未闭合的 think 块整体归入 reasoning，正文只留标签前的可见文本。
    #
    # 这里曾断言 "text "（保留尾随空格）。该断言写于 9604c92c（hardening 前的
    # 基线快照），而 strip_protocol_tags 末尾的 .strip() 是 77106241 那次加固
    # 才加的——实现晚于测试，是断言过时了。清洗函数削首尾空白是它的职责，
    # 内部空白不受影响（见上面 test_scrub_static_basic 的 "answer  tail"）。
    assert v == "text"
    assert r == "leaked"


def test_scrub_static_no_tag():
    assert scrub_static("plain") == ("plain", "")
