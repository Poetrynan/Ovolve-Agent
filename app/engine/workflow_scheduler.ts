/**
 * workflow_scheduler.ts — Scheduled workflow execution engine with zero-dependency mini-cron.
 *
 * Ported from `app/backend/workflow_scheduler.py` (521 lines).
 *
 * Provides:
 * 1. MiniCron: Pure standard 5-field cron parser and fast forward next-run evaluator.
 * 2. WorkflowScheduler: SQLite-persisted recurring workflow scheduler with drift
 *    protection, validation gates, and fail-open background loop.
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins (node:crypto uuid via randomUUID, sqlite via sqlite_connection).
 * - §2 ValueError → Error with identical message text; int() semantics via _pyInt
 *   (whitespace/underscore tolerant, Python error message on failure).
 * - §2 datetime naive wall-clock arithmetic → Date constructor normalization
 *   (both operate on calendar fields, matching across DST).
 * - §2 `from X import` inside function → variable dynamic import (skill_loader
 *   not yet ported; rejection == source ImportError path, fail-open).
 * - §6 PORT STATUS trailer at file end.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

import { Result } from "./result.js";
import { Workflow } from "./workflow_recorder.js";
import { WorkflowReplayer } from "./workflow_recorder.js";
import { load_workflow } from "./workflow_recorder.js";
import { openSqlite } from "./sqlite_connection.js";
import { dbDir } from "./user_dirs.js";

// ── Zero-Dependency MiniCron Parser & Evaluator ──

const _CRON_MACROS = new Map<string, string>([
    ["@hourly", "0 * * * *"],
    ["@daily", "0 0 * * *"],
    ["@midnight", "0 0 * * *"],
    ["@weekly", "0 0 * * 0"],
    ["@monthly", "0 0 1 * *"],
    ["@yearly", "0 0 1 1 *"],
    ["@annually", "0 0 1 1 *"],
]);

/** Python int(str)：容许首尾空白与数字间下划线，否则 ValueError 同款消息。 */
function _pyInt(s: string): number {
    const t = s.trim();
    if (/^[+-]?\d(?:_?\d)*$/.test(t)) {
        return parseInt(t.replace(/_/g, ""), 10);
    }
    throw new Error(`invalid literal for int() with base 10: '${s}'`);
}

/** Parses a single cron field into allowed integers. */
export function _parse_cron_field(
    raw: string,
    min_val: number,
    max_val: number,
    is_dow: boolean = false,
): Set<number> {
    let raw2 = raw.trim();
    if (!raw2) {
        throw new Error("Empty cron field");
    }

    const values = new Set<number>();
    const parts = raw2.split(",");
    for (let part of parts) {
        part = part.trim();
        if (!part) {
            continue;
        }
        if (part.includes("/")) {
            const si = part.indexOf("/");
            const range_expr = part.slice(0, si);
            const step_str = part.slice(si + 1);
            let step: number;
            try {
                step = _pyInt(step_str);
            } catch {
                throw new Error(`Invalid step value in field: ${part}`);
            }
            if (step <= 0) {
                throw new Error(`Step must be > 0: ${part}`);
            }

            let start_val: number;
            let end_val: number;
            if (range_expr === "*") {
                start_val = min_val;
                end_val = max_val;
            } else if (range_expr.includes("-")) {
                const di = range_expr.indexOf("-");
                start_val = _pyInt(range_expr.slice(0, di));
                end_val = _pyInt(range_expr.slice(di + 1));
            } else {
                start_val = _pyInt(range_expr);
                end_val = max_val;
            }

            if (start_val < min_val || end_val > max_val || start_val > end_val) {
                throw new Error(
                    `Range [${start_val}, ${end_val}] out of bounds [${min_val}, ${max_val}]`,
                );
            }

            for (let v = start_val; v <= end_val; v += step) {
                values.add(is_dow && v === 7 ? 0 : v);
            }
        } else if (part.includes("-")) {
            const di = part.indexOf("-");
            const start_val = _pyInt(part.slice(0, di));
            const end_val = _pyInt(part.slice(di + 1));
            if (start_val < min_val || end_val > max_val || start_val > end_val) {
                throw new Error(
                    `Range [${start_val}, ${end_val}] out of bounds [${min_val}, ${max_val}]`,
                );
            }
            for (let v = start_val; v <= end_val; v++) {
                values.add(is_dow && v === 7 ? 0 : v);
            }
        } else if (part === "*") {
            for (let v = min_val; v <= max_val; v++) {
                values.add(is_dow && v === 7 ? 0 : v);
            }
        } else {
            let val = _pyInt(part);
            if (is_dow && val === 7) {
                val = 0;
            }
            if (val < min_val || val > max_val) {
                throw new Error(`Value ${val} out of bounds [${min_val}, ${max_val}]`);
            }
            values.add(val);
        }
    }

    if (values.size === 0) {
        throw new Error(`No valid values parsed from field: ${raw2}`);
    }
    return values;
}

