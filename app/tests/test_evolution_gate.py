"""红线测试：自我演化的资格门。

这个模块会往 ``AGENTS.md`` / ``MEMORY.md`` / ``SOUL.md`` 追加内容——也就是会改
「每回合都注入模型」的那几个文件。它出错的方式不是崩，而是**悄悄给自己立规则**：
为一次偶发失败写下一条永久约束，然后每轮都花 token 复述它。所以这里测的全是
「不该发生的事没发生」：没到复发阈值不提、被拒了不再骚扰、触顶就停、白名单外
一律不落盘。

store 与 workspace 都指向 tmp_path。
"""
import time

import pytest

from evolution import (
    MODE_ACTIVE, MODE_CAUTIOUS, MODE_OFF, MODE_POLICIES,
    EvolutionEngine, EvolutionStore,
)


@pytest.fixture
def engine(tmp_path):
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    eng = EvolutionEngine(store=store, mode=MODE_ACTIVE,
                          workspace_root=str(tmp_path))
    yield eng
    store.close()


def feed(engine, n, kind="tool_failure", tool="shell_executor", detail="boom at line 12"):
    """喂 n 条同签名信号。行号/路径会被 normalize_error 抹掉，签名才折叠成一个。"""
    sig = None
    for i in range(n):
        sig = engine.record(kind, tool, f"{detail} (attempt {i}) /tmp/x{i}.py:{i}")
    return sig


# ── 关档 ────────────────────────────────────────────────────────────────────

def test_off_mode_writes_nothing(tmp_path):
    """「用户没开就一行不跑」——off 档连信号都不该落盘。"""
    store = EvolutionStore(db_path=str(tmp_path / "evo.db"))
    eng = EvolutionEngine(store=store, mode=MODE_OFF, workspace_root=str(tmp_path))
    assert eng.record("tool_failure", "shell_executor", "boom") is None
    assert eng.mine() == []
    assert eng.list_all() == []
    store.close()


# ── 资格门 ──────────────────────────────────────────────────────────────────

def test_below_min_hits_proposes_nothing(engine):
    need = MODE_POLICIES[MODE_ACTIVE].min_hits
    feed(engine, need - 1)
    assert engine.mine() == []


def test_at_min_hits_proposes_once(engine):
    need = MODE_POLICIES[MODE_ACTIVE].min_hits
    feed(engine, need)
    made = engine.mine()
    assert len(made) == 1
    assert made[0].target_file == "AGENTS.md"
    assert made[0].hits >= need


def test_open_proposal_blocks_a_duplicate(engine):
    """同一签名同时只能有一条待审，否则用户会被同一件事问五遍。"""
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits + 3)
    assert len(engine.mine()) == 1
    assert engine.mine() == []


def test_rejected_signature_enters_cooldown(engine):
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits)
    p = engine.mine()[0]
    assert engine.decide(p.id, accept=False)["status"] == "rejected"
    # 没有未决提案了，命中数也还够——唯一挡住它的就是冷却期
    assert engine.mine() == []


def test_cooldown_expiry_allows_a_new_proposal(engine, monkeypatch):
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits)
    p = engine.mine()[0]
    engine.decide(p.id, accept=False)
    # 把「现在」推到冷却期之后，而不是 sleep 七天
    later = time.time() + MODE_POLICIES[MODE_ACTIVE].reject_cooldown_s + 1
    monkeypatch.setattr("evolution.time.time", lambda: later)
    assert len(engine.mine()) == 1


def test_max_open_caps_the_queue(engine):
    """触顶就停：先让用户清完，别把待审队列堆成一面墙。"""
    cap = MODE_POLICIES[MODE_ACTIVE].max_open
    need = MODE_POLICIES[MODE_ACTIVE].min_hits
    for i in range(cap + 3):
        feed(engine, need, tool=f"tool_{i}")
    engine.mine()
    assert engine.store.count_open() <= cap
    assert engine.mine() == []


def test_unmapped_kind_never_produces_a_proposal(engine):
    """白名单是硬约束：没映射目标文件的 kind 一条都不许出。"""
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits + 2, kind="some_new_kind")
    assert engine.mine() == []


def test_cautious_needs_more_hits_than_active(engine):
    """两档的差别只在「多久才算够确定」，这条守住阈值没被写反。"""
    assert MODE_POLICIES[MODE_CAUTIOUS].min_hits > MODE_POLICIES[MODE_ACTIVE].min_hits
    engine.set_mode(MODE_CAUTIOUS)
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits)   # 够 active、不够 cautious
    assert engine.mine() == []


def test_invalid_mode_is_rejected(engine):
    with pytest.raises(ValueError):
        engine.set_mode("aggressive")


# ── 落盘 ────────────────────────────────────────────────────────────────────

def test_accept_writes_the_rule_into_the_guidance_file(engine, tmp_path):
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits)
    p = engine.mine()[0]
    out = engine.decide(p.id, accept=True)
    assert out["applied"] is True

    body = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    assert "Learned Rules" in body
    assert "shell_executor" in body


def test_accepting_twice_does_not_duplicate_the_line(engine, tmp_path):
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits)
    p = engine.mine()[0]
    engine.decide(p.id, accept=True)
    first = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")

    again = engine.decide(p.id, accept=True)
    assert again["ok"] is False and again["error"] == "already decided"
    assert (tmp_path / "AGENTS.md").read_text(encoding="utf-8") == first


def test_target_outside_the_whitelist_is_not_written(engine, tmp_path):
    """提案系统若能往任意文件追加，就是一条绕过所有写入防护的通道。"""
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits)
    p = engine.mine()[0]
    p.target_file = "../evil.md"          # 只动内存里的对象，模拟被篡改的草稿
    assert engine._apply_to_guidance(p) is False
    assert not (tmp_path.parent / "evil.md").exists()


def test_decide_on_a_missing_proposal_is_reported(engine):
    out = engine.decide("does-not-exist", accept=True)
    assert out["ok"] is False and out["status"] == "missing"


def test_draft_never_embeds_raw_detail(engine):
    """草稿里不许出现原始路径/堆栈——那可能带着凭证或用户私有路径。"""
    feed(engine, MODE_POLICIES[MODE_ACTIVE].min_hits,
         detail="token=sk-secret-value failed at C:/Users/me/proj/app.py:99")
    p = engine.mine()[0]
    assert "sk-secret-value" not in p.draft
    assert "C:/Users/me/proj/app.py" not in p.draft
