//! native_desktop - faithful Rust port of backend/native_desktop.py (Native → Rust).
//!
//! Industrial-grade Windows GUI engine: GDI screen capture, DPI-aware metrics,
//! SendInput keyboard/mouse, quadratic-Bezier mouse movement, hardware failsafe,
//! and top-level window enumeration.
//!
//! FIDELITY MODEL (per D:\ovolve-migration RULEBOOK):
//! - Every float computation goes through CPython objects (pyo3 number
//!   protocol), so IEEE results match the original module bit-for-bit.
//! - int()/round()/max()/min()/ord() are the *Python* builtins (banker's
//!   rounding, trunc-toward-zero, Unicode ord semantics incl. its TypeError).
//! - All OS calls funnel through `os_call(name, args)`. When a recorder
//!   callable is installed via `_set_os_recorder` (parity harness only) it
//!   services every call; otherwise the real Win32 APIs are used.
//! - DIVERGENCE(port): in fake mode a failing os() propagates as the
//!   exception raised by the recorder, while CPython ctypes would usually
//!   return 0 silently for a failing user32 call. Real mode emulates the
//!   silent-0 paths (BitBlt/GetDIBits/SelectObject returns ignored, failed
//!   GetDIBits yields a zero buffer - bug-for-bug), so this only matters for
//!   adversarial fakes, which the parity suite does not use.
//! - DIVERGENCE(port): non-numeric arguments (max_dim, clicks, coords) raise
//!   at the binding boundary with a different message than CPython would;
//!   all numeric paths are identical.
//! - list_top_level_windows always uses the real Win32 path, mirroring the
//!   Python function's local `user32 = ctypes.windll.user32` re-binding,
//!   which bypassed any module-level patching (bug-for-bug).
// PORT STATUS: confidence=high todos=[0]

use pyo3::ffi;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList, PyString, PyTuple};
use std::sync::Mutex;

type B<'py> = Bound<'py, PyAny>;

// ─── OS seam (recorder for parity tests; real Win32 otherwise) ──────────────

static RECORDER: Mutex<Option<PyObject>> = Mutex::new(None);

fn recorder_now(py: Python) -> Option<PyObject> {
    let g = RECORDER.lock().ok()?;
    g.as_ref().map(|c| c.clone_ref(py))
}

/// Dispatch one normalized OS call. `args` are scalar (JSON-able) values of
/// the recorder protocol; exact shapes are documented in the parity harness.
fn os_call<'py>(py: Python<'py>, name: &str, args: Vec<B<'py>>) -> PyResult<B<'py>> {
    if let Some(cb) = recorder_now(py) {
        let a = PyList::new_bound(py, args);
        return cb.call1(py, (name, a)).map(|o| o.into_bound(py));
    }
    real_os(py, name, &args)
}

fn os_int(py: Python, name: &str, args: Vec<B<'_>>) -> PyResult<i64> {
    os_call(py, name, args)?.extract::<i64>()
}

fn obj<'py>(py: Python<'py>, v: i64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

fn fobj<'py>(py: Python<'py>, v: f64) -> PyResult<B<'py>> {
    Ok(v.to_object(py).into_bound(py).into_any())
}

/// Positions cross the seam as any 2-sequence; the Python API returns a
/// fresh tuple (`return pt.x, pt.y`), so normalize to a tuple of ints.
fn pos_tuple<'py>(py: Python<'py>, p: &B<'py>) -> PyResult<Bound<'py, PyTuple>> {
    let (x, y) = pos_xy(p)?;
    Ok(PyTuple::new_bound(py, vec![obj(py, x)?, obj(py, y)?]))
}

fn pos_xy(p: &B<'_>) -> PyResult<(i64, i64)> {
    Ok((p.get_item(0)?.extract::<i64>()?, p.get_item(1)?.extract::<i64>()?))
}

/// SendInput event in normalized protocol form:
///   ["mouse", dwFlags, mouseData]  /  ["key", wVk, wScan, dwFlags]
enum Ev {
    Mouse { flags: i64, data: i64 },
    Key { vk: i64, scan: i64, flags: i64 },
}

impl Ev {
    fn to_py<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let items: Vec<B<'py>> = match self {
            Ev::Mouse { flags, data } => {
                vec![PyString::new_bound(py, "mouse").into_any(), obj(py, *flags)?, obj(py, *data)?]
            }
            Ev::Key { vk, scan, flags } => {
                vec![
                    PyString::new_bound(py, "key").into_any(),
                    obj(py, *vk)?,
                    obj(py, *scan)?,
                    obj(py, *flags)?,
                ]
            }
        };
        Ok(PyList::new_bound(py, items))
    }
}

/// The Python code sends exactly one INPUT per SendInput call; mirror that.
fn send_input(py: Python, ev: &Ev) -> PyResult<()> {
    let inner = ev.to_py(py)?;
    let events = PyList::new_bound(py, vec![inner.into_any()]);
    os_call(py, "SendInput", vec![events.into_any()])?;
    Ok(())
}

// ─── CPython-object arithmetic helpers (bit-exact parity) ───────────────────

