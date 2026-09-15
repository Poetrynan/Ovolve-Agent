"""W3：``task`` 工具的结果契约（result_schema）与后台执行（background）。

两块能力分开测，但同属一个交付：

  A. result_schema —— 调用方显式声明的交付格式。与既有的 persona 级
     ResultContract **刻意不同**：persona 契约是格式建议，失败只挂警告、
     绝不改写 ok（P0 规则）；而 result_schema 是调用方明确提的要求，
     所以失败一次后重试一次，再失败就**如实报错**，不许静默成功。

  B. background —— 派发即返回，用 run_id 事后取件。后台任务同样计入
     MAX_CONCURRENT_SUBAGENTS，且单个 turn 有上限，避免把并发预算吃光。

A 的重试逻辑抽成了可注入 run_once 的接缝，所以不用起真模型就能测到
"重试一次 / 再失败如实报"这条路径。
"""
from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from subagent_runtime import (
    MAX_CONCURRENT_SUBAGENTS,
    MAX_BACKGROUND_PER_TURN,
    SubagentStatus,
    normalize_result_schema,
    parse_result_payload,
    validate_result_payload,
    schema_retry_prompt,
    run_with_result_schema,
    get_subagent_runtime,
    TASK_TOOL_SCHEMA,
)


# ── A1. 归一化：JSON-Schema 子集 → 既有 {required, types} 契约 ────────────

class TestNormalizeResultSchema:
    """DRY：不另造校验器，把 JSON-Schema 子集归一化成 team.check_result_contract
    能吃的形状，复用既有两算子。"""

    def test_object_with_properties_and_required(self):
        got = normalize_result_schema({
            "type": "object",
            "properties": {"summary": {"type": "string"},
                           "issues": {"type": "array"}},
            "required": ["summary"],
        })
        assert got["required"] == ["summary"]
        assert got["types"] == {"summary": str, "issues": list}

    def test_types_mapping_covers_json_types(self):
        got = normalize_result_schema({
            "type": "object",
            "properties": {"s": {"type": "string"}, "n": {"type": "integer"},
                           "f": {"type": "number"}, "b": {"type": "boolean"},
                           "a": {"type": "array"}, "o": {"type": "object"}},
        })
        assert got["types"] == {"s": str, "n": int, "f": float,
                                "b": bool, "a": list, "o": dict}

    def test_required_defaults_to_empty(self):
        got = normalize_result_schema({"type": "object",
                                       "properties": {"a": {"type": "string"}}})
        assert got["required"] == []

    def test_named_schema_string_is_resolved(self):
        """传字符串 = 引用内置 persona 契约，不必内联重复。"""
        got = normalize_result_schema("reviewer")
        assert "verdict" in got["required"] and "issues" in got["required"]

    def test_rejects_non_object_root(self):
        with pytest.raises(ValueError):
            normalize_result_schema({"type": "array"})

    def test_rejects_non_dict_non_str(self):
        with pytest.raises(ValueError):
            normalize_result_schema(123)

    def test_unknown_property_type_rejected(self):
        """未知类型必须报错，不能静默当成 object 放行。"""
        with pytest.raises(ValueError):
            normalize_result_schema({
                "type": "object",
                "properties": {"x": {"type": "quantum"}},
            })

    def test_required_key_must_be_declared_in_properties(self):
        with pytest.raises(ValueError):
            normalize_result_schema({
                "type": "object",
                "properties": {"a": {"type": "string"}},
                "required": ["b"],
            })


# ── A2. 载荷解析：子代理交回的是自然语言 + JSON ──────────────────────────

class TestParseResultPayload:
    def test_plain_json(self):
        ok, data, err = parse_result_payload('{"summary": "done"}')
        assert ok and data == {"summary": "done"} and err == ""

    def test_fenced_json_block(self):
        text = 'Here you go:\n```json\n{"summary": "done"}\n```\n'
        ok, data, _ = parse_result_payload(text)
        assert ok and data == {"summary": "done"}

    def test_json_embedded_in_prose(self):
        ok, data, _ = parse_result_payload('I finished. {"summary": "done"} thanks')
        assert ok and data["summary"] == "done"

    def test_garbage_reports_readable_error(self):
        ok, data, err = parse_result_payload("no json at all")
        assert not ok and data is None
        assert "JSON" in err or "json" in err

    def test_empty_text_reports_readable_error(self):
        ok, data, err = parse_result_payload("")
        assert not ok and err


# ── A3. 校验：解析 + 契约 ───────────────────────────────────────────────

