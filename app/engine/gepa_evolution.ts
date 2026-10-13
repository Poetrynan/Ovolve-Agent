/**
 * gepa_evolution.ts — 自然语言反思与遗传帕累托进化引擎 (GEPA)
 *
 * Ported from `app/backend/gepa_evolution.py` (433 lines).
 *
 * 基于 Nous Research Hermes Agent 与 ICLR 2026 论文
 * 《GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning》。
 * 核心机制（源 docstring，保留为合同）：
 * 1. 自然语言基因组表达 (Natural Language Genome)
 * 2. 反思引导定向变异 (Reflection-Guided Mutation)
 * 3. 基因交叉重组 (Genetic Crossover)
 * 4. 多目标帕累托前沿筛选 (Multi-Objective Pareto-Front Selection)
 * 5. 金丝雀灰度演化与安全晋升 (Canary Staging & Safe Promotion)
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto sha256, node:crypto uuid).
 *   §2  `dict.fromkeys` dedupe (insertion-order-preserving) → JS Set-then-
 *       Array with the same order semantics.
 *   §2  Python round(x, 4) is half-to-even; the to_dict round sites only
 *       render UI numbers — a note marks where the banker's rounding differs
 *       from Math.round on exact halves (float artifacts make this
 *       unobservable on real scores).
 *   §2  copy.deepcopy isn't needed: candidates are rebuilt immutably.
 *   §4  naming: gepa_evolution.py → gepa_evolution.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";

import { Result } from "./result.js";
import { pyJsonDumps } from "./storage/storage_funcs.js";

/** RULEBOOK §2: Python `json.dumps(obj)` 默认 ensure_ascii=True——>0x7E 的码点
 * 一律转 \uXXXX（代理对拆两枚）。pyJsonDumps 保留 ASCII 原文，故再转一道。 */
