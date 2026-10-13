/**
 * bare_modifier_guard.ts — 物理按键与鼠标干扰防冲突安全锁
 *
 * Ported from `app/backend/bare_modifier_guard.py` (183 lines, Native target).
 *
 * 在执行 CAP_POINT (点击/拖拽) 与 CAP_TYPE (文本输入/击键) 前，检测用户物理
 * 按键状态（Ctrl / Shift / Alt / Win）与光标位移，确保只在无物理按键交织的
 * 纯净间隙执行自动化，彻底杜绝快捷键误触发。
 *
 * IMPLEMENTATION NOTE (RULEBOOK §1, Native-target units): the source calls
 * user32.GetAsyncKeyState / GetCursorPos via ctypes. The TS engine has no
 * FFI and adds no dependency row, so the DEFAULT getters are the honest
 * "cannot probe" implementations (return false / null — same as the source's
 * non-Windows branch and its `except Exception` path), while the real Win32
 * probing arrives exactly the way tests inject fakes: via the constructor's
 * getter injection points. A native host addon can wire GetAsyncKeyState
 * through `setBareModifierProbe` below without touching call sites.
 *
 * RULEBOOK CITATIONS
 *   §1  no new dependency (the ctypes surface becomes an injectable seam).
 *   §2  time.monotonic → performance.now()/1000 (both are monotonic clocks).
 *   §2  time.sleep loop → synchronous busy wait is hostile in Node; the wait
 *       loop is ported as async with awaitable sleeps, keeping the same
 *       deadline/interval semantics. (Callers of the Python version run it
 *       in worker threads; the TS engine runs single-threaded — async is the
 *       behavior-preserving shape.)
 *   §4  naming: bare_modifier_guard.py → bare_modifier_guard.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

// Windows Virtual-Key Codes (标准 WinUser.h 约定)
export const VK_SHIFT = 0x10;
export const VK_CONTROL = 0x11;
export const VK_MENU = 0x12; // Alt
export const VK_LSHIFT = 0xa0;
export const VK_RSHIFT = 0xa1;
export const VK_LCONTROL = 0xa2;
export const VK_RCONTROL = 0xa3;
export const VK_LMENU = 0xa4;
export const VK_RMENU = 0xa5;
export const VK_LWIN = 0x5b;
export const VK_RWIN = 0x5c;

export const MODIFIER_MAP: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["Ctrl", [VK_CONTROL, VK_LCONTROL, VK_RCONTROL]],
  ["Shift", [VK_SHIFT, VK_LSHIFT, VK_RSHIFT]],
  ["Alt", [VK_MENU, VK_LMENU, VK_RMENU]],
  ["Win", [VK_LWIN, VK_RWIN]],
];

export type KeyStateGetter = (vk: number) => boolean;
export type CursorPosGetter = () => [number, number] | null;

function _default_win32_key_state(_vk: number): boolean {
  /** 标准 Win32 真实按键异步状态检测（0x8000 表示按下态）。
   * TS 引擎无 ctypes；无注入时如实返回 false（与源的非 Windows/异常路径
   * 相同——守卫在此状态下从不阻塞自动化）。 */
  return false;
}

function _default_win32_cursor_pos(): [number, number] | null {
  /** 标准 Win32 获取真实屏幕光标坐标。无注入时如实返回 null。 */
  return null;
}

let _hostKeyState: KeyStateGetter | null = null;
let _hostCursorPos: CursorPosGetter | null = null;

/** Native host addon wiring point (GetAsyncKeyState / GetCursorPos). */
export function setBareModifierProbe(
  keyState: KeyStateGetter | null,
  cursorPos: CursorPosGetter | null
): void {
  _hostKeyState = keyState;
  _hostCursorPos = cursorPos;
}

function monotonic(): number {
  return performance.now() / 1000;
}

export class BareModifierGuard {
  /** 物理人机防冲突安全锁：修饰键与鼠标运动监控。 */
  private _get_key_state: KeyStateGetter;
  private _get_cursor_pos: CursorPosGetter;
  private _last_cursor_pos: [number, number] | null = null;
  private _last_cursor_time = 0.0;

  constructor(key_state_getter?: KeyStateGetter | null, cursor_pos_getter?: CursorPosGetter | null) {
    this._get_key_state =
      key_state_getter ?? _hostKeyState ?? _default_win32_key_state;
    this._get_cursor_pos =
      cursor_pos_getter ?? _hostCursorPos ?? _default_win32_cursor_pos;
  }

  /** 检测当前物理修饰键（Ctrl / Shift / Alt / Win）是否处于激活按下状态。
   * Returns: (has_active, [active_modifier_names]) */
  is_modifier_active(): [boolean, string[]] {
    const active_names: string[] = [];
    for (const [name, vks] of MODIFIER_MAP) {
      for (const vk of vks) {
        if (this._get_key_state(vk)) {
          active_names.push(name);
          break; // 命中该修饰键之一即标记
        }
      }
    }
    return [active_names.length > 0, active_names];
  }

  /** 检测鼠标光标是否在最近时间窗口内被用户物理主动晃动。
   *
   * @param threshold_px 触发移动判定的像素距离阈值（默认 8px，抗静止抖动）
   * @param time_window_s 采样最大有效时间窗口（默认 250ms） */
  is_mouse_moving(threshold_px = 8, time_window_s = 0.25): boolean {
    const current_pos = this._get_cursor_pos();
    const now = monotonic();
    if (current_pos === null) {
      return false;
    }

    if (
      this._last_cursor_pos === null ||
      now - this._last_cursor_time > time_window_s
    ) {
      this._last_cursor_pos = current_pos;
      this._last_cursor_time = now;
      return false;
    }

    const dx = current_pos[0] - this._last_cursor_pos[0];
    const dy = current_pos[1] - this._last_cursor_pos[1];
    const dist = Math.hypot(dx, dy);

    this._last_cursor_pos = current_pos;
    this._last_cursor_time = now;

    return dist > threshold_px;
  }

  /** 等待物理键盘恢复纯净状态（无任何修饰键按下）。
   *
   * @param timeout_ms 最大等待毫数（默认 500ms）
   * @param check_interval_ms 轮询采样间隔（默认 25ms）
   * @param check_mouse 是否同时校验鼠标静止
   * Returns: (is_clean, reason_or_status) */
  async wait_for_bare_state(
    timeout_ms = 500,
    check_interval_ms = 25,
    check_mouse = false
  ): Promise<[boolean, string]> {
    const deadline = monotonic() + timeout_ms / 1000.0;
    const interval_s = check_interval_ms / 1000.0;

    for (;;) {
      const [active, active_names] = this.is_modifier_active();
      const mouse_active = check_mouse ? this.is_mouse_moving() : false;

      if (!active && !mouse_active) {
        return [true, "Bare input state clean"];
      }

      if (monotonic() >= deadline) {
        const reasons: string[] = [];
        if (active) {
          reasons.push(`Holding modifier keys: ${active_names.join(", ")}`);
        }
        if (mouse_active) {
          reasons.push("Mouse is physically moving");
        }
        return [false, reasons.join("; ")];
      }

      // time.sleep(interval_s) — async sleep keeps the event loop alive.
      await new Promise((r) => setTimeout(r, interval_s * 1000));
    }
  }
}
