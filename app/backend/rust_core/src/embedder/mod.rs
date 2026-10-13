//! embedder.rs - High-performance local sentence embedding engine.
//!
//! Rust implementation of embedder.py. Provides vector normalization,
//! cosine similarity, and LRU caching. When ONNX Runtime is available,
//! it delegates to ort crate for hardware-accelerated inference.

use pyo3::prelude::*;
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

/// L2-normalize a vector. Zero vectors are returned as-is.
#[pyfunction]
pub fn l2_normalize_py(vec: Vec<f32>) -> Vec<f32> {
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm < 1e-10 {
        return vec;
    }
    vec.into_iter().map(|x| x / norm).collect()
}

/// Batch L2-normalize.
#[pyfunction]
pub fn l2_normalize_batch_py(vectors: Vec<Vec<f32>>) -> Vec<Vec<f32>> {
    vectors.into_iter().map(|v| l2_normalize_py(v)).collect()
}

/// Cosine similarity between two (pre-normalized) vectors.
#[pyfunction]
pub fn cosine_similarity_py(a: Vec<f32>, b: Vec<f32>) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Thread-safe embedding cache with LRU eviction.
#[pyclass]
pub struct EmbeddingCache {
    cache: Arc<Mutex<lru::LruCache<u64, Vec<f32>>>>,
    hits: Arc<Mutex<u64>>,
    misses: Arc<Mutex<u64>>,
}

#[pymethods]
impl EmbeddingCache {
    #[new]
    fn new(capacity: Option<usize>) -> Self {
        let cap = capacity.unwrap_or(4096);
        Self {
            cache: Arc::new(Mutex::new(lru::LruCache::new(
                std::num::NonZeroUsize::new(cap).unwrap_or(
                    std::num::NonZeroUsize::new(1024).unwrap()
                )
            ))),
            hits: Arc::new(Mutex::new(0)),
            misses: Arc::new(Mutex::new(0)),
        }
    }

    fn get(&self, key: u64) -> Option<Vec<f32>> {
        let result = self.cache.lock().get(&mut key.clone()).cloned();
        if result.is_some() {
            *self.hits.lock() += 1;
        } else {
            *self.misses.lock() += 1;
        }
        result
    }

    fn put(&self, key: u64, value: Vec<f32>) {
        self.cache.lock().put(key, value);
    }

    fn contains(&self, key: u64) -> bool {
        self.cache.lock().contains(&key)
    }

    fn clear(&self) {
        self.cache.lock().clear();
        *self.hits.lock() = 0;
        *self.misses.lock() = 0;
    }

    fn stats(&self) -> HashMap<String, u64> {
        let cache = self.cache.lock();
        let mut stats = HashMap::new();
        stats.insert("len".to_string(), cache.len() as u64);
        stats.insert("cap".to_string(), cache.cap().get() as u64);
        stats.insert("hits".to_string(), *self.hits.lock());
        stats.insert("misses".to_string(), *self.misses.lock());
        stats
    }
}

/// Compute cache key from text.
#[pyfunction]
pub fn compute_cache_key(text: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Register the embedder submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let m = PyModule::new_bound(parent.py(), "embedder")?;
    m.add_function(wrap_pyfunction!(l2_normalize_py, &m)?)?;
    m.add_function(wrap_pyfunction!(l2_normalize_batch_py, &m)?)?;
    m.add_function(wrap_pyfunction!(cosine_similarity_py, &m)?)?;
    m.add_function(wrap_pyfunction!(compute_cache_key, &m)?)?;
    m.add_class::<EmbeddingCache>()?;
    parent.add_submodule(&m)?;
    Ok(())
}
