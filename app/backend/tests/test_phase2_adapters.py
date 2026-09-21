"""
tests/test_phase2_adapters.py - Validate Phase 2 Rust adapters match original Python behavior.

Tests for:
- storage_engine: cosine_similarity, keyword_score, decode_embedding, trust_of, normalize_scores, fuse_scores
- event_engine: genesis_hash, compute_chain_hash, verify_chain_hashes, compute_snapshot_hash
- wiki_engine: normalize_text, subject_predicate_key, has_negation, triple_from_text, detect_conflicts

Run with:
    pytest tests/test_phase2_adapters.py -v
"""
import pytest
import json
import hashlib
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ============================================================
# storage_engine tests
# ============================================================

class TestCosineSimilarity:
    """Test cosine similarity computation."""
    
    def test_identical_vectors(self):
        from rust_adapters.storage_engine import cosine_similarity
        v = [1.0, 2.0, 3.0]
        result = cosine_similarity(v, v)
        assert abs(result - 1.0) < 0.001
    
    def test_orthogonal_vectors(self):
        from rust_adapters.storage_engine import cosine_similarity
        a = [1.0, 0.0, 0.0]
        b = [0.0, 1.0, 0.0]
        result = cosine_similarity(a, b)
        assert abs(result - 0.0) < 0.001
    
    def test_opposite_vectors(self):
        from rust_adapters.storage_engine import cosine_similarity
        a = [1.0, 0.0, 0.0]
        b = [-1.0, 0.0, 0.0]
        result = cosine_similarity(a, b)
        assert abs(result - (-1.0)) < 0.001
    
    def test_empty_vectors(self):
        from rust_adapters.storage_engine import cosine_similarity
        assert cosine_similarity([], []) == 0.0
        assert cosine_similarity([1.0], []) == 0.0
        assert cosine_similarity([], [1.0]) == 0.0
    
    def test_mismatched_lengths(self):
        from rust_adapters.storage_engine import cosine_similarity
        assert cosine_similarity([1.0, 2.0], [1.0]) == 0.0
    
    def test_known_values(self):
        from rust_adapters.storage_engine import cosine_similarity
        a = [3.0, 4.0]
        b = [3.0, 4.0]
        assert abs(cosine_similarity(a, b) - 1.0) < 0.001
        
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        assert abs(cosine_similarity(a, b) - 0.0) < 0.001
    
    def test_large_vectors(self):
        from rust_adapters.storage_engine import cosine_similarity
        import math
        # 768-dim vectors (typical embedding size)
        a = [1.0 / math.sqrt(768)] * 768
        b = [1.0 / math.sqrt(768)] * 768
        result = cosine_similarity(a, b)
        assert abs(result - 1.0) < 0.001


class TestBatchCosineSimilarity:
    """Test batch cosine similarity."""
    
    def test_basic_batch(self):
        from rust_adapters.storage_engine import batch_cosine_similarity
        query = [1.0, 0.0, 0.0]
        vectors = [
            [1.0, 0.0, 0.0],  # identical
            [0.0, 1.0, 0.0],  # orthogonal (filtered out, score=0)
            [0.5, 0.5, 0.0],  # 45 degrees
        ]
        results = batch_cosine_similarity(query, vectors)
        # Orthogonal vector is correctly filtered out (score=0)
        assert len(results) == 2
        # First should be identical (score ~1.0)
        assert results[0][0] == 0
        assert abs(results[0][1] - 1.0) < 0.001
    
    def test_sorts_descending(self):
        from rust_adapters.storage_engine import batch_cosine_similarity
        query = [1.0, 0.0]
        vectors = [
            [0.0, 1.0],   # orthogonal (0)
            [1.0, 0.0],   # identical (1)
            [0.707, 0.707],  # 45 degrees (~0.707)
        ]
        results = batch_cosine_similarity(query, vectors)
        scores = [r[1] for r in results]
        assert scores == sorted(scores, reverse=True)