/** Pure-standard 5-field cron parser and evaluator. */
export class MiniCron {
    expr: string;
    min_raw: string;
    hour_raw: string;
    dom_raw: string;
    mon_raw: string;
    dow_raw: string;
    minutes: Set<number>;
    hours: Set<number>;
    days: Set<number>;
    months: Set<number>;
    dows: Set<number>;
    dom_is_wildcard: boolean;
    dow_is_wildcard: boolean;

    constructor(expr: string) {
        this.expr = expr.trim();
        const expanded = _CRON_MACROS.get(this.expr) ?? this.expr;
        const tokens = expanded.split(/\s+/).filter((t) => t.length > 0);
        if (tokens.length !== 5) {
            throw new Error(
                `Cron expression must contain exactly 5 fields, got ${tokens.length}: '${expr}'`,
            );
        }

        [this.min_raw, this.hour_raw, this.dom_raw, this.mon_raw, this.dow_raw] =
            tokens as [string, string, string, string, string];
        this.minutes = _parse_cron_field(this.min_raw, 0, 59);
        this.hours = _parse_cron_field(this.hour_raw, 0, 23);
        this.days = _parse_cron_field(this.dom_raw, 1, 31);
        this.months = _parse_cron_field(this.mon_raw, 1, 12);
        this.dows = _parse_cron_field(this.dow_raw, 0, 7, true);

        this.dom_is_wildcard = this.dom_raw === "*";
        this.dow_is_wildcard = this.dow_raw === "*";
    }

    /** Calculates the next matching timestamp strictly greater than `after`. */
    get_next_run(after?: number | Date | null): number {
        let base: Date;
        if (after === null || after === undefined) {
            base = new Date();
        } else if (typeof after === "number") {
            base = new Date(after * 1000.0);
        } else {
            base = new Date(after.getTime());
        }
        // replace(microsecond=0) then replace(second=0) + timedelta(minutes=1)
        base = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
            base.getHours(), base.getMinutes(), 0, 0);
        let curr = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
            base.getHours(), base.getMinutes() + 1, 0, 0);

        // Look up to 5 years ahead
        const max_steps = 5 * 366 * 24 * 60;
        for (let _ = 0; _ < max_steps; _++) {
            const month = curr.getMonth() + 1;
            if (!this.months.has(month)) {
                if (month === 12) {
                    // Python datetime(year+1,1,1) raises OverflowError("year 10000 is out of range")
                    // long before the 5-year step cap for never-matching crons (e.g. "0 0 30 2 *");
                    // JS Dates tolerate year 10000, so replicate the original error point verbatim.
                    if (curr.getFullYear() + 1 > 9999) {
                        throw new Error("year 10000 is out of range");
                    }
                    curr = new Date(curr.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
                } else {
                    curr = new Date(curr.getFullYear(), month, 1, 0, 0, 0, 0);
                }
                continue;
            }

            const day = curr.getDate();
            // cron dow(日=0) == JS getDay(); Python weekday()+1 恰好还原该映射。
            const cron_dow = curr.getDay();
            let day_match: boolean;
            if (this.dom_is_wildcard && this.dow_is_wildcard) {
                day_match = true;
            } else if (!this.dom_is_wildcard && this.dow_is_wildcard) {
                day_match = this.days.has(day);
            } else if (this.dom_is_wildcard && !this.dow_is_wildcard) {
                day_match = this.dows.has(cron_dow);
            } else {
                day_match = this.days.has(day) || this.dows.has(cron_dow);
            }

            if (!day_match) {
                curr = new Date(curr.getFullYear(), curr.getMonth(), day + 1, 0, 0, 0, 0);
                continue;
            }

            const hour = curr.getHours();
            if (!this.hours.has(hour)) {
                curr = new Date(curr.getFullYear(), curr.getMonth(), day, hour + 1, 0, 0, 0);
                continue;
            }

            if (this.minutes.has(curr.getMinutes())) {
                return curr.getTime() / 1000.0;
            }

            curr = new Date(curr.getFullYear(), curr.getMonth(), day, hour,
                curr.getMinutes() + 1, 0, 0);
        }

        throw new Error(`No matching run time found within 5 years for cron: ${this.expr}`);
    }
}

