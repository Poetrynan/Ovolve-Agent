"""
native_desktop.py - Industrial-Grade Native Windows GUI & Computer Use Engine.

Provides hardware-level screen capture (GDI), high-DPI coordinate transformation,
Unicode-native SendInput keyboard typing, human-like Bezier mouse movements,
and physical failsafe hardware interrupt detection for AI desktop agents.
"""
from __future__ import annotations
import os
import sys
import time
import math
import ctypes
import io
import base64
from typing import Optional, Tuple, List, Dict, Any
from PIL import Image

_IS_WINDOWS = sys.platform == "win32"

# ─── Win32 DLL handles ───────────────────────────────────────────────────────
# Resolved eagerly on Windows; on other hosts a stand-in object keeps the
# module importable (Linux CI collecting the test tree) while making every
# real entry point fail fast with a clear error instead of a NameError.
# A lazy PEP 562 hook would NOT work here: it only intercepts attribute
# access from OUTSIDE the module, not the ~40 intra-module `user32.…`
# global lookups in the functions below.
if _IS_WINDOWS:
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
else:
    class _MissingWinDLL:
        def __getattr__(self, name: str):
            raise OSError("native_desktop only runs on Windows (needs user32/gdi32)")

    user32 = _MissingWinDLL()
    gdi32 = _MissingWinDLL()


if _IS_WINDOWS:
    # Enable Per-Monitor DPI Awareness v2 / v1
    try:
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            # PROCESS_PER_MONITOR_DPI_AWARE = 2
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

# ─── Win32 Structures for SendInput & GDI ─────────────────────────────────────
ULONG_PTR = ctypes.c_ulonglong if sys.maxsize > 2**32 else ctypes.c_ulong

class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_uint32),
        ("biWidth", ctypes.c_int32),
        ("biHeight", ctypes.c_int32),
        ("biPlanes", ctypes.c_uint16),
        ("biBitCount", ctypes.c_uint16),
        ("biCompression", ctypes.c_uint32),
        ("biSizeImage", ctypes.c_uint32),
        ("biXPelsPerMeter", ctypes.c_int32),
        ("biYPelsPerMeter", ctypes.c_int32),
        ("biClrUsed", ctypes.c_uint32),
        ("biClrImportant", ctypes.c_uint32),
    ]

# SendInput Constants
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
INPUT_HARDWARE = 2

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ULONG_PTR),
    ]

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ULONG_PTR),
    ]

class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong),
        ("wParamL", ctypes.c_ushort),
        ("wParamH", ctypes.c_ushort),
    ]

class _INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
        ("hi", HARDWAREINPUT),
    ]

class INPUT(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_ulong),
        ("union", _INPUT_UNION),
    ]

