//! bare_modifier_guard - 物理按键与鼠标干扰防冲突安全锁
//!
//! 通过标准 Win32 GetAsyncKeyState 与 GetCursorPos 接口实现。
//! 在执行 CAP_POINT (点击/拖拽) 与 CAP_TYPE (文本输入/击键) 前，
//! 检测用户物理按键状态（Ctrl / Shift / Alt / Win）与光标位移，
//! 确保只在无物理按键交织的纯净间隙执行自动化，彻底杜绝快捷键误触发。

use pyo3::prelude::*;
use pyo3::types::{PyList, PyTuple};
use std::time::Instant;

pub const VK_SHIFT: i32 = 0x10;
pub const VK_CONTROL: i32 = 0x11;
pub const VK_MENU: i32 = 0x12;
pub const VK_LSHIFT: i32 = 0xA0;
pub const VK_RSHIFT: i32 = 0xA1;
pub const VK_LCONTROL: i32 = 0xA2;
pub const VK_RCONTROL: i32 = 0xA3;
pub const VK_LMENU: i32 = 0xA4;
pub const VK_RMENU: i32 = 0xA5;
pub const VK_LWIN: i32 = 0x5B;
pub const VK_RWIN: i32 = 0x5C;

pub static MODIFIER_SPECS: &[(&str, &[i32])] = &[
    ("Ctrl", &[VK_CONTROL, VK_LCONTROL, VK_RCONTROL]),
    ("Shift", &[VK_SHIFT, VK_LSHIFT, VK_RSHIFT]),
    ("Alt", &[VK_MENU, VK_LMENU, VK_RMENU]),
    ("Win", &[VK_LWIN, VK_RWIN]),
];

#[pyfunction]
#[pyo3(name = "_default_win32_key_state")]
pub fn default_win32_key_state(vk: i32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let state = unsafe { GetAsyncKeyState(vk) };
        (state as u16 & 0x8000) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = vk;
        false
    }
}

