# -*- coding: utf-8 -*-
"""test_mcp_servers_config.py — Test configuration and loading of official MCP reference servers."""
import json
from pathlib import Path
import pytest

from mcp_manager import MCPManager, MCPServerConfig


def test_config_json_has_mcp_servers():
    config_path = Path(__file__).resolve().parent.parent.parent / "config.json"
    assert config_path.exists(), f"config.json not found at {config_path}"

    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert "mcpServers" in data, "mcpServers block missing from config.json"
    servers = data["mcpServers"]
    assert "filesystem" in servers, "Official reference 'filesystem' server missing"
    assert "fetch" in servers, "Official reference 'fetch' server missing"

    fs = servers["filesystem"]
    assert fs.get("command") == "npx"
    assert any("@modelcontextprotocol/server-filesystem" in arg for arg in fs.get("args", []))

    ft = servers["fetch"]
    assert ft.get("command") == "uvx"
    assert any("mcp-server-fetch" in arg for arg in ft.get("args", []))


def test_mcp_manager_loads_mcp_servers():
    mgr = MCPManager()
    cfg = {
        "mcpServers": {
            "filesystem": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"],
                "disabled": False,
            },
            "fetch": {
                "command": "uvx",
                "args": ["mcp-server-fetch"],
                "disabled": False,
            },
        }
    }
    mgr.load_config(cfg)
    assert len(mgr._servers) == 2
    assert "filesystem" in mgr._servers
    assert "fetch" in mgr._servers

    fs_conn = mgr._servers["filesystem"]
    assert fs_conn.config.transport == "stdio"
    assert fs_conn.config.command == "npx"

    snap = fs_conn.snapshot()
    assert snap["name"] == "filesystem"
    assert snap["status"] in ("idle", "disabled")
