# -*- coding: utf-8 -*-
"""bare_modifier_guard.py - 物理按键与鼠标干扰防冲突安全锁

通过标准 Win32 GetAsyncKeyState 与 GetCursorPos 接口实现。
在执行 CAP_POINT (点击/拖拽) 与 CAP_TYPE (文本输入/击键) 前，
检测用户物理按键状态（Ctrl / Shift / Alt / Win）与光标位移，
确保只在无物理按键交织的纯净间隙执行自动化，彻底杜绝快捷键误触发。
"""
from __future__ import annotations

import math
import platform
import sys
import time
from typing import Callable, Optional, Tuple, List

# Windows Virtual-Key Codes (标准 WinUser.h 约定)
VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12  # Alt
VK_LSHIFT = 0xA0
VK_RSHIFT = 0xA1
VK_LCONTROL = 0xA2
VK_RCONTROL = 0xA3
VK_LMENU = 0xA4
VK_RMENU = 0xA5
VK_LWIN = 0x5B
VK_RWIN = 0x5C

MODIFIER_MAP = [
    ("Ctrl", [VK_CONTROL, VK_LCONTROL, VK_RCONTROL]),
    ("Shift", [VK_SHIFT, VK_LSHIFT, VK_RSHIFT]),
    ("Alt", [VK_MENU, VK_LMENU, VK_RMENU]),
    ("Win", [VK_LWIN, VK_RWIN]),
]


def _default_win32_key_state(vk: int) -> bool:
    """标准 Win32 真实按键异步状态检测（0x8000 表示按键当前处于按下态）。"""
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        # GetAsyncKeyState returns SHORT (16-bit signed). High-order bit set means pressed.
        state = ctypes.windll.user32.GetAsyncKeyState(vk)
        return bool(state & 0x8000)
    except Exception:
        return False


def _default_win32_cursor_pos() -> Optional[Tuple[int, int]]:
    """标准 Win32 获取真实屏幕光标坐标。"""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        pt = POINT()
        if ctypes.windll.user32.GetCursorPos(ctypes.byref(pt)):
            return (pt.x, pt.y)
        return None
    except Exception:
        return None


class BareModifierGuard:
    """物理人机防冲突安全锁：修饰键与鼠标运动监控。"""

    def __init__(
        self,
        key_state_getter: Optional[Callable[[int], bool]] = None,
        cursor_pos_getter: Optional[Callable[[], Optional[Tuple[int, int]]]] = None,
    ):
        self._get_key_state = key_state_getter or _default_win32_key_state
        self._get_cursor_pos = cursor_pos_getter or _default_win32_cursor_pos
        self._last_cursor_pos: Optional[Tuple[int, int]] = None
        self._last_cursor_time: float = 0.0

    def is_modifier_active(self) -> Tuple[bool, List[str]]:
        """检测当前物理修饰键（Ctrl / Shift / Alt / Win）是否处于激活按下状态。

        Returns:
            (has_active, [active_modifier_names])
        """
        active_names = []
        for name, vks in MODIFIER_MAP:
            for vk in vks:
                if self._get_key_state(vk):
                    active_names.append(name)
                    break  # 命中该修饰键之一即标记
        return (len(active_names) > 0, active_names)

    def is_mouse_moving(self, threshold_px: int = 8, time_window_s: float = 0.25) -> bool:
        """检测鼠标光标是否在最近时间窗口内被用户物理主动晃动。

        Args:
            threshold_px: 触发移动判定的像素距离阈值（默认 8px，抗静止抖动）
            time_window_s: 采样最大有效时间窗口（默认 250ms）
        """
        current_pos = self._get_cursor_pos()
        now = time.monotonic()
        if current_pos is None:
            return False

        if self._last_cursor_pos is None or (now - self._last_cursor_time) > time_window_s:
            self._last_cursor_pos = current_pos
            self._last_cursor_time = now
            return False

        dx = current_pos[0] - self._last_cursor_pos[0]
        dy = current_pos[1] - self._last_cursor_pos[1]
        dist = math.hypot(dx, dy)

        self._last_cursor_pos = current_pos
        self._last_cursor_time = now

        return dist > threshold_px

    def wait_for_bare_state(
        self,
        timeout_ms: int = 500,
        check_interval_ms: int = 25,
        check_mouse: bool = False,
    ) -> Tuple[bool, str]:
        """等待物理键盘恢复纯净状态（无任何修饰键按下）。

        Args:
            timeout_ms: 最大等待毫秒数（默认 500ms）
            check_interval_ms: 轮询采样间隔（默认 25ms）
            check_mouse: 是否同时校验鼠标静止

        Returns:
            (is_clean, reason_or_status)
        """
        deadline = time.monotonic() + (timeout_ms / 1000.0)
        interval_s = check_interval_ms / 1000.0

        while True:
            active, active_names = self.is_modifier_active()
            mouse_active = self.is_mouse_moving() if check_mouse else False

            if not active and not mouse_active:
                return (True, "Bare input state clean")

            if time.monotonic() >= deadline:
                reasons = []
                if active:
                    reasons.append(f"Holding modifier keys: {', '.join(active_names)}")
                if mouse_active:
                    reasons.append("Mouse is physically moving")
                return (False, "; ".join(reasons))

            time.sleep(interval_s)