fn p_add<'py>(a: &Bound<'py, PyAny>, b: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    let py = a.py();
    unsafe { Py::from_owned_ptr_or_err(py, ffi::PyNumber_Add(a.as_ptr(), b.as_ptr())) }
        .map(|o| o.into_bound(py))
}
fn p_sub<'py>(a: &Bound<'py, PyAny>, b: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    let py = a.py();
    unsafe { Py::from_owned_ptr_or_err(py, ffi::PyNumber_Subtract(a.as_ptr(), b.as_ptr())) }
        .map(|o| o.into_bound(py))
}
fn p_mul<'py>(a: &Bound<'py, PyAny>, b: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    let py = a.py();
    unsafe { Py::from_owned_ptr_or_err(py, ffi::PyNumber_Multiply(a.as_ptr(), b.as_ptr())) }
        .map(|o| o.into_bound(py))
}
fn p_truediv<'py>(a: &Bound<'py, PyAny>, b: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    let py = a.py();
    unsafe { Py::from_owned_ptr_or_err(py, ffi::PyNumber_TrueDivide(a.as_ptr(), b.as_ptr())) }
        .map(|o| o.into_bound(py))
}
fn p_powi<'py>(a: &Bound<'py, PyAny>, e: i64) -> PyResult<B<'py>> {
    let py = a.py();
    let ex = e.to_object(py).into_bound(py).into_any();
    // CPython's PyNumber_Power treats a NULL third operand as a ternary pow
    // (float** raises); pass real None like the `**` operator does.
    let none = py.None();
    unsafe {
        Py::from_owned_ptr_or_err(
            py,
            ffi::PyNumber_Power(a.as_ptr(), ex.as_ptr(), none.as_ptr()),
        )
    }
    .map(|o| o.into_bound(py))
}

fn builtins(py: Python) -> PyResult<Bound<'_, PyModule>> {
    Ok(py.import_bound("builtins")?)
}

/// Python `int(x)`: truncates toward zero; raises OverflowError for
/// inf/nan exactly like CPython. Result kept as an object (arbitrary
/// precision preserved for the wire protocol).
fn py_int_obj<'py>(py: Python<'py>, x: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("int")?.call1((x,))?)
}

fn py_int(py: Python, x: &Bound<'_, PyAny>) -> PyResult<i64> {
    let i = py_int_obj(py, x)?;
    i.extract::<i64>().map_err(|_| {
        pyo3::exceptions::PyOverflowError::new_err(
            "integer float representation too large to convert",
        )
    })
}

fn py_ord(py: Python, ch: &str) -> PyResult<i64> {
    let r = builtins(py)?.getattr("ord")?.call1((ch,))?;
    r.extract::<i64>()
}

fn py_max2<'py>(py: Python<'py>, a: &Bound<'py, PyAny>, b: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("max")?.call1(((a, b),))?)
}

fn py_min2<'py>(py: Python<'py>, a: &Bound<'py, PyAny>, b: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    Ok(builtins(py)?.getattr("min")?.call1(((a, b),))?)
}

fn math_f<'py>(py: Python<'py>, fname: &str, x: &Bound<'py, PyAny>) -> PyResult<B<'py>> {
    Ok(py.import_bound("math")?.getattr(fname)?.call1((x,))?)
}

// ─── Display metrics ─────────────────────────────────────────────────────────

/// Port of DesktopMetrics.get_metrics(). Fallback rules replicated exactly:
/// width/height fall back to 1920/1080; virtual_* fall back to the *raw*
/// primary values (which may themselves be 0 - BUG(port) in the original,
/// faithfully kept: on failure virtual_width can be 0, not 1920).
fn metrics_values(py: Python) -> PyResult<(i64, i64, i64, i64, PyObject)> {
    let phys_w = os_int(py, "GetSystemMetrics", vec![obj(py, 0)?])?;
    let phys_h = os_int(py, "GetSystemMetrics", vec![obj(py, 1)?])?;
    let virt_w = os_int(py, "GetSystemMetrics", vec![obj(py, 78)?])?;
    let virt_h = os_int(py, "GetSystemMetrics", vec![obj(py, 79)?])?;

    // try: hdc = GetDC(0); log_x = GetDeviceCaps(hdc, 88); ReleaseDC(0, hdc);
    //      scale = round(log_x / 96.0, 2)     # banker's rounding, via CPython
    // except Exception: scale = 1.0
    let scale_try: PyResult<B<'_>> = (|| {
        let hdc = os_int(py, "GetDC", vec![obj(py, 0)?])?;
        let log_x = os_int(py, "GetDeviceCaps", vec![obj(py, hdc)?, obj(py, 88)?])?;
        os_call(py, "ReleaseDC", vec![obj(py, 0)?, obj(py, hdc)?])?;
        let d = p_truediv(&obj(py, log_x)?, &fobj(py, 96.0)?)?;
        Ok(builtins(py)?.getattr("round")?.call1((d, 2))?)
    })();
    let scale: B<'_> = match scale_try {
        Ok(v) => v,
        Err(_) => fobj(py, 1.0)?,
    };
    let scale_owned = scale.to_object(py);

    let w = if phys_w > 0 { phys_w } else { 1920 };
    let h = if phys_h > 0 { phys_h } else { 1080 };
    let vw = if virt_w > 0 { virt_w } else { phys_w };
    let vh = if virt_h > 0 { virt_h } else { phys_h };
    Ok((w, h, vw, vh, scale_owned))
}

fn metrics_dict(py: Python) -> PyResult<Bound<'_, PyDict>> {
    let (w, h, vw, vh, scale) = metrics_values(py)?;
    let d = PyDict::new_bound(py);
    d.set_item("width", w)?;
    d.set_item("height", h)?;
    d.set_item("virtual_width", vw)?;
    d.set_item("virtual_height", vh)?;
    d.set_item("scale_factor", scale.bind(py).clone())?;
    Ok(d)
}

// ─── Virtual-key map (identical to the Python VK_MAP) ───────────────────────

static VK_MAP: &[(&str, i64)] = &[
    ("enter", 0x0D),
    ("return", 0x0D),
    ("tab", 0x09),
    ("space", 0x20),
    ("backspace", 0x08),
    ("escape", 0x1B),
    ("esc", 0x1B),
    ("delete", 0x2E),
    ("del", 0x2E),
    ("ctrl", 0x11),
    ("control", 0x11),
    ("alt", 0x12),
    ("shift", 0x10),
    ("win", 0x5B),
    ("cmd", 0x5B),
    ("windows", 0x5B),
    ("up", 0x26),
    ("down", 0x28),
    ("left", 0x25),
    ("right", 0x27),
    ("pageup", 0x21),
    ("pagedown", 0x22),
    ("home", 0x24),
    ("end", 0x23),
    ("f1", 0x70),
    ("f2", 0x71),
    ("f3", 0x72),
    ("f4", 0x73),
    ("f5", 0x74),
    ("f6", 0x75),
    ("f7", 0x76),
    ("f8", 0x77),
    ("f9", 0x78),
    ("f10", 0x79),
    ("f11", 0x7A),
    ("f12", 0x7B),
];

