"""
team.py — Subagent Team 协作原语（Phase 7 首切片）。

总指令 §13：多 Agent 的目标不是数量，而是成功率、验证率、恢复率。四个原语：

* RoleSpec       —— 角色即配置：工具白名单、预算、结果 schema 的预设
* TaskLease      —— 原子租约：同一任务同一时刻只有一个持有者，过期可抢
* ResultContract —— 结果契约：子代理交付必须过 schema 检查才被父运行接受
* TeamBoard      —— 看板：一个 parent run 名下所有子任务的状态一览

子代理不能直接改父运行的事实状态——只能通过 ResultContract + 事件交付。
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


# ── M-3: TaskSpec (Spec-Driven 派单合同) ───────────────────────────────────

@dataclass
class TaskSpec:
    """Spec-Driven 结构化派单合同。

    明确边界与验收断言，预取符号上下文，降低探索返工率与 Token 开销。
    """
    goal: str
    in_scope: List[str] = field(default_factory=list)
    out_of_scope: List[str] = field(default_factory=list)
    acceptance: List[str] = field(default_factory=list)
    context_refs: List[Dict[str, Any]] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "goal": self.goal,
            "in_scope": list(self.in_scope),
            "out_of_scope": list(self.out_of_scope),
            "acceptance": list(self.acceptance),
            "context_refs": list(self.context_refs),
            "metadata": dict(self.metadata),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> TaskSpec:
        d = dict(data or {})
        return cls(
            goal=str(d.get("goal") or ""),
            in_scope=list(d.get("in_scope") or []),
            out_of_scope=list(d.get("out_of_scope") or []),
            acceptance=list(d.get("acceptance") or []),
            context_refs=list(d.get("context_refs") or []),
            metadata=dict(d.get("metadata") or {}),
        )


def build_task_spec(
    goal: str,
    in_scope: Optional[List[str]] = None,
    out_of_scope: Optional[List[str]] = None,
    acceptance: Optional[List[str]] = None,
    context_refs: Optional[List[Dict[str, Any]]] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """构造结构化派单合同字典。若 goal 为空抛出 ValueError。"""
    if not goal or not isinstance(goal, str) or not goal.strip():
        raise ValueError("goal must be a non-empty string")
    spec = TaskSpec(
        goal=goal.strip(),
        in_scope=list(in_scope or []),
        out_of_scope=list(out_of_scope or []),
        acceptance=list(acceptance or []),
        context_refs=list(context_refs or []),
        metadata=dict(metadata or {}),
    )
    return spec.to_dict()


def validate_task_spec(spec_data: Any) -> tuple[bool, List[str]]:
    """校验派单合同有效性与完备度，检测 spec_ambiguity（缺少 acceptance 等）。"""
    problems: List[str] = []
    d = spec_data.to_dict() if hasattr(spec_data, "to_dict") else spec_data
    if not isinstance(d, dict):
        return False, [f"task spec must be dict or TaskSpec, got {type(spec_data).__name__}"]

    goal = str(d.get("goal") or "").strip()
    if not goal:
        problems.append("missing goal in spec")

    acceptance = d.get("acceptance")
    if not isinstance(acceptance, (list, tuple)) or not acceptance:
        problems.append("missing acceptance criteria in spec (spec_ambiguity)")

    for field_name in ("in_scope", "out_of_scope", "context_refs"):
        if field_name in d and not isinstance(d[field_name], (list, tuple)):
            problems.append(f"field '{field_name}' must be a list")

    return (len(problems) == 0), problems


def prefetch_context_refs(
    symbols: List[str],
    root_dir: str = "",
    graph: Any = None,
) -> List[Dict[str, Any]]:
    """使用 CKG / 代码符号索引预取关键符号定义与上下文，注入派单合同。"""
    if not symbols:
        return []

    refs: List[Dict[str, Any]] = []
    try:
        if graph is None:
            try:
                from code_graph import get_code_graph
                graph = get_code_graph(root_dir) if root_dir else None
            except Exception:
                pass

        if graph is not None and hasattr(graph, "find_symbol"):
            for sym in symbols:
                res = graph.find_symbol(sym)
                if res:
                    refs.append({
                        "symbol": sym,
                        "path": str(res.get("file") or res.get("path") or ""),
                        "line": int(res.get("line") or 0),
                        "kind": str(res.get("kind") or "symbol"),
                        "doc": str(res.get("doc") or "")[:200],
                    })
    except Exception:
        pass

    if not refs:
        # 降级占位回退，保证派单合同格式统一
        for sym in symbols:
            refs.append({
                "symbol": sym,
                "path": "",
                "line": 0,
                "kind": "reference",
            })
    return refs


# ── M-1 & M-2: Reviewer-Critic 结构化分歧裁决与四视角模板 ─────────────────

REVIEW_PERSPECTIVE_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "security": {
        "name": "Security Audit",
        "focus": "Vulnerabilities, injection risks, credential leakage, path traversal, untrusted input handling",
        "tools": ["read_text", "search_code", "diff_files"],
    },
    "perf": {
        "name": "Performance Analysis",
        "focus": "Algorithmic complexity, quadratic loops, redundant I/O, regex recompilation, memory bloat",
        "tools": ["read_text", "search_code", "diff_files"],
    },
    "maintainability": {
        "name": "Maintainability Review",
        "focus": "Modularity, naming clarity, cyclomatic complexity, code duplication, adherence to conventions",
        "tools": ["read_text", "search_code", "diff_files"],
    },
    "test-coverage": {
        "name": "Test & Reliability Verification",
        "focus": "Missing unit tests, untested edge cases, assertion validity, regression prevention, swallowed exceptions",
        "tools": ["read_text", "search_code", "diff_files"],
    },
}


class ReviewVerdict:
    """Reviewer-Critic 结构化分歧裁决状态三态。"""
    CONFIRMED = "confirmed"    # 经 Critic 验证确凿成立的缺陷，回灌修复
    REJECTED = "rejected"      # 确认为假阳性或误报，记录理由后丢弃
    ESCALATED = "escalated"    # 高风险或上下文歧义边缘情况，升级给用户/开发者裁决


def adjudicate_review_findings(
    findings: List[Any],
    critic_fn: Optional[Callable[[Any], tuple[str, str]]] = None,
) -> Dict[str, List[Any]]:
    """Reviewer-Critic 结构化分歧裁决器。

    将评审意见经 Critic 验证后分类为 confirmed / rejected / escalated 三态。
    """
    groups: Dict[str, List[Any]] = {
        ReviewVerdict.CONFIRMED: [],
        ReviewVerdict.REJECTED: [],
        ReviewVerdict.ESCALATED: [],
    }

    for f in findings:
        if critic_fn is not None:
            try:
                verdict, reason = critic_fn(f)
                if hasattr(f, "verdict"):
                    f.verdict = verdict
                    f.verdict_reason = reason
                elif isinstance(f, dict):
                    f["verdict"] = verdict
                    f["verdict_reason"] = reason
            except Exception as e:
                verdict = ReviewVerdict.ESCALATED
                if hasattr(f, "verdict"):
                    f.verdict = verdict
                    f.verdict_reason = f"Critic verification error: {e}"
                elif isinstance(f, dict):
                    f["verdict"] = verdict
                    f["verdict_reason"] = f"Critic verification error: {e}"

        v = getattr(f, "verdict", None) or (f.get("verdict") if isinstance(f, dict) else None)
        v_clean = str(v or "").lower()
        if v_clean in groups:
            groups[v_clean].append(f)
        else:
            groups[ReviewVerdict.CONFIRMED].append(f)

    return groups


# ── RoleSpec 预设（§13 推荐角色）────────────────────────────────────────────
# 工具名称必须与 ToolRegistry 注册的 canonical 真实名称严格一致：
# read_text, search_code, find_files, list_dir, diff_files, get_file_info,
# write_file, edit_file, delete_file, move_file, copy_file,
# git_status, git_diff, git_log, git_add, git_commit,
# shell_executor, python_executor, web_search, web_fetch, etc.

ROLE_PRESETS: Dict[str, Dict[str, Any]] = {
    "planner": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir", "get_file_info",
            "goal_plan_create", "goal_plan_update",
        ],
        "budget_tokens": 60_000,
        "result_schema": {"required": ["plan"], "types": {"plan": list}},
    },
    "researcher": {
        "tools": [
            "web_search", "web_fetch", "academic_search", "read_text",
            "search_code", "find_files", "list_dir", "get_file_info",
        ],
        "budget_tokens": 120_000,
        "result_schema": {"required": ["findings"], "types": {"findings": list}},
    },
    "coder": {
        "tools": [
            "read_file", "read_text", "write_file", "edit_file", "delete_file", "move_file", "copy_file",
            "git_status", "git_diff", "git_log", "git_add", "git_commit",
            "shell_executor", "python_executor",
        ],
        "budget_tokens": 200_000,
        "result_schema": {"required": ["patch_summary"],
                          "types": {"patch_summary": str}},
    },
    "reviewer": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir",
            "get_file_info", "diff_files", "git_status", "git_diff", "git_log",
        ],
        "budget_tokens": 80_000,
        "result_schema": {"required": ["verdict", "issues"],
                          "types": {"verdict": str, "issues": list}},
    },
    "validator": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir",
            "get_file_info", "diff_files", "git_status", "git_diff",
            "shell_executor", "python_executor",
        ],
        "budget_tokens": 80_000,
        "result_schema": {"required": ["passed", "evidence"],
                          "types": {"passed": bool}},
    },
    "memory_curator": {
        "tools": ["read_text", "list_dir", "memory_query", "memory_store"],
        "budget_tokens": 40_000,
        "result_schema": {"required": ["proposals"],
                          "types": {"proposals": list}},
    },
    "explore": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir", "get_file_info", "diff_files",
            "git_status", "git_diff", "git_log",
        ],
        "budget_tokens": 60_000,
        "result_schema": {"required": ["findings"], "types": {"findings": list}},
    },
    "diagnostician": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir", "get_file_info",
            "git_status", "git_diff", "git_log", "diagnose",
        ],
        "budget_tokens": 50_000,
        "result_schema": {"required": ["observations"], "types": {"observations": list}},
    },
}


def role_spec(role: str, *, overrides: Dict[str, Any] | None = None) -> Dict[str, Any]:
    """取角色预设。未知角色返回受限的通用白名单——宁缺勿滥。"""
    base = ROLE_PRESETS.get(
        role,
        {"tools": [], "budget_tokens": 50_000,
         "result_schema": {"required": ["summary"], "types": {"summary": str}}},
    )
    spec = {
        "role": role,
        "tools": list(overrides.get("tools") or base["tools"]) if overrides else list(base["tools"]),
        "budget_tokens": int((overrides or {}).get("budget_tokens") or base["budget_tokens"]),
        "result_schema": dict(base["result_schema"]),
        "deadline_s": int((overrides or {}).get("deadline_s") or 600),
    }
    return spec


# ── F3: ModelRole 分模型路由─────────────────────────────
# 常见 Agent 运行时定义 ModelRole = {Main, Compact, Lite, Review, Subagent}，子代理与压缩
# 自动路由到更便宜模型。Ovolve 已有 model_override，升级为按 persona 自动路由。

# 角色档位
MODEL_ROLES = {"main", "compact", "lite", "review", "subagent"}

# persona → 默认档位映射（建议：重推理用 main，轻任务用 lite/review）
ROLE_MODEL_ROLE_DEFAULTS: Dict[str, str] = {
    "planner": "main",
    "coder": "main",
    "researcher": "lite",
    "explore": "lite",
    "reviewer": "review",
    "validator": "review",
    "verifier": "review",
    "diagnostician": "lite",
    "memory_curator": "lite",
}

# 将 ROLE_PRESETS 里每个 persona 补上 model_role 键（单一来源）
for _preset_name, _preset in ROLE_PRESETS.items():
    if "model_role" not in _preset:
        _preset["model_role"] = ROLE_MODEL_ROLE_DEFAULTS.get(_preset_name, "subagent")


def resolve_model_for_role(role: str, config: Dict[str, Any] | None = None) -> Optional[str]:
    """F3: 档位 → 实际模型解析。

    从 config 的 `subagent.model_roles.<role>` 读取，未配置返回 None（继承父）。
    配置键形如: subagent.model_roles.lite = "siliconflow:deepseek-ai/DeepSeek-V4-Flash"
    """
    if not config or role not in MODEL_ROLES:
        return None
    subagent_cfg = config.get("subagent") if isinstance(config, dict) else None
    if not isinstance(subagent_cfg, dict):
        return None
    roles_cfg = subagent_cfg.get("model_roles") if isinstance(subagent_cfg.get("model_roles"), dict) else {}
    model = roles_cfg.get(role)
    return str(model) if model else None


def resolve_subagent_model(
    persona: str,
    model_override: Optional[str] = None,
    persona_model: Optional[str] = None,
    config: Dict[str, Any] | None = None,
) -> tuple[Optional[str], str]:
    """F3: 解析子代理最终使用的模型。

    优先级: model_override（显式） > persona_model（persona 显式） >
              ROLE_MODEL_ROLE_DEFAULTS[persona]→config 档位 > 继承父模型

    返回: (model_id, model_role_label)
    """
    # 1. 显式 override 永远赢
    if model_override:
        return model_override, "explicit"
    # 2. persona 级显式 model
    if persona_model:
        return persona_model, "explicit"
    # 3. 按角色档位自动路由
    role = ROLE_MODEL_ROLE_DEFAULTS.get(persona, "subagent")
    resolved = resolve_model_for_role(role, config)
    if resolved:
        return resolved, role
    # 4. 继承父模型
    return None, "inherit"


# ── ResultContract ──────────────────────────────────────────────────────────

def check_result_contract(payload: Any, schema: Dict[str, Any]) -> tuple[bool, List[str]]:
    """交付物契约检查：required 键在、类型对。多余键不拦——前向兼容。"""
    problems: List[str] = []
    if not isinstance(payload, dict):
        return False, [f"payload must be a dict, got {type(payload).__name__}"]
    for key in schema.get("required") or []:
        if key not in payload:
            problems.append(f"missing key: {key}")
    types = schema.get("types") or {}
    pytype = {str: str, list: list, dict: dict, bool: bool, int: int, float: float}
    for key, want in types.items():
        if key not in payload:
            continue
        value = payload[key]
        # bool 是 int 的子类，所以 `isinstance(True, int)` 为真——要求 int 时
        # 必须先把 bool 挑出来，否则 JSON 里的 `true` 会冒充 1 通过校验。
        # （这行以前被写在 isinstance 的 else 分支里，而 isinstance(True, int)
        # 恰好为真，于是整个 bool 检查从来没执行过。）
        if want is int and isinstance(value, bool):
            problems.append(f"key {key}: expected int, got bool")
            continue
        if not isinstance(value, pytype.get(want, object)):
            problems.append(f"key {key}: expected {want}, "
                            f"got {type(value).__name__}")
    return (not problems), problems


_SUMMARY_CONTRACT = {"required": ["summary"], "types": {"summary": str}}

PERSONA_RESULT_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "ResultContract.v1": {"required": ["summary"], "types": {"summary": str}},
    "explore": {"required": ["findings"], "types": {"findings": list}},
    "researcher": {"required": ["findings"], "types": {"findings": list}},
    "reviewer": {"required": ["verdict", "issues"], "types": {"verdict": str, "issues": list}},
    "planner": {"required": ["plan"], "types": {"plan": list}},
    "coder": {"required": ["patch_summary"], "types": {"patch_summary": str}},
    "validator": {"required": ["passed"], "types": {"passed": bool}},
    "diagnostician": {"required": ["observations"], "types": {"observations": list}},
}


def get_persona_contract(persona_name: str, result_schema: Optional[str] = None) -> Dict[str, Any]:
    """Get the ResultContract schema for a persona."""
    if result_schema and result_schema in PERSONA_RESULT_SCHEMAS:
        return PERSONA_RESULT_SCHEMAS[result_schema]
    if persona_name in PERSONA_RESULT_SCHEMAS:
        return PERSONA_RESULT_SCHEMAS[persona_name]
    return _SUMMARY_CONTRACT


def _emit_contract_telemetry(warnings: int, total: int, persona_breakdown: dict) -> None:
    """Emit a telemetry span for contract enforcement observability.

    P1: Contract rejection rate must be visible — a 100% rejection rate should
    surface within minutes, not during a manual benchmark run.
    """
    try:
        from telemetry import Span, SpanName, flush_span
        span = Span(
            name=SpanName.CONTRACT_ENFORCE.value,
            start_time=time.time(),
            end_time=time.time(),
            attributes={
                "contract.total": total,
                "contract.warnings": warnings,
                "contract.warning_rate": round(warnings / max(total, 1), 3),
                "contract.persona_breakdown": json.dumps(persona_breakdown),
            },
        )
        if warnings > 0:
            span.add_event("contract_warning", count=warnings)
        flush_span(span)
    except Exception:
        pass  # 遥测失败绝不影响主流程


def _emit_quarantine_telemetry(sub_id: str, reason: str, path: str | None, changes_count: int) -> None:
    """Emit a telemetry span for sub-agent overlay quarantine."""
    try:
        from telemetry import Span, SpanName, flush_span
        span = Span(
            name=SpanName.SUBAGENT_QUARANTINE.value,
            start_time=time.time(),
            end_time=time.time(),
            attributes={
                "quarantine.sub_id": sub_id,
                "quarantine.reason": reason,
                "quarantine.changes_count": changes_count,
                "quarantine.saved": path is not None,
            },
        )
        flush_span(span)
    except Exception:
        pass


def enforce_contracts(results: list, work_copies: dict | None = None) -> int:
    """对一批子代理交付做契约验收（§13 的验收边界）。

    核心原则（P0 修复）：
    - 契约是报告格式规范，不是工作成果的判官
    - 契约失败只挂警告，绝不改写 r["ok"]、绝不销毁 overlay
    - 空文本但 overlay 有实际改动 → 从 diff 派生摘要，自动修复
    - 验收判据按 persona 分型：coder 判 diff，researcher 判 prose

    返回契约警告数量（非拒收数量）。
    """
    warnings = 0
    work_copies = work_copies or {}

    for r in results:
        if not isinstance(r, dict) or not r.get("ok"):
            continue
        text = str(r.get("text") or "").strip()
        p_type = str(r.get("type") or "")
        schema = get_persona_contract(p_type)
        payload = r.get("payload") if isinstance(r.get("payload"), dict) else {}

        # ── 智能适配：从 text 推导结构化字段 ──────────────────────────────
        if "summary" not in payload and text:
            payload["summary"] = text
        if p_type in ("explore", "researcher") and "findings" not in payload:
            lines = [l.strip("- *• ") for l in text.splitlines() if l.strip()]
            payload["findings"] = lines if lines else [text]
        elif p_type == "planner" and "plan" not in payload:
            lines = [l.strip("- *0123456789.• ") for l in text.splitlines() if l.strip()]
            payload["plan"] = lines if lines else [text]
        elif p_type == "reviewer":
            if "verdict" not in payload:
                payload["verdict"] = "approved" if ("pass" in text.lower() or "ok" in text.lower() or "通过" in text) and "fail" not in text.lower() else "changes_requested"
            if "issues" not in payload:
                payload["issues"] = [l.strip("- *• ") for l in text.splitlines() if any(k in l.lower() for k in ("issue", "error", "warn", "fix", "问题", "缺陷"))]
        elif p_type == "coder" and "patch_summary" not in payload:
            payload["patch_summary"] = text
        elif p_type in ("validator", "verifier"):
            if "passed" not in payload:
                payload["passed"] = bool(("pass" in text.lower() or "ok" in text.lower() or "通过" in text or "成功" in text) and "fail" not in text.lower() and "失败" not in text)
            if "evidence" not in payload:
                payload["evidence"] = [text]
        elif p_type == "diagnostician" and "observations" not in payload:
            lines = [l.strip("- *• ") for l in text.splitlines() if l.strip()]
            payload["observations"] = lines if lines else [text]

        # ── validator 业务验证未通过 → 仍应失败（不因 P0-1 修复而放行）────
        # 注意：这是业务结论（passed=False），不是格式问题
        if p_type in ("validator", "verifier") and payload.get("passed") is False:
            r["ok"] = False
            r["error"] = f"validator check failed: {text or 'verification returned passed=False'}"
            r["contract"] = {
                "ok": False,
                "warning": False,
                "problems": ["validator returned passed=False (business conclusion)"],
                "severity": "error",
            }
            warnings += 1
            r["payload"] = payload
            continue

        # ── P0-2: 空文本 + overlay 有实际改动 → 从 diff 派生摘要 ──────────
        sub_id = r.get("subagent_id", "")
        wc = work_copies.get(sub_id) if sub_id else None
        has_actual_changes = wc is not None and bool(wc.changes())

        if not text and has_actual_changes:
            # 模型改了文件但没写总结 → 从 overlay diff 派生 patch_summary
            changed_paths = [c["rel"] for c in wc.changes() if c["kind"] == "write"]
            deleted_paths = [c["rel"] for c in wc.changes() if c["kind"] == "delete"]
            parts = []
            if changed_paths:
                parts.append("modified " + ", ".join(changed_paths[:5]))
            if deleted_paths:
                parts.append("deleted " + ", ".join(deleted_paths[:5]))
            derived_summary = "; ".join(parts)
            payload["patch_summary"] = derived_summary
            if "summary" not in payload:
                payload["summary"] = derived_summary
            r["_contract_note"] = f"auto-derived summary from {len(wc.changes())} file changes"

        # ── P0-4: gate 语义修正 — 无 summary 时按 persona 分型处理 ────
        # 原 bug: payload if payload.get("summary") else {} → 空 dict 必然失败
        # 修正: 没有 summary 时不传空 dict，按交付物类型分流
        if not payload.get("summary") and not payload.get("patch_summary"):
            if p_type in ("coder", "validator", "verifier"):
                # artifact 型 persona: 以 overlay 有改动为准
                if has_actual_changes:
                    # 有实际改动但无摘要 → 已通过 P0-2 补上，继续校验
                    pass
                else:
                    # 无改动无摘要 → 真·空交付，挂警告但不改写 ok
                    r["contract"] = {
                        "ok": False,
                        "warning": True,
                        "problems": ["empty delivery: no text and no file changes"],
                        "severity": "warn",
                    }
                    warnings += 1
                    r["payload"] = payload
                    continue
            elif p_type in ("researcher", "explorer", "planner", "reviewer", "diagnostician"):
                # 文本交付型 persona: 无 summary = 空交付，挂警告
                r["contract"] = {
                    "ok": False,
                    "warning": True,
                    "problems": [f"empty delivery: {p_type} produced no text summary"],
                    "severity": "warn",
                }
                warnings += 1
                r["payload"] = payload
                continue
            else:
                # 未知 persona → 跳过格式校验
                r["contract"] = {"ok": True, "problems": [], "severity": "skip"}
                r["payload"] = payload
                continue

        # ── 契约格式校验（只挂警告，不碰 r["ok"]）────────────────────────
        ok, problems = check_result_contract(payload, schema)
        if not ok:
            r["contract"] = {
                "ok": False,
                "warning": True,
                "problems": problems,
                "severity": "warn",
            }
            warnings += 1
            # P0-1 核心修复：契约失败不改写 ok，只附警告
            r["_contract_warning"] = (
                "contract format mismatch: " + "; ".join(problems)
                + " — work preserved, please improve report format next time"
            )
        else:
            r["contract"] = {"ok": True, "problems": [], "severity": "ok"}

        r["payload"] = payload

    # ── 可观测性：契约执行指标 ────────────────────────────────────────
    persona_breakdown: dict = {}
    for r in results:
        if not isinstance(r, dict):
            continue
        pt = str(r.get("type") or "unknown")
        if pt not in persona_breakdown:
            persona_breakdown[pt] = {"total": 0, "warnings": 0}
        persona_breakdown[pt]["total"] += 1
        if not r.get("contract", {}).get("ok", True):
            persona_breakdown[pt]["warnings"] += 1

    _emit_contract_telemetry(warnings, len([r for r in results if isinstance(r, dict)]), persona_breakdown)

    return warnings


# ── TaskLease ───────────────────────────────────────────────────────────────

_LEASE_DDL = """
CREATE TABLE IF NOT EXISTS team_leases (
    task_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
)
"""


def _ensure_lease_table(storage) -> None:
    c = storage._db("sessions")
    c.execute(_LEASE_DDL)
    c.commit()


def acquire_lease(storage, task_id: str, owner: str, *,
                  ttl_s: int = 900) -> bool:
    """原子抢占租约。已有人持有效租约 → False；过期/无主 → 接管。"""
    _ensure_lease_table(storage)
    now = int(time.time())
    c = storage._db("sessions")
    cur = c.execute(
        "INSERT INTO team_leases (task_id, owner, acquired_at, expires_at)"
        " VALUES (?,?,?,?)"
        " ON CONFLICT(task_id) DO UPDATE SET"
        "   owner=excluded.owner, acquired_at=excluded.acquired_at,"
        "   expires_at=excluded.expires_at"
        " WHERE team_leases.owner=? OR team_leases.expires_at<?",
        (task_id, owner, now, now + ttl_s, owner, now),
    )
    c.commit()
    return cur.rowcount > 0


def release_lease(storage, task_id: str, owner: str) -> bool:
    """只有持有者本人能释放——防误删他人的租约。"""
    _ensure_lease_table(storage)
    c = storage._db("sessions")
    cur = c.execute(
        "DELETE FROM team_leases WHERE task_id=? AND owner=?",
        (task_id, owner),
    )
    c.commit()
    return cur.rowcount > 0


# ── TeamBoard ───────────────────────────────────────────────────────────────

class TeamBoard:
    """一个 parent run 的看板：角色、租约、交付是否过契，一眼看全。

    状态真相仍在 subagent_runs 台账与事件流里；看板是投影，丢了可重建。
    支持 DAG 依赖拓扑（depends_on）与失败级联阻塞（blocked）。
    """

    def __init__(self, storage, parent_run_id: str):
        self.storage = storage
        self.parent_run_id = parent_run_id
        self._tasks: Dict[str, dict] = {}

    def add_task(self, task_id: str, role: str, *,
                 depends_on: Optional[List[str]] = None,
                 overrides: Dict[str, Any] | None = None,
                 task_spec: Optional[TaskSpec | Dict[str, Any]] = None) -> Dict[str, Any]:
        spec = role_spec(role, overrides=overrides)
        spec_contract = None
        if task_spec:
            spec_contract = task_spec.to_dict() if hasattr(task_spec, "to_dict") else dict(task_spec)

        entry = {
            "task_id": task_id, "role": role, "spec": spec,
            "status": "pending",          # pending|leased|delivered|rejected|failed|blocked
            "lease_owner": "", "result": None, "contract_problems": [],
            "review_status": "none",      # none|approved|changes_requested|rejected|confirmed|escalated
            "review_note": "",
            "depends_on": list(depends_on or []),
            "spec_contract": spec_contract,
        }
        self._tasks[task_id] = entry
        return entry

    def get_task_spec(self, task_id: str) -> Optional[TaskSpec]:
        """获取指定任务绑定的 Spec-Driven 合同。"""
        t = self._tasks.get(task_id)
        if not t or not t.get("spec_contract"):
            return None
        return TaskSpec.from_dict(t["spec_contract"])

    def can_run(self, task_id: str) -> bool:
        """检查任务的前置依赖是否全部成功交付。"""
        t = self._tasks.get(task_id)
        if not t or t["status"] != "pending":
            return False
        for dep in t.get("depends_on") or []:
            dep_t = self._tasks.get(dep)
            if not dep_t or dep_t["status"] != "delivered" or dep_t["review_status"] == "rejected":
                return False
        return True

    def get_runnable_tasks(self) -> List[str]:
        """获取当前所有依赖已满足且处于 pending 状态的任务 ID。"""
        return [tid for tid, t in self._tasks.items() if self.can_run(tid)]

    def cascade_failures(self) -> int:
        """若前置依赖失败/打回，级联将下游 pending 任务标记为 blocked。返回阻塞数。"""
        blocked_count = 0
        for tid, t in self._tasks.items():
            if t["status"] != "pending":
                continue
            for dep in t.get("depends_on") or []:
                dep_t = self._tasks.get(dep)
                if dep_t and dep_t["status"] in ("rejected", "failed", "blocked"):
                    t["status"] = "blocked"
                    t["contract_problems"] = [f"prerequisite task '{dep}' {dep_t['status']}"]
                    blocked_count += 1
                    break
        return blocked_count

    def claim(self, task_id: str, worker: str) -> bool:
        t = self._tasks.get(task_id)
        if not t:
            return False
        ok = acquire_lease(self.storage, f"{self.parent_run_id}:{task_id}",
                           worker)
        if ok:
            t["status"] = "leased"
            t["lease_owner"] = worker
        return ok

    def deliver(self, task_id: str, worker: str, payload: Any) -> tuple[bool, List[str]]:
        """交付必须同时满足：仍持有租约 + 过 ResultContract。二者缺一即拒收。"""
        t = self._tasks.get(task_id)
        if not t:
            return False, [f"unknown task: {task_id}"]
        if t["lease_owner"] != worker:
            return False, [f"not lease holder: {worker} vs {t['lease_owner']}"]
        ok, problems = check_result_contract(payload, t["spec"]["result_schema"])
        if ok:
            t["status"] = "delivered"
            t["result"] = payload
        else:
            t["status"] = "rejected"
            t["contract_problems"] = problems
        return ok, problems

    def set_review(self, task_id: str, verdict: str, note: str = "") -> bool:
        """reviewer gate（§13 ReviewStatus）：对 delivered 交付的复核裁决。

        rejected 即打回——父运行不得采信被复核否决的结果。非 delivered
        状态无物可审，如实拒绝。支持 confirmed / rejected / escalated 三态。
        """
        t = self._tasks.get(task_id)
        if not t or t["status"] != "delivered":
            return False
        valid_verdicts = ("approved", "changes_requested", "rejected", "confirmed", "escalated")
        if verdict not in valid_verdicts:
            raise ValueError(f"unknown review verdict {verdict!r}")
        t["review_status"] = verdict
        t["review_note"] = str(note or "")[:300]
        if verdict == "rejected":
            t["status"] = "rejected"
        return True

    def view(self) -> list:
        return [{k: v for k, v in t.items() if k != "spec"} | {
            "role": t["role"], "tools": len(t["spec"]["tools"]),
        } for t in self._tasks.values()]


# ── 4-Stage Dispatch Pipeline ────────────────────────────────

class DispatchPipeline:
    """四段式分发管道：Admission（准入） -> Steer（转向） -> Dispatch（派发） -> Delivery（交付）。"""

    def __init__(self, max_concurrent: int = 8, max_depth: int = 2):
        self.max_concurrent = max_concurrent
        self.max_depth = max_depth

    def admit(self, current_concurrent: int, depth: int, token_budget: int = 50_000) -> tuple[bool, str]:
        """Stage 1: Admission 准入控制（并发限额、递归深度与预算检查）。"""
        if current_concurrent >= self.max_concurrent:
            return False, f"concurrency limit reached ({current_concurrent}/{self.max_concurrent})"
        if depth > self.max_depth:
            return False, f"maximum subagent recursion depth exceeded ({depth} > {self.max_depth})"
        if token_budget <= 0:
            return False, "insufficient token budget allocated"
        return True, ""

    def steer(self, task_prompt: str, requested_persona: str = "", requested_role: str = "") -> dict:
        """Stage 2: Steer 动态角色特化与工具裁剪。"""
        role = requested_role or "coder"
        if not requested_role:
            prompt_lower = task_prompt.lower()
            if any(k in prompt_lower for k in ("review", "diff", "audit", "check")):
                role = "reviewer"
            elif any(k in prompt_lower for k in ("search", "find", "explore", "research", "investigate")):
                role = "researcher"
            elif any(k in prompt_lower for k in ("plan", "decompose", "design")):
                role = "planner"
            elif any(k in prompt_lower for k in ("diagnose", "error", "trace", "bug")):
                role = "diagnostician"
        spec = role_spec(role)
        return {"role": role, "persona": requested_persona or role, "spec": spec}

    def dispatch(
        self,
        task_id: str,
        role_info: dict,
        parent_session_id: str,
        *,
        fork: bool = False,
        task_spec: Optional[TaskSpec | Dict[str, Any]] = None,
    ) -> dict:
        """Stage 3: Dispatch 会话隔离、派单合同与调度准备（支持 fork 历史快照继承）。"""
        import uuid
        child_session_id = f"subagent-{uuid.uuid4().hex[:8]}"
        res = {
            "task_id": task_id,
            "child_session_id": child_session_id,
            "parent_session_id": parent_session_id,
            "role": role_info.get("role", "coder"),
            "persona": role_info.get("persona", "coder"),
            "dispatched_at": time.time(),
            "forked": fork,
        }
        if task_spec:
            res["spec"] = task_spec.to_dict() if hasattr(task_spec, "to_dict") else dict(task_spec)
        return res

    def review(
        self,
        findings: List[Any],
        critic_fn: Optional[Callable[[Any], tuple[str, str]]] = None,
    ) -> Dict[str, List[Any]]:
        """Stage 4+ Review: Reviewer-Critic 结构化分歧裁决。"""
        return adjudicate_review_findings(findings, critic_fn)

    def deliver(self, result_payload: Any, expected_schema: dict) -> tuple[bool, list[str]]:
        """Stage 4: Delivery 交付物契约校验。"""
        return check_result_contract(result_payload, expected_schema)
