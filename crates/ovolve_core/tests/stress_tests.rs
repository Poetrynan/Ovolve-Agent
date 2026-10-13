use ovolve_core::{
    generate_spill_preview, replace_file_content_fast, Bm25Doc, Bm25Index,
};

#[test]
fn stress_test_replace_large_file_10mb() {
    // Generate a 10MB text with 50,000 lines
    let mut large_text = String::with_capacity(10 * 1024 * 1024);
    for i in 0..50000 {
        large_text.push_str(&format!("line_{:05}: standard logging information for system component\n", i));
    }

    let target = "line_25000: standard logging information for system component";
    let replacement = "line_25000: CRITICAL_PATCHED_SECURITY_UPDATE";

    let start = std::time::Instant::now();
    let res = replace_file_content_fast(&large_text, target, replacement, false);
    let elapsed = start.elapsed();

    assert!(res.success);
    assert_eq!(res.replaced_count, 1);
    assert!(res.content.contains("CRITICAL_PATCHED_SECURITY_UPDATE"));
    assert!(!res.content.contains("line_25000: standard logging information"));
    assert!(elapsed.as_millis() < 500, "10MB replacement took too long: {:?}", elapsed);
}

#[test]
fn stress_test_replace_multiple_10k_occurrences() {
    let base_pattern = "TOKEN_TO_REPLACE ";
    let large_text = base_pattern.repeat(10000);

    let start = std::time::Instant::now();
    let res = replace_file_content_fast(&large_text, "TOKEN_TO_REPLACE", "NEW_VALUE", true);
    let elapsed = start.elapsed();

    assert!(res.success);
    assert_eq!(res.replaced_count, 10000);
    assert!(!res.content.contains("TOKEN_TO_REPLACE"));
    assert_eq!(res.content.matches("NEW_VALUE").count(), 10000);
    assert!(elapsed.as_millis() < 500, "Multiple replace took too long: {:?}", elapsed);
}

#[test]
fn stress_test_fuzzy_auto_diagnosis_edge_cases() {
    // 1. Empty target and original
    let res_empty = replace_file_content_fast("", "", "foo", false);
    assert!(res_empty.success);

    // 2. Target not found in 10,000 line text with near match at line 8888
    let mut lines = Vec::new();
    for i in 1..=10000 {
        if i == 8888 {
            lines.push("    const databaseConnectionTimeoutMs = 30000;".to_string());
        } else {
            lines.push(format!("    let var_{} = {};", i, i));
        }
    }
    let original = lines.join("\n");

    let typo_target = "const databaseConnectionTimeoutMs=30000;";
    let start = std::time::Instant::now();
    let res_fuzzy = replace_file_content_fast(&original, typo_target, "const timeout = 60000;", false);
    let elapsed = start.elapsed();

    assert!(!res_fuzzy.success);
    assert!(res_fuzzy.candidates.is_some());
    let candidates = res_fuzzy.candidates.unwrap();
    assert!(!candidates.is_empty());
    assert_eq!(candidates[0].line_number, 8888);
    assert!(res_fuzzy.diagnostics.is_some());
    assert!(res_fuzzy.diagnostics.unwrap().contains("Auto-Diagnosis"));
    println!("Fuzzy auto-diagnosis in 10k lines took {:?}", elapsed);
}

#[test]
fn stress_test_unicode_astral_plane_and_special_chars() {
    let original = "Header\n🚀 🦀 🌟 Emoji and CJK 汉字 测试 𠮷野家\nSpecial \\n \\t \\r \" ' ` $ { } [ ] ( ) * + ? ^ .\nFooter";
    let target = "🚀 🦀 🌟 Emoji and CJK 汉字 测试 𠮷野家";
    let replacement = "✨ ⚡ 💥 Emoji Astral CJK 统一码 𠮷野家 修复完成";

    let res = replace_file_content_fast(original, target, replacement, false);
    assert!(res.success);
    assert_eq!(res.replaced_count, 1);
    assert!(res.content.contains("✨ ⚡ 💥 Emoji Astral CJK"));

    // Replace special regex chars without regex escape bugs
    let regex_target = "Special \\n \\t \\r \" ' ` $ { } [ ] ( ) * + ? ^ .";
    let regex_rep = "Special REPLACED";
    let res2 = replace_file_content_fast(&res.content, regex_target, regex_rep, false);
    assert!(res2.success);
    assert!(res2.content.contains("Special REPLACED"));
}

#[test]
fn stress_test_spill_preview_100k_and_1m_chars() {
    // 100k chars
    let mut large_log = String::with_capacity(100_000);
    for i in 1..=2000 {
        large_log.push_str(&format!("[TRACE {:04}] Module worker dispatch pipeline iteration event {}\n", i, i));
    }
    assert!(large_log.len() > 100_000);

    let preview = generate_spill_preview(&large_log, 16000, 40, 40);
    assert!(preview.is_spilled);
    assert_eq!(preview.total_lines, 2000);
    assert_eq!(preview.head_lines, 40);
    assert_eq!(preview.tail_lines, 40);
    assert_eq!(preview.omitted_lines, 1920);
    assert!(preview.preview_content.contains("[TRACE 0001]"));
    assert!(preview.preview_content.contains("[TRACE 2000]"));
    assert!(preview.preview_content.contains("omitted 1920 lines"));

    // Single huge line with 500k characters without newlines
    let huge_line = "A".repeat(500_000);
    let preview_single = generate_spill_preview(&huge_line, 16000, 40, 40);
    assert!(preview_single.is_spilled);
    assert_eq!(preview_single.total_lines, 1);
    assert_eq!(preview_single.omitted_lines, 0);
    assert_eq!(preview_single.preview_content.len(), 500_000);
}

#[test]
fn stress_test_bm25_high_volume_indexing_and_search() {
    let mut docs = Vec::new();
    for i in 0..5000 {
        docs.push(Bm25Doc {
            id: format!("doc_{}", i),
            tags: vec![format!("tag_{}", i % 50), "common".to_string()],
            content: format!(
                "Document {} discussing system architecture, memory cache, database indexing {} and 中文搜索 检索 测试",
                i, i
            ),
        });
    }

    let start_build = std::time::Instant::now();
    let index = Bm25Index::new(docs);
    let build_elapsed = start_build.elapsed();
    println!("BM25 5000 docs build time: {:?}", build_elapsed);

    let start_search = std::time::Instant::now();
    let results = index.search("architecture 检索 tag_42", 10);
    let search_elapsed = start_search.elapsed();
    println!("BM25 search time: {:?}", search_elapsed);

    assert!(!results.is_empty());
    assert!(results.len() <= 10);
    assert!(search_elapsed.as_millis() < 500, "BM25 search too slow: {:?}", search_elapsed);
}
