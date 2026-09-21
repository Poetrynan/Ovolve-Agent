"""Phase 11/12 切片：golden task 录制与确定性回放、迁移前自动备份。"""
import json
import os

import pytest
import sqlite3

from eval_harness import check_golden, record_golden
from storage import Storage
from canary import canary_gate
from eval_harness import record_golden


def seed_stream(st, sid="sess-gold"):
    """造一条有真实形状的事件流：会话 → 消息 → 工具完成。"""
    st.create_session(sid, "golden")
    st.add_message(sid, "user", "把 README 标题改成 Ovolve")
    st.add_message(sid, "assistant", "已修改并验证。")


def test_golden_record_and_replay_roundtrip(tmp_path):
    db_dir = str(tmp_path / "db")
    st = Storage(db_dir=db_dir)
    try:
        seed_stream(st)
        path = record_golden(st, "sess-gold", name="readme-edit",
                             out_dir=str(tmp_path / "golden"))
        assert path.endswith("readme-edit.golden.json")
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        assert len(raw["events"]) >= 3, "基线必须抓到完整事件流"

        report = check_golden(path, st)
        assert report.chain_valid, "链校验必须通过"
        assert report.replay_ok, "未漂移的流必须回放一致"
        assert report.problems == []
    finally:
        st.close()


def test_golden_detects_drift_and_vanish(tmp_path):
    db_dir = str(tmp_path / "db")
    st = Storage(db_dir=db_dir)
    try:
        seed_stream(st)
        path = record_golden(st, "sess-gold", name="drift",
                             out_dir=str(tmp_path / "golden"))
    finally:
        st.close()

    # 篡改现库：把一条消息的 payload 改掉（绕过 EventStore，模拟外部损坏）
    conn = sqlite3.connect(str(tmp_path / "db" / "events.db"))
    conn.execute("UPDATE agent_events SET payload = ? WHERE seq = "
                 "(SELECT MIN(seq) FROM agent_events)", ('{"tampered": true}',))
    conn.commit()
    conn.close()

    st2 = Storage(db_dir=db_dir)
    try:
        report = check_golden(path, st2)
        assert not report.replay_ok, "载荷漂移必须被回放发现"
        assert any("drifted" in p or "vanished" in p for p in report.problems)
    finally:
        st2.close()


# ── Phase 11 收口：canary 门禁（fail-closed）────────────────────────────────

def test_canary_gate(tmp_path):
    from canary import canary_gate
    db_dir = str(tmp_path / "db")
    st = Storage(db_dir=db_dir)
    try:
        seed_stream(st)
        empty_dir = str(tmp_path / "none")
        allow, summary = canary_gate(st, golden_dir=empty_dir)
        assert not allow and "no golden" in summary["reason"], \
            "没有基线时门必须关着——'没证据'不等于'没回归'"

        gd = str(tmp_path / "golden")
        record_golden(st, "sess-gold", name="good", out_dir=gd)
        allow2, s2 = canary_gate(st, golden_dir=gd)
        assert allow2 and s2["passed"] == 1

        # 一条基线漂移 → 整道门关上
        import sqlite3
        conn = sqlite3.connect(str(tmp_path / "db" / "events.db"))
        conn.execute("UPDATE agent_events SET payload=? WHERE seq="
                     "(SELECT MIN(seq) FROM agent_events)", ('{"x":1}',))
        conn.commit()
        conn.close()
        allow3, s3 = canary_gate(st, golden_dir=gd)
        assert not allow3 and s3["failed"] == ["good"]
    finally:
        st.close()


# ── Phase 11 扩充：确定性回放 + 常驻合成基线 ────────────────────────────────

def test_replay_golden_roundtrip(tmp_path):
    from event_store import EventStore
    from eval_harness import replay_golden
    db_dir = str(tmp_path / "db")
    st = Storage(db_dir=db_dir)
    try:
        seed_stream(st)
        path = record_golden(st, "sess-gold", name="rt",
                             out_dir=str(tmp_path / "golden"))
        # 重放进一个全新的隔离 store
        store = EventStore(db_path=str(tmp_path / "replay" / "events.db"))
        report = replay_golden(path, store)
        assert report.replay_ok and report.chain_valid, report.problems
        assert report.event_count == len(st.get_event_store().read_stream("sess-gold"))
    finally:
        st.close()


