/**
 * reflection_engine.ts — 结构化自我反思（Reflexion）
 *
 * Ported from `app/backend/reflection_engine.py` (340 lines).
 *
 * 将执行失败转化为可落地的结构化反思：生成 → 落库 → 桥接自进化 → 召回注入。
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto for uuid4；json 用内联 helpers)。
 *   §2  `except Exception: pass` / fail-open 分支逐字保留（LLM 增强、
 *       落库、召回全部不抛）。
 *   §2  Python `from memory_tiers import MemoryTier` / `from evolution import
 *       EvolutionEngine, Proposal` / `from storage import get_storage`：
 *       storage 已移植走静态 import；evolution（SPLIT，未移植）走
 *       computed-specifier 动态 import，缺席时桥接静默返回 False —— 与源的
 *       ImportError → except → return False 行为一致。
 *   §2  Python Storage 的 `_active_workspace` 属性实际存储是 configs 库的
 *       kv 行（storage.py:1739 证实）；TS 直接读同一 kv，缺席时降级为
 *       process.cwd()（与 evolution_tools.ts 的 fallback 口径一致）。
 *   §2  `asyncio.iscoroutinefunction(self._llm)` → typeof 检查 promise thenable；
 *       两种 LLM 形状（同步/异步）都支持。
 *   §4  naming: reflection_engine.py → reflection_engine.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";

import { get_storage } from "./storage.js";
import { MemoryTier } from "./memory_tiers.js";

// ---------------------------------------------------------------------------
// json helpers (Python json.dumps/loads semantics used here)
// ---------------------------------------------------------------------------

function pyDumps(obj: unknown): string {
  return JSON.stringify(obj);
}

function pyLoads(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function uuid4(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Reflection dataclass
// ---------------------------------------------------------------------------

/** 结构化自我反思实体。 */
export interface Reflection {
  id: string;
  scenario: string;
  root_cause: string;
  alternative_strategy: string;
  prevention_rule: string;
  applicability_boundary: string;
  confidence: number;
  tags: string[];
  created_at: number;
  session_id: string;
  source_tool: string;
}

export function reflection_to_dict(r: Reflection): Record<string, unknown> {
  // Python asdict() = plain copy of the dataclass fields
  return { ...r };
}

export function reflection_from_dict(data: Record<string, unknown>): Reflection {
  return {
    id: String(data["id"] || uuid4()),
    scenario: String(data["scenario"] || ""),
    root_cause: String(data["root_cause"] || ""),
    alternative_strategy: String(data["alternative_strategy"] || ""),
    prevention_rule: String(data["prevention_rule"] || ""),
    applicability_boundary: String(data["applicability_boundary"] || "general"),
    confidence: Number(data["confidence"] || 0.85),
    tags: Array.isArray(data["tags"]) ? (data["tags"] as string[]).map(String) : [],
    created_at: Number(data["created_at"] || Date.now() / 1000),
    session_id: String(data["session_id"] || ""),
    source_tool: String(data["source_tool"] || ""),
  };
}

/** 格式化为适合 LLM 理解的紧凑提示。 */
export function reflection_format_for_prompt(r: Reflection): string {
  const tool_tag = r.source_tool ? `[${r.source_tool}] ` : "";
  return (
    `- ${tool_tag}针对场景「${r.scenario}」的反思:\n` +
    `  * 根因分析: ${r.root_cause}\n` +
    `  * 替代策略: ${r.alternative_strategy}\n` +
    `  * 前置防范规则: ${r.prevention_rule}`
  );
}

// ---------------------------------------------------------------------------
// ReflectionGenerator
// ---------------------------------------------------------------------------

/** LLM 函数形状：同步返回或 Promise 均可（源支持两种）。 */
export type LlmFn = (prompt: string) => string | Promise<string>;

export class ReflectionGenerator {
  _llm: LlmFn | null;

  constructor(llm_fn?: LlmFn | null) {
    this._llm = llm_fn ?? null;
  }