class TestKeywordScore:
    """Test keyword scoring."""
    
    def test_basic_match(self):
        from rust_adapters.storage_engine import keyword_score
        content = "Python is a great programming language"
        keywords = ["python", "programming"]
        assert keyword_score(content, keywords) == 2
    
    def test_case_insensitive(self):
        from rust_adapters.storage_engine import keyword_score
        content = "PYTHON is great"
        keywords = ["python"]
        assert keyword_score(content, keywords) == 1
    
    def test_no_match(self):
        from rust_adapters.storage_engine import keyword_score
        content = "Hello world"
        keywords = ["python", "java"]
        assert keyword_score(content, keywords) == 0
    
    def test_empty_content(self):
        from rust_adapters.storage_engine import keyword_score
        assert keyword_score("", ["test"]) == 0
    
    def test_empty_keywords(self):
        from rust_adapters.storage_engine import keyword_score
        assert keyword_score("some content", []) == 0
    
    def test_partial_match(self):
        from rust_adapters.storage_engine import keyword_score
        content = "I love Python and JavaScript"
        keywords = ["python", "ruby", "javascript"]
        assert keyword_score(content, keywords) == 2


class TestDecodeEmbedding:
    """Test embedding blob decoding."""
    
    def test_json_string(self):
        from rust_adapters.storage_engine import decode_embedding
        vec = [0.1, 0.2, 0.3, 0.4]
        blob = json.dumps(vec).encode("utf-8")
        result = decode_embedding(blob)
        assert result is not None
        assert len(result) == 4
        assert abs(result[0] - 0.1) < 0.001
    
    def test_json_str(self):
        from rust_adapters.storage_engine import decode_embedding
        vec = [0.5, 0.6, 0.7]
        blob = json.dumps(vec)
        result = decode_embedding(blob)
        assert result is not None
        assert len(result) == 3
    
    def test_list_input(self):
        from rust_adapters.storage_engine import decode_embedding
        vec = [1.0, 2.0, 3.0]
        result = decode_embedding(vec)
        assert result is not None
        assert len(result) == 3
    
    def test_empty_blob(self):
        from rust_adapters.storage_engine import decode_embedding
        assert decode_embedding(None) is None
        assert decode_embedding(b"") is None
        assert decode_embedding("") is None
    
    def test_invalid_json(self):
        from rust_adapters.storage_engine import decode_embedding
        assert decode_embedding(b"not json") is None


class TestTrustOf:
    """Test confidence extraction."""
    
    def test_valid_confidence(self):
        from rust_adapters.storage_engine import trust_of
        assert abs(trust_of(confidence=0.8) - 0.8) < 0.001
        assert abs(trust_of(confidence=0.5) - 0.5) < 0.001
        assert abs(trust_of(confidence=1.0) - 1.0) < 0.001
    
    def test_invalid_confidence(self):
        from rust_adapters.storage_engine import trust_of
        assert abs(trust_of(confidence=0.0) - 0.5) < 0.001
        assert abs(trust_of(confidence=-0.1) - 0.5) < 0.001
        assert abs(trust_of(confidence=1.1) - 0.5) < 0.001
    
    def test_none_confidence(self):
        from rust_adapters.storage_engine import trust_of
        assert abs(trust_of(confidence=None) - 0.5) < 0.001
        assert abs(trust_of(row=None) - 0.5) < 0.001
    
    def test_row_dict(self):
        from rust_adapters.storage_engine import trust_of
        assert abs(trust_of(row={"confidence": 0.7}) - 0.7) < 0.001
        assert abs(trust_of(row={"confidence": None}) - 0.5) < 0.001
        assert abs(trust_of(row={}) - 0.5) < 0.001


class TestNormalizeScores:
    """Test score normalization."""
    
    def test_basic_normalize(self):
        from rust_adapters.storage_engine import normalize_scores
        scores = {"a": 10.0, "b": 5.0, "c": 0.0}
        result = normalize_scores(scores)
        assert abs(result["a"] - 1.0) < 0.001
        assert abs(result["c"] - 0.0) < 0.001
    
    def test_empty_scores(self):
        from rust_adapters.storage_engine import normalize_scores
        result = normalize_scores({})
        assert result == {}
    
    def test_equal_scores(self):
        from rust_adapters.storage_engine import normalize_scores
        scores = {"a": 5.0, "b": 5.0}
        result = normalize_scores(scores)
        assert abs(result["a"] - 0.5) < 0.001
        assert abs(result["b"] - 0.5) < 0.001
    
    def test_lower_is_better(self):
        from rust_adapters.storage_engine import normalize_scores
        scores = {"a": 10.0, "b": 5.0, "c": 0.0}
        result = normalize_scores(scores, higher_is_better=False)
        assert abs(result["a"] - 0.0) < 0.001
        assert abs(result["c"] - 1.0) < 0.001