fn vk_lookup(name: &str) -> Option<i64> {
    VK_MAP.iter().find(|(k, _)| *k == name).map(|(_, v)| *v)
}

// SendInput flag constants (match the Python module)
const MOUSEEVENTF_LEFTDOWN: i64 = 0x0002;
const MOUSEEVENTF_LEFTUP: i64 = 0x0004;
const MOUSEEVENTF_RIGHTDOWN: i64 = 0x0008;
const MOUSEEVENTF_RIGHTUP: i64 = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN: i64 = 0x0020;
const MOUSEEVENTF_MIDDLEUP: i64 = 0x0040;
const MOUSEEVENTF_WHEEL: i64 = 0x0800;
const KEYEVENTF_KEYUP: i64 = 0x0002;
const KEYEVENTF_UNICODE: i64 = 0x0004;

// ─── Win32 engine ────────────────────────────────────────────────────────────

#[pyclass]
pub struct DesktopMetrics;

#[pymethods]
impl DesktopMetrics {
    /// Get current display metrics (exact Python dict shape).
    #[staticmethod]
    fn get_metrics(py: Python) -> PyResult<Bound<'_, PyDict>> {
        metrics_dict(py)
    }
}

#[pyclass]
struct NativeDesktopEngine {
    #[pyo3(get, set)]
    failsafe_enabled: bool,
    #[pyo3(get, set)]
    _last_cursor_pos: PyObject,
}

impl NativeDesktopEngine {
    fn create(py: Python) -> PyResult<Self> {
        // def __init__(self): self._last_cursor_pos = self.get_cursor_pos()
        let cp = pos_tuple(py, &os_call(py, "GetCursorPos", vec![])?)?.to_object(py);
        Ok(Self { failsafe_enabled: true, _last_cursor_pos: cp })
    }

    fn set_last<'py>(&mut self, py: Python<'py>, x: &B<'py>, y: &B<'py>) {
        self._last_cursor_pos = (x.clone(), y.clone()).to_object(py);
    }
}

#[pymethods]
impl NativeDesktopEngine {
    #[new]
    fn new(py: Python) -> PyResult<Self> {
        Self::create(py)
    }

    fn get_cursor_pos<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyTuple>> {
        pos_tuple(py, &os_call(py, "GetCursorPos", vec![])?)
    }

    /// Physical hardware failsafe: returns False if a human physically
    /// seized the mouse (drift > 50px from `expected`) or holds Escape
    /// down. True = safe (same polarity as the Python method).
    #[pyo3(signature = (expected=None))]
    fn check_failsafe(
        &self,
        py: Python,
        expected: Option<B<'_>>,
    ) -> PyResult<bool> {
        if !self.failsafe_enabled {
            return Ok(true);
        }
        let cp = os_call(py, "GetCursorPos", vec![])?;
        let (cx, cy) = pos_xy(&cp)?;
        if let Some(exp) = &expected {
            let (ex, ey) = pos_xy(exp)?;
            let dx = (cx - ex).abs();
            let dy = (cy - ey).abs();
            if dx > 50 || dy > 50 {
                return Ok(false);
            }
        }
        let aks = os_int(py, "GetAsyncKeyState", vec![obj(py, 0x1B)?])?;
        if aks & 0x8000 != 0 {
            return Ok(false);
        }
        Ok(true)
    }

