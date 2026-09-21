"""
path_lock.py — 按路径的进程级写锁。

## 为什么需要它

并行子代理共享同一个 workspace（`subagent_runtime.spawn_batch` 把同一个
`parent_ctx` 传给每个 `spawn_one`，所以 `workspace_root` 是同一个字符串），
而 `coder` 人格继承完整工具目录、有写权限。父代理的 `_is_parallel_safe` 白名单
只管**单个 Router 单个 step 内**的工具批处理，管不到"两个 Router 同时跑"这一层。

于是这个组合是可能的：两个 coder 子代理同时对同一个文件做 read-modify-write。
`_edit_file_impl` 的形状正是 read → replace → write 三步非原子操作，两个并发
执行会让后写的那个把先写的改动整片覆盖掉——而且**两边都会报成功**，没有任何
一环会告诉用户丢了改动。

`asyncio.Semaphore` 挡不住这个：它限制的是并发**数量**，不是同一资源的互斥。

## 为什么用 threading.Lock 而不是 asyncio.Lock

`ToolRegistry.dispatch` 现在把同步工具丢进 `asyncio.to_thread` 执行（见
tools.py 的超时改造），所以这些 `_*_impl` 跑在**工作线程**里，不在事件循环上。
线程里 `await` 不了 asyncio 原语，只有 `threading.Lock` 是对的。

## 粒度

锁按 `os.path.abspath` 规范化后的路径分配，所以：
- 改不同文件的子代理完全不互相阻塞（这是常态，不该付代价）；
- 改同一文件的会排队，后到的看到的是前一个写完的内容。

多路径操作（move/copy 涉及 src+dst）按**排序后**的顺序依次获取，避免两个方向
相反的 move 互相死等。
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Iterable


class PathLockRegistry:
    """路径 → 锁 的映射。锁本身永不回收。

    不回收是刻意的：一个 workspace 里被反复写的文件是有限集合，
    留着几百个 `threading.Lock` 对象（每个几十字节）比实现引用计数回收
    要安全得多——回收逻辑写错会导致两个线程拿到不同的锁对象，那就等于没锁。
    """

    def __init__(self) -> None:
        self._locks: dict[str, threading.Lock] = {}
        # 保护 _locks 本身的字典操作。持有时间极短（只做一次 setdefault），
        # 不会成为瓶颈。
        self._guard = threading.Lock()

    @staticmethod
    def _key(path: str) -> str:
        """规范化路径，让 './a.txt' 和绝对路径拿到同一把锁。

        Windows 上大小写不敏感，所以一并 casefold —— 否则 'A.TXT' 和 'a.txt'
        会拿到两把锁，锁了等于没锁。
        """
        norm = os.path.normcase(os.path.abspath(path or ""))
        return norm

    def lock_for(self, path: str) -> threading.Lock:
        key = self._key(path)
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    @contextmanager
    def hold(self, *paths: str):
        """按路径顺序获取一组锁，退出时逆序释放。

        排序是死锁预防：如果 A 线程按 (x, y) 的顺序拿、B 线程按 (y, x) 拿，
        两边各持一半就永久互等。全局统一按 key 排序后获取，这个环就不可能形成。
        """
        keys = sorted({self._key(p) for p in paths if p})
        acquired: list[threading.Lock] = []
        try:
            for k in keys:
                with self._guard:
                    lock = self._locks.setdefault(k, threading.Lock())
                lock.acquire()
                acquired.append(lock)
            yield
        finally:
            for lock in reversed(acquired):
                try:
                    lock.release()
                except RuntimeError:
                    pass  # 不该发生；释放失败也不能掩盖 body 里的真实异常

    def tracked(self) -> int:
        """当前分配了多少把锁 —— 诊断/自测用。"""
        with self._guard:
            return len(self._locks)


_registry: PathLockRegistry | None = None


def get_path_locks() -> PathLockRegistry:
    """进程内共享的锁注册表。

    必须是单例：两个注册表就是两套锁，同一个文件在不同表里拿到不同锁对象，
    互斥就失效了。
    """
    global _registry
    if _registry is None:
        _registry = PathLockRegistry()
    return _registry


@contextmanager
def write_lock(*paths: str):
    """便捷入口：``with write_lock(path): ...``"""
    with get_path_locks().hold(*paths):
        yield