class TestFuseScores:
    """Test score fusion."""
    
    def test_basic_fusion(self):
        from rust_adapters.storage_engine import fuse_scores
        dense = {"a": 0.8, "b": 0.5}
        sparse = {"b": 0.7, "c": 0.6}
        result = fuse_scores(dense, sparse, 0.7, 0.3)
        
        # Should have 3 entries
        assert len(result) == 3
        
        # Check that b is fused correctly: 0.7*0.5 + 0.3*0.7 = 0.35 + 0.21 = 0.56
        b_entry = next(r for r in result if r[0] == "b")
        assert abs(b_entry[1] - 0.56) < 0.001
    
    def test_sorted_descending(self):
        from rust_adapters.storage_engine import fuse_scores
        dense = {"a": 0.9, "b": 0.1}
        sparse = {"c": 0.8}
        result = fuse_scores(dense, sparse, 0.5, 0.5)
        scores = [r[1] for r in result]
        assert scores == sorted(scores, reverse=True)
    
    def test_parts_structure(self):
        from rust_adapters.storage_engine import fuse_scores
        dense = {"a": 0.8}
        sparse = {"a": 0.6}
        result = fuse_scores(dense, sparse, 0.7, 0.3)
        assert len(result) == 1
        assert "vec" in result[0][2]
        assert "kw" in result[0][2]


# ============================================================
# event_engine tests
# ============================================================

class TestGenesisHash:
    """Test genesis hash computation."""
    
    def test_deterministic(self):
        from rust_adapters.event_engine import genesis_hash
        h1 = genesis_hash("session-123")
        h2 = genesis_hash("session-123")
        assert h1 == h2
    
    def test_unique_per_session(self):
        from rust_adapters.event_engine import genesis_hash
        h1 = genesis_hash("session-1")
        h2 = genesis_hash("session-2")
        assert h1 != h2
    
    def test_matches_python(self):
        from rust_adapters.event_engine import genesis_hash
        session_id = "test-session-abc"
        expected = hashlib.sha256(f"genesis:{session_id}".encode("utf-8")).hexdigest()
        assert genesis_hash(session_id) == expected
    
    def test_is_hex(self):
        from rust_adapters.event_engine import genesis_hash
        h = genesis_hash("test")
        assert len(h) == 64  # SHA-256 hex digest length
        int(h, 16)  # Should not raise


class TestComputeChainHash:
    """Test chain hash computation."""
    
    def test_deterministic(self):
        from rust_adapters.event_engine import compute_chain_hash
        h1 = compute_chain_hash("prev", "session", "tool_call", 12345, {"key": "value"})
        h2 = compute_chain_hash("prev", "session", "tool_call", 12345, {"key": "value"})
        assert h1 == h2
    
    def test_unique_per_input(self):
        from rust_adapters.event_engine import compute_chain_hash
        h1 = compute_chain_hash("prev", "session", "tool_call", 12345, {"key": "value1"})
        h2 = compute_chain_hash("prev", "session", "tool_call", 12345, {"key": "value2"})
        assert h1 != h2
    
    def test_matches_python(self):
        from rust_adapters.event_engine import compute_chain_hash
        prev = "abc123"
        session = "session-1"
        event_type = "tool_call"
        timestamp = 1234567890
        payload = {"tool": "read", "path": "/test"}
        
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        seed = f"{prev}|{session}|{event_type}|{timestamp}|{canonical}"
        expected = hashlib.sha256(seed.encode("utf-8")).hexdigest()
        
        assert compute_chain_hash(prev, session, event_type, timestamp, payload) == expected
    
    def test_chaining(self):
        from rust_adapters.event_engine import compute_chain_hash, genesis_hash
        g = genesis_hash("session-1")
        h1 = compute_chain_hash(g, "session-1", "event1", 1000, {"a": 1})
        h2 = compute_chain_hash(h1, "session-1", "event2", 1001, {"b": 2})
        assert h1 != h2
        assert h2 != g