class TestValidateResultPayload:
    SCHEMA = {"type": "object",
              "properties": {"summary": {"type": "string"},
                             "issues": {"type": "array"}},
              "required": ["summary"]}

    def test_valid_payload(self):
        ok, data, err = validate_result_payload(
            '{"summary": "ok", "issues": []}', self.SCHEMA)
        assert ok and data["summary"] == "ok" and err == ""

    def test_missing_required_key(self):
        ok, _data, err = validate_result_payload('{"issues": []}', self.SCHEMA)
        assert not ok and "summary" in err

    def test_wrong_type(self):
        ok, _data, err = validate_result_payload(
            '{"summary": 42}', self.SCHEMA)
        assert not ok and "summary" in err

    def test_bool_is_not_an_int(self):
        """JSON 里 true 不该被当成整数通过——bool 是 int 子类，容易漏。"""
        schema = {"type": "object", "properties": {"n": {"type": "integer"}},
                  "required": ["n"]}
        ok, _data, err = validate_result_payload('{"n": true}', schema)
        assert not ok and "n" in err

    def test_extra_keys_allowed(self):
        """前向兼容：多给的键不拦（与既有 check_result_contract 一致）。"""
        ok, _data, _err = validate_result_payload(
            '{"summary": "ok", "extra": 1}', self.SCHEMA)
        assert ok


# ── A4. 重试编排：跑一次 → 失败带上错误重试一次 → 再失败如实报 ──────────

class TestRunWithResultSchema:
    SCHEMA = {"type": "object",
              "properties": {"summary": {"type": "string"}},
              "required": ["summary"]}

    @pytest.mark.asyncio
    async def test_first_attempt_valid_no_retry(self):
        calls = []

        async def run_once(prompt):
            calls.append(prompt)
            return '{"summary": "ok"}', True

        out = await run_with_result_schema(run_once, "do it", self.SCHEMA)
        assert out["ok"] and out["attempts"] == 1
        assert len(calls) == 1
        assert out["payload"] == {"summary": "ok"}

    @pytest.mark.asyncio
    async def test_invalid_then_valid_retries_once_with_error(self):
        seen = []

        async def run_once(prompt):
            seen.append(prompt)
            if len(seen) == 1:
                return "totally not json", True
            return '{"summary": "ok"}', True

        out = await run_with_result_schema(run_once, "do it", self.SCHEMA)
        assert out["ok"] and out["attempts"] == 2
        # 第二次的 prompt 必须带上第一次的错误，否则重试就是撞运气
        assert len(seen) == 2 and seen[1] != seen[0]
        assert "JSON" in seen[1] or "json" in seen[1]

    @pytest.mark.asyncio
    async def test_invalid_twice_reports_honestly(self):
        async def run_once(prompt):
            return "still not json", True

        out = await run_with_result_schema(run_once, "do it", self.SCHEMA)
        assert not out["ok"]                       # 绝不静默成功
        assert out["attempts"] == 2                # 只重试一次
        assert out["schema_error"]                 # 如实带出原因
        assert out["text"] == "still not json"     # 原文保留，便于人看

    @pytest.mark.asyncio
    async def test_no_schema_is_a_passthrough(self):
        async def run_once(prompt):
            return "free-form prose", True

        out = await run_with_result_schema(run_once, "do it", None)
        assert out["ok"] and out["attempts"] == 1 and out["text"] == "free-form prose"

    @pytest.mark.asyncio
    async def test_underlying_failure_does_not_retry_for_schema(self):
        """子代理本身跑挂了 → 不该为了 schema 再烧一次模型调用。"""
        calls = []

        async def run_once(prompt):
            calls.append(prompt)
            return "", False

        out = await run_with_result_schema(run_once, "do it", self.SCHEMA)
        assert not out["ok"] and len(calls) == 1


def test_schema_retry_prompt_states_the_error_and_the_shape():
    p = schema_retry_prompt("original task", "missing key: summary")
    assert "original task" in p
    assert "missing key: summary" in p


# ── A5. tool schema 暴露 ───────────────────────────────────────────────

class TestTaskToolSchema:
    def test_result_schema_is_offered_per_task(self):
        item = TASK_TOOL_SCHEMA["properties"]["tasks"]["items"]["properties"]
        assert "result_schema" in item

    def test_background_is_offered(self):
        assert "background" in TASK_TOOL_SCHEMA["properties"]

    def test_background_defaults_false(self):
        assert TASK_TOOL_SCHEMA["properties"]["background"].get("default") is False


# ── B. 后台执行 ─────────────────────────────────────────────────────────

