//! ovolve_core: High-performance Rust engine for OvolveAgent
//!
//! Provides ultra-fast string search & diff patching with smart auto-diagnosis,
//! zero-copy spill stream filtering with Head-Tail preview,
//! and multilingual inverted-index BM25 scoring (supporting English words, CJK unigrams/bigrams, and tag boosting).

use std::collections::{HashMap, HashSet};

/// Near match candidate for self-healing auto-diagnosis
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct CandidateMatch {
    pub line_number: usize,
    pub preview: String,
    pub similarity: f64,
}

/// Precision string replacement result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ReplaceResult {
    pub success: bool,
    #[serde(alias = "matched")]
    pub matched: bool,
    pub content: String,
    #[serde(alias = "replacements_made")]
    pub replaced_count: usize,
    pub error: Option<String>,
    pub diagnostics: Option<String>,
    pub candidates: Option<Vec<CandidateMatch>>,
}

/// Computes Levenshtein distance between two strings
pub fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let s1_chars: Vec<char> = s1.chars().collect();
    let s2_chars: Vec<char> = s2.chars().collect();
    let len1 = s1_chars.len();
    let len2 = s2_chars.len();

    if len1 == 0 {
        return len2;
    }
    if len2 == 0 {
        return len1;
    }

    let mut dp = vec![vec![0usize; len2 + 1]; len1 + 1];

    for i in 0..=len1 {
        dp[i][0] = i;
    }
    for j in 0..=len2 {
        dp[0][j] = j;
    }

    for i in 1..=len1 {
        for j in 1..=len2 {
            let cost = if s1_chars[i - 1] == s2_chars[j - 1] { 0 } else { 1 };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }

    dp[len1][len2]
}

/// Computes normalized character similarity between target and candidate line
pub fn compute_similarity(s1: &str, s2: &str) -> f64 {
    let clean1: String = s1.chars().filter(|c| !c.is_whitespace()).collect();
    let clean2: String = s2.chars().filter(|c| !c.is_whitespace()).collect();

    if clean1.is_empty() || clean2.is_empty() {
        return 0.0;
    }
    if clean1 == clean2 {
        return 1.0;
    }
    if clean1.contains(&clean2) || clean2.contains(&clean1) {
        return 0.85;
    }

    let len1 = clean1.chars().count();
    let len2 = clean2.chars().count();
    let max_len = len1.max(len2);
    if max_len == 0 {
        return 1.0;
    }

    let dist = levenshtein_distance(&clean1, &clean2);
    (1.0 - (dist as f64 / max_len as f64)).max(0.0)
}

