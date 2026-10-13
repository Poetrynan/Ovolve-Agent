/**
 * workflow_evolution.ts — 工作流自进化提炼为 Agent 技能引擎 (Gap D Phase 2).
 *
 * Ported from `app/backend/workflow_evolution.py` (498 lines).
 *
 * 核心链路：
 * 1. WorkflowMetricsTracker: 记录工作流多次回放成功率与漂移率，筛选稳定正样本。
 * 2. WorkflowSlotExtractor: 参数槽位化引擎，将硬编码字面量抽取为通用占位符与 JSON Schema。
 * 3. WorkflowSkillPromoter: 将合格工作流直接编译为符合规范的 SKILL.md，并动态热挂载至 SkillLoader。
 * 4. GEPA 联动: 当物化后的技能执行失败时，通过遗传反思算法调整槽位规则或提示词。
 *
 * Fail-Open 承诺：所有对外入口返回 Result，任何内部异常都不得阻断主 Agent 交互。
 *
 * RULEBOOK CITATIONS:
 * - §1 node: fs/path/os builtins.
 * - §2 dataclass → class（default_factory → undefined 哨兵参数）；
 *   json.dumps(ensure_ascii=False) → pyJsonDumps；split(sep, maxsplit) →
 *   _pySplitMax；str[:1000] 码点切片 → Array.from；`:.2f` 半偶舍入 → _format2。
 * - §2 copy.deepcopy(workflow) → Workflow.from_dict(structuredClone(to_dict()))。
 * - §6 PORT STATUS trailer at file end.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

import { Result } from "./result.js";
import { Workflow } from "./workflow_recorder.js";
import type { WorkflowStep } from "./workflow_recorder.js";
import {
    ReflectiveMutator,
    candidate_to_dict,
    newFitnessVector,
} from "./gepa_evolution.js";
import type { GenomeCandidate } from "./gepa_evolution.js";
import { pyJsonDumps } from "./storage/storage_funcs.js";

// ---------------------------------------------------------------------------
// 指标账本
// ---------------------------------------------------------------------------

export class WorkflowExecutionMetrics {
    workflow_id: string;
    total_runs: number;
    success_runs: number;
    drift_runs: number;
    last_run_timestamp: number | null;
    avg_latency_ms: number;
    is_promotion_candidate: boolean;
    consecutive_failures: number;
    is_degraded: boolean;

    constructor(workflow_id: string, last_run_timestamp?: number | null) {
        this.workflow_id = workflow_id;
        this.total_runs = 0;
        this.success_runs = 0;
        this.drift_runs = 0;
        // field(default_factory=time.time)：仅在实参缺省时取当前时间。
        this.last_run_timestamp =
            last_run_timestamp === undefined ? Date.now() / 1000.0 : last_run_timestamp;
        this.avg_latency_ms = 0.0;
        this.is_promotion_candidate = false;
        this.consecutive_failures = 0;
        this.is_degraded = false;
    }

    get success_rate(): number {
        return this.total_runs > 0 ? this.success_runs / this.total_runs : 0.0;
    }

    get drift_rate(): number {
        return this.total_runs > 0 ? this.drift_runs / this.total_runs : 0.0;
    }
}

export class WorkflowMetricsTracker {
    /** 跟踪工作流执行表现与晋升候选资格 */

    private _metrics: Map<string, WorkflowExecutionMetrics> = new Map();

    record_run(
        workflow_id: string,
        success: boolean,
        drift: boolean = false,
        latency_ms: number = 0.0,
    ): WorkflowExecutionMetrics {
        if (!this._metrics.has(workflow_id)) {
            this._metrics.set(workflow_id, new WorkflowExecutionMetrics(workflow_id));
        }

        const m = this._metrics.get(workflow_id)!;
        m.total_runs += 1;

        if (success && !drift) {
            m.success_runs += 1;
            m.consecutive_failures = 0;
            if (m.is_degraded) {
                m.is_degraded = false;
                void WorkflowMetricsTracker._recover_skill(workflow_id);
            }
        } else {
            m.consecutive_failures += 1;
            if (drift) {
                m.drift_runs += 1;
            }
            if (m.consecutive_failures >= 3 && !m.is_degraded) {
                m.is_degraded = true;
                void WorkflowMetricsTracker._degrade_skill(workflow_id);
            }
        }

        m.last_run_timestamp = Date.now() / 1000.0;
        // 平滑平均延迟
        if (m.avg_latency_ms === 0.0) {
            m.avg_latency_ms = latency_ms;
        } else {
            m.avg_latency_ms = (m.avg_latency_ms * (m.total_runs - 1) + latency_ms) / m.total_runs;
        }

        // 晋升资格判定：成功 >= 3 次且漂移率 <= 0
        m.is_promotion_candidate =
            m.success_runs >= 3 && m.drift_rate <= 0.0 && !m.is_degraded;
        return m;
    }

    /** 连续失败或漂移达到阈值时，自动将技能置为 DISABLED 状态（fail-open）。 */
    static async _degrade_skill(workflow_id: string): Promise<boolean> {
        try {
            const loader_spec = "./skill_loader.js";
            const mod = (await import(loader_spec)) as {
                get_skill_loader: () => {
                    get_skill: (n: string) => unknown;
                    disable_skill: (n: string) => unknown;
                };
            };
            const loader = mod.get_skill_loader();
            const clean_id = workflow_id.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "-");
            for (const name of [`wf-${clean_id}`, workflow_id, clean_id]) {
                const entry = loader.get_skill(name);
                if (entry) {
                    loader.disable_skill(name);
                    return true;
                }
            }
        } catch {
            // 与源一致：任何异常吞掉，fail-open
        }
        return false;
    }

    /** 测试或回放干净成功后，自动将之前降级的技能恢复为 IMPORTED 状态（fail-open）。 */
    static async _recover_skill(workflow_id: string): Promise<boolean> {
        try {
            const loader_spec = "./skill_loader.js";
            const mod = (await import(loader_spec)) as {
                get_skill_loader: () => {
                    get_skill: (n: string) => { status?: unknown } | null;
                    enable_skill: (n: string) => unknown;
                };
                SkillStatus?: { DISABLED?: unknown };
            };
            const loader = mod.get_skill_loader();
            const disabled = mod.SkillStatus?.DISABLED ?? "disabled";
            const clean_id = workflow_id.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "-");
            for (const name of [`wf-${clean_id}`, workflow_id, clean_id]) {
                const entry = loader.get_skill(name);
                if (entry && entry.status === disabled) {
                    loader.enable_skill(name);
                    return true;
                }
            }
        } catch {
            // 与源一致：任何异常吞掉，fail-open
        }
        return false;
    }

    get_metrics(workflow_id: string): WorkflowExecutionMetrics | null {
        return this._metrics.get(workflow_id) ?? null;
    }

    get_promotion_candidates(min_success: number = 3, max_drift_rate: number = 0.0): string[] {
        const candidates: string[] = [];
        for (const [wf_id, m] of this._metrics.entries()) {
            if (m.success_runs >= min_success && m.drift_rate <= max_drift_rate) {
                candidates.push(wf_id);
            }
        }
        return candidates;
    }
}

