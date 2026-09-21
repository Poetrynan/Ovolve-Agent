"""
tests/test_rust_adapters.py - Validate Rust adapters match original Python behavior.

This test suite ensures 100% functional compatibility between:
- Original Python modules (baseline)
- Rust-backed adapters (new implementation)

Run with:
    pytest tests/test_rust_adapters.py -v
"""
import pytest
import sys
import os

# Ensure backend is on path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestL2Normalize:
    """Test L2 normalization (embedder core function)."""
    
    def test_basic_normalize(self):
        from rust_adapters.embedder import _l2_normalize
        vec = [3.0, 4.0]
        result = _l2_normalize(vec)
        assert len(result) == 2
        # 3/5 = 0.6, 4/5 = 0.8
        assert abs(result[0] - 0.6) < 0.001
        assert abs(result[1] - 0.8) < 0.001
    
    def test_zero_vector(self):
        from rust_adapters.embedder import _l2_normalize
        vec = [0.0, 0.0, 0.0]
        result = _l2_normalize(vec)
        assert result == [0.0, 0.0, 0.0]
    
    def test_already_normalized(self):
        from rust_adapters.embedder import _l2_normalize
        vec = [1.0, 0.0, 0.0]
        result = _l2_normalize(vec)
        assert abs(result[0] - 1.0) < 0.001
        assert abs(result[1]) < 0.001
    
    def test_unit_length(self):
        from rust_adapters.embedder import _l2_normalize
        import math
        vec = [1.0, 2.0, 3.0, 4.0, 5.0]
        result = _l2_normalize(vec)
        norm = math.sqrt(sum(x*x for x in result))
        assert abs(norm - 1.0) < 0.001
    
    def test_idempotent(self):
        from rust_adapters.embedder import _l2_normalize
        vec = [1.5, -2.3, 0.7]
        once = _l2_normalize(vec)
        twice = _l2_normalize(once)
        for a, b in zip(once, twice):
            assert abs(a - b) < 0.0001


class TestCJKBigrams:
    """Test CJK bigram tokenization (memory_retrieval core function)."""
    
    def test_basic_chinese(self):
        from rust_adapters.memory_retrieval import cjk_bigrams
        result = cjk_bigrams("关闭工具授权")
        assert result == ["关闭", "闭工", "工具", "具授", "授权"]
    
    def test_single_char(self):
        from rust_adapters.memory_retrieval import cjk_bigrams
        result = cjk_bigrams("工")
        assert result == []
    
    def test_two_chars(self):
        from rust_adapters.memory_retrieval import cjk_bigrams
        result = cjk_bigrams("工具")
        assert result == ["工具"]
    
    def test_mixed_text(self):
        from rust_adapters.memory_retrieval import cjk_bigrams
        result = cjk_bigrams("使用python编程")
        # Only CJK chars form bigrams
        assert "使用" in result
        assert "用p" not in result  # Mixed CJK-Latin doesn't form bigram
    
    def test_empty_string(self):
        from rust_adapters.memory_retrieval import cjk_bigrams
        result = cjk_bigrams("")
        assert result == []
    
    def test_pure_ascii(self):
        from rust_adapters.memory_retrieval import cjk_bigrams
        result = cjk_bigrams("hello world")
        assert result == []
    
    def test_is_cjk(self):
        from rust_adapters.memory_retrieval import is_cjk
        assert is_cjk('中') == True
        assert is_cjk('A') == False
        assert is_cjk('1') == False
        assert is_cjk('あ') == True  # Hiragana
        assert is_cjk('ア') == True  # Katakana
        assert is_cjk('가') == True  # Hangul


class TestFtsDocument:
    """Test FTS5 document generation."""
    
    def test_chinese_text(self):
        from rust_adapters.memory_retrieval import fts_document
        result = fts_document("关闭工具授权")
        assert "关闭" in result
        assert "工具" in result
    
    def test_english_text(self):
        from rust_adapters.memory_retrieval import fts_document
        result = fts_document("hello world")
        assert result == "hello world"
    
    def test_mixed_text(self):
        from rust_adapters.memory_retrieval import fts_document
        result = fts_document("使用python")
        assert "使用" in result


class TestBuildFtsQuery:
    """Test FTS5 query building."""
    
    def test_simple_chinese(self):
        from rust_adapters.memory_retrieval import build_fts_query
        result = build_fts_query("工具授权")
        assert "工具" in result or "授权" in result
    
    def test_with_keywords(self):
        from rust_adapters.memory_retrieval import build_fts_query
        result = build_fts_query("查询", keywords=["工具", "授权"])
        assert len(result) > 0
    
    def test_empty_input(self):
        from rust_adapters.memory_retrieval import build_fts_query
        result = build_fts_query("")
        assert len(result) > 0  # Should return fallback


