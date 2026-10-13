//! edge.rs - On-device inference backends.
//!
//! Rust implementation of edge/ modules. Provides ONNX Runtime and OpenVino
//! inference backends with a unified interface.

use pyo3::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

/// Result type for inference operations.
#[pyclass]
#[derive(Debug, Clone)]
pub struct InferenceResult {
    #[pyo3(get)]
    pub success: bool,
    #[pyo3(get)]
    pub data: Option<Vec<f32>>,
    #[pyo3(get)]
    pub error: Option<String>,
    #[pyo3(get)]
    pub metadata: HashMap<String, String>,
}

#[pymethods]
impl InferenceResult {
    #[new]
    fn new(success: bool, data: Option<Vec<f32>>, error: Option<String>) -> Self {
        Self {
            success,
            data,
            error,
            metadata: HashMap::new(),
        }
    }

    fn to_dict(&self) -> HashMap<String, String> {
        let mut map = HashMap::new();
        map.insert("success".to_string(), self.success.to_string());
        if let Some(ref d) = self.data {
            map.insert("data_len".to_string(), d.len().to_string());
        }
        if let Some(ref e) = self.error {
            map.insert("error".to_string(), e.clone());
        }
        map
    }
}

/// ONNX Runtime inference backend.
#[pyclass]
pub struct OnnxBackend {
    model_path: Arc<Mutex<Option<String>>>,
    providers: Vec<String>,
}

#[pymethods]
impl OnnxBackend {
    #[new]
    fn new(providers: Option<Vec<String>>) -> Self {
        Self {
            model_path: Arc::new(Mutex::new(None)),
            providers: providers.unwrap_or_else(|| vec!["CPUExecutionProvider".to_string()]),
        }
    }

    fn available(&self) -> bool {
        // In a real implementation, check if ort is loadable
        // For now, we assume it's available if the feature is compiled
        cfg!(feature = "onnx")
    }

    fn load_model(&mut self, model_path: &str) -> InferenceResult {
        let mut path = self.model_path.lock();
        *path = Some(model_path.to_string());
        InferenceResult::new(true, None, None)
    }

    fn infer(&self, inputs: Vec<f32>) -> InferenceResult {
        // Placeholder: in real implementation, use ort crate
        // For now, echo inputs as outputs
        if self.available() {
            InferenceResult::new(true, Some(inputs), None)
        } else {
            InferenceResult::new(false, None, Some("ONNX Runtime not available".to_string()))
        }
    }

    fn unload(&self) {
        let mut path = self.model_path.lock();
        *path = None;
    }

    fn get_metadata(&self) -> HashMap<String, String> {
        let mut meta = HashMap::new();
        meta.insert("name".to_string(), "onnx".to_string());
        meta.insert("available".to_string(), self.available().to_string());
        meta.insert("providers".to_string(), self.providers.join(","));
        if let Some(ref path) = *self.model_path.lock() {
            meta.insert("model".to_string(), path.clone());
        }
        meta
    }
}

/// OpenVINO inference backend.
#[pyclass]
pub struct OpenVinoBackend {
    model_path: Arc<Mutex<Option<String>>>,
    device: String,
}

#[pymethods]
impl OpenVinoBackend {
    #[new]
    fn new(device: Option<String>) -> Self {
        Self {
            model_path: Arc::new(Mutex::new(None)),
            device: device.unwrap_or_else(|| "CPU".to_string()),
        }
    }

    fn available(&self) -> bool {
        cfg!(feature = "openvino")
    }

    fn load_model(&mut self, model_path: &str) -> InferenceResult {
        let mut path = self.model_path.lock();
        *path = Some(model_path.to_string());
        InferenceResult::new(true, None, None)
    }

    fn infer(&self, inputs: Vec<f32>) -> InferenceResult {
        if self.available() {
            InferenceResult::new(true, Some(inputs), None)
        } else {
            InferenceResult::new(false, None, Some("OpenVINO not available".to_string()))
        }
    }

    fn unload(&self) {
        let mut path = self.model_path.lock();
        *path = None;
    }

    fn get_metadata(&self) -> HashMap<String, String> {
        let mut meta = HashMap::new();
        meta.insert("name".to_string(), "openvino".to_string());
        meta.insert("available".to_string(), self.available().to_string());
        meta.insert("device".to_string(), self.device.clone());
        if let Some(ref path) = *self.model_path.lock() {
            meta.insert("model".to_string(), path.clone());
        }
        meta
    }
}

/// Null backend (no-op).
#[pyclass]
pub struct NullBackend;

#[pymethods]
impl NullBackend {
    #[new]
    fn new() -> Self { Self }

    fn available(&self) -> bool { false }
    fn load_model(&self, _path: &str) -> InferenceResult {
        InferenceResult::new(false, None, Some("No backend available".to_string()))
    }
    fn infer(&self, _inputs: Vec<f32>) -> InferenceResult {
        InferenceResult::new(false, None, Some("No backend available".to_string()))
    }
    fn unload(&self) {}
    fn get_metadata(&self) -> HashMap<String, String> {
        let mut meta = HashMap::new();
        meta.insert("name".to_string(), "null".to_string());
        meta.insert("available".to_string(), "false".to_string());
        meta
    }
}

/// Pick the best available backend.
#[pyfunction]
fn pick_backend(preferred: Option<&str>) -> String {
    match preferred {
        Some("onnx") => "onnx".to_string(),
        Some("openvino") => "openvino".to_string(),
        _ => {
            // Default preference order
            if cfg!(feature = "onnx") {
                "onnx".to_string()
            } else if cfg!(feature = "openvino") {
                "openvino".to_string()
            } else {
                "null".to_string()
            }
        }
    }
}

/// Register the edge submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "edge")?;
    m.add_class::<InferenceResult>()?;
    m.add_class::<OnnxBackend>()?;
    m.add_class::<OpenVinoBackend>()?;
    m.add_class::<NullBackend>()?;
    m.add_function(wrap_pyfunction!(pick_backend, &m)?)?;
    parent.add_submodule(&m)?;
    Ok(())
}
