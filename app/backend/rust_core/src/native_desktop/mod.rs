//! native_desktop.rs - High-performance Windows desktop automation engine.
//!
//! Rust implementation of the Python native_desktop.py module.
//! Provides GDI screen capture, SendInput keyboard/mouse, Bezier mouse movement,
//! and hardware failsafe detection — all with zero-cost abstractions.

use pyo3::prelude::*;
use std::collections::HashMap;

// Platform-specific imports
#[cfg(windows)]
mod platform {
    pub use windows_sys::Win32::Foundation::{BOOL, HWND, TRUE, FALSE};
    pub use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, SRCCOPY,
    };
    pub use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, MOUSEINPUT,
        KEYBDINPUT, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN,
        MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_WHEEL, MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE,
        KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VK_LBUTTON, VK_RBUTTON, VK_MBUTTON,
    };
    pub use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, SetCursorPos,
    };
}

#[cfg(windows)]
use platform::*;

/// Display metrics for DPI-aware coordinate transforms.
#[pyclass]
#[derive(Debug, Clone)]
pub struct DesktopMetrics {
    #[pyo3(get)]
    pub physical_width: i32,
    #[pyo3(get)]
    pub physical_height: i32,
    #[pyo3(get)]
    pub logical_width: i32,
    #[pyo3(get)]
    pub logical_height: i32,
    #[pyo3(get)]
    pub dpi_scale: f64,
}

#[pymethods]
impl DesktopMetrics {
    /// Get current display metrics (physical/logical resolution + DPI scale).
    #[staticmethod]
    fn get_metrics() -> PyResult<Self> {
        #[cfg(windows)]
        unsafe {
            let hwnd = 0 as platform::HWND;
            let hdc = platform::GetDC(hwnd);
            if hdc == 0 {
                return Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
                    "GetDC failed"
                ));
            }
            let physical_width = windows_sys::Win32::Graphics::Gdi::GetDeviceCaps(hdc, 8);  /* HORZRES */
            let physical_height = windows_sys::Win32::Graphics::Gdi::GetDeviceCaps(hdc, 10); /* VERTRES */
            let logical_width = windows_sys::Win32::Graphics::Gdi::GetDeviceCaps(hdc, 118); /* DESKTOPHORZRES */
            let logical_height = windows_sys::Win32::Graphics::Gdi::GetDeviceCaps(hdc, 117); /* DESKTOPVERTRES */
            platform::ReleaseDC(hwnd, hdc);

            let dpi_scale = if logical_width > 0 {
                physical_width as f64 / logical_width as f64
            } else {
                1.0
            };

            Ok(Self {
                physical_width,
                physical_height,
                logical_width: if logical_width > 0 { logical_width } else { physical_width },
                logical_height: if logical_height > 0 { logical_height } else { physical_height },
                dpi_scale,
            })
        }
        #[cfg(not(windows))]
        {
            // Non-Windows fallback for CI/testing
            Ok(Self {
                physical_width: 1920,
                physical_height: 1080,
                logical_width: 1920,
                logical_height: 1080,
                dpi_scale: 1.0,
            })
        }
    }

    fn to_dict(&self) -> HashMap<String, f64> {
        let mut map = HashMap::new();
        map.insert("physical_width".to_string(), self.physical_width as f64);
        map.insert("physical_height".to_string(), self.physical_height as f64);
        map.insert("logical_width".to_string(), self.logical_width as f64);
        map.insert("logical_height".to_string(), self.logical_height as f64);
        map.insert("dpi_scale".to_string(), self.dpi_scale);
        map
    }
}

/// Core desktop automation engine.
#[pyclass]
pub struct NativeDesktopEngine {
    metrics: DesktopMetrics,
    #[allow(dead_code)]
    screen_dc: usize, // placeholder for DC handle
}

impl NativeDesktopEngine {
    pub fn create() -> PyResult<Self> {
        let metrics = DesktopMetrics::get_metrics()?;
        Ok(Self {
            metrics,
            screen_dc: 0,
        })
    }
}

#[pymethods]
impl NativeDesktopEngine {
    #[new]
    fn new() -> PyResult<Self> {
        Self::create()
    }

    /// Get current cursor position as (x, y).
    fn get_cursor_pos(&self) -> (i32, i32) {
        #[cfg(windows)]
        unsafe {
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            if platform::GetCursorPos(&mut pt) != 0 {
                return (pt.x, pt.y);
            }
        }
        (0, 0)
    }