#[pyfunction]
#[pyo3(name = "_default_win32_cursor_pos")]
pub fn default_win32_cursor_pos() -> Option<(i32, i32)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut pt = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut pt) } != 0 {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[pyclass(subclass)]
pub struct BareModifierGuard {
    key_state_getter: Option<PyObject>,
    cursor_pos_getter: Option<PyObject>,
    last_cursor_pos: Option<(i32, i32)>,
    last_cursor_time: Option<Instant>,
}

#[pymethods]
impl BareModifierGuard {
    #[new]
    #[pyo3(signature = (key_state_getter=None, cursor_pos_getter=None))]
    pub fn new(
        key_state_getter: Option<PyObject>,
        cursor_pos_getter: Option<PyObject>,
    ) -> Self {
        Self {
            key_state_getter,
            cursor_pos_getter,
            last_cursor_pos: None,
            last_cursor_time: None,
        }
    }

    pub fn is_modifier_active(&self, py: Python<'_>) -> PyResult<(bool, Vec<String>)> {
        let mut active_names = Vec::new();
        for (name, vks) in MODIFIER_SPECS {
            for &vk in *vks {
                let is_pressed = if let Some(ref getter) = self.key_state_getter {
                    getter.call1(py, (vk,))?.extract::<bool>(py)?
                } else {
                    default_win32_key_state(vk)
                };
                if is_pressed {
                    active_names.push((*name).to_string());
                    break;
                }
            }
        }
        let has_active = !active_names.is_empty();
        Ok((has_active, active_names))
    }

    #[pyo3(signature = (threshold_px=8, time_window_s=0.25))]
    pub fn is_mouse_moving(
        &mut self,
        py: Python<'_>,
        threshold_px: i32,
        time_window_s: f64,
    ) -> PyResult<bool> {
        let current_pos: Option<(i32, i32)> = if let Some(ref getter) = self.cursor_pos_getter {
            let res = getter.call0(py)?;
            if res.is_none(py) {
                None
            } else {
                Some(res.extract::<(i32, i32)>(py)?)
            }
        } else {
            default_win32_cursor_pos()
        };

        let now = Instant::now();
        let current_pos = match current_pos {
            Some(p) => p,
            None => return Ok(false),
        };

        if let (Some(last_pos), Some(last_time)) = (self.last_cursor_pos, self.last_cursor_time) {
            let elapsed = now.duration_since(last_time).as_secs_f64();
            if elapsed > time_window_s {
                self.last_cursor_pos = Some(current_pos);
                self.last_cursor_time = Some(now);
                return Ok(false);
            }

            let dx = (current_pos.0 - last_pos.0) as f64;
            let dy = (current_pos.1 - last_pos.1) as f64;
            let dist = dx.hypot(dy);

            self.last_cursor_pos = Some(current_pos);
            self.last_cursor_time = Some(now);

            Ok(dist > (threshold_px as f64))
        } else {
            self.last_cursor_pos = Some(current_pos);
            self.last_cursor_time = Some(now);
            Ok(false)
        }
    }

    #[pyo3(signature = (timeout_ms=500, check_interval_ms=25, check_mouse=false))]
    pub fn wait_for_bare_state(
        &mut self,
        py: Python<'_>,
        timeout_ms: u64,
        check_interval_ms: u64,
        check_mouse: bool,
    ) -> PyResult<(bool, String)> {
        let deadline = Instant::now() + std::time::Duration::from_millis(timeout_ms);
        let interval = std::time::Duration::from_millis(check_interval_ms);

        loop {
            let (active, active_names) = self.is_modifier_active(py)?;
            let mouse_active = if check_mouse {
                self.is_mouse_moving(py, 8, 0.25)?
            } else {
                false
            };

            if !active && !mouse_active {
                return Ok((true, "Bare input state clean".to_string()));
            }

            if Instant::now() >= deadline {
                let mut reasons = Vec::new();
                if active {
                    reasons.push(format!("Holding modifier keys: {}", active_names.join(", ")));
                }
                if mouse_active {
                    reasons.push("Mouse is physically moving".to_string());
                }
                return Ok((false, reasons.join("; ")));
            }

            py.allow_threads(|| {
                std::thread::sleep(interval);
            });
        }
    }
}

pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(py, "bare_modifier_guard")?;

    m.add("VK_SHIFT", VK_SHIFT)?;
    m.add("VK_CONTROL", VK_CONTROL)?;
    m.add("VK_MENU", VK_MENU)?;
    m.add("VK_LSHIFT", VK_LSHIFT)?;
    m.add("VK_RSHIFT", VK_RSHIFT)?;
    m.add("VK_LCONTROL", VK_LCONTROL)?;
    m.add("VK_RCONTROL", VK_RCONTROL)?;
    m.add("VK_LMENU", VK_LMENU)?;
    m.add("VK_RMENU", VK_RMENU)?;
    m.add("VK_LWIN", VK_LWIN)?;
    m.add("VK_RWIN", VK_RWIN)?;

    let mod_map = PyList::empty_bound(py);
    for &(name, vks) in MODIFIER_SPECS {
        let name_str = pyo3::types::PyString::new_bound(py, name);
        let vk_list = PyList::new_bound(py, vks);
        let pair = PyTuple::new_bound(py, [name_str.as_any(), vk_list.as_any()]);
        mod_map.append(pair)?;
    }
    m.add("MODIFIER_MAP", mod_map)?;

    m.add_function(wrap_pyfunction!(default_win32_key_state, &m)?)?;
    m.add_function(wrap_pyfunction!(default_win32_cursor_pos, &m)?)?;
    m.add_class::<BareModifierGuard>()?;

    parent.add_submodule(&m)?;

    // Register into sys.modules so import works cleanly
    if let Ok(sys) = py.import_bound("sys") {
        if let Ok(modules) = sys.getattr("modules") {
            let _ = modules.set_item("ovolve_core.bare_modifier_guard", &m);
        }
    }

    Ok(())
}

// PORT STATUS: 本文件无 TODO(port)。