// ---------------------------------------------------------------------------
// 槽位抽取
// ---------------------------------------------------------------------------

export class ExtractedSlot {
    slot_name: string;
    data_type: string;
    original_value: unknown;
    description: string;

    constructor(
        slot_name: string,
        data_type: string,
        original_value: unknown,
        description: string = "",
    ) {
        this.slot_name = slot_name;
        this.data_type = data_type;
        this.original_value = original_value;
        this.description = description;
    }
}

export class WorkflowSlotExtractor {
    /** 从具体工作流步骤中自动泛化出变量槽位 (Slots) 与参数 Schema */

    // Python `^https?://[^\s]+$` 的 re.match：$ 允许末尾单个换行，显式补 (?:\n)?$。
    static readonly URL_PATTERN = /^https?:\/\/[^\s]+(?:\n)?$/;
    static readonly PATH_PATTERN = /^[a-zA-Z]:[/\\]|^\.?\/[^\s]+/;

    extract_slots(
        workflow: Workflow,
    ): [Workflow, ExtractedSlot[], Record<string, unknown>] {
        const parameterized_wf = Workflow.from_dict(structuredClone(workflow.to_dict()));
        const extracted_slots: ExtractedSlot[] = [];
        const schema_props: Record<string, unknown> = {};
        const required_props: string[] = [];

        let slot_counter = 0;

        for (const step of parameterized_wf.steps) {
            for (const [key, val] of Object.entries(step.params)) {
                if (typeof val !== "string") {
                    continue;
                }

                let slot_name: string | null = null;
                const slot_type = "string";
                let slot_desc = "";

                if (WorkflowSlotExtractor.URL_PATTERN.test(val)) {
                    slot_name = key.toLowerCase().includes("url")
                        ? "target_url"
                        : `url_slot_${slot_counter}`;
                    slot_desc = "目标操作网页 URL";
                } else if (WorkflowSlotExtractor.PATH_PATTERN.test(val)) {
                    slot_name = key.toLowerCase().includes("path")
                        ? "file_path"
                        : `path_slot_${slot_counter}`;
                    slot_desc = "目标文件或输出路径";
                } else if (["query", "keyword", "search"].includes(key.toLowerCase())) {
                    slot_name = `${key}_slot_${slot_counter}`;
                    slot_desc = `搜索关键字或查询参数 (${key})`;
                }

                if (slot_name) {
                    slot_counter += 1;
                    // 避免重复重命名
                    const existing = extracted_slots.find((s) => s.original_value === val);
                    if (existing) {
                        step.params[key] = `{{${existing.slot_name}}}`;
                    } else {
                        extracted_slots.push(
                            new ExtractedSlot(slot_name, slot_type, val, slot_desc),
                        );
                        schema_props[slot_name] = {
                            type: slot_type,
                            description: slot_desc,
                            default: val,
                        };
                        required_props.push(slot_name);
                        step.params[key] = `{{${slot_name}}}`;
                    }
                }
            }
        }

        const json_schema: Record<string, unknown> = {
            type: "object",
            properties: schema_props,
            required: required_props,
        };
        return [parameterized_wf, extracted_slots, json_schema];
    }
}

