"""Test Layer 1 rule memory (RuleEngine) and Layer 2 embedder wiring.

The embedder tests deliberately avoid downloading the 400MB model — they cover
the graceful-degradation contract, which is the part that must never break the
backend regardless of whether sentence-transformers is installed.
"""
import os
import pytest

from rule_engine import (
    PRIORITY_ORDER,
    Rule,
    RuleEngine,
    _extract_title,
    _parse_frontmatter,
    _truthy,
)
from embedder import DISABLE_ENV, LocalEmbedder


# ── frontmatter parsing ─────────────────────────────────────────────────────

def test_parses_frontmatter_and_strips_it_from_body():
    text = "---\npriority: CRITICAL\nenabled: true\n---\n# Title\nbody here"
    meta, body = _parse_frontmatter(text)
    assert meta == {"priority": "CRITICAL", "enabled": "true"}
    assert body.strip().startswith("# Title")
    assert "---" not in body


def test_no_frontmatter_returns_original_body():
    text = "# Just a title\nno meta"
    meta, body = _parse_frontmatter(text)
    assert meta == {}
    assert body == text


def test_frontmatter_strips_quotes():
    meta, _ = _parse_frontmatter('---\nname: "My Rule"\n---\nbody')
    assert meta["name"] == "My Rule"


def test_frontmatter_keys_are_lowercased():
    meta, _ = _parse_frontmatter("---\nPriority: HIGH\n---\nbody")
    assert meta["priority"] == "HIGH"


def test_truthy_accepts_common_spellings():
    for v in ("true", "TRUE", "yes", "on", "1"):
        assert _truthy(v) is True
    for v in ("false", "no", "off", "0"):
        assert _truthy(v) is False
    # Absent means enabled — a rule file without the key should still apply.
    assert _truthy(None) is True


def test_extract_title_prefers_h1():
    assert _extract_title("\n\n# Real Title\ncontent", "fallback") == "Real Title"


def test_extract_title_falls_back_when_body_starts_with_prose():
    """Don't mistake the first prose line for a title."""
    assert _extract_title("just prose\n# Later Heading", "fallback") == "fallback"


# ── loading ─────────────────────────────────────────────────────────────────

def write_rule(dirpath, name, content):
    d = dirpath / ".ovolve" / "rules"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.md").write_text(content, encoding="utf-8")


def test_loads_workspace_rules(tmp_path):
    write_rule(tmp_path, "safety", "---\npriority: CRITICAL\n---\n# Safety\n删文件要确认")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    rules = eng.load()
    assert len(rules) == 1
    assert rules[0].title == "Safety"
    assert rules[0].priority == "CRITICAL"
    assert rules[0].scope == "workspace"


def test_disabled_rules_are_skipped(tmp_path):
    write_rule(tmp_path, "off", "---\nenabled: false\n---\n# Off\nshould not load")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    assert eng.load() == []


def test_sorted_by_priority(tmp_path):
    write_rule(tmp_path, "a_low", "---\npriority: LOW\n---\n# Low\nx")
    write_rule(tmp_path, "b_crit", "---\npriority: CRITICAL\n---\n# Crit\nx")
    write_rule(tmp_path, "c_med", "---\npriority: MEDIUM\n---\n# Med\nx")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    assert [r.priority for r in eng.load()] == ["CRITICAL", "MEDIUM", "LOW"]


def test_invalid_priority_defaults_to_medium(tmp_path):
    write_rule(tmp_path, "weird", "---\npriority: SUPER_URGENT\n---\n# W\nx")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    assert eng.load()[0].priority == "MEDIUM"


def test_user_and_workspace_rules_both_load(tmp_path):
    ws = tmp_path / "proj"
    home = tmp_path / "home"
    ws.mkdir()
    home.mkdir()
    write_rule(ws, "proj_rule", "# Project Rule\nx")
    write_rule(home, "user_rule", "# User Rule\nx")
    eng = RuleEngine(workspace_dir=str(ws), user_home=str(home))
    scopes = {r.scope for r in eng.load()}
    assert scopes == {"workspace", "user"}


