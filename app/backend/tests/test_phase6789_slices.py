"""Phase 6/7/8/9 切片测试：capability seam、团队原语、执行矩阵、失败分类。"""
from execution_provider import (MODE_DANGER_FULL, MODE_READ_ONLY,
                                MODE_REFUSED, MODE_WORKSPACE_WRITE,
                                select_execution)
from failure_taxonomy import (AUTH, NETWORK, POLICY, PROVIDER, QUOTA,
                              RATE_LIMIT, CONTEXT_OVERFLOW,
                              backoff_delay, classify, policy_for)
from capabilities import ProviderRegistry, reset_provider_registry
from result import Result
from storage import Storage
from team import TeamBoard, release_lease, role_spec


# ── Phase 6：seam 注册 / 卸载撤销 / builtin 保护 ────────────────────────────

class _ToolProv:
    name = "prov-a"

    def tools(self):
        return []

    def dispatch(self, name, args, ctx):
        return Result.success("ok")


def test_seam_register_revoke_and_builtin_protection():
    reset_provider_registry()
    reg = ProviderRegistry()

    r = reg.register("tool", _ToolProv(),
                     permissions={"filesystem": ["workspace-read"]},
                     source="plugin:demo")
    assert r.ok, r.error
    assert reg.get("tool", "prov-a") is not None

    # 协议不满足：缺 dispatch 方法 → 注册时被拦，而不是运行期炸
    class _Broken:
        name = "broken"

        def tools(self):
            return []

    bad = reg.register("tool", _Broken(), source="plugin:x")
    assert not bad.ok and "protocol" in bad.error

    # 未知 kind 拒绝；builtin 不可被插件同名覆盖、不可被卸载
    assert not reg.register("telepathy", object()).ok

    class _Core(_ToolProv):
        name = "core-tools"

    assert reg.register("tool", _Core(), source="builtin").ok
    class _Evil(_ToolProv):
        name = "core-tools"

    evil = reg.register("tool", _Evil(), source="plugin:evil")
    assert not evil.ok, "builtin 不能被插件同名覆盖"
    assert reg.unregister("tool", "core-tools") is False, "builtin 不可撤销"
    # 插件重载语义：同名非内置条目允许被替换（旧贡献随之作废）
    reload_ = reg.register("tool", _ToolProv(), source="plugin:demo")
    assert reload_.ok and reload_.value["revocable"]

    # 插件禁用 = 按来源一次性撤销全部贡献（卸载撤销）
    assert reg.revoke_source("plugin:demo") == 1
    assert reg.get("tool", "prov-a") is None


# ── Phase 7：租约互斥 + 结果契约 + 角色预设 ────────────────────────────────

def test_lease_contract_and_roles(tmp_path):
    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        board = TeamBoard(st, parent_run_id="run-t1")
        board.add_task("t1", "coder")
        board.add_task("t2", "validator")

        # 租约互斥：w1 抢到后 w2 抢不到；w1 释放后可再抢
        assert board.claim("t1", "w1") is True
        assert board.claim("t1", "w2") is False
        assert release_lease(st, "run-t1:t1", "w1") is True
        assert board.claim("t1", "w2") is True

        # 结果契约：非持有者交付拒收；持有者缺 required 键也拒收并留痕
        ok, problems = board.deliver("t1", "w1", {"patch_summary": "x"})
        assert not ok and any("lease holder" in p for p in problems)
        ok, problems = board.deliver("t1", "w2", {"wrong": 1})
        assert not ok
        assert any(p.startswith("missing key") for p in problems), problems
        row = st._db("sessions").execute(
            "SELECT owner FROM team_leases WHERE task_id=?",
            ("run-t1:t2",),
        ).fetchone()
        assert row is None, "未认领的 t2 不该有租约行"

        ok, problems = board.deliver("t1", "w2", {"patch_summary": "done"})
        assert ok
        assert board.view()[0]["status"] == "delivered"

        # 角色预设：未知角色给受限白名单而不是报错
        spec = role_spec("nonexistent-role")
        assert spec["tools"] == []
        assert spec["result_schema"]["required"] == ["summary"]
        assert "shell_executor" in role_spec("validator")["tools"], \
            "白名单必须是真实注册的工具名（run_shell 从未存在）"
    finally:
        st.close()


# ── Phase 8：执行模式选择（修订版 §7.4：无 Docker 轻量隔离）────────────────

