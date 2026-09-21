"""
eval_harness.py — golden tasks / deterministic replay（Phase 11 首切片）。

总指令 §11(Phase 11) 与 §22-15：golden task 有稳定基线；回放能定位差异；
自进化提案必须经过 replay。确定性回放的根基是：**状态由事件流重建，回放
绝不触发真实副作用工具**。

用法：
    from eval_harness import record_golden, check_golden
    path = record_golden(storage, session_id)          # 把一条真实流定格成基线
    report = check_golden(path, storage)               # 之后随时核对是否漂移

check 做两层验证：
  1. chain_valid —— 基线里的链哈希仍然成立（事件被篡改/删除会暴露）；
  2. replay_ok   —— 按 seq 重放投影计数与基线一致（投影逻辑变了会暴露）。
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, asdict
from typing import Any, Dict, List


GOLDEN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "..", "tests", "golden")


@dataclass
class GoldenReport:
    session_id: str
    chain_valid: bool
    replay_ok: bool
    event_count: int
    problems: List[str]

    def to_dict(self) -> dict:
        return asdict(self)


def record_golden(storage, session_id: str, *, name: str = "",
                  out_dir: str = None) -> str:
    """把一个会话的事件流定格为 golden 基线文件，返回文件路径。"""
    events = storage.get_event_store().read_stream(session_id)
    payload = {
        "session_id": session_id,
        "recorded_at": time.time(),
        "events": [
            {
                "seq": e.seq, "event_type": e.event_type,
                "payload": e.payload, "chain_hash": e.chain_hash,
                # 时间戳是链哈希的原材料——没有它基线无法自证未被篡改。
                "timestamp": e.timestamp,
            } for e in events
        ],
    }
    out_dir = out_dir or GOLDEN_DIR
    os.makedirs(out_dir, exist_ok=True)
    fname = f"{name or session_id}.golden.json"
    path = os.path.join(out_dir, fname)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    return path


def check_golden(path: str, storage) -> GoldenReport:
    """对照基线核验当前库里的同一条流。"""
    with open(path, "r", encoding="utf-8") as fh:
        golden = json.load(fh)
    sid = golden["session_id"]
    baseline = {e["seq"]: e for e in golden["events"]}
    problems: List[str] = []

    # 1) 现库的链校验（EventStore 自带的 SHA-256 全链验证）
    try:
        verdict = storage.get_event_store().verify_chain(sid)
        chain_valid = bool(verdict.get("valid", False)) if isinstance(verdict, dict) else bool(verdict)
    except Exception as e:
        chain_valid = False
        problems.append(f"verify_chain error: {e}")

    # 2) 与基线逐条比对：类型与载荷必须逐字一致（确定性投影的前提）
    current = storage.get_event_store().read_stream(sid)
    cur_by_seq = {e.seq: {"seq": e.seq, "event_type": e.event_type,
                          "payload": e.payload, "chain_hash": e.chain_hash}
                  for e in current}
    for seq, base in baseline.items():
        cur = cur_by_seq.get(seq)
        if cur is None:
            problems.append(f"seq {seq} vanished")
            continue
        if cur["event_type"] != base["event_type"]:
            problems.append(f"seq {seq} type drifted: "
                            f"{base['event_type']} → {cur['event_type']}")
        elif json.dumps(cur["payload"], sort_keys=True, ensure_ascii=False) != \
             json.dumps(base["payload"], sort_keys=True, ensure_ascii=False):
            problems.append(f"seq {seq} payload drifted")
        elif cur["chain_hash"] and base["chain_hash"] and \
                cur["chain_hash"] != base["chain_hash"]:
            problems.append(f"seq {seq} chain hash changed")

    replay_ok = not any("drifted" in p or "vanished" in p for p in problems)
    return GoldenReport(
        session_id=sid, chain_valid=chain_valid, replay_ok=replay_ok,
        event_count=len(cur_by_seq), problems=problems,
    )


# ── 确定性回放与合成基线（Phase 11 扩充）────────────────────────────────────

def _compare_baseline(baseline_events: list, store, sid: str) -> tuple[bool, List[str], int]:
    """把 store 里的流与基线逐 seq 比对（类型+载荷）。返回 (replay_ok, problems, n)。"""
    problems: List[str] = []
    current = store.read_stream(sid)
    cur_by_seq = {e.seq: {"event_type": e.event_type, "payload": e.payload}
                  for e in current}
    for base in baseline_events:
        seq = base["seq"]
        cur = cur_by_seq.get(seq)
        if cur is None:
            problems.append(f"seq {seq} vanished")
            continue
        if cur["event_type"] != base["event_type"]:
            problems.append(f"seq {seq} type drifted: "
                            f"{base['event_type']} → {cur['event_type']}")
        elif json.dumps(cur["payload"], sort_keys=True, ensure_ascii=False) != \
             json.dumps(base["payload"], sort_keys=True, ensure_ascii=False):
            problems.append(f"seq {seq} payload drifted")
    return (not problems), problems, len(cur_by_seq)


def _baseline_chain_problems(golden: dict) -> List[str]:
    """离线核验基线文件**自身**的链完整性（篡改检测）。

    基线里每条事件带着它入链时的 chain_hash。用与 EventStore 相同的级联
    公式从 (prev|sid|type|ts|payload) 重算比对：被改过 payload/类型/顺序的
    基线在这里现形。这一步不可省——回放比对对"基线自身被篡改"是盲的：
    拿篡改后的数据重放，和篡改后的数据比当然一致。

    旧格式（无 timestamp）无法离线重算，跳过自证、只做回放比对；
    新录制与合成基线一律带 timestamp。
    """
    import hashlib
    events = golden.get("events") or []
    if not events or any("timestamp" not in e for e in events):
        return []   # legacy 基线：没有原材料，谈不上重算
    sid = str(golden.get("session_id") or "")
    prev = hashlib.sha256(f"genesis:{sid}".encode("utf-8")).hexdigest()
    problems: List[str] = []
    for e in events:
        canonical = json.dumps(e.get("payload") or {},
                               sort_keys=True, ensure_ascii=False)
        seed = f"{prev}|{sid}|{e.get('event_type')}|{e.get('timestamp')}|{canonical}"
        calc = hashlib.sha256(seed.encode("utf-8")).hexdigest()
        recorded = str(e.get("chain_hash") or "")
        if not recorded:
            problems.append(f"seq {e.get('seq')} baseline carries no chain hash")
        elif calc != recorded:
            problems.append(
                f"seq {e.get('seq')} baseline tampered: chain hash mismatch "
                f"(expected {calc[:12]}…, recorded {recorded[:12]}…)")
        # 断点之后用"已记录值"继续推——一次篡改报一条，而不是雪崩成 N 条
        prev = recorded or calc
    return problems


def replay_golden(path: str, store) -> GoldenReport:
    """把基线事件按序重放进一个**全新**的 store，再逐条比对。

    确定性回放的纪律：只写事件、不触发任何真实副作用工具。重放流的链哈希
    因时间戳不同必然与基线不同——所以校验的是重放流自身的链完整性 + 类型/
    载荷逐条一致。重放之前先做基线自身的链自证（篡改检测）：门禁要拦的
    不只是"代码漂移"，还有"有人动了基线"。
    """
    with open(path, "r", encoding="utf-8") as fh:
        golden = json.load(fh)
    sid = golden["session_id"]
    tamper = _baseline_chain_problems(golden)
    if tamper:
        return GoldenReport(session_id=sid, chain_valid=False,
                            replay_ok=False, event_count=0,
                            problems=tamper)
    try:
        for e in golden["events"]:
            store.append(sid, e["event_type"], e["payload"])
    except Exception as e:  # noqa: BLE001
        return GoldenReport(session_id=sid, chain_valid=False, replay_ok=False,
                            event_count=0, problems=[f"append failed: {e}"])
    verdict = store.verify_chain(sid)
    chain_valid = bool(verdict.get("valid", False)) if isinstance(verdict, dict) else bool(verdict)
    replay_ok, problems, n = _compare_baseline(golden["events"], store, sid)
    return GoldenReport(session_id=sid, chain_valid=chain_valid,
                        replay_ok=replay_ok and chain_valid,
                        event_count=n, problems=problems)


def build_synthetic_golden(out_path: str, scenario: str = "chat") -> str:
    """生成合成演示流基线——canary 门禁的常驻口粮。

    合成而非录制真实会话是刻意的：golden 基线会进仓库，真实对话属于用户隐私。
    scenario 覆盖三大事件族：
      chat  —— 会话 + 用户消息 + 工具执行 + 回合完成（默认）
      goal  —— 回合推进 + 系统检查点（Goal resume 流族）
      skill —— 技能生命周期 + 经验入账 + 记忆抽取（学习环流族）
    """
    import tempfile
    from event_store import EventStore

    flows = {
        "chat": [
            ("session.created", {"title": "合成基线演示"}),
            ("user.message_submitted", {"text": "把 README 标题改成 Ovolve"}),
            ("tool.execution_started",
             {"tool": "write_file", "args": {"path": "README.md"}}),
            ("tool.execution_completed",
             {"tool": "write_file", "ok": True, "chars": 128}),
            ("agent.turn_completed", {"ok": True}),
        ],
        "goal": [
            ("session.created", {"title": "合成目标流"}),
            ("agent.turn_started", {"turn": 1}),
            ("tool.execution_started",
             {"tool": "run_shell", "args": {"cmd": "pytest -q"}}),
            ("tool.execution_completed", {"tool": "run_shell", "ok": True}),
            ("agent.turn_completed", {"ok": True}),
            ("system.checkpoint_created",
             {"turn_state": "completed", "scope": "synthetic"}),
            ("system.recovery_initiated", {"reason": "synthetic drill"}),
        ],
        "skill": [
            ("skill.started", {"skill_id": "demo-skill",
                               "selection_reason": "trigger_match(score=3)"}),
            ("tool.execution_started", {"tool": "read_file", "args": {}}),
            ("tool.execution_completed", {"tool": "read_file", "ok": True}),
            ("skill.completed", {"skill_id": "demo-skill"}),
            ("skill.experience_recorded",
             {"experience_id": "exp-synth-1", "outcome": "success"}),
            ("memory.extracted", {"facts": ["演示用事实一条"],
                                  "count": 1}),
        ],
    }
    if scenario not in flows:
        raise ValueError(f"unknown scenario {scenario!r}; "
                         f"expected one of {sorted(flows)}")

    db = os.path.join(tempfile.mkdtemp(prefix="golden-src-"), "events.db")
    store = EventStore(db_path=db)
    sid = f"synthetic-{scenario}"
    try:
        for etype, payload in flows[scenario]:
            store.append(sid, etype, payload)
        events = [{"seq": e.seq, "event_type": e.event_type,
                   "payload": e.payload, "timestamp": e.timestamp,
                   "chain_hash": e.chain_hash}
                  for e in store.read_stream(sid)]
    finally:
        store.close()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"session_id": sid, "recorded_at": time.time(),
                   "synthetic": True, "scenario": scenario, "events": events},
                  fh, ensure_ascii=False, indent=1)
    return out_path


def main(argv=None) -> int:
    import argparse
    import tempfile
    from event_store import EventStore

    p = argparse.ArgumentParser(prog="eval_harness",
                                description="golden 基线 录制 / 回放 / 清单")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record", help="把一个会话的事件流定格为基线")
    r.add_argument("session_id")
    r.add_argument("--name", default="")
    r.add_argument("--out", default=GOLDEN_DIR)
    rp = sub.add_parser("replay", help="把基线重放进全新 store 并比对")
    rp.add_argument("path")
    sub.add_parser("list", help="列出已有基线")
    args = p.parse_args(argv)

    if args.cmd == "list":
        for f in list_golden(GOLDEN_DIR):
            print(f)
        return 0
    if args.cmd == "record":
        from storage import get_storage
        path = record_golden(get_storage(), args.session_id,
                             name=args.name, out_dir=args.out)
        print(path)
        return 0
    if args.cmd == "replay":
        db = os.path.join(tempfile.mkdtemp(prefix="golden-replay-"), "events.db")
        report = replay_golden(args.path, EventStore(db_path=db))
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=1))
        return 0 if (report.replay_ok and report.chain_valid) else 1
    return 2


def list_golden(out_dir: str = None) -> List[str]:
    d = out_dir or GOLDEN_DIR
    if not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if f.endswith(".golden.json"))


if __name__ == "__main__":
    sys.exit(main())