/// High-speed precision line-range replacement with smart auto-diagnosis fuzzy matching
pub fn replace_file_content_fast(
    original_text: &str,
    target_content: &str,
    replacement_content: &str,
    allow_multiple: bool,
) -> ReplaceResult {
    if !original_text.contains(target_content) {
        // Auto-diagnosis: locate near matches for 1-step self healing
        let lines: Vec<&str> = original_text.lines().collect();
        let target_first_line = target_content.lines().next().unwrap_or("").trim();
        let mut candidates = Vec::new();

        if !target_first_line.is_empty() {
            for (idx, line) in lines.iter().enumerate() {
                let sim = compute_similarity(target_first_line, line);
                if sim >= 0.55 {
                    let start_ctx = idx.saturating_sub(2);
                    let end_ctx = (idx + target_content.lines().count() + 2).min(lines.len());
                    let preview = lines[start_ctx..end_ctx]
                        .iter()
                        .enumerate()
                        .map(|(i, l)| format!("{:4} | {}", start_ctx + i + 1, l))
                        .collect::<Vec<_>>()
                        .join("\n");
                    candidates.push(CandidateMatch {
                        line_number: idx + 1,
                        preview,
                        similarity: sim,
                    });
                    if candidates.len() >= 3 {
                        break;
                    }
                }
            }
        }

        let diagnostics = if !candidates.is_empty() {
            let hints = candidates
                .iter()
                .map(|c| format!("Near Line {} (similarity {:.2}):\n{}", c.line_number, c.similarity, c.preview))
                .collect::<Vec<_>>()
                .join("\n---\n");
            Some(format!(
                "💡 Auto-Diagnosis: target_content was not found exactly (check whitespace/indentation/typo). Found candidate line(s):\n{}\nPlease adjust target_content to match the exact lines above.",
                hints
            ))
        } else {
            None
        };

        return ReplaceResult {
            success: false,
            matched: false,
            content: original_text.to_string(),
            replaced_count: 0,
            error: Some("Target content not found in original text".to_string()),
            diagnostics,
            candidates: if candidates.is_empty() { None } else { Some(candidates) },
        };
    }

    let count = original_text.matches(target_content).count();
    if count > 1 && !allow_multiple {
        return ReplaceResult {
            success: false,
            matched: true,
            content: original_text.to_string(),
            replaced_count: 0,
            error: Some(format!("Found {} occurrences of targetContent but allow_multiple is false", count)),
            diagnostics: Some(format!("Target content appears {} times; provide more surrounding context or set allow_multiple=true", count)),
            candidates: None,
        };
    }

    let new_content = if allow_multiple {
        original_text.replace(target_content, replacement_content)
    } else {
        original_text.replacen(target_content, replacement_content, 1)
    };

    let replacements_made = if allow_multiple { count } else { 1 };

    ReplaceResult {
        success: true,
        matched: true,
        content: new_content,
        replaced_count: replacements_made,
        error: None,
        diagnostics: None,
        candidates: None,
    }
}

/// Head-Tail bounded preview generation for massive tool output
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct SpillPreview {
    pub is_spilled: bool,
    pub total_lines: usize,
    pub total_chars: usize,
    #[serde(alias = "preview_text")]
    pub preview_content: String,
    pub head_lines: usize,
    pub tail_lines: usize,
    pub omitted_lines: usize,
    pub spill_file_path: Option<String>,
}

pub fn generate_spill_preview(
    raw_output: &str,
    threshold_chars: usize,
    head_lines_count: usize,
    tail_lines_count: usize,
) -> SpillPreview {
    let total_chars = raw_output.len();
    let lines: Vec<&str> = raw_output.lines().collect();
    let total_lines = lines.len();

    if total_chars <= threshold_chars {
        return SpillPreview {
            is_spilled: false,
            total_lines,
            total_chars,
            preview_content: raw_output.to_string(),
            head_lines: total_lines,
            tail_lines: 0,
            omitted_lines: 0,
            spill_file_path: None,
        };
    }

    if total_lines <= head_lines_count + tail_lines_count {
        return SpillPreview {
            is_spilled: true,
            total_lines,
            total_chars,
            preview_content: raw_output.to_string(),
            head_lines: total_lines,
            tail_lines: 0,
            omitted_lines: 0,
            spill_file_path: None,
        };
    }

    let head_slice = &lines[..head_lines_count];
    let tail_slice = &lines[total_lines - tail_lines_count..];
    let omitted_lines = total_lines - head_lines_count - tail_lines_count;

    let mut preview = String::with_capacity(head_lines_count * 80 + tail_lines_count * 80 + 200);
    preview.push_str(&head_slice.join("\n"));
    preview.push_str(&format!(
        "\n\n... [⚠️ Output Spilled: omitted {} lines ({} chars). Full log persisted to disk] ...\n\n",
        omitted_lines, total_chars
    ));
    preview.push_str(&tail_slice.join("\n"));

    SpillPreview {
        is_spilled: true,
        total_lines,
        total_chars,
        preview_content: preview,
        head_lines: head_lines_count,
        tail_lines: tail_lines_count,
        omitted_lines,
        spill_file_path: None,
    }
}