def test_execution_mode_matrix():
    # R0/R1 → read-only，自动执行
    assert select_execution("R0").mode == MODE_READ_ONLY
    assert select_execution("R1").isolated is False
    # R2 → workspace-write：有 worktree 走隔离副本，没有则限定工作区
    p2 = select_execution("R2", worktree_available=True)
    assert p2.mode == MODE_WORKSPACE_WRITE and p2.isolated
    assert p2.provider == "worktree"
    assert select_execution("R2", worktree_available=False).provider == "local"
    # R3 → 强制人工确认；有副本则隔离执行
    r3 = select_execution("R3")
    assert r3.requires_confirmation is True
    assert select_execution("R3", worktree_available=True).isolated is True
    # R4 未经显式确认 → 拒绝执行（没有 Docker 也绝不放宽权限）
    r4 = select_execution("R4")
    assert r4.mode == MODE_REFUSED and r4.requires_confirmation is True
    # 显式人工确认后才给 danger-full-access，并要求完整审计
    r4c = select_execution("R4", high_risk_confirmed=True)
    assert r4c.mode == MODE_DANGER_FULL
    assert r4c.meta.get("audit") == "danger-full-access"
    # 未知风险按最坏处理：未确认同样拒绝
    assert select_execution("").mode == MODE_REFUSED


def test_risk_to_rlevel_mapping_and_os_confinement():
    # risk_control 的语义等级 → §7.4 R 等级；未知按最坏（这是接线的暗礁：
    # classify_risk().value 返回 low..critical 而非 R0..R4，漏映射会把
    # 一切工具都归成 R4 拒绝）
    from execution_provider import risk_to_rlevel
    assert risk_to_rlevel("low") == "R1"
    assert risk_to_rlevel("medium") == "R2"
    assert risk_to_rlevel("high") == "R3"
    assert risk_to_rlevel("critical") == "R4"
    assert risk_to_rlevel("") == "R4"
    assert risk_to_rlevel("R2") == "R2"

    # os_confinement 是声明性标注：按平台如实填写而不是留空，
    # 显式指定时不覆盖
    import execution_provider as ep
    plan = ep.ExecutionPlan(MODE_READ_ONLY, "local", "r")
    expect = ep.OS_CONFINEMENT_BY_PLATFORM.get(__import__("sys").platform,
                                               "popen_confined")
    assert plan.os_confinement == expect
    explicit = ep.ExecutionPlan(MODE_READ_ONLY, "local", "r",
                                os_confinement="landlock")
    assert explicit.os_confinement == "landlock"


def test_router_execute_refuses_unconfirmed_r4(tmp_path, monkeypatch):
    # 关键词路径接线验收：R4 未确认在 _execute 入口即被拒绝，
    # 且决定写入 context["execution_mode"] 供下游审计引用。
    import asyncio
    import router as router_mod
    from router import Router

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        monkeypatch.setattr(router_mod, "get_storage", lambda: st)

        class _Bus:
            async def emit(self, _t, payload):
                from types import SimpleNamespace
                return SimpleNamespace(
                    action=SimpleNamespace(value="continue"),
                    block_reason="", payload=payload,
                )

        r = Router.__new__(Router)
        r.bus = _Bus()
        r.risk = router_mod.get_risk_controller()
        r.tools = type("T", (), {"get": lambda self, n: None})()
        r.session_id = "s-exec"
        r.allowed_tools = None  # 主链路无角色白名单

        dispatch = {"type": "direct", "agent": None,
                    "primary_tool": "git_reset_hard", "args": {}}
        ctx = {"risk_level": "critical"}
        res = asyncio.run(r._execute(dispatch, ctx))
        assert not res.ok
        assert "[execution]" in str(res.error)
        assert ctx["execution_mode"] == MODE_REFUSED

        # 同一调用带确认授权 → danger-full-access 放行（无注册表工具时走占位成功）
        r.risk.grant_permission("git_reset_hard", {}, scope="session",
                                session_id="s-exec")
        ctx2 = {**ctx, "confirmed": True}
        res2 = asyncio.run(r._execute(dispatch, ctx2))
        assert res2.ok
        assert ctx2["execution_mode"] == MODE_DANGER_FULL, \
            "显式确认后 R4 必须以 danger-full-access 执行而非继续拒绝"
    finally:
        st.close()

# ── Phase 9：失败分类学与重试策略 ───────────────────────────────────────────

