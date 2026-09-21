import pytest
from tool_search import ToolRegistryIndex, ToolMeta, get_tool_index, tool_search_handler


def test_tool_index_registration_and_search():
    index = ToolRegistryIndex()
    index.register_tool(
        name="read_file",
        description="Read the contents of a file on disk",
        parameters={"properties": {"path": {"type": "string"}}},
        category="filesystem",
        tags=["file", "read", "io"],
    )
    index.register_tool(
        name="git_commit",
        description="Record changes to the git repository",
        parameters={"properties": {"message": {"type": "string"}}},
        category="git",
        tags=["git", "vcs", "commit"],
    )
    index.register_tool(
        name="web_search",
        description="Search Google or DuckDuckGo for public web pages",
        parameters={"properties": {"query": {"type": "string"}}},
        category="web",
        tags=["web", "search", "network"],
    )

    # Search for git
    res_git = index.search("git commit repository")
    assert len(res_git) > 0
    assert res_git[0].name == "git_commit"

    # Search for file read
    res_file = index.search("read disk file")
    assert len(res_file) > 0
    assert res_file[0].name == "read_file"


def test_tool_search_handler():
    index = get_tool_index()
    index.register_tool(
        name="database_query",
        description="Execute SQL query against PostgreSQL database",
        parameters={"properties": {"sql": {"type": "string"}}},
        category="database",
        tags=["sql", "db", "postgres"],
    )
    out = tool_search_handler("SQL database query", limit=3)
    assert out["status"] == "ok"
    assert out["count"] > 0
    assert any(m["name"] == "database_query" for m in out["matches"])
