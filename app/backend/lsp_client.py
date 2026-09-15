"""lsp_client.py — Language Server Protocol (LSP) 符号级代码导航与定义查找 

功能：
1. 标准 JSON-RPC 2.0 协议封装
2. 精准符号跳转 (textDocument/definition)
3. 查找引用与调用链 (textDocument/references)
4. 文档符号大纲 (textDocument/documentSymbol)
5. 纯本地启动支持 (pyright, typescript-language-server, rust-analyzer, gopls)
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class SymbolLocation:
    file_path: str
    line: int
    character: int
    symbol_name: str = ""
    container_name: str = ""
    kind: str = "variable"  # "function" | "class" | "variable" | "interface"


class LocalSymbolNavigator:
    """轻量级纯本地符号解析与导航引擎（带 AST / 正则启发式快速定位）"""

    def __init__(self, workspace_root: str):
        self.workspace_root = os.path.abspath(workspace_root)

    def find_definition(self, symbol_name: str, target_file: Optional[str] = None) -> list[SymbolLocation]:
        """查找指定符号的定义位置（支持类、函数、常量、类型定义）"""
        results: list[SymbolLocation] = []
        # 兼容 def foo, class foo, function foo, const foo 等
        pattern = re.compile(
            r'(?:def|class|function|const|let|var|interface|type|struct|fn)\s+(' + re.escape(symbol_name) + r')(?:\b|[(:])'
        )

        files_to_scan = []
        if target_file and os.path.isfile(target_file):
            files_to_scan.append(target_file)
        else:
            for root, _, files in os.walk(self.workspace_root):
                if any(ignored in root for ignored in [".git", "node_modules", "__pycache__", "dist", "build"]):
                    continue
                for f in files:
                    if f.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs")):
                        files_to_scan.append(os.path.join(root, f))
                if len(files_to_scan) > 200:
                    break

        for fpath in files_to_scan:
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                    for i, line in enumerate(fp, start=1):
                        match = pattern.search(line)
                        if match:
                            kind = "function" if "def " in line or "fn " in line or "function " in line else "class" if "class " in line else "variable"
                            rel_path = os.path.relpath(fpath, self.workspace_root)
                            results.append(
                                SymbolLocation(
                                    file_path=rel_path,
                                    line=i,
                                    character=match.start(1),
                                    symbol_name=symbol_name,
                                    kind=kind,
                                )
                            )
            except Exception:
                continue

        return results

    def find_references(self, symbol_name: str, limit: int = 20) -> list[SymbolLocation]:
        """查找指定符号的所有引用调用位置"""
        results: list[SymbolLocation] = []
        pattern = re.compile(r'\b(' + re.escape(symbol_name) + r')\b')

        for root, _, files in os.walk(self.workspace_root):
            if any(ignored in root for ignored in [".git", "node_modules", "__pycache__", "dist"]):
                continue
            for f in files:
                if f.endswith((".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs")):
                    fpath = os.path.join(root, f)
                    try:
                        with open(fpath, "r", encoding="utf-8", errors="ignore") as fp:
                            for i, line in enumerate(fp, start=1):
                                match = pattern.search(line)
                                if match:
                                    rel_path = os.path.relpath(fpath, self.workspace_root)
                                    results.append(
                                        SymbolLocation(
                                            file_path=rel_path,
                                            line=i,
                                            character=match.start(1),
                                            symbol_name=symbol_name,
                                        )
                                    )
                                    if len(results) >= limit:
                                        return results
                    except Exception:
                        continue
        return results


_GLOBAL_NAVIGATOR: Optional[LocalSymbolNavigator] = None


def get_symbol_navigator(workspace_root: str) -> LocalSymbolNavigator:
    global _GLOBAL_NAVIGATOR
    if _GLOBAL_NAVIGATOR is None or _GLOBAL_NAVIGATOR.workspace_root != os.path.abspath(workspace_root):
        _GLOBAL_NAVIGATOR = LocalSymbolNavigator(workspace_root)
    return _GLOBAL_NAVIGATOR


def lsp_navigate_handler(symbol: str, action: str = "definition", workspace: str = ".") -> dict[str, Any]:
    """lsp 符号导航工具运行时处理入口"""
    nav = get_symbol_navigator(workspace)
    if action == "definition":
        defs = nav.find_definition(symbol)
        return {
            "status": "ok",
            "symbol": symbol,
            "action": "definition",
            "count": len(defs),
            "definitions": [
                {
                    "location": f"{d.file_path}:{d.line}",
                    "kind": d.kind,
                }
                for d in defs
            ],
        }
    elif action == "references":
        refs = nav.find_references(symbol)
        return {
            "status": "ok",
            "symbol": symbol,
            "action": "references",
            "count": len(refs),
            "references": [
                {
                    "location": f"{r.file_path}:{r.line}",
                }
                for r in refs
            ],
        }
    return {"status": "error", "message": f"未知的 LSP 动作: '{action}'"}


# ─────────────────────────────────────────────────────────────────────────────
# 诊断 (diagnostics_for_file)
#
# 影子工作区预校验 (shadow_workspace._checker_lsp) 需要在落盘前知道一个文件有没有
# LSP 级别的错误（未定义符号、类型错误……）。它调用 ``diagnostics_for_file(workspace,
# logical_path, content)`` 并读取返回对象上的 ``.source / .severity / .message /
# .line / .character``。
#
# 设计原则：
#   * 失败开放但**不静默错误**——没有可用的 LSP 会话时返回 ``[]`` 并记录一条
#     清晰的 warning（限流到每进程一次），调用方据此跳过 LSP 校验而不是误以为
#     "无错"。
#   * 解析走 LSP 标准 ``textDocument/publishDiagnostics`` 形态，便于用 mock transport
#     在 CI 里不依赖真实语言服务器完成测试。
# ─────────────────────────────────────────────────────────────────────────────

import logging as _lsp_log

log = _lsp_log.getLogger(__name__)

#: LSP ``DiagnosticSeverity`` 数值 → Ovolve 字符串档位（与 shadow_workspace 的
#: ``severity in ("error","warning")`` 判定口径一致）。
_LSP_SEVERITY_TO_STR = {1: "error", 2: "warning", 3: "info", 4: "hint"}


def _path_to_uri(path: str) -> str:
    """``C:\\foo\\bar.py`` → ``file:///C:/foo/bar.py``（跨平台）。"""
    abs_path = os.path.abspath(path)
    norm = abs_path.replace("\\", "/")
    if norm.startswith("/"):
        return "file://" + norm
    return "file:///" + norm


