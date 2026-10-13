/**
 * router_modules/prompt.ts - EnvironmentSnapshot, prompt assembly, and guidance blocks.
 */

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { prompt_block as ask_user_prompt_block } from "../ask_user.js";
import { get_prompt_loader } from "../prompt_layers.js";
import { prompt_block as permission_prompt_block } from "../risk_control.js";
import { shorten_path } from "../tools.js";
import {
  extract_plan_block,
  get_plan_artifact,
  render_contract,
  save_plan_artifact,
} from "../plan_artifact.js";
import { wrap_untrusted } from "../active_memory.js";

export const PROMPT_SEAMS = {
  get_plan_artifact: get_plan_artifact as (id: string) => any,
  render_contract: render_contract as (art: any) => string,
  save_plan_artifact: save_plan_artifact as (
    session_id: string,
    plan_md: string,
    opts?: any
  ) => any,
  extract_plan_block: extract_plan_block as (text: string) => string,
  wrap_untrusted: wrap_untrusted as (text: string, source: string) => string,
};

export class EnvironmentSnapshot {
  /** Build environment snapshot for system prompt injection with short TTL cache. */
  static _cache: Record<string, [number, string]> = {};
  static TTL_SECONDS = 2.5;
  static pythonVersion: string = process.env.OVERRIDE_PYTHON_VERSION || "3.13.14";

  static invalidate(workspace?: string | null): void {
    /** Explicitly invalidate snapshot cache on file/git mutations. */
    if (workspace) {
      const ws_key = path.resolve(workspace);
      delete this._cache[ws_key];
    } else {
      this._cache = {};
    }
  }

  static build(workspace?: string | null): string {
    const ws = workspace || process.cwd();
    const ws_key = path.resolve(ws);
    const now = Date.now() / 1000;
    const cached = this._cache[ws_key];
    if (cached && (now - cached[0]) < this.TTL_SECONDS) {
      return cached[1];
    }

    const parts = ["# Environment Snapshot (snapshot in time)\n"];
    parts.push(`- Working directory: \`${shorten_path(ws)}\``);
    parts.push(`- Platform: ${this._platform_system()} ${this._platform_release()}`);
    parts.push(`- Python: ${this.pythonVersion}`);

    // Git snapshot
    const git_info = this._git_snapshot(ws);
    if (git_info) {
      parts.push(`\n## Git Status\n${git_info}`);
    } else {
      // Directory snapshot for non-git dirs
      const dir_info = this._dir_snapshot(ws);
      if (dir_info) {
        parts.push(`\n## Directory Overview\n${dir_info}`);
      }
    }

    const res = parts.join("\n");
    this._cache[ws_key] = [now, res];
    return res;
  }

  static _platform_system(): string {
    if (process.env.OVERRIDE_PLATFORM_SYSTEM) return process.env.OVERRIDE_PLATFORM_SYSTEM;
    if (process.platform === "win32") return "Windows";
    if (process.platform === "darwin") return "Darwin";
    if (process.platform === "linux") return "Linux";
    return os.type();
  }

  static _platform_release(): string {
    if (process.env.OVERRIDE_PLATFORM_RELEASE) return process.env.OVERRIDE_PLATFORM_RELEASE;
    if (process.platform === "win32") {
      const rel = os.release();
      const major = rel.split(".")[0] || "10";
      const build = parseInt(rel.split(".")[2] || "0", 10);
      if (build >= 22000) return "11";
      return major;
    }
    return os.release();
  }