// ---------------------------------------------------------------------------
// Gate 校验
// ---------------------------------------------------------------------------

/**
 * 把描述渲染成 frontmatter 里安全的纯标量。
 *
 * 默认是裸写（``description: 中文描述``），因为技能目录的解析器同时也
 * 认带引号的标量；只有以 YAML 结构字符开头的描述才加引号，避免被误判
 * 成块标量 / 注释 / 序列。
 */
export function _render_description_value(desc: string): string {
    if (!desc) {
        return '""';
    }
    if ([">", "|", "#", "-", "[", "{", "&", "*", "!", "%", "@", "`", '"', "'"].includes(desc[0]!)) {
        return pyJsonDumps(desc);
    }
    return desc;
}

/** Python `str.split(sep, maxsplit)`：JS 的第二参数是截断长度，语义不同，须自写。 */
function _pySplitMax(s: string, sep: string, maxsplit: number): string[] {
    const out: string[] = [];
    let start = 0;
    for (;;) {
        const idx = s.indexOf(sep, start);
        if (idx === -1 || out.length >= maxsplit) {
            out.push(s.slice(start));
            break;
        }
        out.push(s.slice(start, idx));
        start = idx + sep.length;
    }
    return out;
}

/** Python `str.splitlines()` 的行边界集合。 */
function _pySplitlines(s: string): string[] {
    if (!s) {
        return [];
    }
    const parts = s.split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/);
    if (parts.length > 0 && parts[parts.length - 1] === "") {
        parts.pop();
    }
    return parts;
}