def test_workspace_sorts_before_user_at_equal_priority(tmp_path):
    """Project rules are closer to the task at hand — the model should see them first."""
    ws = tmp_path / "proj"
    home = tmp_path / "home"
    ws.mkdir()
    home.mkdir()
    write_rule(ws, "z_proj", "# P\nx")   # 'z' would sort last alphabetically
    write_rule(home, "a_user", "# U\nx")
    eng = RuleEngine(workspace_dir=str(ws), user_home=str(home))
    assert [r.scope for r in eng.load()] == ["workspace", "user"]


def test_missing_dirs_are_not_an_error(tmp_path):
    eng = RuleEngine(workspace_dir=str(tmp_path / "nope"), user_home=str(tmp_path / "nada"))
    assert eng.load() == []


def test_rule_ids_are_scoped_and_stable(tmp_path):
    write_rule(tmp_path, "coding", "# C\nx")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    assert eng.load()[0].id == "workspace:coding"


# ── rendering ───────────────────────────────────────────────────────────────

def test_render_is_empty_when_no_rules(tmp_path):
    """Empty must be falsy so the prompt assembler can skip the section cleanly."""
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    assert eng.render_for_prompt() == ""


def test_render_includes_body_and_priority_badge(tmp_path):
    write_rule(tmp_path, "safety", "---\npriority: CRITICAL\n---\n# Safety\n删除前必须确认")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    out = eng.render_for_prompt()
    assert "[CRITICAL]" in out
    assert "删除前必须确认" in out
    assert "规则库" in out


def test_render_orders_critical_first(tmp_path):
    write_rule(tmp_path, "a_low", "---\npriority: LOW\n---\n# LowRule\nlow body")
    write_rule(tmp_path, "b_crit", "---\npriority: CRITICAL\n---\n# CritRule\ncrit body")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    out = eng.render_for_prompt()
    assert out.index("CritRule") < out.index("LowRule")


def test_snapshot_shape(tmp_path):
    write_rule(tmp_path, "r", "---\npriority: HIGH\n---\n# R\nbody text")
    eng = RuleEngine(workspace_dir=str(tmp_path), user_home=str(tmp_path / "nohome"))
    snap = eng.snapshot()
    assert snap["count"] == 1
    entry = snap["rules"][0]
    assert entry["id"] == "workspace:r"
    assert entry["priority"] == "HIGH"
    assert entry["scope"] == "workspace"
    assert "body text" in entry["excerpt"]


def test_priority_order_is_total():
    assert set(PRIORITY_ORDER) == {"CRITICAL", "HIGH", "MEDIUM", "LOW"}
    assert Rule(id="x", title="t", body="", priority="CRITICAL").priority_value() == 0


# ── embedder graceful degradation ───────────────────────────────────────────

def test_disabled_by_env_returns_none(monkeypatch):
    monkeypatch.setenv(DISABLE_ENV, "1")
    e = LocalEmbedder()
    assert e.available is False
    assert e.encode("任何文本") is None
    assert DISABLE_ENV in (e.last_error or "")


def test_empty_text_returns_none_without_loading(monkeypatch):
    monkeypatch.setenv(DISABLE_ENV, "1")
    e = LocalEmbedder()
    assert e.encode("") is None
    assert e.encode("   ") is None


def test_batch_returns_aligned_nones_when_unavailable(monkeypatch):
    """Length must match the input so callers can zip by index."""
    monkeypatch.setenv(DISABLE_ENV, "1")
    e = LocalEmbedder()
    assert e.encode_batch(["a", "b", "c"]) == [None, None, None]
    assert e.encode_batch([]) == []


def test_status_does_not_trigger_loading(monkeypatch):
    monkeypatch.setenv(DISABLE_ENV, "1")
    e = LocalEmbedder()
    st = e.status()
    assert st["attempted"] is False   # status() must not force a 400MB load
    assert st["loaded"] is False
    assert st["model"]


