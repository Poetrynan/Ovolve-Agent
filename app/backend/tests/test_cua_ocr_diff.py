# -*- coding: utf-8 -*-
"""cua_ocr_diff 单元测试：行级 diff、几乎未变短路、预算上限、滚动基线。

全部用假 OCR 行文本注入，不依赖任何截图引擎——离线可跑，纯标准库。
"""

import pytest

from cua_ocr_diff import (
    DIFF_MAX_CHARS,
    DIFF_MAX_LINES,
    OcrDiffState,
    diff_ocr_lines,
    render_ocr_diff,
)


def _seq(prefix: str, start: int, count: int) -> list[str]:
    return [f"{prefix}{i:04d}" for i in range(start, start + count)]


# ── 纯函数：diff_ocr_lines ──────────────────────────────────────────────────


def test_first_frame_is_marked_not_a_real_change():
    """首帧没有基线：整屏计入 added，但 is_first_frame=True 供渲染器走建基线文案。"""
    result = diff_ocr_lines([], ["菜单栏", "工具栏", "状态栏"])
    assert result.is_first_frame is True
    assert result.unchanged_screen is False
    assert result.stats["added"] == 3
    assert all(line.startswith("[+] ") for line in result.changed_lines)


def test_added_line_detected():
    prev = ["文件", "编辑", "视图"]
    curr = ["文件", "编辑", "视图", "帮助"]
    result = diff_ocr_lines(prev, curr)
    assert result.unchanged_screen is False
    assert "[+] 帮助" in result.changed_lines
    assert result.stats["added"] == 1
    assert result.stats["removed"] == 0


def test_removed_line_detected():
    result = diff_ocr_lines(["文件", "编辑", "视图"], ["文件", "视图"])
    assert "[-] 编辑" in result.changed_lines
    assert result.stats["removed"] == 1


def test_modified_line_uses_tilde_prefix():
    """replace 段成对记 [~]，报的是新内容——模型关心的是'现在屏幕上是什么'。"""
    result = diff_ocr_lines(["用户: A", "状态: 就绪", "版本: 1"], ["用户: A", "状态: 忙碌", "版本: 1"])
    assert "[~] 状态: 忙碌" in result.changed_lines
    assert result.stats["changed"] == 1
    assert result.stats["added"] == 0
    assert result.stats["removed"] == 0


def test_identical_screens_collapse_to_single_line():
    prev = _seq("row", 0, 100)
    result = diff_ocr_lines(prev, list(prev))
    assert result.unchanged_screen is True
    assert result.changed_lines == []
    assert result.stats["similarity"] == 1.0


def test_small_noise_above_threshold_collapses():
    """98/100 行相同 → 相似度 0.98 > 0.95：噪声被吞掉，1 行结论。"""
    prev = _seq("row", 0, 100)
    curr = list(prev[:98]) + ["新行甲", "新行乙"]
    result = diff_ocr_lines(prev, curr)
    assert result.unchanged_screen is True
    assert result.changed_lines == []


def test_boundary_similarity_exactly_threshold_still_diffs():
    """40 行基线 + 38 行相同 + 2 新行 → 相似度恰好 0.95：严格大于，仍走 diff。"""
    prev = _seq("row", 0, 40)
    curr = list(prev[:38]) + ["新行甲", "新行乙"]
    result = diff_ocr_lines(prev, curr)
    assert result.unchanged_screen is False
    assert result.stats["similarity"] == 0.95
    assert len(result.changed_lines) == 2


def test_real_change_below_threshold_produces_diff():
    prev = _seq("row", 0, 20)
    curr = list(prev[:17]) + ["新行甲", "新行乙", "新行丙"]
    result = diff_ocr_lines(prev, curr)
    assert result.unchanged_screen is False
    # difflib 可能把"删旧加新"对齐为 replace 段（记 [~]），不硬编码具体前缀划分
    assert len(result.changed_lines) == 3
    assert sum(result.stats[k] for k in ("added", "removed", "changed")) == 3


def test_stats_counts_consistent():
    prev = ["a", "b", "c", "d", "e"]
    curr = ["a", "x", "c", "f", "g"]
    result = diff_ocr_lines(prev, curr)
    assert result.stats["prev_lines"] == 5
    assert result.stats["curr_lines"] == 5
    assert len(result.changed_lines) == result.stats["added"] + result.stats["removed"] + result.stats["changed"]


def test_both_empty_is_unchanged():
    result = diff_ocr_lines([], [])
    assert result.unchanged_screen is True
    assert result.stats["similarity"] == 1.0


def test_curr_empty_after_content_is_full_removal():
    result = diff_ocr_lines(["甲", "乙"], [])
    assert result.unchanged_screen is False
    assert result.stats["removed"] == 2