    /// Ultra-fast GDI screenshot with optional ROI crop, downscale and JPEG
    /// data-URI. The PIL encode chain runs through the same interpreter as
    /// the original, so data_uri bytes are identical.
    #[pyo3(signature = (roi=None, max_dim=1920, quality=None))]
    fn capture_screen<'py>(
        &self,
        py: Python<'py>,
        roi: Option<B<'py>>,
        max_dim: i64,
        quality: Option<Py<PyAny>>,
    ) -> PyResult<Bound<'py, PyDict>> {
        // Default kept semantically identical to Python's quality=80; the
        // signature shows None because Py<PyAny> defaults aren't expressible.
        let quality = match quality {
            Some(q) => q.into_bound(py),
            None => obj(py, 80)?,
        };
        let (w, h, _vw, _vh, scale) = metrics_values(py)?;

        let hwin = os_int(py, "GetDesktopWindow", vec![])?;
        let hwindc = os_int(py, "GetWindowDC", vec![obj(py, hwin)?])?;
        let srcdc = os_int(py, "CreateCompatibleDC", vec![obj(py, hwindc)?])?;
        let bmp = os_int(
            py,
            "CreateCompatibleBitmap",
            vec![obj(py, hwindc)?, obj(py, w)?, obj(py, h)?],
        )?;
        let old_bmp = os_int(py, "SelectObject", vec![obj(py, srcdc)?, obj(py, bmp)?])?;
        // SRCCOPY (0x00CC0020) | CAPTUREBLT (0x40000000) for layered windows
        os_call(
            py,
            "BitBlt",
            vec![
                obj(py, srcdc)?,
                obj(py, 0)?,
                obj(py, 0)?,
                obj(py, w)?,
                obj(py, h)?,
                obj(py, hwindc)?,
                obj(py, 0)?,
                obj(py, 0)?,
                obj(py, 0x40CC_0020)?,
            ],
        )?;
        let buf = os_call(
            py,
            "GetDIBits",
            vec![obj(py, srcdc)?, obj(py, bmp)?, obj(py, w)?, obj(py, h)?],
        )?;
        // GDI handle cleanup; Python ignores all these returns (order kept).
        os_call(py, "SelectObject", vec![obj(py, srcdc)?, obj(py, old_bmp)?])?;
        os_call(py, "DeleteObject", vec![obj(py, bmp)?])?;
        os_call(py, "DeleteDC", vec![obj(py, srcdc)?])?;
        os_call(py, "ReleaseDC", vec![obj(py, hwin)?, obj(py, hwindc)?])?;

        // Image pipeline via CPython PIL - byte-identical by construction.
        let image_mod = py.import_bound("PIL.Image")?;
        let buf = buf.downcast::<PyBytes>()?;
        let mut img: B<'py> =
            image_mod.call_method1("frombuffer", ("RGBA", (w, h), buf, "raw", "BGRA", 0, 1))?;
        img = img.call_method1("convert", ("RGB",))?;

        if let Some(r) = &roi {
            if r.is_truthy()? {
                // `if roi:` truthiness then 4-tuple unpack; empty tuple is
                // falsy in Python and skips the crop - replicated.
                let (rx, ry, rw, rh): (i64, i64, i64, i64) = r.extract().map_err(|_| {
                    pyo3::exceptions::PyTypeError::new_err(
                        "cannot unpack the ROI sequence into 4 values",
                    )
                })?;
                img = img.call_method1("crop", ((rx, ry, rx + rw, ry + rh),))?;
            }
        }

        let (orig_w, orig_h): (i64, i64) = img.getattr("size")?.extract()?;
        if orig_w.max(orig_h) > max_dim {
            // scale = max_dim / float(max(ow, oh)); new = int(orig * scale)
            let mx = py_max2(py, &obj(py, orig_w)?, &obj(py, orig_h)?)?;
            let fm = builtins(py)?.getattr("float")?.call1((mx,))?;
            let sc = p_truediv(&obj(py, max_dim)?, &fm)?;
            let nw = py_int(py, &p_mul(&obj(py, orig_w)?, &sc)?)?;
            let nh = py_int(py, &p_mul(&obj(py, orig_h)?, &sc)?)?;
            let lanczos = image_mod.getattr("Resampling")?.getattr("LANCZOS")?;
            img = img.call_method1("resize", ((nw, nh), lanczos))?;
        }

        let bio = py.import_bound("io")?.getattr("BytesIO")?.call0()?;
        let kw = PyDict::new_bound(py);
        kw.set_item("format", "JPEG")?;
        kw.set_item("quality", quality)?;
        kw.set_item("optimize", true)?;
        img.call_method("save", (bio.clone(),), Some(&kw))?;
        let raw = bio.call_method0("getvalue")?;
        let bytes_length = raw.len()?;
        let b64: String = py
            .import_bound("base64")?
            .call_method1("b64encode", (raw,))?
            .call_method1("decode", ("ascii",))?
            .extract()?;

        let d = PyDict::new_bound(py);
        d.set_item("image", img)?;
        d.set_item("width", orig_w)?;
        d.set_item("height", orig_h)?;
        d.set_item("scale_factor", scale.bind(py).clone())?;
        d.set_item("data_uri", format!("data:image/jpeg;base64,{}", b64))?;
        d.set_item("bytes_length", bytes_length)?;
        Ok(d)
    }

    /// Moves cursor with clamping and an optional human-like quadratic
    /// Bezier path. Quirks kept bug-for-bug: `expected` is only passed to
    /// the failsafe on step 1 (drift measured against the *start* point);
    /// the final SetCursorPos runs even after a failsafe break.
    #[pyo3(signature = (x, y, smooth=true, duration=None))]
    fn move_cursor<'py>(
        &mut self,
        py: Python<'py>,
        x: B<'py>,
        y: B<'py>,
        smooth: bool,
        duration: Option<Py<PyAny>>,
    ) -> PyResult<()> {
        let duration = match duration {
            Some(d) => d.into_bound(py),
            None => fobj(py, 0.2)?,
        };
        let (sw, sh, _vw, _vh, _sc) = metrics_values(py)?;

        // x = max(0, min(x, sw - 1)); y = max(0, min(y, sh - 1))
        let x = py_max2(
            py,
            &obj(py, 0)?,
            &py_min2(py, &x, &p_sub(&obj(py, sw)?, &obj(py, 1)?)?)?,
        )?;
        let y = py_max2(
            py,
            &obj(py, 0)?,
            &py_min2(py, &y, &p_sub(&obj(py, sh)?, &obj(py, 1)?)?)?,
        )?;

        if !smooth || duration.le(&obj(py, 0)?)? {
            os_call(
                py,
                "SetCursorPos",
                vec![py_int_obj(py, &x)?, py_int_obj(py, &y)?],
            )?;
            self.set_last(py, &x, &y);
            return Ok(());
        }

        let start = os_call(py, "GetCursorPos", vec![])?;
        let (start_x, start_y) = pos_xy(&start)?;
        let start_xo = obj(py, start_x)?;
        let start_yo = obj(py, start_y)?;

        // steps = max(5, int(duration * 60))
        let raw_steps = py_int(py, &p_mul(&duration, &obj(py, 60)?)?)?;
        let steps = py_max2(py, &obj(py, 5)?, &obj(py, raw_steps)?)?.extract::<i64>()?;
        let steps_o = obj(py, steps)?;

        // Control points; time.time() is called twice (once per axis) - kept.
        let sinv = math_f(py, "sin", &os_call(py, "time", vec![])?)?;
        let ctrl_x = p_add(
            &p_add(
                &start_xo,
                &p_mul(&p_sub(&x, &start_xo)?, &fobj(py, 0.25)?)?,
            )?,
            &p_mul(&sinv, &obj(py, 15)?)?,
        )?;
        let cosv = math_f(py, "cos", &os_call(py, "time", vec![])?)?;
        let ctrl_y = p_sub(
            &p_add(
                &start_yo,
                &p_mul(&p_sub(&y, &start_yo)?, &fobj(py, 0.75)?)?,
            )?,
            &p_mul(&cosv, &obj(py, 15)?)?,
        )?;

        let one = fobj(py, 1.0)?;
        let two = fobj(py, 2.0)?;
        for i in 1..=steps {
            let exp_ref: Option<B<'py>> = if i == 1 {
                Some((start_x, start_y).to_object(py).into_bound(py).into_any())
            } else {
                None
            };
            if !self.check_failsafe(py, exp_ref)? {
                break;
            }
            let t = p_truediv(&obj(py, i)?, &steps_o)?;
            let ti = p_sub(&one, &t)?;
            // ((1-t)**2 * s + 2*(1-t)*t*ctrl) + t**2 * e   (left-assoc, exact)
            let cx = p_add(
                &p_add(
                    &p_mul(&p_powi(&ti, 2)?, &start_xo)?,
                    &p_mul(&p_mul(&p_mul(&two, &ti)?, &t)?, &ctrl_x)?,
                )?,
                &p_mul(&p_powi(&t, 2)?, &x)?,
            )?;
            let cy = p_add(
                &p_add(
                    &p_mul(&p_powi(&ti, 2)?, &start_yo)?,
                    &p_mul(&p_mul(&p_mul(&two, &ti)?, &t)?, &ctrl_y)?,
                )?,
                &p_mul(&p_powi(&t, 2)?, &y)?,
            )?;
            os_call(
                py,
                "SetCursorPos",
                vec![py_int_obj(py, &cx)?, py_int_obj(py, &cy)?],
            )?;
            os_call(py, "sleep", vec![p_truediv(&duration, &steps_o)?])?;
        }

        // Runs even when the failsafe broke the loop - bug-for-bug.
        os_call(
            py,
            "SetCursorPos",
            vec![py_int_obj(py, &x)?, py_int_obj(py, &y)?],
        )?;
        self.set_last(py, &x, &y);
        Ok(())
    }

    #[pyo3(signature = (x=None, y=None, button=None, clicks=1))]
    fn click<'py>(
        &mut self,
        py: Python<'py>,
        x: Option<B<'py>>,
        y: Option<B<'py>>,
        button: Option<Bound<'py, PyString>>,
        clicks: i64,
    ) -> PyResult<()> {
        if let (Some(px), Some(pyv)) = (x, y) {
            self.move_cursor(py, px, pyv, true, Some(fobj(py, 0.15)?.to_object(py)))?;
            os_call(py, "sleep", vec![fobj(py, 0.05)?])?;
        }
        let btn = match button {
            Some(s) => s.call_method0("lower")?.extract::<String>()?,
            None => "left".to_string(),
        };
        let (down_flag, up_flag) = match btn.as_str() {
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        };
        for _ in 0..clicks {
            send_input(py, &Ev::Mouse { flags: down_flag, data: 0 })?;
            os_call(py, "sleep", vec![fobj(py, 0.04)?])?;
            send_input(py, &Ev::Mouse { flags: up_flag, data: 0 })?;
            os_call(py, "sleep", vec![fobj(py, 0.06)?])?;
        }
        Ok(())
    }

    #[pyo3(signature = (start_x, start_y, end_x, end_y, duration=None))]
    fn drag<'py>(
        &mut self,
        py: Python<'py>,
        start_x: i64,
        start_y: i64,
        end_x: i64,
        end_y: i64,
        duration: Option<Py<PyAny>>,
    ) -> PyResult<()> {
        let duration = match duration {
            Some(d) => d.into_bound(py),
            None => fobj(py, 0.5)?,
        };
        self.move_cursor(
            py,
            obj(py, start_x)?,
            obj(py, start_y)?,
            true,
            Some(fobj(py, 0.2)?.to_object(py)),
        )?;
        os_call(py, "sleep", vec![fobj(py, 0.05)?])?;
        send_input(py, &Ev::Mouse { flags: MOUSEEVENTF_LEFTDOWN, data: 0 })?;
        os_call(py, "sleep", vec![fobj(py, 0.08)?])?;
        self.move_cursor(
            py,
            obj(py, end_x)?,
            obj(py, end_y)?,
            true,
            Some(duration.to_object(py)),
        )?;
        os_call(py, "sleep", vec![fobj(py, 0.08)?])?;
        send_input(py, &Ev::Mouse { flags: MOUSEEVENTF_LEFTUP, data: 0 })?;
        Ok(())
    }

    #[pyo3(signature = (clicks, x=None, y=None))]
    fn scroll<'py>(
        &mut self,
        py: Python<'py>,
        clicks: i64,
        x: Option<B<'py>>,
        y: Option<B<'py>>,
    ) -> PyResult<()> {
        if let (Some(px), Some(pyv)) = (x, y) {
            self.move_cursor(py, px, pyv, false, Some(fobj(py, 0.2)?.to_object(py)))?;
        }
        // WHEEL_DELTA = 120; c_ulong(wheel & 0xFFFFFFFF) wrap semantics.
        let wheel = clicks * 120;
        let data = wheel & 0xFFFF_FFFF;
        send_input(py, &Ev::Mouse { flags: MOUSEEVENTF_WHEEL, data })?;
        Ok(())
    }

    /// Hardware-level Unicode typing (KEYEVENTF_UNICODE), immune to IME.
    /// wScan lands in a c_ushort: codes > 0xFFFF wrap mod 65536 silently.
    #[pyo3(signature = (text, delay_per_char=0.01))]
    fn type_unicode(&self, py: Python, text: String, delay_per_char: f64) -> PyResult<()> {
        for ch in text.chars() {
            let mut ub = [0u8; 4];
            let code = py_ord(py, ch.encode_utf8(&mut ub))?;
            let scan = code % 0x1_0000; // c_ushort silent wrap (code >= 0)
            send_input(py, &Ev::Key { vk: 0, scan, flags: KEYEVENTF_UNICODE })?;
            send_input(
                py,
                &Ev::Key { vk: 0, scan, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP },
            )?;
            if delay_per_char > 0.0 {
                os_call(py, "sleep", vec![fobj(py, delay_per_char)?])?;
            }
        }
        Ok(())
    }

    /// Press keys or combos ('enter', 'ctrl+s', 'win+r'). Quirks kept:
    /// unknown multi-char keys push 0 (skipped later); single chars consult
    /// VkKeyScanW(ord(upper)) & 0xFF and fall back to the ord() value -
    /// which raises TypeError for chars whose uppercase is a 2-char string
    /// (e.g. 'ß'), bug-for-bug.
    fn press_key<'py>(&self, py: Python<'py>, key_combo: Bound<'py, PyString>) -> PyResult<()> {
        let raw: Vec<Bound<'py, PyString>> = key_combo.call_method1("split", ("+",))?.extract()?;
        let mut parts: Vec<Bound<'py, PyString>> = Vec::new();
        for p in raw {
            let stripped = p.call_method0("strip")?;
            if stripped.is_truthy()? {
                parts.push(stripped.call_method0("lower")?.extract()?);
            }
        }
        if parts.is_empty() {
            return Ok(());
        }

        let mut vk_codes: Vec<i64> = Vec::new();
        for p in &parts {
            let key: String = p.extract()?;
            if let Some(vk) = vk_lookup(&key) {
                vk_codes.push(vk);
            } else if p.len()? == 1 {
                let up = p.call_method0("upper")?;
                let code = py_ord(py, &up.extract::<String>()?)?;
                let vk = os_int(py, "VkKeyScanW", vec![obj(py, code)?])? & 0xFF;
                if vk > 0 {
                    vk_codes.push(vk);
                } else {
                    vk_codes.push(code);
                }
            } else {
                vk_codes.push(0); // VK_MAP.get(p, 0) - p is not in the map here
            }
        }

        let d02 = fobj(py, 0.02)?;
        for vk in &vk_codes {
            if *vk == 0 {
                continue;
            }
            send_input(py, &Ev::Key { vk: *vk, scan: 0, flags: 0 })?;
            os_call(py, "sleep", vec![d02.clone()])?;
        }
        os_call(py, "sleep", vec![fobj(py, 0.05)?])?;
        for vk in vk_codes.iter().rev() {
            if *vk == 0 {
                continue;
            }
            send_input(py, &Ev::Key { vk: *vk, scan: 0, flags: KEYEVENTF_KEYUP })?;
            os_call(py, "sleep", vec![d02.clone()])?;
        }
        Ok(())
    }
}

