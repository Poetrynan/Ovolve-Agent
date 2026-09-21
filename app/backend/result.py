"""
result.py — Result<T,E> 纪律（Pi 工程范式核心）

所有 I/O 边界（文件/Shell/MCP/网络）统一返回 Result，绝不抛异常。
错误成为一等公民，调用方用 `if not r.ok:` 走降级/报告，不 try/except。


"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Generic, Optional, TypeVar

T = TypeVar("T")


@dataclass
class Result(Generic[T]):
    """统一返回类型：成功带 value，失败带 error。

    用法:
        r = read_file(path)
        if not r.ok:
            return r  # 传递错误
        data = r.value  # 安全使用
    """

    ok: bool
    value: Optional[T] = None
    error: str = ""
    # 可选元数据：耗时、来源、审计标记等
    meta: dict = field(default_factory=dict)

    # ---- 便捷构造 ----

    @staticmethod
    def success(value: Any, meta: Optional[dict] = None, **kwargs) -> "Result":
        merged = dict(meta or {})
        merged.update(kwargs)
        return Result(ok=True, value=value, meta=merged)

    @staticmethod
    def failure(error: str, meta: Optional[dict] = None, **kwargs) -> "Result":
        merged = dict(meta or {})
        merged.update(kwargs)
        return Result(ok=False, error=error, meta=merged)

    # ---- 函数式操作（链式）----

    def map(self, fn: Callable[[Any], Any]) -> "Result":
        """成功时对 value 做变换，失败时透传。"""
        if self.ok:
            return Result.success(fn(self.value), **self.meta)
        return self

    def and_then(self, fn: Callable[[Any], "Result"]) -> "Result":
        """成功时调用 fn(value) 得到新 Result（flatMap），失败时透传。"""
        if self.ok:
            return fn(self.value)
        return self

    def or_else(self, default: Any) -> Any:
        """成功返回 value，失败返回 default。"""
        return self.value if self.ok else default

    def unwrap_or_raise(self) -> Any:
        """成功返回 value，失败抛 RuntimeError（仅用于确实不该失败的地方）。"""
        if not self.ok:
            raise RuntimeError(f"Result.unwrap failed: {self.error}")
        return self.value

    def __bool__(self) -> bool:
        return self.ok

    def __repr__(self) -> str:
        if self.ok:
            return f"Result(ok=True, value={self.value!r})"
        return f"Result(ok=False, error={self.error!r})"


def try_result(fn: Callable[[], Any], *args, **kwargs) -> Result:
    """把可能抛异常的函数包成 Result。

    用法:
        r = try_result(lambda: open(path).read())
    """
    try:
        return Result.success(fn(*args, **kwargs))
    except Exception as e:
        return Result.failure(str(e))
