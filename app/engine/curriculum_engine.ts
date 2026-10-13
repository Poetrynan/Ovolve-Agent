/**
 * curriculum_engine.ts — Voyager 级自主课程生成与能力缺口自进化引擎。
 *
 * Ported from `app/backend/curriculum_engine.py` (168 lines).
 *
 * 基于 ICLR 2024 顶会论文:
 * 《Voyager: An Open-Ended Embodied Agent with Large Language Models》
 *
 * 核心机制：
 * 1. 能力缺口探测 (Skill Gap Discovery)：扫描历史会话轨迹，自动识别
 *    "反复自主摸索、但尚无专属技能沉淀"的能力缺口；
 * 2. 自主课程生成 (Automatic Curriculum Generation)：依据当前能力边界
 *    由易到难生成自驱动探索目标与验收测试契约。
 *
 * RULEBOOK CITATIONS
 *   §1  node:crypto (md5[:10] gap id)。
 *   §2  collections.defaultdict(list) → Map<string, string[]>。
 *   §2  `from storage import get_storage` → 静态 import（已移植）；skill_loader
 *       （SPLIT）→ computed 动态 import + except 吞并；storage._db("sessions")
 *       是 Python 私有方法 —— TS StorageBase 的等价访问经由 sqlite 连接，
 *       这里按已移植的 storage/storage.ts 形状走（若方法名不同则以现有
 *       StorageBase 公开面为准，保持"读 sessions 标题"的语义）。DIVERGENCE(port)：
 *       _db("sessions") 访问面与源一致；技能去重改异步预取已单独注明。
 *   §4  naming: curriculum_engine.ts
 *
 * PORT STATUS: confidence=medium todos=0
 */

import * as crypto from "node:crypto";

import { get_storage } from "./storage.js";

export interface SkillGap {
  /** 探测出的 Agent 能力缺口实体。 */
  gap_id: string;
  category: string;
  description: string;
  frequency: number;
  suggested_skill_name: string;
  suggested_tools: string[];
  sample_queries: string[];
}

export function skill_gap_to_dict(g: SkillGap): Record<string, unknown> {
  return { ...g };
}

export interface ExplorationTask {
  /** 自主探索任务实体。 */
  task_id: string;
  title: string;
  objective: string;
  target_gap_id: string;
  difficulty: string; // "easy" | "medium" | "hard"
  verification_criteria: string[];
  suggested_deliverables: string[];
  created_at: number;
}

export function exploration_task_to_dict(t: ExplorationTask): Record<string, unknown> {
  return { ...t };
}

/** storage 形状（结构性，含 Python _db 语义的 TS 对应面）。 */
interface StorageShape {
  _db?: (name: string) => {
    execute(sql: string, params?: unknown[]): { fetchall(): Record<string, unknown>[] };
  };
}

/** 自主课程引擎：负责能力缺口分析与自适应探索任务生成。 */
export class CurriculumEngine {
  storage: unknown;

  constructor(storage?: unknown) {
    if (storage === null || storage === undefined) {
      this.storage = get_storage();
    } else {
      this.storage = storage;
    }
  }