def test_committed_synthetic_fixture_always_replays(tmp_path):
    """仓库里的常驻合成基线必须永远能重放通过——它坏了说明事件层语义漂移，
    canary 门禁就该拦。"""
    import os as _os
    from event_store import EventStore
    from eval_harness import GOLDEN_DIR, replay_golden

    path = os.path.join(GOLDEN_DIR, "synthetic-demo.golden.json")
    if not _os.path.isfile(path):
        pytest.skip("合成基线尚未生成")
    store = EventStore(db_path=str(tmp_path / "events.db"))
    report = replay_golden(path, store)
    assert report.replay_ok and report.chain_valid, report.problems


# ── Phase 11 收口补充：基线自身篡改检测 ─────────────────────────────────────

def test_baseline_tamper_blocks_replay(tmp_path):
    """改过 payload 的基线必须被离线链自证拦下。

    回放比对对"基线自身被篡改"是盲的——拿篡改数据重放，和篡改数据比当然
    一致。所以回放之前先按 EventStore 同款级联公式重算每条 chain_hash。
    """
    from event_store import EventStore
    from eval_harness import GOLDEN_DIR, replay_golden, record_golden

    db_dir = str(tmp_path / "db")
    st = Storage(db_dir=db_dir)
    try:
        seed_stream(st)
        path = record_golden(st, "sess-gold", name="tamper",
                             out_dir=str(tmp_path / "golden"))
    finally:
        st.close()

    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    # 基线必须带时间戳与链哈希——否则离线自证无从谈起
    assert all("timestamp" in e and e["chain_hash"] for e in raw["events"])
    raw["events"][1]["payload"]["__tampered__"] = True
    bad = tmp_path / "golden" / "tampered.golden.json"
    bad.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    store = EventStore(db_path=str(tmp_path / "replay" / "events.db"))
    report = replay_golden(str(bad), store)
    assert not report.replay_ok and not report.chain_valid
    assert any("tampered" in p for p in report.problems), report.problems

    # 未动过的原件照常全绿——门禁只拦篡改，不误伤诚实基线
    ok_report = replay_golden(path, EventStore(
        db_path=str(tmp_path / "replay2" / "events.db")))
    assert ok_report.replay_ok and ok_report.chain_valid


def test_every_committed_golden_has_a_valid_chain(tmp_path):
    """仓库里每条常驻基线的链都必须能离线自证。

    补的是一个实打实的覆盖缺口：`test_canary_gate` 只用 tmp_path 里临时录的
    基线，从没对真实提交的 GOLDEN_DIR 跑过；而
    `test_committed_synthetic_fixture_always_replays` 只盯 synthetic-demo 一条。
    结果另外三条基线坏了也无人知晓——cd580729 那次 产品改名
    就是这么同时踩了 demo 和 chat 两个文件，chat 那条静默坏了很久。

    只断言 chain_valid 而不是 replay_ok：链自证是"基线有没有被手改过"的
    判据，回放比对还牵扯生成期确定性，混进来会让这条守卫变得难以归因。
    """
    from event_store import EventStore
    from eval_harness import GOLDEN_DIR, list_golden, replay_golden

    names = list_golden(GOLDEN_DIR)
    assert names, "一条常驻基线都没有——canary 没有证据，等于没有门禁"

    broken = {}
    for i, name in enumerate(names):
        store = EventStore(db_path=str(tmp_path / f"db{i}" / "events.db"))
        try:
            report = replay_golden(os.path.join(GOLDEN_DIR, name), store)
        finally:
            store.close()
        if not report.chain_valid:
            broken[name] = report.problems

    assert not broken, (
        "以下常驻基线的链哈希与内容对不上（多半是改了 payload 没重算哈希；"
        f"链式哈希是级联的，改一条要把后续一起重算）：{broken}")
