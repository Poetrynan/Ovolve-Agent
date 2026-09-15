"""_activity_child.py — activity_exec 的子进程侧。

一个全新解释器，只做一件事：按 spec 导入模块、解析函数、以
``(args, context)`` 调用一次，把结果用 ``@@ACTIVITY_RESULT@@`` 哨兵行写到
stdout 后立即退出。任何工具自身的 print 输出都会先于哨兵行出现，父进程只认
最后一个哨兵行，所以混流无害。

崩溃（import 失败、段错误、被杀）时没有哨兵行——退出码和 stderr 就是全部
真相，父进程据此返回 effect unknown 而不是编造一个失败。
"""
from __future__ import annotations

import json
import os
import sys

# Force UTF-8 on Windows stdout/stderr to avoid GBK UnicodeEncodeError
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 让子进程能像父进程一样平铺导入 backend 模块（write_file、file_agent…）。
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

_RESULT_SENTINEL = "@@ACTIVITY_RESULT@@"


def _resolve_function(module_name: str, qualname: str):
    """module + 点分 qualname → 可调用对象。

    支持类方法形态（``Class.method``）：逐段 getattr。解析失败抛异常，由
    外层统一变成错误结果——那至少是子进程活着时的诚实失败。
    """
    import importlib
    module = importlib.import_module(module_name)
    obj = module
    for part in qualname.split("."):
        obj = getattr(obj, part)
    return obj


def _to_payload(result):
    """工具返回 Result → 协议 dict；返回裸值 → 成功协议。"""
    if hasattr(result, "ok") and hasattr(result, "error"):
        value = getattr(result, "value", None)
        error = str(getattr(result, "error", "") or "")
        ok = bool(result.ok)
    else:
        value, error, ok = result, "", True
    # default=str 是最后的兜底：value 里混进不可序列化对象时给出可读的
    # 表示，而不是让整个回传通道崩掉。
    encoded = json.dumps({"ok": ok, "value": value, "error": error},
                         ensure_ascii=False, default=str)
    if len(encoded.encode("utf-8", "replace")) > 1_000_000:
        # 结果过大时截断 value——工具层本该 truncate；这里是第二道闸。
        encoded = json.dumps(
            {"ok": ok,
             "value": f"[activity child: result too large, "
                      f"{len(encoded)} bytes truncated]",
             "error": error},
            ensure_ascii=False, default=str)
    return encoded


def main() -> int:
    if len(sys.argv) < 2:
        sys.stdout.write(_RESULT_SENTINEL + json.dumps(
            {"ok": False, "value": None, "error": "missing spec path"},
            ensure_ascii=False) + "\n")
        return 2
    spec_path = sys.argv[1]
    payload = {"ok": False, "value": None, "error": ""}
    try:
        with open(spec_path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
        fn = _resolve_function(str(spec["module"]), str(spec["qualname"]))
        result = fn(spec.get("args") or {}, spec.get("context") or {})
        body = _to_payload(result)
    except BaseException as exc:  # 系统退出也要回话，不能静默死掉
        body = json.dumps(
            {"ok": False, "value": None,
             "error": f"{type(exc).__name__}: {exc}"},
            ensure_ascii=False, default=str)
        try:
            # 尽力删掉自己的 spec，失败无所谓（临时目录兜底）。
            os.unlink(spec_path)
        except OSError:
            pass
        sys.stdout.write(_RESULT_SENTINEL + body + "\n")
        sys.stdout.flush()
        return 1
    try:
        os.unlink(spec_path)
    except OSError:
        pass
    sys.stdout.write(_RESULT_SENTINEL + body + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
