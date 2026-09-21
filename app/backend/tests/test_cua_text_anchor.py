# -*- coding: utf-8 -*-
"""test_cua_text_anchor.py - 本地 OCR 文本锚点定位与 DPI 补偿单元测试"""
import pytest
from cua_text_anchor import TextAnchorResolver


def test_find_text_boxes_substring():
    boxes = [
        {"text": "登录注册", "x": 100, "y": 200, "width": 80, "height": 30},
        {"text": "取消", "x": 300, "y": 200, "width": 40, "height": 30},
    ]
    matches = TextAnchorResolver.find_text_boxes(boxes, "登录")
    assert len(matches) == 1
    assert matches[0]["text"] == "登录注册"
    assert matches[0]["center_x"] == 140.0
    assert matches[0]["center_y"] == 215.0


def test_find_text_boxes_exact_mode():
    boxes = [
        {"text": "登录注册", "x": 100, "y": 200, "width": 80, "height": 30},
        {"text": "登录", "x": 100, "y": 300, "width": 40, "height": 30},
    ]
    matches = TextAnchorResolver.find_text_boxes(boxes, "登录", exact=True)
    assert len(matches) == 1
    assert matches[0]["y"] == 300


def test_dpi_compensated_coords():
    # 物理坐标 300, 450 在 150% (1.5) 缩放下转为逻辑坐标 200, 300
    lx, ly = TextAnchorResolver.calculate_dpi_compensated_coords(300, 450, scale_factor=1.5, to_logical=True)
    assert lx == 200
    assert ly == 300


def test_resolve_click_target_occurrence():
    boxes = [
        {"text": "确定", "x": 100, "y": 100, "width": 50, "height": 20},
        {"text": "确定", "x": 200, "y": 200, "width": 50, "height": 20},
    ]
    # 取第 2 个
    ok, result = TextAnchorResolver.resolve_click_target(boxes, "确定", occurrence=2, scale_factor=1.0)
    assert ok is True
    assert result == (225, 210)

    # 越界取第 3 个
    ok_fail, err = TextAnchorResolver.resolve_click_target(boxes, "确定", occurrence=3)
    assert ok_fail is False
    assert "超出范围" in err