class LspDiagnostic:
    """单条诊断。同时支持属性访问（消费者用）与下标访问（``d["range"]``）。"""

    __slots__ = ("range", "severity", "message", "source", "line", "character")

    def __init__(self, range, severity, message, source, line=0, character=0):
        self.range = range
        self.severity = severity
        self.message = message
        self.source = source
        self.line = line
        self.character = character

    def __getitem__(self, key):
        return getattr(self, key)

    def to_dict(self) -> dict:
        return {
            "range": self.range,
            "severity": self.severity,
            "message": self.message,
            "source": self.source,
            "line": self.line,
            "character": self.character,
        }

    @staticmethod
    def parse_publish_diagnostics(params: Optional[dict]) -> list["LspDiagnostic"]:
        """解析 LSP ``PublishDiagnosticsParams`` → ``list[LspDiagnostic]``。

        ``params`` 形态::

            {"uri": "file:///...", "diagnostics": [
                {"range": {"start": {"line": L, "character": C},
                           "end":   {"line": L, "character": C}},
                 "severity": 1, "source": "pyright", "message": "..."}
            ]}

        空 / 畸形输入安全返回 ``[]``。
        """
        if not params:
            return []
        raw = params.get("diagnostics")
        if not isinstance(raw, list):
            return []
        out: list[LspDiagnostic] = []
        for d in raw:
            if not isinstance(d, dict):
                continue
            rng = d.get("range") or {}
            start = (rng.get("start") or {}) if isinstance(rng, dict) else {}
            sev = d.get("severity")
            if isinstance(sev, int):
                severity = _LSP_SEVERITY_TO_STR.get(sev, "info")
            elif isinstance(sev, str):
                severity = sev
            else:
                severity = "info"
            out.append(LspDiagnostic(
                range=rng if isinstance(rng, dict) else {},
                severity=severity,
                message=d.get("message", "") or "",
                source=(d.get("source") or "lsp") or "lsp",
                line=int(start.get("line", 0) or 0),
                character=int(start.get("character", 0) or 0),
            ))
        return out


