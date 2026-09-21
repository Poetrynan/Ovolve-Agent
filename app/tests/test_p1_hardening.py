"""P1 回归测试：假保护标注、迁移账本、子代理台账。

与 test_p0_hardening.py 分开：那一份钉的是「防护是否被绕过」，这一份钉的是
「系统是否对自己的能力说了真话」——一个永不触发的安全层、一张没人读写的账本，
都不会让任何功能报错，只会让人误判防护范围。

按语料组织：加规则时往语料里加行，别改断言。
"""
import pytest

import tool_policy


# ── 语料 1：SANDBOX 策略层的自述必须诚实（B10）────────────────────────────
#
# 该层在 pipeline 里注册了、会出现在审计轨迹的层列表里、代码读起来像在做约束，
# 但它的门是 `sandbox_readonly` 标志，而全仓库没有任何地方写这个标志。
# 这里钉住两件事：默认必须自述「不生效」；一旦有人声明自己会写标志，自述必须
# 立刻改口——这样未来实现沙箱的人不需要记得回来改文案。
@pytest.fixture(autouse=True)
def _isolate_sandbox_writers():
    """写者集合是模块级全局，测完必须还原，否则污染同进程其它测试。"""
    original = set(tool_policy._sandbox_flag_writers)
    yield
    tool_policy._sandbox_flag_writers.clear()
    tool_policy._sandbox_flag_writers.update(original)


def test_sandbox_layer_reports_itself_ineffective_by_default():
    s = tool_policy.sandbox_layer_status()
    assert s["registered"] is True, "层确实注册着，这一点不能瞒"
    assert s["effective"] is False, "没有任何代码设置该标志时，必须自述不生效"
    assert s["writers"] == []


def test_sandbox_status_names_the_flag_it_waits_on():
    """自述里要带上标志名，否则读者无法自己去 grep 验证。"""
    s = tool_policy.sandbox_layer_status()
    assert s["flag"] == tool_policy.SANDBOX_READONLY_FLAG == "sandbox_readonly"


def test_sandbox_note_does_not_claim_protection_while_inert():
    note = tool_policy.sandbox_layer_status()["note"]
    assert "不生效" in note
    # 必须指出真正在起作用的是哪几层，否则用户只会以为"没保护"。
    assert "path_guard" in note


def test_sandbox_status_flips_once_a_writer_declares_itself():
    tool_policy.declare_sandbox_flag_writer("sandbox.run_confined")
    s = tool_policy.sandbox_layer_status()
    assert s["effective"] is True
    assert "sandbox.run_confined" in s["writers"]
    assert "不生效" not in s["note"]


def test_declaring_a_blank_writer_does_not_flip_the_status():
    tool_policy.declare_sandbox_flag_writer("")
    assert tool_policy.sandbox_layer_status()["effective"] is False


# ── 语料 2：自进化审计计数必须与列表的 limit 脱钩（B12）────────────────────────
#
# 页面上的「已接受 / 已拒绝」原先是拿 `all_proposals(limit=50)` 的结果过滤出来的，
# 于是记录一超过 50 条，两个数字就开始越报越低，而界面上没有任何迹象说它被截断了。
# 这里钉住的是「计数走独立的 GROUP BY，不受 limit 影响」这一条，而不是某个具体数字。
def _seed(store, n_pending=0, n_accepted=0, n_rejected=0):
    """按状态灌入提案。id 必须唯一（主键），signature 无所谓。"""
    from evolution import Proposal

    i = 0
    for status, count in (("pending", n_pending),
                          ("accepted", n_accepted),
                          ("rejected", n_rejected)):
        for _ in range(count):
            i += 1
            p = Proposal(
                id=f"p{i}", signature=f"s{i}", kind="tool_failure",
                tool_name="shell_executor", target_file="AGENTS.md",
                draft=f"- rule {i}", rationale="r", hits=1,
                status="pending", created_at=float(i),
            )
            store.insert_proposal(p)
            if status != "pending":
                store.mark_decided(p.id, status, applied=(status == "accepted"))


@pytest.fixture
def store(tmp_path):
    from evolution import EvolutionStore
    return EvolutionStore(db_path=str(tmp_path / "evolution.db"))


def test_counts_are_zero_on_a_fresh_store(store):
    assert store.count_by_status() == {
        "pending": 0, "accepted": 0, "rejected": 0, "total": 0,
    }


def test_counts_match_what_was_seeded(store):
    _seed(store, n_pending=3, n_accepted=4, n_rejected=2)
    c = store.count_by_status()
    assert c == {"pending": 3, "accepted": 4, "rejected": 2, "total": 9}


