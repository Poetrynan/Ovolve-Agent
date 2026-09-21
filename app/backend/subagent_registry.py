"""
subagent_registry.py — definitions for the sub-agent types the ``task`` tool
can spawn.

A sub-agent type is a persona + a capability boundary:
  - ``system_prompt``   who it is and how it should behave / what to return
  - ``allowed_tools``   the ONLY tools it may call (None = inherit everything)
  - ``permission``      ``risk_control.PermissionMode`` value — ``readonly``/``plan`` lock writes
  - ``model``           optional model override (None = inherit parent's)
  - ``handoffs``        which other personas it may pass the task on to


Definitions come from two places, merged with user files winning:
  1. Built-in presets below (always available).
  2. ``app/backend/subagents/*.yaml`` on disk (optional, user-authored),
     reusing the SKILL.md-style YAML-frontmatter convention already used by
     the skill loader — a sub-agent is really just a skill that happens to run
     as its own turn.

Kept deliberately small: the registry is data, not behavior. The runtime
(subagent_runtime.py) is what actually spawns a Router from one of these.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Optional, Any


@dataclass
class HandoffEnvelope:
    """子代理任务委派上下文信封"""
    subagent_type: str
    task: str
    parent_session_id: str
    context_refs: list[str] = field(default_factory=list)
    memory_refs: list[str] = field(default_factory=list)
    target_paths: list[str] = field(default_factory=list)
    depth: int = 0


@dataclass
class ResultContract:
    """子代理交付契约"""
    status: str = "ok"  # "ok" | "error" | "refused"
    summary: str = ""
    findings: list[dict] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    raw_output: str = ""


@dataclass
class SubagentDef:
    name: str
    description: str
    system_prompt: str
    # None → inherit the full tool catalogue. A set → allowlist (defense in
    # depth: the runtime both hides non-allowed tools from the LLM and blocks
    # them at dispatch).
    allowed_tools: Optional[frozenset] = None
    permission: str = "auto"     # risk_control.PermissionMode value
    model: Optional[str] = None  # provider:model_id override, or None
    #: ``main`` → follow parent model; ``economy`` → follow Settings light model.
    #: Ignored when ``model`` is set. Default ``main``.
    #: F3/F5 模型策略：``auto``（默认，未显式选择 → 走 ROLE_PRESETS 的 model_role
    # 自动档位）/ ``main``（显式主档）/ ``economy``（显式经济档）。UI 选择器写
    # main/economy；默认 auto 保住 explore/researcher 自动走 lite 的成本优化。
    model_policy: str = "auto"
    #: Max agent-loop steps for this persona. An explorer needs many search
    #: rounds; a reviewer reads once and concludes. None → Router default.
    max_turns: Optional[int] = None
    #: Personas this one may hand the task onward to. Empty (the default) means
    #: it is a leaf: it must finish the job itself.
    handoffs: frozenset = frozenset()
    memory_policy: str = "task_refs_only"
    skill_policy: str = "explicit_refs_only"
    isolation: str = "worktree_or_overlay"
    result_schema: str = "ResultContract.v1"
    #: F6 respawn 门控：True 时该 persona 的确定性失败（如 validator 判失败）
    # 可由框架自动重跑一次（与空交付重试共享单次上限）。默认关——自动复活
    # 只属于显式声明可重跑的角色，否则失败就是失败，父 Agent 应该自己决定。
    auto_respawn: bool = False
    #: F5 执行模式：``inprocess``（默认）或 ``subprocess``（独立 worker 进程）。
    exec_mode: str = "inprocess"
    #: P3-2: 五轴域规则 (filesystem, network, commandRules, mcpRules, onRestrict)
    domain_rules: dict[str, Any] = field(default_factory=dict)
    #: P3-2: 单子代理 MCP 工具数硬顶 (默认 24)
    mcp_tool_cap: int = 24

    def to_public(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "allowedTools": sorted(self.allowed_tools) if self.allowed_tools else None,
            "permission": self.permission,
            "model": self.model,
            "modelPolicy": self.model_policy or "auto",
            "maxTurns": self.max_turns,
            "handoffs": sorted(self.handoffs),
            "memoryPolicy": self.memory_policy,
            "skillPolicy": self.skill_policy,
            "isolation": self.isolation,
            "resultSchema": self.result_schema,
            "autoRespawn": self.auto_respawn,
            "execMode": self.exec_mode,
            "domainRules": self.domain_rules,
            "mcpToolCap": self.mcp_tool_cap,
        }


# ── 五轴域规则评估引擎 (P3-2) ──────────────────────────────────────────────
import fnmatch
import shlex

_FS_WRITE_TOOLS = frozenset({
    "write_file", "edit_file", "write_to_file", "replace_file_content",
    "create_file", "delete_file", "touch", "patch", "apply_patch",
})
_FS_READ_TOOLS = frozenset({
    "read_text", "search_code", "find_files", "list_dir", "get_file_info",
    "diff_files", "view_file", "grep_search", "find_by_name",
})
_NETWORK_TOOLS = frozenset({
    "web_search", "web_fetch", "academic_search", "standard_search",
    "browser_open", "http_request", "read_url_content", "search_web",
})
_COMMAND_TOOLS = frozenset({
    "run_command", "shell_executor", "terminal", "bash", "cmd", "exec", "powershell",
})


def _split_command_pipeline(cmd_line: str) -> list[str]:
    """把复合命令按分号、管道与逻辑操作符拆分成独立命令单元。"""
    parts = re.split(r"[;\n|&]+", cmd_line)
    return [p.strip() for p in parts if p.strip()]


def evaluate_domain_rules(domain_rules: dict, tool_name: str, args: dict) -> tuple[bool, str, str, str]:
    """对子代理工具调用评估五轴域规则。

    返回 (allowed: bool, action: str, failure_kind: str, reason: str):
      - allowed: 是否放行
      - action: 拦截动作 ("block" 或 "fallback")
      - failure_kind: "command_rule_deny" | "mcp_rule_deny" | "sandbox_fail_immediately" | ...
      - reason: 人类可读拒绝原因
    """
    if not domain_rules:
        return True, "allow", "", ""

    on_restrict = domain_rules.get("onRestrict", "block")
    fs_rule = domain_rules.get("filesystem", "readWrite")
    net_rule = domain_rules.get("network", "allow")
    cmd_rules = domain_rules.get("commandRules", {})
    mcp_rules = domain_rules.get("mcpRules", {})

    # 1. 文件系统轴 (filesystem)
    if fs_rule == "none":
        if tool_name in _FS_READ_TOOLS or tool_name in _FS_WRITE_TOOLS:
            return False, on_restrict, "command_rule_deny", f"域规则限制: 文件系统已被完全禁用 (filesystem=none，受阻工具: {tool_name})"
    elif fs_rule == "readOnly":
        if tool_name in _FS_WRITE_TOOLS:
            return False, on_restrict, "command_rule_deny", f"域规则限制: 当前子代理仅具备只读权限，禁止写入操作 (受阻工具: {tool_name})"

    # 2. 网络轴 (network)
    if net_rule == "deny":
        if tool_name in _NETWORK_TOOLS:
            return False, on_restrict, "command_rule_deny", f"域规则限制: 禁止外部网络访问 (network=deny，受阻工具: {tool_name})"

    # 3. 命令规则轴 (commandRules: shlex 分词结构匹配)
    if tool_name in _COMMAND_TOOLS:
        cmd_text = str(args.get("command") or args.get("cmd") or args.get("CommandLine") or "")
        if cmd_text:
            segments = _split_command_pipeline(cmd_text)
            deny_patterns = cmd_rules.get("deny", [])
            allow_patterns = cmd_rules.get("allow", [])

            for seg in segments:
                try:
                    tokens = shlex.split(seg, posix=False)
                except Exception:
                    tokens = seg.split()
                if not tokens:
                    continue

                head = tokens[0].lower().strip("\"'")
                # 先检查 deny 规则
                for pat in deny_patterns:
                    try:
                        pat_tokens = shlex.split(pat, posix=False)
                    except Exception:
                        pat_tokens = pat.split()
                    if not pat_tokens:
                        continue
                    pat_head = pat_tokens[0].lower()
                    if fnmatch.fnmatch(head, pat_head):
                        if len(pat_tokens) == 1:
                            return False, on_restrict, "command_rule_deny", f"域规则拒绝: 命令「{head}」匹配拒绝规则「{pat}」"
                        rest_tokens = [t.lower().strip("\"'") for t in tokens[1:]]
                        pat_arg = pat_tokens[1].lower()
                        if any(fnmatch.fnmatch(arg, pat_arg) for arg in rest_tokens):
                            return False, on_restrict, "command_rule_deny", f"域规则拒绝: 命令参数「{seg}」匹配拒绝规则「{pat}」"

                # 再检查 allow 规则 (如果显式指定且不为 ["*"])
                if allow_patterns and allow_patterns != ["*"]:
                    matched_allow = False
                    for pat in allow_patterns:
                        try:
                            pat_tokens = shlex.split(pat, posix=False)
                        except Exception:
                            pat_tokens = pat.split()
                        if not pat_tokens:
                            continue
                        pat_head = pat_tokens[0].lower()
                        if fnmatch.fnmatch(head, pat_head):
                            matched_allow = True
                            break
                    if not matched_allow:
                        return False, on_restrict, "command_rule_deny", f"域规则拒绝: 命令「{head}」不在允许清单内 (allow={allow_patterns})"

    # 4. MCP 工具规则轴 (mcpRules)
    if tool_name.startswith("mcp__"):
        deny_mcp = mcp_rules.get("deny", [])
        allow_mcp = mcp_rules.get("allow", [])
        for pat in deny_mcp:
            if fnmatch.fnmatch(tool_name, pat):
                return False, on_restrict, "mcp_rule_deny", f"域规则拒绝: MCP 工具「{tool_name}」匹配拒绝规则「{pat}」"
        if allow_mcp and allow_mcp != ["*"]:
            if not any(fnmatch.fnmatch(tool_name, pat) for pat in allow_mcp):
                return False, on_restrict, "mcp_rule_deny", f"域规则拒绝: MCP 工具「{tool_name}」不在允许清单内"

    return True, "allow", "", ""


# ── Read-only capability sets ────────────────────────────────────────────────
# Tool names must match what's registered in the ToolRegistry **verbatim**. This
# is not a wish-list: `_tool_specs_for` inverts the allowlist into an exclude
# set, so a name that no tool actually has doesn't fail loudly — it just means
# the real tool gets hidden. A typo here silently blinds a whole persona, which
# is exactly what happened when this set said `read_file`/`glob`/`grep`/`search`
# (none of which are registered) and the read-only personas were left with only
# `list_dir` and the web tools. `audit_allowed_tools()` below now catches that.
_READ_TOOLS = frozenset({
    # Files and code search — file_agent.py + tools.py builtins.
    "read_text", "search_code", "find_files", "list_dir",
    "get_file_info", "diff_files",
    # Read-only git. Deliberately excludes branch/add/commit/push/pull.
    "git_status", "git_diff", "git_log",
    # Network research — search_agent.py + browser_agent's fetch.
    "web_search", "web_fetch", "academic_search", "standard_search",
    "code_search", "semantic_search", "credibility_check",
    # Self-inspection.
    "diagnose",
})


PRESETS: dict[str, SubagentDef] = {
    "explore": SubagentDef(
        name="explore",
        description=(
            "Read-only codebase explorer. Use to answer 'where / how / what' "
            "questions, locate code, or map a subsystem. Cannot modify files."
        ),
        system_prompt=(
            "You are a focused codebase exploration sub-agent . "
            "You were spawned by a parent agent to answer specific architectural or implementation questions.\n\n"
            "Rules & Investigation Discipline:\n"
            "- Strictly READ-ONLY. Never attempt to write, edit, or execute commands that change state.\n"
            "- Multi-hop exploration: Grep for symbols, trace function definitions to call sites, read enclosing files.\n"
            "- Structure your findings cleanly: File paths with line numbers (e.g. `path/file.py:L12-34`), exact signatures, "
            "and a concise synthesis of behavior and constraints.\n"
            "- Your final message IS the report returned to the parent. Lead with direct answers, cite evidence, no fluff.\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="readonly",
    ),
    "planner": SubagentDef(
        name="planner",
        description=(
            "Enhanced Read-only Software Architect & Planner . "
            "Investigates codebase state, analyzes trade-offs, and produces a concrete step-by-step plan."
        ),
        system_prompt=(
            "You are a software architect and planning specialist (Architectural Planning Mode).\n\n"
            "=== STRICTLY READ-ONLY PLANNING SANDBOX ===\n"
            "You are strictly prohibited from creating, editing, or deleting any files, or running state-changing commands.\n\n"
            "Four-Step Planning Process:\n"
            "1. Understand Requirements: Clarify design intent and critical constraints.\n"
            "2. Explore Thoroughly: Search codebase patterns, trace complete calling chains and dependencies, examine tests.\n"
            "3. Design Solution: Evaluate architectural trade-offs, follow established codebase idioms, avoid premature abstractions.\n"
            "4. Detail Implementation Strategy: Output a numbered sequence of steps, specify exact files/functions to modify/create, "
            "identify risks/unknowns, and define automated & manual verification criteria.\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="plan",
        handoffs=frozenset({"explore"}),
    ),
    "reviewer": SubagentDef(
        name="reviewer",
        description=(
            "Industrial 10-Phase Code Review Subagent with 8 Scan Angles and 3-State Verification "
            "."
        ),
        system_prompt=(
            "You are an industrial-grade code review specialist (Multi-Angle Code Review Pipeline).\n\n"
            "=== READ-ONLY CODE REVIEW PROTOCOL ===\n"
            "Scan the target diff/code through 8 comprehensive inspection angles:\n"
            "- Angle A (Line-by-line diff scan): Check inverted conditions, off-by-one, null deref, missing await, falsey zero, wrong var copy-paste, swallowed errors in catch, unescaped regex.\n"
            "- Angle B (Enclosing function & caller scope): Scope mismatch, signature drift, async race conditions.\n"
            "- Angle C (Error handling & edge cases): Unhandled promises, resource leaks, broken rollbacks.\n"
            "- Angle D (Simplification): Unnecessary wrappers, dead branches, over-defensive code inside trusted boundaries.\n"
            "- Angle E (Reuse): Duplicate implementations that should use existing utilities.\n"
            "- Angle F (Efficiency): Quadratic loops, redundant IO/network calls.\n"
            "- Angle G (Architecture Altitude): Leaky abstractions, layer violations.\n"
            "- Angle H (Conventions): Idioms, naming, type correctness.\n\n"
            "3-State Verification Phase:\n"
            "1. CONFIRMED — Can name exact trigger inputs/state and resulting crash or wrong output. Quote exact file:line.\n"
            "2. PLAUSIBLE — Mechanism is real, trigger depends on timing/environment. State verification condition.\n"
            "3. REFUTED — Factually incorrect or guarded elsewhere. Quote counter-evidence line.\n\n"
            "ReportFindings Output Format:\n"
            "Return verified findings ranked by severity (Critical > High > Medium > Low):\n"
            "- [Severity] file:line — `short_summary (≤60 chars)` | Category | 3-State Verdict\n"
            "  * Failure Scenario & Mechanism\n"
            "  * Minimal Recommended Fix\n"
            "If no bugs exist, state: 'CLEAN: No verified defects found.'\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="readonly",
    ),
    "coder": SubagentDef(
        name="coder",
        description=(
            "Full implementation sub-agent with Full-Scope Delivery and Worktree Isolation "
            "."
        ),
        system_prompt=(
            "You are an expert implementation sub-agent. Carry out your assigned task end to end.\n\n"
            "Engineering Discipline:\n"
            "- Delivering at full scope: Complete the entire task cleanly without leaving stubbed/half-implemented work.\n"
            "- No compatibility hacks: Delete unused code completely; do not add _unused vars or temporary shims.\n"
            "- No unnecessary error handling: Validate only at system boundaries; trust internal framework guarantees.\n"
            "- Minimal abstractions: Three similar lines is better than premature abstraction. Fix bugs without unrelated refactoring.\n"
            "- Comment WHY-only: Only write comments for non-obvious constraints.\n"
            "- Truthful Reporting: Run tests/builds to verify your changes. If tests fail, report the exact error output.\n"
            "- Your final message IS the report returned to the parent: list of modified files, verification outcome, and diff summary.\n"
        ),
        allowed_tools=None,  # inherit full catalogue (write-capable)
        permission="auto",
        handoffs=frozenset({"reviewer"}),
    ),
    "diagnostician": SubagentDef(
        name="diagnostician",
        description=(
            "Environment & Health Doctor Subagent . "
            "Audits environment variables, toolchains, permissions, Git health, and build prerequisites."
        ),
        system_prompt=(
            "You are a diagnostic and environment doctor sub-agent .\n\n"
            "Diagnostic Scope:\n"
            "1. Toolchains & Runtimes: Node, Python, Git, Rust/C++ compilers if relevant.\n"
            "2. Project Health: Lockfiles, package dependencies, environment files, build scripts.\n"
            "3. Workspace & Git: Dirty worktree, untracked large files, branch conflicts, permissions.\n"
            "4. Service Health: Local backend port connectivity, database status, memory/disk headroom.\n\n"
            "Output Format:\n"
            "Provide a structured health report with status badges (✅ PASS / ⚠️ WARN / ❌ FAIL), exact root causes, and one-click actionable remediation commands.\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="readonly",
    ),
    "researcher": SubagentDef(
        name="researcher",
        description=(
            "Deep technical & web research specialist. Investigates third-party libraries, APIs, "
            "algorithms, documentation, and external technical resources."
        ),
        system_prompt=(
            "You are an expert technical and web research sub-agent.\n\n"
            "Research Protocol:\n"
            "- Multi-source verification: Search documentation, GitHub issues, and authoritative web sources.\n"
            "- Extract concrete code snippets, configuration examples, and version compatibility matrices.\n"
            "- Synthesize concise, evidence-backed answers with clickable URLs and clear recommendations.\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="readonly",
    ),
    "validator": SubagentDef(
        name="validator",
        description=(
            "Automated test runner & quality validator. Executes test suites, reproduces bugs, "
            "and rigorously verifies code fixes against regressions."
        ),
        system_prompt=(
            "You are an automated testing and quality verification specialist.\n\n"
            "Verification Protocol:\n"
            "1. Run targeted unit tests, integration tests, and linters.\n"
            "2. If tests fail, extract exact tracebacks, failing assertions, and reproduction steps.\n"
            "3. Verify that new patches resolve the root cause without breaking existing test suites.\n"
        ),
        allowed_tools=None,
        permission="auto",
        handoffs=frozenset({"reviewer"}),
    ),
    "refactor": SubagentDef(
        name="refactor",
        description=(
            "Code refactoring & architectural simplification specialist. Eliminates dead code, "
            "decouples modules, and reduces technical debt while preserving behavior."
        ),
        system_prompt=(
            "You are a senior refactoring and code architecture specialist.\n\n"
            "Refactoring Principles:\n"
            "- Behavior preservation: Ensure all public APIs and invariants remain unchanged.\n"
            "- Simplify relentlessly: Remove duplicate logic, dead branches, and unnecessary layers.\n"
            "- Decouple cleanly: Reduce tight coupling between modules and improve testability.\n"
            "- Verify with tests after every incremental change.\n"
        ),
        allowed_tools=None,
        permission="auto",
        handoffs=frozenset({"validator", "reviewer"}),
    ),
    "docwriter": SubagentDef(
        name="docwriter",
        description=(
            "Technical documentation & architecture writer. Produces high-quality Markdown docs, "
            "API references, setup guides, architecture diagrams, and release notes."
        ),
        system_prompt=(
            "You are an expert technical documentation writer.\n\n"
            "Documentation Standards:\n"
            "- Inspect actual implementation code before writing to ensure 100% factual accuracy.\n"
            "- Produce clear, readable Markdown with formatted tables, code blocks, and Mermaid diagrams.\n"
            "- Structure content logically: Overview, Prerequisites, Quick Start, API Reference, and FAQ.\n"
        ),
        allowed_tools=None,
        permission="auto",
    ),
    "memory_curator": SubagentDef(
        name="memory_curator",
        description=(
            "Knowledge & memory consolidation specialist. Extracts durable rules, user habits, "
            "and architectural conventions from session history into structured long-term memory."
        ),
        system_prompt=(
            "You are a knowledge consolidation and memory curator sub-agent.\n\n"
            "Curation Scope:\n"
            "- Scan interaction logs and tool outcomes for recurring preferences and pitfalls.\n"
            "- Distill concise, actionable rules into structured memory proposals.\n"
            "- Avoid noise: only promote high-confidence, reusable patterns.\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="readonly",
    ),
    "debugger": SubagentDef(
        name="debugger",
        description=(
            "Systematic debugging specialist . "
            "Forms falsifiable hypotheses, adds minimal probe instrumentation, "
            "collects runtime evidence, and validates root causes without guessing."
        ),
        system_prompt=(
            "You are a systematic debugging specialist.\n\n"
            "Scientific Debugging Protocol:\n"
            "1. Problem Formulation: Understand symptoms, expected vs actual behavior, and environment.\n"
            "2. Falsifiable Hypotheses: Propose explicit, testable hypotheses for root cause.\n"
            "3. Minimal Instrumentation: Inject targeted temporary logging/probes to capture runtime execution trace.\n"
            "4. Evidence Collection: Run reproducing tests and gather physical evidence.\n"
            "5. Root-Cause Patching: Fix the verified bug and clean up all instrumentation.\n"
            "6. Regression Verification: Run full test suite to guarantee 100% green status.\n"
        ),
        allowed_tools=None,
        permission="auto",
        handoffs=frozenset({"validator", "reviewer"}),
    ),
    "security_auditor": SubagentDef(
        name="security_auditor",
        description=(
            "Security vulnerability & prompt injection auditor. Audits codebase for "
            "credential leakage, injection flaws, SSRF, path traversal, and distillation risks."
        ),
        system_prompt=(
            "You are an industrial cybersecurity and prompt security auditor.\n\n"
            "Audit Checkpoints:\n"
            "1. Secrets & Credentials: Hardcoded API keys, tokens, passwords, or internal endpoints.\n"
            "2. Code Vulnerabilities: SQL injection, SSRF, command injection, path traversal, unescaped regex.\n"
            "3. Prompt Security: System prompt exfiltration risks, user prompt injection vectors.\n"
            "4. Anti-Distillation: Proprietary logic leaks and confidential telemetry exposure.\n\n"
            "Report Format: Return vulnerabilities sorted by CVSS severity with minimal remediation code.\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="readonly",
    ),
    "readonly_researcher": SubagentDef(
        name="readonly_researcher",
        description="只读研究员，仅允许读取文件与网络，禁止所有写入与修改命令",
        system_prompt=(
            "You are a read-only researcher subagent.\n\n"
            "Domain Constraints:\n"
            "- Filesystem: Strictly read-only. Modifying or writing any file is forbidden.\n"
            "- Network: Allowed for documentation and web research.\n"
            "- Commands: Read-only inspection commands only (e.g. git status, git log, grep, ls, dir).\n"
        ),
        allowed_tools=_READ_TOOLS,
        permission="readonly",
        domain_rules={
            "filesystem": "readOnly",
            "network": "allow",
            "commandRules": {
                "allow": ["git status*", "git log*", "grep*", "ls*", "dir*"],
                "deny": ["rm*", "git commit*", "git push*", "git reset*"],
            },
            "mcpRules": {"allow": ["*"], "deny": []},
            "onRestrict": "fallback",
        },
        mcp_tool_cap=24,
    ),
    "fs_writer": SubagentDef(
        name="fs_writer",
        description="文件写作者，允许读写文件但禁止网络外联",
        system_prompt=(
            "You are a filesystem writer subagent.\n\n"
            "Domain Constraints:\n"
            "- Filesystem: Full read/write within workspace bounds.\n"
            "- Network: Strictly denied. No external HTTP requests, curls or sockets.\n"
        ),
        allowed_tools=None,
        permission="auto",
        domain_rules={
            "filesystem": "readWrite",
            "network": "deny",
            "commandRules": {
                "allow": ["*"],
                "deny": ["curl*", "wget*", "ssh*", "nc*", "telnet*", "ping*"],
            },
            "mcpRules": {"allow": ["*"], "deny": []},
            "onRestrict": "block",
        },
        mcp_tool_cap=24,
    ),
    "full_operator": SubagentDef(
        name="full_operator",
        description="全权执行者，具备完整文件读写与网络权限",
        system_prompt=(
            "You are a full operator subagent with full filesystem and network capabilities within workspace bounds."
        ),
        allowed_tools=None,
        permission="auto",
        domain_rules={
            "filesystem": "readWrite",
            "network": "allow",
            "commandRules": {"allow": ["*"], "deny": []},
            "mcpRules": {"allow": ["*"], "deny": []},
            "onRestrict": "block",
        },
        mcp_tool_cap=24,
    ),
}


def _legacy_mode_permission(d: dict) -> Optional[str]:
    """Map an old-scheme ``mode:`` field onto the single permission axis.

    The mode axis was removed, but user-authored YAML personas may predate that.
    ``plan`` keeps its own level; the other read-only mode (``ask``) becomes
    ``readonly``; writable modes have no read-only intent to preserve.
    """
    m = str(d.get("mode") or "").strip().lower()
    return {"plan": "plan", "ask": "readonly"}.get(m)


def _parse_yaml_def(path: str) -> Optional[SubagentDef]:
    """Parse ONE sub-agent YAML file into a def, or None if unusable."""
    try:
        import yaml  # optional dep; skills already rely on it
    except Exception:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            d = yaml.safe_load(f) or {}
        name = str(d.get("name") or os.path.splitext(os.path.basename(path))[0]).strip()
        if not name or not d.get("system_prompt"):
            return None
        tools = d.get("allowed_tools")
        raw_handoffs = d.get("handoffs") or []
        return SubagentDef(
            name=name,
            description=str(d.get("description", "")),
            system_prompt=str(d["system_prompt"]),
            allowed_tools=frozenset(tools) if tools else None,
            # A YAML persona written for the old two-axis scheme may still say
            # `mode: plan` / `mode: ask`; honour it as a permission rather than
            # silently dropping the author's read-only intent.
            permission=str(d.get("permission") or _legacy_mode_permission(d) or "auto"),
            model=d.get("model"),
            model_policy=str(d.get("model_policy") or "auto").strip().lower(),
            max_turns=int(d["max_turns"]) if d.get("max_turns") else None,
            handoffs=frozenset(str(h) for h in raw_handoffs),
            auto_respawn=bool(d.get("auto_respawn")),
            exec_mode=str(d.get("exec_mode") or "inprocess").strip().lower(),
            domain_rules=d.get("domain_rules") or d.get("domainRules") or {},
            mcp_tool_cap=int(d.get("mcp_tool_cap") or d.get("mcpToolCap") or 24),
        )
    except Exception:
        return None


def _load_yaml_defs_from_files(paths) -> dict[str, SubagentDef]:
    """Parse a list of YAML file paths into defs, skipping any that fail."""
    out: dict[str, SubagentDef] = {}
    for path in paths:
        d = _parse_yaml_def(path)
        if d is not None:
            out[d.name] = d
    return out


def _load_yaml_defs(subagents_dir: str) -> dict[str, SubagentDef]:
    """Load user-authored sub-agent YAML files from a directory. Best-effort."""
    if not os.path.isdir(subagents_dir):
        return {}
    paths = [
        os.path.join(subagents_dir, fn)
        for fn in os.listdir(subagents_dir)
        if fn.endswith((".yaml", ".yml"))
    ]
    return _load_yaml_defs_from_files(paths)


_REGISTRY: Optional[dict[str, SubagentDef]] = None


def reload_subagent_defs() -> None:
    """Drop the cached registry so the next read re-scans the YAML dir.

    Used after the UI persists a per-persona override: without this the running
    process would keep serving the stale in-memory copy until restart.
    """
    global _REGISTRY
    _REGISTRY = None


def get_subagent_registry() -> dict[str, SubagentDef]:
    """Presets overlaid with user YAML (user wins on name collision)."""
    global _REGISTRY
    if _REGISTRY is None:
        merged = dict(PRESETS)
        here = os.path.dirname(os.path.abspath(__file__))
        merged.update(_load_yaml_defs(os.path.join(here, "subagents")))
        _REGISTRY = merged
    return _REGISTRY


def get_subagent(name: str) -> Optional[SubagentDef]:
    return get_subagent_registry().get(name)


def register_subagent_def(definition: SubagentDef, *, overwrite: bool = False) -> bool:
    """Inject a definition into the live registry. Returns True if it landed.

    Used by the plugin loader: a plugin's ``contributes.subagents`` files are
    not under ``app/backend/subagents/``, so directory scanning would never see
    them. Refuses to clobber an existing name unless asked, so installing a
    plugin can't silently replace the built-in ``coder`` with something else.
    """
    registry = get_subagent_registry()
    if definition.name in registry and not overwrite:
        return False
    registry[definition.name] = definition
    return True


def unregister_subagent_def(name: str) -> bool:
    """Remove a definition, but never a built-in preset."""
    if name in PRESETS:
        return False
    return get_subagent_registry().pop(name, None) is not None


def load_subagent_file(path: str) -> Optional[SubagentDef]:
    """Parse one sub-agent YAML file. Returns None if it isn't usable."""
    defs = _load_yaml_defs_from_files([path])
    return next(iter(defs.values()), None)