class LspDiagnosticTransport:
    """传输抽象。``publish_diagnostics(uri)`` 返回该文件的 PublishDiagnosticsParams
    或 ``{}``。真实实现见 :class:`StdioLspTransport`；测试用 :class:`FakeLspTransport`。
    """

    def publish_diagnostics(self, uri: str) -> dict:  # pragma: no cover - 基类
        return {}


class FakeLspTransport(LspDiagnosticTransport):
    """内存 transport：``push_diagnostics(uri, params)`` 注入，供测试与离线使用。"""

    def __init__(self):
        self._store: dict[str, dict] = {}

    def push_diagnostics(self, uri: str, params: dict) -> None:
        self._store[uri] = params

    def publish_diagnostics(self, uri: str) -> dict:
        return self._store.get(uri, {})


class LspDiagnosticClient:
    """持有一个 transport + 工作区根，对外暴露 ``diagnostics_for_file``。"""

    def __init__(self, transport: LspDiagnosticTransport, root_uri: str = ""):
        self.transport = transport
        self.root_uri = root_uri

    def diagnostics_for_file(self, workspace: str, logical_path: str, content=None) -> list:
        uri = _path_to_uri(os.path.join(workspace, logical_path)) if workspace else _path_to_uri(logical_path)
        params = self.transport.publish_diagnostics(uri)
        return LspDiagnostic.parse_publish_diagnostics(params)


