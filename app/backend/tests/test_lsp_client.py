import pytest
import os
import tempfile
from lsp_client import LocalSymbolNavigator, get_symbol_navigator, lsp_navigate_handler


def test_symbol_definition_and_references():
    with tempfile.TemporaryDirectory() as tmp_dir:
        code_file = os.path.join(tmp_dir, "service.py")
        with open(code_file, "w", encoding="utf-8") as f:
            f.write(
                "def compute_metrics(x, y):\n"
                "    return x + y\n\n"
                "res = compute_metrics(10, 20)\n"
            )

        nav = LocalSymbolNavigator(tmp_dir)
        defs = nav.find_definition("compute_metrics")
        assert len(defs) >= 1
        assert defs[0].line == 1
        assert defs[0].kind == "function"

        refs = nav.find_references("compute_metrics")
        assert len(refs) >= 2


def test_lsp_navigate_handler():
    with tempfile.TemporaryDirectory() as tmp_dir:
        out = lsp_navigate_handler("test_symbol", action="definition", workspace=tmp_dir)
        assert out["status"] == "ok"
        assert out["symbol"] == "test_symbol"


# ─────────────────────────────────────────────────────────────────────────────
# diagnostics_for_file 单测（Track R3）
# 不依赖真实语言服务器：用 FakeTransport 注入标准 publishDiagnostics 响应。
# ─────────────────────────────────────────────────────────────────────────────

import logging
from unittest import mock

from lsp_client import (
    FakeLspTransport,
    LspDiagnostic,
    LspDiagnosticClient,
    _path_to_uri,
    diagnostics_for_file,
    set_lsp_diagnostic_client,
)

_CANNED_PARAMS = {
    "uri": "file:///tmp/ws/example.py",
    "diagnostics": [
        {
            "range": {
                "start": {"line": 1, "character": 2},
                "end": {"line": 1, "character": 10},
            },
            "severity": 1,
            "source": "pyright",
            "message": 'undefined name "foo"',
        },
        {
            "range": {
                "start": {"line": 3, "character": 0},
                "end": {"line": 3, "character": 5},
            },
            "severity": 2,
            "source": "pyright",
            "message": "unused variable 'bar'",
        },
        {
            "range": {
                "start": {"line": 5, "character": 0},
                "end": {"line": 5, "character": 3},
            },
            "severity": 3,
            "source": "mypy",
            "message": "note: type hint",
        },
    ],
}


def setup_function(_fn):
    # 每个测试前清空全局会话，避免用例间串扰。
    set_lsp_diagnostic_client(None)


def test_diagnostics_function_exists():
    assert callable(diagnostics_for_file)
    assert callable(LspDiagnostic.parse_publish_diagnostics)
    assert callable(LspDiagnosticClient)


def test_returns_empty_without_server(caplog):
    """没有活跃 LSP 会话时返回 []，并记一条清晰的 warning（不抛异常）。"""
    set_lsp_diagnostic_client(None)
    with caplog.at_level(logging.WARNING, logger="lsp_client"):
        out = diagnostics_for_file("/tmp/ws", "example.py", "print(1)\n")
    assert out == []
    # 便捷单参数写法同样返回 []
    assert diagnostics_for_file("/tmp/ws/example.py") == []
    assert any("no active LSP diagnostic session" in r.message for r in caplog.records)


def test_parses_canned_publish_diagnostics_via_transport():
    """通过 mock transport 推送标准 publishDiagnostics 并解析。"""
    transport = FakeLspTransport()
    uri = _path_to_uri("/tmp/ws/example.py")
    transport.push_diagnostics(uri, _CANNED_PARAMS)
    client = LspDiagnosticClient(transport, root_uri="file:///tmp/ws")

    diags = client.diagnostics_for_file("/tmp/ws", "example.py")
    assert isinstance(diags, list)
    assert len(diags) == 3

    # 消费者（shadow_workspace）依赖的属性访问
    first = diags[0]
    assert first.source == "pyright"
    assert first.severity == "error"      # severity 1 → "error"
    assert first.line == 1
    assert first.character == 2
    assert first.message == 'undefined name "foo"'

    # 交付物要求的 dict 形态（按下标访问也可用）
    assert first["range"]["start"] == {"line": 1, "character": 2}
    assert first["severity"] == "error"
    assert set(first.to_dict().keys()) == {
        "range", "severity", "message", "source", "line", "character"
    }

    # severity 数值映射正确
    assert diags[1].severity == "warning"  # 2
    assert diags[2].severity == "info"     # 3


def test_parse_publish_diagnostics_directly_is_robust():
    """parse_publish_diagnostics 对空/畸形输入安全返回 []。"""
    assert LspDiagnostic.parse_publish_diagnostics(None) == []
    assert LspDiagnostic.parse_publish_diagnostics({}) == []
    assert LspDiagnostic.parse_publish_diagnostics({"diagnostics": "not-a-list"}) == []

    parsed = LspDiagnostic.parse_publish_diagnostics(_CANNED_PARAMS)
    assert len(parsed) == 3
    # 缺字段时给默认值，不崩
    single = LspDiagnostic.parse_publish_diagnostics({"diagnostics": [{"message": "boom"}]})
    assert single[0].severity == "info"
    assert single[0].source == "lsp"
    assert single[0].line == 0


def test_global_client_is_used_when_registered():
    """注册全局会话后，模块级 diagnostics_for_file 走真实查询。"""
    transport = FakeLspTransport()
    transport.push_diagnostics(_path_to_uri("/tmp/ws/example.py"), _CANNED_PARAMS)
    set_lsp_diagnostic_client(LspDiagnosticClient(transport, "file:///tmp/ws"))

    out = diagnostics_for_file("/tmp/ws", "example.py")
    assert len(out) == 3
    assert out[0].severity == "error"