class TestVerifyChainHashes:
    """Test chain verification."""
    
    def test_valid_chain(self):
        from rust_adapters.event_engine import compute_chain_hash, verify_chain_hashes, genesis_hash
        session = "test-session"
        g = genesis_hash(session)
        
        events = []
        prev = g
        for i in range(5):
            payload = {"index": i, "data": f"event-{i}"}
            h = compute_chain_hash(prev, session, "test_event", 1000 + i, payload)
            events.append(("test_event", 1000 + i, payload, h))
            prev = h
        
        valid, broken, error = verify_chain_hashes(session, events)
        assert valid is True
        assert broken is None
        assert error is None
    
    def test_broken_chain(self):
        from rust_adapters.event_engine import compute_chain_hash, verify_chain_hashes, genesis_hash
        session = "test-session"
        g = genesis_hash(session)
        
        events = []
        prev = g
        for i in range(5):
            payload = {"index": i}
            h = compute_chain_hash(prev, session, "test_event", 1000 + i, payload)
            # Corrupt the hash at index 2
            if i == 2:
                h = "corrupted_hash"
            events.append(("test_event", 1000 + i, payload, h))
            prev = h
        
        valid, broken, error = verify_chain_hashes(session, events)
        assert valid is False
        assert broken == 2
        assert error is not None
    
    def test_empty_chain(self):
        from rust_adapters.event_engine import verify_chain_hashes
        valid, broken, error = verify_chain_hashes("session", [])
        assert valid is True
        assert broken is None


class TestComputeSnapshotHash:
    """Test snapshot hash computation."""
    
    def test_deterministic(self):
        from rust_adapters.event_engine import compute_snapshot_hash
        h1 = compute_snapshot_hash("session", 10, {"state": "value"})
        h2 = compute_snapshot_hash("session", 10, {"state": "value"})
        assert h1 == h2
    
    def test_matches_python(self):
        from rust_adapters.event_engine import compute_snapshot_hash
        session = "test"
        seq = 42
        state = {"key": "value", "nested": {"a": 1}}
        state_str = json.dumps(state, sort_keys=True, ensure_ascii=False)
        expected = hashlib.sha256(f"{session}:{seq}:{state_str}".encode("utf-8")).hexdigest()
        assert compute_snapshot_hash(session, seq, state) == expected


# ============================================================
# wiki_engine tests
# ============================================================

class TestNormalizeText:
    """Test text normalization."""
    
    def test_basic_normalize(self):
        from rust_adapters.wiki_engine import normalize_text
        assert normalize_text("  Hello   World  ") == "hello world"
    
    def test_case_fold(self):
        from rust_adapters.wiki_engine import normalize_text
        assert normalize_text("HELLO WORLD") == "hello world"
        assert normalize_text("Hello World") == "hello world"
    
    def test_empty_string(self):
        from rust_adapters.wiki_engine import normalize_text
        assert normalize_text("") == ""
    
    def test_whitespace_collapse(self):
        from rust_adapters.wiki_engine import normalize_text
        assert normalize_text("a   b     c") == "a b c"
        assert normalize_text("a\tb\nc") == "a b c"
    
    def test_unicode(self):
        from rust_adapters.wiki_engine import normalize_text
        assert normalize_text("  你好  世界  ") == "你好 世界"


class TestSubjectPredicateKey:
    """Test subject+predicate key generation."""
    
    def test_basic_key(self):
        from rust_adapters.wiki_engine import subject_predicate_key
        key = subject_predicate_key("用户", "名字")
        assert key == "用户::名字"
    
    def test_normalized_key(self):
        from rust_adapters.wiki_engine import subject_predicate_key
        key = subject_predicate_key("  User  ", " Name ")
        assert key == "user::name"
    
    def test_stable_key(self):
        from rust_adapters.wiki_engine import subject_predicate_key
        k1 = subject_predicate_key("User", "Name")
        k2 = subject_predicate_key("  User  ", "  Name  ")
        assert k1 == k2


class TestHasNegation:
    """Test negation detection."""
    
    def test_english_negation(self):
        from rust_adapters.wiki_engine import has_negation
        assert has_negation("I do not like this") is True
        assert has_negation("This is not correct") is True
        assert has_negation("I don't know") is True
        assert has_negation("Never do that") is True
    
    def test_chinese_negation(self):
        from rust_adapters.wiki_engine import has_negation
        assert has_negation("我不喜欢这个") is True
        assert has_negation("我没有去过") is True
        assert has_negation("这不是正确的") is True
    
    def test_no_negation(self):
        from rust_adapters.wiki_engine import has_negation
        assert has_negation("I like this") is False
        assert has_negation("This is correct") is False
        assert has_negation("我喜欢这个") is False
    
    def test_empty_string(self):
        from rust_adapters.wiki_engine import has_negation
        assert has_negation("") is False