/** Validates whether a string is a well-formed 5-field cron or recognized macro. */
export function validate_cron(cron_expr: string): [boolean, string] {
    try {
        new MiniCron(cron_expr);
        return [true, ""];
    } catch (exc) {
        return [false, exc instanceof Error ? exc.message : String(exc)];
    }
}

/** Convenience evaluator returning next run timestamp. */
export function get_next_run(cron_expr: string, after?: number | Date | null): number {
    return new MiniCron(cron_expr).get_next_run(after === undefined ? null : after);
}

// ── Workflow Eligibility Validation ──

/** Checks whether a workflow is sufficiently mature or promoted for recurring automation. */
export async function is_workflow_eligible_for_scheduling(
    wf: Workflow,
): Promise<[boolean, string]> {
    // 1. Skill Loader status
    try {
        const loader_spec = "./skill_loader.js";
        const mod = (await import(loader_spec)) as {
            get_skill_loader: () => { get_skill: (n: string) => { status?: unknown } | null };
            SkillStatus?: { IMPORTED?: unknown };
        };
        const loader = mod.get_skill_loader();
        const imported = mod.SkillStatus?.IMPORTED ?? "imported";
        for (const candidate_name of [wf.id, `wf-${wf.id}`, wf.name]) {
            const entry = loader.get_skill(candidate_name);
            if (entry) {
                const st = entry.status;
                const status_val = (st && typeof st === "object" && "value" in (st as Record<string, unknown>))
                    ? (st as Record<string, unknown>)["value"]
                    : undefined;
                if (st === imported || status_val === "imported") {
                    return [true, ""];
                }
            }
        }
    } catch {
        // 源语义：skill_loader 不可用时静默降级
    }

    // 2. Workflow metadata promotion status
    const meta = (wf.metadata ?? {}) as Record<string, unknown>;
    if (["imported", "promoted", "active"].includes(meta["status"] as string)) {
        return [true, ""];
    }
    if (meta["promoted"] === true) {
        return [true, ""];
    }

    // 3. Workflow metrics candidate status
    // NOTE: 源如此——每个调用都 new 一个空 tracker，此分支恒为 False。逐字保留。
    try {
        const { WorkflowMetricsTracker } = await import("./workflow_evolution.js");
        const tracker = new WorkflowMetricsTracker();
        const metrics = tracker.get_metrics(wf.id);
        if (metrics && metrics.is_promotion_candidate) {
            return [true, ""];
        }
    } catch {
        // fail-open
    }

    return [false,
        `Workflow \`${wf.id}\` is not eligible for scheduled execution: must be imported as a skill, ` +
        "marked as imported in metadata, or qualified as a promotion candidate.",
    ];
}

// ── WorkflowScheduler Service ──

export class WorkflowSchedule {
    id: string;
    workflow_id: string;
    cron_expr: string;
    session_id: string;
    enabled: number;
    last_run: number | null;
    next_run: number;
    created_at: number | null;
    error_count: number;
    last_error: string;

