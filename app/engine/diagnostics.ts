/**
 * diagnostics.ts — Diagnosable agent and system telemetry.
 *
 * Ported from `app/backend/diagnostics.py` (167 lines).
 *
 * Produces the two-view diagnostic report:
 * 1. Config-state report  (system view: which providers/MCP/Bot/Hook/Skill/… are configured)
 * 2. Feature-availability matrix (user view: which capabilities are usable + why)
 *
 * Plus the six-step skill localization method exposed via diagnose_skill so
 * "loaded != triggerable" problems can be walked through. Registered as the
 * `diagnose` tool.
 *
 * RULEBOOK CITATIONS
 *   §1  node:fs / node:path。
 *   §2  importlib.util.find_spec → require.resolve 探测（Node 侧：selenium/
 *       croniter 是 Python 生态，Node 侧对应能力由内置/已装包承担；探测
 *       失败即 false，行结构保留）。DIVERGENCE(port)：探测对象随生态切换，
 *       探测机制（模块可导入性）与行结构逐字一致。
 *   §2  `from skill_loader import get_skill_loader, SkillStatus`（SPLIT，未
 *       移植）→ computed 动态 import + except 吞并（源 diagnose_skill 在
 *       loader 缺席时抛 ImportError；TS 版返回 found=false 步骤，语义等价
 *       —— 对外报告"skill 未被发现"）。DIVERGENCE(port)：异步化已注明。
 *   §4  naming: diagnostics.py → diagnostics.ts
 *
 * PORT STATUS: confidence=medium todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Result } from "./result.js";

function _module_dir(): string {
  try {
    const d = (globalThis as Record<string, unknown>)["__dirname"];
    if (typeof d === "string") {
      return d;
    }
  } catch {
    // fall through
  }
  return process.cwd();
}

const BACKEND_DIR = _module_dir();
const APP_DIR = path.resolve(BACKEND_DIR, "..");
const PROJECT_DIR = path.resolve(APP_DIR, "..");

/** Six-step skill localization method (reference text for reports). */
export const SIX_STEP_METHOD = [
  "1. 子系统开关：功能总开关开了吗（memory/compact/skill/mcp/hook）？",
  "2. 是否被发现：文件在发现路径吗（用户 > 工作区 > 内置）？",
  "3. 加载是否失败：frontmatter 合法吗？description 空/超长会被丢弃。",
  "4. 谁赢了 (shadow)：更高优先级有同名副本吗？首个同名生效。",
  "5. 是否被禁用：插件禁用状态 / 配置里的 disable 覆盖？",
  "6. 触发词是否弱：description 前 ~250 字写清'何时用'了吗？",
];

function _module_available(mod: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const req = eval("require") as NodeRequire;
    req.resolve(mod);
    return true;
  } catch {
    return false;
  }
}

export class Diagnostics {
  config: Record<string, unknown>;

  constructor(config?: Record<string, unknown> | null) {
    this.config = config !== null && config !== undefined ? config : this._load_config();
  }

