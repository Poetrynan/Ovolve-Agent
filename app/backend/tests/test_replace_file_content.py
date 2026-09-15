"""test_replace_file_content.py — Track R1 coverage for replace_file_content.

Covers:
  * exact search/replace (and the ambiguity guard / allow_multiple)
  * fuzzy replace with a typo above the similarity threshold
  * hard failure when nothing reaches the threshold
  * SEARCH/REPLACE parsing with indentation drift (both directions)
  * unified diff path via patch_engine
  * input-format ambiguity guard

Test-file protection belongs to path_guard and is deliberately NOT asserted
here (the impl must not duplicate it).
"""
import os
import sys
from pathlib import Path

import pytest

# Same sys.path juggling as the other tests in app/backend/tests/.
backend_dir = Path(__file__).parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

import aider_parser  # noqa: E402
from file_agent import _replace_file_content_impl  # noqa: E402


def _write(tmp_path, name, content: str) -> str:
    p = tmp_path / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return str(p)


# The impl only reads ctx.workspace_root (passed to shorten_path).
def _ctx(tmp_path):
    return {"workspace_root": str(tmp_path)}


# ── exact search/replace ──────────────────────────────────────────────────

def test_exact_replace(tmp_path):
    p = _write(tmp_path, "a.txt", "alpha\nbeta\ngamma\n")
    r = _replace_file_content_impl(
        {"path": p, "search": "beta", "replace": "BETA"}, _ctx(tmp_path)
    )
    assert r.ok, r.error
    assert Path(p).read_text(encoding="utf-8") == "alpha\nBETA\ngamma\n"
    assert r.meta["backend"] in ("ovolve_core", "python-levenshtein")
    assert r.meta["similarity"] == pytest.approx(1.0)
    assert r.meta["bytes_changed"] == 0  # same length


def test_exact_replace_bytes_changed(tmp_path):
    p = _write(tmp_path, "b.txt", "one two three\n")
    r = _replace_file_content_impl(
        {"path": p, "search": "two", "replace": "twenty two"}, _ctx(tmp_path)
    )
    assert r.ok, r.error
    assert r.meta["bytes_changed"] == len("twenty two".encode()) - len("two".encode())


def test_exact_ambiguous_refused_without_allow_multiple(tmp_path):
    p = _write(tmp_path, "c.txt", "dup\nmid\ndup\n")
    r = _replace_file_content_impl(
        {"path": p, "search": "dup", "replace": "x"}, _ctx(tmp_path)
    )
    assert not r.ok
    assert "allow_multiple" in r.error


def test_exact_allow_multiple(tmp_path):
    p = _write(tmp_path, "d.txt", "dup\nmid\ndup\n")
    r = _replace_file_content_impl(
        {"path": p, "search": "dup", "replace": "x", "allow_multiple": True},
        _ctx(tmp_path),
    )
    assert r.ok, r.error
    assert Path(p).read_text(encoding="utf-8") == "x\nmid\nx\n"
    assert r.meta["bytes_changed"] >= 0


# ── fuzzy replace (typo above threshold) ──────────────────────────────────

def test_fuzzy_replace_with_typo(tmp_path):
    content = "def hello():\n    print('hi')\n    return 1\n"
    p = _write(tmp_path, "e.py", content)
    # "prnt" instead of "print" — similarity well above 0.8, below exact.
    r = _replace_file_content_impl(
        {
            "path": p,
            "search": "def hello():\n    prnt('hi')\n    return 1",
            "replace": "def hello():\n    print('bye')\n    return 2",
        },
        _ctx(tmp_path),
    )
    assert r.ok, r.error
    assert r.meta["similarity"] >= 0.8
    assert r.meta["backend"] == "python-levenshtein" or r.meta["backend"] == "ovolve_core"
    assert "print('bye')" in Path(p).read_text(encoding="utf-8")


def test_fuzzy_below_threshold_refused(tmp_path):
    content = "def hello():\n    print('hi')\n    return 1\n"
    p = _write(tmp_path, "f.py", content)
    # Completely unrelated search text — nothing near it.
    r = _replace_file_content_impl(
        {
            "path": p,
            "search": "class TotallyUnrelated:\n    pass\n    x = 99",
            "replace": "whatever",
        },
        _ctx(tmp_path),
    )
    assert not r.ok
    assert "threshold" in r.error.lower()


def test_no_match_failure(tmp_path):
    p = _write(tmp_path, "g.txt", "line one\nline two\n")
    r = _replace_file_content_impl(
        {"path": p, "search": "zzz not here qqq", "replace": "y"}, _ctx(tmp_path)
    )
    assert not r.ok
    assert Path(p).read_text(encoding="utf-8") == "line one\nline two\n"  # untouched


# ── Aider block: parsing + indentation drift ──────────────────────────────

def test_parse_aider_blocks_basic():
    text = (
        "somefile.py\n"
        "<<<<<<< SEARCH\n"
        "old line\n"
        "=======\n"
        "new line\n"
        ">>>>>>> REPLACE\n"
        "<<<<<<< SEARCH\n"
        "second old\n"
        "=======\n"
        "second new\n"
        ">>>>>>> REPLACE\n"
    )
    blocks = aider_parser.parse_aider_blocks(text)
    assert len(blocks) == 2
    assert blocks[0].search == "old line"
    assert blocks[0].replace == "new line"
    assert blocks[1].search == "second old"
    assert blocks[1].replace == "second new"