/** Gate 1: SKILL.md 结构合规性与 Agent 可读性校验。 */
export function validate_skill_structure(skill_md_content: string): Result {
    if (!skill_md_content.startsWith("---")) {
        return Result.failure("Gate 1: SKILL.md 缺少开头的 YAML frontmatter 分隔符 (---)");
    }
    const parts = _pySplitMax(skill_md_content, "---", 2);
    if (parts.length < 3) {
        return Result.failure("Gate 1: SKILL.md 缺少闭合的 YAML frontmatter 分隔符");
    }

    const fm_text = parts[1]!.trim();
    const fm: Record<string, string> = {};
    for (let line of _pySplitlines(fm_text)) {
        line = line.trim();
        if (line.includes(":")) {
            const [k, v] = _pySplitMax(line, ":", 1);
            fm[k!.trim()] = v!.trim();
        }
    }

    const name = (fm["name"] ?? "").trim();
    if (!name) {
        return Result.failure("Gate 1: SKILL.md frontmatter 缺少必需的 name 字段");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return Result.failure(`Gate 1: 技能名称 '${name}' 包含非法字符，必须为字母、数字、下划线或连字符`);
    }

    const desc = (fm["description"] ?? "").trim();
    if (!desc || desc === '""' || desc === "''") {
        return Result.failure("Gate 1: SKILL.md frontmatter 缺少有效的 description 描述");
    }

    const body = parts[2]!.trim();
    if (!body) {
        return Result.failure("Gate 1: SKILL.md 正文内容为空，Agent 无法阅读指导");
    }
    if (!(body.startsWith("#") || body.includes("##"))) {
        return Result.failure("Gate 1: SKILL.md 正文缺少标准 Markdown 标题结构");
    }

    return Result.success({ name: name, description: desc });
}

export type TrialRunner = (wf: Workflow, slots: ExtractedSlot[]) => Result;

/** Gate 2: 沙盒试运行 (trial)。以样例槽位值执行试运行，确保工作流步骤可被正确解析与调度。 */
export function run_skill_trial(
    parameterized_wf: Workflow,
    slots: ExtractedSlot[],
    trial_runner: TrialRunner | null = null,
): Result {
    if (!parameterized_wf.steps.length) {
        return Result.failure("Gate 2: 工作流无任何执行步骤，trial 无法运行");
    }

    if (trial_runner !== null) {
        try {
            const res = trial_runner(parameterized_wf, slots);
            if (!res.ok) {
                return Result.failure(`Gate 2 trial 试运行失败: ${res.error}`);
            }
            return res;
        } catch (exc) {
            return Result.failure(
                `Gate 2 trial 试运行异常: ${exc instanceof Error ? exc.message : String(exc)}`,
            );
        }
    }

    // 默认试运行静态与插值校验
    const slot_names = new Set(slots.map((s) => s.slot_name));
    for (const step of parameterized_wf.steps) {
        if (!step.tool_name || !step.tool_name.trim()) {
            return Result.failure(`Gate 2: 步骤 ${step.step_index} 缺少合法的 tool_name`);
        }
        const params_str = pyJsonDumps(step.params);
        // 验证所有插值槽位名均在 slots 清单内
        for (const mm of params_str.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) {
            const placeholder = mm[1]!;
            if (!slot_names.has(placeholder)) {
                return Result.failure(
                    `Gate 2: 步骤 ${step.step_index} 引用了未定义的槽位 '${placeholder}'`,
                );
            }
        }
    }

    return Result.success({ trial: "passed", steps_verified: parameterized_wf.steps.length });
}