  static _git_snapshot(ws: string): string | null {
    const git_dir = path.join(ws, ".git");
    if (!fs.existsSync(git_dir)) {
      return null;
    }
    try {
      const _git = (args: string[]): string => {
        try {
          return child_process.execFileSync(
            "git",
            ["-c", "core.quotePath=false", ...args],
            {
              cwd: ws,
              timeout: 5000,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "ignore"],
            }
          ).trim();
        } catch {
          return "";
        }
      };

      const branch = _git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const status = _git(["status", "--short"]);
      const log = _git(["log", "--oneline", "-5"]);
      // Capture the committer identity and the repo's main
      // branch so the model can reason about "merge to main" style asks.
      const user = _git(["config", "user.name"]);
      const main_branch = this._main_branch(ws, _git);

      const parts = [`- Branch: \`${branch}\``];
      if (main_branch && main_branch !== branch) {
        parts.push(`- Main branch: \`${main_branch}\``);
      }
      if (user) {
        parts.push(`- Git user: ${user}`);
      }
      parts.push(`- Status: ${status ? "dirty" : "clean"}`);
      if (status) {
        const lines = status.split("\n").slice(0, 10);
        parts.push(`- Modified files: ${status.split("\n").length}`);
        parts.push("```\n" + lines.join("\n") + "\n```");
      } else {
        parts.push("- Working tree clean");
      }
      parts.push("- Recent commits:\n```\n" + log + "\n```");
      return parts.join("\n");
    } catch {
      return null;
    }
  }

  static _main_branch(ws: string, _git: (args: string[]) => string): string {
    /** Resolve the repo's main branch (origin/HEAD, else main/master). */
    const head = _git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (head) {
      const idx = head.lastIndexOf("/");
      return idx >= 0 ? head.slice(idx + 1) : head;
    }
    for (const candidate of ["main", "master"]) {
      try {
        if (_git(["rev-parse", "--verify", candidate])) {
          return candidate;
        }
      } catch {
        // ignore
      }
    }
    return "";
  }

  static _dir_snapshot(ws: string): string | null {
    try {
      const entries = fs.readdirSync(ws).sort().slice(0, 20);
      const dirs: string[] = [];
      const files: string[] = [];
      for (const e of entries) {
        if (e.startsWith(".")) continue;
        const full = path.join(ws, e);
        try {
          const st = fs.statSync(full);
          if (st.isDirectory()) {
            dirs.push(e + "/");
          } else if (st.isFile()) {
            files.push(e);
          }
        } catch {
          // ignore
        }
      }
      const parts = [`- Directories: ${dirs.slice(0, 10).join(", ")}`];
      parts.push(`- Files: ${files.slice(0, 10).join(", ")}`);
      return parts.join("\n");
    } catch {
      return null;
    }
  }
}

export function _is_cot_content_leak(text: string): boolean {
  /**
   * True when *text* looks like a spurious content token during CoT streaming.
   *
   * Some reasoning gateways (e.g. LongCat) emit reasoning_content and also
   * leak 1–2 punctuation/digit tokens on the content channel while thinking.
   * Those must not grow the assistant bubble.
   */
  const t = (text || "").trim();
  if (!t) {
    return true;
  }
  if (t.length > 2) {
    return false;
  }
  for (const c of t) {
    if (/\p{L}/u.test(c) || (c >= "\u4e00" && c <= "\u9fff")) {
      return false;
    }
  }
  return true;
}

export function _strip_leading_junk(text: string): string {
  /**
   * Strip a SHORT junk prefix (<= 2 numbers/punctuation chars, criterion same as _is_cot_content_leak)
   * from the first frame of a channel. Returns the remainder; "" when the whole
   * frame is junk.
   */
  const t = text || "";
  let n = 0;
  let foundLetter = false;
  for (const c of t) {
    if (/\p{L}/u.test(c) || (c >= "\u4e00" && c <= "\u9fff")) {
      foundLetter = true;
      break;
    }
    n += 1;
  }
  if (!foundLetter) {
    return ""; // whole frame is junk
  }
  if (0 < n && n <= 2) {
    return t.slice(n).trimStart();
  }
  return t;
}

// ---------------------------------------------------------------------------
// Plan: approved contract injection
// ---------------------------------------------------------------------------

export function _approved_plan_context(
  messages: any[],
  context: Record<string, any>
): [any[], Record<string, any>] {
  /**
   * Execution turn preface: inject approved plan contract into message head,
   * producing extra meta fields.
   *
   * Returns [messages, meta_extra]. Contract injected as user role right before original request.
   * Fail-open if plan not approved or missing.
   */
  const meta_extra: Record<string, any> = {};
  const plan_id = String((context || {}).approved_plan || "").trim();
  if (!plan_id) {
    return [messages, meta_extra];
  }
  try {
    const art = PROMPT_SEAMS.get_plan_artifact(plan_id);
    if (!art || (art as any).status !== "approved") {
      return [messages, meta_extra];
    }
    const contract = PROMPT_SEAMS.render_contract(art as any);
    const injected = [{ role: "user", content: contract }, ...messages];
    meta_extra["approved_with"] = String((art as any).approved_with || "");
    meta_extra["approved_plan_id"] = plan_id;
    return [injected, meta_extra];
  } catch (exc) {
    console.error(`[plan_artifact] contract injection failed (fail-open): ${exc}`);
    return [messages, meta_extra];
  }
}

export function _merge_plan_meta(
  meta: Record<string, any>,
  context: any
): Record<string, any> {
  /**
   * Merge plan approval info recorded in execution turn into turn meta.
   * Pop to avoid pollution of subsequent turns.
   */
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return meta;
  }
  const plan_meta = context._plan_meta;
  delete context._plan_meta;
  if (plan_meta && typeof plan_meta === "object" && !Array.isArray(plan_meta)) {
    Object.assign(meta, plan_meta);
  }
  return meta;
}