def test_aider_block_indentation_drift_dedent(tmp_path):
    """Model wrote the SEARCH body at column 0; the file has it at column 8."""
    content = "class Foo:\n    def bar(self):\n        print('old value')\n        return 1\n"
    p = _write(tmp_path, "h.py", content)
    block = (
        "<<<<<<< SEARCH\n"
        "print('old value')\n"
        "return 1\n"
        "=======\n"
        "print('new value')\n"
        "return 2\n"
        ">>>>>>> REPLACE\n"
    )
    r = _replace_file_content_impl({"path": p, "aider_block": block}, _ctx(tmp_path))
    assert r.ok, r.error
    out = Path(p).read_text(encoding="utf-8")
    assert "old value" not in out
    assert "        print('new value')\n        return 2\n" in out


def test_aider_block_indentation_drift_indent(tmp_path):
    """Model added one level of indentation the file does not have."""
    content = "def main():\n    run()\n"
    p = _write(tmp_path, "i.py", content)
    block = (
        "<<<<<<< SEARCH\n"
        "    run()\n"
        "=======\n"
        "    walk()\n"
        ">>>>>>> REPLACE\n"
    )
    r = _replace_file_content_impl({"path": p, "aider_block": block}, _ctx(tmp_path))
    assert r.ok, r.error
    out = Path(p).read_text(encoding="utf-8")
    assert "run()" not in out
    assert "    walk()\n" in out


def test_aider_block_multi_all_or_nothing(tmp_path):
    """Second block fails -> the file must be left untouched (all-or-nothing)."""
    content = "keep me\n"
    p = _write(tmp_path, "j.txt", content)
    block = (
        "<<<<<<< SEARCH\n"
        "keep me\n"
        "=======\n"
        "changed me\n"
        ">>>>>>> REPLACE\n"
        "<<<<<<< SEARCH\n"
        "this text does not exist anywhere\n"
        "=======\n"
        "x\n"
        ">>>>>>> REPLACE\n"
    )
    r = _replace_file_content_impl({"path": p, "aider_block": block}, _ctx(tmp_path))
    assert not r.ok
    assert Path(p).read_text(encoding="utf-8") == "keep me\n"  # first block rolled back


# ── unified diff path (patch_engine) ──────────────────────────────────────

def test_unified_diff_apply(tmp_path):
    p = _write(tmp_path, "k.txt", "line1\nold line\nline3\n")
    patch = (
        "--- a/k.txt\n"
        "+++ b/k.txt\n"
        "@@ -1,3 +1,3 @@\n"
        " line1\n"
        "-old line\n"
        "+new line\n"
        " line3\n"
    )
    r = _replace_file_content_impl({"path": p, "diff": patch}, _ctx(tmp_path))
    assert r.ok, r.error
    assert r.meta["backend"] == "patch_engine"
    assert Path(p).read_text(encoding="utf-8") == "line1\nnew line\nline3\n"


def test_unified_diff_bad_context_fails(tmp_path):
    p = _write(tmp_path, "l.txt", "line1\nline2\n")
    patch = (
        "@@ -1,2 +1,2 @@\n"
        " line1\n"
        "-wrong context\n"
        "+new line\n"
        " line2\n"
    )
    r = _replace_file_content_impl({"path": p, "diff": patch}, _ctx(tmp_path))
    assert not r.ok


# ── input validation ──────────────────────────────────────────────────────

def test_no_edit_format_given(tmp_path):
    p = _write(tmp_path, "m.txt", "x\n")
    r = _replace_file_content_impl({"path": p}, _ctx(tmp_path))
    assert not r.ok
    assert "Provide one edit" in r.error


def test_ambiguous_formats_refused(tmp_path):
    p = _write(tmp_path, "n.txt", "x\n")
    r = _replace_file_content_impl(
        {"path": p, "search": "x", "replace": "y", "diff": "@@ -1 +1 @@\n-x\n+y\n"},
        _ctx(tmp_path),
    )
    assert not r.ok
    assert "Ambiguous" in r.error


def test_missing_path(tmp_path):
    r = _replace_file_content_impl({"search": "a", "replace": "b"}, _ctx(tmp_path))
    assert not r.ok
    assert "path is required" in r.error


# ── similarity primitives sanity (mirror ovolve_core semantics) ──────────

def test_similarity_primitives():
    assert aider_parser.levenshtein_distance("kitten", "sitting") == 3
    assert aider_parser.compute_similarity("abc", "abc") == 1.0
    # Whitespace is ignored — indentation drift must not lower the score.
    assert aider_parser.compute_similarity("  return 1", "return 1") == 1.0
    assert aider_parser.compute_similarity("", "abc") == 0.0


def test_rust_backend_graceful_degradation():
    """Either the Rust extension is active or the pure-Python fallback is —
    but the module must always expose a working matcher."""
    assert callable(aider_parser.levenshtein_distance)
    assert aider_parser.backend_name() in ("ovolve_core", "python-levenshtein")
    outcome = aider_parser.replace_once("alpha beta", "alpha", "gamma")
    assert outcome.ok
    assert outcome.content == "gamma beta"