  _load_config(): Record<string, unknown> {
    const p = path.join(APP_DIR, "config.json");
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  // ── config-state (system view) ────────────────────────────────

  config_state(): Record<string, unknown>[] {
    const cfg = this.config;
    const model = (cfg["model"] as Record<string, unknown>) ?? {};
    const mcp = (cfg["mcp"] as Record<string, unknown>) ?? {};
    const bot = (cfg["bot"] as Record<string, unknown>) ?? {};
    const memory = (cfg["memory"] as Record<string, unknown>) ?? {};

    const hooks_path = path.join(PROJECT_DIR, ".agents", "hooks.json");
    const skills_dir = path.join(PROJECT_DIR, ".agents", "skills");
    let skill_count = 0;
    if (fs.existsSync(skills_dir) && fs.statSync(skills_dir).isDirectory()) {
      skill_count = fs.readdirSync(skills_dir).filter((e) => {
        const skill_md = path.join(skills_dir, e, "SKILL.md");
        return fs.existsSync(skill_md) && fs.statSync(skill_md).isFile();
      }).length;
    }

    return [
      {
        category: "Provider",
        configured: Boolean(model["api_key"]),
        detail: String(model["model_id"] ?? "") || "no model_id",
      },
      {
        category: "MCP",
        configured: Boolean(mcp["gateway_url"]),
        detail: String(mcp["gateway_url"] ?? "") || "gateway_url empty",
      },
      {
        category: "Bot",
        configured: Boolean(bot["telegram_token"] || bot["feishu_app_id"]),
        detail: "telegram/feishu credentials",
      },
      {
        category: "Hook",
        configured: fs.existsSync(hooks_path) && fs.statSync(hooks_path).isFile(),
        detail: fs.existsSync(hooks_path) ? hooks_path : "no .agents/hooks.json",
      },
      { category: "Skill", configured: skill_count > 0, detail: `${skill_count} skill(s) on disk` },
      {
        category: "Memory",
        configured: Boolean(memory["enabled"]),
        detail: `embedding=${String(memory["embedding_model"] ?? "n/a")}`,
      },
    ];
  }

  // ── feature-availability (user view) ──────────────────────────

  feature_matrix(): Record<string, unknown>[] {
    const cfg = this.config;
    const model = (cfg["model"] as Record<string, unknown>) ?? {};
    const mcp = (cfg["mcp"] as Record<string, unknown>) ?? {};
    const bot = (cfg["bot"] as Record<string, unknown>) ?? {};
    const memory = (cfg["memory"] as Record<string, unknown>) ?? {};
    const hooks_path = path.join(PROJECT_DIR, ".agents", "hooks.json");

    const row = (feature: string, available: unknown, depends: string) => ({
      feature,
      available: Boolean(available),
      depends_on: depends,
    });

    return [
      row("AI 对话", model["api_key"], "Provider api_key"),
      row("文件读写", true, "built-in tools"),
      row("系统/进程管理", true, "built-in tools"),
      row("浏览器自动化", _module_available("selenium"), "selenium + control-browser skill"),
      row("深度搜索", true, "search_agent (arxiv/web built-in)"),
      row("定时任务", _module_available("croniter"), "croniter + CronCreate"),
      row("长程目标", true, "goal_manager"),
      row("记忆系统", memory["enabled"], "memory.enabled + storage"),
      row("自动化 Hook", fs.existsSync(hooks_path) && fs.statSync(hooks_path).isFile(), ".agents/hooks.json"),
      row("外部 MCP", mcp["gateway_url"], "mcp.gateway_url"),
      row("远程控制", bot["telegram_token"] || bot["feishu_app_id"], "Bot 配置"),
    ];
  }

  // ── six-step skill diagnosis ──────────────────────────────────

  /** Walk the six-step method for one skill and report where it stands.
   * Async drift：skill_loader 是 SPLIT，动态 import 需 await；源同步签名
   * 变 Promise（调用方 diagnose 工具链本就异步投递 Result）。DIVERGENCE(port)：异步化已注明。 */
  async diagnose_skill(name: string): Promise<Record<string, unknown>> {
    const steps: Record<string, unknown>[] = [];
    // skill_loader 是 SPLIT：动态 import，缺席 = 源 ImportError → 对外
    // 等价呈现为 "not found"（diagnose 报告不崩溃）。
    {
      let loader: Record<string, unknown> | null = null;
      try {
        const spec = "./skill_loader" + ".js";
        const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
          get_skill_loader: () => Record<string, unknown>;
          SkillStatus: Record<string, string>;
        };
        loader = { loader: mod.get_skill_loader(), SkillStatus: mod.SkillStatus };
      } catch {
        loader = null;
      }
      if (loader === null) {
        steps.push({
          step: 2,
          check: "discovered",
          pass: false,
          note: "not found in loader",
        });
        return { skill: name, found: false, steps, method: SIX_STEP_METHOD } as Record<string, unknown>;
      }

      const l = loader["loader"] as Record<string, unknown>;
      const SkillStatus = loader["SkillStatus"] as Record<string, string>;
      const entry = (l["get_skill"] as (n: string) => Record<string, unknown> | null)(name) as {
        status?: string;
        errors?: string[];
        description?: string;
      } | null;

      const found = entry !== null;
      steps.push({
        step: 2,
        check: "discovered",
        pass: found,
        note: found ? "on disk & imported" : "not found in loader",
      });
      if (!found) {
        return { skill: name, found: false, steps, method: SIX_STEP_METHOD };
      }

      const loaded = entry!.status !== SkillStatus["DROPPED"];
      steps.push({
        step: 3,
        check: "loaded (frontmatter ok)",
        pass: loaded,
        note: (entry!.errors ?? []).join("; ") || "ok",
      });
      const enabled = entry!.status !== SkillStatus["DISABLED"];
      steps.push({ step: 5, check: "enabled", pass: enabled, note: String(entry!.status) });
      const strong_trigger = String(entry!.description ?? "").trim().length >= 30;
      steps.push({
        step: 6,
        check: "trigger words",
        pass: strong_trigger,
        note: `description length=${String(entry!.description ?? "").length}`,
      });
      return {
        skill: name,
        found: true,
        status: String(entry!.status),
        steps,
        method: SIX_STEP_METHOD,
      } as Record<string, unknown>;
    }
  }

  report(): Record<string, unknown> {
    const cfg_state = this.config_state();
    const matrix = this.feature_matrix();
    return {
      config_state: cfg_state,
      feature_matrix: matrix,
      available_features: matrix.filter((m) => m["available"]).length,
      total_features: matrix.length,
      six_step_method: SIX_STEP_METHOD,
    };
  }
}

export function _diagnose_impl(args: Record<string, unknown>): unknown {
  const diag = get_diagnostics();
  const skill = args["skill"];
  if (skill) {
    return Result.success(diag.diagnose_skill(String(skill)));
  }
  return Result.success(diag.report());
}

/** Register the `diagnose` tool. */
export function register_tools(registry?: unknown): void {
  void (async () => {
    try {
      // tools.py 是 SPLIT 单元：computed-specifier 动态 import，
      // 缺席时静默返回（源的 ImportError 等价吞并）。
      const spec = "./tools" + ".js";
      const mod = (await import(/* @vite-ignore */ spec)) as unknown as {
        ToolDef: new (
          name: string,
          description: string,
          schema: Record<string, unknown>,
          impl: (args: Record<string, unknown>, ctx: unknown) => unknown,
          kwargs: Record<string, unknown>
        ) => unknown;
        get_tool_registry: () => { register: (def: unknown) => unknown };
      };
      const reg = (registry ?? mod.get_tool_registry()) as {
        register: (def: unknown) => unknown;
      };
      reg.register(
        new mod.ToolDef(
          "diagnose",
          "Diagnose the agent: config-state report + feature-availability matrix. " +
            "Pass 'skill' to run the six-step method on one skill.",
          { type: "object", properties: { skill: { type: "string" } }, required: [] },
          _diagnose_impl,
          { domain: "computer", risk_level: "low" }
        )
      );
    } catch {
      // ImportError swallow
    }
  })();
}

let _diag: Diagnostics | null = null;

export function get_diagnostics(config?: Record<string, unknown> | null): Diagnostics {
  if (_diag === null) {
    _diag = new Diagnostics(config ?? undefined);
  }
  return _diag;
}