def audit_allowed_tools(registry: Optional[dict] = None) -> dict[str, list[str]]:
    """Report persona allowlist entries that match no registered tool.

    An allowlist is enforced by *hiding* everything outside it, so a misspelled
    entry is invisible at runtime: the persona simply never sees the tool it was
    supposed to have. This turns that silent failure into a startup warning.

    Returns ``{persona_name: [unknown_tool, ...]}`` — empty dict means clean.
    Never raises: a broken audit must not stop the app from booting.
    """
    out: dict[str, list[str]] = {}
    try:
        from tools import get_tool_registry

        known = {t.name for t in get_tool_registry().list_tools()}
    except Exception:
        return out
    if not known:
        # Registry not populated yet (e.g. audited before agents register their
        # tools). Reporting everything as unknown would be pure noise.
        return out
    for name, definition in (registry or get_subagent_registry()).items():
        allowed = definition.allowed_tools
        if not allowed:
            continue  # None/empty means "inherit the full catalogue".
        missing = sorted(t for t in allowed if t not in known)
        if missing:
            out[name] = missing
    return out


def warn_on_unknown_allowed_tools() -> None:
    """Print the audit result. Call once after all tool registration is done."""
    for persona, missing in audit_allowed_tools().items():
        print(
            f"[subagents] persona '{persona}' allows tools that are not "
            f"registered and will therefore be hidden from it: "
            f"{', '.join(missing)}"
        )


def list_subagents() -> list[dict]:
    return [d.to_public() for d in get_subagent_registry().values()]
