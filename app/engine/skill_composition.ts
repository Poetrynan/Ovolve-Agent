/**
 * skill_composition.ts — Voyager 级可组合技能挖掘与复合技能合成引擎。
 *
 * Ported from `app/backend/skill_composition.py` (169 lines, wave-10, unit 196).
 *
 * 基于 ICLR 2024 顶会论文:
 * 《Voyager: An Open-Ended Embodied Agent with Large Language Models》
 *
 * 核心机制：
 * 1. 时序模式挖掘 (Sequential Pattern Mining):
 *    - 扫描历史成功经验账本 (Skill Experiences / Tool Traces)，挖掘高频共现的技能/工具执行链；
 * 2. 复合技能基因重组 (Composite Skill Synthesis):
 *    - 自动融合多步原子技能的前置条件 (Preconditions)、步骤链 (Steps)、输入输出契约与验证标准
 *      (Verification)，合成可复用的复合宏技能 (Composite Macro-Skill)；
 * 3. 生命周期安全接轨 (Skill Lifecycle Bridge):
 *    - 自动生成合规的 `SkillCandidate`，打上 `["composite", ...]` 标签，
 *      并对接 `skill_lifecycle.py` 的结构门、注入/秘密扫描门禁，进入待审池。
 *
 * RULEBOOK CITATIONS
 *   §2  `@dataclass` → a class with explicit fields in declaration order and a
 *       `to_dict()` that reproduces `dataclasses.asdict` (same key order, same
 *       nested list copied). `field(default_factory=list)` → a fresh array per
 *       instance (NOT a shared default — the classic mutable-default trap).
 *   §2  `dict` used as an ordered structure → `Map` for the chain/ngram
 *       accumulators: the source relies on insertion order for the final
 *       `sorted(..., reverse=True)` tie order, and CPython's `sorted` with
 *       `reverse=True` is STABLE (equal frequencies keep insertion order).
 *       JS `Array.prototype.sort` is stable too, so `b.frequency - a.frequency`
 *       reproduces it exactly.
 *   §2  `hashlib.md5(x).hexdigest()[:12]` → node:crypto `createHash("md5")`.
 *   §2  `except Exception: pass` in `mine_patterns` is preserved verbatim and
 *       marked BUG(port) — a broken ledger yields `[]`, never a raise.
 *   §2  `len()` / slicing are code-point based → `pyLen` / `pySlice` where the
 *       value can be user text.
 *   §M  **镜像单层（mirror single-source）**：本文件不再自带 `py_str/py_truth/py_type_name/
 *       str(exc)` 的私有副本，一律 `import` `./server/http_server_keys.js`
 *       （`py_truth` 107 / `py_or` 129 / `py_float_repr` 134 / `py_type_name` 146 /
 *       `py_str` 171 / `py_repr` 186 / `exc_str` 638）。旧的私有副本在这里错过了四张脸
 *       （差分证据 `tmp/sklco_lead_helper_diff.txt`，CPython 侧 `tmp/sklco_ev_probe.out`）：
 *       `str(float('nan'))` 应为 `"nan"` 而非 `"NaN"`；`str(-0.0)` 应为 `"-0.0"`；
 *       `str({'b': 'x'})` 的值走 **repr**（`{'b': 'x'}`），私有副本打成 `{'b': x}`；
 *       `bool(float('nan'))` 与 `bool(<类实例>)` 在 CPython 都是 **真**，私有 `pyTruth`
 *       都判成假（NaN 支被 `!Number.isNaN` 杀掉；无字段实例支被 `Object.keys().length` 杀掉，
 *       318 行因此会多跑一次 `record_skill_experience`）。
 *       还有一条**不由本次修复解决**的：`str(1.0)` 在 CPython 是 `"1.0"`，JS 的 number
 *       无法区分 int/float，§M 也一样输出 `"1"`（差分表 f1 两列同值）。
 *   §M  `x or y` 只能走 `py_or`：源 70-72 的 `str(r["session_id"] or r["goal_id"] or "default")`
 *       在 JS `||` 下会走反（`{}`/`[]` 在 JS 为真、`NaN` 在 JS 为假，CPython 恰好相反）。
 *   §4  naming: app/backend/skill_composition.py -> app/engine/skill_composition.ts.
 *       Field names, method names and the `composite_*` / `voyager_mined` /
 *       `len_N` literals are preserved byte for byte (they are ledger/UI contracts).
 *
 * DIVERGENCE(port): `from storage import get_storage` (constructor default) and
 * `from skill_lifecycle import create_candidate, promote` (function-local, inside
 * the try) both resolve through `SKILL_COMPOSITION_SEAMS` so the probe can drive
 * every branch; the defaults are the real static imports.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import { createHash } from "node:crypto";
import { Result } from "./result.js";
import * as _storage_mod from "./storage.js";
import * as _skill_lifecycle_mod from "./skill_lifecycle.js";
import { exc_str, py_or, py_str, py_truth, py_type_name } from "./server/http_server_keys.js";

// ── 本文件私有的两件工具：§M 没有这两条语义，所以留在原地 ──────────────────────

/** python `len(x)` (code-point based for strings). */
function pyLen(v: unknown): number {
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v instanceof Uint8Array) return v.length;
  if (v !== null && typeof v === "object") return Object.keys(v as object).length;
  throw new TypeError(`object of type '${py_type_name(v)}' has no len()`);
}

