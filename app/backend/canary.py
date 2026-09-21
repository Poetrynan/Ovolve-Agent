"""
canary.py — 金丝雀门禁（Phase 11 收口切片）。

总指令 §11(Phase 11)：改动先离线 replay，通过基线才可 canary；回归自动阻止。
本模块把 eval_harness 的 golden 套件变成一道**门**：

    from canary import canary_gate
    allow, summary = canary_gate(storage)
    if not allow: ...   # 回归未过，自动阻止进入下一阶段/发布

零 golden 基线时门是关着的（fail-closed）——没有基线就没有"没回归"可言。
"""
from __future__ import annotations

import os

from typing import Any, Dict

from eval_harness import GOLDEN_DIR, check_golden, list_golden


def _resolve_dir(golden_dir: str = None) -> str:
    """None → 内置基线目录的绝对路径。

    list_golden 返回的是裸文件名；调用方拿它拼路径时若不先解析目录，
    就会拼出相对 CWD 的路径——从仓库根跑 CI 时四条基线全部"找不到文件"，
    门禁虽然 fail-closed 但永远放不过任何发布。
    """
    return os.path.abspath(golden_dir or GOLDEN_DIR)


def run_canary_suite(golden_dir: str = None, storage=None) -> Dict[str, Any]:
    """跑全部 golden 基线。返回逐任务结果与汇总。"""
    d = _resolve_dir(golden_dir)
    files = list_golden(d)
    tasks = []
    for f in files:
        path = os.path.join(d, f)
        try:
            report = check_golden(path, storage)
            tasks.append({
                "task": f.replace(".golden.json", ""),
                "chain_valid": report.chain_valid,
                "replay_ok": report.replay_ok,
                "events": report.event_count,
                "problems": report.problems,
            })
        except Exception as e:  # noqa: BLE001
            tasks.append({"task": f, "chain_valid": False, "replay_ok": False,
                          "problems": [f"harness error: {e}"]})
    passed = sum(1 for t in tasks
                 if t["chain_valid"] and t["replay_ok"])
    return {
        "tasks": len(tasks), "passed": passed,
        "failed": [t["task"] for t in tasks
                   if not (t["chain_valid"] and t["replay_ok"])],
        "results": tasks,
    }


def canary_gate(storage, *, golden_dir: str = None,
                min_pass_ratio: float = 1.0) -> tuple[bool, Dict[str, Any]]:
    """门禁：全绿（或达到比例）才放行。

    fail-closed 语义：
    * 没有任何基线 → 不放行（"没有证据"不等于"没有回归"）；
    * 任一基线链校验失败或回放漂移 → 不放行。
    """
    suite = run_canary_suite(golden_dir, storage)
    if suite["tasks"] == 0:
        return False, {**suite, "reason": "no golden baselines —— 门禁 fail-closed"}
    ratio = suite["passed"] / suite["tasks"]
    allow = ratio >= min_pass_ratio
    summary = {**suite, "pass_ratio": round(ratio, 3),
               "reason": "" if allow else
               f"canary 未达标：{len(suite['failed'])} 条基线漂移/损坏"}
    return allow, summary


def canary_replay_gate(golden_dir: str = None,
                       min_pass_ratio: float = 1.0) -> tuple[bool, Dict[str, Any]]:
    """**回放式**门禁：不依赖运行实例——把每条基线重放进隔离临时 store。

    CI / 发布流水线友好：机器上无需真实用户数据库。fail-closed 语义同上。
    """
    from eval_harness import replay_golden

    d = _resolve_dir(golden_dir)
    files = list_golden(d)
    if not files:
        return False, {"tasks": 0, "passed": 0, "failed": [],
                       "reason": "no golden baselines —— 门禁 fail-closed"}
    import tempfile
    from event_store import EventStore
    results, failed = [], []
    for f in files:
        path = os.path.join(d, f)
        store = EventStore(
            db_path=os.path.join(tempfile.mkdtemp(prefix="canary-"), "events.db"))
        try:
            report = replay_golden(path, store)
            ok = report.replay_ok and report.chain_valid
        except Exception as e:  # noqa: BLE001
            ok, report = False, None
            results.append({"task": f, "harness_error": str(e)[:200]})
            failed.append(f)
            continue
        results.append({"task": f, "replay_ok": ok,
                        "events": report.event_count,
                        "problems": report.problems})
        if not ok:
            failed.append(f)
    passed = len(files) - len(failed)
    ratio = passed / len(files)
    allow = ratio >= min_pass_ratio and not failed
    return allow, {"tasks": len(files), "passed": passed,
                   "failed": failed, "pass_ratio": round(ratio, 3),
                   "reason": "" if allow else "canary replay 未达标",
                   "results": results}
