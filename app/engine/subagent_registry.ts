/**
 * subagent_registry.ts — definitions for the sub-agent types the `task` tool can spawn.
 * Port of app/backend/subagent_registry.py (unit 174, wave 7).
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { get_tool_registry } from "./tools.js";
import { loadSimpleYaml } from "./path_policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class HandoffEnvelope {
  /** 子代理任务委派上下文信封 */
  subagent_type: string;
  task: string;
  parent_session_id: string;
  context_refs: string[];
  memory_refs: string[];
  target_paths: string[];
  depth: number;

  constructor(opts: {
    subagent_type: string;
    task: string;
    parent_session_id: string;
    context_refs?: string[];
    memory_refs?: string[];
    target_paths?: string[];
    depth?: number;
  }) {
    this.subagent_type = opts.subagent_type;
    this.task = opts.task;
    this.parent_session_id = opts.parent_session_id;
    this.context_refs = opts.context_refs || [];
    this.memory_refs = opts.memory_refs || [];
    this.target_paths = opts.target_paths || [];
    this.depth = opts.depth || 0;
  }
}

export class ResultContract {
  /** 子代理交付契约 */
  status: string; // "ok" | "error" | "refused"
  summary: string;
  findings: Array<Record<string, any>>;
  changed_files: string[];
  raw_output: string;

  constructor(opts?: {
    status?: string;
    summary?: string;
    findings?: Array<Record<string, any>>;
    changed_files?: string[];
    raw_output?: string;
  }) {
    this.status = opts?.status || "ok";
    this.summary = opts?.summary || "";
    this.findings = opts?.findings || [];
    this.changed_files = opts?.changed_files || [];
    this.raw_output = opts?.raw_output || "";
  }
}

export class SubagentDef {
  name: string;
  description: string;
  system_prompt: string;
  allowed_tools: Set<string> | null;
  permission: string;
  model: string | null;
  model_policy: string;
  max_turns: number | null;
  handoffs: Set<string>;
  memory_policy: string;
  skill_policy: string;
  isolation: string;
  result_schema: string;
  auto_respawn: boolean;
  exec_mode: string;
  domain_rules: Record<string, any>;
  mcp_tool_cap: number;

  constructor(opts: {
    name: string;
    description: string;
    system_prompt: string;
    allowed_tools?: Set<string> | Iterable<string> | null;
    permission?: string;
    model?: string | null;
    model_policy?: string;
    max_turns?: number | null;
    handoffs?: Set<string> | Iterable<string>;
    memory_policy?: string;
    skill_policy?: string;
    isolation?: string;
    result_schema?: string;
    auto_respawn?: boolean;
    exec_mode?: string;
    domain_rules?: Record<string, any>;
    mcp_tool_cap?: number;
  }) {
    this.name = opts.name;
    this.description = opts.description;
    this.system_prompt = opts.system_prompt;
    this.allowed_tools = opts.allowed_tools ? new Set(opts.allowed_tools) : null;
    this.permission = opts.permission || "auto";
    this.model = opts.model || null;
    this.model_policy = opts.model_policy || "auto";
    this.max_turns = opts.max_turns !== undefined ? opts.max_turns : null;
    this.handoffs = opts.handoffs ? new Set(opts.handoffs) : new Set();
    this.memory_policy = opts.memory_policy || "task_refs_only";
    this.skill_policy = opts.skill_policy || "explicit_refs_only";
    this.isolation = opts.isolation || "worktree_or_overlay";
    this.result_schema = opts.result_schema || "ResultContract.v1";
    this.auto_respawn = Boolean(opts.auto_respawn);
    this.exec_mode = opts.exec_mode || "inprocess";
    this.domain_rules = opts.domain_rules || {};
    this.mcp_tool_cap = opts.mcp_tool_cap !== undefined ? opts.mcp_tool_cap : 24;
  }

  to_public(): Record<string, any> {
    return {
      name: this.name,
      description: this.description,
      allowedTools: this.allowed_tools ? Array.from(this.allowed_tools).sort() : null,
      permission: this.permission,
      model: this.model,
      modelPolicy: this.model_policy || "auto",
      maxTurns: this.max_turns,
      handoffs: Array.from(this.handoffs).sort(),
      memoryPolicy: this.memory_policy,
      skillPolicy: this.skill_policy,
      isolation: this.isolation,
      resultSchema: this.result_schema,
      autoRespawn: this.auto_respawn,
      execMode: this.exec_mode,
      domainRules: this.domain_rules,
      mcpToolCap: this.mcp_tool_cap,
    };
  }
}