    /// Check if user physically seized mouse (hardware failsafe).
    /// Returns true if failsafe triggered (human intervention detected).
    fn check_failsafe(&self, expected_pos: Option<(i32, i32)>) -> bool {
        let current = self.get_cursor_pos();
        match expected_pos {
            Some((ex, ey)) => {
                let dx = (current.0 - ex).abs();
                let dy = (current.1 - ey).abs();
                // If mouse moved more than threshold, human is controlling it
                dx > 50 || dy > 50
            }
            None => false,
        }
    }

    /// Capture screen region as raw RGB bytes.
    /// Returns (width, height, rgb_bytes) or error.
    fn capture_screen(&self, x: i32, y: i32, width: i32, height: i32) -> PyResult<(u32, u32, Vec<u8>)> {
        #[cfg(windows)]
        unsafe {
            let hwnd = 0 as platform::HWND;
            let hdc_screen = platform::GetDC(hwnd);
            if hdc_screen == 0 {
                return Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
                    "GetDC(screen) failed"
                ));
            }

            let hdc_mem = platform::CreateCompatibleDC(hdc_screen);
            if hdc_mem == 0 {
                platform::ReleaseDC(hwnd, hdc_screen);
                return Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
                    "CreateCompatibleDC failed"
                ));
            }

            let hbitmap = platform::CreateCompatibleBitmap(hdc_screen, width, height);
            let old_bitmap = platform::SelectObject(hdc_mem, hbitmap as _);

            let success = platform::BitBlt(
                hdc_mem, 0, 0, width, height,
                hdc_screen, x, y, SRCCOPY,
            );

            if success == 0 {
                platform::SelectObject(hdc_mem, old_bitmap);
                platform::DeleteObject(hbitmap as _);
                platform::DeleteDC(hdc_mem);
                platform::ReleaseDC(hwnd, hdc_screen);
                return Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
                    "BitBlt failed"
                ));
            }

            // Prepare bitmap info for GetDIBits
            let mut bmi = std::mem::zeroed::<platform::BITMAPINFO>();
            bmi.bmiHeader.biSize = std::mem::size_of::<platform::BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = width;
            bmi.bmiHeader.biHeight = -height; // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 24;
            bmi.bmiHeader.biCompression = BI_RGB;

            let row_size = ((width * 3 + 3) / 4) * 4; // align to 4 bytes
            let buffer_size = (row_size * height) as usize;
            let mut buffer: Vec<u8> = vec![0u8; buffer_size];

            let lines = platform::GetDIBits(
                hdc_mem, hbitmap, 0, height as u32,
                buffer.as_mut_ptr() as _, &mut bmi, DIB_RGB_COLORS,
            );

            // Cleanup GDI objects
            platform::SelectObject(hdc_mem, old_bitmap);
            platform::DeleteObject(hbitmap as _);
            platform::DeleteDC(hdc_mem);
            platform::ReleaseDC(hwnd, hdc_screen);

            if lines == 0 {
                return Err(PyErr::new::<pyo3::exceptions::PyRuntimeError, _>(
                    "GetDIBits failed"
                ));
            }

            // Convert BGR to RGB and remove padding
            let mut rgb: Vec<u8> = Vec::with_capacity((width * height * 3) as usize);
            for row in 0..height {
                let row_start = (row * row_size as i32) as usize;
                for col in 0..width {
                    let pixel_start = row_start + (col * 3) as usize;
                    rgb.push(buffer[pixel_start + 2]); // R
                    rgb.push(buffer[pixel_start + 1]); // G
                    rgb.push(buffer[pixel_start]);     // B
                }
            }

            Ok((width as u32, height as u32, rgb))
        }
        #[cfg(not(windows))]
        {
            // Non-Windows: return black frame
            let size = (width * height * 3) as usize;
            Ok((width as u32, height as u32, vec![0u8; size]))
        }
    }

    /// Move cursor to (x, y) with optional smooth Bezier interpolation.
    fn move_cursor(&self, x: i32, y: i32, smooth: bool, duration: f64) -> PyResult<()> {
        #[cfg(windows)]
        unsafe {
            if !smooth || duration <= 0.0 {
                platform::SetCursorPos(x, y);
                return Ok(());
            }

            let start = self.get_cursor_pos();
            let steps = (duration * 60.0) as i32; // 60fps
            let steps = steps.max(10).min(120);

            // Cubic Bezier control points for human-like movement
            let mid_x = (start.0 + x) / 2;
            let mid_y = (start.1 + y) / 2;
            let cp1 = (mid_x + rand_jitter(20), mid_y + rand_jitter(20));
            let cp2 = (mid_x + rand_jitter(20), mid_y + rand_jitter(20));

            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                let t_inv = 1.0 - t;

                // Cubic Bezier formula
                let bx = (t_inv.powi(3) * start.0 as f64
                    + 3.0 * t_inv.powi(2) * t * cp1.0 as f64
                    + 3.0 * t_inv * t.powi(2) * cp2.0 as f64
                    + t.powi(3) * x as f64) as i32;

                let by = (t_inv.powi(3) * start.1 as f64
                    + 3.0 * t_inv.powi(2) * t * cp1.1 as f64
                    + 3.0 * t_inv * t.powi(2) * cp2.1 as f64
                    + t.powi(3) * y as f64) as i32;

                platform::SetCursorPos(bx, by);

                // Variable speed: slower at start/end
                let sleep_ms = (duration * 1000.0 / steps as f64
                    * (0.8 + 0.4 * (std::f64::consts::PI * t).sin())) as u64;
                std::thread::sleep(std::time::Duration::from_millis(sleep_ms.max(1)));
            }
        }
        Ok(())
    }

    /// Click at position (or current position if None).
    #[pyo3(signature = (x=None, y=None, button="left", clicks=1))]
    fn click(&self, x: Option<i32>, y: Option<i32>, button: &str, clicks: i32) -> PyResult<()> {
        #[cfg(windows)]
        unsafe {
            if let (Some(px), Some(py)) = (x, y) {
                platform::SetCursorPos(px, py);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            let (down_flag, up_flag) = match button {
                "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            };

            for _ in 0..clicks {
                let mut input_down = std::mem::zeroed::<INPUT>();
                input_down.r#type = INPUT_MOUSE;
                input_down.Anonymous.mi = {
                    let mut mi = std::mem::zeroed::<MOUSEINPUT>();
                    mi.dwFlags = down_flag;
                    mi
                };

                let mut input_up = std::mem::zeroed::<INPUT>();
                input_up.r#type = INPUT_MOUSE;
                input_up.Anonymous.mi = {
                    let mut mi = std::mem::zeroed::<MOUSEINPUT>();
                    mi.dwFlags = up_flag;
                    mi
                };

                platform::SendInput(1, &mut input_down, std::mem::size_of::<INPUT>() as i32);
                platform::SendInput(1, &mut input_up, std::mem::size_of::<INPUT>() as i32);

                if clicks > 1 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
        Ok(())
    }

    /// Drag from start to end position.
    fn drag(&self, start_x: i32, start_y: i32, end_x: i32, end_y: i32, duration: f64) -> PyResult<()> {
        #[cfg(windows)]
        unsafe {
            platform::SetCursorPos(start_x, start_y);
            std::thread::sleep(std::time::Duration::from_millis(10));

            // Mouse down
            let mut input_down = std::mem::zeroed::<INPUT>();
            input_down.r#type = INPUT_MOUSE;
            input_down.Anonymous.mi = {
                let mut mi = std::mem::zeroed::<MOUSEINPUT>();
                mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
                mi
            };
            platform::SendInput(1, &mut input_down, std::mem::size_of::<INPUT>() as i32);
            std::thread::sleep(std::time::Duration::from_millis(10));

            // Move with interpolation
            let steps = (duration * 60.0) as i32;
            let steps = steps.max(10).min(120);
            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                let ix = (start_x as f64 + (end_x - start_x) as f64 * t) as i32;
                let iy = (start_y as f64 + (end_y - start_y) as f64 * t) as i32;
                platform::SetCursorPos(ix, iy);
                std::thread::sleep(std::time::Duration::from_millis(
                    (duration * 1000.0 / steps as f64) as u64
                ));
            }

            // Mouse up
            let mut input_up = std::mem::zeroed::<INPUT>();
            input_up.r#type = INPUT_MOUSE;
            input_up.Anonymous.mi = {
                let mut mi = std::mem::zeroed::<MOUSEINPUT>();
                mi.dwFlags = MOUSEEVENTF_LEFTUP;
                mi
            };
            platform::SendInput(1, &mut input_up, std::mem::size_of::<INPUT>() as i32);
        }
        Ok(())
    }

    /// Scroll mouse wheel.
    fn scroll(&self, clicks: i32, x: Option<i32>, y: Option<i32>) -> PyResult<()> {
        #[cfg(windows)]
        unsafe {
            if let (Some(px), Some(py)) = (x, y) {
                platform::SetCursorPos(px, py);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            let mut input = std::mem::zeroed::<INPUT>();
            input.r#type = INPUT_MOUSE;
            input.Anonymous.mi = {
                let mut mi = std::mem::zeroed::<MOUSEINPUT>();
                mi.dwFlags = MOUSEEVENTF_WHEEL;
                mi.mouseData = (clicks * 120) as u32; // WHEEL_DELTA = 120
                mi
            };
            platform::SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32);
        }
        Ok(())
    }

    /// Type Unicode text using SendInput (bypasses IME).
    fn type_unicode(&self, text: &str, delay_per_char: f64) -> PyResult<()> {
        #[cfg(windows)]
        unsafe {
            for ch in text.chars() {
                // Key down
                let mut input_down = std::mem::zeroed::<INPUT>();
                input_down.r#type = INPUT_KEYBOARD;
                input_down.Anonymous.ki = {
                    let mut ki = std::mem::zeroed::<KEYBDINPUT>();
                    ki.wScan = ch as u16;
                    ki.dwFlags = KEYEVENTF_UNICODE;
                    ki
                };

                // Key up
                let mut input_up = std::mem::zeroed::<INPUT>();
                input_up.r#type = INPUT_KEYBOARD;
                input_up.Anonymous.ki = {
                    let mut ki = std::mem::zeroed::<KEYBDINPUT>();
                    ki.wScan = ch as u16;
                    ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                    ki
                };

                platform::SendInput(1, &mut input_down, std::mem::size_of::<INPUT>() as i32);
                platform::SendInput(1, &mut input_up, std::mem::size_of::<INPUT>() as i32);

                if delay_per_char > 0.0 {
                    std::thread::sleep(std::time::Duration::from_secs_f64(delay_per_char));
                }
            }
        }
        Ok(())
    }

    /// Press a key combo like "ctrl+c" or "alt+tab".
    fn press_key(&self, key_combo: &str) -> PyResult<()> {
        // Parse key combo and send - simplified implementation
        let parts: Vec<&str> = key_combo.split('+').map(|s| s.trim()).collect();
        if parts.is_empty() {
            return Ok(());
        }

        #[cfg(windows)]
        unsafe {
            let vk_code = virtual_key_code(parts.last().unwrap());
            let mut input = std::mem::zeroed::<INPUT>();
            input.r#type = INPUT_KEYBOARD;
            input.Anonymous.ki = {
                let mut ki = std::mem::zeroed::<KEYBDINPUT>();
                ki.wVk = vk_code as u16;
                ki
            };

            platform::SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32);

            // Key up
            let mut input_up = input;
            input_up.Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
            platform::SendInput(1, &mut input_up, std::mem::size_of::<INPUT>() as i32);
        }
        Ok(())
    }

    /// Get display metrics reference.
    fn get_metrics(&self) -> DesktopMetrics {
        self.metrics.clone()
    }
}

/// Get singleton NativeDesktopEngine instance.
#[pyfunction]
fn get_native_desktop() -> PyResult<NativeDesktopEngine> {
    NativeDesktopEngine::create()
}

/// Convert key name to virtual key code (Windows).
#[cfg(windows)]
fn virtual_key_code(name: &str) -> u32 {
    match name.to_lowercase().as_str() {
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "esc" | "escape" => 0x1B,
        "space" => 0x20,
        "backspace" => 0x08,
        "delete" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "f1" => 0x70,
        "f2" => 0x71,
        "f3" => 0x72,
        "f4" => 0x73,
        "f5" => 0x74,
        "f6" => 0x75,
        "f7" => 0x76,
        "f8" => 0x77,
        "f9" => 0x78,
        "f10" => 0x79,
        "f11" => 0x7A,
        "f12" => 0x7B,
        "ctrl" => 0xA2,
        "alt" => 0xA4,
        "shift" => 0xA0,
        "win" => 0x5B,
        c if c.len() == 1 => c.chars().next().unwrap() as u32,
        _ => 0x41, // default 'a'
    }
}

#[cfg(not(windows))]
fn virtual_key_code(_name: &str) -> u32 { 0 }

// Simple rand helper for Bezier jitter
fn rand_jitter(range: i32) -> i32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(42);
    ((nanos % (range as u32 * 2 + 1)) as i32) - range
}

/// Register the native_desktop submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "native_desktop")?;
    m.add_class::<DesktopMetrics>()?;
    m.add_class::<NativeDesktopEngine>()?;
    m.add_function(wrap_pyfunction!(get_native_desktop, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