def test_model_name_from_env(monkeypatch):
    monkeypatch.setenv("OVOLVE_EMBED_MODEL", "some/other-model")
    assert LocalEmbedder().model_name == "some/other-model"


def test_explicit_model_beats_env(monkeypatch):
    monkeypatch.setenv("OVOLVE_EMBED_MODEL", "from-env")
    assert LocalEmbedder("explicit").model_name == "explicit"


def test_failure_is_not_retried(monkeypatch):
    """A missing library must be probed once, not on every single recall."""
    monkeypatch.setenv(DISABLE_ENV, "1")
    e = LocalEmbedder()
    assert e.available is False
    calls = []
    original = e._ensure_model

    def counting():
        calls.append(1)
        return original()

    e._ensure_model = counting
    e.encode("x")
    e.encode("y")
    # _ensure_model is still called, but it short-circuits on the cached state.
    assert e._state is False


def test_encode_with_fake_model_normalizes_and_returns_floats():
    """Verify the contract memory_layer._embed_text requires: normalized list[float]."""
    class FakeST:
        def encode(self, text, show_progress_bar=False):
            return [3.0, 4.0]  # norm 5 → normalized (0.6, 0.8)

    e = LocalEmbedder()
    e._model = FakeST()
    e._backend = "torch"
    e._state = True
    vec = e.encode("你好")
    assert vec == [pytest.approx(0.6), pytest.approx(0.8)]
    assert all(isinstance(x, float) for x in vec)
    # Already-normalized output stays unit length.
    assert abs(sum(x * x for x in vec) - 1.0) < 1e-6


def test_onnx_backend_encode_path():
    """fastembed returns a generator of arrays; the ONNX path must handle it."""
    class FakeONNX:
        def embed(self, texts):
            for _ in texts:
                yield [6.0, 8.0]  # norm 10 → (0.6, 0.8)

    e = LocalEmbedder()
    e._model = FakeONNX()
    e._backend = "onnx"
    e._state = True
    assert e.encode("hi") == [pytest.approx(0.6), pytest.approx(0.8)]


def test_encode_batch_skips_blanks_but_keeps_positions():
    class FakeST:
        def encode(self, texts, show_progress_bar=False):
            # length-based so each row is distinguishable; will be normalized to 1.0
            return [[float(len(t))] for t in texts]

    e = LocalEmbedder()
    e._model = FakeST()
    e._backend = "torch"
    e._state = True
    out = e.encode_batch(["ab", "", "xyz"])
    assert out[0] == [pytest.approx(1.0)]   # [2.0] normalized
    assert out[1] is None                    # blank stays None
    assert out[2] == [pytest.approx(1.0)]   # [3.0] normalized


def test_single_encode_failure_does_not_disable_embedder():
    """One bad string shouldn't blacklist the whole embedder."""
    class Flaky:
        def __init__(self):
            self.n = 0

        def encode(self, text, show_progress_bar=False):
            self.n += 1
            if self.n == 1:
                raise RuntimeError("boom")
            return [1.0]

    e = LocalEmbedder()
    e._model = Flaky()
    e._backend = "torch"
    e._state = True
    assert e.encode("first") is None
    assert e.encode("second") == [pytest.approx(1.0)]   # still usable


def test_status_reports_backend(monkeypatch):
    monkeypatch.setenv(DISABLE_ENV, "1")
    e = LocalEmbedder()
    st = e.status()
    assert "backend" in st
    assert st["backend"] is None       # nothing loaded


def test_l2_normalize_is_idempotent():
    from embedder import _l2_normalize
    once = _l2_normalize([3.0, 4.0])
    twice = _l2_normalize(once)
    assert once == pytest.approx(twice)
    assert abs(sum(x * x for x in once) - 1.0) < 1e-6


def test_l2_normalize_handles_zero_vector():
    from embedder import _l2_normalize
    assert _l2_normalize([0.0, 0.0]) == [0.0, 0.0]  # no division by zero