def test_counts_survive_past_the_list_limit(store):
    """核心断言：列表被截断，计数不能跟着被截断。"""
    _seed(store, n_accepted=60, n_rejected=10)
    assert len(store.all_proposals(limit=50)) == 50, "列表本身确实被 limit 截断"
    c = store.count_by_status()
    assert c["accepted"] == 60, "计数必须是终身总数，不是最近 50 条里的数量"
    assert c["rejected"] == 10
    assert c["total"] == 70


def test_counts_stay_consistent_with_count_open(store):
    """两条独立的查询路径不能互相打架。"""
    _seed(store, n_pending=5, n_accepted=1)
    assert store.count_by_status()["pending"] == store.count_open() == 5


def test_engine_exposes_counts(store, tmp_path):
    """端点读的是 engine.counts()，所以引擎层也得有这条通路。"""
    from evolution import EvolutionEngine

    engine = EvolutionEngine(store=store, workspace_root=str(tmp_path))
    _seed(store, n_pending=2, n_accepted=1)
    assert engine.counts() == {
        "pending": 2, "accepted": 1, "rejected": 0, "total": 3,
    }


# ── 语料 3：子代理台账与孤儿回收（B14）──────────────────────────────────────
#
# 之前 subagent_runtime 只把运行记录放在进程内的 dict 里，而且 300s 后自动过期。
# 于是「跑过什么、怎么结束的、跑了多久」既扛不住重启，连看晚了几分钟都查不到；
# 崩溃留下的 spawning/running 记录更是永远不会有人收尾。
# 这里钉三件事：_transition 必须落盘、回收只碰别的 generation、当前进程的活记录
# 绝不能被自己的启动回收误杀。
@pytest.fixture
def ledger(tmp_path):
    """独立 db 目录的 Storage。不能用 get_storage() 单例——那会写进真实用户库。"""
    from storage import Storage
    return Storage(db_dir=str(tmp_path / "db"))


def test_upsert_creates_a_row_stamped_with_this_generation(ledger):
    import storage as storage_mod

    ledger.upsert_subagent_run(
        "sub1", parent_session_id="s1", subagent_type="Explore",
        label="扫描", status="spawning", created_at=100.0,
    )
    rows = ledger.list_subagent_runs("s1")
    assert len(rows) == 1
    assert rows[0]["status"] == "spawning"
    assert rows[0]["generation"] == storage_mod.PROCESS_GENERATION


def test_upsert_updates_in_place_and_keeps_created_at(ledger):
    """后续状态变更不能把 created_at 冲掉，否则时长统计全错。"""
    ledger.upsert_subagent_run("sub1", parent_session_id="s1",
                               status="spawning", created_at=100.0)
    ledger.upsert_subagent_run("sub1", status="running", started_at=101.0)
    ledger.upsert_subagent_run("sub1", status="completed",
                               finished_at=105.0, result_chars=42)
    rows = ledger.list_subagent_runs("s1")
    assert len(rows) == 1, "同一个 subagent_id 只能有一行"
    assert rows[0]["created_at"] == 100.0
    assert rows[0]["started_at"] == 101.0
    assert rows[0]["status"] == "completed"
    assert rows[0]["result_chars"] == 42


def test_reap_closes_out_rows_from_a_dead_generation(ledger):
    """上一个进程留下的 running 行：它的主人已经没了，必须收尾。"""
    ledger.upsert_subagent_run("dead", parent_session_id="s1", status="running",
                               created_at=1.0)
    ledger._db("sessions").execute(
        "UPDATE subagent_runs SET generation='previous-boot' WHERE subagent_id='dead'"
    )
    ledger._db("sessions").commit()

    # Phase 2 contract change: reap returns the demoted ROWS (callers print
    # len() and recovery.py mirrors each into the event ledger), not a count.
    demoted = ledger.reap_orphan_subagent_runs()
    assert len(demoted) == 1 and demoted[0]["subagent_id"] == "dead"
    row = ledger.list_subagent_runs("s1")[0]
    assert row["status"] == "killed"
    assert row["finished_at"] > 0, "终态必须有结束时间，否则时长永远算不出来"
    assert "restart" in row["error"]


def test_reap_never_touches_live_rows_from_this_generation(ledger):
    """这是回收的安全边界：本进程正在跑的子代理不能被自己的启动清理误杀。"""
    ledger.upsert_subagent_run("alive", parent_session_id="s1", status="running",
                               created_at=1.0)
    assert ledger.reap_orphan_subagent_runs() == []
    assert ledger.list_subagent_runs("s1")[0]["status"] == "running"