// ─── Window enumeration (always the real Win32 path; see header) ────────────

#[pyfunction]
fn list_top_level_windows(py: Python) -> PyResult<Bound<'_, PyList>> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging as wm;

        static ENUM_SINK: Mutex<Vec<i64>> = Mutex::new(Vec::new());
        unsafe extern "system" fn cb(hwnd: HWND, _lparam: LPARAM) -> i32 {
            if let Ok(mut g) = ENUM_SINK.lock() {
                g.push(hwnd as i64);
            }
            1
        }
        // SAFETY: standard EnumWindows callback; the sink mutex serializes
        // enumeration access.
        unsafe {
            if let Ok(mut g) = ENUM_SINK.lock() {
                g.clear();
            }
            wm::EnumWindows(Some(cb), 0);
        }
        let hwnds: Vec<i64> = std::mem::take(&mut *ENUM_SINK.lock().unwrap());

        let rows = PyList::empty_bound(py);
        for h in hwnds {
            let hh = h as HWND;
            // SAFETY: plain read-only window queries on live HWND handles.
            unsafe {
                if wm::IsWindowVisible(hh) == 0 {
                    continue;
                }
                let n = wm::GetWindowTextLengthW(hh);
                if n <= 0 {
                    continue;
                }
                let mut buf = vec![0u16; (n + 1) as usize];
                let k = wm::GetWindowTextW(hh, buf.as_mut_ptr(), n + 1);
                let end = (k.max(0) as usize).min(buf.len());
                let title = String::from_utf16_lossy(&buf[..end]);
                let mut pid: u32 = 0;
                wm::GetWindowThreadProcessId(hh, &mut pid);
                let d = PyDict::new_bound(py);
                d.set_item("hwnd", h)?;
                d.set_item("title", title)?;
                d.set_item("pid", pid as i64)?;
                d.set_item("visible", true)?;
                rows.append(d)?;
            }
        }
        Ok(rows)
    }
    #[cfg(not(windows))]
    {
        let _ = py;
        Err(pyo3::exceptions::PyOSError::new_err(
            "list_top_level_windows only runs on Windows",
        ))
    }
}

