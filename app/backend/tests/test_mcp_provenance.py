"""Origin bookkeeping for installed MCP connectors.

A connector installed from the marketplace should stay attributable after it is
installed, not only while it is still sitting in the catalogue. That origin is
kept beside config.json rather than inside it, because everything under
``mcpServers`` is handed to the MCP client as-is and our bookkeeping is not
part of that protocol.
"""
import json
import os
import sys

import pytest

here = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.abspath(os.path.join(here, ".."))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import skill_registry


@pytest.fixture()
def provenance_file(tmp_path, monkeypatch):
    """Redirect the origin record into a temp dir instead of the repository."""
    path = tmp_path / "mcp-provenance.json"
    monkeypatch.setattr(skill_registry, "_mcp_provenance_path", lambda: path)
    return path


_ENTRY = {
    "id": "mcp-filesystem",
    "name": "filesystem",
    "type": "mcp",
    "source": "github.com/modelcontextprotocol/servers",
    "mcpConfig": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"]},
}


def test_recorded_origin_survives_a_reload(provenance_file):
    skill_registry.record_mcp_provenance("filesystem", _ENTRY)
    assert provenance_file.is_file()

    record = skill_registry.load_mcp_provenance()
    assert record["filesystem"]["source"] == "github.com/modelcontextprotocol/servers"
    # Provenance comes from the source registry, so the licence is filled in.
    assert record["filesystem"]["license"] == "Apache-2.0 (new contributions) / MIT (existing)"


def test_origin_never_leaks_into_the_mcp_config(provenance_file):
    """The sidecar exists precisely so config.json stays protocol-clean."""
    skill_registry.record_mcp_provenance("filesystem", _ENTRY)
    record = skill_registry.load_mcp_provenance()["filesystem"]
    for leaked in ("mcpConfig", "command", "args", "type"):
        assert leaked not in record


def test_entry_without_a_known_source_records_nothing(provenance_file):
    """No source means no record, rather than a record full of nulls."""
    skill_registry.record_mcp_provenance("mystery", {"id": "x", "name": "mystery", "type": "mcp"})
    assert skill_registry.load_mcp_provenance() == {}


def test_unreadable_record_reads_as_empty(provenance_file):
    provenance_file.write_text("{ not json", encoding="utf-8")
    assert skill_registry.load_mcp_provenance() == {}


async def test_mcp_list_merges_the_recorded_origin(provenance_file, monkeypatch):
    """The listing endpoint must surface origin, and invent none for others."""
    import mcp_manager

    class _StubManager:
        available = True
        import_error = ""

        def list_servers(self):
            return [
                {"name": "filesystem", "status": "connected"},
                {"name": "added-by-hand", "status": "connected"},
            ]

    monkeypatch.setattr(mcp_manager, "get_mcp_manager", lambda: _StubManager())
    skill_registry.record_mcp_provenance("filesystem", _ENTRY)

    from server.http_server import handle_mcp_list

    response = await handle_mcp_list(None)
    payload = json.loads(response.text)
    by_name = {s["name"]: s for s in payload["servers"]}

    assert by_name["filesystem"]["source"] == "github.com/modelcontextprotocol/servers"
    assert by_name["filesystem"]["license"].startswith("Apache-2.0")
    # A hand-added server has no recorded origin, and must not be given one.
    assert "source" not in by_name["added-by-hand"]
    assert "license" not in by_name["added-by-hand"]