class TestTripleFromText:
    """Test SPO triple extraction."""
    
    def test_english_name(self):
        from rust_adapters.wiki_engine import triple_from_text
        result = triple_from_text("my name is John")
        assert result is not None
        assert result[0] == "用户"
        assert result[1] == "名字"
        assert result[2] == "John"
    
    def test_chinese_name(self):
        from rust_adapters.wiki_engine import triple_from_text
        result = triple_from_text("我叫张三")
        assert result is not None
        assert result[0] == "用户"
        assert result[1] == "名字"
        assert result[2] == "张三"
    
    def test_english_work(self):
        from rust_adapters.wiki_engine import triple_from_text
        result = triple_from_text("I work at Google")
        assert result is not None
        assert result[0] == "用户"
        assert result[1] == "工作单位"
        assert result[2] == "Google"
    
    def test_chinese_work(self):
        from rust_adapters.wiki_engine import triple_from_text
        result = triple_from_text("我在字节工作")
        assert result is not None
        assert result[0] == "用户"
        assert result[1] == "工作单位"
        assert result[2] == "字节"
    
    def test_no_match(self):
        from rust_adapters.wiki_engine import triple_from_text
        assert triple_from_text("Hello world") is None
        assert triple_from_text("") is None
    
    def test_negated_statement(self):
        from rust_adapters.wiki_engine import triple_from_text
        result = triple_from_text("my name isn't John")
        assert result is not None
        assert result[2] == "John"


class TestDetectConflicts:
    """Test contradiction detection."""
    
    def test_structural_conflict(self):
        from rust_adapters.wiki_engine import detect_conflicts
        peers = [
            ("Paris", "I live in Paris", "claim-1"),
            ("London", "I live in London", "claim-2"),
        ]
        conflicts = detect_conflicts("Berlin", "I live in Berlin", peers)
        assert "claim-1" in conflicts
        assert "claim-2" in conflicts
    
    def test_no_conflict_same_object(self):
        from rust_adapters.wiki_engine import detect_conflicts
        peers = [
            ("Paris", "I live in Paris", "claim-1"),
        ]
        conflicts = detect_conflicts("Paris", "I live in Paris", peers)
        assert len(conflicts) == 0
    
    def test_negation_conflict(self):
        from rust_adapters.wiki_engine import detect_conflicts
        peers = [
            ("Paris", "I live in Paris", "claim-1"),
        ]
        conflicts = detect_conflicts("Paris", "I don't live in Paris", peers)
        assert "claim-1" in conflicts
    
    def test_empty_object_no_conflict(self):
        from rust_adapters.wiki_engine import detect_conflicts
        peers = [
            ("Paris", "I live in Paris", "claim-1"),
        ]
        # Empty object is treated as "not asserting an object"
        conflicts = detect_conflicts("", "I live in Paris", peers)
        assert len(conflicts) == 0


# ============================================================
# Cross-module integration tests
# ============================================================

class TestStorageEventIntegration:
    """Test that storage_engine and event_engine work together."""
    
    def test_hash_then_store(self):
        from rust_adapters.event_engine import genesis_hash, compute_chain_hash
        from rust_adapters.storage_engine import cosine_similarity
        
        # Compute a hash
        g = genesis_hash("session-1")
        h = compute_chain_hash(g, "session-1", "event", 1000, {"data": "test"})
        
        # Use it in a vector (simulating embedding storage)
        vec1 = [float(ord(c)) for c in h[:32]]
        vec2 = [float(ord(c)) for c in h[:32]]
        sim = cosine_similarity(vec1, vec2)
        assert abs(sim - 1.0) < 0.001


class TestWikiStorageIntegration:
    """Test that wiki_engine and storage_engine work together."""
    
    def test_normalize_then_score(self):
        from rust_adapters.wiki_engine import normalize_text
        from rust_adapters.storage_engine import keyword_score
        
        text = "  Hello   World  "
        normalized = normalize_text(text)
        score = keyword_score(normalized, ["hello"])
        assert score == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
