"""memory_mcp_server.py — Ovolve 本地 MCP 记忆服务器（官方 SDK 版）

命名说明：``mcp_server/`` 那个包是**客户端**侧基础设施（auth / server / tools，
用于连接外部 MCP 服务）。本文件是**服务端** —— 把 Ovolve 自己的记忆暴露给别的
Agent。职责相反，所以不共用一个名字。

# 实现选择：官方 ``mcp`` SDK（FastMCP）

宪法文档 v3 §4.1 明确要求"MCP | 官方 mcp 包 | 兼容性保障"。之前手写 JSON-RPC
虽然依赖轻，但要自己维护协议版本、错误码、通知语义 —— 官方 SDK 已经把这些细节
处理好了，直接用 FastMCP 的装饰器 API 声明工具，最省事也最兼容。

# 暴露的工具（都是本地的，不出户）

  · ``memory_search``  —— 语义 + 关键词混合召回；embed 缺席时自动退回关键词
  · ``memory_add``     —— 写入一条记忆，立即落盘到 SQLite
  · ``memory_list``    —— 分页列出当前工作区的所有记忆
  · ``rules_list``     —— 读取用户可编辑的 rules/*.md 规则库

# 传输：stdio

MCP 生态默认走 stdio —— 客户端把服务器作为子进程 spawn 起来，双方读写 stdin /
stdout 交换 JSON-RPC。stderr 留给日志。主流 MCP 客户端的标配。

# 启动方式

    python -m memory_mcp_server

配主流 MCP 客户端：

    {"mcpServers": {
      "ovolve-memory": {
        "command": "python",
        "args": ["-m", "memory_mcp_server"],
        "env": {"PYTHONPATH": "<repo>/app/backend",
                "OVOLVE_WORKSPACE": "<你的项目根>"}
      }
    }}
"""
from __future__ import annotations

import os
import sys
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

# 复用 memory_layer / storage / rule_engine —— 一份代码两个入口
# （HTTP/WebSocket + MCP），语义完全一致，无需数据同步。
from memory_layer import get_memory_layer, Memory, MemoryType, MemoryScope
from storage import get_storage
from rule_engine import get_rule_engine


SERVER_NAME = "ovolve-memory"
SERVER_VERSION = "0.2.0"


def _log(msg: str) -> None:
    """诊断日志走 stderr，绝对不能污染 stdout（那是 JSON-RPC 通道）。"""
    print(f"[mcp] {msg}", file=sys.stderr, flush=True)


def _get_workspace() -> str:
    """MCP 服务器没有"当前工作区"概念，走环境变量或当前目录。"""
    return os.environ.get("OVOLVE_WORKSPACE") or os.getcwd()


# ── FastMCP 应用 ───────────────────────────────────────────────────────────
#
# FastMCP 会读函数签名 + docstring + 类型注解自动生成 tools/list 的 schema。
# 手写 inputSchema 的活它替我们干了。

mcp = FastMCP(SERVER_NAME)


@mcp.tool()
def memory_search(query: str, limit: int = 5) -> dict:
    """语义 + 关键词召回记忆。返回结构化条目列表。

    Args:
        query: 查询文本，用于向量检索和关键词匹配。
        limit: 最多返回条数，默认 5，最大 50。
    """
    query = (query or "").strip()
    if not query:
        return {"error": "query 不能为空"}
    limit = max(1, min(int(limit or 5), 50))
    memory = get_memory_layer()
    storage = get_storage()
    # ``prefetch`` 返回给 system prompt 用的 XML 字符串；MCP 客户端要结构化，
    # 所以直接走底层 search_memory_semantic 拿原始条目。
    q_emb = memory._embed_text(query) if memory.has_embeddings else None
    rows = storage.search_memory_semantic(
        root=_get_workspace(),
        query_embedding=q_emb,
        keywords=memory._extract_keywords(query) or None,
        limit=limit,
    )
    return {
        "results": [
            {
                "id": r.get("id"),
                "content": r.get("content"),
                "type": r.get("type"),
                "importance": r.get("importance"),
                "created_at": r.get("created_at"),
            }
            for r in rows
        ],
        "backend": "semantic" if q_emb else "keyword",
    }


