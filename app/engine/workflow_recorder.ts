/**
 * workflow_recorder.ts — Workflow Record and Replay Protocol (Gap D Phase 1).
 *
 * Ported from `app/backend/workflow_recorder.py` (398 lines).
 *
 * Implementation of automated workflow recording and deterministic replay:
 * 1. Recording: Captures action sequences (tool name, action, parameters,
 *    OCR/state hash, expected target).
 * 2. Persistence: Stores workflows in `workflows/<id>.json` with schema validation.
 * 3. Replay with Drift Circuit Breaker:
 *    - Pre-check 1: Physical bare modifier guard (`BareModifierGuard`) ensuring
 *      0 physical key/mouse interference.
 *    - Pre-check 2: Target / state existence verification. Immediate circuit
 *      breaker trip upon drift with failed step reported.
 *    - Execution: Deterministic step dispatch through tool registry/executors.
 * 4. Episode Boundary Protection: Avoids cross-topic workflow pollution.
 *
 * RULEBOOK CITATIONS:
 * - §1 node: fs/path/os/crypto builtins.
 * - §2 dataclass → class; json.dump(ensure_ascii=False, indent=2) →
 *   JSON.stringify(..., null, 2); kwargs-with-defaults → default parameters.
 * - §3 DIVERGENCE notes at file end (async dispatch host, Path → string).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

import { BareModifierGuard } from "./bare_modifier_guard.js";
import { Result } from "./result.js";

/** Structural type of workflow_evolution.WorkflowMetricsTracker.record_run. */
export interface WorkflowMetricsTracker {
    record_run(
        workflow_id: string,
        success: boolean,
        drift?: boolean,
        latency_ms?: number,
    ): unknown;
}

/** A single atomic step within a workflow. */
export class WorkflowStep {
    step_index: number;
    tool_name: string;
    action: string;
    params: Record<string, unknown>;
    timestamp: number | null;
    pre_state_hash: string | null;
    expected_target: Record<string, unknown> | null;

    constructor(
        step_index: number,
        tool_name: string,
        action: string = "",
        params: Record<string, unknown> | null = null,
        timestamp: number | null | undefined = undefined,
        pre_state_hash: string | null = null,
        expected_target: Record<string, unknown> | null = null,
    ) {
        this.step_index = step_index;
        this.tool_name = tool_name;
        this.params = params ?? {};
        // default_factory=time.time fires only when the arg is omitted.
        this.timestamp = timestamp === undefined ? Date.now() / 1000.0 : timestamp;
        this.pre_state_hash = pre_state_hash;
        this.expected_target = expected_target;
        // __post_init__
        this.action = action;
        if (!this.action) {
            if (typeof this.params === "object" && this.params !== null && "action" in this.params) {
                const a = this.params["action"];
                this.action = a === null || a === undefined ? "" : String(a);
            } else {
                this.action = this.tool_name;
            }
        }
    }

    to_dict(): Record<string, unknown> {
        return {
            "step_index": this.step_index,
            "tool_name": this.tool_name,
            "action": this.action,
            "params": this.params,
            "timestamp": this.timestamp,
            "pre_state_hash": this.pre_state_hash,
            "expected_target": this.expected_target,
        };
    }

    static from_dict(data: Record<string, unknown>): WorkflowStep {
        return new WorkflowStep(
            _get(data, "step_index", 0) as number,
            _get(data, "tool_name", "") as string,
            _get(data, "action", "") as string,
            (data["params"] as Record<string, unknown>) || {},
            _get(data, "timestamp", 0.0) as number,
            (data["pre_state_hash"] as string | undefined) ?? null,
            (data["expected_target"] as Record<string, unknown> | undefined) ?? null,
        );
    }
}

/** `dict.get(key, default)`: the default fires only when the key is absent. */
function _get(data: Record<string, unknown>, key: string, defl: unknown): unknown {
    return key in data ? data[key] : defl;
}

/** An executable workflow encapsulating recorded steps. */
export class Workflow {
    id: string;
    name: string;
    created_at: number | null;
    session_id: string;
    episode_id: string;
    description: string;
    steps: WorkflowStep[];
    metadata: Record<string, unknown>;

