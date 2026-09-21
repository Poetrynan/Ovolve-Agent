# -*- coding: utf-8 -*-
"""test_ecosystem_skill_scanner.py — Unit tests for ecosystem multi-protocol skill scanner in Ovolve."""
from pathlib import Path
import pytest
from ecosystem_skill_scanner import EcosystemSkillScanner, EcosystemSkill
from skill_loader import SkillEntry


def test_ecosystem_skill_scanner_discovers_claude_skill(tmp_path):
    claude_skill_dir = tmp_path / ".claude" / "skills" / "pr-review"
    claude_skill_dir.mkdir(parents=True, exist_ok=True)
    skill_file = claude_skill_dir / "SKILL.md"
    skill_file.write_text(
        """---
name: pr-review
description: Multi-angle code review for GitHub pull requests
tools:
  - git
  - ripgrep
---
# PR Review
Inspect git diffs and report findings.
""",
        encoding="utf-8",
    )

    scanner = EcosystemSkillScanner(search_roots=[tmp_path])
    skills = scanner.scan(workspace_root=tmp_path)

    assert len(skills) == 1
    skill = skills[0]
    assert skill.name == "pr-review"
    assert "Multi-angle code review" in skill.description
    assert skill.protocol == "claude-code"
    assert skill.tools == ["git", "ripgrep"]
    assert "Inspect git diffs" in skill.instructions
    assert len(skill.content_hash) == 16


def test_ecosystem_skill_scanner_adapts_to_ovolve_skill_entry(tmp_path):
    skill_dir = tmp_path / ".agents" / "skills" / "deep-research"
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: deep-research
description: Multi-hop web research assistant
user-invocable: true
---
# Deep Research
Perform exhaustive web queries.
""",
        encoding="utf-8",
    )

    scanner = EcosystemSkillScanner(search_roots=[tmp_path])
    skills = scanner.scan(workspace_root=tmp_path)
    assert len(skills) == 1

    entry = scanner.adapt_to_skill_entry(skills[0])
    assert isinstance(entry, SkillEntry)
    assert entry.name == "deep-research"
    assert entry.description == "Multi-hop web research assistant"
    assert entry.version == skills[0].content_hash
    assert entry.user_invocable is True
    assert "Perform exhaustive web queries" in entry.body


def test_ecosystem_skill_scanner_ignores_noise_directories(tmp_path):
    # .git directory should be skipped
    git_skill_dir = tmp_path / ".git" / "skills" / "fake-skill"
    git_skill_dir.mkdir(parents=True, exist_ok=True)
    (git_skill_dir / "SKILL.md").write_text(
        "---\nname: fake-skill\ndescription: fake\n---\n# Fake\n",
        encoding="utf-8",
    )

    scanner = EcosystemSkillScanner(search_roots=[tmp_path])
    skills = scanner.scan(workspace_root=tmp_path)
    assert len(skills) == 0