  /** 从工具调用失败生成反思。 */
  async generate_from_tool_failure(
    tool_name: string,
    arguments_: Record<string, unknown>,
    error_message: string,
    context = "",
    session_id = ""
  ): Promise<Reflection> {
    const args_str = JSON.stringify(arguments_).slice(0, 300);
    const err_str = String(error_message).slice(0, 400);

    // 优先使用启发式快速提取，保证即使无 LLM 也能产生高质量反思
    const [root_cause0, alt_strat0, prev_rule0] = this._heuristic_tool_reflection(
      tool_name,
      arguments_,
      err_str
    );
    let root_cause = root_cause0;
    let alt_strat = alt_strat0;
    let prev_rule = prev_rule0;

    // 若配置了 LLM 且属于复杂错误，可异步增强
    if (
      this._llm &&
      !err_str.toLowerCase().includes("not found") &&
      !err_str.toLowerCase().includes("syntax")
    ) {
      try {
        const prompt =
          "You are the Reflexion Engine of an AI agent. An action failed. " +
          "Analyze the failure and produce a structured self-reflection.\n\n" +
          `TOOL: ${tool_name}\n` +
          `ARGUMENTS: ${args_str}\n` +
          `ERROR: ${err_str}\n` +
          `CONTEXT: ${context.slice(0, 300)}\n\n` +
          "Respond with ONLY a JSON object:\n" +
          '{"root_cause": "<concise reason>", "alternative_strategy": "<what to do instead>", ' +
          '"prevention_rule": "<rule to remember>", "applicability_boundary": "<boundary>"}';
        const out = this._llm(prompt);
        const res = out instanceof Promise ? await out : out;
        if (typeof res === "string") {
          const m = /\{[\s\S]*\}/.exec(res);
          if (m) {
            const data = pyLoads(m[0]);
            if (data) {
              root_cause = String(data["root_cause"] || root_cause);
              alt_strat = String(data["alternative_strategy"] || alt_strat);
              prev_rule = String(data["prevention_rule"] || prev_rule);
            }
          }
        }
      } catch {
        // fail-open: 保留启发式提取结果
      }
    }

    return {
      id: uuid4(),
      scenario: `调用工具 ${tool_name} 执行失败`,
      root_cause,
      alternative_strategy: alt_strat,
      prevention_rule: prev_rule,
      applicability_boundary: "general",
      confidence: 0.85,
      tags: ["reflection", "tool_failure", tool_name],
      created_at: Date.now() / 1000,
      session_id,
      source_tool: tool_name,
    };
  }

  /** 从机器验收门禁 (Verification Gate) 失败生成反思。 */
  async generate_from_gate_failure(
    unmet_criteria: string[],
    failing_evidence = "",
    session_id = ""
  ): Promise<Reflection> {
    void failing_evidence; // source signature carries it but the body doesn't use it
    const unmet_summary = unmet_criteria.slice(0, 3).join("; ");
    return {
      id: uuid4(),
      scenario: "机器验收门禁 (Verification Gate) 未通过",
      root_cause: `以下验收条件未达成: ${unmet_summary}`,
      alternative_strategy:
        "先针对未通过的测试用例/缺失产物进行局部修复并本地验证，全绿后再标记完成",
      prevention_rule: "严禁在测试未通过时提前收工，必须先执行自测并修复报错",
      applicability_boundary: "general",
      confidence: 0.85,
      tags: ["reflection", "gate_failure", "anti_early_quit"],
      created_at: Date.now() / 1000,
      session_id,
      source_tool: "verification_gate",
    };
  }