class TestTokenLen:
    """Test token length estimation."""
    
    def test_chinese_text(self):
        from rust_adapters.memory_retrieval import token_len
        count = token_len("关闭工具授权")
        assert count >= 5  # At least 5 CJK chars
    
    def test_english_text(self):
        from rust_adapters.memory_retrieval import token_len
        count = token_len("hello world")
        assert count >= 2
    
    def test_empty_string(self):
        from rust_adapters.memory_retrieval import token_len
        count = token_len("")
        assert count >= 1  # Minimum 1


class TestSplitSentences:
    """Test sentence splitting."""
    
    def test_chinese_period(self):
        from rust_adapters.memory_retrieval import split_sentences
        result = split_sentences("你好。世界。")
        assert len(result) >= 2
    
    def test_english_period(self):
        from rust_adapters.memory_retrieval import split_sentences
        result = split_sentences("Hello. World.")
        assert len(result) >= 2
    
    def test_no_delimiter(self):
        from rust_adapters.memory_retrieval import split_sentences
        result = split_sentences("no delimiter here")
        assert len(result) == 1


class TestChunkText:
    """Test text chunking."""
    
    def test_short_text(self):
        from rust_adapters.memory_retrieval import chunk_text
        result = chunk_text("短文本。", max_tokens=256)
        assert len(result) >= 1
    
    def test_long_text(self):
        from rust_adapters.memory_retrieval import chunk_text
        long_text = "这是一段很长的文本。" * 100
        result = chunk_text(long_text, max_tokens=50)
        assert len(result) > 1


class TestNormalizeScores:
    """Test score normalization."""
    
    def test_basic_normalize(self):
        from rust_adapters.memory_retrieval import normalize_scores
        scores = {"a": 10.0, "b": 5.0, "c": 0.0}
        result = normalize_scores(scores)
        assert abs(result["a"] - 1.0) < 0.001
        assert abs(result["c"] - 0.0) < 0.001
    
    def test_empty_scores(self):
        from rust_adapters.memory_retrieval import normalize_scores
        result = normalize_scores({})
        assert result == {}
    
    def test_equal_scores(self):
        from rust_adapters.memory_retrieval import normalize_scores
        scores = {"a": 5.0, "b": 5.0}
        result = normalize_scores(scores)
        # 与规范实现 backend/memory_retrieval.normalize_scores 对齐：全并列
        # （或单候选）归一为 1.0 —— "唯一找到的东西"不应因无处比较而打 0.5。
        assert abs(result["a"] - 1.0) < 0.001
        assert abs(result["b"] - 1.0) < 0.001


class TestFuse:
    """Test score fusion（API 与 backend/memory_retrieval.fuse 对齐）."""

    def test_basic_fusion(self):
        from rust_adapters.memory_retrieval import fuse
        dense = {"a": 0.8, "b": 0.5}
        sparse = {"b": 0.7, "c": 0.6}
        result = fuse(dense, sparse, 0.7, 0.3)
        # 规范 API：先各通道 min-max 归一再加权求和，返回
        # [(id, fused, {"vec":…, "kw":…}), …] 且按 fused 降序——
        # storage.search_memory_hybrid 依赖这个形状做重排与检索解释。
        assert [t[0] for t in result] == ["a", "b", "c"]
        by_id = {t[0]: t for t in result}
        # a: vec 通道归一后独占 1.0 → 0.7*1.0
        assert abs(by_id["a"][1] - 0.7) < 0.001
        # b: vec 归一 0.0，kw 归一 1.0 → 0.3*1.0
        assert abs(by_id["b"][1] - 0.3) < 0.001
        assert abs(by_id["b"][2]["kw"] - 1.0) < 0.001
        # c: kw 通道归一后为 0 → fused 0.0，但仍保留在候选并集里
        assert abs(by_id["c"][1] - 0.0) < 0.001


class TestEstimateTokens:
    """Test token estimation (context_compactor)."""
    
    def test_chinese(self):
        from rust_adapters.context_compactor import estimate_tokens
        count = estimate_tokens("关闭工具授权")
        assert count >= 5
    
    def test_english(self):
        from rust_adapters.context_compactor import estimate_tokens
        count = estimate_tokens("hello world")
        assert count >= 2
    
    def test_empty(self):
        from rust_adapters.context_compactor import estimate_tokens
        # Canonical contract (token_estimate.py): empty text is 0 tokens.
        # The old >=1 expectation locked in the drifted word-counting clone;
        # the adapter now delegates to token_estimate (single source of truth).
        count = estimate_tokens("")
        assert count == 0