// ─── DPI awareness init (import-time chain in the Python module) ────────────

/// Replays the Python import-time chain:
///   try user32.SetProcessDpiAwarenessContext(c_void_p(-4))
///   except: try shcore.SetProcessDpiAwareness(2)
///   except: try user32.SetProcessDPIAware()
///   except: pass  (fail-open)
/// Resolution is dynamic (LoadLibrary/GetProcAddress) so the extension keeps
/// loading cleanly on old Windows hosts, exactly like the ctypes attribute
/// lookups did (missing symbol -> attempt fails -> next try). The Python
/// module runs this at import; the Rust adapter calls this once at import
/// (DIVERGENCE(port): call-site moved, sequence identical).
#[pyfunction]
fn init_dpi_awareness(py: Python) -> PyResult<()> {
    if !cfg!(windows) {
        return Ok(()); // py gates the chain behind _IS_WINDOWS
    }
    if os_call(py, "SetProcessDpiAwarenessContext", vec![obj(py, -4)?]).is_ok() {
        return Ok(());
    }
    if os_call(py, "SetProcessDpiAwareness", vec![obj(py, 2)?]).is_ok() {
        return Ok(());
    }
    let _ = os_call(py, "SetProcessDPIAware", vec![]);
    Ok(())
}

#[cfg(windows)]
fn dpi_call(sym: &str, arg: i64) -> PyResult<i64> {
    use std::ffi::CString;
    use windows_sys::Win32::Foundation::FreeLibrary;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    unsafe fn attempt(lib: &str, sym: &str, arg: i64) -> Option<i64> {
        let mut wlib = [0u16; 32];
        for (i, u) in lib.encode_utf16().take(31).enumerate() {
            wlib[i] = u;
        }
        let h = LoadLibraryW(wlib.as_ptr());
        if h == 0 {
            return None;
        }
        let c = CString::new(sym).ok()?;
        let p = GetProcAddress(h, c.as_ptr() as *const u8);
        let p = match p {
            Some(f) => f as *const u8 as usize,
            None => {
                FreeLibrary(h);
                return None;
            }
        };
        let r = if sym == "SetProcessDpiAwarenessContext" {
            type F = unsafe extern "system" fn(isize) -> i32;
            std::mem::transmute::<usize, F>(p)(arg as isize)
        } else if sym == "SetProcessDpiAwareness" {
            type F = unsafe extern "system" fn(u32) -> i32;
            std::mem::transmute::<usize, F>(p)(arg as u32)
        } else {
            type F = unsafe extern "system" fn() -> i32;
            std::mem::transmute::<usize, F>(p)()
        };
        FreeLibrary(h);
        Some(r as i64)
    }
    // SAFETY: pointers resolved via GetProcAddress and invoked through exact
    // Win32 ABI signatures; null handles and symbols checked beforehand.
    unsafe { attempt("user32.dll", sym, arg) }.ok_or_else(|| {
        pyo3::exceptions::PyOSError::new_err("native_desktop only runs on Windows (needs user32/gdi32)")
    })
}