/** json.dumps(obj, indent=2, ensure_ascii=False)：Python 缩进模式分隔符为 (",", ": ")。 */
function _pyDumpsIndent2(value: unknown, level: number = 0): string {
    const pad = " ".repeat(level * 2);
    const padNext = " ".repeat((level + 1) * 2);
    if (value === null || value === undefined) {
        return "null";
    }
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
        return pyJsonDumps(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "[]";
        }
        return `[\n${value.map((v) => padNext + _pyDumpsIndent2(v, level + 1)).join(",\n")}\n${pad}]`;
    }
    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return "{}";
        }
        const items = keys.map(
            (k) => `${padNext}${pyJsonDumps(k)}: ${_pyDumpsIndent2(obj[k], level + 1)}`,
        );
        return `{\n${items.join(",\n")}\n${pad}}`;
    }
    return "null";
}

/** Python f"{x:.2f}"：对二进制精确的 .xx5 走半偶舍入（0.125 → "0.12"），toFixed 会进位。 */
function _format2(x: number): string {
    const y = x * 100;
    const fl = Math.floor(y);
    const diff = y - fl;
    let r: number;
    if (diff > 0.5) {
        r = fl + 1;
    } else if (diff < 0.5) {
        r = fl;
    } else {
        r = fl % 2 === 0 ? fl : fl + 1;
    }
    return (r / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// 技能晋级
// ---------------------------------------------------------------------------

export class WorkflowSkillPromoter {
    /** 将正样本工作流编译为标准 SKILL.md 实体包并激活（经三道门安全审查）。 */

    slot_extractor: WorkflowSlotExtractor;

    constructor(slot_extractor?: WorkflowSlotExtractor | null) {
        this.slot_extractor = slot_extractor ?? new WorkflowSlotExtractor();
    }

    async promote_to_skill(
        workflow: Workflow,
        skills_root?: string | null,
        hot_mount: boolean = true,
        trial_runner: TrialRunner | null = null,
        skip_trial: boolean = false,
    ): Promise<Result> {
        if (!workflow.steps.length) {
            return Result.failure("无法将无步骤的空工作流晋级为技能");
        }

        const [parameterized_wf, slots, schema] = this.slot_extractor.extract_slots(workflow);

        // Gate 2 试运行先行校验 (沙盒试跑)
        if (!skip_trial) {
            const trial_res = run_skill_trial(parameterized_wf, slots, trial_runner);
            if (!trial_res.ok) {
                return trial_res;
            }
        }

        const root_dir = skills_root
            ? String(skills_root)
            : nodePath.join(os.homedir(), ".ovolve", "skills");
        fs.mkdirSync(root_dir, { recursive: true });

        const clean_id = workflow.id.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, "-");
        const skill_folder_name = `wf-${clean_id}`;
        const target_dir = nodePath.join(root_dir, skill_folder_name);

        // Gate 3: 幂等性与版本演进判定
        let version = "1.0.0";
        let is_update = false;
        const skill_md_path = nodePath.join(target_dir, "SKILL.md");
        if (fs.existsSync(target_dir) && fs.existsSync(skill_md_path)) {
            is_update = true;
            try {
                const old_text = fs.readFileSync(skill_md_path, "utf-8");
                const m = /version:\s*([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(old_text);
                if (m) {
                    const maj = parseInt(m[1]!, 10);
                    const mnr = parseInt(m[2]!, 10);
                    const patch = parseInt(m[3]!, 10);
                    version = `${maj}.${mnr}.${patch + 1}`;
                }
            } catch {
                version = "1.0.1";
            }
        }

        fs.mkdirSync(target_dir, { recursive: true });

        let desc = workflow.description.trim() || `自动执行工作流: ${workflow.name}`;
        desc = Array.from(desc.replace(/\n/g, " ")).slice(0, 1000).join("");

        // 组装标准 SKILL.md
        const frontmatter: string[] = [
            "---",
            `name: ${skill_folder_name}`,
            `description: ${_render_description_value(desc)}`,
            `version: ${version}`,
            "user-invocable: true",
            "disable-model-invocation: false",
            "include-in-runtime-registry: true",
            "include-in-available-skills-prompt: true",
            "---",
            "",
            `# ${workflow.name}`,
            "",
            desc,
            "",
            "## 参数配置 (Slots)",
            "```json",
            _pyDumpsIndent2(schema),
            "```",
            "",
            "## 执行步骤",
        ];
        for (const step of parameterized_wf.steps) {
            frontmatter.push(
                `- **Step ${step.step_index + 1}**: \`${step.tool_name}\` -> ${pyJsonDumps(step.params)}`,
            );
        }

        const rendered_skill_md = frontmatter.join("\n");

        // Gate 1: SKILL.md 结构校验与 Agent 可读性
        const gate1_res = validate_skill_structure(rendered_skill_md);
        if (!gate1_res.ok) {
            return gate1_res;
        }

        fs.writeFileSync(skill_md_path, rendered_skill_md, "utf-8");

        // 同时存盘参数化后的 workflow 原型
        const wf_json_path = nodePath.join(target_dir, "workflow.json");
        fs.writeFileSync(wf_json_path, _pyDumpsIndent2(parameterized_wf.to_dict()), "utf-8");

        // Gate 3: 幂等热挂载 (热载入至 SkillLoader 运行时)
        let mount_status: string = "skipped";
        if (hot_mount) {
            mount_status = await WorkflowSkillPromoter._hot_mount(target_dir, skill_folder_name);
        }

        return Result.success({
            status: is_update ? "updated" : "promoted",
            skill_name: skill_folder_name,
            skill_dir: target_dir,
            skill_md: skill_md_path,
            slots_count: slots.length,
            version: version,
            is_update: is_update,
            hot_mount: mount_status,
        });
    }

    /** 把刚物化的技能热挂载进运行时 SkillLoader（fail-open & 幂等）。 */
    static async _hot_mount(skill_dir: string, skill_name: string): Promise<string> {
        try {
            const loader_spec = "./skill_loader.js";
            const mod = (await import(loader_spec)) as {
                TrustLevel: { OWN: unknown };
                get_skill_loader: () => {
                    import_skill: (d: string, t: unknown) => Result;
                };
            };
            const res = mod.get_skill_loader().import_skill(skill_dir, mod.TrustLevel.OWN);
            return res.ok ? "mounted" : `degraded: ${res.error}`;
        } catch (exc) {
            return `degraded: ${exc instanceof Error ? exc.message : String(exc)}`;
        }
    }
}

// ---------------------------------------------------------------------------
// GEPA 桥接
// ---------------------------------------------------------------------------

export class WorkflowEvolutionBridge {
    /** 工作流 ↔ GEPA 自进化桥接器。
     *
     * 职责是把"回放失败"这条信号翻译成 GEPA 能消化的基因候选：
     * 先以工作流步骤为种子构造父代基因，再把失败轨迹交给反思变异器，
     * 拿到带新增防线/步骤补丁的子代，供后续重放验证。
     */

    tracker: WorkflowMetricsTracker;
    promoter: WorkflowSkillPromoter;
    private _mutator: ReflectiveMutator | null = null;

    constructor(
        tracker?: WorkflowMetricsTracker | null,
        promoter?: WorkflowSkillPromoter | null,
    ) {
        this.tracker = tracker ?? new WorkflowMetricsTracker();
        this.promoter = promoter ?? new WorkflowSkillPromoter();
    }

    private _get_mutator(): ReflectiveMutator {
        if (this._mutator === null) {
            this._mutator = new ReflectiveMutator();
        }
        return this._mutator;
    }

    /** 用工作流步骤构造父代基因（generation 0）。 */
    static _seed_candidate(workflow: Workflow): GenomeCandidate {
        const steps = workflow.steps.map(
            (s) => `调用 \`${s.tool_name}\`，参数 ${pyJsonDumps(s.params)}`,
        );
        let prompt = `工作流技能：${workflow.name}`;
        if (workflow.description) {
            prompt += `\n${workflow.description}`;
        }
        return {
            candidate_id: `wf_${workflow.id}`,
            generation: 0,
            name: workflow.name || workflow.id,
            prompt_content: prompt,
            preconditions: `由工作流 ${workflow.id} 自动提炼`,
            steps,
            guardrails: [],
            mutation_type: "seed",
            parent_ids: [],
            reflection_notes: "",
            fitness: newFitnessVector(),
            created_at: Date.now() / 1000,
        };
    }

    /** 把一次失败回放转成反思后的基因候选。 */
    reflect_on_failure(workflow: Workflow, failure: Result): Result {
        try {
            const meta = (failure.meta ?? {}) as Record<string, unknown>;
            const failed_index = meta["failed_step"];
            let step: WorkflowStep | null = null;
            if (
                Number.isInteger(failed_index) &&
                (failed_index as number) >= 0 &&
                (failed_index as number) < workflow.steps.length
            ) {
                step = workflow.steps[failed_index as number]!;
            }

            const trace: Record<string, unknown> = {
                tool: step
                    ? step.tool_name
                    : workflow.steps.length
                        ? workflow.steps[0]!.tool_name
                        : "workflow_replay",
                name: workflow.name,
                error: failure.error || "",
                args: step ? step.params : {},
            };

            // Python 经实例调用 @staticmethod，语义即类级函数。
            const diagnosis = ReflectiveMutator.diagnose_failure_trace(trace);
            const parent = WorkflowEvolutionBridge._seed_candidate(workflow);
            const mutated = this._get_mutator().mutate_prompt(parent, [trace], 1);

            const payload: Record<string, unknown> = candidate_to_dict(mutated);
            payload["diagnosis"] = diagnosis;
            return Result.success(payload);
        } catch (exc) {
            return Result.failure(
                `GEPA 反思桥接失败（已 fail-open）: ${exc instanceof Error ? exc.message : String(exc)}`,
            );
        }
    }

    /** 账本达标（成功 >= min_success 且零漂移）时才物化为技能。 */
    async promote_if_ready(
        workflow: Workflow,
        skills_root?: string | null,
        min_success: number = 3,
    ): Promise<Result> {
        const metrics = this.tracker.get_metrics(workflow.id);
        if (metrics === null) {
            return Result.failure(`工作流 ${workflow.id} 尚无回放记录`);
        }
        if (!(metrics.success_runs >= min_success && metrics.drift_rate <= 0.0)) {
            return Result.failure(
                `工作流 ${workflow.id} 未达晋升门槛：成功 ${metrics.success_runs} 次，` +
                `漂移率 ${_format2(metrics.drift_rate)}`,
            );
        }
        return this.promoter.promote_to_skill(workflow, skills_root ?? null);
    }
}

// ---------------------------------------------------------------------------
// DIVERGENCE(port): Python 的 _degrade_skill/_recover_skill 同步 import
//   skill_loader；TS 用动态 import（异步）。二者的返回值在源内均被丢弃，且
//   任何失败都走 fail-open，观测语义一致。
// DIVERGENCE(port): copy.deepcopy → Workflow.from_dict(structuredClone(to_dict()))，
//   经 JSON 值模型克隆，字段集即 to_dict 全集，语义等价。
// DIVERGENCE(port): promote_to_skill/_hot_mount 因动态 import 改为 async；
//   Python 端唯一消费者（promote_if_ready/测试）只看最终 Result，无同步依赖。
// DIVERGENCE(port): Python 文本模式写文件会把 "\n" 转成 os.linesep（Windows
//   为 CRLF）；TS 写裸 LF。源读取端均做换行归一，消费内容一致。
// ---------------------------------------------------------------------------

// PORT STATUS: confidence=high todos=[0]
