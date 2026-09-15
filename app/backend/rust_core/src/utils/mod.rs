//! Shared utilities for Ovolve Core modules.

use pyo3::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

/// L2-normalize a vector in-place. Zero vectors are returned as-is (idempotent).
#[pyfunction]
pub fn l2_normalize(vec: Vec<f32>) -> Vec<f32> {
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm < 1e-10 {
        return vec;
    }
    vec.into_iter().map(|x| x / norm).collect()
}

/// Batch L2-normalize a list of vectors.
#[pyfunction]
pub fn l2_normalize_batch(vectors: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
    vectors.into_iter().map(|v| l2_normalize(v)).collect()
}

/// Cosine similarity between two pre-normalized vectors.
#[pyfunction]
pub fn cosine_similarity(a: Vec<f32>, b: Vec<f32>) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Thread-safe LRU cache for embedding vectors.
#[pyclass]
pub struct VectorCache {
    cache: Arc<Mutex<lru::LruCache<u64, Vec<f32>>>>,
}

#[pymethods]
impl VectorCache {
    #[new]
    fn new(capacity: usize) -> Self {
        Self {
            cache: Arc::new(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(capacity).unwrap_or(std::num::NonZeroUsize::new(1024).unwrap()),
            ))),
        }
    }

    fn get(&self, key: u64) -> Option<Vec<f32>> {
        self.cache.lock().get(&key).cloned()
    }

    fn put(&self, key: u64, value: Vec<f32>) {
        self.cache.lock().put(key, value);
    }

    fn contains(&self, key: u64) -> bool {
        self.cache.lock().contains(&key)
    }

    fn len(&self) -> usize {
        self.cache.lock().len()
    }

    fn clear(&self) {
        self.cache.lock().clear();
    }

    fn stats(&self) -> HashMap<String, usize> {
        let cache = self.cache.lock();
        let mut stats = HashMap::new();
        stats.insert("len".to_string(), cache.len());
        stats.insert("cap".to_string(), cache.cap().get());
        stats
    }
}

/// Compute SHA-1 hash for cache key derivation.
#[pyfunction]
pub fn sha1_hash(text: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Register the utils submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "utils")?;
    m.add_function(wrap_pyfunction!(l2_normalize, &m)?)?;
    m.add_function(wrap_pyfunction!(l2_normalize_batch, &m)?)?;
    m.add_function(wrap_pyfunction!(cosine_similarity, &m)?)?;
    m.add_function(wrap_pyfunction!(sha1_hash, &m)?)?;
    m.add_class::<VectorCache>()?;
    parent.add_submodule(&m)?;
    Ok(())
}