def test_reap_leaves_terminal_rows_alone(ledger):
    """已经结束的记录不该被改写成 killed，也不该被重新盖上结束时间。"""
    ledger.upsert_subagent_run("done", parent_session_id="s1", status="completed",
                               created_at=1.0, finished_at=9.0)
    ledger._db("sessions").execute(
        "UPDATE subagent_runs SET generation='previous-boot' WHERE subagent_id='done'"
    )
    ledger._db("sessions").commit()

    assert ledger.reap_orphan_subagent_runs() == []
    row = ledger.list_subagent_runs("s1")[0]
    assert row["status"] == "completed"
    assert row["finished_at"] == 9.0


def test_reap_is_idempotent(ledger):
    ledger.upsert_subagent_run("dead", parent_session_id="s1", status="spawning",
                               created_at=1.0)
    ledger._db("sessions").execute(
        "UPDATE subagent_runs SET generation='previous-boot'"
    )
    ledger._db("sessions").commit()
    assert len(ledger.reap_orphan_subagent_runs()) == 1
    assert ledger.reap_orphan_subagent_runs() == [], "第二次启动不该再报一遍"


def test_deleting_the_child_session_does_not_erase_the_ledger(ledger):
    """子代理收尾时会 delete_session(child)。台账独立于会话表就是为了这一刻。"""
    ledger.upsert_subagent_run("sub1", parent_session_id="parent",
                               child_session_id="parent::sub::sub1",
                               status="completed", created_at=1.0)
    ledger.delete_session("parent::sub::sub1")
    assert len(ledger.list_subagent_runs("parent")) == 1


def test_deleting_the_parent_session_does_erase_the_ledger(ledger):
    """会话被用户删掉后，它的子代理记录在 UI 里已经无法到达，留着只会污染统计。"""
    ledger.upsert_subagent_run("sub1", parent_session_id="parent",
                               status="completed", created_at=1.0)
    ledger.delete_session("parent")
    assert ledger.list_subagent_runs("parent") == []


def test_transition_is_the_single_write_path_to_the_ledger(ledger, monkeypatch):
    """真正的接线测试：调 _transition，盘上就该出现/更新一行。

    钉的是「函数被调用了」而不是「函数存在」——_persist 只在 _transition 里被调，
    这条断言一挂就说明接线断了。
    """
    import asyncio
    import storage as storage_mod
    from subagent_runtime import (
        SubagentRuntime, SubagentSession, SubagentStatus,
    )

    monkeypatch.setattr(storage_mod, "_storage", ledger)
    runtime = SubagentRuntime()
    sess = SubagentSession(
        subagent_id="wired", subagent_type="Explore", label="接线检查",
        parent_session_id="s1", child_session_id="s1::sub::wired",
    )

    asyncio.run(runtime._transition(sess, SubagentStatus.SPAWNING))
    rows = ledger.list_subagent_runs("s1")
    assert len(rows) == 1 and rows[0]["status"] == "spawning"

    sess.result_chars = 7
    asyncio.run(runtime._transition(sess, SubagentStatus.COMPLETED))
    rows = ledger.list_subagent_runs("s1")
    assert len(rows) == 1, "同一次运行不能变成两行"
    assert rows[0]["status"] == "completed"
    assert rows[0]["finished_at"] > 0
    assert rows[0]["result_chars"] == 7


# ── 语料 4：迁移账本必须真的被读写（B15）─────────────────────────────────────
#
# schema_migration 从一开始就建在库里，但全仓库没有任何一处读它或写它。于是数据库
# 里挂着一张暗示「我们有迁移管理」的表，真实机制却是一堆每次启动都重跑、且没有任何
# 记录的 create-if-not-exists。「这个库到底应用过哪些变更」谁也答不上来。
# 这里钉四件事：账本被写、变更只跑一次、状态可查、失败不静默。
def test_migrations_are_recorded_on_a_fresh_database(ledger):
    st = ledger.migration_status()
    assert st["registered"] >= 1, "至少要有一条注册迁移，否则这套机制又是死的"
    assert st["pending"] == [], "新库建完后不该还有未应用的迁移"
    assert [r["id"] for r in st["applied"]] == [m[0] for m in ledger._MIGRATIONS]


def test_recorded_rows_carry_checksum_version_and_timestamp(ledger):
    row = ledger.migration_status()["applied"][0]
    assert row["checksum"], "没有校验和就没法发现 id 被复用成了别的意图"
    assert row["app_version"] and row["app_version"] != "unknown"
    assert row["applied_at"] > 0


