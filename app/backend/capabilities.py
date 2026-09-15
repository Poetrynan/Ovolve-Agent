"""
capabilities.py — Capability Seam（Phase 6 首切片）。

总指令 §11：不为插件化把代码拆成空接口，而是给既有 registries 一层边界清晰
的 Protocol。本模块只做三件事：

1. 八类 Provider 的最小协议（runtime_checkable，结构化鸭子类型）；
2. ProviderRegistry：注册 / 查询 / **卸载撤销**，每个条目带 permissions 元数据；
3. 加载隔离：单个 provider 注册失败不影响其它，失败原因如实上报。

插件、MCP、内置模块都走同一个 seam——绕过 seam 的能力注册在 review 里视为
安全回归。
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional, Protocol, runtime_checkable

from result import Result


# ── 八类 Provider 协议（最小面：能被现有 registries 直接满足）───────────────

@runtime_checkable
class ToolProvider(Protocol):
    name: str
    def tools(self) -> list: ...
    def dispatch(self, name: str, args: dict, ctx: dict): ...


@runtime_checkable
class ModelProvider(Protocol):
    name: str
    def complete(self, messages: list, **kw): ...


@runtime_checkable
class MemoryProvider(Protocol):
    name: str
    def retrieve(self, query: str, limit: int = 5) -> list: ...


@runtime_checkable
class ExecutionProvider(Protocol):
    name: str
    def prepare(self, ctx: dict): ...
    def teardown(self, handle: Any) -> None: ...


@runtime_checkable
class SandboxProvider(Protocol):
    name: str
    def confine(self, cmd: list) -> list: ...


@runtime_checkable
class ValidatorProvider(Protocol):
    name: str
    def validators(self) -> dict: ...


@runtime_checkable
class HookProvider(Protocol):
    name: str
    def hooks(self) -> dict: ...      # {"pre_tool_use": [fn, ...], ...}


@runtime_checkable
class ChannelProvider(Protocol):
    name: str
    def send(self, text: str, target: str) -> Result: ...


PROTOCOLS = {
    "tool": ToolProvider,
    "model": ModelProvider,
    "memory": MemoryProvider,
    "execution": ExecutionProvider,
    "sandbox": SandboxProvider,
    "validator": ValidatorProvider,
    "hook": HookProvider,
    "channel": ChannelProvider,
}


class ProviderEntry:
    __slots__ = ("kind", "name", "provider", "permissions", "source", "registered_at")

    def __init__(self, kind: str, name: str, provider: Any,
                 permissions: Dict[str, Any] | None, source: str):
        self.kind = kind
        self.name = name
        self.provider = provider
        self.permissions = permissions or {}
        self.source = source                    # builtin | plugin:<name> | mcp
        self.registered_at = time.time()

    def public(self) -> dict:
        return {
            "kind": self.kind, "name": self.name,
            "source": self.source, "permissions": self.permissions,
            "registeredAt": self.registered_at,
            # 卸载撤销的依据：来源不是 builtin 的才能被 unregister
            "revocable": self.source != "builtin",
        }


class ProviderRegistry:
    """一个进程一张注册表。卸载即撤销——disable 插件时必须调 unregister，
    否则视为绕过 seam 的残留能力。"""

    def __init__(self) -> None:
        self._entries: Dict[tuple, ProviderEntry] = {}

    def register(self, kind: str, provider: Any, *,
                 name: str = "", permissions: Dict[str, Any] | None = None,
                 source: str = "builtin") -> Result:
        proto = PROTOCOLS.get(kind)
        if proto is None:
            return Result.failure(f"unknown capability kind {kind!r}")
        pname = getattr(provider, "name", "") or name
        if not pname:
            return Result.failure("provider needs a name (attr or argument)")
        # 结构化鸭子检查：缺方法的 provider 在注册时就被拦下，而不是运行期炸
        missing = [m for m in getattr(proto, "__protocol_attrs__", ())
                   if callable(getattr(provider, m, None)) is False
                   and not hasattr(provider, m)]
        if isinstance(proto, type) and not isinstance(provider, proto):
            # runtime_checkable 只查方法存在性；缺失清单给出可读原因
            methods = [a for a in ("tools", "dispatch", "complete", "retrieve",
                                    "prepare", "teardown", "confine", "validators",
                                    "hooks", "send")
                       if a in dir(proto) and not hasattr(provider, a)]
            if methods:
                return Result.failure(
                    f"{kind} provider {pname!r} does not satisfy the protocol: "
                    f"missing {methods}")
        key = (kind, pname)
        if key in self._entries:
            prev = self._entries[key]
            if prev.source == "builtin":
                return Result.failure(f"cannot override builtin {kind}:{pname}")
            # 同名非内置：先撤销旧的（插件重载语义）
            del self._entries[key]
        self._entries[key] = ProviderEntry(kind, pname, provider, permissions, source)
        return Result.success(self._entries[key].public())

    def unregister(self, kind: str, name: str, *, actor: str = "") -> bool:
        """卸载撤销。builtin 能力不可撤销——那等于拔掉 Agent 的器官。"""
        entry = self._entries.get((kind, name))
        if entry is None:
            return False
        if entry.source == "builtin":
            return False
        del self._entries[(kind, name)]
        return True

    def get(self, kind: str, name: str) -> Optional[Any]:
        e = self._entries.get((kind, name))
        return e.provider if e else None

    def list(self, kind: str = None) -> list:
        return [e.public() for k, e in self._entries.items()
                if kind is None or e.kind == kind]

    def revoke_source(self, source: str) -> int:
        """插件禁用/移除时一次性撤销其全部贡献。返回撤销数量。"""
        keys = [k for k, e in self._entries.items() if e.source == source]
        for k in keys:
            del self._entries[k]
        return len(keys)


_registry: ProviderRegistry | None = None


def get_provider_registry() -> ProviderRegistry:
    global _registry
    if _registry is None:
        _registry = ProviderRegistry()
    return _registry


def reset_provider_registry() -> None:
    global _registry
    _registry = None