function pyJsonAscii(value: unknown): string {
  return pyJsonDumps(value).replace(/[\u007f-\uffff]/g, (ch) =>
    "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

// ── 帕累托适应度向量 ──────────────────────────────────────────────────────────

export interface FitnessVector {
  /** 多目标帕累托适应度指标向量。各维度标准化为浮点数值 (越大越好)：
   * - success_rate: 端到端任务成功率 [0.0, 1.0]
   * - token_efficiency: Token 节约率 / 简洁度 [0.0, 1.0]
   * - latency_score: 步骤与延迟得分 [0.0, 1.0]
   * - safety_score: 越权拦截与安全合规得分 [0.0, 1.0] */
  success_rate: number;
  token_efficiency: number;
  latency_score: number;
  safety_score: number;
  evaluated_cases: number;
  raw_cost_tokens: number;
  raw_latency_ms: number;
}

export function newFitnessVector(
  fields: Partial<FitnessVector> = {}
): FitnessVector {
  return {
    success_rate: fields.success_rate ?? 0.0,
    token_efficiency: fields.token_efficiency ?? 0.5,
    latency_score: fields.latency_score ?? 0.5,
    safety_score: fields.safety_score ?? 1.0,
    evaluated_cases: fields.evaluated_cases ?? 0,
    raw_cost_tokens: fields.raw_cost_tokens ?? 0,
    raw_latency_ms: fields.raw_latency_ms ?? 0.0,
  };
}

export function dominates(self: FitnessVector, other: FitnessVector): boolean {
  /** 帕累托支配检查: 当前个体是否在所有维度均 >= other 且至少一个维度严格 > other。 */
  const curr = [self.success_rate, self.token_efficiency, self.latency_score, self.safety_score];
  const oth = [other.success_rate, other.token_efficiency, other.latency_score, other.safety_score];

  const all_ge = curr.every((c, i) => c >= oth[i]! - 1e-6);
  const any_gt = curr.some((c, i) => c > oth[i]! + 1e-6);
  return all_ge && any_gt;
}

export function scalar_score(
  self: FitnessVector,
  weights?: [number, number, number, number] | null
): number {
  /** 加权标量综合分 (默认权重: 成功率 0.5, 安全 0.25, 效率 0.15, 延迟 0.10)。 */
  const w = weights ?? [0.5, 0.15, 0.1, 0.25];
  return (
    self.success_rate * w[0]! +
    self.token_efficiency * w[1]! +
    self.latency_score * w[2]! +
    self.safety_score * w[3]!
  );
}

export function fitness_to_dict(self: FitnessVector): Record<string, unknown> {
  // NOTE: Python round() is half-to-even; Math.round is half-up. On real
  // score values the two coincide (exact halves don't occur after float
  // arithmetic) — flagged per rulebook §2 as an unobservable divergence.
  return {
    successRate: round4(self.success_rate),
    tokenEfficiency: round4(self.token_efficiency),
    latencyScore: round4(self.latency_score),
    safetyScore: round4(self.safety_score),
    scalarScore: round4(scalar_score(self)),
    evaluatedCases: self.evaluated_cases,
    rawCostTokens: self.raw_cost_tokens,
    rawLatencyMs: Math.round(self.raw_latency_ms * 100) / 100,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ── 候选基因个体 ─────────────────────────────────────────────────────────────

export interface GenomeCandidate {
  /** 一个包含 Prompt / SOP 规则的候选基因个体。 */
  candidate_id: string;
  generation: number;
  name: string;
  prompt_content: string;
  preconditions: string;
  steps: string[];
  guardrails: string[];
  /** seed | reflection_patch | crossover | simplify */
  mutation_type: string;
  parent_ids: string[];
  reflection_notes: string;
  fitness: FitnessVector;
  created_at: number;
}

export function genome_hash(self: GenomeCandidate): string {
  /** 计算基因指纹哈希，确保不产生重复冗余变异。 */
  const normalized =
    self.prompt_content.trim() +
    "\n" + self.preconditions.trim() +
    "\n" + self.steps.join(";") +
    "\n" + self.guardrails.join(";");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

export function candidate_to_dict(self: GenomeCandidate): Record<string, unknown> {
  return {
    candidateId: self.candidate_id,
    generation: self.generation,
    name: self.name,
    promptContent: self.prompt_content,
    preconditions: self.preconditions,
    steps: self.steps,
    guardrails: self.guardrails,
    mutationType: self.mutation_type,
    parentIds: self.parent_ids,
    reflectionNotes: self.reflection_notes,
    fitness: fitness_to_dict(self.fitness),
    genomeHash: genome_hash(self),
    createdAt: self.created_at,
  };
}

// ── 帕累托前沿算法 (Pareto-Front Selection) ──────────────────────────────────

/** 计算非支配解集合 (Pareto Frontier)。
 *
 * 时间复杂度 O(N^2)，对 Agent 基因种群规模 (N <= 100) 极速秒级完成。
 * 返回处于帕累托前沿的所有非支配个体（按综合标量分降序排列）。 */
export function compute_pareto_front(
  candidates: readonly GenomeCandidate[]
): GenomeCandidate[] {
  if (!candidates || candidates.length === 0) {
    return [];
  }

  const unique_candidates: GenomeCandidate[] = [];
  const seen_hashes = new Set<string>();
  for (const c of candidates) {
    const h = genome_hash(c);
    if (!seen_hashes.has(h)) {
      seen_hashes.add(h);
      unique_candidates.push(c);
    }
  }

  const pareto_front: GenomeCandidate[] = [];
  const n = unique_candidates.length;

  for (let i = 0; i < n; i++) {
    const candidate_i = unique_candidates[i]!;
    let is_dominated = false;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const candidate_j = unique_candidates[j]!;
      if (dominates(candidate_j.fitness, candidate_i.fitness)) {
        is_dominated = true;
        break;
      }
    }
    if (!is_dominated) {
      pareto_front.push(candidate_i);
    }
  }

  // 按照综合标量得分降序排序
  pareto_front.sort((a, b) => scalar_score(b.fitness) - scalar_score(a.fitness));
  return pareto_front;
}

// ── 反思与变异引擎 (Reflective Mutator) ───────────────────────────────────────

export interface DiagnosedFailure {
  root_cause: string;
  suggested_guardrail: string;
  suggested_step_patch: string;
  severity: string;
}

export class ReflectiveMutator {
  /** 基于自然语言反思与结构化规则的变异生成器。 */

  static diagnose_failure_trace(trace: Record<string, unknown>): DiagnosedFailure {
    /** 从执行轨迹中自动提取失败模式与改进建议（优先依据结构化 failure_kind）。 */
    const raw_fk = trace["failure_kind"];
    const failure_kind = String(
      typeof raw_fk === "object" && raw_fk !== null && "value" in (raw_fk as Record<string, unknown>)
        ? (raw_fk as Record<string, unknown>)["value"]
        : raw_fk ?? ""
    ).trim();
    const error = String(trace["error"] ?? trace["output"] ?? "");
    const tool_name = String(trace["tool"] ?? trace["name"] ?? "unknown_tool");
    const args = (trace["args"] ?? {}) as Record<string, unknown>;

    const diagnosis: DiagnosedFailure = {
      root_cause: "unknown",
      suggested_guardrail: "",
      suggested_step_patch: "",
      severity: "medium",
    };

    // 1. 优先按结构化 failure_kind 枚举归因
    if (failure_kind === "command_rule_deny") {
      diagnosis.root_cause = "command_rule_deny";
      diagnosis.suggested_guardrail = `严格遵守子代理命令域规则，禁止执行未授权命令 (涉及: ${tool_name})`;
      diagnosis.severity = "high";
      return diagnosis;
    } else if (failure_kind === "mcp_rule_deny") {
      diagnosis.root_cause = "mcp_rule_deny";
      diagnosis.suggested_guardrail = `严格遵守子代理 MCP 工具域规则，禁止调用受限 MCP 工具 (涉及: ${tool_name})`;
      diagnosis.severity = "high";
      return diagnosis;
    } else if (failure_kind === "loop_fault") {
      diagnosis.root_cause = "loop_fault";
      diagnosis.suggested_step_patch = "任务陷入循环，必须设置明确的终止条件并及时汇报进度";
      diagnosis.severity = "high";
      return diagnosis;
    } else if (failure_kind === "user_correction") {
      diagnosis.root_cause = "user_correction";
      diagnosis.suggested_guardrail = "严格遵循用户给出的纠偏指示执行";
      diagnosis.severity = "medium";
      return diagnosis;
    } else if (failure_kind === "schema_mismatch") {
      diagnosis.root_cause = "contract_schema_mismatch";
      diagnosis.suggested_step_patch = "严格按照 ResultContract Schema 输出必需的结构化键值";
      diagnosis.severity = "high";
      return diagnosis;
    } else if (failure_kind === "sandbox_fail_immediately") {
      diagnosis.root_cause = "sandbox_fail_immediately";
      diagnosis.suggested_guardrail = "沙箱环境执行立即失败，检查文件权限及工作区约束";
      diagnosis.severity = "high";
      return diagnosis;
    } else if (failure_kind === "tool_unavailable") {
      diagnosis.root_cause = "tool_unavailable";
      diagnosis.suggested_step_patch = `检查工具可用性，在工具不可用时切换备用工具或方案 (涉及: ${tool_name})`;
      diagnosis.severity = "medium";
      return diagnosis;
    }

    // 2. 兼容兜底：若无 failure_kind 字段，按文本正则归因
    const err_lower = error.toLowerCase();
    if (err_lower.includes("permission") || err_lower.includes("access denied") || err_lower.includes("readonly")) {
      diagnosis.root_cause = "permission_denied";
      diagnosis.suggested_guardrail = `严禁对受保护/只读路径执行写操作 (涉及工具: ${tool_name})`;
      diagnosis.severity = "high";
    } else if (err_lower.includes("timeout") || err_lower.includes("timed out")) {
      diagnosis.root_cause = "timeout_exhaustion";
      diagnosis.suggested_step_patch = `拆分大批量任务，为 ${tool_name} 设置合理超时时间与分页读取`;
      diagnosis.severity = "medium";
    } else if (err_lower.includes("not found") || err_lower.includes("enoent") || err_lower.includes("cannot find")) {
      diagnosis.root_cause = "file_or_resource_not_found";
      diagnosis.suggested_guardrail = `调用 ${tool_name} 前必须先执行 find_files / list_dir 验证路径存在`;
      diagnosis.severity = "low";
    } else if (err_lower.includes("schema") || err_lower.includes("contract rejected") || err_lower.includes("missing key")) {
      diagnosis.root_cause = "contract_schema_mismatch";
      diagnosis.suggested_step_patch = "严格按照 ResultContract Schema 输出必需的结构化键值";
      diagnosis.severity = "high";
    } else {
      diagnosis.root_cause = "generic_tool_error";
      diagnosis.suggested_guardrail = `调用 ${tool_name} 时严格校验入参类型: ${pyJsonAscii(args).slice(0, 100)}`;
    }

    return diagnosis;
  }

  /** 针对失败轨迹对 Parent 基因进行反思定向变异 (Reflection Patch)。 */
  mutate_prompt(
    parent: GenomeCandidate,
    failure_traces: readonly Record<string, unknown>[],
    generation: number
  ): GenomeCandidate {
    const cid = `gepa_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const new_guardrails = [...parent.guardrails];
    const new_steps = [...parent.steps];
    const reflection_notes_list: string[] = [];

    for (const tr of failure_traces.slice(0, 3)) {
      const diag = ReflectiveMutator.diagnose_failure_trace(tr);
      const gr = diag.suggested_guardrail;
      if (gr && !new_guardrails.includes(gr)) {
        new_guardrails.push(gr);
        reflection_notes_list.push(`新增防线: ${gr}`);
      }
      const sp = diag.suggested_step_patch;
      if (sp && !new_steps.includes(sp)) {
        new_steps.push(sp);
        reflection_notes_list.push(`增加步骤: ${sp}`);
      }
    }

    // 生成增强后的 Prompt 正文
    let enhanced_prompt = parent.prompt_content.trim();
    if (new_guardrails.length > 0) {
      const guardrail_section =
        "\n\n【GEPA 自进化安全守则】:\n" +
        new_guardrails.slice(-4).map((g) => `- ${g}`).join("\n");
      if (!enhanced_prompt.includes("【GEPA 自进化安全守则】")) {
        enhanced_prompt += guardrail_section;
      }
    }

    return {
      candidate_id: cid,
      generation,
      name: `${parent.name}_gen${generation}`,
      prompt_content: enhanced_prompt,
      preconditions: parent.preconditions,
      steps: new_steps,
      guardrails: new_guardrails,
      mutation_type: "reflection_patch",
      parent_ids: [parent.candidate_id],
      reflection_notes: reflection_notes_list.join("; ") || "Reflective evolution applied",
      fitness: newFitnessVector(),
      created_at: Date.now() / 1000,
    };
  }

  /** 基因交叉重组 (Crossover): 融合两个优势父本的步骤与安全约束。 */
  crossover(
    parent_a: GenomeCandidate,
    parent_b: GenomeCandidate,
    generation: number
  ): GenomeCandidate {
    const cid = `gepa_cross_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    // dict.fromkeys order-preserving dedupe:
    const merged_guardrails = Array.from(new Set([...parent_a.guardrails, ...parent_b.guardrails]));
    const merged_steps = Array.from(new Set([...parent_a.steps, ...parent_b.steps]));

    // 交叉 Prompt 描述
    const desc_a = parent_a.prompt_content.split("【GEPA 自进化安全守则】")[0]!.trim();
    const desc_b = parent_b.prompt_content.split("【GEPA 自进化安全守则】")[0]!.trim();
    let combined_desc = desc_a.length <= desc_b.length ? desc_a : desc_b;

    if (merged_guardrails.length > 0) {
      combined_desc +=
        "\n\n【GEPA 自进化安全守则】:\n" +
        merged_guardrails.slice(0, 6).map((g) => `- ${g}`).join("\n");
    }

    return {
      candidate_id: cid,
      generation,
      name: `${parent_a.name}_x_${parent_b.name}`,
      prompt_content: combined_desc,
      preconditions: parent_a.preconditions || parent_b.preconditions,
      steps: merged_steps,
      guardrails: merged_guardrails,
      mutation_type: "crossover",
      parent_ids: [parent_a.candidate_id, parent_b.candidate_id],
      reflection_notes: `Crossover between ${parent_a.candidate_id} and ${parent_b.candidate_id}`,
      fitness: newFitnessVector(),
      created_at: Date.now() / 1000,
    };
  }

  /** Token 剪枝与精炼 (Simplification Mutation): 去除冗余废话，提升 Token 效率。 */
  simplify(parent: GenomeCandidate, generation: number): GenomeCandidate {
    const cid = `gepa_simp_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    let compact_prompt = parent.prompt_content.replace(/\n{3,}/g, "\n\n");
    compact_prompt = compact_prompt.replace(/[ \t]+/g, " ").trim();

    return {
      candidate_id: cid,
      generation,
      name: `${parent.name}_compact`,
      prompt_content: compact_prompt,
      preconditions: parent.preconditions,
      steps: parent.steps.slice(0, 8), // 截断过长步骤
      guardrails: parent.guardrails.slice(0, 6), // 保留最高频约束
      mutation_type: "simplify",
      parent_ids: [parent.candidate_id],
      reflection_notes: "Pruned redundancy to maximize token efficiency",
      fitness: newFitnessVector(),
      created_at: Date.now() / 1000,
    };
  }
}

// ── GEPA 进化优化调度器 (GEPAEvolutionOptimizer) ─────────────────────────────

export type SimulatorFn = (
  candidate: GenomeCandidate,
  eval_case: Record<string, unknown>
) => Record<string, unknown>;

export class GEPAEvolutionOptimizer {
  /** GEPA 离线演化优化器主流程。 */
  mutator: ReflectiveMutator;

  constructor(mutator?: ReflectiveMutator | null) {
    this.mutator = mutator ?? new ReflectiveMutator();
  }

  /** 在测试集/历史轨迹上对单个候选基因进行多目标评估。 */
  evaluate_candidate(
    candidate: GenomeCandidate,
    eval_cases: readonly Record<string, unknown>[],
    simulator_fn?: SimulatorFn | null
  ): FitnessVector {
    if (!eval_cases || eval_cases.length === 0) {
      candidate.fitness = newFitnessVector({
        success_rate: 1.0, token_efficiency: 0.8, latency_score: 0.8, safety_score: 1.0, evaluated_cases: 0,
      });
      return candidate.fitness;
    }

    let success_count = 0;
    let safety_pass_count = 0;
    let total_tokens = 0;
    let total_steps = 0;
    const n_cases = eval_cases.length;

    for (const eval_case of eval_cases) {
      let res: Record<string, unknown>;
      if (simulator_fn) {
        res = simulator_fn(candidate, eval_case);
      } else {
        // 默认模拟评测器: 检查是否包含必要的防线与关键模式
        const is_err_case = Boolean(eval_case["expected_error"]);
        const expected_guard = String(eval_case["expected_guardrail"] ?? "");

        let passed = true;
        if (expected_guard && !candidate.prompt_content.includes(expected_guard)) {
          passed = false;
        }

        // Token 开销估算
        const tokens = candidate.prompt_content.split(/\s+/).filter(Boolean).length * 2 + Number(eval_case["base_tokens"] ?? 100);
        const steps = candidate.steps.length || Number(eval_case["base_steps"] ?? 3);

        res = {
          ok: passed,
          safe: !is_err_case || passed,
          tokens,
          steps,
        };
      }

      if (res["ok"]) {
        success_count += 1;
      }
      if (res["safe"] ?? true) {
        safety_pass_count += 1;
      }
      total_tokens += Number(res["tokens"] ?? 200);
      total_steps += Number(res["steps"] ?? 3);
    }

    const avg_tokens = total_tokens / Math.max(1, n_cases);
    // Token 效率评分: 500 tokens 约 0.9, 4000 tokens 约 0.2
    const token_eff = Math.max(0.05, Math.min(1.0, 1.0 - avg_tokens / 5000.0));
    const avg_steps = total_steps / Math.max(1, n_cases);
    const latency_score = Math.max(0.05, Math.min(1.0, 1.0 - avg_steps / 20.0));

    candidate.fitness = newFitnessVector({
      success_rate: success_count / n_cases,
      token_efficiency: token_eff,
      latency_score,
      safety_score: safety_pass_count / n_cases,
      evaluated_cases: n_cases,
      raw_cost_tokens: Math.trunc(avg_tokens),
      raw_latency_ms: avg_steps * 500.0,
    });
    return candidate.fitness;
  }

  /** 执行完整的 GEPA 遗传帕累托进化周期。
   *
   * Returns: { pareto_front, winner, generations_log } */
  run_evolution_cycle(
    seed_prompt: string,
    seed_name: string,
    eval_cases: readonly Record<string, unknown>[],
    failure_traces: readonly Record<string, unknown>[],
    max_generations = 3,
    population_size = 6
  ): Record<string, unknown> {
    // 1. 初始化初代个体 (P0)
    const seed: GenomeCandidate = {
      candidate_id: "gepa_seed_0",
      generation: 0,
      name: seed_name,
      prompt_content: seed_prompt,
      preconditions: "",
      steps: [],
      guardrails: [],
      mutation_type: "seed",
      parent_ids: [],
      reflection_notes: "",
      fitness: newFitnessVector(),
      created_at: Date.now() / 1000,
    };
    this.evaluate_candidate(seed, eval_cases);

    let population: GenomeCandidate[] = [seed];
    const generations_log: Record<string, unknown>[] = [];

    // 2. 迭代繁衍演化
    for (let gen = 1; gen <= max_generations; gen++) {
      const next_pop: GenomeCandidate[] = [...population];

      // (a) 对上一代优胜个体执行反思变异 (Reflective Mutation)
      const current_front = compute_pareto_front(population);
      for (const elite of current_front.slice(0, 3)) {
        const mutant = this.mutator.mutate_prompt(elite, failure_traces, gen);
        this.evaluate_candidate(mutant, eval_cases);
        next_pop.push(mutant);
      }

      // (b) 基因交叉重组 (Crossover)
      if (current_front.length >= 2) {
        const child = this.mutator.crossover(current_front[0]!, current_front[1]!, gen);
        this.evaluate_candidate(child, eval_cases);
        next_pop.push(child);
      }

      // (c) 剪枝精炼 (Simplify)
      if (current_front.length > 0) {
        const simplified = this.mutator.simplify(current_front[0]!, gen);
        this.evaluate_candidate(simplified, eval_cases);
        next_pop.push(simplified);
      }

      // (d) 帕累托前沿筛选与环境容量控制
      const next_front = compute_pareto_front(next_pop);
      population = next_front.slice(0, population_size);

      generations_log.push({
        generation: gen,
        population_size: population.length,
        pareto_front_size: next_front.length,
        best_scalar_score: population.length > 0 ? scalar_score(population[0]!.fitness) : 0.0,
      });
    }

    const final_pareto = compute_pareto_front(population);
    const winner = final_pareto.length > 0 ? final_pareto[0]! : seed;

    return {
      winner: candidate_to_dict(winner),
      paretoFront: final_pareto.map((c) => candidate_to_dict(c)),
      generationsLog: generations_log,
      seedFitness: fitness_to_dict(seed.fitness),
      winnerFitness: fitness_to_dict(winner.fitness),
      improved: scalar_score(winner.fitness) > scalar_score(seed.fitness),
    };
  }
}

// Re-export Result so tool-facing consumers can build failures with the same
// uniform shape as the source's `from result import Result`.
export { Result };