export class RouterPromptMixin {
  /** Mixin providing prompt building, guidance reading, and plan capture for Router. */

  GUIDANCE_FILES: readonly string[] = ["MEMORY.md", "AGENTS.md", "SOUL.md"];
  GUIDANCE_MAX_CHARS: number = 6000;

  // Expected router instance fields:
  workspace?: string;
  session_id?: string;
  permission?: string;
  is_subagent?: boolean;
  system_prompt?: string;
  effective_workspace?: string;
  models?: any;
  memory?: any;
  storage?: any;
  goals?: any;
  rules?: any;
  skills?: any;
  compactor?: any;
  bus?: any;
  _stable_prefixes?: any;
  _sys_cache_prefix?: string;

  _read_guidance_file(name: string): string {
    /**
     * Read one workspace-root guidance file, or "" if it isn't usable.
     * Containment is checked with realpath rather than trusting join.
     */
    const root = this.workspace || "";
    if (!root) {
      return "";
    }
    let text = "";
    try {
      const base = fs.realpathSync(root);
      const target = fs.realpathSync(path.join(base, name));
      if (!target.startsWith(base + path.sep)) {
        return ""; // a symlink resolved outside the workspace
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        return "";
      }
      const raw = fs.readFileSync(target, { encoding: "utf-8" });
      text = raw.slice(0, this.GUIDANCE_MAX_CHARS + 1);
    } catch {
      return "";
    }
    text = text.trim();
    if (!text) {
      return "";
    }
    if (text.length > this.GUIDANCE_MAX_CHARS) {
      text = text.slice(0, this.GUIDANCE_MAX_CHARS).trimEnd() + "\n…（已截断，完整内容见项目根目录该文件）";
    }
    return text;
  }

  guidance_blocks(): Record<string, string> {
    /** All readable guidance files, keyed by filename. Empty when none exist. */
    const out: Record<string, string> = {};
    for (const name of this.GUIDANCE_FILES) {
      const body = this._read_guidance_file(name);
      if (body) {
        out[name] = body;
      }
    }
    return out;
  }

  _sync_turn_cache_prefix(full_system: string): void {
    /** Extend cache prefix using registry longest_match after skill append. */
    try {
      const result = this._stable_prefixes?.longest_match?.(full_system || "");
      const matched = result ? result[1] : "";
      if (matched && matched.length > (this._sys_cache_prefix || "").length) {
        this._sys_cache_prefix = matched;
      }
    } catch {
      // pass
    }
  }

  _skill_guidance_block(context: Record<string, any>): string {
    /**
     * LLM main loop Stage-2 progressive disclosure.
     * Trigger-matched skill body injected into system prompt as untrusted reference material.
     */
    try {
      if (!context || context.benchmark) {
        return "";
      }
      const cands = context.skill_candidates || [];
      if (!cands || cands.length === 0 || context.skill_injected) {
        return "";
      }
      const cand0 = cands[0] || {};
      const skillName = String(cand0.name || "");
      const entry = this.skills?.get_skill?.(skillName);
      if (!entry) {
        return "";
      }
      const loaded = this.skills?.load_skill_body?.(entry.name);
      if (!loaded || !loaded.ok) {
        return "";
      }
      const val = loaded.value || {};
      const body = (
        typeof val === "object" && val !== null && !Array.isArray(val)
          ? String(val.body || "")
          : String(val || "")
      ).trim();
      if (!body) {
        return "";
      }
      const version = String(entry.version || "");
      context.skill_injected = {
        name: entry.name,
        version: version,
      };
      const wrapped = PROMPT_SEAMS.wrap_untrusted(body.slice(0, 2000), "skill");
      const block = `\n\n<skill-guidance source="trigger-matched-skill" name="${entry.name}">\n${wrapped}\n</skill-guidance>`;
      try {
        const scope = this.compactor?.cache_scope?.() ?? "";
        const base = this._sys_cache_prefix || "";
        this._stable_prefixes?.register?.(
          `skill:${scope}:${entry.name}:${version}`,
          base + block
        );
      } catch {
        // pass
      }
      return block;
    } catch (e) {
      console.error(`[skills] guidance inject failed: ${e}`);
      return "";
    }
  }