@mcp.tool()
def memory_add(
    content: str,
    type: str = "fact",
    scope: str = "workspace",
    importance: float = 0.5,
    tags: Optional[list[str]] = None,
) -> dict:
    """写入一条记忆，落盘到本地 SQLite。

    Args:
        content: 记忆内容主体。
        type: fact / preference / context / procedure，默认 fact。
        scope: workspace / project / session，默认 workspace。
        importance: 0-1 的重要度评分，影响召回优先级。
        tags: 可选标签列表。
    """
    content = (content or "").strip()
    if not content:
        return {"error": "content 不能为空"}
    memory = get_memory_layer()
    mem = Memory(
        content=content,
        mem_type=type or MemoryType.FACT,
        scope=scope or MemoryScope.WORKSPACE,
        importance=float(importance if importance is not None else 0.5),
        tags=[str(t) for t in (tags or [])],
        session_id="mcp",
        root_dir=_get_workspace(),
    )
    result = memory.store(mem)
    return {
        "ok": result.ok,
        "id": result.value if result.ok else None,
        "error": None if result.ok else result.error,
    }


@mcp.tool()
def memory_list(limit: int = 20, offset: int = 0) -> dict:
    """列出当前工作区的所有记忆，按 importance 排序。

    Args:
        limit: 单页条数，默认 20。
        offset: 偏移，用于分页。
    """
    limit = max(1, int(limit or 20))
    offset = max(0, int(offset or 0))
    storage = get_storage()
    rows = storage.search_memory_semantic(
        root=_get_workspace(),
        query_embedding=None,
        keywords=None,
        limit=limit + offset,
    )
    slice_ = rows[offset:offset + limit]
    return {
        "items": [
            {
                "id": r.get("id"),
                "content": (r.get("content") or "")[:200],
                "type": r.get("type"),
                "importance": r.get("importance"),
            }
            for r in slice_
        ],
        "total_returned": len(slice_),
    }


@mcp.tool()
def rules_list() -> dict:
    """读取用户可编辑的规则库（.ovolve/rules/*.md）。让别的 Agent 也能看到项目约定。"""
    return get_rule_engine(_get_workspace()).snapshot()


# ── 入口 ───────────────────────────────────────────────────────────────────

def main() -> None:
    """默认 stdio 传输 —— MCP 客户端标配。"""
    _log(f"{SERVER_NAME} v{SERVER_VERSION} 启动，工作区 = {_get_workspace()}")
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()


# ── 兼容旧测试的薄封装 ─────────────────────────────────────────────────────
#
# 之前的手写版对外暴露了 ``TOOLS`` 字典和 ``handle_request`` 纯函数以便离线
# 单测。切到官方 SDK 后协议由 SDK 内部驱动，但工具处理器本身就是普通函数 ——
# 用一个 ``TOOLS`` 视图把它们串起来，让原有的单测能沿用同样的调用形状。

TOOLS: dict[str, dict[str, Any]] = {
    "memory_search": {
        "description": memory_search.__doc__.split("\n")[0] if memory_search.__doc__ else "",
        "handler": lambda args: memory_search(**args),
    },
    "memory_add": {
        "description": memory_add.__doc__.split("\n")[0] if memory_add.__doc__ else "",
        "handler": lambda args: memory_add(**args),
    },
    "memory_list": {
        "description": memory_list.__doc__.split("\n")[0] if memory_list.__doc__ else "",
        "handler": lambda args: memory_list(**args),
    },
    "rules_list": {
        "description": rules_list.__doc__.split("\n")[0] if rules_list.__doc__ else "",
        "handler": lambda _args: rules_list(),
    },
}