    constructor(
        id: string,
        workflow_id: string,
        cron_expr: string,
        session_id: string = "",
        enabled: number = 1,
        last_run: number | null = null,
        next_run: number = 0.0,
        created_at?: number | null,
        error_count: number = 0,
        last_error: string = "",
    ) {
        this.id = id;
        this.workflow_id = workflow_id;
        this.cron_expr = cron_expr;
        this.session_id = session_id;
        this.enabled = enabled;
        this.last_run = last_run;
        this.next_run = next_run;
        // field(default_factory=time.time)：仅缺省时取当前时间。
        this.created_at = created_at === undefined ? Date.now() / 1000.0 : created_at;
        this.error_count = error_count;
        this.last_error = last_error;
    }

    /** dataclasses.asdict：按字段声明顺序。 */
    to_dict(): Record<string, unknown> {
        return {
            id: this.id,
            workflow_id: this.workflow_id,
            cron_expr: this.cron_expr,
            session_id: this.session_id,
            enabled: this.enabled,
            last_run: this.last_run,
            next_run: this.next_run,
            created_at: this.created_at,
            error_count: this.error_count,
            last_error: this.last_error,
        };
    }
}

export class WorkflowScheduler {
    /** Manages scheduled workflow tasks with SQLite persistence and an async polling loop. */

    db_path: string;
    poll_interval_s: number;
    workflow_dir: string | null;
    private _running: boolean = false;
    private _task: Promise<void> | null = null;
    private _task_done: boolean = true;

    constructor(
        db_path?: string | null,
        poll_interval_s: number = 15.0,
        workflow_dir?: string | null,
    ) {
        if (db_path === null || db_path === undefined) {
            let resolved_dir: string;
            try {
                resolved_dir = dbDir();
            } catch {
                resolved_dir = nodePath.join(os.homedir(), ".ovolve", "db");
            }
            fs.mkdirSync(resolved_dir, { recursive: true });
            this.db_path = nodePath.join(resolved_dir, "workflow_schedules.db");
        } else {
            this.db_path = db_path;
            if (db_path !== ":memory:") {
                fs.mkdirSync(nodePath.dirname(nodePath.resolve(db_path)), { recursive: true });
            }
        }

        this.poll_interval_s = poll_interval_s;
        this.workflow_dir = workflow_dir ?? null;
        this._init_db();
    }

    // 源的 `with conn:` 只做提交（node:sqlite 逐语句自动提交）；
    // Python 连接随作用域结束被 GC，TS 必须显式 close，故统一 finally 关闭。
    private _withConn<T>(fn: (conn: ReturnType<typeof openSqlite>) => T): T {
        const conn = openSqlite(this.db_path);
        try {
            return fn(conn);
        } finally {
            conn.close();
        }
    }