  async _maybe_capture_plan(
    context: Record<string, any>,
    output: string
  ): Promise<void> {
    /**
     * permission=plan successful turn saves output as plan artifact and emits plan_ready.
     * Fail-open: any exception is logged without throwing.
     */
    try {
      if ((context || {}).permission !== "plan") {
        return;
      }
      const text = String(output || "");
      if (!text.trim()) {
        return;
      }
      const plan_md = PROMPT_SEAMS.extract_plan_block(text);
      if (!plan_md) {
        return;
      }
      const sessionId = String(this.session_id || "");
      const turnId = String((context || {}).turn_id || "");
      const art = PROMPT_SEAMS.save_plan_artifact(sessionId, plan_md, {
        turn_id: turnId,
      });
      await this.bus?.emit?.("plan_ready", {
        session_id: sessionId,
        plan_id: art.plan_id,
        chars: art.chars,
        preview: plan_md.slice(0, 300),
      });
      context.plan_id = art.plan_id;
    } catch (exc) {
      console.error(`[plan_artifact] capture failed (fail-open): ${exc}`);
    }
  }

  get_system_prompt(context: Record<string, any> = {}): string {
    /** Build the system prompt from the six-layer file cluster. */
    const ctx = context || {};
    if (ctx.benchmark) {
      return (
        "You are an elite scientific researcher, mathematician, and expert problem solver with PhD-level mastery " +
        "across physics, chemistry, biology, materials science, and mathematics.\n\n" +
        "### Core Operating Constitution:\n" +
        "1. First-Principles Deconstruction: Do not rely on intuition, superficial pattern-matching, or mental shortcuts. " +
        "Explicitly identify the governing physical laws, reaction mechanisms, differential equations, biochemical pathways, " +
        "or mathematical definitions involved.\n" +
        "2. Mandatory Code-as-Scratchpad Verification: You have access to python_executor (which supports math, numpy, scipy, " +
        "sympy, itertools, fractions, etc.) and shell_executor. For any quantitative, combinatorial, thermodynamic, spectroscopic, " +
        "or coordinate problem, NEVER calculate in your head. Write and execute Python code to compute exact values, check units, " +
        "evaluate matrix determinants, solve roots, or verify limits.\n" +
        "3. Adversarial Distractor Auditing: In multiple-choice questions (MCQs), incorrect options are specifically designed to " +
        "exploit common misconceptions, sign flips, index shifts, standard temperature/pressure conversions, and stoichiometric ratios. " +
        "Before concluding, systematically eliminate distractors by proving why each alternative choice is invalid.\n" +
        "4. Tool Error Resilience: If a tool call returns an error or empty output, immediately inspect the failure, adjust the syntax " +
        "or parameters, and re-run. Do not give up on verification.\n" +
        "5. Strict Output Protocol: At the very end of your final response, state your definitive answer in the exact format " +
        "requested in the prompt (e.g., 'ANSWER: $CHOICE' where $CHOICE is A, B, C, or D; or 'FINAL ANSWER: $VALUE')."
      );
    }

    const snapshot = EnvironmentSnapshot.build(this.workspace);
    const model_info = this.models?.resolve?.();
    const model_name =
      model_info && model_info.ok && model_info.value?.model_id
        ? model_info.value.model_id
        : "unknown";

    // ── MEMORY layer: tier inject + wiki claims + recall + synthesis ──
    const memory_parts: string[] = [];

    // 1. C1 always-inject tiers (WORKING + LONG_TERM). User-editable,
    //    pre-budgeted, highest trust.
    const tier_inject = ctx.memory_inject;
    if (tier_inject) {
      memory_parts.push(
        "## Persistent Memory (curated; WORKING + LONG_TERM tiers)\n" +
          String(tier_inject)
      );
    }

    // 1b. Project guidance files (AGENTS.md / MEMORY.md / SOUL.md), read back off disk.
    for (const [name, body] of Object.entries(this.guidance_blocks())) {
      memory_parts.push(`## Project Guidance · ${name}\n${body}`);
    }

    // 2. C4 wiki claims.
    const wiki_block = ctx.wiki_claims;
    if (wiki_block) {
      memory_parts.push(
        "## Declarative Knowledge (wiki claims)\n" +
          '带 status="disputed" 的条目存在未裁决的矛盾——需要时向用户澄清，' +
          "不要自己挑一边当事实。\n" +
          String(wiki_block)
      );
    }

    // 3. C3 recalled episodic memory.
    const injected = ctx.injected_memories || [];
    if (injected && (Array.isArray(injected) ? injected.length > 0 : Boolean(injected))) {
      const body = Array.isArray(injected) ? injected.join("\n") : String(injected);
      memory_parts.push(
        "## Recalled Memory (from previous sessions; not user-visible)\n" + body
      );
    }

    // 4. Reflexion (NeurIPS 2023): 前置避坑反思与历史教训
    const reflections = ctx.reflections;
    if (reflections) {
      memory_parts.push(
        "## Reflexion Self-Reflections (前置避坑与自省)\n" + String(reflections)
      );
    }

    const prev = this.memory?.get_session_synthesis?.(this.session_id);
    if (prev) {
      const body = JSON.stringify(prev, null, 2);
      memory_parts.push(`## Session Synthesis\n\`\`\`json\n${body}\n\`\`\``);
    } else {
      // Cross-session: parent fork synthesis or recent workspace syntheses
      try {
        const row = this.storage?.get_session?.(this.session_id) || {};
        const parent_id = String(row.parent_id || "");
        if (parent_id) {
          const ps = this.memory?.get_session_synthesis?.(parent_id);
          if (ps) {
            const body = JSON.stringify(ps, null, 2);
            memory_parts.push(
              `## Prior Session Synthesis (from parent)\n\`\`\`json\n${body}\n\`\`\``
            );
          }
        }
        const ws = String(row.workspace || this.effective_workspace || "");
        const recent =
          this.storage?.get_workspace_recent_synthesis?.(ws, this.session_id, 2) || [];
        for (const item of recent) {
          const body = JSON.stringify(item.synthesis || {}, null, 2);
          const sessShort = String(item.session_id || "").slice(0, 8);
          memory_parts.push(
            `## Cross-Session Synthesis (session ${sessShort}…)\n\`\`\`json\n${body}\n\`\`\``
          );
        }
      } catch {
        // pass
      }
    }

    // ── AGENTS layer: active goal keeps long tasks alive across turns ──
    const agents_parts: string[] = [];
    const goal_ctx = this.goals?.get_active_goal_context?.();
    if (goal_ctx) {
      agents_parts.push(`## Active Goal\n${goal_ctx}`);
    }

    // ── SOUL layer: builtin constitution + the user's own rule library ──
    const loader = this._prompt_loader();
    const base_layers: Record<string, string> = {};
    for (const l of loader.load()) {
      base_layers[l.name] = l.content;
    }

    let soul_override: string | null = null;
    const rules_block = this.rules?.render_for_prompt?.();
    if (rules_block) {
      soul_override = ((base_layers["SOUL"] || "") + "\n\n" + rules_block).trim();
    }

    // ── Dynamic Turn Rules & Capability Hints (placed in dynamic MEMORY layer) ──
    const hint_block = ctx.capability_hints;
    if (hint_block) {
      memory_parts.push(`## Recommended Capabilities for This Turn\n${hint_block}`);
    }

    const perm_block = permission_prompt_block(this.permission || "auto");
    const ask_block = ask_user_prompt_block(
      !(this.is_subagent || ctx.is_remote)
    );
    const dynamic_exec_blocks = [perm_block, ask_block].filter(Boolean).join("\n\n");
    if (dynamic_exec_blocks) {
      memory_parts.push(`## Turn Execution Policy\n${dynamic_exec_blocks}`);
    }

    const overrides: Record<string, string> = {
      MEMORY: memory_parts.join("\n\n"),
      AGENTS: agents_parts.join("\n\n"),
    };
    if (soul_override !== null) {
      overrides["SOUL"] = soul_override;
    }

    // TOOLS layer: Stage 1 of progressive skill disclosure (B2).
    let tools_block = ctx.available_skills_block || "";
    if (!tools_block) {
      try {
        tools_block = this.skills?.render_available_skills_prompt?.() || "";
      } catch {
        tools_block = ""; // a broken catalogue must not kill the turn
      }
    }
    if (tools_block) {
      overrides["TOOLS"] = tools_block;
      try {
        const scope = this.compactor?.cache_scope?.() ?? "";
        this._stable_prefixes?.register?.(`tools:${scope}`, tools_block);
      } catch {
        // pass
      }
    }

    const [layered, stable] = loader.render_and_prefix(overrides);
    this._sys_cache_prefix = stable;
    try {
      const scope = this.compactor?.cache_scope?.() ?? "";
      this._stable_prefixes?.register?.(`sys:${scope}`, stable);
    } catch {
      // pass
    }

    return (
      `${layered}\n\n` +
      `${snapshot}\n` +
      `## Active Model: ${model_name}\n` +
      `## Session: ${this.session_id || ""}\n`
    );
  }

  _prompt_loader(): any {
    /** Lazily bind the layer loader to this router's workspace. */
    return get_prompt_loader(
      this.workspace || "",
      this.system_prompt || ""
    );
  }
}