  /** 分析高频但缺乏专属技能支持的任务模式。 */
  identify_skill_gaps(min_recurrence = 2): SkillGap[] {
    const gaps: SkillGap[] = [];
    try {
      // 扫描最近的 sessions 记录（Python _db("sessions") 的 TS 语义等价面）
      const st = this.storage as StorageShape;
      if (!st || typeof st._db !== "function") {
        return gaps;
      }
      const c = st._db("sessions");
      const rows = c
        .execute(
          "SELECT id, title FROM sessions WHERE title IS NOT NULL AND title != '' ORDER BY updated_at DESC LIMIT 200"
        )
        .fetchall();

      // 聚类高频意图 (如: 重构, 测试, 数据分析, 转换, 部署等)
      const intent_keywords: Record<string, [string, string[]]> = {
        refactor: ["重构/代码优化", ["find_by_name", "view_file", "replace_file_content"]],
        test: ["自动化测试/用例编写", ["run_command", "view_file", "write_to_file"]],
        data_analysis: ["数据解析与图表", ["run_command", "view_file"]],
        deploy_release: ["发布打包与部署", ["run_command", "find_by_name"]],
        database_migration: ["数据库迁移与管理", ["run_command", "view_file"]],
      };

      const intent_counts = new Map<string, string[]>();
      for (const r of rows) {
        const title = String(r["title"] ?? "").toLowerCase();
        for (const [key, [desc, tools]] of Object.entries(intent_keywords)) {
          void tools;
          if (title.includes(key) || desc.split("/").some((w) => title.includes(w))) {
            const arr = intent_counts.get(key) ?? [];
            arr.push(String(r["title"]));
            intent_counts.set(key, arr);
          }
        }
      }

      // 读取现有技能列表避免重复（skill_loader 是 SPLIT → 动态 import 吞并）
      const existing_skills = new Set<string>();
      try {
        // 同步上下文里不能 await —— fire-and-forget 预取，本 pass 先用
        // 模块级缓存（首 pass 空，后续 pass 生效）。源在同步函数里做同步
        // import；TS 侧等价物只能异步预取，语义差异仅"首 pass 可能重复"。
        const cached = (globalThis as Record<string, unknown>)["__curriculum_skills__"];
        if (Array.isArray(cached)) {
          for (const s of cached as string[]) {
            existing_skills.add(String(s));
          }
        }
      } catch {
        // except Exception: pass
      }

      for (const [key, queries] of intent_counts) {
        if (queries.length >= min_recurrence) {
          const skill_name = `auto-${key.replace(/_/g, "-")}`;
          if (!existing_skills.has(skill_name)) {
            const gid = crypto.createHash("md5").update(key, "utf-8").digest("hex").slice(0, 10);
            const [desc, tools] = intent_keywords[key]!;
            gaps.push({
              gap_id: gid,
              category: key,
              description: `高频任务类型「${desc}」缺乏专属技能覆盖（历史出现 ${queries.length} 次）`,
              frequency: queries.length,
              suggested_skill_name: skill_name,
              suggested_tools: tools,
              sample_queries: queries.slice(0, 3),
            });
          }
        }
      }
    } catch {
      // except Exception: pass
    }
    return gaps.sort((a, b) => b.frequency - a.frequency);
  }

  /** 为特定能力缺口生成自主探索学习任务。 */
  generate_exploration_goal(gap: SkillGap): ExplorationTask {
    const tid = `exp_task_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const title = `自主能力习得: ${gap.suggested_skill_name}`;
    const obj =
      `探索并建立针对「${gap.description}」的标准操作流程(SOP)，` +
      `沉淀可复用的技能候选并完成自测验证。`;
    const criteria = [
      `产出符合规范的 SKILL.md 候选`,
      `验证所依赖的工具链 ${gap.suggested_tools.join(", ")} 可正常协同工作`,
      `通过机器完成门禁测试`,
    ];
    return {
      task_id: tid,
      title,
      objective: obj,
      target_gap_id: gap.gap_id,
      difficulty: "medium",
      verification_criteria: criteria,
      suggested_deliverables: [`.agents/skills/${gap.suggested_skill_name}/SKILL.md`],
      created_at: Date.now() / 1000,
    };
  }
}

/** 异步预取现有技能名（供下一轮 identify_skill_gaps 去重；
 * fire-and-forget，失败静默 —— 与源 except Exception: pass 等价）。 */
export async function prefetch_existing_skills(): Promise<void> {
  try {
    const spec = "./skill_loader" + ".js";
    const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
      SkillLoader: new () => { list_skill_names(): string[] };
    };
    const names = new mod.SkillLoader().list_skill_names();
    (globalThis as Record<string, unknown>)["__curriculum_skills__"] = names;
  } catch {
    // except Exception: pass
  }
}
