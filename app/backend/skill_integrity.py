"""skill_integrity.py — 技能供应链完整性锁（skills.lock）。

# 为什么需要它

已有的防线都守在**安装前**：skill_vetter 静态扫描、skill_lifecycle 四道门。
但一个技能通过审批落盘之后，SKILL.md 就只是用户盘上的一个普通文件——被
恶意软件改写、被同步盘覆盖、被手滑编辑，运行时毫无感知，而技能正文是
每回合都可能注入模型的内容，篡改它等于篡改 agent 的行为。skills.lock 补
的就是**安装后**这一段：把每个已装技能的 sha256 记下来，装载时重算比对。

# 语义（与 Handoff 2.2 的验收对齐）

- 谁会被锁：走 skill_lifecycle.approve 安装的技能（生命周期产物）。discover
  扫到的本机技能不自动上锁——用户手改自己的技能是预期行为，默认全锁会把
  每次正常编辑都变成"篡改警报"。
- 比对不符：**载入但打高优警告**（默认），不硬拒——可用性优先，警告里写
  清"预期哈希 vs 实际哈希"，UI 显式提示。用户确认是自己的修改后调用
  relock 端点重新锁定，警告消失。
- 锁文件：``<db_dir>/skills.lock``（JSON）。损坏/缺失按"无锁"处理，绝不
  因为锁文件本身的问题拦住技能加载。
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Optional

#: 单个技能目录里参与哈希的文件上限与单文件大小上限——技能是小文件集合，
#: 超过这个规模的东西不该被静默吞进哈希（也防住符号链接循环式的意外）。
_MAX_FILES_PER_SKILL = 200
_MAX_FILE_BYTES = 2_000_000

#: 跳过的文件名模式：审批快照与编辑器残渣不是技能内容。用子串匹配而不是
#: endswith——快照带时间戳后缀（SKILL.md.bak-1735...），按后缀比对会漏。
_SKIP_SUBSTRINGS = (".bak", ".tmp", ".swp")


def _lock_path() -> str:
    try:
        from user_dirs import db_dir
    except ImportError:  # pragma: no cover - packaged import shape
        from app.backend.user_dirs import db_dir
    return os.path.join(db_dir(), "skills.lock")


def _file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        # 分块读：技能正文再小也是按块的稳妥读法，8KB 对 2MB 上限足够。
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_skill_dir(skill_dir: str) -> dict:
    """对一个技能目录做完整性快照：SKILL.md + 全部附属文件的 sha256。

    返回 ``{"files": {相对路径: sha256}}``。目录不存在返回空表——调用方
    （写锁处）应把"空快照"视为错误而不是静默写一条空锁。
    """
    files: dict[str, str] = {}
    if not os.path.isdir(skill_dir):
        return {"files": files}
    count = 0
    for root, _dirs, names in os.walk(skill_dir):
        for n in sorted(names):
            if any(s in n for s in _SKIP_SUBSTRINGS):
                continue
            full = os.path.join(root, n)
            rel = os.path.relpath(full, skill_dir).replace("\\", "/")
            try:
                if os.path.getsize(full) > _MAX_FILE_BYTES:
                    continue
                files[rel] = _file_sha256(full)
            except OSError:
                continue  # 读不到的文件不进快照，也不让整个快照失败
            count += 1
            if count >= _MAX_FILES_PER_SKILL:
                return {"files": files}
    return {"files": files}


def read_lock() -> dict:
    """读锁文件。任何损坏都按"无锁"处理（返回空 dict）。"""
    try:
        with open(_lock_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_lock(data: dict) -> None:
    path = _lock_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, path)


def write_lock_entry(name: str, skill_dir: str) -> dict:
    """安装/重锁时记录一个技能的哈希基线。返回写入的条目。"""
    entry = hash_skill_dir(skill_dir)
    if not entry["files"]:
        return entry  # 空快照（目录不存在）不写锁
    entry["lockedAt"] = time.time()
    data = read_lock()
    data[name] = entry
    try:
        _write_lock(data)
    except OSError as e:
        print(f"[skills] lock write failed for '{name}': {e}")
    return entry


def remove_lock_entry(name: str) -> None:
    data = read_lock()
    if name in data:
        del data[name]
        try:
            _write_lock(data)
        except OSError as e:
            print(f"[skills] lock remove failed for '{name}': {e}")


def verify_skill_dir(name: str, skill_dir: str) -> Optional[dict]:
    """装载时校验。返回 None = 无锁记录（不评价）；否则返回核验报告。

    报告形状：``{"ok": bool, "missing": [相对路径], "changed": {路径: 现哈希}}``。
    多出来的新文件不报——附加文件不改变已审批内容的行为面，报了只会
    训练用户忽略警告。
    """
    data = read_lock()
    entry = data.get(name)
    if not isinstance(entry, dict) or not entry.get("files"):
        return None
    expected: dict = entry["files"]
    current = hash_skill_dir(skill_dir)["files"]
    missing = [rel for rel in expected if rel not in current]
    changed = {rel: current[rel] for rel in expected
               if rel in current and current[rel] != expected[rel]}
    return {"ok": not missing and not changed,
            "missing": missing, "changed": changed}