/** python row access: sqlite3.Row supports BOTH `r["k"]` and index access. */
function rowGet(row: unknown, key: string): unknown {
  if (row === null || row === undefined) {
    throw new TypeError(`'${py_type_name(row)}' object is not subscriptable`);
  }
  if (typeof row === "object") {
    return (row as Record<string, unknown>)[key];
  }
  throw new TypeError(`'${py_type_name(row)}' object is not subscriptable`);
}

// ── seams（python 的函数级导入在这里可替换；默认值 = 真端口） ────────────────────

type AnyMod = Record<string, any>;

export const SKILL_COMPOSITION_SEAMS = {
  /** python `from storage import get_storage`（构造器默认值）。 */
  storageModule: (): AnyMod => _storage_mod as unknown as AnyMod,
  /** python `from skill_lifecycle import create_candidate, promote`。 */
  skillLifecycleModule: (): AnyMod => _skill_lifecycle_mod as unknown as AnyMod,
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof SKILL_COMPOSITION_SEAMS>): void {
  Object.assign(SKILL_COMPOSITION_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  SKILL_COMPOSITION_SEAMS.storageModule = (): AnyMod => _storage_mod as unknown as AnyMod;
  SKILL_COMPOSITION_SEAMS.skillLifecycleModule = (): AnyMod => _skill_lifecycle_mod as unknown as AnyMod;
}

// ── CompositePattern ─────────────────────────────────────────────────────────

/** 挖掘出的频繁技能/工具时序组合模式。 */
export class CompositePattern {
  pattern_id: string;
  name: string;
  /** 技能或工具链条，如 ["find_by_name", "view_file", "replace_file_content"] */
  sequence: string[];
  frequency: number;
  success_rate: number;
  description: string;
  sample_experience_refs: string[];

  constructor(fields: {
    pattern_id: string;
    name: string;
    sequence: string[];
    frequency: number;
    success_rate: number;
    description: string;
    sample_experience_refs?: string[];
  }) {
    this.pattern_id = fields.pattern_id;
    this.name = fields.name;
    this.sequence = fields.sequence;
    this.frequency = fields.frequency;
    this.success_rate = fields.success_rate;
    this.description = fields.description;
    // python `field(default_factory=list)`：每个实例一份新数组，不是共享默认值。
    this.sample_experience_refs = fields.sample_experience_refs === undefined
      ? []
      : fields.sample_experience_refs;
  }

  /** python `dataclasses.asdict(self)` — same key order as the field declarations. */
  to_dict(): Record<string, unknown> {
    return {
      pattern_id: this.pattern_id,
      name: this.name,
      sequence: [...this.sequence],
      frequency: this.frequency,
      success_rate: this.success_rate,
      description: this.description,
      sample_experience_refs: [...this.sample_experience_refs],
    };
  }
}

// ── SkillComposer ────────────────────────────────────────────────────────────

/** 技能组合器：负责挖掘频繁组合序列并合成复合宏技能。 */
export class SkillComposer {
  storage: any;

  constructor(storage: any = null) {
    if (storage === null || storage === undefined) {
      const get_storage = SKILL_COMPOSITION_SEAMS.storageModule()["get_storage"] as () => any;
      storage = get_storage();
    }
    this.storage = storage;
  }

  /** 从历史成功执行经验中挖掘频繁时序模式。 */
  mine_patterns(min_support = 2, min_success_rate = 0.8): CompositePattern[] {
    void min_success_rate;
    const patterns: CompositePattern[] = [];
    try {
      const c = this.storage._db("sessions");
      const rows: any[] = c.execute(
        "SELECT experience_id, skill_id, session_id, outcome, goal_id "
        + "FROM skill_experiences WHERE outcome='success' ORDER BY created_at DESC LIMIT 500",
      ).fetchall();

      // 按 session/goal 分组提取工具链
      const chains = new Map<string, [string, string][]>();
      for (const r of rows) {
        const eid = py_str(py_or(rowGet(r, "experience_id"), ""));
        const sk = py_str(py_or(rowGet(r, "skill_id"), ""));
        const group_key = py_str(py_or(rowGet(r, "session_id"), py_or(rowGet(r, "goal_id"), "default")));
        if (!chains.has(group_key)) {
          chains.set(group_key, []);
        }
        (chains.get(group_key) as [string, string][]).push([sk, eid]);
      }

      // 统计 N-gram 时序共现 (N = 2, 3)
      const seq_counts = new Map<string, { seq: string[]; refs: string[] }>();
      for (const [_group_key, items] of chains) {
        const tools = items.filter((it) => it[0]).map((it) => it[0]);
        const exp_ids = items.filter((it) => it[1]).map((it) => it[1]);
        if (tools.length < 2) {
          continue;
        }
        for (const n of [2, 3]) {
          for (let i = 0; i < tools.length - n + 1; i++) {
            const sub = tools.slice(i, i + n);
            const key = sub.join("\u0000");
            if (!seq_counts.has(key)) {
              seq_counts.set(key, { seq: sub, refs: [] });
            }
            (seq_counts.get(key) as { seq: string[]; refs: string[] }).refs.push(exp_ids[i] as string);
          }
        }
      }

      for (const [_key, entry] of seq_counts) {
        const seq = entry.seq;
        const exp_refs = entry.refs;
        const freq = pyLen(exp_refs);
        if (freq >= min_support) {
          const pid = createHash("md5").update(seq.join("_"), "utf-8").digest("hex").slice(0, 12);
          const name = `composite_${seq.join("_")}`;
          const desc = `自动合成的复合技能链条: ${seq.join(" -> ")}`;
          patterns.push(new CompositePattern({
            pattern_id: pid,
            name,
            sequence: [...seq],
            frequency: freq,
            success_rate: 1.0,
            description: desc,
            sample_experience_refs: exp_refs.slice(0, 3),
          }));
        }
      }
    } catch {
      // BUG(port): 源为 `except Exception: pass`，宽吞逐字保留——账本读不到时
      // 返回空清单而不是抛，组合挖掘是可选增强。
    }
    return patterns.sort((a, b) => b.frequency - a.frequency);
  }

  /** 将挖掘出的频繁模式转化为合规的 SkillCandidate 数据结构。 */
  generate_composite_candidate(pattern: CompositePattern): Record<string, any> | null {
    if (!py_truth(pattern.sequence)) {
      return null;
    }

    const steps = pattern.sequence.map((tool_or_skill, idx) => (
      idx === 0
        ? `调用 \`${tool_or_skill}\` 准备/定位上下文或执行前置验证`
        : `基于上一步产出，调用 \`${tool_or_skill}\` 执行核心变换或校验`
    ));

    const when_to_use = `当需要连续完成 ${pattern.sequence.join(" -> ")} 等多步骤联动任务时使用。`;
    const verification = `确认所有步骤执行完毕，且最后一步 \`${pattern.sequence[pattern.sequence.length - 1]}\` 执行结果为 success。`;

    const ref_exp = py_truth(pattern.sample_experience_refs)
      ? pattern.sample_experience_refs[0]
      : "";

    return {
      name: pattern.name,
      description: pattern.description,
      when_to_use,
      scope: "project",
      preconditions: "目标项目工作区已加载，相关环境依赖完备。",
      inputs: "任务目标描述及目标文件/模块路径。",
      outputs: "完整执行链产物及验证结果。",
      steps,
      required_tools: pattern.sequence,
      verification,
      experience_ref: ref_exp,
      tags: ["composite", "voyager_mined", `len_${pyLen(pattern.sequence)}`],
    };
  }

  /** 一键合成复合技能并送入 SkillLifecycle 门禁。 */
  synthesize_and_stage(pattern: CompositePattern): [boolean, string] {
    const c_data = this.generate_composite_candidate(pattern);
    // `c_data === null` 只为 TS 收窄类型：python 侧 `None` 已经被 `py_truth` 判成假，
    // 这一支在源里不额外跑路径（`if not c_data` 覆盖 None 和空 dict 两张脸）。
    if (!py_truth(c_data) || c_data === null) {
      return [false, "无法生成候选技能数据"];
    }
    try {
      const lifecycle: AnyMod = SKILL_COMPOSITION_SEAMS.skillLifecycleModule();
      const create_candidate = lifecycle["create_candidate"] as (s: any, d: any) => any;
      const promote = lifecycle["promote"] as (s: any, id: string) => any;

      // 若未绑定真实经验，则创建一条合成的有效经验
      if (!py_truth(c_data["experience_ref"])) {
        const fake_exp_id = this.storage.record_skill_experience(pattern.name, {
          outcome: "success",
          session_id: "composite_seed",
        });
        c_data["experience_ref"] = fake_exp_id;
      }

      const res: any = create_candidate(this.storage, c_data);
      if (!py_truth(res.ok)) {
        return [false, `创建候选失败: ${res.error}`];
      }

      const cand_obj: any = res.value;
      const cid = isPlainDict(cand_obj) ? cand_obj["id"] : py_str(cand_obj);
      const promo_res: any = promote(this.storage, cid);
      return [
        true,
        // f-string `{promo_res.ok}` renders a python bool as True/False; a TS
        // template literal would print true/false.
        `复合技能候选已生成并完成门禁扫描 (Candidate ID: ${cid}, 门禁结果: ${py_str(promo_res.ok)})`,
      ];
    } catch (exc) {
      return [false, `合成异常: ${exc_str(exc)}`];
    }
  }
}

/** python `isinstance(v, dict)` — a class instance is NOT a dict. */
function isPlainDict(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// `Result` 是源的账本类型（`create_candidate` 返回它）；这里显式引用以保持导入面。
void Result;