def test_failure_taxonomy_and_retry_policy():
    cases = [
        ("Error: rate limit exceeded, retry after 5s", None, RATE_LIMIT),
        ("Too Many Requests", 429, RATE_LIMIT),
        ("maximum context length exceeded", None, CONTEXT_OVERFLOW),
        ("invalid api key provided", 401, AUTH),
        ("content policy violation", None, POLICY),
        ("ECONNRESET while streaming", None, NETWORK),
        ("quota exhausted for this month", None, QUOTA),
        ("provider internal error", 500, PROVIDER),
    ]
    for text, code, want in cases:
        got = classify(text, code)
        assert got == want, f"{text!r} → {got}，期望 {want}"

    # 策略表：auth/policy 零重试；rate_limit 有界退避且允许 fallback
    assert policy_for(AUTH).max_retries == 0
    assert policy_for(POLICY).allow_fallback is False
    rl = policy_for(RATE_LIMIT)
    assert rl.max_retries >= 2 and rl.allow_fallback
    # 退避指数增长；不可重试类延迟为 0
    assert backoff_delay(RATE_LIMIT, 0) < backoff_delay(RATE_LIMIT, 1)
    assert backoff_delay(AUTH, 0) == 0.0


# ── Phase 7 深化：父运行验收边界的批量契约 ──────────────────────────────────

def test_enforce_contracts_rejects_empty_deliveries():
    """空交付不能算完成。

    语义更新（P0-1）：enforce_contracts 是"报告格式规范"，不是成果判官——
    空交付挂 severity=warn 的 contract 警告并计入返回的警告数，但绝不改写
    r["ok"]（翻转 ok 只属于 validator 业务校验路径）。无 type 的条目按未知
    persona 跳过校验，因此这里显式给文本型 persona（researcher）以命中
    "空交付"警告路径。
    """
    from team import enforce_contracts
    results = [
        {"ok": True, "type": "researcher", "text": "认真完成的结论"},
        {"ok": True, "type": "researcher", "text": ""},      # 空文本顶 ok → 警告
        {"ok": True, "type": "researcher", "text": "   "},   # 纯空白同样警告
        {"ok": False, "error": "boom"},                      # 已失败条目不动
    ]
    warnings = enforce_contracts(results)
    assert warnings == 2
    # 正常交付通过契约
    assert results[0]["ok"] is True
    assert results[0]["contract"]["ok"] is True
    # 空交付：ok 保留（工作成果不因报告格式被销毁），但契约亮黄牌
    assert results[1]["ok"] is True
    assert results[1]["contract"]["ok"] is False
    assert results[1]["contract"]["severity"] == "warn"
    assert any("empty delivery" in p for p in results[1]["contract"]["problems"])
    assert results[2]["contract"]["severity"] == "warn"
    assert results[3] == {"ok": False, "error": "boom"}, \
        "已如实呈现的失败不再二次改写"


# ── Phase 7 深化：DAG 任务租约——同一 id 的并发重试不双跑 ────────────────────

def test_dag_lease_blocks_duplicate_task_id(tmp_path, monkeypatch):
    import asyncio
    import storage as storage_mod
    from subagent_runtime import _run_dag
    from team import acquire_lease, release_lease

    st = Storage(db_dir=str(tmp_path / "db"))
    try:
        monkeypatch.setattr(storage_mod, "get_storage", lambda: st)

        class _Stub:
            async def spawn_batch(self, specs, ctx):
                return [{"ok": True, "type": s.get("subagent_type") or "x",
                         "label": s.get("label") or "", "text": "done",
                         "error": "", "subagent_id": "sid"} for s in specs]

        tasks = [{"id": "same-id", "prompt": "p",
                  "subagent_type": "explore", "label": "L"}]
        layers = [[0]]

        # 常规执行：跑完租约即释放，表里不残留
        r1 = asyncio.run(_run_dag(_Stub(), tasks, {"session_id": "s"}, layers))
        assert r1[0]["ok"] is True
        left = st._db("sessions").execute(
            "SELECT COUNT(*) AS c FROM team_leases").fetchone()["c"]
        assert left == 0, "租约用完即释，不得残留"

        # 另一个运行先持锁 → 同 id 任务以 BLOCKED 呈现，不静默双跑
        assert acquire_lease(st, "dag-task:same-id", "other-run") is True
        r2 = asyncio.run(_run_dag(_Stub(), tasks, {"session_id": "s"}, layers))
        assert r2[0]["status"] == "blocked" and not r2[0]["ok"]
        assert "租约" in r2[0]["blockedReason"]
        release_lease(st, "dag-task:same-id", "other-run")

        # 锁释放后恢复可执行
        r3 = asyncio.run(_run_dag(_Stub(), tasks, {"session_id": "s"}, layers))
        assert r3[0]["ok"] is True
    finally:
        st.close()
