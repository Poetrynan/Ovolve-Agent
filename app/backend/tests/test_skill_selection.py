"""Skill selection slice: authored triggers, BROKEN exclusion, degraded feedback,
and the ``skill_load`` tool.

Covers four "written but never wired" findings from the audit:

* frontmatter ``triggers`` never took part in selection (``matched_by_triggers``
  had zero production callers);
* ``BROKEN`` was on the selection whitelist, so an already-broken skill could
  still be recommended and have its body injected;
* the ``degraded`` status written by ``_maybe_degrade_skill`` had no reader;
* the system prompt tells the model to call ``skill_load``, which was never
  registered as a tool.
"""
import os

from skill_lifecycle import create_candidate
from skill_loader import SkillLoader, SkillStatus, TrustLevel
from storage import Storage


SKILL_TMPL = """---
name: {name}
description: {desc}
triggers: [{triggers}]
---

# {name}

Step 1: do the thing.
"""


def write_skill(root, name, desc, triggers=""):
    d = os.path.join(str(root), name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(SKILL_TMPL.format(name=name, desc=desc, triggers=triggers))
    return d


def make_loader(tmp_path):
    st = Storage(db_dir=str(tmp_path / "db"))
    loader = SkillLoader()
    loader._storage = st  # temp DB: never touch the user's real data
    loader._degraded_cache = None
    return loader, st


def imp(loader, path):
    """Import as OWN trust: UNTRUSTED lands DISABLED and selection never runs."""
    r = loader.import_skill(path, TrustLevel.OWN)
    assert r.ok, r.error
    return r


def test_authored_trigger_wins_over_description_overlap(tmp_path):
    loader, st = make_loader(tmp_path)
    try:
        root = tmp_path / "skills"
        # Two description words hit (deploy/check), no authored trigger.
        imp(loader, write_skill(root, "wordy",
                                "deploy check release verify pipeline"))
        # Description is unrelated; exactly one authored trigger hits.
        imp(loader, write_skill(root, "authored",
                                "unrelated words entirely here",
                                triggers="ship-it"))

        hits = loader.find_by_trigger("please deploy check this, then ship-it")
        names = [h["name"] for h in hits]
        assert names[0] == "authored", hits
        assert hits[0]["matched_by"] == "triggers"
        assert hits[0]["triggers_hit"] == ["ship-it"]
        assert "wordy" in names, "description matches still rank, just lower"
    finally:
        st.close()


def test_trigger_only_match_is_selected_at_all(tmp_path):
    """One authored trigger is enough. The old rule needed 2 description words
    and looked at triggers not at all."""
    loader, st = make_loader(tmp_path)
    try:
        imp(loader, write_skill(tmp_path / "s", "pdf-fill",
                                "totally unrelated description text",
                                triggers="fill-the-form"))
        hits = loader.find_by_trigger("help me fill-the-form")
        assert [h["name"] for h in hits] == ["pdf-fill"], hits
    finally:
        st.close()


def test_broken_skill_is_not_offered(tmp_path):
    loader, st = make_loader(tmp_path)
    try:
        imp(loader, write_skill(tmp_path / "s", "risky",
                                "deploy check release verify",
                                triggers="ship-it"))
        loader.get_skill("risky").status = SkillStatus.BROKEN
        assert loader.find_by_trigger("deploy check ship-it") == [], \
            "a broken skill must not be recommended, let alone injected"
    finally:
        st.close()


def test_degraded_skill_is_excluded_from_selection(tmp_path):
    """Repeated failures -> degraded -> selection must actually stop offering it."""
    loader, st = make_loader(tmp_path)
    try:
        imp(loader, write_skill(tmp_path / "s", "flaky",
                                "deploy check release verify",
                                triggers="ship-it"))
        assert loader.find_by_trigger("deploy check ship-it"), \
            "baseline: it would be selected before degrading"

        exp = st.record_skill_experience(
            "flaky", outcome="success", steps_attempted=1, steps_succeeded=1)
        cand = create_candidate(st, {
            "name": "flaky", "description": "deploy checklist",
            "when_to_use": "before shipping", "verification": "human confirms",
            "steps": ["check"], "experience_ref": exp,
        })
        assert cand.ok
        st.set_skill_candidate_status(cand.value["id"], "degraded")

        loader._degraded_cache = None  # bypass the 30s cache, read fresh
        assert loader.find_by_trigger("deploy check ship-it") == [], \
            "degraded was written but nobody read it — that is not a feedback loop"
    finally:
        st.close()


def test_skill_load_tool_is_registered_and_returns_body(tmp_path):
    import skill_loader as sl
    import skill_tools
    from tools import ToolRegistry

    registry = ToolRegistry()
    skill_tools.register_tools(registry)
    assert registry.get("skill_load") is not None, \
        "the prompt has always told the model to call it; it must exist"

    loader, st = make_loader(tmp_path)
    prev = getattr(sl, "_loader", None)
    sl._loader = loader
    try:
        imp(loader, write_skill(tmp_path / "s", "doc-writer",
                                "how to write docs", triggers="write-docs"))
        ctx = {}
        res = skill_tools._skill_load_impl({"name": "doc-writer"}, ctx)
        assert res.ok, res.error
        assert "Step 1" in res.value["body"]
        # Loading IS a use: the turn end records an experience from this.
        assert ctx["skill_injected"]["name"] == "doc-writer"
        assert ctx["skill_injected"]["reason"] == "skill_load_tool"

        missing = skill_tools._skill_load_impl({"name": "nope"}, {})
        assert not missing.ok and "no skill named" in missing.error
    finally:
        sl._loader = prev
        st.close()
