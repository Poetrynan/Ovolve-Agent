"""user_dirs.py — Ovolve 用户数据目录的唯一真相源。

所有用户级数据落在 ``~/.ovolve``。``OVOLVE_DB_DIR`` 环境变量可覆盖数据库目录
（测试/多实例隔离用）。

所有需要用户级数据路径的模块都从这里取值，不再各自硬编码路径。
"""
from __future__ import annotations

import os
from pathlib import Path

BRAND_DIR = ".ovolve"
DB_DIR_ENV = "OVOLVE_DB_DIR"

_resolved_home: Path | None = None


def home_dir() -> Path:
    """Ovolve 用户数据根目录（``~/.ovolve``）。"""
    global _resolved_home
    if _resolved_home is not None:
        return _resolved_home
    _resolved_home = Path.home() / BRAND_DIR
    return _resolved_home


def db_dir() -> str:
    """SQLite 数据库目录。环境变量显式指定时优先。"""
    env = os.environ.get(DB_DIR_ENV)
    if env:
        return env
    return str(home_dir() / "db")