  /** 针对常见工具错误模式的高精度启发式反思库。 */
  _heuristic_tool_reflection(
    tool_name: string,
    arguments_: Record<string, unknown>,
    error: string
  ): [string, string, string] {
    void tool_name;
    const err_lower = error.toLowerCase();
    if (
      err_lower.includes("file not found") ||
      err_lower.includes("no such file") ||
      err_lower.includes("does not exist")
    ) {
      const target =
        arguments_["path"] ?? arguments_["TargetFile"] ?? arguments_["file_path"] ?? "文件";
      return [
        `尝试操作的目标路径 \`${String(target)}\` 不存在。`,
        `在操作前先调用 list_dir / find_by_name 确认文件真实路径或先创建对应目录。`,
        `任何文件读写/替换前，必须确保目标文件已存在或先初始化该文件。`,
      ];
    }
    if (
      err_lower.includes("targetcontent") ||
      err_lower.includes("not found in file") ||
      err_lower.includes("replace")
    ) {
      return [
        "replace_file_content 替换块与现有文件内容不完全匹配（包含缩进、空格或换行差异）。",
        "先使用 view_file 查看最新精确代码行与行号，再执行精准替换，避免盲目猜测。",
        "代码编辑时必须保证 targetContent 与源文件字符及缩进 100% 严格一致。",
      ];
    }
    if (err_lower.includes("permission") || err_lower.includes("denied") || err_lower.includes("policy")) {
      return [
        `操作触发了安全策略限制或越权拦截: ${error.slice(0, 100)}`,
        "限制在当前工作区 (workspace) 内操作，使用只读或标准沙箱工具，避免操作敏感系统文件。",
        "遵守路径边界策略，绝不越权访问上级敏感目录。",
      ];
    }
    if (err_lower.includes("timeout")) {
      return [
        `命令/工具执行超时: ${error.slice(0, 100)}`,
        "拆分大任务为更小的子步骤，或增加单次命令超时阈值，避免单次执行过长耗时命令。",
        "耗时构建或测试操作应控制在限定执行时长内，必要时转入后台或拆步执行。",
      ];
    }

    return [
      `工具执行异常: ${error.slice(0, 150)}`,
      "检查输入参数格式与前置环境依赖，调整参数后重试。",
      "调用工具前仔细阅读工具参数规范并校验必填字段。",
    ];
  }
}

// ---------------------------------------------------------------------------
// ReflectionStore
// ---------------------------------------------------------------------------

/** 反思存储与召回管理器：负责反思的落库、搜索与上下文注入。 */
export class ReflectionStore {
  // Storage shape (structural, avoids importing the whole Storage type):
  // save_memory_entry(eid, sid, root, scope, content, opts) / get_memory_entries
  storage: {
    save_memory_entry: (
      eid: string,
      sid: string,
      root: string,
      scope: string,
      content: string,
      opts?: Record<string, unknown>
    ) => unknown;
    get_memory_entries: (
      root?: string | null,
      mem_type?: string | null,
      include_archived?: boolean,
      limit?: number | null,
      since?: number | null
    ) => Record<string, unknown>[];
  } & Record<string, unknown>;

  constructor(storage?: unknown) {
    if (storage === null || storage === undefined) {
      this.storage = get_storage() as unknown as ReflectionStore["storage"];
    } else {
      this.storage = storage as ReflectionStore["storage"];
    }
  }

  /** 将反思持久化至记忆系统。 */
  save_reflection(reflection: Reflection): boolean {
    try {
      const content = pyDumps(reflection_to_dict(reflection));
      const root = this.active_workspace();
      this.storage.save_memory_entry(
        reflection.id,
        reflection.session_id,
        root,
        "project",
        content,
        {
          meta: { tags: reflection.tags, source_tool: reflection.source_tool },
          mem_type: "reflection",
          importance: reflection.confidence,
          tags: reflection.tags,
          tier: MemoryTier.SHORT_TERM_RECALL,
          created_by: "evolution",
        }
      );
      // Phase 60 联动: 高置信度反思自动提交至 EvolutionEngine 待审提案
      // （fire-and-forget：桥接失败不影响落库结果，与源 except 吞并等价）
      void this._bridge_reflection_to_evolution(reflection);
      return true;
    } catch {
      return false;
    }
  }

