"""Phase 7 收口测试：TeamBoard 角色白名单强制执行 + Mailbox 子代理运行时收发。

验收口径（HANDOFF 任务 3 / 任务 4）：
- 角色白名单真正落到子代理 Router 的 allowed_tools（Router 分发层既有强制点），
  coder 角色 + researcher 声明的组合取交集，白名单外工具被拒；
- 白名单内的工具照常放行；
- 子代理 spawn/终态时父运行信箱有对应消息，HTTP 端点可查。
"""
from types import SimpleNamespace

from storage import Storage

import subagent_runtime as sr
from subagent_runtime import SubagentRuntime, SubagentSession, SubagentStatus, \
    resolve_child_allowlist


def _persona(allowed=None, handoffs=None):
    return SimpleNamespace(allowed_tools=allowed, handoffs=handoffs or set())


# ── 任务 3：角色白名单解析 ──────────────────────────────────────────────────

def test_role_allowlist_narrows_full_catalogue_persona():
    # coder persona 继承全目录（allowed_tools=None）。声明 role="coder" 后，
    # 白名单从"什么都能调"收窄为角色预设——web_search 不在其中。
    got = resolve_child_allowlist(_persona(None), "coder")
    assert "web_search" not in got
    assert {"write_file", "edit_file", "shell_executor", "read_file"} <= set(got)


def test_role_allowlist_intersects_with_persona_restriction():
    # 只读 persona 再套 coder 角色：交集只剩 read_file——双重限制是收紧，
    # 不是放权。
    read_only = frozenset({"read_file", "list_dir", "search_code"})
    got = resolve_child_allowlist(_persona(read_only), "coder")
    assert got == frozenset({"read_file"})


def test_handoff_capable_persona_keeps_task_tool():
    # 有 hand-off 的 persona 必须保留 task 工具——否则只读白名单会顺手删掉
    # 交接唯一通道。交集之后 task 仍在。
    p = _persona(frozenset({"read_file"}), handoffs={"planner"})
    got = resolve_child_allowlist(p, "coder")
    assert "task" in got and "read_file" in got
    # 无角色声明时维持旧行为：persona 集合 + task
    assert resolve_child_allowlist(p, "") == {"read_file", "task"}


def test_unknown_role_falls_back_to_empty_allowlist():
    # 未知角色 → role_spec 的受限通用档（空工具集）。宁缺勿滥，绝不静默放权。
    got = resolve_child_allowlist(_persona(None), "nonexistent-role")
    assert got == frozenset()


def test_no_role_no_persona_keeps_full_catalogue():
    assert resolve_child_allowlist(_persona(None), "") is None


def test_router_keyword_path_enforces_allowlist():
    # 关键词降级路径同样受白名单约束——子代理能调什么不该取决于是否配了 API Key。
    import asyncio
    from router import Router

    r = Router.__new__(Router)
    r.allowed_tools = frozenset({"read_text"})

    res = asyncio.run(r._execute(
        {"type": "direct", "agent": None, "primary_tool": "web_search",
         "args": {}}, {}))
    assert not res.ok
    assert "[team] tool 'web_search' not in role allowlist" in str(res.error)


# ── 任务 4：Mailbox 运行时收发 ──────────────────────────────────────────────

def test_subagent_lifecycle_lands_in_parent_mailbox(tmp_path, monkeypatch):
    import storage as storage_mod
    from mailbox import unread, drain

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        monkeypatch.setattr(storage_mod, "get_storage", lambda: st)
        rt = SubagentRuntime.__new__(SubagentRuntime)
        sess = SubagentSession(
            subagent_id="abc123", subagent_type="explore", label="查资料",
            parent_session_id="parent-1", child_session_id="parent-1::sub::abc123",
        )

        box = "mailbox:parent-1"
        # SPAWNING 不投递——排队等待不是"开始干活"，信箱只记录真实生命周期。
        rt._notify_parent_mailbox(sess, SubagentStatus.SPAWNING)
        assert unread(st, box) == []

        sess.error = ""
        rt._notify_parent_mailbox(sess, SubagentStatus.RUNNING)
        rt._notify_parent_mailbox(sess, SubagentStatus.KILLED)

        msgs = drain(st, box)
        assert [m["payload"]["event"] for m in msgs] == ["started", "killed"]
        started = msgs[0]["payload"]
        assert started["type"] == "explore"
        assert started["subagent_id"] == "abc123"
        assert msgs[1]["payload"]["error"] == ""

        # 消费即标记：再 drain 为空，但审计记录仍在库里
        assert drain(st, box) == []
        total = st._db("sessions").execute(
            "SELECT COUNT(*) AS c FROM mailbox_messages WHERE box_id=?",
            (box,)).fetchone()["c"]
        assert total == 2
    finally:
        st.close()