// ─── Real-mode OS dispatch ───────────────────────────────────────────────────

#[cfg(windows)]
fn real_os<'py>(py: Python<'py>, name: &str, args: &[B<'py>]) -> PyResult<B<'py>> {
    use windows_sys::Win32::Graphics::Gdi as gdi;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse as kb;
    use windows_sys::Win32::UI::WindowsAndMessaging as wm;

    macro_rules! a {
        ($i:expr) => {
            args[$i].extract::<i64>()?
        };
    }
    let r = match name {
        "GetSystemMetrics" => {
            let idx = a!(0);
            // SAFETY: plain read of user metrics.
            let v = unsafe {
                match idx {
                    0 => wm::GetSystemMetrics(wm::SM_CXSCREEN),
                    1 => wm::GetSystemMetrics(wm::SM_CYSCREEN),
                    78 => wm::GetSystemMetrics(wm::SM_CXVIRTUALSCREEN),
                    79 => wm::GetSystemMetrics(wm::SM_CYVIRTUALSCREEN),
                    other => wm::GetSystemMetrics(other as i32),
                }
            };
            v as i64
        }
        // SAFETY: plain GDI/user32 handle round-trips; all handle values
        // originate from matching create calls in this same dispatch.
        "GetDC" => unsafe { gdi::GetDC(a!(0) as _) as i64 },
        "ReleaseDC" => unsafe { gdi::ReleaseDC(a!(0) as _, a!(1) as _) as i64 },
        "GetDeviceCaps" => unsafe { gdi::GetDeviceCaps(a!(0) as _, a!(1) as i32) as i64 },
        "GetDesktopWindow" => unsafe { wm::GetDesktopWindow() as i64 },
        "GetWindowDC" => unsafe { gdi::GetWindowDC(a!(0) as _) as i64 },
        "CreateCompatibleDC" => unsafe { gdi::CreateCompatibleDC(a!(0) as _) as i64 },
        "CreateCompatibleBitmap" => unsafe {
            gdi::CreateCompatibleBitmap(a!(0) as _, a!(1) as i32, a!(2) as i32) as i64
        },
        "SelectObject" => unsafe { gdi::SelectObject(a!(0) as _, a!(1) as _) as i64 },
        "DeleteObject" => unsafe { gdi::DeleteObject(a!(0) as _) as i64 },
        "DeleteDC" => unsafe { gdi::DeleteDC(a!(0) as _) as i64 },
        "BitBlt" => unsafe {
            gdi::BitBlt(
                a!(0) as _,
                a!(1) as i32,
                a!(2) as i32,
                a!(3) as i32,
                a!(4) as i32,
                a!(5) as _,
                a!(6) as i32,
                a!(7) as i32,
                a!(8) as u32,
            ) as i64
        },
        "GetDIBits" => {
            // Python pre-zeroes the buffer and ignores the return code: a
            // failed call yields an all-black frame, not an error. Replicated.
            let (hdc, hb, w, h) = (a!(0), a!(1), a!(2), a!(3));
            let mut bmi: gdi::BITMAPINFO = unsafe { std::mem::zeroed() };
            bmi.bmiHeader.biSize = std::mem::size_of::<gdi::BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w as i32;
            bmi.bmiHeader.biHeight = -(h as i32); // top-down DIB
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = gdi::BI_RGB;
            let mut buf = vec![0u8; (w.max(0) * h.max(0) * 4) as usize];
            unsafe {
                gdi::GetDIBits(
                    hdc as _,
                    hb as _,
                    0,
                    h as u32,
                    buf.as_mut_ptr() as *mut std::ffi::c_void,
                    &mut bmi,
                    gdi::DIB_RGB_COLORS,
                )
            };
            return Ok(PyBytes::new_bound(py, &buf).into_any());
        }
        "GetCursorPos" => {
            let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            let ok = unsafe { wm::GetCursorPos(&mut pt) };
            let (x, y) = if ok != 0 { (pt.x, pt.y) } else { (0, 0) };
            return Ok(PyList::new_bound(
                py,
                vec![obj(py, x as i64)?, obj(py, y as i64)?],
            )
            .into_any());
        }
        "SetCursorPos" => unsafe { wm::SetCursorPos(a!(0) as i32, a!(1) as i32) as i64 },
        "SendInput" => {
            use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
                INPUT, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, MOUSEINPUT,
            };
            let events: Bound<'_, PyList> = args[0].extract()?;
            let mut inputs: Vec<INPUT> = Vec::new();
            for e in events.iter() {
                let l: Bound<'_, PyList> = e.extract()?;
                let kind: String = l.get_item(0)?.extract()?;
                let mut inp: INPUT = unsafe { std::mem::zeroed() };
                if kind == "mouse" {
                    inp.r#type = INPUT_MOUSE;
                    unsafe {
                        inp.Anonymous.mi = MOUSEINPUT {
                            dx: 0,
                            dy: 0,
                            mouseData: l.get_item(2)?.extract::<i64>()? as u32,
                            dwFlags: l.get_item(1)?.extract::<i64>()? as u32,
                            time: 0,
                            dwExtraInfo: 0,
                        };
                    }
                } else {
                    inp.r#type = INPUT_KEYBOARD;
                    unsafe {
                        inp.Anonymous.ki = KEYBDINPUT {
                            wVk: l.get_item(1)?.extract::<i64>()? as u16,
                            wScan: l.get_item(2)?.extract::<i64>()? as u16,
                            dwFlags: l.get_item(3)?.extract::<i64>()? as u32,
                            time: 0,
                            dwExtraInfo: 0,
                        };
                    }
                }
                inputs.push(inp);
            }
            // SAFETY: INPUT array built above with matching cbSize; the OS
            // may clamp delivery, which matches ctypes behaviour.
            let n = unsafe {
                kb::SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                )
            };
            n as i64
        }
        "VkKeyScanW" => unsafe { kb::VkKeyScanW(a!(0) as u16) as i64 },
        "GetAsyncKeyState" => unsafe { kb::GetAsyncKeyState(a!(0) as i32) as i64 },
        "SetProcessDpiAwarenessContext" => dpi_call("SetProcessDpiAwarenessContext", a!(0))?,
        "SetProcessDpiAwareness" => dpi_call("SetProcessDpiAwareness", a!(0))?,
        "SetProcessDPIAware" => dpi_call("SetProcessDPIAware", 0)?,
        // time.sleep / time.time: not Win32 APIs, but they flow through the
        // same seam so the parity recorder sees them. Real mode: std clock.
        "time" => {
            let d = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| pyo3::exceptions::PyOSError::new_err(e.to_string()))?;
            return fobj(py, d.as_secs_f64());
        }
        "sleep" => {
            let secs: f64 = args[0].extract()?;
            std::thread::sleep(std::time::Duration::from_secs_f64(secs.max(0.0)));
            return Ok(py.None().into_bound(py));
        }
        _ => {
            return Err(pyo3::exceptions::PyNotImplementedError::new_err(format!(
                "real_os: unhandled API {name}"
            )))
        }
    };
    Ok(r.to_object(py).into_bound(py))
}