    constructor(
        id: string,
        name: string,
        created_at: number | null | undefined = undefined,
        session_id = "",
        episode_id = "",
        description = "",
        steps: WorkflowStep[] | null = null,
        metadata: Record<string, unknown> | null = null,
    ) {
        this.id = id;
        this.name = name;
        this.created_at = created_at === undefined ? Date.now() / 1000.0 : created_at;
        this.session_id = session_id;
        this.episode_id = episode_id;
        this.description = description;
        this.steps = steps ?? [];
        this.metadata = metadata ?? {};
    }

    to_dict(): Record<string, unknown> {
        return {
            "id": this.id,
            "name": this.name,
            "created_at": this.created_at,
            "session_id": this.session_id,
            "episode_id": this.episode_id,
            "description": this.description,
            "steps": this.steps.map((s) => s.to_dict()),
            "metadata": this.metadata,
        };
    }

    static from_dict(data: Record<string, unknown>): Workflow {
        const steps_data = (data["steps"] as Record<string, unknown>[] | undefined) || [];
        const steps = steps_data.map((s) => WorkflowStep.from_dict(s));
        return new Workflow(
            _get(data, "id", "") as string,
            _get(data, "name", "") as string,
            _get(data, "created_at", 0.0) as number,
            _get(data, "session_id", "") as string,
            _get(data, "episode_id", "") as string,
            _get(data, "description", "") as string,
            steps,
            (data["metadata"] as Record<string, unknown>) || {},
        );
    }
}

function _isdir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Resolves standard storage directory for recorded workflows. */
export function get_default_workflow_dir(dir_path: string | null = null): string {
    let p: string;
    if (dir_path) {
        p = String(dir_path);
    } else {
        // Default to workspace/workflows or ~/.ovolve/workflows
        const workspace = process.env["OVOLVE_WORKSPACE"];
        if (workspace && _isdir(workspace)) {
            p = nodePath.join(workspace, "workflows");
        } else {
            p = nodePath.join(os.homedir(), ".ovolve", "workflows");
        }
    }
    fs.mkdirSync(p, { recursive: true });
    return p;
}

/** Persists a workflow to workflows/<id>.json. */
export function save_workflow(workflow: Workflow, dir_path: string | null = null): string {
    const folder = get_default_workflow_dir(dir_path);
    const file_path = nodePath.join(folder, `${workflow.id}.json`);
    fs.writeFileSync(file_path, JSON.stringify(workflow.to_dict(), null, 2), "utf-8");
    return file_path;
}

/** Loads a workflow from disk by workflow ID. */
export function load_workflow(workflow_id: string, dir_path: string | null = null): Workflow | null {
    if (dir_path === null) {
        const rec = get_workflow_recorder();
        if (rec && rec._dir_path) dir_path = rec._dir_path;
    }
    const folder = get_default_workflow_dir(dir_path);
    const file_path = nodePath.join(folder, `${workflow_id}.json`);
    if (!fs.existsSync(file_path)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(file_path, "utf-8")) as Record<string, unknown>;
        return Workflow.from_dict(data);
    } catch {
        return null;
    }
}

function _stem(json_basename: string): string {
    return json_basename.endsWith(".json") ? json_basename.slice(0, -5) : json_basename;
}

/** Lists summary info of all saved workflows. */
export function list_workflows(dir_path: string | null = null): Record<string, unknown>[] {
    if (dir_path === null) {
        const rec = get_workflow_recorder();
        if (rec && rec._dir_path) dir_path = rec._dir_path;
    }
    const folder = get_default_workflow_dir(dir_path);
    const results: Record<string, unknown>[] = [];
    let names: string[];
    try {
        names = fs.readdirSync(folder).filter((n) => n.endsWith(".json"));
    } catch {
        return results;
    }
    for (const name of names) {
        try {
            const data = JSON.parse(
                fs.readFileSync(nodePath.join(folder, name), "utf-8"),
            ) as Record<string, unknown>;
            results.push({
                "id": _get(data, "id", _stem(name)),
                "name": _get(data, "name", _stem(name)),
                "created_at": _get(data, "created_at", 0.0),
                "step_count": ((data["steps"] as unknown[] | undefined) || []).length,
                "description": _get(data, "description", ""),
                "episode_id": _get(data, "episode_id", ""),
            });
        } catch {
            continue;
        }
    }
    results.sort((a, b) =>
        (b["created_at"] as number) - (a["created_at"] as number),
    );
    return results;
}

