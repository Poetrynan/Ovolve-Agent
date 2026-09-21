"""Keep THIRD_PARTY_LICENSES.md honest.

The license record is written by hand, so it drifts the moment someone edits
SOURCE_REGISTRY or the marketplace catalogue and forgets to update it. These
assertions pin the claims the document makes to the values the code actually
uses, so a silent divergence fails a test instead of shipping.

Nothing here fetches from the network: it checks that the document agrees with
this repository, not that upstream still agrees with us.
"""
import os
import sys

import pytest

here = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.abspath(os.path.join(here, ".."))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from skill_registry import MARKETPLACE_CATALOG, SOURCE_REGISTRY, with_provenance


def _doc_path() -> str:
    """Locate THIRD_PARTY_LICENSES.md at the repository root."""
    root = os.path.abspath(os.path.join(here, "..", "..", ".."))
    return os.path.join(root, "THIRD_PARTY_LICENSES.md")


@pytest.fixture(scope="module")
def doc() -> str:
    path = _doc_path()
    if not os.path.isfile(path):
        pytest.skip(f"license record not present at {path}")
    with open(path, encoding="utf-8") as fp:
        return fp.read()


def _entries(kind: str):
    return [with_provenance(e) for e in MARKETPLACE_CATALOG if e.get("type") == kind]


def test_every_skill_comes_from_the_declared_mit_upstream(doc):
    skills = _entries("skill")
    assert skills, "catalogue should carry skill entries"
    for entry in skills:
        assert entry["source"] == "github.com/wshobson/agents"
        assert entry["license"] == "MIT"
        # 文档必须真的提到这条技能，不能只写个总数。
        assert entry["id"] in doc, f"{entry['id']} missing from the license record"
        assert entry["skillPath"] in doc, f"{entry['id']} path missing from the record"


def test_mcp_connectors_are_split_by_upstream_status(doc):
    """filesystem and fetch are maintained; the other four are not.

    Recorded separately because an archived connector keeps working while
    nothing upstream is being fixed. Merging the two groups would present an
    unmaintained dependency as though it were maintained.
    """
    active = sorted(e["id"] for e in _entries("mcp") if not e["archived"])
    archived = sorted(e["id"] for e in _entries("mcp") if e["archived"])
    assert active == ["mcp-fetch", "mcp-filesystem"]
    assert archived == ["mcp-github", "mcp-postgres", "mcp-puppeteer", "mcp-sqlite"]
    assert "archived" in doc.lower(), "record must state the archived status"


def test_record_carries_every_pinned_revision(doc):
    """Every pinned revision must appear, so the record names what we fetch."""
    pinned = [m["commitSha"] for m in SOURCE_REGISTRY.values() if m["commitSha"]]
    assert pinned, "at least one upstream revision should be pinned"
    for sha in pinned:
        assert sha in doc, f"pinned revision {sha[:12]} missing from the license record"