/// Inverted Index BM25 item score
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Bm25Doc {
    pub id: String,
    pub tags: Vec<String>,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Bm25SearchResult {
    #[serde(alias = "doc_id")]
    pub id: String,
    pub score: f64,
    pub snippet: String,
}

pub struct Bm25Index {
    docs: Vec<Bm25Doc>,
    doc_lens: Vec<usize>,
    avgdl: f64,
    doc_freqs: HashMap<String, usize>,
    k1: f64,
    b: f64,
}

impl Bm25Index {
    pub fn new(docs: Vec<Bm25Doc>) -> Self {
        let n = docs.len();
        if n == 0 {
            return Self {
                docs: vec![],
                doc_lens: vec![],
                avgdl: 0.0,
                doc_freqs: HashMap::new(),
                k1: 1.5,
                b: 0.75,
            };
        }

        let mut doc_lens = Vec::with_capacity(n);
        let mut total_len = 0;
        let mut doc_freqs: HashMap<String, usize> = HashMap::new();

        for doc in &docs {
            let tokens = Self::tokenize(&doc.content);
            let len = tokens.len();
            doc_lens.push(len);
            total_len += len;

            let unique_tokens: HashSet<String> = tokens.into_iter().collect();
            for t in unique_tokens {
                *doc_freqs.entry(t).or_insert(0) += 1;
            }
        }

        let avgdl = if n > 0 { total_len as f64 / n as f64 } else { 0.0 };
        Self {
            docs,
            doc_lens,
            avgdl,
            doc_freqs,
            k1: 1.5,
            b: 0.75,
        }
    }

    /// Enhanced multilingual tokenizer (supporting English words and CJK unigrams/bigrams)
    pub fn tokenize(text: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut current_word = String::new();
        let chars: Vec<char> = text.to_lowercase().chars().collect();
        let mut cjk_chars: Vec<char> = Vec::new();

        for &c in &chars {
            if c.is_alphanumeric() {
                if c.is_ascii_alphanumeric() {
                    if !cjk_chars.is_empty() {
                        cjk_chars.clear();
                    }
                    current_word.push(c);
                } else {
                    // CJK character
                    if !current_word.is_empty() {
                        tokens.push(std::mem::take(&mut current_word));
                    }
                    // Unigram
                    tokens.push(c.to_string());
                    cjk_chars.push(c);
                    // Bigram if previous character was also CJK
                    if cjk_chars.len() >= 2 {
                        let len = cjk_chars.len();
                        let bigram: String = [cjk_chars[len - 2], cjk_chars[len - 1]].iter().collect();
                        tokens.push(bigram);
                    }
                }
            } else {
                if !current_word.is_empty() {
                    tokens.push(std::mem::take(&mut current_word));
                }
                cjk_chars.clear();
            }
        }

        if !current_word.is_empty() {
            tokens.push(current_word);
        }

        tokens
    }

    pub fn search(&self, query: &str, top_k: usize) -> Vec<Bm25SearchResult> {
        let n = self.docs.len() as f64;
        if n == 0.0 {
            return vec![];
        }

        let q_tokens = Self::tokenize(query);
        let mut scores: Vec<(usize, f64)> = Vec::with_capacity(self.docs.len());

        for (idx, doc) in self.docs.iter().enumerate() {
            let doc_tokens = Self::tokenize(&doc.content);
            let dl = self.doc_lens[idx] as f64;
            let mut score = 0.0;

            let mut tf_map: HashMap<String, usize> = HashMap::new();
            for t in &doc_tokens {
                *tf_map.entry(t.clone()).or_insert(0) += 1;
            }

            for qt in &q_tokens {
                if let Some(&df) = self.doc_freqs.get(qt) {
                    let idf = ((n - df as f64 + 0.5) / (df as f64 + 0.5) + 1.0).ln();
                    let tf = *tf_map.get(qt).unwrap_or(&0) as f64;
                    let num = tf * (self.k1 + 1.0);
                    let den = tf + self.k1 * (1.0 - self.b + self.b * (dl / self.avgdl));
                    score += idf * (num / den);
                }
            }

            // Tag match bonus (+2.0 per tag match)
            for tag in &doc.tags {
                if query.to_lowercase().contains(&tag.to_lowercase()) {
                    score += 2.0;
                }
            }

            if score > 0.0 {
                scores.push((idx, score));
            }
        }

        scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scores.truncate(top_k);

        scores
            .into_iter()
            .map(|(idx, s)| {
                let doc = &self.docs[idx];
                let snippet = doc.content.chars().take(200).collect::<String>();
                Bm25SearchResult {
                    id: doc.id.clone(),
                    score: s,
                    snippet,
                }
            })
            .collect()
    }
}

// ── PyO3 bindings (built only via maturin with --features python-bindings) ──

#[cfg(feature = "python-bindings")]
mod python_bindings {
    use pyo3::exceptions::PyValueError;
    use pyo3::prelude::*;
    use pyo3::types::{PyDict, PyList};

    fn candidate_to_py<'py>(py: Python<'py>, c: &super::CandidateMatch) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new(py);
        d.set_item("line_number", c.line_number)?;
        d.set_item("preview", &c.preview)?;
        d.set_item("similarity", c.similarity)?;
        Ok(d)
    }

    fn replace_result_to_py<'py>(py: Python<'py>, r: &super::ReplaceResult) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new(py);
        d.set_item("success", r.success)?;
        d.set_item("matched", r.matched)?;
        d.set_item("content", &r.content)?;
        d.set_item("replaced_count", r.replaced_count)?;
        d.set_item("error", r.error.clone())?;
        d.set_item("diagnostics", r.diagnostics.clone())?;
        match &r.candidates {
            Some(cands) => {
                let list = PyList::empty(py);
                for c in cands {
                    list.append(candidate_to_py(py, c)?)?;
                }
                d.set_item("candidates", list)?;
            }
            None => d.set_item("candidates", Option::<Vec<PyObject>>::None)?,
        }
        Ok(d)
    }

    fn spill_preview_to_py<'py>(py: Python<'py>, p: &super::SpillPreview) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new(py);
        d.set_item("is_spilled", p.is_spilled)?;
        d.set_item("total_lines", p.total_lines)?;
        d.set_item("total_chars", p.total_chars)?;
        d.set_item("preview_content", &p.preview_content)?;
        d.set_item("head_lines", p.head_lines)?;
        d.set_item("tail_lines", p.tail_lines)?;
        d.set_item("omitted_lines", p.omitted_lines)?;
        d.set_item("spill_file_path", p.spill_file_path.clone())?;
        Ok(d)
    }

    /// Levenshtein distance between two strings (character-based).
    #[pyfunction(name = "levenshtein_distance")]
    fn py_levenshtein_distance(s1: &str, s2: &str) -> usize {
        super::levenshtein_distance(s1, s2)
    }

    /// Normalized character similarity in [0.0, 1.0] (whitespace-insensitive).
    #[pyfunction(name = "compute_similarity")]
    fn py_compute_similarity(s1: &str, s2: &str) -> f64 {
        super::compute_similarity(s1, s2)
    }

    /// Precision replacement with fuzzy auto-diagnosis.
    ///
    /// Returns a dict: success, matched, content, replaced_count, error,
    /// diagnostics, candidates (list of {line_number, preview, similarity}).
    #[pyfunction(name = "replace_file_content_fast")]
    #[pyo3(signature = (original_text, target_content, replacement_content, allow_multiple=false))]
    fn py_replace_file_content_fast<'py>(
        py: Python<'py>,
        original_text: &str,
        target_content: &str,
        replacement_content: &str,
        allow_multiple: bool,
    ) -> PyResult<Bound<'py, PyDict>> {
        if original_text.is_empty() {
            return Err(PyValueError::new_err("original_text must not be empty"));
        }
        let result =
            super::replace_file_content_fast(original_text, target_content, replacement_content, allow_multiple);
        replace_result_to_py(py, &result)
    }

    /// Head-Tail bounded preview for massive tool output.
    #[pyfunction(name = "generate_spill_preview")]
    fn py_generate_spill_preview<'py>(
        py: Python<'py>,
        raw_output: &str,
        threshold_chars: usize,
        head_lines_count: usize,
        tail_lines_count: usize,
    ) -> PyResult<Bound<'py, PyDict>> {
        let p = super::generate_spill_preview(raw_output, threshold_chars, head_lines_count, tail_lines_count);
        spill_preview_to_py(py, &p)
    }

    #[pymodule]
    fn ovolve_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
        m.add_function(wrap_pyfunction!(py_levenshtein_distance, m)?)?;
        m.add_function(wrap_pyfunction!(py_compute_similarity, m)?)?;
        m.add_function(wrap_pyfunction!(py_replace_file_content_fast, m)?)?;
        m.add_function(wrap_pyfunction!(py_generate_spill_preview, m)?)?;
        m.add("__version__", env!("CARGO_PKG_VERSION"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_replace_exact_single() {
        let original = "fn main() {\n    println!(\"hello\");\n}";
        let target = "println!(\"hello\");";
        let replacement = "println!(\"world\");";
        let res = replace_file_content_fast(original, target, replacement, false);
        assert!(res.success);
        assert_eq!(res.replaced_count, 1);
        assert_eq!(res.content, "fn main() {\n    println!(\"world\");\n}");
        assert!(res.error.is_none());
    }

    #[test]
    fn test_replace_multiline_block() {
        let original = "function process() {\n    const a = 1;\n    const b = 2;\n    return a + b;\n}";
        let target = "    const a = 1;\n    const b = 2;";
        let replacement = "    const a = 10;\n    const b = 20;";
        let res = replace_file_content_fast(original, target, replacement, false);
        assert!(res.success);
        assert_eq!(res.replaced_count, 1);
        assert!(res.content.contains("const a = 10;\n    const b = 20;"));
    }

    #[test]
    fn test_replace_unicode_cjk() {
        let original = "// 模块描述：高速执行引擎\nlet status = \"运行中\";\n";
        let target = "let status = \"运行中\";";
        let replacement = "let status = \"已完成\";";
        let res = replace_file_content_fast(original, target, replacement, false);
        assert!(res.success);
        assert_eq!(res.replaced_count, 1);
        assert_eq!(res.content, "// 模块描述：高速执行引擎\nlet status = \"已完成\";\n");
    }

    #[test]
    fn test_replace_multiple_allowed() {
        let original = "foo bar foo baz foo";
        let target = "foo";
        let replacement = "qux";
        let res = replace_file_content_fast(original, target, replacement, true);
        assert!(res.success);
        assert_eq!(res.replaced_count, 3);
        assert_eq!(res.content, "qux bar qux baz qux");
    }

    #[test]
    fn test_replace_multiple_disallowed() {
        let original = "foo bar foo";
        let target = "foo";
        let replacement = "qux";
        let res = replace_file_content_fast(original, target, replacement, false);
        assert!(!res.success);
        assert_eq!(res.replaced_count, 0);
        assert!(res.error.unwrap().contains("Found 2 occurrences"));
    }

    #[test]
    fn test_replace_fuzzy_auto_diagnosis() {
        let original = "function calculateTotal(items: Item[]) {\n  let total = 0;\n  for (const item of items) {\n    total += item.price;\n  }\n  return total;\n}";
        // Target has slightly different whitespace/indentation
        let target = "let total=0;";
        let res = replace_file_content_fast(original, target, "let total = 100;", false);
        assert!(!res.success);
        assert!(res.candidates.is_some());
        let candidates = res.candidates.unwrap();
        assert!(!candidates.is_empty());
        assert_eq!(candidates[0].line_number, 2);
        assert!(res.diagnostics.is_some());
        assert!(res.diagnostics.unwrap().contains("Auto-Diagnosis"));
    }

    #[test]
    fn test_similarity_computation() {
        assert_eq!(compute_similarity("", ""), 0.0);
        assert_eq!(compute_similarity("hello world", "hello world"), 1.0);
        assert_eq!(compute_similarity("hello world", "helloworld"), 1.0);
        assert!(compute_similarity("const x = 10;", "const x=10;") > 0.8);
    }

    #[test]
    fn test_spill_preview_under_threshold() {
        let raw = "short log output\nline 2\nline 3";
        let preview = generate_spill_preview(raw, 1000, 40, 40);
        assert!(!preview.is_spilled);
        assert_eq!(preview.total_lines, 3);
        assert_eq!(preview.preview_content, raw);
        assert_eq!(preview.omitted_lines, 0);
    }

    #[test]
    fn test_spill_preview_over_threshold() {
        let mut lines = Vec::new();
        for i in 1..=200 {
            lines.push(format!("Log line #{:04}: detailed execution trace and memory dump information", i));
        }
        let raw = lines.join("\n");
        let threshold = 500;
        let preview = generate_spill_preview(&raw, threshold, 5, 5);
        assert!(preview.is_spilled);
        assert_eq!(preview.total_lines, 200);
        assert_eq!(preview.head_lines, 5);
        assert_eq!(preview.tail_lines, 5);
        assert_eq!(preview.omitted_lines, 190);
        assert!(preview.preview_content.contains("Log line #0001"));
        assert!(preview.preview_content.contains("Log line #0200"));
        assert!(preview.preview_content.contains("Output Spilled: omitted 190 lines"));
    }

    #[test]
    fn test_spill_preview_short_lines_over_threshold() {
        // High character count but fewer lines than head + tail
        let raw = "a".repeat(2000) + "\n" + &"b".repeat(2000);
        let preview = generate_spill_preview(&raw, 1000, 10, 10);
        assert!(preview.is_spilled);
        assert_eq!(preview.total_lines, 2);
        assert_eq!(preview.omitted_lines, 0);
    }

    #[test]
    fn test_bm25_search_multilingual_and_tags() {
        let docs = vec![
            Bm25Doc {
                id: "doc-1".to_string(),
                tags: vec!["rust".to_string(), "backend".to_string()],
                content: "High-performance execution engine in Rust with low latency.".to_string(),
            },
            Bm25Doc {
                id: "doc-2".to_string(),
                tags: vec!["typescript".to_string(), "frontend".to_string()],
                content: "React UI components with Glassmorphism and Fluid Aura design.".to_string(),
            },
            Bm25Doc {
                id: "doc-3".to_string(),
                tags: vec!["memory".to_string(), "sqlite".to_string()],
                content: "持久化存储与三级记忆引擎，支持中文字符与双字索引检索。".to_string(),
            },
        ];

        let index = Bm25Index::new(docs);

        // English search
        let results_en = index.search("execution rust", 5);
        assert!(!results_en.is_empty());
        assert_eq!(results_en[0].id, "doc-1");

        // Tag boosted search
        let results_tag = index.search("backend", 5);
        assert!(!results_tag.is_empty());
        assert_eq!(results_tag[0].id, "doc-1");

        // Chinese search
        let results_zh = index.search("记忆引擎", 5);
        assert!(!results_zh.is_empty());
        assert_eq!(results_zh[0].id, "doc-3");

        // CJK unigram / bigram search
        let results_cjk = index.search("持久化", 5);
        assert!(!results_cjk.is_empty());
        assert_eq!(results_cjk[0].id, "doc-3");
    }

    #[test]
    fn test_bm25_empty_index() {
        let index = Bm25Index::new(vec![]);
        let results = index.search("anything", 10);
        assert!(results.is_empty());
    }

    #[test]
    fn test_bm25_no_match() {
        let docs = vec![Bm25Doc {
            id: "d1".to_string(),
            tags: vec![],
            content: "quick brown fox jumps".to_string(),
        }];
        let index = Bm25Index::new(docs);
        let results = index.search("zebra elephant", 5);
        assert!(results.is_empty());
    }
}
