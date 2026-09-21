"""
gepa_evolution.py — 自然语言反思与遗传帕累托进化引擎 (GEPA)

基于 Nous Research Hermes Agent 与 ICLR 2026 顶会论文:
《GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning》

核心机制:
1. 自然语言基因组表达 (Natural Language Genome): 将 Prompt, SOP 技能与工具规则视为可进化基因;
2. 反思引导定向变异 (Reflection-Guided Mutation): 深度分析失败执行轨迹 (Error Traces) 提取根因并定向打补丁;
3. 基因交叉重组 (Genetic Crossover): 融合两个互补 Prompt/技能的优良策略;
4. 多目标帕累托前沿筛选 (Multi-Objective Pareto-Front Selection):
   适应度向量 F(x) = (f_success, -f_cost, -f_latency, f_safety),
   避免单一指标优化导致的 Token 膨胀或死板过拟合;
5. 金丝雀灰度演化与安全晋升 (Canary Staging & Safe Promotion).
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from result import Result


# ── 帕累托适应度向量 ──────────────────────────────────────────────────────────

@dataclass
class FitnessVector:
    """多目标帕累托适应度指标向量。

    各维度标准化为浮点数值 (越大越好):
    - success_rate: 端到端任务成功率 [0.0, 1.0]
    - token_efficiency: Token 节约率 / 简洁度 [0.0, 1.0] (1.0 = 极简高效)
    - latency_score: 步骤与延迟得分 [0.0, 1.0] (1.0 = 最低轮次完成)
    - safety_score: 越权拦截与安全合规得分 [0.0, 1.0] (1.0 = 零违规零泄露)
    """
    success_rate: float = 0.0
    token_efficiency: float = 0.5
    latency_score: float = 0.5
    safety_score: float = 1.0
    evaluated_cases: int = 0
    raw_cost_tokens: int = 0
    raw_latency_ms: float = 0.0

    def dominates(self, other: FitnessVector) -> bool:
        """帕累托支配检查: 当前个体是否在所有维度均 >= other 且至少一个维度严格 > other。"""
        curr = (self.success_rate, self.token_efficiency, self.latency_score, self.safety_score)
        oth = (other.success_rate, other.token_efficiency, other.latency_score, other.safety_score)

        all_ge = all(c >= o - 1e-6 for c, o in zip(curr, oth))
        any_gt = any(c > o + 1e-6 for c, o in zip(curr, oth))
        return all_ge and any_gt

    def scalar_score(self, weights: Optional[Tuple[float, float, float, float]] = None) -> float:
        """加权标量综合分 (默认权重: 成功率 0.5, 安全 0.25, 效率 0.15, 延迟 0.10)。"""
        w = weights or (0.50, 0.15, 0.10, 0.25)
        return (
            self.success_rate * w[0]
            + self.token_efficiency * w[1]
            + self.latency_score * w[2]
            + self.safety_score * w[3]
        )

    def to_dict(self) -> dict:
        return {
            "successRate": round(self.success_rate, 4),
            "tokenEfficiency": round(self.token_efficiency, 4),
            "latencyScore": round(self.latency_score, 4),
            "safetyScore": round(self.safety_score, 4),
            "scalarScore": round(self.scalar_score(), 4),
            "evaluatedCases": self.evaluated_cases,
            "rawCostTokens": self.raw_cost_tokens,
            "rawLatencyMs": round(self.raw_latency_ms, 2),
        }


# ── 候选基因个体 ─────────────────────────────────────────────────────────────

@dataclass
class GenomeCandidate:
    """一个包含 Prompt / SOP 规则的候选基因个体。"""
    candidate_id: str
    generation: int
    name: str
    prompt_content: str
    preconditions: str = ""
    steps: List[str] = field(default_factory=list)
    guardrails: List[str] = field(default_factory=list)
    mutation_type: str = "seed"  # seed | reflection_patch | crossover | simplify
    parent_ids: List[str] = field(default_factory=list)
    reflection_notes: str = ""
    fitness: FitnessVector = field(default_factory=FitnessVector)
    created_at: float = field(default_factory=time.time)

    def genome_hash(self) -> str:
        """计算基因指纹哈希，确保不产生重复冗余变异。"""
        normalized = (
            self.prompt_content.strip()
            + "\n" + self.preconditions.strip()
            + "\n" + ";".join(self.steps)
            + "\n" + ";".join(self.guardrails)
        )
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

    def to_dict(self) -> dict:
        return {
            "candidateId": self.candidate_id,
            "generation": self.generation,
            "name": self.name,
            "promptContent": self.prompt_content,
            "preconditions": self.preconditions,
            "steps": self.steps,
            "guardrails": self.guardrails,
            "mutationType": self.mutation_type,
            "parentIds": self.parent_ids,
            "reflectionNotes": self.reflection_notes,
            "fitness": self.fitness.to_dict(),
            "genomeHash": self.genome_hash(),
            "createdAt": self.created_at,
        }


# ── 帕累托前沿算法 (Pareto-Front Selection) ──────────────────────────────────

def compute_pareto_front(candidates: Sequence[GenomeCandidate]) -> List[GenomeCandidate]:
    """计算非支配解集合 (Pareto Frontier)。

    时间复杂度 O(N^2)，对 Agent 基因种群规模 (N <= 100) 极速秒级完成。
    返回处于帕累托前沿的所有非支配个体（按综合标量分降序排列）。
    """
    if not candidates:
        return []

    unique_candidates: list[GenomeCandidate] = []
    seen_hashes = set()
    for c in candidates:
        h = c.genome_hash()
        if h not in seen_hashes:
            seen_hashes.add(h)
            unique_candidates.append(c)

    pareto_front: list[GenomeCandidate] = []
    n = len(unique_candidates)

    for i in range(n):
        candidate_i = unique_candidates[i]
        is_dominated = False
        for j in range(n):
            if i == j:
                continue
            candidate_j = unique_candidates[j]
            if candidate_j.fitness.dominates(candidate_i.fitness):
                is_dominated = True
                break
        if not is_dominated:
            pareto_front.append(candidate_i)

    # 按照综合标量得分降序排序
    pareto_front.sort(key=lambda c: -c.fitness.scalar_score())
    return pareto_front


# ── 反思与变异引擎 (Reflective Mutator) ───────────────────────────────────────

class ReflectiveMutator:
    """基于自然语言反思与结构化规则的变异生成器。"""

    @staticmethod
    def diagnose_failure_trace(trace: dict) -> dict:
        """从执行轨迹中自动提取失败模式与改进建议（优先依据结构化 failure_kind）。"""
        raw_fk = trace.get("failure_kind")
        failure_kind = (raw_fk.value if hasattr(raw_fk, "value") else str(raw_fk or "")).strip()
        error = str(trace.get("error") or trace.get("output") or "")
        tool_name = str(trace.get("tool") or trace.get("name") or "unknown_tool")
        args = trace.get("args") or {}

        diagnosis = {
            "root_cause": "unknown",
            "suggested_guardrail": "",
            "suggested_step_patch": "",
            "severity": "medium",
        }

        # 1. 优先按结构化 failure_kind 枚举归因
        if failure_kind == "command_rule_deny":
            diagnosis["root_cause"] = "command_rule_deny"
            diagnosis["suggested_guardrail"] = f"严格遵守子代理命令域规则，禁止执行未授权命令 (涉及: {tool_name})"
            diagnosis["severity"] = "high"
            return diagnosis
        elif failure_kind == "mcp_rule_deny":
            diagnosis["root_cause"] = "mcp_rule_deny"
            diagnosis["suggested_guardrail"] = f"严格遵守子代理 MCP 工具域规则，禁止调用受限 MCP 工具 (涉及: {tool_name})"
            diagnosis["severity"] = "high"
            return diagnosis
        elif failure_kind == "loop_fault":
            diagnosis["root_cause"] = "loop_fault"
            diagnosis["suggested_step_patch"] = "任务陷入循环，必须设置明确的终止条件并及时汇报进度"
            diagnosis["severity"] = "high"
            return diagnosis
        elif failure_kind == "user_correction":
            diagnosis["root_cause"] = "user_correction"
            diagnosis["suggested_guardrail"] = "严格遵循用户给出的纠偏指示执行"
            diagnosis["severity"] = "medium"
            return diagnosis
        elif failure_kind == "schema_mismatch":
            diagnosis["root_cause"] = "contract_schema_mismatch"
            diagnosis["suggested_step_patch"] = "严格按照 ResultContract Schema 输出必需的结构化键值"
            diagnosis["severity"] = "high"
            return diagnosis
        elif failure_kind == "sandbox_fail_immediately":
            diagnosis["root_cause"] = "sandbox_fail_immediately"
            diagnosis["suggested_guardrail"] = "沙箱环境执行立即失败，检查文件权限及工作区约束"
            diagnosis["severity"] = "high"
            return diagnosis
        elif failure_kind == "tool_unavailable":
            diagnosis["root_cause"] = "tool_unavailable"
            diagnosis["suggested_step_patch"] = f"检查工具可用性，在工具不可用时切换备用工具或方案 (涉及: {tool_name})"
            diagnosis["severity"] = "medium"
            return diagnosis

        # 2. 兼容兜底：若无 failure_kind 字段，按文本正则归因
        err_lower = error.lower()
        if "permission" in err_lower or "access denied" in err_lower or "readonly" in err_lower:
            diagnosis["root_cause"] = "permission_denied"
            diagnosis["suggested_guardrail"] = f"严禁对受保护/只读路径执行写操作 (涉及工具: {tool_name})"
            diagnosis["severity"] = "high"
        elif "timeout" in err_lower or "timed out" in err_lower:
            diagnosis["root_cause"] = "timeout_exhaustion"
            diagnosis["suggested_step_patch"] = f"拆分大批量任务，为 {tool_name} 设置合理超时时间与分页读取"
            diagnosis["severity"] = "medium"
        elif "not found" in err_lower or "enoent" in err_lower or "cannot find" in err_lower:
            diagnosis["root_cause"] = "file_or_resource_not_found"
            diagnosis["suggested_guardrail"] = f"调用 {tool_name} 前必须先执行 find_files / list_dir 验证路径存在"
            diagnosis["severity"] = "low"
        elif "schema" in err_lower or "contract rejected" in err_lower or "missing key" in err_lower:
            diagnosis["root_cause"] = "contract_schema_mismatch"
            diagnosis["suggested_step_patch"] = "严格按照 ResultContract Schema 输出必需的结构化键值"
            diagnosis["severity"] = "high"
        else:
            diagnosis["root_cause"] = "generic_tool_error"
            diagnosis["suggested_guardrail"] = f"调用 {tool_name} 时严格校验入参类型: {json.dumps(args)[:100]}"

        return diagnosis

    def mutate_prompt(
        self,
        parent: GenomeCandidate,
        failure_traces: Sequence[dict],
        generation: int,
    ) -> GenomeCandidate:
        """针对失败轨迹对 Parent 基因进行反思定向变异 (Reflection Patch)。"""
        cid = f"gepa_{uuid.uuid4().hex[:8]}"
        new_guardrails = list(parent.guardrails)
        new_steps = list(parent.steps)
        reflection_notes_list = []

        for tr in failure_traces[:3]:
            diag = self.diagnose_failure_trace(tr)
            gr = diag.get("suggested_guardrail")
            if gr and gr not in new_guardrails:
                new_guardrails.append(gr)
                reflection_notes_list.append(f"新增防线: {gr}")
            sp = diag.get("suggested_step_patch")
            if sp and sp not in new_steps:
                new_steps.append(sp)
                reflection_notes_list.append(f"增加步骤: {sp}")

        # 生成增强后的 Prompt 正文
        enhanced_prompt = parent.prompt_content.strip()
        if new_guardrails:
            guardrail_section = "\n\n【GEPA 自进化安全守则】:\n" + "\n".join(f"- {g}" for g in new_guardrails[-4:])
            if "【GEPA 自进化安全守则】" not in enhanced_prompt:
                enhanced_prompt += guardrail_section

        return GenomeCandidate(
            candidate_id=cid,
            generation=generation,
            name=f"{parent.name}_gen{generation}",
            prompt_content=enhanced_prompt,
            preconditions=parent.preconditions,
            steps=new_steps,
            guardrails=new_guardrails,
            mutation_type="reflection_patch",
            parent_ids=[parent.candidate_id],
            reflection_notes="; ".join(reflection_notes_list) or "Reflective evolution applied",
        )

    def crossover(
        self,
        parent_a: GenomeCandidate,
        parent_b: GenomeCandidate,
        generation: int,
    ) -> GenomeCandidate:
        """基因交叉重组 (Crossover): 融合两个优势父本的步骤与安全约束。"""
        cid = f"gepa_cross_{uuid.uuid4().hex[:8]}"
        merged_guardrails = list(dict.fromkeys(parent_a.guardrails + parent_b.guardrails))
        merged_steps = list(dict.fromkeys(parent_a.steps + parent_b.steps))

        # 交叉 Prompt 描述
        desc_a = parent_a.prompt_content.split("【GEPA 自进化安全守则】")[0].strip()
        desc_b = parent_b.prompt_content.split("【GEPA 自进化安全守则】")[0].strip()
        combined_desc = desc_a if len(desc_a) <= len(desc_b) else desc_b

        if merged_guardrails:
            combined_desc += "\n\n【GEPA 自进化安全守则】:\n" + "\n".join(f"- {g}" for g in merged_guardrails[:6])

        return GenomeCandidate(
            candidate_id=cid,
            generation=generation,
            name=f"{parent_a.name}_x_{parent_b.name}",
            prompt_content=combined_desc,
            preconditions=parent_a.preconditions or parent_b.preconditions,
            steps=merged_steps,
            guardrails=merged_guardrails,
            mutation_type="crossover",
            parent_ids=[parent_a.candidate_id, parent_b.candidate_id],
            reflection_notes=f"Crossover between {parent_a.candidate_id} and {parent_b.candidate_id}",
        )

    def simplify(
        self,
        parent: GenomeCandidate,
        generation: int,
    ) -> GenomeCandidate:
        """Token 剪枝与精炼 (Simplification Mutation): 去除冗余废话，提升 Token 效率。"""
        cid = f"gepa_simp_{uuid.uuid4().hex[:8]}"
        compact_prompt = re.sub(r'\n{3,}', '\n\n', parent.prompt_content)
        compact_prompt = re.sub(r'[ \t]+', ' ', compact_prompt).strip()

        return GenomeCandidate(
            candidate_id=cid,
            generation=generation,
            name=f"{parent.name}_compact",
            prompt_content=compact_prompt,
            preconditions=parent.preconditions,
            steps=parent.steps[:8],  # 截断过长步骤
            guardrails=parent.guardrails[:6],  # 保留最高频约束
            mutation_type="simplify",
            parent_ids=[parent.candidate_id],
            reflection_notes="Pruned redundancy to maximize token efficiency",
        )


# ── GEPA 进化优化调度器 (GEPAEvolutionOptimizer) ─────────────────────────────

class GEPAEvolutionOptimizer:
    """GEPA 离线演化优化器主流程。"""

    def __init__(self, mutator: Optional[ReflectiveMutator] = None):
        self.mutator = mutator or ReflectiveMutator()

    def evaluate_candidate(
        self,
        candidate: GenomeCandidate,
        eval_cases: Sequence[dict],
        simulator_fn: Optional[Callable[[GenomeCandidate, dict], dict]] = None,
    ) -> FitnessVector:
        """在测试集/历史轨迹上对单个候选基因进行多目标评估。"""
        if not eval_cases:
            candidate.fitness = FitnessVector(
                success_rate=1.0, token_efficiency=0.8, latency_score=0.8, safety_score=1.0, evaluated_cases=0
            )
            return candidate.fitness

        success_count = 0
        safety_pass_count = 0
        total_tokens = 0
        total_steps = 0
        n_cases = len(eval_cases)

        for case in eval_cases:
            if simulator_fn:
                res = simulator_fn(candidate, case)
            else:
                # 默认模拟评测器: 检查是否包含必要的防线与关键模式
                is_err_case = bool(case.get("expected_error"))
                expected_guard = case.get("expected_guardrail", "")

                passed = True
                if expected_guard and expected_guard not in candidate.prompt_content:
                    passed = False

                # Token 开销估算
                tokens = len(candidate.prompt_content.split()) * 2 + int(case.get("base_tokens", 100))
                steps = len(candidate.steps) or int(case.get("base_steps", 3))

                res = {
                    "ok": passed,
                    "safe": not is_err_case or passed,
                    "tokens": tokens,
                    "steps": steps,
                }

            if res.get("ok"):
                success_count += 1
            if res.get("safe", True):
                safety_pass_count += 1
            total_tokens += int(res.get("tokens", 200))
            total_steps += int(res.get("steps", 3))

        avg_tokens = total_tokens / max(1, n_cases)
        # Token 效率评分: 500 tokens 约 0.9, 4000 tokens 约 0.2
        token_eff = max(0.05, min(1.0, 1.0 - (avg_tokens / 5000.0)))
        avg_steps = total_steps / max(1, n_cases)
        latency_score = max(0.05, min(1.0, 1.0 - (avg_steps / 20.0)))

        candidate.fitness = FitnessVector(
            success_rate=success_count / n_cases,
            token_efficiency=token_eff,
            latency_score=latency_score,
            safety_score=safety_pass_count / n_cases,
            evaluated_cases=n_cases,
            raw_cost_tokens=int(avg_tokens),
            raw_latency_ms=avg_steps * 500.0,
        )
        return candidate.fitness

    def run_evolution_cycle(
        self,
        seed_prompt: str,
        seed_name: str,
        eval_cases: Sequence[dict],
        failure_traces: Sequence[dict],
        max_generations: int = 3,
        population_size: int = 6,
    ) -> dict:
        """执行完整的 GEPA 遗传帕累托进化周期。

        Returns:
            dict with {
                "pareto_front": list of best candidates,
                "winner": top candidate on Pareto front,
                "generations_log": detailed history,
            }
        """
        # 1. 初始化初代个体 (P0)
        seed = GenomeCandidate(
            candidate_id="gepa_seed_0",
            generation=0,
            name=seed_name,
            prompt_content=seed_prompt,
            mutation_type="seed",
        )
        self.evaluate_candidate(seed, eval_cases)

        population: list[GenomeCandidate] = [seed]
        generations_log = []

        # 2. 迭代繁衍演化
        for gen in range(1, max_generations + 1):
            next_pop: list[GenomeCandidate] = list(population)

            # (a) 对上一代优胜个体执行反思变异 (Reflective Mutation)
            current_front = compute_pareto_front(population)
            for elite in current_front[:3]:
                mutant = self.mutator.mutate_prompt(elite, failure_traces, gen)
                self.evaluate_candidate(mutant, eval_cases)
                next_pop.append(mutant)

            # (b) 基因交叉重组 (Crossover)
            if len(current_front) >= 2:
                child = self.mutator.crossover(current_front[0], current_front[1], gen)
                self.evaluate_candidate(child, eval_cases)
                next_pop.append(child)

            # (c) 剪枝精炼 (Simplify)
            if current_front:
                simplified = self.mutator.simplify(current_front[0], gen)
                self.evaluate_candidate(simplified, eval_cases)
                next_pop.append(simplified)

            # (d) 帕累托前沿筛选与环境容量控制
            next_front = compute_pareto_front(next_pop)
            population = next_front[:population_size]

            generations_log.append({
                "generation": gen,
                "population_size": len(population),
                "pareto_front_size": len(next_front),
                "best_scalar_score": population[0].fitness.scalar_score() if population else 0.0,
            })

        final_pareto = compute_pareto_front(population)
        winner = final_pareto[0] if final_pareto else seed

        return {
            "winner": winner.to_dict(),
            "paretoFront": [c.to_dict() for c in final_pareto],
            "generationsLog": generations_log,
            "seedFitness": seed.fitness.to_dict(),
            "winnerFitness": winner.fitness.to_dict(),
            "improved": winner.fitness.scalar_score() > seed.fitness.scalar_score(),
        }