def test_a_migration_does_not_run_twice(ledger, monkeypatch):
    """第二次启动必须跳过已应用的迁移——这才是账本存在的意义。"""
    calls = []
    monkeypatch.setattr(
        type(ledger), "_mig_0001_subagent_runs",
        lambda self: calls.append(1), raising=True,
    )
    ledger._run_migrations()
    assert calls == [], "已记录的迁移被重复执行了"


def test_an_unapplied_migration_does_run(ledger, monkeypatch):
    calls = []
    monkeypatch.setattr(
        type(ledger), "_mig_probe",
        lambda self: calls.append(1), raising=False,
    )
    monkeypatch.setattr(
        type(ledger), "_MIGRATIONS",
        (("9999_probe", "探针", "_mig_probe"),), raising=True,
    )
    ledger._run_migrations()
    assert calls == [1]
    assert "9999_probe" in {r["id"] for r in ledger.migration_status()["applied"]}
    # 再跑一次不该再执行
    ledger._run_migrations()
    assert calls == [1]


def _arm_boom(ledger, monkeypatch, msg="disk on fire"):
    """Register one migration that always blows up."""
    def boom(self):
        raise RuntimeError(msg)

    monkeypatch.setattr(type(ledger), "_mig_boom", boom, raising=False)
    monkeypatch.setattr(
        type(ledger), "_MIGRATIONS",
        (("9998_boom", "会炸的迁移", "_mig_boom"),), raising=True,
    )


def test_a_failing_migration_is_deferred_and_never_marked_applied(ledger, monkeypatch):
    """失败的那条绝不能进 `applied`，否则下次启动会当它成功而永远跳过。

    契约比我最初写这条测试时更细了，而且比"直接抛"更好地回答了原本的担忧：
    失败会先 `_restore_from_backup` 回滚到迁移前的备份，然后**带着旧 schema
    继续启动**（`recovery_mode == "compat"`）。所以留在磁盘上的不是"半应用的
    schema"——那正是这条测试害怕的东西——而是一个旧但自洽的 schema，同时失败
    步骤被记进 `deferred`，等显式重试。一次瞬时故障不该让整个应用白屏。

    只有回滚本身也失败时才会抛，见下一条。
    """
    _arm_boom(ledger, monkeypatch)
    ledger._run_migrations()                      # must not raise

    status = ledger.migration_status()
    assert "9998_boom" not in {r["id"] for r in status["applied"]}, (
        "失败的迁移被记成了 applied，下次启动会永远跳过它"
    )
    assert status["pending"] == [
        {"id": "9998_boom", "description": "会炸的迁移"}
    ], "失败的迁移必须仍然是 pending，下次启动要重试"
    assert "9998_boom" in {d["id"] for d in status["deferred"]}
    assert ledger.recovery_mode == "compat"


def test_a_failing_migration_raises_when_the_rollback_also_fails(ledger, monkeypatch):
    """回滚是"降级启动"的前提。回滚不了，schema 就真的是半应用的了——
    这时候必须炸，而且要让入口能认出这是不可恢复的 schema 损坏。"""
    _arm_boom(ledger, monkeypatch)
    monkeypatch.setattr(type(ledger), "_restore_from_backup",
                        lambda self, backup_dir: False, raising=False)

    from storage import MigrationUnrecoverable
    with pytest.raises(MigrationUnrecoverable) as exc:
        ledger._run_migrations()
    assert exc.value.mig_id == "9998_boom"
    assert "9998_boom" not in {
        r["id"] for r in ledger.migration_status()["applied"]
    }


def test_the_ledger_owns_the_subagent_table_it_registers(ledger):
    """迁移不是空壳：它注册的表和索引必须真的建出来了。"""
    rows = ledger._db("sessions").execute(
        "SELECT name FROM sqlite_master WHERE name IN"
        " ('subagent_runs','idx_subrun_parent','idx_subrun_gen')"
    ).fetchall()
    assert {r["name"] for r in rows} == {
        "subagent_runs", "idx_subrun_parent", "idx_subrun_gen",
    }


def test_safe_add_column_stays_quiet_only_for_duplicate_columns(ledger, capsys):
    """重复列是预期的，静默；其它 OperationalError 必须喊出来。

    以前两种情况被同一个 except 吞掉，于是「列根本没加上」和「列早就在」长得
    一模一样，最后在很远的读取点以 no such column 的形式爆出来。
    """
    ledger._safe_add_column("sessions", "sessions", "pinned", "INTEGER DEFAULT 0")
    assert capsys.readouterr().out == "", "重复列不该有噪音"

    ledger._safe_add_column("sessions", "no_such_table", "x", "TEXT")
    assert "FAILED" in capsys.readouterr().out, "真正的错误必须被打出来"