    private _init_db(): void {
        this._withConn((conn) => {
            conn.execute(
                `
                CREATE TABLE IF NOT EXISTS workflow_schedules (
                    id TEXT PRIMARY KEY,
                    workflow_id TEXT NOT NULL,
                    cron_expr TEXT NOT NULL,
                    session_id TEXT DEFAULT '',
                    enabled INTEGER DEFAULT 1,
                    last_run REAL DEFAULT NULL,
                    next_run REAL NOT NULL,
                    created_at REAL NOT NULL,
                    error_count INTEGER DEFAULT 0,
                    last_error TEXT DEFAULT ''
                );
                `,
            );
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_workflow_schedules_next_run ON workflow_schedules(enabled, next_run);",
            );
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_workflow_schedules_wf_id ON workflow_schedules(workflow_id);",
            );
            conn.commit();
        });
    }

    /** Creates and registers a recurring schedule for a workflow. */
    async create_schedule(
        workflow_id: string,
        cron_expr: string,
        session_id: string = "",
        require_promoted: boolean = true,
    ): Promise<Result> {
        const [valid, err] = validate_cron(cron_expr);
        if (!valid) {
            return Result.failure(`Invalid cron expression '${cron_expr}': ${err}`);
        }

        const wf = load_workflow(workflow_id, this.workflow_dir);
        if (!wf) {
            return Result.failure(`Workflow \`${workflow_id}\` not found on disk`);
        }
        if (!wf.steps.length) {
            return Result.failure(`Workflow \`${workflow_id}\` has no executable steps`);
        }

        if (require_promoted) {
            const [eligible, reason] = await is_workflow_eligible_for_scheduling(wf);
            if (!eligible) {
                return Result.failure(reason);
            }
        }

        const next_run = get_next_run(cron_expr);
        const sched_id = `sched_${Math.trunc(Date.now() / 1000.0)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
        const now = Date.now() / 1000.0;

        const schedule = new WorkflowSchedule(
            sched_id,
            workflow_id,
            cron_expr,
            session_id,
            1,
            null,
            next_run,
            now,
            0,
            "",
        );

        this._withConn((conn) => {
            conn.execute(
                `
                INSERT INTO workflow_schedules (id, workflow_id, cron_expr, session_id, enabled, last_run, next_run, created_at, error_count, last_error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    schedule.id,
                    schedule.workflow_id,
                    schedule.cron_expr,
                    schedule.session_id,
                    schedule.enabled,
                    schedule.last_run,
                    schedule.next_run,
                    schedule.created_at,
                    schedule.error_count,
                    schedule.last_error,
                ],
            );
            conn.commit();
        });

        return Result.success(schedule.to_dict());
    }

    /** Lists all registered workflow schedules. */
    list_schedules(enabled_only: boolean = false): Record<string, unknown>[] {
        let query = "SELECT * FROM workflow_schedules";
        const params: unknown[] = [];
        if (enabled_only) {
            query += " WHERE enabled = 1";
        }
        query += " ORDER BY created_at DESC";

        return this._withConn((conn) => {
            const cursor = conn.execute(query, params);
            const rows = cursor.fetchall();
            return rows.map((r) => ({ ...r }));
        });
    }

    /** Retrieves a single schedule by ID. */
    get_schedule(schedule_id: string): Record<string, unknown> | null {
        return this._withConn((conn) => {
            const cursor = conn.execute(
                "SELECT * FROM workflow_schedules WHERE id = ?", [schedule_id],
            );
            const row = cursor.fetchone();
            return row ? { ...row } : null;
        });
    }

    /** Removes a schedule by ID. */
    delete_schedule(schedule_id: string): Result {
        let deleted = false;
        this._withConn((conn) => {
            const cursor = conn.execute(
                "DELETE FROM workflow_schedules WHERE id = ?", [schedule_id],
            );
            conn.commit();
            if (cursor.rowcount > 0) {
                deleted = true;
            }
        });
        if (deleted) {
            return Result.success({ deleted: true, schedule_id: schedule_id });
        }
        return Result.failure(`Schedule \`${schedule_id}\` not found`);
    }

    /** Enables or disables an existing schedule. */
    set_enabled(schedule_id: string, enabled: boolean): Result {
        const sched = this.get_schedule(schedule_id);
        if (!sched) {
            return Result.failure(`Schedule \`${schedule_id}\` not found`);
        }

        const int_enabled = enabled ? 1 : 0;
        let update_next_run = sched["next_run"] as number;
        if (enabled && (sched["next_run"] as number) <= Date.now() / 1000.0) {
            update_next_run = get_next_run(sched["cron_expr"] as string);
        }

        this._withConn((conn) => {
            conn.execute(
                "UPDATE workflow_schedules SET enabled = ?, next_run = ? WHERE id = ?",
                [int_enabled, update_next_run, schedule_id],
            );
            conn.commit();
        });

        return Result.success({ schedule_id: schedule_id, enabled: Boolean(int_enabled) });
    }

    /** Finds all due schedules, executes their workflows, and advances next_run. */
    async trigger_due(
        now?: number | null,
        replayer?: WorkflowReplayer | null,
    ): Promise<Record<string, unknown>[]> {
        const eval_time = now !== undefined && now !== null ? now : Date.now() / 1000.0;
        const results: Record<string, unknown>[] = [];

        const due_rows = this._withConn((conn) => {
            const cursor = conn.execute(
                "SELECT * FROM workflow_schedules WHERE enabled = 1 AND next_run <= ?",
                [eval_time],
            );
            return cursor.fetchall().map((r) => ({ ...r }));
        });

        for (const row of due_rows) {
            const sched_id = row["id"] as string;
            const wf_id = row["workflow_id"] as string;
            const cron_expr = row["cron_expr"] as string;
            const session_id = (row["session_id"] as string | null) || "";
            const error_count = (row["error_count"] as number | null) || 0;

            const wf = load_workflow(wf_id, this.workflow_dir);
            if (!wf) {
                const err_msg = `Workflow \`${wf_id}\` missing from disk during scheduled replay`;
                const new_next = get_next_run(cron_expr, eval_time);
                this._withConn((conn) => {
                    conn.execute(
                        `
                        UPDATE workflow_schedules
                        SET last_run = ?, next_run = ?, error_count = ?, last_error = ?
                        WHERE id = ?
                        `,
                        [eval_time, new_next, error_count + 1, err_msg, sched_id],
                    );
                    conn.commit();
                });
                results.push({ schedule_id: sched_id, workflow_id: wf_id, ok: false, error: err_msg });
                continue;
            }

            const active_replayer = replayer ?? new WorkflowReplayer();
            const replay_res = await active_replayer.replay(wf, true, session_id);

            const new_next = get_next_run(cron_expr, eval_time);
            const is_ok = Boolean(replay_res.ok);
            const err_text = is_ok ? "" : String(replay_res.error);
            const new_error_count = is_ok ? error_count : error_count + 1;

            this._withConn((conn) => {
                conn.execute(
                    `
                    UPDATE workflow_schedules
                    SET last_run = ?, next_run = ?, error_count = ?, last_error = ?
                    WHERE id = ?
                    `,
                    [eval_time, new_next, new_error_count, err_text, sched_id],
                );
                conn.commit();
            });

            results.push({
                schedule_id: sched_id,
                workflow_id: wf_id,
                ok: is_ok,
                error: err_text,
                next_run: new_next,
            });
        }

        return results;
    }

    /** Starts the background polling loop. */
    start(): void {
        if (this._running) {
            return;
        }
        this._running = true;
        // Python：无运行中事件循环时抛 RuntimeError 静默、不建任务。Node 事件
        // 循环恒在，任务总会被创建（见文末 DIVERGENCE）。
        if (this._task === null || this._task_done) {
            this._task_done = false;
            this._task = this._run_loop().finally(() => {
                this._task_done = true;
            });
        }
    }

    /** Stops the background polling loop. */
    stop(): void {
        this._running = false;
        if (this._task !== null && !this._task_done) {
            // asyncio Task.cancel()：本实现的循环在 sleep 醒来后检查
            // _running 即 break，观测语义一致。
            this._task = null;
        }
    }

    private async _run_loop(): Promise<void> {
        while (this._running) {
            try {
                await new Promise<void>((r) => setTimeout(r, this.poll_interval_s * 1000));
                if (!this._running) {
                    break;
                }
                await this.trigger_due();
            } catch {
                // 源：CancelledError → break；其余异常吞掉继续轮询
                if (!this._running) {
                    break;
                }
            }
        }
    }
}

