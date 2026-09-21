"""
test_four_identities.py — Tests for Four-Fold Identity & Memory Architecture in Ovolve.
"""
from __future__ import annotations

import os
import tempfile
import pytest
from four_identities import (
    IDENTITY_FILE,
    USER_FILE,
    SOUL_FILE,
    MEMORY_FILE,
    init_workspace_identities,
    update_identity_name,
    update_user_name,
)


def test_init_workspace_identities():
    with tempfile.TemporaryDirectory() as td:
        created = init_workspace_identities(td, ai_name="OvolvePrime", user_name="Alice")
        assert created[IDENTITY_FILE] is True
        assert created[USER_FILE] is True
        assert created[SOUL_FILE] is True

        # Check content
        with open(os.path.join(td, IDENTITY_FILE), "r", encoding="utf-8") as f:
            c = f.read()
            assert "OvolvePrime" in c
            assert "IDENTITY.md" in c

        with open(os.path.join(td, USER_FILE), "r", encoding="utf-8") as f:
            c = f.read()
            assert "Alice" in c

        with open(os.path.join(td, SOUL_FILE), "r", encoding="utf-8") as f:
            c = f.read()
            assert "可审计性" in c

        # Re-running without overwrite does not touch files
        second = init_workspace_identities(td, ai_name="Other", overwrite=False)
        assert second[IDENTITY_FILE] is False


def test_update_names_preserves_surrounding_structure():
    with tempfile.TemporaryDirectory() as td:
        init_workspace_identities(td, ai_name="InitialAI", user_name="InitialUser")

        # Update AI Name
        assert update_identity_name(td, "OvolveSuper") is True
        with open(os.path.join(td, IDENTITY_FILE), "r", encoding="utf-8") as f:
            c = f.read()
            assert "- **Name**: OvolveSuper" in c
            assert "**Version**: Ovolve v1.0" in c  # surrounding fields intact

        # Update User Name
        assert update_user_name(td, "BobThePM") is True
        with open(os.path.join(td, USER_FILE), "r", encoding="utf-8") as f:
            c = f.read()
            assert "- **Name**: BobThePM" in c
            assert "Technical AI Product Manager" in c  # surrounding fields intact