// ── 五轴域规则评估引擎 (P3-2) ──────────────────────────────────────────────

export const _FS_WRITE_TOOLS = new Set([
  "write_file", "edit_file", "write_to_file", "replace_file_content",
  "create_file", "delete_file", "touch", "patch", "apply_patch",
]);

export const _FS_READ_TOOLS = new Set([
  "read_text", "search_code", "find_files", "list_dir", "get_file_info",
  "diff_files", "view_file", "grep_search", "find_by_name",
]);

export const _NETWORK_TOOLS = new Set([
  "web_search", "web_fetch", "academic_search", "standard_search",
  "browser_open", "http_request", "read_url_content", "search_web",
]);

export const _COMMAND_TOOLS = new Set([
  "run_command", "shell_executor", "terminal", "bash", "cmd", "exec", "powershell",
]);

export function _split_command_pipeline(cmd_line: string): string[] {
  /** 把复合命令按分号、管道与逻辑操作符拆分成独立命令单元。 */
  const parts = cmd_line.split(/[;\n|&]+/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function fnmatch(name: string, pat: string): boolean {
  /** Glob pattern matching (case-insensitive on Windows / Python fnmatch semantics). */
  const reStr =
    "^" +
    pat
      .replace(/([.+^=!:${}()|\[\]\/\\])/g, "\\$1")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  const re = new RegExp(reStr, "i");
  return re.test(name);
}

export function shlexSplit(s: string, posix: boolean = false): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      if (!posix) {
        current += "\\";
      }
      continue;
    }
    if (inQuote) {
      if (ch === inQuote) {
        if (!posix) {
          current += ch;
        }
        inQuote = null;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        if (!posix) {
          current += ch;
        }
      } else if (/\s/.test(ch)) {
        if (current.length > 0) {
          result.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    }
  }
  if (current.length > 0) {
    result.push(current);
  }
  return result;
}

export function evaluate_domain_rules(
  domain_rules: Record<string, any>,
  tool_name: string,
  args: Record<string, any>
): [boolean, string, string, string] {
  /**
   * 对子代理工具调用评估五轴域规则。
   *
   * 返回 (allowed: boolean, action: string, failure_kind: string, reason: string):
   *   - allowed: 是否放行
   *   - action: 拦截动作 ("block" 或 "fallback")
   *   - failure_kind: "command_rule_deny" | "mcp_rule_deny" | "sandbox_fail_immediately" | ...
   *   - reason: 人类可读拒绝原因
   */
  if (!domain_rules || Object.keys(domain_rules).length === 0) {
    return [true, "allow", "", ""];
  }

  const on_restrict = String(domain_rules.onRestrict || "block");
  const fs_rule = String(domain_rules.filesystem || "readWrite");
  const net_rule = String(domain_rules.network || "allow");
  const cmd_rules = domain_rules.commandRules || {};
  const mcp_rules = domain_rules.mcpRules || {};

  // 1. 文件系统轴 (filesystem)
  if (fs_rule === "none") {
    if (_FS_READ_TOOLS.has(tool_name) || _FS_WRITE_TOOLS.has(tool_name)) {
      return [
        false,
        on_restrict,
        "command_rule_deny",
        `域规则限制: 文件系统已被完全禁用 (filesystem=none，受阻工具: ${tool_name})`,
      ];
    }
  } else if (fs_rule === "readOnly") {
    if (_FS_WRITE_TOOLS.has(tool_name)) {
      return [
        false,
        on_restrict,
        "command_rule_deny",
        `域规则限制: 当前子代理仅具备只读权限，禁止写入操作 (受阻工具: ${tool_name})`,
      ];
    }
  }

  // 2. 网络轴 (network)
  if (net_rule === "deny") {
    if (_NETWORK_TOOLS.has(tool_name)) {
      return [
        false,
        on_restrict,
        "command_rule_deny",
        `域规则限制: 禁止外部网络访问 (network=deny，受阻工具: ${tool_name})`,
      ];
    }
  }

  // 3. 命令规则轴 (commandRules: shlex 分词结构匹配)
  if (_COMMAND_TOOLS.has(tool_name)) {
    const cmd_text = String(
      args.command || args.cmd || args.CommandLine || ""
    );
    if (cmd_text) {
      const segments = _split_command_pipeline(cmd_text);
      const deny_patterns = cmd_rules.deny || [];
      const allow_patterns = cmd_rules.allow || [];

      for (const seg of segments) {
        let tokens: string[] = [];
        try {
          tokens = shlexSplit(seg, false);
        } catch {
          tokens = seg.split(/\s+/).filter(Boolean);
        }
        if (!tokens.length) {
          continue;
        }

        const head = tokens[0]!.toLowerCase().replace(/^["']+|["']+$/g, "");

        // 先检查 deny 规则
        for (const pat of deny_patterns) {
          let pat_tokens: string[] = [];
          try {
            pat_tokens = shlexSplit(pat, false);
          } catch {
            pat_tokens = pat.split(/\s+/).filter(Boolean);
          }
          if (!pat_tokens.length) {
            continue;
          }
          const pat_head = pat_tokens[0]!.toLowerCase();
          if (fnmatch(head, pat_head)) {
            if (pat_tokens.length === 1) {
              return [
                false,
                on_restrict,
                "command_rule_deny",
                `域规则拒绝: 命令「${head}」匹配拒绝规则「${pat}」`,
              ];
            }
            const rest_tokens = tokens
              .slice(1)
              .map((t) => t.toLowerCase().replace(/^["']+|["']+$/g, ""));
            const pat_arg = pat_tokens[1]!.toLowerCase();
            if (rest_tokens.some((arg) => fnmatch(arg, pat_arg))) {
              return [
                false,
                on_restrict,
                "command_rule_deny",
                `域规则拒绝: 命令参数「${seg}」匹配拒绝规则「${pat}」`,
              ];
            }
          }
        }

        // 再检查 allow 规则 (如果显式指定且不为 ["*"])
        if (
          allow_patterns &&
          allow_patterns.length > 0 &&
          !(allow_patterns.length === 1 && allow_patterns[0] === "*")
        ) {
          let matched_allow = false;
          for (const pat of allow_patterns) {
            let pat_tokens: string[] = [];
            try {
              pat_tokens = shlexSplit(pat, false);
            } catch {
              pat_tokens = pat.split(/\s+/).filter(Boolean);
            }
            if (!pat_tokens.length) {
              continue;
            }
            const pat_head = pat_tokens[0]!.toLowerCase();
            if (fnmatch(head, pat_head)) {
              matched_allow = true;
              break;
            }
          }
          if (!matched_allow) {
            return [
              false,
              on_restrict,
              "command_rule_deny",
              `域规则拒绝: 命令「${head}」不在允许清单内 (allow=${JSON.stringify(allow_patterns)})`,
            ];
          }
        }
      }
    }
  }

  // 4. MCP 工具规则轴 (mcpRules)
  if (tool_name.startsWith("mcp__")) {
    const deny_mcp = mcp_rules.deny || [];
    const allow_mcp = mcp_rules.allow || [];
    for (const pat of deny_mcp) {
      if (fnmatch(tool_name, pat)) {
        return [
          false,
          on_restrict,
          "mcp_rule_deny",
          `域规则拒绝: MCP 工具「${tool_name}」匹配拒绝规则「${pat}」`,
        ];
      }
    }
    if (
      allow_mcp &&
      allow_mcp.length > 0 &&
      !(allow_mcp.length === 1 && allow_mcp[0] === "*")
    ) {
      if (!allow_mcp.some((pat: string) => fnmatch(tool_name, pat))) {
        return [
          false,
          on_restrict,
          "mcp_rule_deny",
          `域规则拒绝: MCP 工具「${tool_name}」不在允许清单内`,
        ];
      }
    }
  }

  return [true, "allow", "", ""];
}

// ── Read-only capability sets ────────────────────────────────────────────────

export const _READ_TOOLS = new Set([
  // Files and code search — file_agent.py + tools.py builtins.
  "read_text", "search_code", "find_files", "list_dir",
  "get_file_info", "diff_files",
  // Read-only git. Deliberately excludes branch/add/commit/push/pull.
  "git_status", "git_diff", "git_log",
  // Network research — search_agent.py + browser_agent's fetch.
  "web_search", "web_fetch", "academic_search", "standard_search",
  "code_search", "semantic_search", "credibility_check",
  // Self-inspection.
  "diagnose",
]);

export const PRESETS: Record<string, SubagentDef> = {
  explore: new SubagentDef({
    name: "explore",
    description:
      "Read-only codebase explorer. Use to answer 'where / how / what' " +
      "questions, locate code, or map a subsystem. Cannot modify files.",
    system_prompt:
      "You are a focused codebase exploration sub-agent . " +
      "You were spawned by a parent agent to answer specific architectural or implementation questions.\n\n" +
      "Rules & Investigation Discipline:\n" +
      "- Strictly READ-ONLY. Never attempt to write, edit, or execute commands that change state.\n" +
      "- Multi-hop exploration: Grep for symbols, trace function definitions to call sites, read enclosing files.\n" +
      "- Structure your findings cleanly: File paths with line numbers (e.g. `path/file.py:L12-34`), exact signatures, " +
      "and a concise synthesis of behavior and constraints.\n" +
      "- Your final message IS the report returned to the parent. Lead with direct answers, cite evidence, no fluff.\n",
    allowed_tools: _READ_TOOLS,
    permission: "readonly",
  }),
  planner: new SubagentDef({
    name: "planner",
    description:
      "Enhanced Read-only Software Architect & Planner . " +
      "Investigates codebase state, analyzes trade-offs, and produces a concrete step-by-step plan.",
    system_prompt:
      "You are a software architect and planning specialist (Architectural Planning Mode).\n\n" +
      "=== STRICTLY READ-ONLY PLANNING SANDBOX ===\n" +
      "You are strictly prohibited from creating, editing, or deleting any files, or running state-changing commands.\n\n" +
      "Four-Step Planning Process:\n" +
      "1. Understand Requirements: Clarify design intent and critical constraints.\n" +
      "2. Explore Thoroughly: Search codebase patterns, trace complete calling chains and dependencies, examine tests.\n" +
      "3. Design Solution: Evaluate architectural trade-offs, follow established codebase idioms, avoid premature abstractions.\n" +
      "4. Detail Implementation Strategy: Output a numbered sequence of steps, specify exact files/functions to modify/create, " +
      "identify risks/unknowns, and define automated & manual verification criteria.\n",
    allowed_tools: _READ_TOOLS,
    permission: "plan",
    handoffs: ["explore"],
  }),
  reviewer: new SubagentDef({
    name: "reviewer",
    description:
      "Industrial 10-Phase Code Review Subagent with 8 Scan Angles and 3-State Verification " +
      ".",
    system_prompt:
      "You are an industrial-grade code review specialist (Multi-Angle Code Review Pipeline).\n\n" +
      "=== READ-ONLY CODE REVIEW PROTOCOL ===\n" +
      "Scan the target diff/code through 8 comprehensive inspection angles:\n" +
      "- Angle A (Line-by-line diff scan): Check inverted conditions, off-by-one, null deref, missing await, falsey zero, wrong var copy-paste, swallowed errors in catch, unescaped regex.\n" +
      "- Angle B (Enclosing function & caller scope): Scope mismatch, signature drift, async race conditions.\n" +
      "- Angle C (Error handling & edge cases): Unhandled promises, resource leaks, broken rollbacks.\n" +
      "- Angle D (Simplification): Unnecessary wrappers, dead branches, over-defensive code inside trusted boundaries.\n" +
      "- Angle E (Reuse): Duplicate implementations that should use existing utilities.\n" +
      "- Angle F (Efficiency): Quadratic loops, redundant IO/network calls.\n" +
      "- Angle G (Architecture Altitude): Leaky abstractions, layer violations.\n" +
      "- Angle H (Conventions): Idioms, naming, type correctness.\n\n" +
      "3-State Verification Phase:\n" +
      "1. CONFIRMED — Can name exact trigger inputs/state and resulting crash or wrong output. Quote exact file:line.\n" +
      "2. PLAUSIBLE — Mechanism is real, trigger depends on timing/environment. State verification condition.\n" +
      "3. REFUTED — Factually incorrect or guarded elsewhere. Quote counter-evidence line.\n\n" +
      "ReportFindings Output Format:\n" +
      "Return verified findings ranked by severity (Critical > High > Medium > Low):\n" +
      "- [Severity] file:line — `short_summary (≤60 chars)` | Category | 3-State Verdict\n" +
      "  * Failure Scenario & Mechanism\n" +
      "  * Minimal Recommended Fix\n" +
      "If no bugs exist, state: 'CLEAN: No verified defects found.'\n",
    allowed_tools: _READ_TOOLS,
    permission: "readonly",
  }),
  coder: new SubagentDef({
    name: "coder",
    description:
      "Full implementation sub-agent with Full-Scope Delivery and Worktree Isolation " +
      ".",
    system_prompt:
      "You are an expert implementation sub-agent. Carry out your assigned task end to end.\n\n" +
      "Engineering Discipline:\n" +
      "- Delivering at full scope: Complete the entire task cleanly without leaving stubbed/half-implemented work.\n" +
      "- No compatibility hacks: Delete unused code completely; do not add _unused vars or temporary shims.\n" +
      "- No unnecessary error handling: Validate only at system boundaries; trust internal framework guarantees.\n" +
      "- Minimal abstractions: Three similar lines is better than premature abstraction. Fix bugs without unrelated refactoring.\n" +
      "- Comment WHY-only: Only write comments for non-obvious constraints.\n" +
      "- Truthful Reporting: Run tests/builds to verify your changes. If tests fail, report the exact error output.\n" +
      "- Your final message IS the report returned to the parent: list of modified files, verification outcome, and diff summary.\n",
    allowed_tools: null, // inherit full catalogue (write-capable)
    permission: "auto",
    handoffs: ["reviewer"],
  }),
  diagnostician: new SubagentDef({
    name: "diagnostician",
    description:
      "Environment & Health Doctor Subagent . " +
      "Audits environment variables, toolchains, permissions, Git health, and build prerequisites.",
    system_prompt:
      "You are a diagnostic and environment doctor sub-agent .\n\n" +
      "Diagnostic Scope:\n" +
      "1. Toolchains & Runtimes: Node, Python, Git, Rust/C++ compilers if relevant.\n" +
      "2. Project Health: Lockfiles, package dependencies, environment files, build scripts.\n" +
      "3. Workspace & Git: Dirty worktree, untracked large files, branch conflicts, permissions.\n" +
      "4. Service Health: Local backend port connectivity, database status, memory/disk headroom.\n\n" +
      "Output Format:\n" +
      "Provide a structured health report with status badges (✅ PASS / ⚠️ WARN / ❌ FAIL), exact root causes, and one-click actionable remediation commands.\n",
    allowed_tools: _READ_TOOLS,
    permission: "readonly",
  }),
  researcher: new SubagentDef({
    name: "researcher",
    description:
      "Deep technical & web research specialist. Investigates third-party libraries, APIs, " +
      "algorithms, documentation, and external technical resources.",
    system_prompt:
      "You are an expert technical and web research sub-agent.\n\n" +
      "Research Protocol:\n" +
      "- Multi-source verification: Search documentation, GitHub issues, and authoritative web sources.\n" +
      "- Extract concrete code snippets, configuration examples, and version compatibility matrices.\n" +
      "- Synthesize concise, evidence-backed answers with clickable URLs and clear recommendations.\n",
    allowed_tools: _READ_TOOLS,
    permission: "readonly",
  }),
  validator: new SubagentDef({
    name: "validator",
    description:
      "Automated test runner & quality validator. Executes test suites, reproduces bugs, " +
      "and rigorously verifies code fixes against regressions.",
    system_prompt:
      "You are an automated testing and quality verification specialist.\n\n" +
      "Verification Protocol:\n" +
      "1. Run targeted unit tests, integration tests, and linters.\n" +
      "2. If tests fail, extract exact tracebacks, failing assertions, and reproduction steps.\n" +
      "3. Verify that new patches resolve the root cause without breaking existing test suites.\n",
    allowed_tools: null,
    permission: "auto",
    handoffs: ["reviewer"],
  }),
  refactor: new SubagentDef({
    name: "refactor",
    description:
      "Code refactoring & architectural simplification specialist. Eliminates dead code, " +
      "decouples modules, and reduces technical debt while preserving behavior.",
    system_prompt:
      "You are a senior refactoring and code architecture specialist.\n\n" +
      "Refactoring Principles:\n" +
      "- Behavior preservation: Ensure all public APIs and invariants remain unchanged.\n" +
      "- Simplify relentlessly: Remove duplicate logic, dead branches, and unnecessary layers.\n" +
      "- Decouple cleanly: Reduce tight coupling between modules and improve testability.\n" +
      "- Verify with tests after every incremental change.\n",
    allowed_tools: null,
    permission: "auto",
    handoffs: ["validator", "reviewer"],
  }),
  docwriter: new SubagentDef({
    name: "docwriter",
    description:
      "Technical documentation & architecture writer. Produces high-quality Markdown docs, " +
      "API references, setup guides, architecture diagrams, and release notes.",
    system_prompt:
      "You are an expert technical documentation writer.\n\n" +
      "Documentation Standards:\n" +
      "- Inspect actual implementation code before writing to ensure 100% factual accuracy.\n" +
      "- Produce clear, readable Markdown with formatted tables, code blocks, and Mermaid diagrams.\n" +
      "- Structure content logically: Overview, Prerequisites, Quick Start, API Reference, and FAQ.\n",
    allowed_tools: null,
    permission: "auto",
  }),
  memory_curator: new SubagentDef({
    name: "memory_curator",
    description:
      "Knowledge & memory consolidation specialist. Extracts durable rules, user habits, " +
      "and architectural conventions from session history into structured long-term memory.",
    system_prompt:
      "You are a knowledge consolidation and memory curator sub-agent.\n\n" +
      "Curation Scope:\n" +
      "- Scan interaction logs and tool outcomes for recurring preferences and pitfalls.\n" +
      "- Distill concise, actionable rules into structured memory proposals.\n" +
      "- Avoid noise: only promote high-confidence, reusable patterns.\n",
    allowed_tools: _READ_TOOLS,
    permission: "readonly",
  }),
  debugger: new SubagentDef({
    name: "debugger",
    description:
      "Systematic debugging specialist . " +
      "Forms falsifiable hypotheses, adds minimal probe instrumentation, " +
      "collects runtime evidence, and validates root causes without guessing.",
    system_prompt:
      "You are a systematic debugging specialist.\n\n" +
      "Scientific Debugging Protocol:\n" +
      "1. Problem Formulation: Understand symptoms, expected vs actual behavior, and environment.\n" +
      "2. Falsifiable Hypotheses: Propose explicit, testable hypotheses for root cause.\n" +
      "3. Minimal Instrumentation: Inject targeted temporary logging/probes to capture runtime execution trace.\n" +
      "4. Evidence Collection: Run reproducing tests and gather physical evidence.\n" +
      "5. Root-Cause Patching: Fix the verified bug and clean up all instrumentation.\n" +
      "6. Regression Verification: Run full test suite to guarantee 100% green status.\n",
    allowed_tools: null,
    permission: "auto",
    handoffs: ["validator", "reviewer"],
  }),
  security_auditor: new SubagentDef({
    name: "security_auditor",
    description:
      "Security vulnerability & prompt injection auditor. Audits codebase for " +
      "credential leakage, injection flaws, SSRF, path traversal, and distillation risks.",
    system_prompt:
      "You are an industrial cybersecurity and prompt security auditor.\n\n" +
      "Audit Checkpoints:\n" +
      "1. Secrets & Credentials: Hardcoded API keys, tokens, passwords, or internal endpoints.\n" +
      "2. Code Vulnerabilities: SQL injection, SSRF, command injection, path traversal, unescaped regex.\n" +
      "3. Prompt Security: System prompt exfiltration risks, user prompt injection vectors.\n" +
      "4. Anti-Distillation: Proprietary logic leaks and confidential telemetry exposure.\n\n" +
      "Report Format: Return vulnerabilities sorted by CVSS severity with minimal remediation code.\n",
    allowed_tools: _READ_TOOLS,
    permission: "readonly",
  }),
  readonly_researcher: new SubagentDef({
    name: "readonly_researcher",
    description: "只读研究员，仅允许读取文件与网络，禁止所有写入与修改命令",
    system_prompt:
      "You are a read-only researcher subagent.\n\n" +
      "Domain Constraints:\n" +
      "- Filesystem: Strictly read-only. Modifying or writing any file is forbidden.\n" +
      "- Network: Allowed for documentation and web research.\n" +
      "- Commands: Read-only inspection commands only (e.g. git status, git log, grep, ls, dir).\n",
    allowed_tools: _READ_TOOLS,
    permission: "readonly",
    domain_rules: {
      filesystem: "readOnly",
      network: "allow",
      commandRules: {
        allow: ["git status*", "git log*", "grep*", "ls*", "dir*"],
        deny: ["rm*", "git commit*", "git push*", "git reset*"],
      },
      mcpRules: { allow: ["*"], deny: [] },
      onRestrict: "fallback",
    },
    mcp_tool_cap: 24,
  }),
  fs_writer: new SubagentDef({
    name: "fs_writer",
    description: "文件写作者，允许读写文件但禁止网络外联",
    system_prompt:
      "You are a filesystem writer subagent.\n\n" +
      "Domain Constraints:\n" +
      "- Filesystem: Full read/write within workspace bounds.\n" +
      "- Network: Strictly denied. No external HTTP requests, curls or sockets.\n",
    allowed_tools: null,
    permission: "auto",
    domain_rules: {
      filesystem: "readWrite",
      network: "deny",
      commandRules: {
        allow: ["*"],
        deny: ["curl*", "wget*", "ssh*", "nc*", "telnet*", "ping*"],
      },
      mcpRules: { allow: ["*"], deny: [] },
      onRestrict: "block",
    },
    mcp_tool_cap: 24,
  }),
  full_operator: new SubagentDef({
    name: "full_operator",
    description: "全权执行者，具备完整文件读写与网络权限",
    system_prompt:
      "You are a full operator subagent with full filesystem and network capabilities within workspace bounds.",
    allowed_tools: null,
    permission: "auto",
    domain_rules: {
      filesystem: "readWrite",
      network: "allow",
      commandRules: { allow: ["*"], deny: [] },
      mcpRules: { allow: ["*"], deny: [] },
      onRestrict: "block",
    },
    mcp_tool_cap: 24,
  }),
};

export function _legacy_mode_permission(d: Record<string, any>): string | null {
  /**
   * Map an old-scheme `mode:` field onto the single permission axis.
   * `plan` keeps its own level; `ask` becomes `readonly`.
   */
  const m = String(d.mode || "").trim().toLowerCase();
  if (m === "plan") return "plan";
  if (m === "ask") return "readonly";
  return null;
}

export function _parse_yaml_def(filePath: string): SubagentDef | null {
  /** Parse ONE sub-agent YAML file into a def, or null if unusable. */
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const d = (SUBAGENT_REGISTRY_SEAMS.parse_yaml(raw) as Record<string, any>) || {};
    const baseStem = path.basename(filePath, path.extname(filePath));
    const name = String(d.name || baseStem).trim();
    if (!name || !d.system_prompt) {
      return null;
    }
    const tools = d.allowed_tools || d.allowedTools;
    const raw_handoffs = d.handoffs || [];
    return new SubagentDef({
      name: name,
      description: String(d.description || ""),
      system_prompt: String(d.system_prompt),
      allowed_tools: Array.isArray(tools) ? new Set(tools) : null,
      permission: String(d.permission || _legacy_mode_permission(d) || "auto"),
      model: d.model || null,
      model_policy: String(d.model_policy || d.modelPolicy || "auto").trim().toLowerCase(),
      max_turns: d.max_turns !== undefined && d.max_turns !== null ? parseInt(d.max_turns, 10) : (d.maxTurns !== undefined && d.maxTurns !== null ? parseInt(d.maxTurns, 10) : null),
      handoffs: Array.isArray(raw_handoffs) ? raw_handoffs.map((h: any) => String(h)) : [],
      auto_respawn: Boolean(d.auto_respawn || d.autoRespawn),
      exec_mode: String(d.exec_mode || d.execMode || "inprocess").trim().toLowerCase(),
      domain_rules: d.domain_rules || d.domainRules || {},
      mcp_tool_cap: parseInt(d.mcp_tool_cap || d.mcpToolCap || "24", 10),
    });
  } catch {
    return null;
  }
}

export function _load_yaml_defs_from_files(paths: string[]): Record<string, SubagentDef> {
  /** Parse a list of YAML file paths into defs, skipping any that fail. */
  const out: Record<string, SubagentDef> = {};
  for (const p of paths) {
    const d = _parse_yaml_def(p);
    if (d !== null) {
      out[d.name] = d;
    }
  }
  return out;
}

export function _load_yaml_defs(subagents_dir: string): Record<string, SubagentDef> {
  /** Load user-authored sub-agent YAML files from a directory. Best-effort. */
  try {
    if (!fs.existsSync(subagents_dir) || !fs.statSync(subagents_dir).isDirectory()) {
      return {};
    }
    const paths = fs
      .readdirSync(subagents_dir)
      .filter((fn) => fn.endsWith(".yaml") || fn.endsWith(".yml"))
      .map((fn) => path.join(subagents_dir, fn));
    return _load_yaml_defs_from_files(paths);
  } catch {
    return {};
  }
}

let _REGISTRY: Record<string, SubagentDef> | null = null;

export const SUBAGENT_REGISTRY_SEAMS = {
  get_tool_registry: get_tool_registry,
  subagents_dir: () => path.join(__dirname, "subagents"),
  parse_yaml: (content: string) => loadSimpleYaml(content),
};

export function reload_subagent_defs(): void {
  /** Drop cached registry so next read re-scans YAML dir. */
  _REGISTRY = null;
}

export function get_subagent_registry(): Record<string, SubagentDef> {
  /** Presets overlaid with user YAML (user wins on name collision). */
  if (_REGISTRY === null) {
    const merged: Record<string, SubagentDef> = { ...PRESETS };
    try {
      const dir = SUBAGENT_REGISTRY_SEAMS.subagents_dir();
      Object.assign(merged, _load_yaml_defs(dir));
    } catch {
      // ignore
    }
    _REGISTRY = merged;
  }
  return _REGISTRY;
}

export function get_subagent(name: string): SubagentDef | null {
  return get_subagent_registry()[name] || null;
}

export function register_subagent_def(
  definition: SubagentDef,
  opts?: { overwrite?: boolean }
): boolean {
  /** Inject definition into live registry. Refuses to clobber unless overwrite is true. */
  const registry = get_subagent_registry();
  if (definition.name in registry && !opts?.overwrite) {
    return false;
  }
  registry[definition.name] = definition;
  return true;
}

export function unregister_subagent_def(name: string): boolean {
  /** Remove a definition, but never a built-in preset. */
  if (name in PRESETS) {
    return false;
  }
  const registry = get_subagent_registry();
  if (name in registry) {
    delete registry[name];
    return true;
  }
  return false;
}

export function load_subagent_file(p: string): SubagentDef | null {
  /** Parse one sub-agent YAML file. Returns null if not usable. */
  const defs = _load_yaml_defs_from_files([p]);
  const values = Object.values(defs);
  return values.length > 0 ? values[0]! : null;
}

export function audit_allowed_tools(
  registry?: Record<string, SubagentDef> | null
): Record<string, string[]> {
  /**
   * Report persona allowlist entries that match no registered tool.
   * Returns { [persona_name]: [unknown_tool, ...] } - empty dict means clean.
   */
  const out: Record<string, string[]> = {};
  let known: Set<string>;
  try {
    const reg = SUBAGENT_REGISTRY_SEAMS.get_tool_registry();
    known = new Set((reg.list_tools() || []).map((t: any) => t.name));
  } catch {
    return out;
  }
  if (!known || known.size === 0) {
    return out;
  }
  const target = registry || get_subagent_registry();
  for (const [name, def] of Object.entries(target)) {
    const allowed = def.allowed_tools;
    if (!allowed) {
      continue;
    }
    const missing: string[] = [];
    for (const t of allowed) {
      if (!known.has(t)) {
        missing.push(t);
      }
    }
    if (missing.length > 0) {
      out[name] = missing.sort();
    }
  }
  return out;
}

export function warn_on_unknown_allowed_tools(): void {
  /** Print audit result. Call once after tool registration. */
  for (const [persona, missing] of Object.entries(audit_allowed_tools())) {
    console.warn(
      `[subagents] persona '${persona}' allows tools that are not ` +
        `registered and will therefore be hidden from it: ` +
        missing.join(", ")
    );
  }
}

export function list_subagents(): Array<Record<string, any>> {
  return Object.values(get_subagent_registry()).map((d) => d.to_public());
}