class TestBackgroundExecution:
    def test_backgrounded_status_exists_and_is_not_terminal(self):
        from subagent_runtime import TERMINAL_STATUSES
        assert SubagentStatus.BACKGROUNDED.value == "backgrounded"
        assert SubagentStatus.BACKGROUNDED not in TERMINAL_STATUSES

    def test_per_turn_cap_is_four(self):
        assert MAX_BACKGROUND_PER_TURN == 4

    def test_background_counts_against_global_cap(self):
        """后台不是"绕过并发预算"的后门。"""
        assert MAX_BACKGROUND_PER_TURN <= MAX_CONCURRENT_SUBAGENTS

    def test_unknown_run_id_reports_miss(self):
        rt = get_subagent_runtime()
        out = rt.task_result("run_does_not_exist")
        assert out["status"] == "MISS"

    def test_task_result_shape(self):
        rt = get_subagent_runtime()
        out = rt.task_result("run_does_not_exist")
        assert set(out.keys()) >= {"status", "run_id"}

    def test_orphan_recovery_includes_backgrounded(self):
        """进程重启后后台任务同样会变孤儿，扫描必须覆盖到。"""
        import inspect
        src = inspect.getsource(
            __import__("subagent_runtime").recover_orphaned_subagents)
        assert "BACKGROUNDED" in src

    def test_done_run_round_trips_its_result(self):
        """派发 → 取件必须真的能拿到东西，否则 run_id 是个死胡同。"""
        import asyncio

        rt = get_subagent_runtime()

        async def fake_spawn_one(subagent_type, prompt, parent_ctx, **kw):
            return {"ok": True, "text": f"did {prompt}", "type": subagent_type,
                    "subagent_id": "x", "error": "", "payload": None,
                    "schema_error": ""}

        async def go():
            rt.spawn_one = fake_spawn_one          # type: ignore[assignment]
            got = rt.start_background("explore", "scan the repo", {})
            assert got["status"] == "backgrounded" and got["run_id"]
            # 后台派发后事件循环需要转一圈让 _runner 跑完
            for _ in range(50):
                await asyncio.sleep(0)
            return rt.task_result(got["run_id"])

        out = asyncio.run(go())
        assert out["status"] == "DONE" and out["ok"] is True
        assert out["text"] == "did scan the repo"

    def test_failed_run_reports_error_not_silent_success(self):
        import asyncio

        rt = get_subagent_runtime()

        async def fake_spawn_one(subagent_type, prompt, parent_ctx, **kw):
            return {"ok": False, "text": "", "type": subagent_type,
                    "subagent_id": "x", "error": "boom", "payload": None,
                    "schema_error": ""}

        async def go():
            rt.spawn_one = fake_spawn_one          # type: ignore[assignment]
            got = rt.start_background("coder", "patch it", {})
            for _ in range(50):
                await asyncio.sleep(0)
            return rt.task_result(got["run_id"])

        out = asyncio.run(go())
        assert out["status"] == "DONE" and out["ok"] is False
        assert "boom" in out["error"]


class TestTaskHandlerBackgroundGuards:
    """守卫必须在**派发之前**生效——先派发再报错等于预算已经花掉了。"""

    @pytest.mark.asyncio
    async def test_over_cap_refused_without_dispatch(self):
        from subagent_runtime import _task_handler
        tasks = [{"subagent_type": "explore", "prompt": f"p{i}"}
                 for i in range(MAX_BACKGROUND_PER_TURN + 1)]
        r = await _task_handler({"tasks": tasks, "background": True}, {})
        assert not r.ok
        assert str(MAX_BACKGROUND_PER_TURN) in r.error

    @pytest.mark.asyncio
    async def test_background_with_depends_on_refused(self):
        from subagent_runtime import _task_handler
        r = await _task_handler({
            "tasks": [
                {"subagent_type": "explore", "prompt": "a", "id": "a"},
                {"subagent_type": "coder", "prompt": "b", "depends_on": ["a"]},
            ],
            "background": True,
        }, {})
        assert not r.ok
        assert "background" in r.error

    @pytest.mark.asyncio
    async def test_background_dispatch_returns_run_ids(self, monkeypatch):
        import subagent_runtime as sr

        class _Stub:
            def __init__(self):
                self.calls = []

            def start_background(self, stype, prompt, ctx, **kw):
                self.calls.append((stype, prompt, kw.get("result_schema")))
                return {"run_id": f"bg_{len(self.calls)}",
                        "status": "backgrounded"}

        stub = _Stub()
        monkeypatch.setattr(sr, "get_subagent_runtime", lambda: stub)
        r = await sr._task_handler({
            "tasks": [{"subagent_type": "explore", "prompt": "a",
                       "result_schema": {"type": "object", "properties": {}}}],
            "background": True,
        }, {})
        assert r.ok
        assert r.meta["backgrounded"] is True and r.meta["run_ids"] == ["bg_1"]
        # result_schema 必须透传下去，否则"传了但没用"又是一次假接线
        assert stub.calls[0][2] == {"type": "object", "properties": {}}
        assert "task_result" in r.value