/** Manages active workflow recording session. */
export class WorkflowRecorder {
    _dir_path: string | null;
    _recording: boolean;
    _active_workflow: Workflow | null;

    constructor(dir_path: string | null = null) {
        this._dir_path = dir_path;
        this._recording = false;
        this._active_workflow = null;
    }

    is_recording(): boolean {
        return this._recording && this._active_workflow !== null;
    }

    /** Starts a new recording session. */
    start_recording(
        session_id = "",
        name = "",
        episode_id = "",
        description = "",
        metadata: Record<string, unknown> | null = null,
    ): string {
        const now = Date.now() / 1000.0;
        const wf_id = `wf_${Math.trunc(now)}_${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
        const wf_name = name || `Workflow ${_strftime(now)}`;
        this._active_workflow = new Workflow(
            wf_id,
            wf_name,
            now,
            session_id,
            episode_id,
            description,
            [],
            metadata || {},
        );
        this._recording = true;
        return wf_id;
    }

    /** Appends a recorded action step to the active workflow. */
    record_step(
        tool_name: string,
        params: Record<string, unknown>,
        pre_state_hash: string | null = null,
        expected_target: Record<string, unknown> | null = null,
        action = "",
    ): WorkflowStep | null {
        if (!this.is_recording() || this._active_workflow === null) return null;
        const step_index = this._active_workflow.steps.length;
        const step = new WorkflowStep(
            step_index,
            tool_name,
            action,
            { ...(params || {}) },
            Date.now() / 1000.0,
            pre_state_hash,
            expected_target,
        );
        this._active_workflow.steps.push(step);
        return step;
    }

    /** Stops active recording session and optionally persists to disk. */
    stop_recording(save = true): Workflow | null {
        if (!this._recording || this._active_workflow === null) return null;
        const wf = this._active_workflow;
        this._recording = false;
        this._active_workflow = null;
        if (save) save_workflow(wf, this._dir_path);
        return wf;
    }
}

/** `time.strftime('%Y-%m-%d %H:%M:%S')` — local time, zero-padded. */
function _strftime(secs: number): string {
    const d = new Date(secs * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Executes a recorded workflow with physical safety and drift circuit breaker. */
export class WorkflowReplayer {
    guard: BareModifierGuard;
    private _executor: ((tool_name: string, params: Record<string, unknown>) => Result) | null;
    private _pre_checker: ((step: WorkflowStep) => [boolean, string]) | null;
    private _metrics_tracker: WorkflowMetricsTracker | null;

    constructor(
        guard: BareModifierGuard | null = null,
        executor: ((tool_name: string, params: Record<string, unknown>) => Result) | null = null,
        pre_checker: ((step: WorkflowStep) => [boolean, string]) | null = null,
    ) {
        this.guard = guard ?? new BareModifierGuard();
        this._executor = executor;
        this._pre_checker = pre_checker;
        this._metrics_tracker = null;
    }

    /** 注入指标账本；回放结束后自动登记成功率与漂移率（供技能晋升判定使用）。 */
    set_metrics_tracker(tracker: WorkflowMetricsTracker | null): void {
        this._metrics_tracker = tracker;
    }

    /** 把本次回放结果写入账本。任何异常都不得影响回放本身（fail-open）。 */
    private async _record_run_metrics(
        workflow: Workflow,
        result: Result,
        latency_ms: number,
    ): Promise<void> {
        if (this._metrics_tracker === null) return;
        try {
            const drift = Boolean((result.meta || {})["drift"] ?? false);
            this._metrics_tracker.record_run(
                workflow.id,
                Boolean(result.ok),
                drift,
                latency_ms,
            );
        } catch {
            /* fail-open */
        }
    }

    /** Plays back workflow steps sequentially with circuit breaker protection. */
    async replay(
        workflow: Workflow,
        stop_on_drift = true,
        session_id = "",
        episode_id = "",
    ): Promise<Result> {
        const started = Date.now() / 1000.0;
        const result = await this._replay_inner(workflow, stop_on_drift, session_id, episode_id);
        await this._record_run_metrics(workflow, result, (Date.now() / 1000.0 - started) * 1000.0);
        return result;
    }

    private async _replay_inner(
        workflow: Workflow,
        stop_on_drift = true,
        _session_id = "",
        episode_id = "",
    ): Promise<Result> {
        if (!workflow || workflow.steps.length === 0) {
            return Result.failure("Workflow has no executable steps");
        }

        // Episode boundary check
        if (episode_id && workflow.episode_id && episode_id !== workflow.episode_id) {
            // Note cross-boundary execution
        }

        let executed_steps = 0;
        const total_steps = workflow.steps.length;

        for (const step of workflow.steps) {
            // 1. Bare modifier guard: Ensure physical user input is quiet
            const [clean, clean_reason] = await this.guard.wait_for_bare_state(500, 25, true);
            if (!clean) {
                return Result.failure(
                    `Replay interrupted by physical input interference at step ${step.step_index}: ${clean_reason}`,
                    null,
                    { drift: true, failed_step: step.step_index, executed_steps, total_steps },
                );
            }

            // 2. Target / UI State pre-check
            if (this._pre_checker) {
                const [target_ok, reason] = this._pre_checker(step);
                if (!target_ok && stop_on_drift) {
                    return Result.failure(
                        `UI/State drift detected at step ${step.step_index}: ${reason}`,
                        null,
                        { drift: true, failed_step: step.step_index, executed_steps, total_steps },
                    );
                }
            }

            // 3. Step execution
            const exec_res = await this._dispatch_step(step);
            if (!exec_res.ok) {
                return Result.failure(
                    `Execution failed at step ${step.step_index} (${step.tool_name}): ${exec_res.error}`,
                    null,
                    { failed_step: step.step_index, executed_steps, total_steps },
                );
            }
            executed_steps += 1;
        }

        return Result.success({
            "status": "completed",
            "workflow_id": workflow.id,
            "executed_steps": executed_steps,
            "total_steps": total_steps,
        });
    }

    /** Executes a single step via injected or standard tool executor. */
    private async _dispatch_step(step: WorkflowStep): Promise<Result> {
        if (this._executor) return this._executor(step.tool_name, step.params);

        // Fallback to tool registry. tools.py is still queued for its own port
        // (wave-4 SPLIT); a variable specifier keeps this call site compiling
        // today and resolving at runtime once tools.ts lands — same lazy-import
        // position as the source's function-level `from tools import ...`.
        interface RegistryTool { execute?: (args: Record<string, unknown>) => unknown }
        const tools_spec = "./tools.js";
        const { get_tool_registry } = (await import(tools_spec)) as {
            get_tool_registry: () => { get: (name: string) => RegistryTool | undefined };
        };
        const reg = get_tool_registry();
        const tool = reg.get(step.tool_name);
        if (!tool) {
            return Result.failure(`Tool \`${step.tool_name}\` not found in registry`);
        }

        try {
            // Source: `tool.execute(**step.params)` (kwargs); the TS tool
            // registry convention is one args-object parameter.
            const res = await Promise.resolve(tool.execute?.(step.params));
            if (res instanceof Result) return res;
            return Result.success(res);
        } catch (e) {
            return Result.failure(`Step execution exception: ${String(e)}`);
        }
    }
}

let _default_recorder: WorkflowRecorder | null = null;

export function get_workflow_recorder(): WorkflowRecorder {
    if (_default_recorder === null) {
        _default_recorder = new WorkflowRecorder();
    }
    return _default_recorder;
}

// PORT STATUS: confidence=high todos=[0]
// DIVERGENCE(port): `Path` values are plain strings here; the two boundary
// helpers only join/mkdir/read, so the observable behaviour is identical.
// DIVERGENCE(port): the source inspects `iscoroutinefunction(tool.execute)` and
// wraps sync calls in asyncio.run; JS `await Promise.resolve(...)` handles both
// shapes on one path — same verdict, same error text (str(e)).
// DIVERGENCE(port): replay/_dispatch_step are async (bare-guard polling and the
// tool-registry dispatch are promise-shaped on this host); step ordering,
// circuit-breaker metadata and the fail-open metrics seam are unchanged.
