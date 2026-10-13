/**
 * skill_lifecycle.ts — Skill 候选的完整生命周期（Step E）。
 *
 * Ported from `app/backend/skill_lifecycle.py` (642 lines).
 *
 *     candidate → 结构检查 → 秘密/注入扫描 → 来源回放 → 碰撞/换代检查 → staged
 *               → 用户审批 → active（写盘 + 载入运行时）
 *     active   → degraded（连续失败，advisory）→ stale / archived
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/<name>.py -> app/engine/<name>.ts (SPLIT, TS half).
 *       py kwargs calls become the trailing options object (insert_skill_
 *       candidate, set_skill_candidate_status, list_skill_experiences — the
 *       already-landed storage/domains/skills.ts surfaces); keyword-only
 *       `*, skills_root=None` / `*, shadow_ratio=0.2` become trailing options
 *       / defaulted params.
 *   §2  present-but-null everywhere: c.get("k", d) returns None when the key
 *       is PRESENT with a null value — dictGet mirrors it and no interpolation
 *       folds it with ??/||. f"name: {c.get('name','')}" renders "None" for
 *       present-null exactly like the source's f-string; the `or`-gates
 *       (`c.get("steps") or []`, `str(fields.get(...) or "")`, `skills_root or
 *       default_skills_root()`) are Python falsy gates via pyTruth.
 *   §2  crash semantics kept: create_candidate's `exp["skill_id"]` and
 *       promote's `cand["status"]` are dict SUBSCRIPTS — a missing key raises
 *       KeyError at exactly that point (only insert_skill_candidate and the
 *       ledger probes are inside except-blocks; the subscripts are not).
 *       dictSub reproduces that.
 *   §2  broad swallows kept verbatim, with the source's own noqa markers:
 *       the completed_side_effects / list_skill_experiences / get_goal probes
 *       (`except Exception: landed=[]/successes=0/pass`), the import-failure
 *       cleanup rmtree (`except Exception: pass  # fail-open`), the
 *       rollback-restore probe, and _abort_activation's print-on-failure.
 *   §2  `[-400:]` tail slice, `[:8]` version prefix, `sorted(..., key=...,
 *       reverse=True)` stable ordering, `dict.fromkeys` order-preserving
 *       dedup, and the `{"__task__"}` sentinel via getattr(storage, ...,
 *       "__task__")` are all mirrored.
 *   §2  f-string str() semantics: `{exp.get('outcome')}` renders "None" when
 *       the key is absent; `{e}` in failure texts is str(exc) — Error.message
 *       carries the Python-shaped text for errors we construct.
 *
 * MIGRATION DECISIONS (not divergences — documented dispositions)
 *   host seams: `from sandbox import run_confined_capture` is a Native-routed
 *       module (sandbox.py, wave 1) not landed as TS. Consumed through a
 *       bindable host seam (setPythonRuntime / bind_native_desktop precedent
 *       in executors.ts / app_agent.ts). Unbound → calling it throws, which
 *       propagates out of approve() exactly like Python's ImportError would.
 *   lazy imports that are already landed TS (skill_vetter.vet_skill,
 *       atomic_rule_swapper.AtomicRuleSwapper, skill_loader.TrustLevel) become
 *       static imports; the atomic_rule_swapper ImportError fallback
 *       (`app.backend.` form) disappears with the module system.
 *   shutil.copy2 → fs.copyFileSync (contents + best-effort mtime; Python's
 *       atime preservation is not observable here). DIVERGENCE(port): the
 *       source catches OSError only at those sites; the only errors copyFile/
 *       mkdir/read realistically raise in Node are IO errors mapped to the
 *       same catch, so the reachable paths agree.
 *   hashlib.sha256 → node:crypto, hex prefix [:8] identical.
 *   time.time() → Date.now()/1000 (float seconds; int() truncation mirrored
 *       at the snapshot-name site).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Result } from "./result.js";
import { AtomicRuleSwapper } from "./atomic_rule_swapper.js";
import { TrustLevel } from "./skill_loader.js";
import type { SkillEntry } from "./skill_loader.js";
import { vet_skill } from "./skill_vetter.js";
import type { JsonDict } from "./danger_classifier.js";

// ── house Python-semantics helpers (per-file, project convention) ──────────

function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return String(v);
}

/** str(exc): our constructed Errors carry the Python-shaped message. */
function pyStrExc(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isPyDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (!isPyDict(obj)) {
    throw new Error(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? (obj as Record<string, unknown>)[key] : dflt;
}

/** dict[key] subscript — raises on a missing key like Python. */
function dictSub(obj: Record<string, unknown>, key: string): unknown {
  if (!(key in obj)) {
    throw new Error(`KeyError: '${key}'`);
  }
  return obj[key];
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** `str(a or b or "")` — falsy or-gate then str(). */
function pyStrOr(v: unknown, dflt: unknown): string {
  return pyStr(pyTruth(v) ? v : dflt);
}

/** python time.time() — float seconds. */
function timeNow(): number {
  return Date.now() / 1000;
}

// ── structural surfaces of the injected host objects ────────────────────────

/** The storage methods this module touches (skills/effects/goal domains). */
export interface SkillLifecycleStorage {
  TASK_LEVEL_SKILL_ID?: string;
  get_skill_experience(experience_id: string): JsonDict | null;
  list_skill_experiences(opts?: {
    skill_id?: string | null;
    goal_id?: string | null;
    limit?: number;
  }): JsonDict[];
  insert_skill_candidate(opts: JsonDict): string;
  get_skill_candidate(cid: string): JsonDict | null;
  set_skill_candidate_status(
    cid: string,
    status: string,
    opts?: { version?: string | null; gate_report?: unknown; snapshot_path?: string | null },
  ): boolean;
  completed_side_effects?: (goal_id: string) => unknown[];
  get_goal?: (goal_id: string) => JsonDict | null;
}

/** The loader methods this module touches (skill_loader.ts surface). */
export interface SkillLifecycleLoader {
  get_skill(name: string): SkillEntry | null;
  import_skill(skill_dir: string, trust?: string): Result;
  disable_skill(name: string): Result;
}

/** sandbox.run_confined_capture's dict result (read via .get everywhere). */
export type ConfinedCaptureFn = (
  command: string,
  opts?: { cwd?: string; timeout?: number; mode?: string; strict?: boolean },
) => JsonDict;

// ── host seam: sandbox.py (Native-routed, wave 1 — not landed as TS) ────────

let _runConfinedCapture: ConfinedCaptureFn | null = null;

/** Bind the native/Python sandbox (setPythonRuntime precedent). */
export function bind_sandbox(fn: ConfinedCaptureFn | null): void {
  _runConfinedCapture = fn;
}

function run_confined_capture(
  command: string,
  opts: { cwd?: string; timeout?: number; mode?: string; strict?: boolean },
): JsonDict {
  if (_runConfinedCapture === null) {
    // Python: `from sandbox import run_confined_capture` with the module
    // absent → ImportError, propagating out of approve(). Same here.
    throw new Error("ModuleNotFoundError: No module named 'sandbox' (host seam not bound)");
  }
  return _runConfinedCapture(command, opts);
}

// ── constants and pure helpers ──────────────────────────────────────────────

/** 结构门的必填字段。steps 是列表单独查。 */
export const REQUIRED_FIELDS: readonly string[] = ["name", "description", "when_to_use", "verification"];

/** 秘密/注入扫描的拦截线（Severity.HIGH=3）。 */
export const GATE_BLOCK_SEVERITY = 3;

/** 与 SkillLoader.discover 的第一优先根保持一致：项目本地技能目录。 */
export function default_skills_root(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ""));
  const project = path.resolve(here, "..", "..");
  return path.join(project, ".agents", "skills");
}

/**
 * RULEBOOK §2 (join TypeError): `"\n".join(lines)` raises
 * `TypeError: sequence item N: expected str instance, NoneType found` when a
 * present-but-null value (c.get("k", "") → None) lands in `lines` un-str()'d.
 * The source only str()s name/description inside f-strings; the bare
 * `c.get("when_to_use", "")` / conditional `c["scope"]` elements are appended
 * raw, so a present-null value CRASHES the render at that item index — and a
 * non-str truthy scope/preconditions/inputs/outputs/known_failures value too.
 * pyJoin mirrors that exactly (index counts into `lines`; steps/tools ARE
 * str()'d by their comprehensions, so non-str items there stay safe).
 */
function pyJoin(lines: unknown[]): string {
  for (let i = 0; i < lines.length; i++) {
    const v = lines[i];
    if (typeof v !== "string") {
      throw new Error(
        `sequence item ${i}: expected str instance, ${pyTypeName(v)} found`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * 把候选项渲染成合法的 SKILL.md。纯函数，门禁扫描和激活写盘共用同一份
 * 渲染——审过的内容就是落盘的内容，不存在"审 A 写 B"。
 */
export function render_skill_md(c: JsonDict): string {
  const steps = (pyTruth(dictGet(c, "steps")) ? dictGet(c, "steps") : []) as unknown[];
  const tools = (pyTruth(dictGet(c, "required_tools")) ? dictGet(c, "required_tools") : []) as unknown[];
  const lines: unknown[] = [
    "---",
    `name: ${pyStr(dictGet(c, "name", ""))}`,
    `description: ${pyStr(dictGet(c, "description", ""))}`,
    "version: draft",
    "---",
    "",
    `# ${pyStr(dictGet(c, "name", ""))}`,
    "",
    "## When to use",
    dictGet(c, "when_to_use", ""),
    "",
  ];
  if (pyTruth(dictGet(c, "scope"))) {
    lines.push("## Scope", (c as Record<string, unknown>)["scope"], "");
  }
  if (pyTruth(dictGet(c, "preconditions"))) {
    lines.push("## Preconditions", (c as Record<string, unknown>)["preconditions"], "");
  }
  if (pyTruth(dictGet(c, "inputs"))) {
    lines.push("## Inputs", (c as Record<string, unknown>)["inputs"], "");
  }
  if (pyTruth(dictGet(c, "outputs"))) {
    lines.push("## Outputs", (c as Record<string, unknown>)["outputs"], "");
  }
  lines.push("## Steps");
  steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${pyStr(s)}`);
  });
  lines.push("");
  if (pyTruth(tools)) {
    lines.push("## Required tools", tools.map((t) => pyStr(t)).join(", "), "");
  }
  lines.push("## Verification", dictGet(c, "verification", ""), "");
  if (pyTruth(dictGet(c, "known_failures"))) {
    lines.push("## Known failures", (c as Record<string, unknown>)["known_failures"], "");
  }
  return pyJoin(lines);
}

// ── 创建：证据是入场券 ──────────────────────────────────────────────────────

/**
 * 从真实证据孵化候选。experience_ref 必须指向一条成功经验——这是
 * "学习必须来自成功执行轨迹"在代码里的样子，不是口号。
 */
export function create_candidate(storage: SkillLifecycleStorage, fields: JsonDict): Result {
  const expRef = pyStrOr(dictGet(fields, "experience_ref"), "");
  const exp = expRef ? storage.get_skill_experience(expRef) : null;
  if (!pyTruth(exp)) {
    return Result.failure("候选必须绑定一条真实经验（experience_ref 无效）");
  }
  const expDict = exp as JsonDict;
  if (dictGet(expDict, "outcome") !== "success") {
    return Result.failure(
      `证据经验 ${expRef} 的结局是 ${pyStr(dictGet(expDict, "outcome"))}，不是 success——拒绝孵化`,
    );
  }
  const rawName = pyStrOr(dictGet(fields, "name"), "");
  const name = rawName.trim() !== "" ? rawName.trim() : pyStr(dictSub(expDict as Record<string, unknown>, "skill_id"));
  let cid: string;
  try {
    cid = storage.insert_skill_candidate({
      name: name,
      description: pyStrOr(dictGet(fields, "description"), ""),
      when_to_use: pyStrOr(dictGet(fields, "when_to_use"), ""),
      scope: pyStrOr(dictGet(fields, "scope"), ""),
      preconditions: pyStrOr(dictGet(fields, "preconditions"), ""),
      inputs: pyStrOr(dictGet(fields, "inputs"), ""),
      outputs: pyStrOr(dictGet(fields, "outputs"), ""),
      steps: pyTruth(dictGet(fields, "steps")) ? structuredClone(dictGet(fields, "steps") as unknown[]) : [],
      required_tools: pyTruth(dictGet(fields, "required_tools"))
        ? structuredClone(dictGet(fields, "required_tools") as unknown[])
        : [],
      risk_level: pyStrOr(dictGet(fields, "risk_level"), "medium"),
      verification: pyStrOr(dictGet(fields, "verification"), ""),
      known_failures: pyStrOr(dictGet(fields, "known_failures"), ""),
      memory_refs: pyTruth(dictGet(fields, "memory_refs"))
        ? structuredClone(dictGet(fields, "memory_refs") as unknown[])
        : [],
      experience_ref: expRef,
      source_event_ids: [dictGet(expDict, "experience_id")].filter((expId) => pyTruth(expId)),
      superseded_skill: pyStrOr(dictGet(fields, "superseded_skill"), ""),
      verify_command: pyStrOr(dictGet(fields, "verify_command"), ""),
    });
  } catch (e) {
    return Result.failure(`候选落库失败: ${pyStrExc(e)}`);
  }
  return Result.success(storage.get_skill_candidate(cid));
}

// ── 门禁：candidate → staged ───────────────────────────────────────────────

/**
 * 四道门。全部通过才有资格进 staged；任何一道不过都会给出可读原因。
 * The returned object's key insertion order is load-bearing (JSON reports):
 * structural, secret_scan, source_evidence, evidence_strength, collision.
 */
export function run_gates(
  storage: SkillLifecycleStorage,
  cand: JsonDict,
  loader: SkillLifecycleLoader | null = null,
): JsonDict {
  const report: JsonDict = {};

  const missing: string[] = [];
  for (const f of REQUIRED_FIELDS) {
    if (pyStrOr(dictGet(cand, f), "").trim() === "") missing.push(f);
  }
  if (missing.length === 0 && !pyTruth(dictGet(cand, "steps"))) {
    missing.push("steps(至少一步)");
  }
  report["structural"] = {
    ok: missing.length === 0,
    detail: missing.length ? "缺少必填字段: " + missing.join(", ") : "ok",
  };

  const content = render_skill_md(cand);
  const vr = vet_skill(content);
  const blocking = vr.findings.filter((f) => Number(f.severity) >= GATE_BLOCK_SEVERITY);
  const warnings = vr.findings.filter((f) => Number(f.severity) < GATE_BLOCK_SEVERITY);
  report["secret_scan"] = {
    ok: blocking.length === 0,
    detail: blocking.length
      ? "高危模式: " + blocking.map((f) => `${f.rule_id}@L${f.line}`).join("; ")
      : warnings.length
        ? `${warnings.length} 条低危提示`
        : "ok",
  };

  const exp = pyTruth(dictGet(cand, "experience_ref"))
    ? storage.get_skill_experience((dictGet(cand, "experience_ref") ?? "") as string)
    : null;
  let replayOk = pyTruth(exp) && dictGet(exp, "outcome") === "success";
  let detail = replayOk
    ? `经验 ${pyStr(dictGet(cand, "experience_ref"))} 存在且成功`
    : `来源经验不可回放或非成功: ${pyStr(dictGet(cand, "experience_ref"))}`;
  // 来源回放证据化：经验绑定到目标时，还必须有真实落地的东西作佐证——
  // 光有一条"成功"记录不够，账本里得有干过的活。
  let landed: unknown[] = [];
  if (replayOk && pyTruth(dictGet(exp, "goal_id"))) {
    try {
      landed = (storage.completed_side_effects as (g: string) => unknown[]).call(
        storage,
        (exp as JsonDict)["goal_id"] as string,
      );
    } catch {
      // noqa: BLE001 — 探针失败按无佐证处理。
      landed = [];
    }
    if (landed.length) {
      detail += `；目标 ${(exp as JsonDict)["goal_id"]} 有 ${landed.length} 条已落地副作用佐证`;
    } else {
      replayOk = false;
      detail =
        `来源经验声称成功，但其目标 ${(exp as JsonDict)["goal_id"]} ` +
        "没有任何已落地副作用可回放——证据不足";
    }
  }
  // 这道门以前叫 source_replay，而它从不重放任何东西：它检查的是"账本里有没有
  // 这条成功经验、有没有落地痕迹"。名字撒的谎比缺陷本身更贵——读报告的人会以为
  // 系统真的把来源轨迹重跑了一遍。改成 source_evidence，并显式写明这一点。
  report["source_evidence"] = {
    ok: replayOk,
    detail: detail,
    isReExecution: false,
  };

  // §9.4 要求"source replay、相似 holdout 或 deterministic validator 至少其一"。
  const strength: string[] = [];
  if (landed.length) {
    strength.push(`source-replay 代理：${landed.length} 条已落地副作用`);
  }
  let successes = 0;
  // 按**来源经验的 skill_id** 统计，而不是候选的新名字：跑过的是那个东西，
  // 重复性只能由它的履历证明。哨兵行（无技能覆盖的任务）刻意排除——那是
  // "一堆互不相关的任务都成功了"，不是"这个流程成功了两次"。
  const srcSkill = pyStrOr(dictGet(pyTruth(exp) ? exp : {}, "skill_id"), "");
  const taskSentinel =
    "TASK_LEVEL_SKILL_ID" in storage
      ? (storage["TASK_LEVEL_SKILL_ID"] as string)
      : "__task__";
  if (srcSkill && srcSkill !== taskSentinel) {
    try {
      const rows = storage.list_skill_experiences({ skill_id: srcSkill, limit: 50 }) || [];
      const seen = new Set<string>();
      for (const r of rows) {
        if (dictGet(r, "outcome") === "success") {
          // set of (run_id, turn_id) tuples — serialize the pair, keep the raw
          // present-vs-missing distinction (None vs "" are distinct tuples).
          seen.add(JSON.stringify([dictGet(r, "run_id") ?? null, dictGet(r, "turn_id") ?? null]));
        }
      }
      successes = seen.size;
    } catch {
      // noqa: BLE001
      successes = 0;
    }
  }

  if (successes >= 2) {
    // holdout 的诚实代理：不是"留出集"，是"在两个互不相同的场合各成功过一次"。
    strength.push(`重复性代理：${successes} 次互相独立的成功`);
  }
  if (pyStrOr(dictGet(cand, "verify_command"), "").trim() !== "") {
    strength.push("确定性验证：候选声明了 verify_command（批准时真跑）");
  }
  if (pyTruth(exp) && pyTruth(dictGet(exp, "goal_id"))) {
    try {
      const goal = storage.get_goal ? storage.get_goal((exp as JsonDict)["goal_id"] as string) : null;
      if (pyStrOr(dictGet(pyTruth(goal) ? goal : {}, "verification_result"), "").trim() !== "") {
        strength.push("目标验证器留有机器结论");
      }
    } catch {
      // noqa: BLE001
    }
  }
  report["evidence_strength"] = {
    ok: strength.length > 0,
    detail: strength.length
      ? strength.join("；")
      : "三条证据（回放痕迹 / 重复成功 / 确定性验证）一条都没有——" +
        "单次成功不足以上线，补一条 verify_command 或再跑成功一次",
  };

  const existing = loader ? loader.get_skill((pyTruth(dictGet(cand, "name")) ? dictGet(cand, "name") : "") as string) : null;
  let collision: JsonDict;
  if (existing === null || existing === undefined) {
    collision = { ok: true, detail: "新技能，无同名在线" };
  } else {
    const target = pyStrOr(dictGet(cand, "superseded_skill"), "");
    if (target === existing.name) {
      collision = { ok: true, detail: `声明取代在线技能 ${existing.name}（旧版将快照）` };
    } else {
      collision = { ok: false, detail: "同名技能已在线且候选未正确声明 SUPERSEDES 目标" };
    }
  }

  report["collision"] = collision;
  return report;
}

/** 跑全部门禁；全绿置 staged，任一失败留在 candidate 并附完整报告。 */
export function promote(
  storage: SkillLifecycleStorage,
  cand_id: string,
  loader: SkillLifecycleLoader | null = null,
): Result {
  const cand = storage.get_skill_candidate(cand_id);
  if (!pyTruth(cand)) {
    return Result.failure(`无此候选: ${cand_id}`);
  }
  const candDict = cand as JsonDict;
  const status = dictSub(candDict as Record<string, unknown>, "status") as string;
  if (!["candidate", "degraded", "rejected"].includes(status)) {
    return Result.failure(
      `状态 ${pyStr(status)} 不可 promote（仅 candidate/degraded/rejected 可以重跑门禁）`,
    );
  }
  const report = run_gates(storage, candDict, loader);
  const failed: string[] = [];
  for (const [k, v] of Object.entries(report)) {
    if (!pyTruth(dictGet(v, "ok"))) failed.push(k);
  }
  storage.set_skill_candidate_status(cand_id, failed.length === 0 ? "staged" : "candidate", {
    gate_report: report,
  });
  if (failed.length) {
    return Result.failure("门禁未通过: " + failed.join(", "));
  }
  return Result.success(storage.get_skill_candidate(cand_id));
}

// ── 审批：staged → active（唯一入口是人）────────────────────────────────────

/**
 * 把 content 原子地写到 path：同目录临时文件 → fsync → rename。
 * 返回空串表示成功，否则返回错误原因。（原文档字符串所述语义不变。）
 */
function _atomic_write(path_str: string, content: string): string {
  const swap = new AtomicRuleSwapper().write_atomic(path_str, content, {
    create_snapshot: false,
  });
  if (!swap.success) {
    return pyStrOr(swap.error, "atomic write failed");
  }
  return "";
}

function _own_trust(): string {
  return TrustLevel.OWN;
}

/**
 * staged → active：渲染落盘、载入运行时、记录版本与快照。
 * 这是全系统唯一能把一个候选变成真技能的函数，而它只能被人调用。
 */
export function approve(
  storage: SkillLifecycleStorage,
  loader: SkillLifecycleLoader,
  cand_id: string,
  opts: { skills_root?: string | null } = {},
): Result {
  const cand = storage.get_skill_candidate(cand_id);
  if (!pyTruth(cand)) {
    return Result.failure(`无此候选: ${cand_id}`);
  }
  const candDict = cand as JsonDict;
  const status = dictSub(candDict as Record<string, unknown>, "status");
  if (status !== "staged") {
    return Result.failure(`状态 ${pyStr(status)} 不是 staged——先过门禁`);
  }

  const root = pyTruth(opts.skills_root) ? (opts.skills_root as string) : default_skills_root();
  const skill_dir = path.join(root, dictSub(candDict as Record<string, unknown>, "name") as string);
  const md_path = path.join(skill_dir, "SKILL.md");

  let snapshot_path = "";
  const replaced = fs.existsSync(md_path) && fs.statSync(md_path).isFile();
  if (replaced) {
    snapshot_path = md_path + `.bak-${Math.floor(timeNow())}`;
    try {
      fs.copyFileSync(md_path, snapshot_path);
    } catch (e) {
      return Result.failure(`无法快照旧版技能，中止替换: ${pyStrExc(e)}`);
    }
  }

  const content = render_skill_md(candDict);
  try {
    fs.mkdirSync(skill_dir, { recursive: true });
  } catch (e) {
    return Result.failure(`创建技能目录失败: ${pyStrExc(e)}`);
  }
  const write_err = _atomic_write(md_path, content);
  if (write_err) {
    return Result.failure(`写入 SKILL.md 失败: ${write_err}`);
  }

  const imp = loader.import_skill(skill_dir, _own_trust());
  if (!imp.ok) {
    // 导入失败就不留半成品：没有旧文件的新技能当场撤稿
    if (!replaced) {
      try {
        fs.rmSync(skill_dir, { recursive: true, force: true });
      } catch {
        // fail-open: 可选增强，失败不影响主流程
      }
    }
    return Result.failure(`SKILL.md 已写入但导入运行时失败: ${pyStr(dictGet(imp, "error", ""))}`);
  }

  // 版本 = 内容哈希，从运行时注册表取权威值（import_skill 的返回字典里没有它）。
  const entry = loader.get_skill(dictSub(candDict as Record<string, unknown>, "name") as string);
  const version = pyStrOr(entry ? ((entry as unknown as JsonDict)["version"] ?? null) : null, "");

  // 确定性验证门：候选声明了 verify_command 就真跑一遍（30s 上限、受沙箱约束、
  // 失败即拒绝激活并复位文件）。缺省不是"通过"——没有 verify_command 时也要
  // 留一条"没有机器验证"的记录。
  const verify_cmd = pyStrOr(dictGet(candDict, "verify_command"), "").trim();
  let verify_evidence: JsonDict = {
    ran: false,
    machineVerified: false,
    detail: "候选未声明 verify_command：本次上线只有人工确认，没有机器验证",
  };
  if (verify_cmd) {
    const res = run_confined_capture(verify_cmd, { cwd: root, timeout: 30 });
    // RULEBOOK §2: the source REBINDS verify_evidence here (fresh dict, no
    // "detail" key) — mutating in place would leak the default "未声明" detail
    // into the abort report's merge. Rebind to match exactly.
    verify_evidence = {
      ran: pyTruth(dictGet(res, "ran")),
      returncode: dictGet(res, "returncode"),
      stdout: pyStrOr(dictGet(res, "output"), "").slice(-400),
      confinement: dictGet(res, "confinement"),
      sandboxMode: dictGet(res, "mode"),
      // 只有"真跑了且退出码为 0"才算机器验证过。跑不起来、超时、非 0
      // 都不是"验证通过"——不可用不得当通过，这是这道门的全部意义。
      machineVerified: pyTruth(dictGet(res, "ran")) && dictGet(res, "returncode") === 0,
    };

    if (pyTruth(dictGet(res, "timeout"))) {
      verify_evidence["timeout"] = true;
    }
    if (pyTruth(dictGet(res, "error"))) {
      verify_evidence["error"] = dictGet(res, "error");
    }
    if (!pyTruth(dictGet(res, "ran"))) {
      const errVal = dictGet(res, "error");
      const msg = `验证命令无法执行: ${pyTruth(errVal) ? pyStr(errVal) : "unknown"}`;
      _abort_activation(storage, cand_id, msg, verify_evidence);
      return Result.failure(msg);
    }
    if (dictGet(res, "returncode") !== 0) {
      // 验证失败就不上线：有旧版恢复旧版，全新稿撤稿
      if (replaced && snapshot_path) {
        try {
          const previous = fs.readFileSync(snapshot_path, { encoding: "utf-8" });
          if (!_atomic_write(md_path, previous)) {
            loader.import_skill(skill_dir, _own_trust());
          }
        } catch {
          // fail-open: 可选增强，失败不影响主流程
        }
      } else if (!replaced) {
        fs.rmSync(skill_dir, { recursive: true, force: true });
      }
      _abort_activation(storage, cand_id, "确定性验证未通过", verify_evidence);
      // verify_evidence.get('returncode', 'timeout'): the key is always set
      // by now, so a present-null renders "None" via the f-string str().
      const rc = pyStr(
        "returncode" in (verify_evidence as object)
          ? (verify_evidence as Record<string, unknown>)["returncode"]
          : "timeout",
      );
      return Result.failure(
        `确定性验证未通过（exit=${rc}），` + "候选保持 staged，文件已复位",
      );
    }
  }

  storage.set_skill_candidate_status(cand_id, "active", {
    version: version,
    snapshot_path: snapshot_path,
    // 无条件写入：没有 verify_command 时也要留一条"没有机器验证"的记录。
    gate_report: { verification_run: verify_evidence },
  });

  const detail =
    `active v${version.slice(0, 8)}` +
    (snapshot_path ? `，旧版快照 ${path.basename(snapshot_path)}` : "");
  return Result.success(storage.get_skill_candidate(cand_id), null, { detail: detail });
}

/** 激活被确定性验证拦下：状态退回 staged，证据写进门禁报告供 UI 展示。 */
function _abort_activation(
  storage: SkillLifecycleStorage,
  cand_id: string,
  reason: string,
  evidence: JsonDict | null = null,
): void {
  const report: JsonDict = {
    verification_run: { ok: false, detail: reason, ...(evidence || {}) },
  };
  try {
    storage.set_skill_candidate_status(cand_id, "staged", { gate_report: report });
  } catch (e) {
    console.log(`[skills] abort-activation bookkeeping failed: ${pyStrExc(e)}`);
  }
}

export function reject(storage: SkillLifecycleStorage, cand_id: string, reason = ""): Result {
  const cand = storage.get_skill_candidate(cand_id);
  if (!pyTruth(cand)) {
    return Result.failure(`无此候选: ${cand_id}`);
  }
  if (dictSub(cand as Record<string, unknown>, "status") === "active") {
    return Result.failure("active 技能请走 rollback，不走 reject");
  }
  storage.set_skill_candidate_status(cand_id, "rejected", {
    gate_report: { reject_reason: reason },
  });
  return Result.success(storage.get_skill_candidate(cand_id));
}

// ── 回滚：active → archived，旧版复位 ──────────────────────────────────────

/**
 * active → archived：旧版复位（有快照）或撤稿下线（全新技能）。
 * 回滚是显式 API、由人调用——一次失败只记经验并降级，文件层的回退永远
 * 不自动发生。
 */
export function rollback(
  storage: SkillLifecycleStorage,
  loader: SkillLifecycleLoader,
  cand_id: string,
  opts: { skills_root?: string | null } = {},
): Result {
  const cand = storage.get_skill_candidate(cand_id);
  if (!pyTruth(cand)) {
    return Result.failure(`无此候选: ${cand_id}`);
  }
  const candDict = cand as JsonDict;
  const status = dictSub(candDict as Record<string, unknown>, "status");
  if (status !== "active") {
    return Result.failure(`状态 ${pyStr(status)} 无可回滚`);
  }

  const root = pyTruth(opts.skills_root) ? (opts.skills_root as string) : default_skills_root();
  const skill_dir = path.join(root, dictSub(candDict as Record<string, unknown>, "name") as string);
  const md_path = path.join(skill_dir, "SKILL.md");
  const snapshot = pyStrOr(dictGet(candDict, "snapshot_path"), "");

  try {
    if (snapshot && fs.existsSync(snapshot) && fs.statSync(snapshot).isFile()) {
      const previous = fs.readFileSync(snapshot, { encoding: "utf-8" });
      _atomic_write(md_path, previous);
      const imp = loader.import_skill(skill_dir, _own_trust());
      if (!imp.ok) {
        return Result.failure(
          `旧版已复位但运行时重载失败: ${pyStr(dictGet(imp, "error", ""))}`,
        );
      }
    } else {
      // 全新技能没有旧版可回：撤稿删目录 + 运行时下线。
      if (fs.existsSync(skill_dir) && fs.statSync(skill_dir).isDirectory()) {
        fs.rmSync(skill_dir, { recursive: true, force: true });
      }
      loader.disable_skill(dictSub(candDict as Record<string, unknown>, "name") as string);
    }
  } catch (e) {
    return Result.failure(`回滚 IO 失败: ${pyStrExc(e)}`);
  }

  storage.set_skill_candidate_status(cand_id, "archived", {
    gate_report: {
      rollback: snapshot
        ? `restored from ${path.basename(snapshot)}`
        : "brand-new skill withdrawn",
    },
  });
  return Result.success(storage.get_skill_candidate(cand_id));
}

// ── 金丝雀灰度与健康度巡检 (Canary Staging & Health Guard) ──────────────────

/** 将候选置为金丝雀灰度运行态 (canary)，进行 A/B 真实流量测试。 */
export function canary_stage(
  storage: SkillLifecycleStorage,
  loader: SkillLifecycleLoader,
  cand_id: string,
  opts: { shadow_ratio?: number } = {},
): Result {
  const shadow_ratio = opts.shadow_ratio ?? 0.2;
  const cand = storage.get_skill_candidate(cand_id);
  if (!pyTruth(cand)) {
    return Result.failure(`无此候选: ${cand_id}`);
  }
  const status = dictSub(cand as Record<string, unknown>, "status");
  if (!["staged", "candidate"].includes(status as string)) {
    return Result.failure(`状态 ${pyStr(status)} 不可进入 canary`);
  }

  storage.set_skill_candidate_status(cand_id, "canary", {
    gate_report: { canary_config: { shadow_ratio: shadow_ratio, staged_at: timeNow() } },
  });
  return Result.success(storage.get_skill_candidate(cand_id));
}

/** 对处于 canary 灰度的技能进行健康巡检，连续失败超阈值时触发告警并建议回滚。 */
export function evaluate_canary_health(
  storage: SkillLifecycleStorage,
  skill_name: string,
  max_consecutive_failures = 3,
): JsonDict {
  try {
    const rows = storage.list_skill_experiences({ skill_id: skill_name, limit: 10 }) || [];
    let consecutiveFails = 0;
    for (const r of rows) {
      if (dictGet(r, "outcome") !== "success") {
        consecutiveFails += 1;
      } else {
        break;
      }
    }
    const healthy = consecutiveFails < max_consecutive_failures;
    return {
      skillName: skill_name,
      healthy: healthy,
      consecutiveFailures: consecutiveFails,
      maxAllowed: max_consecutive_failures,
      needsRollback: !healthy,
    };
  } catch (e) {
    return { skillName: skill_name, healthy: true, error: pyStrExc(e) };
  }
}

// ── Voyager 启发：技能组合引擎 (Skill Composer) ──────────────────────────────

/** 频繁共现的技能组合模式序列。 */
export class CompositePattern {
  pattern_id: string;
  skills: string[];
  frequency: number;
  goals_covered: string[];
  sample_experience_id: string;

  constructor(
    pattern_id: string,
    skills: string[],
    frequency: number,
    goals_covered: string[],
    sample_experience_id = ""
  ) {
    this.pattern_id = pattern_id;
    this.skills = skills;
    this.frequency = frequency;
    this.goals_covered = goals_covered;
    this.sample_experience_id = sample_experience_id;
  }

  toDict(): JsonDict {
    return {
      patternId: this.pattern_id,
      skills: this.skills,
      frequency: this.frequency,
      goalsCovered: this.goals_covered,
      sampleExperienceId: this.sample_experience_id,
    };
  }
}

/** 自动挖掘频繁技能调用链并生成复合技能候选 (Voyager Skill Composition). */
export class SkillComposer {
  /** 从成功历史经验中挖掘频繁共现的技能调用序列。 */
  static find_composition_patterns(
    storage: SkillLifecycleStorage | null,
    min_support = 2,
    max_chain_len = 3
  ): CompositePattern[] {
    if (!pyTruth(storage)) return [];

    let rows: JsonDict[];
    try {
      // 获取最近的成功技能经验
      rows = (storage as SkillLifecycleStorage).list_skill_experiences({ limit: 200 }) || [];
    } catch {
      return [];
    }

    // 按 goal_id 分组提取技能顺序
    const goal_chains = new Map<string, JsonDict[]>();
    for (const r of rows) {
      if (dictGet(r, "outcome") !== "success") continue;
      const gid = pyStrOr(dictGet(r, "goal_id"), "");
      const sid = pyStrOr(dictGet(r, "skill_id"), "");
      if (!gid || !sid || sid === (storage as SkillLifecycleStorage).TASK_LEVEL_SKILL_ID)
        continue;
      const bucket = goal_chains.get(gid);
      if (bucket) bucket.push(r);
      else goal_chains.set(gid, [r]);
    }

    // 统计连续 n-gram 子序列。Python 元组键在 JS 里用 "->" 连接串表示，
    // 与下面 pid 的 sha256 输入保持同一序列化。
    const ngram_counts = new Map<string, { goal_id: string; exp_id: string }[]>();
    for (const [gid, exps] of goal_chains) {
      // 按创建时间排序（V8 的 sort 自 ES 起稳定，与 Python sorted 一致）
      const exps_sorted = [...exps].sort((a, b) => {
        const ka = pyTruth(dictGet(a, "created_at")) ? dictGet(a, "created_at") : 0;
        const kb = pyTruth(dictGet(b, "created_at")) ? dictGet(b, "created_at") : 0;
        return (ka as number) - (kb as number);
      });
      const skills = exps_sorted.map((e) => dictSub(e, "skill_id") as string);
      const n = skills.length;

      const seen_ngrams_in_goal = new Set<string>();
      for (let length = 2; length <= Math.min(n, max_chain_len); length++) {
        for (let i = 0; i <= n - length; i++) {
          const sub = skills.slice(i, i + length);
          // 避免同技能自循环如 ('a', 'a')
          if (new Set(sub).size > 1) {
            const key = sub.join("->");
            if (!seen_ngrams_in_goal.has(key)) {
              seen_ngrams_in_goal.add(key);
              const matches = ngram_counts.get(key);
              const entry = {
                goal_id: gid,
                exp_id: pyStr(
                  dictGet(exps_sorted[i], "experience_id", "") || ""
                ),
              };
              if (matches) matches.push(entry);
              else ngram_counts.set(key, [entry]);
            }
          }
        }
      }
    }

    const patterns: CompositePattern[] = [];
    for (const [ngram, matches] of ngram_counts) {
      if (matches.length >= min_support) {
        const pid =
          "pat_" +
          crypto.createHash("sha256").update(ngram, "utf8").digest("hex").slice(0, 8);
        // list(dict.fromkeys(...)) —— 保序去重
        const goals = [...new Set(matches.map((m) => m.goal_id))];
        const sample_eid = matches.length ? matches[0]?.exp_id ?? "" : "";
        patterns.push(
          new CompositePattern(
            pid,
            ngram.split("->"),
            matches.length,
            goals,
            sample_eid
          )
        );
      }
    }

    patterns.sort((a, b) => b.frequency - a.frequency);
    return patterns;
  }

  /** 将频繁调用模式转化为结构化复合技能候选并提交给门禁。 */
  static generate_composite_candidate(
    storage: SkillLifecycleStorage,
    pattern: CompositePattern,
    name = ""
  ): Result {
    if (!pyTruth(pattern) || !pyTruth(pattern.skills))
      return Result.failure("模式为空，无法生成复合技能");

    const skill_chain = pattern.skills.join(" -> ");
    const cand_name =
      name.trim() || `composite-${pattern.skills.slice(0, 3).join("-to-")}`;
    const desc =
      `复合高阶技能：自动化串联执行 [${skill_chain}] 流水线。` +
      `（在历史 ${pattern.frequency} 个任务中成功复现）`;
    const when_to_use = `当任务需要依次完成 ${pattern.skills.join(" 并接着 ")} 时优先调用此复合技能。`;
    const preconditions = `工作区就绪，且满足进入 ${pattern.skills[0]} 的全部前置条件。`;

    const steps: string[] = [
      `第一阶段：调用并执行基础技能 [${pattern.skills[0]}] 处理初始上下文与输入`,
    ];
    pattern.skills.slice(1).forEach((s, j) => {
      steps.push(
        `第 ${j + 2} 阶段：将上一阶段产物作为输入，无缝调用 [${s}] 进行深度处理`
      );
    });
    steps.push("验证阶段：运行端到端复合验证，确保链路最终产物完整落地");

    const fields: JsonDict = {
      name: cand_name,
      description: desc,
      when_to_use: when_to_use,
      scope: "workspace",
      preconditions: preconditions,
      inputs: "初始任务目标与工作区路径",
      outputs: `由 ${pattern.skills[pattern.skills.length - 1]} 产出的最终结构化产物`,
      steps: steps,
      required_tools: ["run_command", "view_file"],
      verification: "全部子阶段顺序执行无报错，且生成物通过目标合同门禁",
      risk_level: "medium",
      known_failures: `跨技能管道传参不兼容；复合模式来源于 ${pattern.goals_covered.length} 个成功用例`,
      experience_ref: pattern.sample_experience_id,
    };

    return create_candidate(storage, fields);
  }
}

// PORT STATUS: confidence=high todos=[0]