// ── Global Singleton Access ──

let _default_scheduler: WorkflowScheduler | null = null;

export function get_workflow_scheduler(db_path?: string | null): WorkflowScheduler {
    if (_default_scheduler === null) {
        _default_scheduler = new WorkflowScheduler(db_path ?? null);
    }
    return _default_scheduler;
}

export function set_default_workflow_scheduler(scheduler: WorkflowScheduler | null): void {
    _default_scheduler = scheduler;
}

// ---------------------------------------------------------------------------
// DIVERGENCE(port): SQLite 连接池形态——Python 每个 with 块新建 sqlite3 连接并
//   交给 GC；node:sqlite 必须显式 close，统一经 _withConn（行为仍是逐语句自动
//   提交，与原 commit() 点等价）。
// DIVERGENCE(port): start()/stop()：Node 无 asyncio“无运行循环”RuntimeError 分
//   支（事件循环恒在），任务总创建；cancel 语义由 _running 标志在睡眠醒来后检
//   查实现，停止观测一致，仅中断粒度为一次 poll 间隔。
// DIVERGENCE(port): create_schedule / trigger_due / is_workflow_eligible 因
//   skill_loader 动态 import 与 replayer.replay 的 promise 形态改为 async；
//   计算结果与原语义一致。
// ---------------------------------------------------------------------------

// PORT STATUS: confidence=high todos=[0]
