"""
triad_runner.py — Factory AI 级三权分立任务执行系统与信息防线 (Triad Orchestrator & The Wall).

核心思想（源自 Factory 2026 顶会与工程实践）：
1. Phase 0 施工前造尺 (Define validation before the work):
   在实现者写第一行代码前，Validator 先对需求/参考程序构建可执行的行为衡具 (Behavioral Instrument)。
2. 信息防线 (The Wall / Blind Testing):
   Implementer 绝不可窥探或直接运行 Validator 的私有衡具测试用例，防止过拟合到稀疏测试集；
3. 高阶语义指令提炼 (Directive Synthesis):
   Orchestrator 将 Validator 产出的底层 Failure Traces 聚类并升维为系统性修复指令 (Directives)，
   下发给 Implementer，实现全局行为对齐。
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from result import Result
from validator_registry import apply_differential_masking, differential_validator

logger = logging.getLogger("triad_runner")


# ── 数据结构 ────────────────────────────────────────────────────────────────

@dataclass
class BehavioralCase:
    """一个独立的端到端行为测量用例。"""
    id: str
    description: str
    command: str = ""
    actual_file: str = ""
    expected: str = ""
    expected_file: str = ""
    weight: float = 1.0
    masks: List[Any] = field(default_factory=list)
    timeout_s: int = 60
    subsystem: str = "general"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "description": self.description,
            "command": self.command,
            "actual_file": self.actual_file,
            "expected": self.expected,
            "expected_file": self.expected_file,
            "weight": self.weight,
            "masks": self.masks,
            "timeout_s": self.timeout_s,
            "subsystem": self.subsystem,
        }


@dataclass
class BehavioralInstrument:
    """一组由 Validator 构建的完备行为测量衡具。"""
    instrument_id: str
    name: str
    target_component: str
    cases: List[BehavioralCase] = field(default_factory=list)
    threshold: float = 0.90  # 默认 90% 行为对齐率达标
    created_at: float = field(default_factory=time.time)

    def total_weight(self) -> float:
        return sum(c.weight for c in self.cases) or 1.0

    def to_dict(self) -> dict:
        return {
            "instrumentId": self.instrument_id,
            "name": self.name,
            "targetComponent": self.target_component,
            "cases": [c.to_dict() for c in self.cases],
            "threshold": self.threshold,
            "createdAt": self.created_at,
        }


@dataclass
class Directive:
    """Orchestrator 提炼的高阶语义修复指令（不泄露底层测试用例）。"""
    directive_id: str
    subsystem: str
    issue_summary: str
    suggested_action: str
    severity: str = "medium"  # high | medium | low
    failing_cases_count: int = 1

    def to_dict(self) -> dict:
        return {
            "directiveId": self.directive_id,
            "subsystem": self.subsystem,
            "issueSummary": self.issue_summary,
            "suggestedAction": self.suggested_action,
            "severity": self.severity,
            "failingCasesCount": self.failing_cases_count,
        }


@dataclass
class TriadEvaluationResult:
    """一次完整的盲测评估报告。"""
    passed: bool
    score: float
    passed_weight: float
    total_weight: float
    directives: List[Directive] = field(default_factory=list)
    raw_failures: List[dict] = field(default_factory=list)
    evaluated_cases: int = 0
    duration_ms: float = 0.0

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "score": round(self.score, 4),
            "passedWeight": round(self.passed_weight, 2),
            "totalWeight": round(self.total_weight, 2),
            "directives": [d.to_dict() for d in self.directives],
            "evaluatedCases": self.evaluated_cases,
            "durationMs": round(self.duration_ms, 2),
        }


# ── 信息防线与衡具构建 ──────────────────────────────────────────────────────

class TheWall:
    """信息防线隔离器：确保 Implementer 无法直接读取私有测试套件。"""

    PRIVATE_SUBDIR = ".ovolve_private_instrument"

    @classmethod
    def get_private_instrument_dir(cls, workspace: str) -> str:
        p = os.path.join(os.path.realpath(workspace), cls.PRIVATE_SUBDIR)
        os.makedirs(p, exist_ok=True)
        return p

    @classmethod
    def sanitize_implementer_prompt(cls, prompt_text: str) -> str:
        """剥离 Prompt 中可能意外泄露的私有测试用例断言。"""
        if not prompt_text:
            return ""
        # 抹去对 private instrument 目录的直接引用
        sanitized = prompt_text.replace(cls.PRIVATE_SUBDIR, "<INTERNAL_EVAL>")
        return sanitized


class ValidatorEngine:
    """验证者角色：负责测量衡具的构建与盲测执行。"""

    @staticmethod
    def build_instrument_from_spec(spec: dict) -> BehavioralInstrument:
        """从规格说明或需求中解析/生成行为衡具。"""
        iid = f"inst_{uuid.uuid4().hex[:8]}"
        name = str(spec.get("name") or "behavioral_instrument")
        component = str(spec.get("target_component") or "core")
        threshold = float(spec.get("threshold") or 0.90)

        cases = []
        raw_cases = spec.get("cases") or []
        for i, rc in enumerate(raw_cases):
            cid = str(rc.get("id") or f"case_{i+1}")
            desc = str(rc.get("description") or f"Test behavior {cid}")
            cmd = str(rc.get("command") or "")
            act_file = str(rc.get("actual_file") or "")
            exp = str(rc.get("expected") or "")
            exp_file = str(rc.get("expected_file") or "")
            weight = float(rc.get("weight") or 1.0)
            masks = list(rc.get("masks") or [])
            subsys = str(rc.get("subsystem") or "general")

            cases.append(BehavioralCase(
                id=cid,
                description=desc,
                command=cmd,
                actual_file=act_file,
                expected=exp,
                expected_file=exp_file,
                weight=weight,
                masks=masks,
                subsystem=subsys,
            ))

        return BehavioralInstrument(
            instrument_id=iid,
            name=name,
            target_component=component,
            cases=cases,
            threshold=threshold,
        )

    @staticmethod
    def evaluate(instrument: BehavioralInstrument, workspace: str) -> TriadEvaluationResult:
        """在工作区上盲测运行衡具，产出加权得分与失败轨迹。"""
        t0 = time.time()
        if not instrument.cases:
            return TriadEvaluationResult(
                passed=True, score=1.0, passed_weight=1.0, total_weight=1.0, evaluated_cases=0,
            )

        passed_weight = 0.0
        total_weight = instrument.total_weight()
        raw_failures = []

        for case in instrument.cases:
            spec = {
                "name": case.id,
                "command": case.command,
                "actual_file": case.actual_file,
                "expected": case.expected,
                "expected_file": case.expected_file,
                "masks": case.masks,
                "timeout_s": case.timeout_s,
            }
            res = differential_validator(spec, workspace)
            if res.get("status") == "passed":
                passed_weight += case.weight
            else:
                raw_failures.append({
                    "case_id": case.id,
                    "subsystem": case.subsystem,
                    "description": case.description,
                    "status": res.get("status"),
                    "evidence": res.get("evidence", []),
                    "weight": case.weight,
                })

        score = passed_weight / total_weight if total_weight > 0 else 1.0
        passed = score >= (instrument.threshold - 1e-6)
        dur = (time.time() - t0) * 1000

        # 将失败送入 Orchestrator 提炼 Directives
        directives = OrchestratorEngine.synthesize_directives(raw_failures)

        return TriadEvaluationResult(
            passed=passed,
            score=score,
            passed_weight=passed_weight,
            total_weight=total_weight,
            directives=directives,
            raw_failures=raw_failures,
            evaluated_cases=len(instrument.cases),
            duration_ms=dur,
        )


class OrchestratorEngine:
    """编排者角色：过滤噪声，将底层测试失败升维为高阶语义指令 (Directives)。"""

    @staticmethod
    def synthesize_directives(raw_failures: Sequence[dict]) -> List[Directive]:
        """将离散的测试失败按子系统与失败模式聚类，生成对 Implementer 友好的语义指令。"""
        if not raw_failures:
            return []

        # 按 subsystem 分组
        grouped: Dict[str, List[dict]] = {}
        for f in raw_failures:
            sub = f.get("subsystem") or "general"
            grouped.setdefault(sub, []).append(f)

        directives = []
        for subsys, fails in grouped.items():
            did = f"dir_{uuid.uuid4().hex[:8]}"
            count = len(fails)
            
            # 提炼公共失败特征
            sample_descs = [f.get("description", "") for f in fails[:3] if f.get("description")]
            summary = f"Subsystem '{subsys}' 行为偏离 ({count} 个用例未达标): " + "; ".join(sample_descs)
            
            # 确定严重度
            total_fail_weight = sum(float(f.get("weight") or 1.0) for f in fails)
            sev = "high" if total_fail_weight >= 3.0 or count >= 3 else "medium"

            # 构造高阶修复建议
            if "timeout" in str(fails).lower():
                action = f"优化 {subsys} 的处理性能与大输入耗时，增加分批或边界检查。"
            elif "not found" in str(fails).lower() or "missing" in str(fails).lower():
                action = f"补齐 {subsys} 模块所缺少的核心功能分支、输出格式或文件协议支持。"
            else:
                action = f"对照系统行为预期，修正 {subsys} 在参数解析、边界条件处理及输出格式上的逻辑缺陷。"

            directives.append(Directive(
                directive_id=did,
                subsystem=subsys,
                issue_summary=summary,
                suggested_action=action,
                severity=sev,
                failing_cases_count=count,
            ))

        # 按严重度排序
        directives.sort(key=lambda d: 0 if d.severity == "high" else 1)
        return directives


class TriadRunner:
    """三权分立闭环协调器 (Triad Runner)."""

    def __init__(self, workspace: str):
        self.workspace = os.path.realpath(workspace)

    def run_cycle(
        self,
        instrument: BehavioralInstrument,
        implementer_action_fn: Optional[Callable[[List[Directive], str], Any]] = None,
        max_rounds: int = 5,
    ) -> Tuple[bool, List[TriadEvaluationResult]]:
        """执行多轮盲测-指令化迭代。"""
        results_history = []
        
        for round_idx in range(1, max_rounds + 1):
            logger.info(f"[Triad] Round {round_idx}/{max_rounds} starting blind evaluation...")
            eval_res = ValidatorEngine.evaluate(instrument, self.workspace)
            results_history.append(eval_res)

            logger.info(
                f"[Triad] Round {round_idx} score: {eval_res.score:.2%}, "
                f"passed: {eval_res.passed}, directives: {len(eval_res.directives)}"
            )

            if eval_res.passed:
                logger.info("[Triad] Standard of completion achieved!")
                return True, results_history

            if implementer_action_fn:
                # 下发指令给 Implementer 进行独立修复（不泄露 raw cases）
                try:
                    implementer_action_fn(eval_res.directives, self.workspace)
                except Exception as exc:
                    logger.warning(f"[Triad] Implementer execution error in round {round_idx}: {exc}")
            else:
                # 无自动修复函数时返回首轮结果
                break

        return False, results_history
