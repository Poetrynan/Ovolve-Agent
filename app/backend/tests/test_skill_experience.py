"""Slice: SkillExperience 持久化（storage 0003）+ Router 真实技能使用路径。

按纠偏指令的最小验证预算：一个核心单元测试（幂等重放）、一个真实接线
集成测试（_execute 全流程产生经验与事件）、一个失败路径测试。
Router 构造函数拉起整个世界，这里沿用 test_router_cancel 的裸对象绑定法，
只接被测方法真正依赖的四个协作者，其中 Storage 是真实的。
"""
import asyncio

from router import Router
from result import Result
from storage import Storage


def make_storage(tmp_path):
    return Storage(db_dir=str(tmp_path / "db"))


# ── 协作替身：只覆盖 _execute 用到的表面 ─────────────────────────────────────

class _Entry:
    name = "deploy-check"
    version = "abc123def4567890"


class _SkillLike:
    def __init__(self, entry):
        self._entry = entry

    def get_skill(self, name):
        return self._entry if name == self._entry.name else None

    def load_skill_body(self, name):
        # 与真实 load_skill_body 同契约：返回 {body, frontmatter, path} 字典。
        # 上一次替身返回纯字符串，掩盖了 router 把字典 repr 进回复的真缺陷。
        return Result.success({
            "body": "Step 1: do the thing.\nStep 2: verify it.",
            "frontmatter": {}, "path": "stub",
        })


class _Tools:
    def __init__(self, ok=True):
        self.ok = ok

    def get(self, name):
        return object()  # 真值 → 走真实 dispatch 分支

    async def dispatch(self, name, args, ctx):
        return Result.success("done") if self.ok else Result.failure("boom")


class _Action:
    value = "allow"


class _Event:
    action = _Action()
    block_reason = ""


class _Bus:
    async def emit(self, kind, payload):
        return _Event()


class _Bare:
    """Router 的技能执行面，不拉依赖图。"""
    _execute = Router._execute
    _trace_skill = Router._trace_skill

    def __init__(self, storage, tools):
        from risk_control import get_risk_controller
        self.session_id = "sess-skill"
        self.storage = storage
        self.skills = _SkillLike(_Entry())
        self.tools = tools
        self.bus = _Bus()
        self.allowed_tools = None  # 主链路无角色白名单（_execute 入口检查）
        self.risk = get_risk_controller()  # §7.4 执行模式选择读取授权


DISPATCH = {"primary_tool": "list_dir", "args": {},
            "skill_matches": [{"name": "deploy-check", "match_score": 3}]}


# ── 单元：幂等重放（崩溃恢复再记一遍不得产生第二条经验） ────────────────────

def test_experience_replay_is_one_row_across_reopens(tmp_path):
    db_dir = str(tmp_path / "db")
    st = make_storage(tmp_path)
    first = st.record_skill_experience(
        "deploy-check", run_id="run-1", turn_id="turn-1",
        outcome="success", session_id="sess-x",
    )
    st.close()
    # 模拟进程重启后恢复流程重放同一条记录
    st2 = Storage(db_dir=db_dir)
    try:
        again = st2.record_skill_experience(
            "deploy-check", run_id="run-1", turn_id="turn-1",
            outcome="failure",  # 重放携带不同结果也不得改写已发生的事实
            session_id="sess-x",
        )
        assert again == first, "确定性 id：重放必须命中同一条经验"
        rows = st2.list_skill_experiences(skill_id="deploy-check")
        assert len(rows) == 1, f"重放产生了重复经验: {len(rows)} 条"
        assert rows[0]["outcome"] == "success", "first write wins"
        # 用户事后反馈走更新通道，而不是重新记录
        assert st2.set_skill_experience_feedback(first, "很有用", outcome="confirmed")
        assert st2.get_skill_experience(first)["user_feedback"] == "很有用"
    finally:
        st2.close()


# ── 集成：真实 _execute 路径产生经验 + 事件 + 指导随回复下发 ────────────────

def test_real_execute_records_experience_and_delivers_guidance(tmp_path):
    st = make_storage(tmp_path)
    try:
        r = _Bare(st, _Tools(ok=True))
        # 真实调用方 _keyword_turn 一定先写 risk_level；缺省未知 = R4 拒绝
        res = asyncio.run(r._execute(dict(DISPATCH), {"risk_level": "low"}))
        assert res.ok
        assert "[Skill guidance — deploy-check v abc123de" in res.value, \
            "技能指导必须真的进入回复，而不是停在发现列表里"
        assert res.meta.get("skill_experience_id"), "结果要能回指到经验行"
        # §7.4 执行模式随结果下发，UI/审计可查"这次是怎么被放行的"
        assert res.meta.get("execution_mode") == "read-only"

        rows = st.list_skill_experiences(skill_id="deploy-check")
        assert len(rows) == 1
        row = rows[0]
        assert row["outcome"] == "success"
        assert row["selection_reason"].startswith("trigger_match")
        assert row["skill_version"] == "abc123def4567890"
        assert row["latency_ms"] >= 0

        kinds = [e.event_type for e in st.get_event_store().read_stream("sess-skill")]
        assert "skill.started" in kinds and "skill.completed" in kinds
        assert "skill.experience_recorded" in kinds
    finally:
        st.close()


# ── 失败路径：失败是合法经验，指导不下发 ────────────────────────────────────

def test_failed_use_records_failure_without_guidance(tmp_path):
    st = make_storage(tmp_path)
    try:
        r = _Bare(st, _Tools(ok=False))
        res = asyncio.run(r._execute(dict(DISPATCH), {"risk_level": "low"}))
        assert not res.ok
        assert "Skill guidance" not in str(res.value), "失败时不得把指导当成功下发"

        row = st.list_skill_experiences(skill_id="deploy-check")[0]
        assert row["outcome"] == "failure"
        assert "boom" in (row["failure_class"] or "")
        assert row["steps_succeeded"] == 0
    finally:
        st.close()


# ── task-level 履历（P0-2）：无技能的任务也留证，且不冒充技能 ────────────────

def test_task_level_experience_is_ledgered_but_hidden_from_skill_views(tmp_path):
    st = make_storage(tmp_path)
    try:
        st.record_skill_experience(
            "deploy-check", run_id="run-1", turn_id="turn-1",
            goal_id="g-1", outcome="success", session_id="sess-x",
        )
        task_exp = st.record_skill_experience(
            st.TASK_LEVEL_SKILL_ID, run_id="run-1", turn_id="turn-2",
            goal_id="g-1", outcome="failure", selection_reason="no_skill",
            session_id="sess-x",
        )

        # 默认视图 = "技能表现"：哨兵行不得混进去冒充一个技能
        default_rows = st.list_skill_experiences(goal_id="g-1")
        assert [r["skill_id"] for r in default_rows] == ["deploy-check"]

        # 学习闭环视图：必须看得见"这个任务没有技能覆盖"
        all_rows = st.list_skill_experiences(goal_id="g-1", include_task_level=True)
        assert task_exp in [r["experience_id"] for r in all_rows]
        assert len(all_rows) == 2

        # 显式点名哨兵是有意请求，照常返回
        assert len(st.list_skill_experiences(skill_id=st.TASK_LEVEL_SKILL_ID)) == 1

        # 关键安全性：哨兵行不能拉低任何真实技能的健康度——降级查询按
        # 精确 skill_id 过滤，两者永不相交。
        assert st.TASK_LEVEL_SKILL_ID != "deploy-check"
    finally:
        st.close()
