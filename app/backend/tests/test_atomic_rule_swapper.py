# -*- coding: utf-8 -*-
"""test_atomic_rule_swapper.py — Unit tests for atomic rule swapper & rollback (Module 3)."""
import os
from pathlib import Path
import pytest
from atomic_rule_swapper import AtomicRuleSwapper, SwapResult


def test_atomic_write_new_file(tmp_path):
    swapper = AtomicRuleSwapper(snapshot_dir=tmp_path / "snapshots")
    target = tmp_path / "rules" / "test_rule.md"
    content = "# Test Rule\nAlways verify with tests."
    
    result = swapper.write_atomic(target, content)
    assert result.success is True
    assert target.exists()
    assert target.read_text(encoding="utf-8") == content
    assert result.snapshot_path is None  # Target didn't exist before, so no snapshot


def test_atomic_write_existing_file_creates_snapshot_and_undo(tmp_path):
    swapper = AtomicRuleSwapper(snapshot_dir=tmp_path / "snapshots")
    target = tmp_path / "rules" / "test_rule.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("Old rule content v1", encoding="utf-8")
    
    new_content = "New rule content v2"
    result = swapper.write_atomic(target, new_content)
    
    assert result.success is True
    assert target.read_text(encoding="utf-8") == new_content
    assert result.snapshot_path is not None
    assert result.snapshot_path.exists()
    assert result.snapshot_path.read_text(encoding="utf-8") == "Old rule content v1"
    assert result.undo_token is not None


def test_atomic_rollback(tmp_path):
    swapper = AtomicRuleSwapper(snapshot_dir=tmp_path / "snapshots")
    target = tmp_path / "rules" / "test_rule.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("Original v1", encoding="utf-8")
    
    result = swapper.write_atomic(target, "Broken v2")
    assert target.read_text(encoding="utf-8") == "Broken v2"
    
    # Perform rollback using undo_token
    rollback_ok = swapper.rollback(result.undo_token)
    assert rollback_ok is True
    assert target.read_text(encoding="utf-8") == "Original v1"