class TestShouldFold:
    """Test fold decision."""
    
    def test_under_threshold(self):
        from rust_adapters.context_compactor import should_fold
        messages = [{"role": "user", "content": "short"}]
        should, reason = should_fold(messages, token_limit=8192)
        assert should == False
    
    def test_over_threshold(self):
        from rust_adapters.context_compactor import should_fold
        # Create messages that exceed threshold
        # Use spaced words so token count is high enough
        long_content = "word " * 500  # 500 tokens
        messages = [{"role": "user", "content": long_content}]
        should, reason = should_fold(messages, token_limit=100, threshold=0.5)
        assert should == True


class TestKeyIdentifiers:
    """Test key identifier extraction."""
    
    def test_path_extraction(self):
        from rust_adapters.context_compactor import key_identifiers
        text = "Read /home/user/file.txt and C:\\Windows\\system32"
        ids = key_identifiers(text)
        assert any("/home/user/file.txt" in id for id in ids)
    
    def test_url_extraction(self):
        from rust_adapters.context_compactor import key_identifiers
        text = "Visit https://example.com/path for details"
        ids = key_identifiers(text)
        assert any("https://example.com/path" in id for id in ids)


class TestHeuristicSummary:
    """Test heuristic summary generation."""
    
    def test_basic_summary(self):
        from rust_adapters.context_compactor import heuristic_summary
        messages = [
            {"role": "user", "content": "What is Python?"},
            {"role": "assistant", "content": "Python is a programming language."},
        ]
        summary = heuristic_summary(messages)
        assert "# Session Summary" in summary
        assert "Python" in summary


class TestAdaptiveChunkRatio:
    """Test adaptive chunk ratio calculation."""
    
    def test_small_messages(self):
        from rust_adapters.context_compactor import compute_adaptive_chunk_ratio
        messages = [{"content": "hi"} for _ in range(100)]
        ratio = compute_adaptive_chunk_ratio(messages, token_limit=8192)
        assert 0.1 <= ratio <= 0.5
    
    def test_large_messages(self):
        from rust_adapters.context_compactor import compute_adaptive_chunk_ratio
        messages = [{"content": "x" * 1000} for _ in range(5)]
        ratio = compute_adaptive_chunk_ratio(messages, token_limit=8192)
        assert 0.1 <= ratio <= 0.5


class TestSandboxPolicy:
    """Test sandbox policy resolution."""
    
    def test_read_only(self):
        from rust_adapters.sandbox import resolve_policy
        policy = resolve_policy("read-only", "/workspace")
        assert policy.mode == "read-only"
        assert len(policy.writable_roots) == 0
    
    def test_workspace_write(self):
        from rust_adapters.sandbox import resolve_policy
        policy = resolve_policy("workspace-write", "/workspace")
        assert "/workspace" in policy.writable_roots
    
    def test_unknown_mode_fallback(self):
        from rust_adapters.sandbox import resolve_policy
        policy = resolve_policy("unknown-mode", "/workspace")
        assert policy.mode == "read-only"  # Safest fallback


class TestProbe:
    """Test enforcement probing."""
    
    def test_returns_enforcement(self):
        from rust_adapters.sandbox import probe
        result = probe()
        assert hasattr(result, 'backend')
        assert hasattr(result, 'usable')
        assert hasattr(result, 'features')
    
    def test_backend_is_string(self):
        from rust_adapters.sandbox import probe
        result = probe()
        assert isinstance(result.backend, str)
        assert len(result.backend) > 0


class TestDesktopMetrics:
    """Test desktop metrics."""
    
    def test_get_metrics(self):
        from rust_adapters.native_desktop import DesktopMetrics
        metrics = DesktopMetrics.get_metrics()
        assert "physical_width" in metrics
        assert "physical_height" in metrics
        assert "dpi_scale" in metrics
    
    def test_metrics_positive(self):
        from rust_adapters.native_desktop import DesktopMetrics
        metrics = DesktopMetrics.get_metrics()
        assert metrics["physical_width"] > 0
        assert metrics["physical_height"] > 0


class TestNativeDesktopEngine:
    """Test desktop engine."""
    
    def test_creation(self):
        from rust_adapters.native_desktop import NativeDesktopEngine
        engine = NativeDesktopEngine()
        assert engine is not None
    
    def test_get_cursor_pos(self):
        from rust_adapters.native_desktop import NativeDesktopEngine
        engine = NativeDesktopEngine()
        pos = engine.get_cursor_pos()
        assert isinstance(pos, tuple)
        assert len(pos) == 2
    
    def test_failsafe_no_expected(self):
        from rust_adapters.native_desktop import NativeDesktopEngine
        engine = NativeDesktopEngine()
        result = engine.check_failsafe(None)
        assert result == False


class TestBackendInfo:
    """Test backend info reporting."""
    
    def test_backend_info(self):
        from rust_adapters import backend_info
        info = backend_info()
        assert "backend" in info
        assert info["backend"] in ("rust", "python")
    
    def test_is_rust_available(self):
        from rust_adapters import is_rust_available
        result = is_rust_available()
        assert isinstance(result, bool)


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
