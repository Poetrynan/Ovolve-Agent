# -*- coding: utf-8 -*-
"""test_bare_modifier_guard.py - 物理按键与鼠标干扰防冲突安全锁单元测试 (TDD)"""
import time
import pytest

from bare_modifier_guard import (
    BareModifierGuard,
    VK_CONTROL,
    VK_SHIFT,
    VK_MENU,
    VK_LWIN,
    VK_RWIN,
)


def test_no_modifier_active_by_default():
    # 模拟无任何修饰键按下
    guard = BareModifierGuard(key_state_getter=lambda vk: False)
    active, names = guard.is_modifier_active()
    assert active is False
    assert names == []


def test_detect_ctrl_active():
    # 模拟 Ctrl 键被物理按住
    def fake_get_key_state(vk):
        return vk == VK_CONTROL

    guard = BareModifierGuard(key_state_getter=fake_get_key_state)
    active, names = guard.is_modifier_active()
    assert active is True
    assert "Ctrl" in names


def test_detect_multiple_modifiers():
    # 模拟 Ctrl + Shift + Alt 同时被按住
    def fake_get_key_state(vk):
        return vk in (VK_CONTROL, VK_SHIFT, VK_MENU)

    guard = BareModifierGuard(key_state_getter=fake_get_key_state)
    active, names = guard.is_modifier_active()
    assert active is True
    assert set(names) == {"Ctrl", "Shift", "Alt"}


def test_wait_for_bare_state_success_after_release():
    # 模拟用户在前 2 次检查时按着，第 3 次松开
    calls = 0

    def mock_key_state(vk):
        nonlocal calls
        calls += 1
        if calls < 3 and vk == VK_CONTROL:
            return True
        return False

    guard = BareModifierGuard(key_state_getter=mock_key_state)
    success, reason = guard.wait_for_bare_state(timeout_ms=300, check_interval_ms=10)
    assert success is True
    assert "clean" in reason.lower()
    assert calls >= 3


def test_wait_for_bare_state_timeout_on_holding():
    # 模拟用户一直按着 Ctrl 不放，触发超时保护
    guard = BareModifierGuard(key_state_getter=lambda vk: vk == VK_CONTROL)
    success, reason = guard.wait_for_bare_state(timeout_ms=60, check_interval_ms=15)
    assert success is False
    assert "Ctrl" in reason


def test_mouse_velocity_detection():
    # 模拟光标被用户快速晃动
    positions = [(100, 100), (200, 200)]
    pos_idx = 0

    def mock_cursor_pos():
        nonlocal pos_idx
        p = positions[min(pos_idx, len(positions) - 1)]
        pos_idx += 1
        return p

    guard = BareModifierGuard(cursor_pos_getter=mock_cursor_pos)
    # 第一次采样
    guard.is_mouse_moving()
    # 第二次采样位移 141px > 8px
    is_moving = guard.is_mouse_moving(threshold_px=8)
    assert is_moving is True