#[cfg(not(windows))]
fn real_os<'py>(py: Python<'py>, _name: &str, _args: &[B<'py>]) -> PyResult<B<'py>> {
    // Mirrors _MissingWinDLL.__getattr__ raising on every entry point.
    let _ = py;
    Err(pyo3::exceptions::PyOSError::new_err(
        "native_desktop only runs on Windows (needs user32/gdi32)",
    ))
}

// ─── Singleton + module registration ────────────────────────────────────────

static ENGINE_SINGLETON: Mutex<Option<Py<NativeDesktopEngine>>> = Mutex::new(None);

#[pyfunction]
fn get_native_desktop(py: Python) -> PyResult<Py<NativeDesktopEngine>> {
    let mut g = ENGINE_SINGLETON
        .lock()
        .map_err(|_| pyo3::exceptions::PyRuntimeError::new_err("singleton lock poisoned"))?;
    if let Some(p) = g.as_ref() {
        return Ok(p.clone_ref(py));
    }
    let e = Py::new(py, NativeDesktopEngine::create(py)?)?;
    *g = Some(e.clone_ref(py));
    Ok(e)
}

/// Test-only seam used by the parity harness: install (or clear with None) a
/// Python callable that records/serves every OS interaction instead of
/// touching the live desktop.
#[pyfunction]
#[pyo3(signature = (rec=None))]
fn _set_os_recorder(rec: Option<PyObject>) -> PyResult<()> {
    let mut g = RECORDER
        .lock()
        .map_err(|_| pyo3::exceptions::PyRuntimeError::new_err("recorder lock poisoned"))?;
    *g = rec;
    Ok(())
}

/// Register the native_desktop submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let py = parent.py();
    let m = PyModule::new_bound(parent.py(), "native_desktop")?;
    m.add_class::<DesktopMetrics>()?;
    m.add_class::<NativeDesktopEngine>()?;
    m.add_function(wrap_pyfunction!(get_native_desktop, &m)?)?;
    m.add_function(wrap_pyfunction!(list_top_level_windows, &m)?)?;
    m.add_function(wrap_pyfunction!(init_dpi_awareness, &m)?)?;
    m.add_function(wrap_pyfunction!(_set_os_recorder, &m)?)?;
    let vk = PyDict::new_bound(py);
    for (k, v) in VK_MAP {
        vk.set_item(*k, *v)?;
    }
    m.add("VK_MAP", vk)?;
    parent.add_submodule(&m)?;
    Ok(())
}