if _IS_WINDOWS:
    # Prototype the SendInput signature once at import (argtypes/restype make
    # the call safe and let ctypes marshal the INPUT array correctly). On
    # non-Windows hosts there is no user32 to prototype against; the lazy
    # accessor raises a clear OSError long before any call site reaches here.
    user32.SendInput.argtypes = [ctypes.c_uint, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.SendInput.restype = ctypes.c_uint

# Virtual Key Mapping for common hotkeys
VK_MAP = {
    "enter": 0x0D,
    "return": 0x0D,
    "tab": 0x09,
    "space": 0x20,
    "backspace": 0x08,
    "escape": 0x1B,
    "esc": 0x1B,
    "delete": 0x2E,
    "del": 0x2E,
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "shift": 0x10,
    "win": 0x5B,
    "cmd": 0x5B,
    "windows": 0x5B,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "pageup": 0x21,
    "pagedown": 0x22,
    "home": 0x24,
    "end": 0x23,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73,
    "f5": 0x74, "f6": 0x75, "f7": 0x76, "f8": 0x77,
    "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}


class DesktopMetrics:
    """Detects physical and logical display bounds and DPI scaling factor."""

    @staticmethod
    def get_metrics() -> Dict[str, Any]:
        phys_w = user32.GetSystemMetrics(0) # SM_CXSCREEN
        phys_h = user32.GetSystemMetrics(1) # SM_CYSCREEN
        virt_w = user32.GetSystemMetrics(78) # SM_CXVIRTUALSCREEN
        virt_h = user32.GetSystemMetrics(79) # SM_CYVIRTUALSCREEN

        # Calculate primary monitor DPI
        try:
            hdc = user32.GetDC(0)
            log_x = gdi32.GetDeviceCaps(hdc, 88) # LOGPIXELSX
            user32.ReleaseDC(0, hdc)
            scale = round(log_x / 96.0, 2)
        except Exception:
            scale = 1.0

        return {
            "width": phys_w if phys_w > 0 else 1920,
            "height": phys_h if phys_h > 0 else 1080,
            "virtual_width": virt_w if virt_w > 0 else phys_w,
            "virtual_height": virt_h if virt_h > 0 else phys_h,
            "scale_factor": scale,
        }


class NativeDesktopEngine:
    """Core high-performance Windows OS interaction engine."""

    def __init__(self):
        self._last_cursor_pos = self.get_cursor_pos()
        self.failsafe_enabled = True

    def get_cursor_pos(self) -> Tuple[int, int]:
        pt = POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        return pt.x, pt.y

    def check_failsafe(self, expected_pos: Optional[Tuple[int, int]] = None) -> bool:
        """Physical hardware failsafe: returns False if human physically seized mouse."""
        if not self.failsafe_enabled:
            return True
        current_x, current_y = self.get_cursor_pos()
        if expected_pos is not None:
            dx = abs(current_x - expected_pos[0])
            dy = abs(current_y - expected_pos[1])
            # If mouse physically drifted > 50px away from where AI moved it
            if dx > 50 or dy > 50:
                return False
        # Also check if user physically holds Escape key down
        if user32.GetAsyncKeyState(0x1B) & 0x8000:
            return False
        return True

    # ─── GDI Screen Capture ───────────────────────────────────────────────────

    def capture_screen(
        self,
        roi: Optional[Tuple[int, int, int, int]] = None,
        max_dim: int = 1920,
        quality: int = 80,
    ) -> Dict[str, Any]:
        """
        Ultra-fast GDI screenshot capture with DPI alignment and optional ROI cropping.
        Returns PIL Image, metadata, and Base64 encoded JPEG data URI.
        """
        metrics = DesktopMetrics.get_metrics()
        w = metrics["width"]
        h = metrics["height"]

        hwin = user32.GetDesktopWindow()
        hwindc = user32.GetWindowDC(hwin)
        srcdc = gdi32.CreateCompatibleDC(hwindc)
        bmp = gdi32.CreateCompatibleBitmap(hwindc, w, h)
        old_bmp = gdi32.SelectObject(srcdc, bmp)

        # BitBlt with CAPTUREBLT (0x40000000) for layered windows
        gdi32.BitBlt(srcdc, 0, 0, w, h, hwindc, 0, 0, 0x00CC0020 | 0x40000000)

        bih = BITMAPINFOHEADER()
        bih.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bih.biWidth = w
        bih.biHeight = -h # top-down DIB
        bih.biPlanes = 1
        bih.biBitCount = 32
        bih.biCompression = 0

        buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(srcdc, bmp, 0, h, buf, ctypes.byref(bih), 0)

        # Cleanup GDI handles
        gdi32.SelectObject(srcdc, old_bmp)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(srcdc)
        user32.ReleaseDC(hwin, hwindc)

        img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")

        # Apply ROI crop if requested: (x, y, w, h)
        if roi:
            rx, ry, rw, rh = roi
            img = img.crop((rx, ry, rx + rw, ry + rh))

        # Downscale if exceeds max_dim to conserve LLM vision tokens
        orig_w, orig_h = img.size
        if max(orig_w, orig_h) > max_dim:
            scale = max_dim / float(max(orig_w, orig_h))
            new_w = int(orig_w * scale)
            new_h = int(orig_h * scale)
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # Compress to JPEG Base64
        bio = io.BytesIO()
        img.save(bio, format="JPEG", quality=quality, optimize=True)
        raw_bytes = bio.getvalue()
        b64 = base64.b64encode(raw_bytes).decode("ascii")
        data_uri = f"data:image/jpeg;base64,{b64}"

        return {
            "image": img,
            "width": orig_w,
            "height": orig_h,
            "scale_factor": metrics["scale_factor"],
            "data_uri": data_uri,
            "bytes_length": len(raw_bytes),
        }

    # ─── Native SendInput Mouse & Keyboard ───────────────────────────────────

    def move_cursor(self, x: int, y: int, smooth: bool = True, duration: float = 0.2):
        """Moves cursor to (x, y). Supports smooth human-like Bezier path."""
        metrics = DesktopMetrics.get_metrics()
        sw = metrics["width"]
        sh = metrics["height"]

        # Clamp to screen
        x = max(0, min(x, sw - 1))
        y = max(0, min(y, sh - 1))

        if not smooth or duration <= 0:
            user32.SetCursorPos(int(x), int(y))
            self._last_cursor_pos = (x, y)
            return

        start_x, start_y = self.get_cursor_pos()
        steps = max(5, int(duration * 60)) # 60 FPS interpolation
        # Generate cubic Bezier control points for natural curved hand motion
        ctrl_x = start_x + (x - start_x) * 0.25 + (math.sin(time.time()) * 15)
        ctrl_y = start_y + (y - start_y) * 0.75 - (math.cos(time.time()) * 15)

        for i in range(1, steps + 1):
            if not self.check_failsafe((start_x, start_y) if i == 1 else None):
                break
            t = i / float(steps)
            # Quadratic Bezier
            curr_x = (1 - t)**2 * start_x + 2 * (1 - t) * t * ctrl_x + t**2 * x
            curr_y = (1 - t)**2 * start_y + 2 * (1 - t) * t * ctrl_y + t**2 * y
            user32.SetCursorPos(int(curr_x), int(curr_y))
            time.sleep(duration / steps)

        user32.SetCursorPos(int(x), int(y))
        self._last_cursor_pos = (x, y)

    def click(self, x: Optional[int] = None, y: Optional[int] = None, button: str = "left", clicks: int = 1):
        """Clicks at (x, y) or current position."""
        if x is not None and y is not None:
            self.move_cursor(x, y, smooth=True, duration=0.15)
            time.sleep(0.05)

        btn = button.lower()
        if btn == "right":
            down_flag, up_flag = MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP
        elif btn == "middle":
            down_flag, up_flag = MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP
        else:
            down_flag, up_flag = MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP

        for _ in range(clicks):
            inp_down = INPUT(type=INPUT_MOUSE)
            inp_down.union.mi.dwFlags = down_flag
            user32.SendInput(1, ctypes.byref(inp_down), ctypes.sizeof(INPUT))
            time.sleep(0.04)

            inp_up = INPUT(type=INPUT_MOUSE)
            inp_up.union.mi.dwFlags = up_flag
            user32.SendInput(1, ctypes.byref(inp_up), ctypes.sizeof(INPUT))
            time.sleep(0.06)

    def drag(self, start_x: int, start_y: int, end_x: int, end_y: int, duration: float = 0.5):
        """Drags mouse from start to end position."""
        self.move_cursor(start_x, start_y, smooth=True, duration=0.2)
        time.sleep(0.05)

        # Mouse Down
        inp_down = INPUT(type=INPUT_MOUSE)
        inp_down.union.mi.dwFlags = MOUSEEVENTF_LEFTDOWN
        user32.SendInput(1, ctypes.byref(inp_down), ctypes.sizeof(INPUT))
        time.sleep(0.08)

        # Drag Move
        self.move_cursor(end_x, end_y, smooth=True, duration=duration)
        time.sleep(0.08)

        # Mouse Up
        inp_up = INPUT(type=INPUT_MOUSE)
        inp_up.union.mi.dwFlags = MOUSEEVENTF_LEFTUP
        user32.SendInput(1, ctypes.byref(inp_up), ctypes.sizeof(INPUT))

    def scroll(self, clicks: int, x: Optional[int] = None, y: Optional[int] = None):
        """Scrolls mouse wheel vertically (positive = up, negative = down)."""
        if x is not None and y is not None:
            self.move_cursor(x, y, smooth=False)

        wheel_delta = clicks * 120 # Standard Win32 WHEEL_DELTA
        inp = INPUT(type=INPUT_MOUSE)
        inp.union.mi.dwFlags = MOUSEEVENTF_WHEEL
        inp.union.mi.mouseData = ctypes.c_ulong(wheel_delta & 0xFFFFFFFF)
        user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

    def type_unicode(self, text: str, delay_per_char: float = 0.01):
        """
        Hardware-level Unicode keyboard typing (KEYEVENTF_UNICODE).
        Completely immune to system input method (IME) interference,
        perfectly typing Chinese, English, punctuation, and Unicode symbols.
        """
        for char in text:
            code = ord(char)
            # Send Down
            inp_down = INPUT(type=INPUT_KEYBOARD)
            inp_down.union.ki.wScan = code
            inp_down.union.ki.dwFlags = KEYEVENTF_UNICODE
            user32.SendInput(1, ctypes.byref(inp_down), ctypes.sizeof(INPUT))

            # Send Up
            inp_up = INPUT(type=INPUT_KEYBOARD)
            inp_up.union.ki.wScan = code
            inp_up.union.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            user32.SendInput(1, ctypes.byref(inp_up), ctypes.sizeof(INPUT))

            if delay_per_char > 0:
                time.sleep(delay_per_char)

    def press_key(self, key_combo: str):
        """
        Presses keys or combo hotkeys, e.g. 'enter', 'ctrl+s', 'win+r', 'alt+f4'.
        """
        parts = [p.strip().lower() for p in key_combo.split("+") if p.strip()]
        if not parts:
            return

        vk_codes: List[int] = []
        for p in parts:
            if p in VK_MAP:
                vk_codes.append(VK_MAP[p])
            elif len(p) == 1:
                # Character key (A-Z, 0-9)
                vk = user32.VkKeyScanW(ord(p.upper())) & 0xFF
                if vk > 0:
                    vk_codes.append(vk)
                else:
                    vk_codes.append(ord(p.upper()))
            else:
                # Unknown key fallback
                vk_codes.append(VK_MAP.get(p, 0))

        # Press down in order
        for vk in vk_codes:
            if vk == 0:
                continue
            inp = INPUT(type=INPUT_KEYBOARD)
            inp.union.ki.wVk = vk
            user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
            time.sleep(0.02)

        time.sleep(0.05)

        # Release in reverse order
        for vk in reversed(vk_codes):
            if vk == 0:
                continue
            inp = INPUT(type=INPUT_KEYBOARD)
            inp.union.ki.wVk = vk
            inp.union.ki.dwFlags = KEYEVENTF_KEYUP
            user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
            time.sleep(0.02)


def list_top_level_windows() -> List[Dict[str, Any]]:
    """枚举可见且有标题的顶层窗口：``[{hwnd, title, pid, visible}]``。

    这是 UIA 语义动作那条链路的**入口**：``element_tree`` / ``click_element``
    都要一个 hwnd，而模型没有别的地方能拿到它。少了这个，两个动作在 schema
    里看得见、实际永远调不动。

    只列可见且有标题的窗口——隐藏窗口和空标题的消息窗对模型没有意义，
    只会把列表撑长、把真正想点的窗口挤到后面。
    """
    if not _IS_WINDOWS:
        raise OSError("list_top_level_windows only runs on Windows")
    user32 = ctypes.windll.user32
    rows: List[Dict[str, Any]] = []
    # 回调签名用 c_void_p 而不是 wintypes.HWND：本模块没有导入 wintypes，
    # 而且 HWND 在这里只需要当不透明句柄透传。
    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        pid = ctypes.c_ulong(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        rows.append({"hwnd": int(hwnd), "title": buf.value,
                     "pid": int(pid.value), "visible": True})
        return True

    user32.EnumWindows(enum_proc(_cb), 0)
    return rows


# Singleton
_desktop_engine: Optional[NativeDesktopEngine] = None

def get_native_desktop() -> NativeDesktopEngine:
    global _desktop_engine
    if _desktop_engine is None:
        _desktop_engine = NativeDesktopEngine()
    return _desktop_engine
