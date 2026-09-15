"""批次3 红线测试：真实成本核算 + 目标计划表 + 卡死判定。

这三件事之前都是「有读没写」或者「写了个假数」：

* ``turn_usage`` 只记 token，没有钱。价目表落在代码里、成本在写入时算一次，
  是为了**历史不会被今天的价格改写**——这一点这里专门测。
* ``goals.plan_json`` 一直只有读路径，进度条永远 0/0，重启后续跑是把原始
  description 重放一遍。
* 卡死判定用 ``str(evidence)[:200]`` 精确比对，A-B-A-B 来回抓不到。

DB 全部指向 tmp_path，绝不碰 ~/.ovolve。
"""
import json

import pytest

import storage as storage_mod
from storage import Storage

import goal_manager as goal_manager_mod
import model_registry as mr
import goal_plan
import goal_scheduler as gs


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A real Storage on a throwaway directory, installed as the singleton.

    Also blanks the GoalManager singleton for the duration. GoalManager binds
    ``self.storage`` once in its constructor, so a manager built while this
    fixture is active would keep pointing at a deleted tmp database after the
    test — and the next test file's goals would come back "not found".
    monkeypatch restores whatever was there, so isolation runs both ways.
    """
    s = Storage(db_dir=str(tmp_path / "db"))
    monkeypatch.setattr(storage_mod, "_storage", s)
    monkeypatch.setattr(goal_manager_mod, "_manager", None)
    monkeypatch.setattr(gs, "_scheduler", None)
    return s


@pytest.fixture
def goal(store):
    """One saved goal, returned as its id."""
    store.save_goal("g1", "把登录页重做一遍", "running", 0, "s1", "")
    return "g1"


# ---------------------------------------------------------------------------
# 价目表
# ---------------------------------------------------------------------------

def test_exact_key_hits_the_table():
    rates, source = mr.lookup_price("claude-sonnet-4")
    assert source == mr.COST_ESTIMATED
    assert rates["input"] == 3.0 and rates["output"] == 15.0


def test_provider_prefix_and_vendor_path_are_stripped():
    # 我们自己的 "providerId:modelId"，以及代理商加的 "openai/..." 前缀。
    a, _ = mr.lookup_price("__config__:gpt-4o")
    b, _ = mr.lookup_price("openai/gpt-4o")
    assert a == b == {**mr.FALLBACK_PRICE, **mr.MODEL_PRICES["gpt-4o"]}


def test_longest_prefix_wins_so_mini_is_not_shadowed():
    # 最短前缀匹配会让 gpt-4o 吃掉 gpt-4o-mini，把便宜模型按 16 倍计价。
    mini, _ = mr.lookup_price("gpt-4o-mini-2024-07-18")
    assert mini["input"] == mr.MODEL_PRICES["gpt-4o-mini"]["input"]


def test_unknown_model_is_flagged_not_zeroed():
    rates, source = mr.lookup_price("some-model-nobody-has-heard-of")
    assert source == mr.COST_FALLBACK
    # 关键：不是 0。0 会被读成「这次免费」，而这恰恰是唯一确定不成立的事。
    assert rates["input"] > 0


def test_user_override_beats_the_shipped_list_price():
    rates, source = mr.lookup_price("gpt-4o", overrides={"gpt-4o": {"input": 0.01, "output": 0.02}})
    assert source == mr.COST_ESTIMATED
    assert rates["input"] == 0.01


def test_cost_is_tokens_times_rate_in_micros():
    # 1 micro = 1e-6 USD，所以 micros 就是 tokens * 每百万单价，没有除法。
    got = mr.compute_cost("claude-sonnet-4", {"input": 1_000_000, "output": 0})
    assert got["cost_micros"] == 3_000_000  # = $3.00
    assert got["cost_source"] == mr.COST_ESTIMATED


def test_openai_style_cached_tokens_are_not_double_billed():
    # OpenAI 的 prompt_tokens 里已经含 cached_tokens。不减掉就会按全价再收一遍。
    got = mr.compute_cost("gpt-4o", {"input": 1000, "output": 0, "cache_read": 800})
    expected = 200 * 2.50 + 800 * 1.25
    assert got["cost_micros"] == round(expected)


def test_anthropic_style_cache_read_larger_than_input_is_billed_whole():
    # Anthropic 的 input_tokens 不含 cache_read，cache_read 常常比它大得多；
    # 这时候相减会把 input 扣成负数，等于漏收。
    got = mr.compute_cost("claude-sonnet-4", {"input": 50, "output": 0, "cache_read": 9000})
    expected = 50 * 3.0 + 9000 * 0.30
    assert got["cost_micros"] == round(expected)


def test_cache_saved_is_the_difference_against_full_input_rate():
    got = mr.compute_cost("gpt-4o", {"input": 1000, "output": 0, "cache_read": 1000})
    assert got["cache_saved_micros"] == round(1000 * (2.50 - 1.25))


def test_reasoning_tokens_inside_output_are_not_counted_twice():
    # 多数 provider 把 reasoning_tokens 算在 output_tokens 里面。
    inside = mr.compute_cost("gpt-5", {"input": 0, "output": 1000, "reasoning": 400})
    assert inside["cost_micros"] == round(1000 * 10.0)
    # 只有当 reasoning 明显在 output 之外（output 更小）时才另外加。
    outside = mr.compute_cost("gpt-5", {"input": 0, "output": 100, "reasoning": 900})
    assert outside["cost_micros"] == round(1000 * 10.0)


def test_provider_reported_cost_outranks_our_table():
    got = mr.compute_cost("gpt-4o", {"input": 999_999, "output": 999_999, "cost": 0.5})
    assert got["cost_micros"] == 500_000
    assert got["cost_source"] == mr.COST_REPORTED


# ---------------------------------------------------------------------------
# turn_usage：钱在写入时算一次
# ---------------------------------------------------------------------------

def test_usage_summary_sums_stored_cost(store):
    store.record_usage("s1", "turn-1", 100, 20, cost_micros=1234,
                       cache_saved_micros=50, cost_source="estimated")
    store.record_usage("s1", "turn-2", 200, 40, cost_micros=766,
                       cache_saved_micros=10, cost_source="estimated")
    got = store.get_usage("s1")
    assert got["total_cost_micros"] == 2000
    assert got["cache_saved_micros"] == 60
    assert got["cost_approximate"] is False


def test_a_fallback_priced_row_marks_the_whole_total_approximate(store):
    store.record_usage("s1", "turn-1", 10, 10, cost_micros=5, cost_source="estimated")
    store.record_usage("s1", "turn-2", 10, 10, cost_micros=5, cost_source="fallback")
    assert store.get_usage("s1")["cost_approximate"] is True


def test_stored_cost_survives_a_price_change(store, monkeypatch):
    # 这是整个设计的理由：涨价不能把上个月的账单改写。
    priced = mr.compute_cost("gpt-4o", {"input": 1_000_000, "output": 0})
    store.record_usage("s1", "turn-1", 1_000_000, 0,
                       cost_micros=priced["cost_micros"], cost_source=priced["cost_source"])
    before = store.get_usage("s1")["total_cost_micros"]

    monkeypatch.setitem(mr.MODEL_PRICES, "gpt-4o", {"input": 999.0, "output": 999.0,
                                                    "cache_read": 0.0, "cache_write": 0.0})
    assert store.get_usage("s1")["total_cost_micros"] == before


def test_usage_summary_keeps_its_old_keys(store):
    # 仪表盘还在读这几个键，加列不能顺手把它们改名。
    store.record_usage("s1", "turn-1", 100, 20, reason=5)
    got = store.get_usage("s1")
    assert got["turns"] == 1 and got["total_input"] == 100
    assert got["total_output"] == 20 and got["total"] == 125


# ---------------------------------------------------------------------------
# goal_plan：进度表的写入侧
# ---------------------------------------------------------------------------

class _Brief:
    def __init__(self, deliverables):
        self.deliverables = deliverables


def test_seed_from_brief_creates_one_item_per_deliverable(store, goal):
    items = goal_plan.seed_plan_from_brief(goal, _Brief(["加校验", "接后端", "写测试"]))
    assert [i["title"] for i in items] == ["加校验", "接后端", "写测试"]
    assert all(i["status"] == "pending" for i in items)
    # 落库了，重读一致。
    assert goal_plan.load_plan(goal) == items


def test_seed_never_overwrites_an_existing_plan(store, goal):
    goal_plan.save_plan(goal, [{"title": "已有项", "status": "in_progress"}])
    goal_plan.seed_plan_from_brief(goal, _Brief(["新项"]))
    assert [i["title"] for i in goal_plan.load_plan(goal)] == ["已有项"]


def test_pass_marks_everything_completed():
    items = [{"title": "a", "status": "pending"}, {"title": "b", "status": "in_progress"}]
    out, flipped = goal_plan.apply_completion(items, None, all_done=True)
    assert flipped == 2
    assert all(i["status"] == "completed" for i in out)


def test_rejection_only_flips_named_items():
    items = [{"title": "a"}, {"title": "b"}, {"title": "c"}]
    out, flipped = goal_plan.apply_completion(items, [2], all_done=False)
    assert flipped == 1
    assert [i["status"] for i in out] == ["pending", "completed", "pending"]


def test_resume_renders_unfinished_not_the_whole_thing():
    items = [{"title": "做完的", "status": "completed"},
             {"title": "没做的", "status": "pending"}]
    block = goal_plan.render_unfinished(items)
    assert "没做的" in block and "做完的" not in block
    assert "1/2" in block  # 已完成 / 总数


def test_render_unfinished_is_empty_when_all_done():
    assert goal_plan.render_unfinished([{"title": "x", "status": "completed"}]) == ""


def test_plan_write_needs_a_goal_in_context(store):
    r = goal_plan._plan_write({"items": [{"title": "x"}]}, context={})
    assert not r.ok  # 没绑定目标就拒绝，别写到不知道哪去


def test_plan_write_persists_to_the_same_goal_table(store, goal):
    r = goal_plan._plan_write({"items": [{"title": "第一步"}, {"title": "第二步"}]},
                              context={"goal_id": goal})
    assert r.ok
    assert [i["title"] for i in goal_plan.load_plan(goal)] == ["第一步", "第二步"]


def test_normalize_accepts_bare_strings_and_caps_length():
    items = goal_plan.normalize_plan(["只是个字符串"])
    assert items[0]["title"] == "只是个字符串" and items[0]["status"] == "pending"
    big = goal_plan.normalize_plan([{"title": "x"}] * (goal_plan.MAX_PLAN_ITEMS + 10))
    assert len(big) == goal_plan.MAX_PLAN_ITEMS


# ---------------------------------------------------------------------------
# 迭代明细表
# ---------------------------------------------------------------------------

def test_iteration_rows_are_idempotent_on_ordinal(store, goal):
    store.add_goal_iteration(goal, 1, evidence="第一次", verdict="rejected", cost_micros=100)
    store.add_goal_iteration(goal, 1, evidence="重试", verdict="passed", cost_micros=200)
    rows = store.list_goal_iterations(goal)
    assert len(rows) == 1  # 同一轮重试是覆盖，不是追加
    assert rows[0]["verdict"] == "passed" and rows[0]["cost_micros"] == 200


def test_iteration_evidence_is_digested_not_stored_whole(store, goal):
    store.add_goal_iteration(goal, 1, evidence="x" * 5000)
    row = store.list_goal_iterations(goal)[0]
    assert len(row["evidence_digest"]) == store.GOAL_EVIDENCE_DIGEST_CHARS


def test_iterations_come_back_in_order(store, goal):
    for i in (3, 1, 2):
        store.add_goal_iteration(goal, i, evidence=f"r{i}")
    assert [r["ordinal"] for r in store.list_goal_iterations(goal)] == [1, 2, 3]


# ---------------------------------------------------------------------------
# 卡死判定（C5）
# ---------------------------------------------------------------------------

def test_same_action_three_times_is_stuck():
    sig = "write_file:abc"
    assert gs.is_stuck([sig, sig, sig])


def test_abab_oscillation_is_stuck():
    # 老逻辑（连续三次相同）抓不到 A-B-A-B，这正是它烧光预算的方式。
    assert gs.is_stuck(["A", "B", "A", "B"])


def test_genuine_progress_is_not_stuck():
    assert not gs.is_stuck(["A", "B", "C", "D"])


def test_signature_ignores_volatile_numbers():
    # 「写了 41 行」和「写了 42 行」是同一个动作，不该被当成两个。
    a = gs._text_signature("wrote 41 lines to foo.py")
    b = gs._text_signature("wrote 42 lines to foo.py")
    assert a == b


def test_signature_prefers_tool_calls_over_prose():
    trace = [{"tool": "edit_file", "args": {"path": "a.py"}}]
    sig = gs.round_signature(trace, "模型这一轮说了一大段废话")
    assert sig.startswith("edit_file:")


def test_signature_falls_back_to_text_when_no_tools():
    sig = gs.round_signature([], "纯文字回复，没有工具调用")
    assert sig.startswith("text:")


def test_charge_uses_the_real_usage_from_result_meta(store, goal):
    from result import Result
    sched = gs.GoalScheduler(router=None, bus=None)
    turn = Result.success("ok", usage={"cost_micros": 12_345, "tokens": 999,
                                       "cost_source": "estimated"})
    got = sched._charge_round(goal, turn)
    assert got["cost_micros"] == 12_345 and got["tokens"] == 999
    assert store.get_goal(goal)["cost_micros"] == 12_345


def test_charge_falls_back_when_the_turn_reported_nothing(store, goal):
    from result import Result
    sched = gs.GoalScheduler(router=None, bus=None)
    got = sched._charge_round(goal, Result.success("ok"))
    # 不能记 0：记 0 等于把成本上限变成永远碰不到的装饰。
    assert got["cost_micros"] == gs.FALLBACK_ROUND_MICROS
    assert got["source"] == "fallback"


def test_charge_reports_over_cap(store, goal):
    from result import Result
    store.update_goal_fields(goal, cost_cap_micros=1000)
    sched = gs.GoalScheduler(router=None, bus=None)
    got = sched._charge_round(goal, Result.success("ok", usage={"cost_micros": 1500}))
    assert got["over_cap"] is True


def test_opening_prompt_carries_the_unfinished_plan():
    plan = [{"title": "已完成项", "status": "completed"}, {"title": "剩下的活", "status": "pending"}]
    prompt = gs.GoalScheduler._opening_prompt("原始描述", plan)
    assert "原始描述" in prompt and "剩下的活" in prompt


def test_opening_prompt_is_just_the_description_without_a_plan():
    assert gs.GoalScheduler._opening_prompt("原始描述", []) == "原始描述"


# ---------------------------------------------------------------------------
# plan_write 注册
# ---------------------------------------------------------------------------

def test_plan_write_is_registered_with_a_schema():
    class _Reg:
        def __init__(self):
            self.tools = {}

        def register(self, tool):
            self.tools[tool.name] = tool

    reg = _Reg()
    goal_plan.register_tools(reg)
    tool = reg.tools["plan_write"]
    assert tool.schema["required"] == ["items"]
    # 描述里必须写清「什么时候别用」，否则模型会给「读一个文件」也列清单。
    assert "别用" in tool.description