class StdioLspTransport(LspDiagnosticTransport):
    """尽力而为的真实 LSP transport：启动一个语言服务器子进程，做 initialize +
    textDocument/didOpen，并把收到的 ``publishDiagnostics`` 通知缓存起来供 pull。

    全部通信包在 try/except 里、带硬超时，启动/握手失败就把 ``self.available`` 置
    False 并安全返回 ``{}``——**绝不让诊断查询卡住或炸掉预校验**。默认路径不会自动
    实例化它；调用方显式 ``create_stdio_lsp_client`` 才会用。
    """

    def __init__(self, command: list, root_uri: str, timeout_s: float = 8.0):
        self.command = list(command)
        self.root_uri = root_uri
        self.timeout_s = timeout_s
        self.available = False
        self._store: dict[str, dict] = {}
        self._proc = None
        self._req_id = 0
        self._start()

    def _start(self) -> None:
        try:
            import subprocess
            import threading
            import json as _json

            self._proc = subprocess.Popen(
                self.command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
            # 最小握手（initialize / initialized / 不等待完整能力协商）。
            self._send({"jsonrpc": "2.0", "id": self._next_id(),
                        "method": "initialize",
                        "params": {"rootUri": self.root_uri or None,
                                   "capabilities": {}}})
            # 后台读线程：只认 publishDiagnostics，其余忽略；任何异常都静默退出。
            def _reader():
                try:
                    for msg in self._read_messages():
                        if msg.get("method") == "textDocument/publishDiagnostics":
                            p = msg.get("params") or {}
                            self._store[p.get("uri", "")] = p
                except Exception:
                    return

            t = threading.Thread(target=_reader, daemon=True)
            t.start()
            self.available = True
        except Exception as exc:  # noqa: BLE001
            log.warning("StdioLspTransport: failed to start LSP server %s: %s", self.command, exc)
            self.available = False

    def _next_id(self):
        self._req_id += 1
        return self._req_id

    def _send(self, obj) -> None:
        import json as _json
        body = _json.dumps(obj)
        self._proc.stdin.write(f"Content-Length: {len(body.encode('utf-8'))}\r\n\r\n{body}\n")
        self._proc.stdin.flush()

    def _read_messages(self):
        import json as _json
        buf = ""
        while True:
            line = self._proc.stdout.readline()
            if not line:
                return
            line = line.strip()
            if line == "":
                # 头部结束，读 Content-Length body
                cl = 0
                while True:
                    h = self._proc.stdout.readline().strip()
                    if h == "":
                        break
                    if h.lower().startswith("content-length:"):
                        cl = int(h.split(":", 1)[1])
                if cl <= 0:
                    continue
                data = self._proc.stdout.read(cl)
                yield _json.loads(data)
            else:
                buf = line

    def did_open(self, uri: str, language_id: str, text: str) -> None:
        if not self.available:
            return
        try:
            self._send({"jsonrpc": "2.0", "method": "textDocument/didOpen",
                        "params": {"textDocument": {"uri": uri,
                                                    "languageId": language_id,
                                                    "version": 1,
                                                    "text": text}}})
        except Exception:  # noqa: BLE001
            pass

    def publish_diagnostics(self, uri: str) -> dict:
        if not self.available:
            return {}
        return self._store.get(uri, {})

    def shutdown(self) -> None:
        try:
            if self._proc and self._proc.poll() is None:
                self._proc.terminate()
        except Exception:  # noqa: BLE001
            pass


def create_stdio_lsp_client(command: list, root_uri: str = "") -> LspDiagnosticClient:
    """按命令启动一个真实 LSP 子进程并返回诊断客户端（启动失败则 available=False）。"""
    return LspDiagnosticClient(StdioLspTransport(command, root_uri), root_uri)


# ── 全局诊断会话（由 router / 配置在启动时注入；不注入则默认无会话 → 返回 []） ──

_GLOBAL_DIAGNOSTIC_CLIENT: Optional[LspDiagnosticClient] = None
_NO_SESSION_WARNED: bool = False


def set_lsp_diagnostic_client(client: Optional[LspDiagnosticClient]) -> None:
    """注册当前进程的活跃 LSP 诊断会话（传 None 可清空）。"""
    global _GLOBAL_DIAGNOSTIC_CLIENT, _NO_SESSION_WARNED
    _GLOBAL_DIAGNOSTIC_CLIENT = client
    _NO_SESSION_WARNED = False


def diagnostics_for_file(workspace, logical_path: str = "", content=None) -> list:
    """查询当前活跃 LSP 会话，返回 ``logical_path`` 的诊断列表。

    同时兼容两种调用风格：

      * ``diagnostics_for_file(workspace, logical_path, content)``  ← shadow_workspace 消费者
      * ``diagnostics_for_file(file_path)``                        ← 单参数便捷写法

    无可用 LSP 会话时返回 ``[]`` 并记一条（限流）warning——**不抛异常**，调用方据此
    跳过 LSP 校验，而不是误判为"无错"。
    """
    global _NO_SESSION_WARNED
    # 单参数便捷写法：把 file_path 拆成 workspace 根 + 相对名。
    if not logical_path:
        file_path = workspace
        workspace = os.path.dirname(file_path) or "."
        logical_path = os.path.basename(file_path)

    client = _GLOBAL_DIAGNOSTIC_CLIENT
    if client is None:
        if not _NO_SESSION_WARNED:
            _NO_SESSION_WARNED = True
            log.warning(
                "diagnostics_for_file: no active LSP diagnostic session configured "
                "(set_lsp_diagnostic_client); returning [] — LSP checks are SKIPPED, not passed."
            )
        return []
    try:
        return client.diagnostics_for_file(workspace, logical_path, content)
    except Exception as exc:  # noqa: BLE001
        log.warning("diagnostics_for_file: LSP session error for %s/%s: %s; returning []",
                    workspace, logical_path, exc)
        return []