  /** Phase 60 联动: 将高置信度反思前置防范规则自动向 EvolutionEngine 提议为自进化提案。 */
  async _bridge_reflection_to_evolution(reflection: Reflection): Promise<boolean> {
    if (!reflection.prevention_rule || reflection.confidence < 0.85) {
      return false;
    }
    try {
      // evolution 是 SPLIT 单元：computed-specifier 动态 import，
      // 缺席 = 源的 ImportError → except → return False。
      // Async drift：动态 import 必须 await；调用方（save_reflection）
      // 不等待它 —— 与源的同步语义相比只差微任务时序，失败仍静默。
      const spec = "./evolution" + ".js";
      const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
        EvolutionEngine: new (opts: { workspace_root: string; storage?: unknown }) => {
          store: {
            has_open_for_signature(sig: string): boolean;
            insert_proposal(prop: Record<string, unknown>): unknown;
            close(): unknown;
          };
        };
        Proposal: new (kwargs: Record<string, unknown>) => Record<string, unknown>;
      };

      const ws = this.active_workspace();
      const engine = new mod.EvolutionEngine({ workspace_root: ws, storage: this.storage });

      const sig = `reflection:${reflection.source_tool || "general"}:${reflection.scenario.slice(0, 30)}`;
      if (engine.store.has_open_for_signature(sig)) {
        return false;
      }

      const prop = new mod.Proposal({
        id: uuid4().replace(/-/g, "").slice(0, 16),
        signature: sig,
        kind: "tool_failure",
        tool_name: reflection.source_tool,
        target_file: "AGENTS.md",
        draft: `- [Rule] ${reflection.prevention_rule}`,
        rationale: `由 Reflexion 反思系统捕获: ${reflection.root_cause}，替代策略: ${reflection.alternative_strategy}`,
        hits: 1,
        status: "pending",
        created_at: Date.now() / 1000,
        user_title: `工具 ${reflection.source_tool || "操作"} 前置防范规则`,
        user_advice: reflection.prevention_rule,
        user_reason: reflection.root_cause,
        category: "safety",
      });
      engine.store.insert_proposal(prop);
      engine.store.close();
      return true;
    } catch {
      return false;
    }
  }

  /** Python 端读 storage._active_workspace；实际存储是 configs 库的
   * active_workspace kv 行（storage.py:1739 注释证实）。TS StorageBase 有
   * 同一 configs 库 —— 直接读 kv，缺席时空串由调用方 fallback 到 cwd。 */
  active_workspace(): string {
    const st = this.storage as Record<string, unknown>;
    try {
      if (typeof st["kv_get"] === "function") {
        const v = (st.kv_get as (k: string, ns?: string) => unknown)("active_workspace", "risk");
        if (typeof v === "string" && v) {
          return v;
        }
      }
    } catch {
      // fail-open: fall through to cwd
    }
    return process.cwd();
  }

  /** 按查询意图或相关工具召回适用的历史反思。 */
  retrieve_reflections(query = "", tool_names: readonly string[] = [], limit = 4): Reflection[] {
    const out: Reflection[] = [];
    try {
      const rows = this.storage.get_memory_entries(null, "reflection", false, limit * 3);
      for (const r of rows) {
        const content = String(r["content"] ?? "");
        try {
          const data = pyLoads(content);
          if (!data) {
            continue;
          }
          const ref = reflection_from_dict(data);
          // 匹配工具或关键词
          if (tool_names.length > 0 && tool_names.includes(ref.source_tool)) {
            out.push(ref);
          } else if (query && (ref.source_tool.includes(query) || ref.tags.some((t) => query.includes(t)))) {
            out.push(ref);
          } else {
            out.push(ref);
          }
          if (out.length >= limit) {
            break;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // except Exception: pass
    }
    return out.slice(0, limit);
  }

  /** 构建待注入 Prompt 的 `<reflections>` 上下文块。 */
  format_reflection_context(query = "", tool_names: readonly string[] = [], limit = 3): string {
    const refs = this.retrieve_reflections(query, tool_names, limit);
    if (refs.length === 0) {
      return "";
    }
    const lines: string[] = ["<reflections>", "【历史经验与前置避坑反思 (Reflexion Memory)】:"];
    for (const ref of refs) {
      lines.push(reflection_format_for_prompt(ref));
    }
    lines.push("</reflections>");
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Module singletons
// ---------------------------------------------------------------------------

let _generator_instance: ReflectionGenerator | null = null;
let _store_instance: ReflectionStore | null = null;

export function get_reflection_generator(): ReflectionGenerator {
  if (_generator_instance === null) {
    _generator_instance = new ReflectionGenerator();
  }
  return _generator_instance;
}

export function get_reflection_store(): ReflectionStore {
  if (_store_instance === null) {
    _store_instance = new ReflectionStore();
  }
  return _store_instance;
}