def test_inputs_not_mutated():
    prev = ["a", "b"]
    curr = ["a", "c"]
    diff_ocr_lines(prev, curr)
    assert prev == ["a", "b"] and curr == ["a", "c"]


# ── 渲染：render_ocr_diff ───────────────────────────────────────────────────


def test_render_first_frame_note():
    result = diff_ocr_lines([], ["a", "b"])
    out = render_ocr_diff(result)
    assert out.startswith("屏幕观察(首帧)")
    assert "2 行" in out


def test_render_unchanged_single_line():
    prev = _seq("row", 0, 60)
    out = render_ocr_diff(diff_ocr_lines(prev, list(prev)))
    assert out.startswith("屏幕几乎未变")
    assert "100%" in out
    assert "\n" not in out


def test_render_header_counts():
    prev = ["a", "b"]
    curr = ["a", "c", "d"]
    out = render_ocr_diff(diff_ocr_lines(prev, curr))
    # b→c,d 被对齐为 replace(成对 [~] c) + insert([+] d)：+1 / -0 / ~1
    assert out.startswith("屏幕变化: +1 行 / -0 行 / ~1 行改动")
    assert "[~] c" in out
    assert "[+] d" in out


def test_render_line_budget_cap():
    """超过 DIFF_MAX_LINES 的变化行折叠，并提示未展示数量与出路。"""
    prev = []
    curr = _seq("long_changed_row_", 0, DIFF_MAX_LINES + 20)
    result = diff_ocr_lines(prev, curr)
    assert result.is_first_frame is True  # 走首帧文案，不用它验上限
    # 改用有基线的第二帧触发行数上限
    state = OcrDiffState()
    state.update_from_lines(["基线行"])
    _, result2 = state.update_from_lines(["基线行"] + curr)
    out = render_ocr_diff(result2)
    shown = [line for line in out.splitlines() if line.startswith("[+] ")]
    assert len(shown) == DIFF_MAX_LINES
    assert f"另有 {len(curr) - DIFF_MAX_LINES} 行变化未展示" in out
    assert "screenshot" in out


def test_render_char_budget_cap():
    """字符上限独立生效：每行 100 字符时 600 字符预算只放行 5 行。"""
    state = OcrDiffState()
    state.update_from_lines(["基线行"])
    long_lines = ["x" * 100 for _ in range(15)]
    _, result = state.update_from_lines(["基线行"] + long_lines)
    out = render_ocr_diff(result)
    assert out.count("[+] ") == 5
    assert f"另有 {15 - 5} 行变化未展示" in out
    assert DIFF_MAX_CHARS == 600  # 锁定预算常量语义


# ── 滚动基线：OcrDiffState ──────────────────────────────────────────────────


def test_state_advances_baseline_each_frame():
    """第三帧必须和第二帧比，而不是和首帧比——否则变化会重复上报。"""
    state = OcrDiffState()
    state.update_from_lines(["a", "b", "c"])
    summary2, diff2 = state.update_from_lines(["a", "b", "c", "d"])
    assert "+1 行" in summary2 and "[+] d" in summary2
    summary3, diff3 = state.update_from_lines(["a", "b", "c", "d", "e"])
    assert "+1 行" in summary3 and "[+] e" in summary3
    assert diff3.stats["added"] == 1


def test_state_reset_rebuilds_baseline():
    state = OcrDiffState()
    state.update_from_lines(["旧屏幕"])
    state.reset()
    summary, diff = state.update_from_lines(["新屏幕"])
    assert diff.is_first_frame is True
    assert summary.startswith("屏幕观察(首帧)")
    assert state.has_baseline is True


def test_update_from_ocr_extraction_matches_summary_convention():
    """与 cua_actions.summarize_ocr 同一提取约定：lines[].text、丢空行、丢非 dict 项。"""
    state = OcrDiffState()
    ocr_value = {
        "lines": [
            {"text": "  窗口标题  "},
            {"text": ""},
            "不是 dict 的脏数据",
            {"text": "正文行"},
        ]
    }
    summary, diff = state.update_from_ocr(ocr_value)
    assert diff.is_first_frame is True
    assert diff.stats["added"] == 2
    assert "2 行" in summary
    assert state.last_lines == ["窗口标题", "正文行"]


def test_update_from_ocr_non_dict_input_is_safe():
    """首帧喂进脏数据（None）：按空基线安全处理，报"建基线"而不是"屏幕几乎未变"。"""
    state = OcrDiffState()
    summary, diff = state.update_from_ocr(None)
    assert diff.stats["added"] == 0
    assert diff.is_first_frame is True
    assert summary.startswith("屏幕观察(首帧)")


def test_state_summary_and_result_agree_on_unchanged():
    state = OcrDiffState()
    state.update_from_lines(["a", "b", "c"])
    summary, diff = state.update_from_lines(["a", "b", "c"])
    assert diff.unchanged_screen is True
    assert summary.startswith("屏幕几乎未变")
