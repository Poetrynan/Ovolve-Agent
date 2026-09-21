"""Unit tests for Unified Extension Marketplace and Safe Uninstall Lifecycle in Ovolve.

Verifies:
1. Marketplace catalog filtering by type (skill / plugin / mcp).
2. MCP and Plugin catalog entry shapes and install dispatch.
3. Safe uninstall lifecycle for skills: status becomes DISABLED, disable_model_invocation is True,
   directory and card remain intact, but AI runtime prompt & triggers completely isolate/exclude it.
"""
import os
import sys
import tempfile
import pytest

# Ensure app/backend is on sys.path
here = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.abspath(os.path.join(here, ".."))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from skill_registry import get_marketplace_catalog, install_marketplace_skill, MARKETPLACE_CATALOG
from skill_loader import SkillLoader, SkillStatus, TrustLevel


def test_marketplace_catalog_type_filter():
    """Verify get_marketplace_catalog filters correctly by type."""
    all_items = get_marketplace_catalog()
    assert len(all_items) > 0

    mcp_items = get_marketplace_catalog(type_filter="mcp")
    assert len(mcp_items) >= 4
    for item in mcp_items:
        assert item.get("type") == "mcp"
    mcp_ids = [item["id"] for item in mcp_items]
    assert "mcp-github" in mcp_ids
    assert "mcp-filesystem" in mcp_ids

    plugin_items = get_marketplace_catalog(type_filter="plugin")
    assert len(plugin_items) >= 3
    for item in plugin_items:
        assert item.get("type") == "plugin"
    plugin_ids = [item["id"] for item in plugin_items]
    assert "plugin-git-suite" in plugin_ids

    skill_items = get_marketplace_catalog(type_filter="skill")
    assert len(skill_items) >= 5
    for item in skill_items:
        assert item.get("type") == "skill"


def test_marketplace_category_and_query():
    """Verify category and search query work across types."""
    dev_items = get_marketplace_catalog(category="development")
    assert len(dev_items) > 0
    for item in dev_items:
        assert item["category"] == "development"

    search_items = get_marketplace_catalog(query="github")
    assert any(item["id"] == "mcp-github" for item in search_items)


def test_safe_uninstall_skill_lifecycle():
    """Verify uninstall_skill keeps the card in loader, marks DISABLED, and isolates from AI."""
    with tempfile.TemporaryDirectory() as tmpdir:
        loader = SkillLoader()
        skill_dir = os.path.join(tmpdir, "test-safe-skill")
        os.makedirs(skill_dir, exist_ok=True)
        skill_md = os.path.join(skill_dir, "SKILL.md")
        with open(skill_md, "w", encoding="utf-8") as f:
            f.write("---\nname: test-safe-skill\ndescription: A safe test skill for verification\ntriggers: [testsafe, unittesthit]\n---\n# Test Body\nSome instructions.\n")

        res = loader.import_skill(skill_dir, TrustLevel.VERIFIED)
        assert res.ok
        assert "test-safe-skill" in loader._skills
        entry = loader._skills["test-safe-skill"]
        assert entry.status != SkillStatus.DISABLED

        # Check that it appears in available skills prompt and trigger matching
        prompt_before = loader.render_available_skills_prompt()
        assert "test-safe-skill" in prompt_before
        triggers_before = loader.matched_by_triggers("hello testsafe world")
        assert "test-safe-skill" in triggers_before

        # Execute safe uninstall
        un_res = loader.uninstall_skill("test-safe-skill")
        assert un_res.ok

        # 1. Card / entry is NOT deleted from loader
        assert "test-safe-skill" in loader._skills
        # 2. Status is set to DISABLED and invocation disabled
        assert entry.status == SkillStatus.DISABLED
        assert entry.disable_model_invocation is True
        # 3. Directory on disk is NOT deleted
        assert os.path.exists(skill_md)

        # 4. list_skills(include_disabled=True) still returns it so UI keeps the card
        listed = loader.list_skills(include_disabled=True)
        listed_names = [s["name"] for s in listed]
        assert "test-safe-skill" in listed_names
        disabled_item = next(s for s in listed if s["name"] == "test-safe-skill")
        assert disabled_item["status"] == "disabled"

        # 5. But prompt rendering and trigger matching NO LONGER contain it
        prompt_after = loader.render_available_skills_prompt()
        assert "test-safe-skill" not in prompt_after
        triggers_after = loader.matched_by_triggers("hello testsafe world")
        assert "test-safe-skill" not in triggers_after


def test_get_skill_detail():
    with tempfile.TemporaryDirectory() as tmpdir:
        loader = SkillLoader()
        skill_dir = os.path.join(tmpdir, "test-detail-skill")
        os.makedirs(skill_dir, exist_ok=True)
        skill_md = os.path.join(skill_dir, "SKILL.md")
        with open(skill_md, "w", encoding="utf-8") as f:
            f.write("---\nname: test-detail-skill\ndescription: Detailed test skill\ntools: [grep, bash]\n---\n# Detailed instructions\nStep 1.\n")

        loader.import_skill(skill_dir, TrustLevel.VERIFIED)
        detail_res = loader.get_skill_detail("test-detail-skill")
        assert detail_res.ok
        val = detail_res.value
        assert val["name"] == "test-detail-skill"
        assert val["description"] == "Detailed test skill"
        assert "Detailed instructions" in val["body"]


def test_catalog_skill_paths_point_into_plugins_tree():
    """Marketplace skill entries must name a real upstream directory.

    wshobson/agents has no top-level skills/ directory: every skill lives at
    plugins/<plugin>/skills/<skill>/. An entry written as "skills/<name>" resolves
    to nothing, and the failure only surfaces deep inside the clone step as a
    missing SKILL.md, which reads like a network problem rather than a bad path.
    """
    skills = [e for e in MARKETPLACE_CATALOG if e.get("type") == "skill"]
    assert skills, "catalog should carry at least one skill entry"
    for entry in skills:
        path = entry.get("skillPath") or ""
        assert path, f"{entry['id']} has no skillPath"
        # 必须是目录：install_marketplace_skill 只判 isdir，写成文件路径会直接失败。
        assert not path.endswith("SKILL.md"), f"{entry['id']} skillPath must be a directory"
        assert path.startswith("plugins/"), f"{entry['id']} uses a non-plugin path: {path}"
        assert "/skills/" in path, f"{entry['id']} skillPath lacks a skills/ segment: {path}"
        parts = path.split("/")
        assert len(parts) == 4, (
            f"{entry['id']} expected plugins/<plugin>/skills/<skill>, got {path}"
        )


def test_catalog_skill_paths_stay_within_approved_plugins():
    """Skill entries must come from plugin trees we have reviewed.

    Naming the approved set is safer than naming the ones we exclude: an
    allowlist fails closed when upstream adds a plugin we have never looked
    at, instead of quietly admitting it until someone remembers to extend a
    blocklist.
    """
    approved = {
        "developer-essentials",
        "llm-application-dev",
        "ui-design",
        "documentation-generation",
        "protect-mcp",
    }
    for entry in MARKETPLACE_CATALOG:
        path = str(entry.get("skillPath") or "")
        if not path.startswith("plugins/"):
            continue
        plugin = path.split("/")[1]
        assert plugin in approved, (
            f"{entry['id']} pulls from an unreviewed plugin: {plugin}"
        )
