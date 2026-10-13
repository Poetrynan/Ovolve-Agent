/**
 * risk_control.ts — Three-level risk control + two-stage confirmation.
 *
 * Ported from `app/backend/risk_control.py` (1345 lines).
 *
 * Mounted as a 'pre_tool_use' event subscriber (not embedded in kernel).
 * Risk levels: low (auto) / medium (two-stage confirm) / high (block or escalate) / critical.
 * Permission modes: plan / readonly / confirm / auto / full.
 *
 * RULEBOOK CITATIONS:
 * - §4 Naming: app/backend/risk_control.py -> app/engine/risk_control.ts
 * - §2 Enums: RiskLevel and PermissionMode as const objects + union types.
 * - §2 Bug-for-bug preservation and identical error reporting.
 * - §1 Builtins: node:crypto, node:fs, node:path.
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  EventBus,
  Event,
  EventAction,
  getEventBus,
} from "./event_bus.js";
import {
  RuleBehavior,
  RuleScope,
  PermissionRule,
  get_permission_rules,
  suggest_pattern,
} from "./permission_rules.js";
import {
  PolicyAction,
  PolicyDecision,
  PolicyLayer,
  PolicyRequest,
  PipelineResult,
  ToolPolicyPipeline,
  make_sandbox_layer,
  make_subagent_layer,
  sandbox_layer_status,
} from "./tool_policy.js";
import { make_command_guard_layer } from "./command_classifier.js";
import { get_storage } from "./storage.js";
import { get_tool_registry } from "./tools.js";
import { get_red_team_auditor } from "./red_team.js";
import { get_token_analytics } from "./token_analytics.js";
import { get_bot_controller } from "./bot_remote.js";

// ── Testability Seams ────────────────────────────────────────────────────────

export interface RiskControlSeams {
  now?: () => number;
  readConfigFile?: (configPath: string) => string | null;
  getStorage?: () => any;
  getPermissionRules?: () => any;
  getToolRegistry?: () => any;
  getRedTeamAuditor?: () => any;
  getTokenAnalytics?: () => any;
  getBotController?: () => any;
  getEventBus?: () => any;
}

export const RISK_CONTROL_SEAMS: RiskControlSeams = {};

let _lastTime = 0;
function _getTime(): number {
  if (RISK_CONTROL_SEAMS.now) return RISK_CONTROL_SEAMS.now();
  let now = Date.now() / 1000;
  if (now <= _lastTime) {
    now = _lastTime + 0.0001;
  }
  _lastTime = now;
  return now;
}

// ── Enums & Types ────────────────────────────────────────────────────────────

export const RiskLevel = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const PermissionMode = {
  PLAN: "plan",
  READ_ONLY: "readonly",
  CONFIRM: "confirm",
  AUTO: "auto",
  FULL: "full",
} as const;

export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode];

export const READ_ONLY_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  PermissionMode.PLAN,
  PermissionMode.READ_ONLY,
]);

export const DEFAULT_PERMISSION: PermissionMode = PermissionMode.AUTO;

export const _PERMISSION_ALIASES: Record<string, PermissionMode> = {
  deny: PermissionMode.READ_ONLY,
  read_only: PermissionMode.READ_ONLY,
  ask: PermissionMode.CONFIRM,
  ask_every: PermissionMode.CONFIRM,
  always: PermissionMode.CONFIRM,
  yolo: PermissionMode.FULL,
  never: PermissionMode.FULL,
  full_access: PermissionMode.FULL,
  edit: PermissionMode.AUTO,
  agent: PermissionMode.AUTO,
  build: PermissionMode.AUTO,
  risky: PermissionMode.AUTO,
};

export function coerce_permission(value: unknown): PermissionMode {
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (
      raw === PermissionMode.PLAN ||
      raw === PermissionMode.READ_ONLY ||
      raw === PermissionMode.CONFIRM ||
      raw === PermissionMode.AUTO ||
      raw === PermissionMode.FULL
    ) {
      return raw as PermissionMode;
    }
    return _PERMISSION_ALIASES[raw] ?? DEFAULT_PERMISSION;
  }
  if (!value) {
    return DEFAULT_PERMISSION;
  }
  const raw = String(value).trim().toLowerCase();
  if (
    raw === PermissionMode.PLAN ||
    raw === PermissionMode.READ_ONLY ||
    raw === PermissionMode.CONFIRM ||
    raw === PermissionMode.AUTO ||
    raw === PermissionMode.FULL
  ) {
    return raw as PermissionMode;
  }
  return _PERMISSION_ALIASES[raw] ?? DEFAULT_PERMISSION;
}

export function is_read_only(value: unknown): boolean {
  return READ_ONLY_MODES.has(coerce_permission(value));
}

export const _PERMISSION_NAMES: Record<PermissionMode, string> = {
  [PermissionMode.PLAN]: "只出方案",
  [PermissionMode.READ_ONLY]: "只看不动",
  [PermissionMode.CONFIRM]: "每步问我",
  [PermissionMode.AUTO]: "小事放手",
  [PermissionMode.FULL]: "全权代理",
};

export function describe_permission(value: unknown): string {
  return _PERMISSION_NAMES[coerce_permission(value)];
}

export const _PERMISSION_PROMPTS: Record<PermissionMode, string> = {
  [PermissionMode.PLAN]: `## 当前档位：只出方案（不动手）


你现在**只做方案，不动手**。目标是让用户在你开工之前就能看懂、能否决。

- 可以读文件、搜代码、查历史 —— 把现状调查清楚，方案要基于真实代码而不是猜测。
- **不要**改任何文件、不要跑有副作用的命令。写操作会被系统拦下。
- 调查完给出方案，包含：
  1. **现状** —— 相关代码现在是怎么写的，你实际读到了什么
  2. **改动清单** —— 具体到文件，每个文件改什么，为什么
  3. **风险与取舍** —— 哪里可能出问题，你放弃了哪些替代方案及原因
  4. **验证方式** —— 改完怎么确认真的 work（跑哪个测试、看什么输出）
- 方案给完就停下，等用户回应。不要问"要我开始吗"然后自己接着做。
- 如果调查后发现用户的想法有问题，直接说，不要照着做一份注定失败的方案。`,

  [PermissionMode.READ_ONLY]: `## 当前档位：只看不动


这一轮**任何写操作都会被拦**。

- 可以读文件、搜代码、查 git 历史、看系统信息 —— 所有只读操作照常用。
- 回答问题本身，答完就停。不要顺手附一份"我可以帮你这样改"的方案 —— 用户没问。
- 如果问题必须动手验证才能回答，说明这一点，让用户放开权限。
- 结论先行。先给答案，再给支撑细节；引用具体文件和行号（\`path/to/file.py:42\`）。`,

  [PermissionMode.CONFIRM]: `## 当前档位：每步问我


每个写操作都会弹给用户确认。因此：
- 把相关的改动**合并**成一次调用，别把一个文件拆成五次小编辑轮流问。
- 动手前先一句话说清你要改什么，让用户看确认框时知道自己在批准什么。`,

  [PermissionMode.AUTO]: "",

  [PermissionMode.FULL]: `## 当前档位：全权代理


用户明确要求不再逐步确认。放手做，但底线不变：
- 不做用户没要求的重构、不加没要求的功能。
- 破坏性操作（删数据、force push、改生产配置）仍然要先说清后果再做。
- 做完必须自己验证（跑测试/构建），别声称完成却没验证过。`,
};

export function prompt_block(value: unknown = null): string {
  return _PERMISSION_PROMPTS[coerce_permission(value)] || "";
}

// ── Tool Risk Level Table ────────────────────────────────────────────────────

export const TOOL_RISK_LEVELS: Record<string, { level: RiskLevel; needs_approval: boolean }> = {
  // Low risk - read-only, no confirmation
  read_text: { level: RiskLevel.LOW, needs_approval: false },
  read_file: { level: RiskLevel.LOW, needs_approval: false },
  search_code: { level: RiskLevel.LOW, needs_approval: false },
  find_files: { level: RiskLevel.LOW, needs_approval: false },
  list_dir: { level: RiskLevel.LOW, needs_approval: false },
  web_fetch: { level: RiskLevel.LOW, needs_approval: false },
  git_status: { level: RiskLevel.LOW, needs_approval: false },
  git_log: { level: RiskLevel.LOW, needs_approval: false },
  git_diff: { level: RiskLevel.LOW, needs_approval: false },
  git_show: { level: RiskLevel.LOW, needs_approval: false },
  system_info: { level: RiskLevel.LOW, needs_approval: false },
  env_get: { level: RiskLevel.LOW, needs_approval: false },
  process_list: { level: RiskLevel.LOW, needs_approval: false },
  network_interfaces: { level: RiskLevel.LOW, needs_approval: false },
  disk_usage: { level: RiskLevel.LOW, needs_approval: false },
  action_search: { level: RiskLevel.LOW, needs_approval: false },
  app_list: { level: RiskLevel.LOW, needs_approval: false },
  web_search: { level: RiskLevel.LOW, needs_approval: false },
  semantic_search: { level: RiskLevel.LOW, needs_approval: false },
  academic_search: { level: RiskLevel.LOW, needs_approval: false },
  diagnose: { level: RiskLevel.LOW, needs_approval: false },
  recommend: { level: RiskLevel.LOW, needs_approval: false },
  red_team_scan: { level: RiskLevel.LOW, needs_approval: false },
  security_audit: { level: RiskLevel.LOW, needs_approval: false },

  // Medium risk - file changes, schedules
  write_file: { level: RiskLevel.MEDIUM, needs_approval: true },
  edit_file: { level: RiskLevel.MEDIUM, needs_approval: true },
  delete_file: { level: RiskLevel.MEDIUM, needs_approval: true },
  convert_file: { level: RiskLevel.MEDIUM, needs_approval: true },
  skill: { level: RiskLevel.MEDIUM, needs_approval: true },
  use_skill: { level: RiskLevel.MEDIUM, needs_approval: true },
  cron_create: { level: RiskLevel.MEDIUM, needs_approval: true },
  git_add: { level: RiskLevel.MEDIUM, needs_approval: true },
  git_commit: { level: RiskLevel.MEDIUM, needs_approval: true },
  git_branch: { level: RiskLevel.MEDIUM, needs_approval: true },
  git_checkout: { level: RiskLevel.MEDIUM, needs_approval: true },
  git_pull: { level: RiskLevel.MEDIUM, needs_approval: true },

  // High risk - shell, agent dispatch
  bash: { level: RiskLevel.HIGH, needs_approval: true },
  shell_executor: { level: RiskLevel.HIGH, needs_approval: true },
  python_executor: { level: RiskLevel.HIGH, needs_approval: true },
  dispatch_task: { level: RiskLevel.HIGH, needs_approval: true },
  git_push: { level: RiskLevel.HIGH, needs_approval: true },

  // Critical - irreversible / non-workspace-recoverable
  git_push_force: { level: RiskLevel.CRITICAL, needs_approval: true },
  git_reset_hard: { level: RiskLevel.CRITICAL, needs_approval: true },
  git_clean: { level: RiskLevel.CRITICAL, needs_approval: true },
};

export const _READONLY_HEADS: ReadonlySet<string> = new Set([
  "ls", "dir", "pwd", "echo", "cat", "type", "head", "tail", "wc", "tree",
  "whoami", "hostname", "date", "uname", "ver", "systeminfo", "tasklist",
  "ps", "env", "printenv", "which", "where", "stat", "file", "df", "du",
  "free", "ipconfig", "ifconfig", "ping", "nslookup", "rg", "grep", "findstr",
  "wmic", "get-process", "get-service", "get-item", "get-content", "get-childitem",
  "get-command", "get-help",
]);

export const _READONLY_GIT: readonly string[] = [
  "git status", "git log", "git diff", "git show", "git branch",
  "git remote -v", "git stash list", "git blame",
];

export const _FRIENDLY_TOOL_NAMES: Record<string, string> = {
  system_info: "查看系统信息",
  shell_executor: "执行系统命令",
  python_executor: "运行 Python 代码",
  write_file: "写入文件",
  edit_file: "编辑文件",
  delete_file: "删除文件",
  process_kill: "结束进程",
  app_install: "安装应用",
  app_uninstall: "卸载应用",
  git_push: "推送到远程仓库",
  git_commit: "创建 Git 提交",
  git_add: "暂存文件变更",
  cron_create: "创建定时任务",
  navigate: "打开网页",
  fill: "填写网页表单",
  native_action_chain: "执行系统操作链",
};

export function is_readonly_command(command: string): boolean {
  if (!command || typeof command !== "string") {
    return false;
  }
  if (/(>>?|\|\s*tee\b)/.test(command)) {
    return false;
  }
  const segs = command.split(/&&|\|\||;|\|/);
  for (let seg of segs) {
    seg = seg.trim();
    if (!seg) continue;
    const low = seg.toLowerCase();
    if (_READONLY_GIT.some((g) => low === g || low.startsWith(g + " "))) {
      continue;
    }
    const head = low.split(/\s+/)[0];
    if (!head || !_READONLY_HEADS.has(head)) {
      return false;
    }
  }
  return true;
}

// ── Permission Record ────────────────────────────────────────────────────────

export class PermissionRecord {
  tool_name: string;
  scope: string;
  granted_at: number;
  args_hash: string;
  session_id: string;
  single_use: boolean;

  constructor(opts: {
    tool_name: string;
    scope?: string;
    granted_at?: number;
    args_hash?: string;
    session_id?: string;
    single_use?: boolean;
  }) {
    this.tool_name = opts.tool_name;
    this.scope = opts.scope ?? "session";
    this.granted_at = opts.granted_at ?? 0.0;
    this.args_hash = opts.args_hash ?? "";
    this.session_id = opts.session_id ?? "";
    this.single_use = opts.single_use ?? true;
  }
}

export const GRANT_TTL_S: number = 900.0;
export const _MAX_PENDING: number = 32;
export const _PENDING_KV_NS: string = "risk_pending";
export const PENDING_TTL_S: number = 3600.0;

export function _pending_kv_key(session_id: string): string {
  return `pending:${session_id}`;
}

export class PendingConfirmation {
  call_id: string;
  tool_name: string;
  args: Record<string, any>;
  prompt: string;
  session_id: string;
  asked_at: number;

  constructor(opts: {
    call_id: string;
    tool_name: string;
    args: Record<string, any>;
    prompt?: string;
    session_id?: string;
    asked_at?: number;
  }) {
    this.call_id = opts.call_id;
    this.tool_name = opts.tool_name;
    this.args = opts.args || {};
    this.prompt = opts.prompt ?? "";
    this.session_id = opts.session_id ?? "";
    this.asked_at = opts.asked_at ?? 0.0;
  }
}

export const _CONSENT_YES: ReadonlySet<string> = new Set([
  "同意", "确认", "确定", "可以", "可以的", "行", "好", "好的", "好吧", "没问题",
  "继续", "执行", "批准", "允许", "去吧", "来吧", "干吧", "上",
  "y", "yes", "yeah", "yep", "ok", "okay", "sure", "go", "go ahead",
  "approve", "approved", "allow", "continue", "proceed", "do it",
]);

export const _CONSENT_NO: ReadonlySet<string> = new Set([
  "不", "不要", "不用", "不用了", "别", "别了", "不同意", "拒绝", "取消", "停",
  "停下", "算了", "先别", "不行",
  "n", "no", "nope", "cancel", "stop", "deny", "abort", "don't", "dont",
]);

export const _CONSENT_ALWAYS: ReadonlySet<string> = new Set([
  "以后都允许", "以后都行", "以后不用问", "以后别问", "一直允许", "都允许",
  "总是允许", "不用再问", "别再问了", "加白名单", "记住这个",
  "always", "always allow", "allow always", "don't ask again",
  "dont ask again", "remember this", "whitelist",
]);

export const _CONSENT_STRIP: string = " \t\r\n。，、！!？?~～.,;；:：」「\"'（）()【】[]";

export function parse_consent(text: string): string | null {
  const stripChars = new Set(_CONSENT_STRIP.split(""));
  let s = (text || "").trim();
  let start = 0;
  while (start < s.length && stripChars.has(s[start]!)) start++;
  let end = s.length;
  while (end > start && stripChars.has(s[end - 1]!)) end--;
  s = s.slice(start, end).trim().toLowerCase();
  if (!s || s.length > 12) {
    return null;
  }
  if (_CONSENT_NO.has(s)) {
    return "deny";
  }
  if (_CONSENT_ALWAYS.has(s)) {
    return "approve_always";
  }
  if (_CONSENT_YES.has(s)) {
    return "approve";
  }
  return null;
}

export const _READONLY_TOOLS: Set<string> = new Set(
  Object.keys(TOOL_RISK_LEVELS).filter((k) => TOOL_RISK_LEVELS[k]!.level === RiskLevel.LOW)
);

export const _SUBAGENT_DENIED_TOOLS: Set<string> = new Set([
  "dispatch_task",
  "shell_executor",
  "bash",
  "python_executor",
]);

// ── Python repr / JSON helpers ───────────────────────────────────────────────

function _pyCanonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(_pyCanonicalJson).join(", ") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj as Record<string, any>).sort();
    const pairs = keys.map(
      (k) => `${JSON.stringify(k)}: ${_pyCanonicalJson((obj as Record<string, any>)[k])}`
    );
    return "{" + pairs.join(", ") + "}";
  }
  return String(obj);
}

function _pyRepr(val: unknown): string {
  if (val === null || val === undefined) return "None";
  if (typeof val === "boolean") return val ? "True" : "False";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") {
    if (!val.includes("'")) return `'${val}'`;
    if (!val.includes('"')) return `"${val}"`;
    return `'${val.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(val)) {
    return "[" + val.map(_pyRepr).join(", ") + "]";
  }
  if (typeof val === "object") {
    const pairs = Object.keys(val as Record<string, any>).map(
      (k) => `${_pyRepr(k)}: ${_pyRepr((val as Record<string, any>)[k])}`
    );
    return "{" + pairs.join(", ") + "}";
  }
  return String(val);
}

export function _short_repr(val: unknown, max_len: number = 50): string {
  const s = _pyRepr(val);
  if (s.length > max_len) {
    return s.slice(0, max_len) + "...";
  }
  return s;
}

export function _consequence_intent(tool_name: string, args: Record<string, any>): string {
  const a = args || {};
  const pathVal = a["path"] || a["dst"] || a["file"];
  const pid = a["pid"];
  const cmd = a["command"] || a["cmd"];
  const url = a["url"];

  if (tool_name === "write_file" && pathVal) {
    return `我会写入文件 \`${pathVal}\`。`;
  }
  if (tool_name === "edit_file" && pathVal) {
    return `我会修改文件 \`${pathVal}\`。`;
  }
  if (tool_name === "delete_file" && pathVal) {
    return `我会删除文件 \`${pathVal}\`。`;
  }
  if (tool_name === "process_kill" && pid !== undefined && pid !== null) {
    return `我会结束进程 PID ${pid}。`;
  }
  if ((tool_name === "shell_executor" || tool_name === "bash") && cmd) {
    return `我会在系统里执行这条命令：\`${_short_repr(cmd, 80)}\`。`;
  }
  if (tool_name === "git_push") {
    return "准备把当前提交推送到远程仓库。";
  }
  if (tool_name === "git_commit") {
    return "准备创建一个 Git 提交。";
  }
  if (tool_name === "app_uninstall") {
    const pkg = (" " + String(a["name"] || a["package"] || "")).trimEnd();
    return `准备卸载应用${pkg}。`;
  }
  if (tool_name === "navigate" && url) {
    return `准备打开网页 \`${url}\`。`;
  }
  if (tool_name === "fill") {
    return "准备在网页上填写表单字段。";
  }
  if (tool_name === "cron_create") {
    return "准备创建一个定时任务。";
  }
  const friendly = _FRIENDLY_TOOL_NAMES[tool_name];
  if (friendly) {
    return `接下来我会${friendly}。`;
  }
  return "接下来有一步操作需要你点头。";
}

export function _consequence_side_effect(tool_name: string, args: Record<string, any>): string {
  if (tool_name === "write_file" || tool_name === "edit_file") {
    return "这会改动已有内容；需要的话我可以先备份再写。";
  }
  if (tool_name === "delete_file") {
    return "删除后通常难以恢复，请确认目标无误。";
  }
  if (tool_name === "process_kill") {
    return "结束后对应窗口/服务会关掉，一般可以再打开。";
  }
  if (
    tool_name === "shell_executor" ||
    tool_name === "bash" ||
    tool_name === "native_action_chain" ||
    tool_name === "python_executor"
  ) {
    return "命令可能改变系统状态；我只会执行你批准的这一次。";
  }
  if (tool_name === "git_push") {
    return "推上去之后远端会更新。";
  }
  if (tool_name === "app_uninstall" || tool_name === "app_install") {
    return "这会改变本机已安装的应用。";
  }
  if (tool_name === "fill") {
    return "如果涉及登录或凭据字段，请确认内容无误。";
  }
  return "";
}

// ── RiskController ───────────────────────────────────────────────────────────

export class RiskController {
  public mode: PermissionMode;
  public auto_confirm_low_risk: boolean;
  public _permissions: PermissionRecord[];
  public _pending_confirmations: Map<string, PendingConfirmation>;
  public _storage: any;
  public _pending_loaded: Set<string>;
  public _bus: EventBus | null;
  public pipeline: ToolPolicyPipeline;
  public last_result: any;

  constructor(mode: PermissionMode = PermissionMode.AUTO) {
    this.mode = mode;
    this.auto_confirm_low_risk = true;

    if (RISK_CONTROL_SEAMS.readConfigFile) {
      const raw = RISK_CONTROL_SEAMS.readConfigFile("config.json");
      if (raw) {
        try {
          const cfg = JSON.parse(raw);
          const val = cfg?.permissions?.auto_confirm_low_risk;
          if (val !== undefined && val !== null) {
            this.auto_confirm_low_risk = Boolean(val);
          }
        } catch {}
      }
    } else {
      try {
        const baseDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
        const cfgPath = path.join(baseDir, "..", "config.json");
        if (fs.existsSync(cfgPath)) {
          const raw = fs.readFileSync(cfgPath, "utf8");
          const cfg = JSON.parse(raw);
          const val = cfg?.permissions?.auto_confirm_low_risk;
          if (val !== undefined && val !== null) {
            this.auto_confirm_low_risk = Boolean(val);
          }
        }
      } catch {}
    }

    this._permissions = [];
    this._pending_confirmations = new Map();
    this._storage = null;
    this._pending_loaded = new Set();
    this._bus = null;
    this.pipeline = new ToolPolicyPipeline();
    this.last_result = null;
    this._install_layers();
  }

  public _install_layers(): void {
    this.pipeline.register(
      PolicyLayer.GLOBAL,
      (req) => this._global_risk_layer(req),
      "risk-table"
    );
    this.pipeline.register(
      PolicyLayer.SANDBOX,
      make_sandbox_layer(_READONLY_TOOLS),
      "sandbox"
    );
    const _sandbox = sandbox_layer_status();
    if (!_sandbox["effective"]) {
      console.log(
        "[policy] SANDBOX tool-flag layer is unset (readonly-tools " +
          "gate). Kernel confinement is sandbox.popen_confined, not this layer."
      );
    }
    this.pipeline.register(
      PolicyLayer.SUBAGENT,
      make_subagent_layer(_SUBAGENT_DENIED_TOOLS),
      "subagent"
    );
    this.pipeline.register(
      PolicyLayer.INHERITED,
      (req) => this._granted_permission_layer(req),
      "granted-permission"
    );
    this.pipeline.register(
      PolicyLayer.COMMAND,
      make_command_guard_layer(),
      "command-guard"
    );
  }

  public _global_risk_layer(req: PolicyRequest): PolicyDecision | null {
    const risk = this.classify_risk(req.tool_name, req.args);
    const mode = this._effective_mode(req.context || {});
    const rule = this._match_rule(req);

    if (rule !== null && rule !== undefined) {
      try {
        const analytics = RISK_CONTROL_SEAMS.getTokenAnalytics
          ? RISK_CONTROL_SEAMS.getTokenAnalytics()
          : get_token_analytics();
        if (analytics && typeof analytics.on_rule_applied === "function") {
          analytics.on_rule_applied();
        }
      } catch {}
    }

    if (rule !== null && rule !== undefined && rule.behavior === RuleBehavior.DENY) {
      const idPrefix = (rule.id || "").slice(0, 8);
      const patternDesc = rule.pattern ? ` / ${rule.pattern}` : "";
      return new PolicyDecision(
        PolicyAction.DENY,
        PolicyLayer.GLOBAL,
        `rule:deny:${idPrefix}`,
        `你设置过一条规则禁止这类调用（${rule.tool_name}${patternDesc}），已拦下。要放开就去设置里删掉那条规则。`
      );
    }

    if (READ_ONLY_MODES.has(mode) && risk !== RiskLevel.LOW) {
      return new PolicyDecision(
        PolicyAction.DENY,
        PolicyLayer.GLOBAL,
        `mode:${mode}`,
        this._read_only_refusal(mode, req.tool_name)
      );
    }

    if (risk === RiskLevel.CRITICAL) {
      return new PolicyDecision(
        PolicyAction.ASK,
        PolicyLayer.GLOBAL,
        "risk:critical",
        this._critical_prompt(req.tool_name, req.args || {})
      );
    }

    if (rule !== null && rule !== undefined && rule.behavior === RuleBehavior.ASK) {
      const idPrefix = (rule.id || "").slice(0, 8);
      return new PolicyDecision(
        PolicyAction.ASK,
        PolicyLayer.GLOBAL,
        `rule:ask:${idPrefix}`,
        this._build_confirmation_prompt(req.tool_name, req.args || {}, risk)
      );
    }

    if (rule !== null && rule !== undefined && rule.behavior === RuleBehavior.ALLOW) {
      return null;
    }

    if (risk === RiskLevel.LOW) {
      if (mode === PermissionMode.CONFIRM && !this.auto_confirm_low_risk) {
        return new PolicyDecision(
          PolicyAction.ASK,
          PolicyLayer.GLOBAL,
          "mode:confirm+low",
          this._build_confirmation_prompt(req.tool_name, req.args || {}, risk)
        );
      }
      return null;
    }

    if (mode === PermissionMode.CONFIRM) {
      return new PolicyDecision(
        PolicyAction.ASK,
        PolicyLayer.GLOBAL,
        `mode:confirm+risk:${risk}`,
        this._build_confirmation_prompt(req.tool_name, req.args || {}, risk)
      );
    }

    if (mode === PermissionMode.FULL) {
      return null;
    }

    return new PolicyDecision(
      PolicyAction.ASK,
      PolicyLayer.GLOBAL,
      `risk:${risk}`,
      this._build_confirmation_prompt(req.tool_name, req.args || {}, risk)
    );
  }

  public _match_rule(req: PolicyRequest): any {
    try {
      const rules = RISK_CONTROL_SEAMS.getPermissionRules
        ? RISK_CONTROL_SEAMS.getPermissionRules()
        : get_permission_rules();
      const ctx = req.context || {};
      return rules.match(
        req.tool_name,
        req.args || {},
        String(ctx["workspace_root"] || ""),
        String(ctx["session_id"] || "")
      );
    } catch {
      return null;
    }
  }

  public _critical_prompt(tool_name: string, args: Record<string, any>): string {
    const intent = _consequence_intent(tool_name, args || {});
    return (
      `${intent}\n` +
      "这一步不可逆，而且**不受权限档位和白名单规则影响** —— 就算你开了" +
      "「全权代理」，它也一定会停下来问你。想继续请明确回复「同意」；" +
      "如果有更安全的做法（比如先备份、或改成不带 force 的推送），说一声我换。"
    );
  }

  public _effective_mode(context: Record<string, any>): PermissionMode {
    const override = context ? context["permission"] : undefined;
    if (override) {
      return coerce_permission(override);
    }
    return this.mode;
  }

  public _read_only_refusal(mode: PermissionMode, tool_name: string): string {
    if (mode === PermissionMode.PLAN) {
      return (
        `当前是「只出方案」档，\`${tool_name}\` 会改动环境，已被拦下。\n` +
        "这一档下你只能读取和分析。请把你打算怎么做写成方案交给用户 —— " +
        "包括要改哪些文件、每处改什么、有什么风险、怎么验证。用户认可后会自己把" +
        "权限调到「小事放手」或「全权代理」，那时你再动手。不要试图绕开这个限制。"
      );
    }
    return (
      `当前权限档是「只看不动」，\`${tool_name}\` 会改动环境，已被拦下。\n` +
      "你可以继续读取和分析来回答用户的问题。如果确实需要动手，" +
      "请提示用户把权限调到「每步问我」或更高。"
    );
  }

  public _granted_permission_layer(req: PolicyRequest): PolicyDecision | null {
    if (this._has_explicit_grant(req.tool_name, req.args || {}, req.context || {})) {
      return new PolicyDecision(
        PolicyAction.CLEAR,
        PolicyLayer.INHERITED,
        "granted",
        "user already approved this exact call"
      );
    }
    return null;
  }

  public mount(bus?: EventBus): void {
    this._bus =
      bus ||
      (RISK_CONTROL_SEAMS.getEventBus
        ? RISK_CONTROL_SEAMS.getEventBus()
        : getEventBus());
    if (this._bus) {
      this._bus.on("pre_tool_use", (e) => this._on_pre_tool_use(e), 100);
    }
  }

  public unmount(): void {
    if (this._bus) {
      this._bus.off("pre_tool_use", (e) => this._on_pre_tool_use(e));
    }
  }

  public set_mode(mode: PermissionMode | string): void {
    this.mode = coerce_permission(mode);
  }

  public set_auto_confirm_low_risk(enabled: boolean): void {
    this.auto_confirm_low_risk = Boolean(enabled);
  }

  public classify_risk(tool_name: string, args: Record<string, any> | null = null): RiskLevel {
    if ((tool_name === "bash" || tool_name === "shell_executor") && args) {
      const cmd = args["command"] || args["cmd"] || "";
      if (cmd && is_readonly_command(String(cmd))) {
        return RiskLevel.LOW;
      }
    }

    if ((tool_name === "git_push" || tool_name === "git_push_force") && args) {
      if (args["force"] || args["force_with_lease"]) {
        return RiskLevel.CRITICAL;
      }
    }

    const entry = TOOL_RISK_LEVELS[tool_name];
    if (entry) {
      return entry.level;
    }

    try {
      const registry = RISK_CONTROL_SEAMS.getToolRegistry
        ? RISK_CONTROL_SEAMS.getToolRegistry()
        : get_tool_registry();
      const tool = registry ? registry.get(tool_name) : null;
      if (tool) {
        const level = String(tool.risk_level || "medium").toLowerCase();
        if (level === "critical") return RiskLevel.CRITICAL;
        if (level === "low") return RiskLevel.LOW;
        if (level === "high") return RiskLevel.HIGH;
        return RiskLevel.MEDIUM;
      }
    } catch {}

    return RiskLevel.MEDIUM;
  }

  public needs_confirmation(
    tool_name: string,
    args: Record<string, any> | null = null,
    context: Record<string, any> | null = null
  ): boolean {
    const risk = this.classify_risk(tool_name, args);
    const decision = this._global_risk_layer(
      new PolicyRequest(
        tool_name,
        args || {},
        context || {},
        risk,
        context?.["provider"] || "",
        context?.["agent_role"] || ""
      )
    );
    return decision !== null && (decision.action === PolicyAction.ASK || decision.action === PolicyAction.DENY);
  }

  public _on_pre_tool_use(event: Event): void {
    const payload = event.payload as Record<string, any>;
    const tool_name = String(payload["tool_name"] || "");
    const args = (payload["args"] || {}) as Record<string, any>;
    const context = (payload["context"] || {}) as Record<string, any>;

    const risk = this.classify_risk(tool_name, args);

    const request = new PolicyRequest(
      tool_name,
      args,
      context,
      risk,
      context["provider"] || "",
      context["agent_role"] || ""
    );

    let result = this.pipeline.evaluate(request);
    this.last_result = result;

    if (result.action !== PolicyAction.DENY) {
      try {
        const auditor = RISK_CONTROL_SEAMS.getRedTeamAuditor
          ? RISK_CONTROL_SEAMS.getRedTeamAuditor()
          : get_red_team_auditor();
        if (auditor && typeof auditor.confused_deputy_signals === "function") {
          const signals: string[] = auditor.confused_deputy_signals(tool_name, args, context);
          if (signals && signals.length > 0 && result.action === PolicyAction.ALLOW) {
            const perm = context["permission"];
            if (
              perm === "full" ||
              perm === "yolo" ||
              perm === "never" ||
              perm === "full_access" ||
              this.mode === PermissionMode.FULL
            ) {
              // 全权代理：保持 ALLOW，不升级为 ASK
            } else {
              const sig_text = signals.join("; ");
              const dec = new PolicyDecision(
                PolicyAction.ASK,
                PolicyLayer.GLOBAL,
                "confused-deputy",
                `Confused-deputy 检测触发，需人工确认: ${sig_text}`
              );
              result = new PipelineResult(PolicyAction.ASK, dec, result.trail);
              this.last_result = result;
            }
          }
        }
      } catch {}
    }

    if (result.action === PolicyAction.DENY) {
      event.block(result.reason || "策略拦截");
      return;
    }

    if (result.action === PolicyAction.ASK) {
      const prompt = result.reason || this._build_confirmation_prompt(tool_name, args, risk);
      this.record_pending(
        String(payload["call_id"] || ""),
        tool_name,
        args,
        prompt,
        String(payload["session_id"] || context["session_id"] || "")
      );
      event.ask(prompt);
      return;
    }
  }

  public get_audit_trail(): Record<string, any>[] {
    if (this.last_result !== null && this.last_result !== undefined) {
      return this.last_result.trail || [];
    }
    return [];
  }

  public _has_permission(
    tool_name: string,
    args: Record<string, any>,
    context: Record<string, any>
  ): boolean {
    const risk = this.classify_risk(tool_name, args);
    if (risk === RiskLevel.LOW) {
      return true;
    }
    return this._has_explicit_grant(tool_name, args, context);
  }

  public _has_explicit_grant(
    tool_name: string,
    args: Record<string, any>,
    context: Record<string, any>
  ): boolean {
    return this._find_grant(tool_name, args, context) !== null;
  }

  public _find_grant(
    tool_name: string,
    args: Record<string, any>,
    context: Record<string, any>
  ): PermissionRecord | null {
    const args_hash = this._hash_args(args);
    const session_id = String(context?.["session_id"] || "");
    const now = _getTime();
    for (const perm of this._permissions) {
      if (perm.tool_name !== tool_name || perm.args_hash !== args_hash) {
        continue;
      }
      if (perm.scope === "session") {
        if (perm.session_id && session_id && perm.session_id !== session_id) {
          continue;
        }
      }
      if (perm.granted_at && now - perm.granted_at > GRANT_TTL_S) {
        continue;
      }
      return perm;
    }
    return null;
  }

  public has_grant(
    tool_name: string,
    args: Record<string, any>,
    context?: Record<string, any>
  ): boolean {
    return this._has_explicit_grant(tool_name, args, context || {});
  }

  public consume_grant(
    tool_name: string,
    args: Record<string, any>,
    context?: Record<string, any>
  ): boolean {
    const perm = this._find_grant(tool_name, args, context || {});
    if (perm === null) {
      return false;
    }
    if (perm.single_use) {
      this._permissions = this._permissions.filter((p) => p !== perm);
    }
    return true;
  }

  public grant_permission(
    tool_name: string,
    args: Record<string, any>,
    scope: string = "session",
    session_id: string = "",
    single_use: boolean = true
  ): void {
    this._permissions.push(
      new PermissionRecord({
        tool_name,
        scope,
        granted_at: _getTime(),
        args_hash: this._hash_args(args),
        session_id,
        single_use,
      })
    );
  }

  public revoke_permission(tool_name: string, scope: string = "session"): void {
    this._permissions = this._permissions.filter(
      (p) => !(p.tool_name === tool_name && p.scope === scope)
    );
  }

  // ── Pending-ask ledger ─────────────────────────────────────────────────────

  public _store(): any {
    if (this._storage === null) {
      this._storage = RISK_CONTROL_SEAMS.getStorage
        ? RISK_CONTROL_SEAMS.getStorage()
        : get_storage();
    }
    return this._storage;
  }

  public _load_pending(session_id: string): void {
    const sid = String(session_id || "");
    if (!sid || this._pending_loaded.has(sid)) {
      return;
    }
    this._pending_loaded.add(sid);
    let rows: any = [];
    try {
      const store = this._store();
      if (store && typeof store.kv_get === "function") {
        rows = store.kv_get(_pending_kv_key(sid), _PENDING_KV_NS, []) || [];
      }
    } catch {
      return;
    }
    const now = _getTime();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        try {
          const asked_at = Number(row["asked_at"] || 0);
          if (now - asked_at > PENDING_TTL_S) {
            continue;
          }
          const entry = new PendingConfirmation({
            call_id: String(row["call_id"]),
            tool_name: String(row["tool_name"] || ""),
            args: (row["args"] || {}) as Record<string, any>,
            prompt: String(row["prompt"] || ""),
            session_id: sid,
            asked_at,
          });
          if (entry.tool_name && !this._pending_confirmations.has(entry.call_id)) {
            this._pending_confirmations.set(entry.call_id, entry);
          }
        } catch {}
      }
    }
  }

  public _persist_pending(session_id: string): void {
    const sid = String(session_id || "");
    if (!sid) {
      return;
    }
    try {
      const store = this._store();
      if (store && typeof store.kv_set === "function") {
        const payload = this.pending_for(sid)
          .filter((p) => p.session_id === sid)
          .map((p) => ({
            call_id: p.call_id,
            tool_name: p.tool_name,
            args: p.args,
            prompt: p.prompt,
            asked_at: p.asked_at,
          }));
        store.kv_set(_pending_kv_key(sid), payload, _PENDING_KV_NS);
      }
    } catch {}
  }

  public record_pending(
    call_id: string,
    tool_name: string,
    args: Record<string, any>,
    prompt: string = "",
    session_id: string = ""
  ): PendingConfirmation {
    this._load_pending(session_id);
    const entry = new PendingConfirmation({
      call_id: call_id || `${tool_name}-pending`,
      tool_name,
      args: args || {},
      prompt,
      session_id: String(session_id || ""),
      asked_at: _getTime(),
    });
    this._pending_confirmations.set(entry.call_id, entry);

    if (this._pending_confirmations.size > _MAX_PENDING) {
      const oldest = Array.from(this._pending_confirmations.values()).sort(
        (a, b) => a.asked_at - b.asked_at
      );
      const toRemove = this._pending_confirmations.size - _MAX_PENDING;
      for (let i = 0; i < toRemove; i++) {
        this._pending_confirmations.delete(oldest[i]!.call_id);
      }
    }
    this._persist_pending(entry.session_id);
    return entry;
  }

  public pending_for(session_id: string = ""): PendingConfirmation[] {
    const sid = String(session_id || "");
    this._load_pending(sid);
    const rows: PendingConfirmation[] = [];
    for (const p of this._pending_confirmations.values()) {
      if (!sid || !p.session_id || p.session_id === sid) {
        rows.push(p);
      }
    }
    return rows.sort((a, b) => b.asked_at - a.asked_at);
  }

  public resolve_pending(
    decision: string,
    session_id: string = "",
    call_id: string = ""
  ): PendingConfirmation | null {
    const rows = this.pending_for(session_id);
    let entry: PendingConfirmation | null = null;
    if (call_id) {
      entry = this._pending_confirmations.get(call_id) || null;
    } else if (rows.length > 0) {
      entry = rows[0]!;
    }
    if (entry === null) {
      return null;
    }

    this._pending_confirmations.delete(entry.call_id);
    this._persist_pending(entry.session_id || String(session_id || ""));

    if (decision === "approve" || decision === "approve_always") {
      const sid = entry.session_id || String(session_id || "");
      this.grant_permission(entry.tool_name, entry.args, "session", sid);
      if (decision === "approve_always") {
        this._remember_always(entry);
      }
    }
    return entry;
  }

  public _remember_always(entry: PendingConfirmation): boolean {
    try {
      const risk = this.classify_risk(entry.tool_name, entry.args);
      if (risk === RiskLevel.CRITICAL) {
        return false;
      }
      const rules = RISK_CONTROL_SEAMS.getPermissionRules
        ? RISK_CONTROL_SEAMS.getPermissionRules()
        : get_permission_rules();
      rules.add(
        new PermissionRule({
          tool_name: entry.tool_name,
          pattern: suggest_pattern(entry.tool_name, entry.args),
          behavior: RuleBehavior.ALLOW,
          scope: RuleScope.SESSION,
          session_id: entry.session_id,
          source: "user",
          note: "用户在确认时选择「以后都允许」",
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  public _hash_args(args: Record<string, any>): string {
    const canonical = _pyCanonicalJson(args || {});
    return crypto.createHash("md5").update(Buffer.from(canonical, "utf8")).digest("hex");
  }

  public _build_confirmation_prompt(
    tool_name: string,
    args: Record<string, any>,
    risk: RiskLevel
  ): string {
    const intent = _consequence_intent(tool_name, args || {});
    const consequence = _consequence_side_effect(tool_name, args || {});
    const lines: string[] = [`收到。${intent}`];
    if (consequence) {
      lines.push(consequence);
    }
    lines.push("回复「同意」我就继续 —— 这次确认只对这一次有效。");
    lines.push(this._always_hint(tool_name, args || {}));
    lines.push("不想做的话直接告诉我换个做法。");
    return lines.filter(Boolean).join("\n");
  }

  public _always_hint(tool_name: string, args: Record<string, any>): string {
    try {
      const pattern = suggest_pattern(tool_name, args || {});
      if (pattern) {
        return `回复「以后都允许」，这个会话里所有 \`${pattern}\` 都不再问你。`;
      }
    } catch {}
    return "回复「以后都允许」，这个会话里同类操作都不再问你。";
  }

  public get_risk_table(): Record<string, { level: string; needs_approval: boolean }> {
    const out: Record<string, { level: string; needs_approval: boolean }> = {};
    for (const [name, info] of Object.entries(TOOL_RISK_LEVELS)) {
      out[name] = { level: info.level, needs_approval: info.needs_approval };
    }
    return out;
  }
}

// ── RemoteSessionRiskDecorator ───────────────────────────────────────────────

export class RemoteSessionRiskDecorator {
  public static readonly PRIORITY: number = 200;
  public _bot: any;
  public _bus: EventBus | null;

  constructor(controller: any = null) {
    this._bot = controller;
    this._bus = null;
  }

  public _bot_controller(): any {
    if (this._bot === null) {
      this._bot = RISK_CONTROL_SEAMS.getBotController
        ? RISK_CONTROL_SEAMS.getBotController()
        : get_bot_controller();
    }
    return this._bot;
  }

  public mount(bus?: EventBus): void {
    this._bus =
      bus ||
      (RISK_CONTROL_SEAMS.getEventBus
        ? RISK_CONTROL_SEAMS.getEventBus()
        : getEventBus());
    if (this._bus) {
      this._bus.on("pre_tool_use", (e) => this._on_pre_tool_use(e), RemoteSessionRiskDecorator.PRIORITY);
    }
  }

  public unmount(): void {
    if (this._bus) {
      this._bus.off("pre_tool_use", (e) => this._on_pre_tool_use(e));
    }
  }

  public _on_pre_tool_use(event: Event): void {
    const payload = event.payload as Record<string, any>;
    const context = (payload["context"] || {}) as Record<string, any>;
    if (!context["is_remote"]) {
      return;
    }
    const tool_name = String(payload["tool_name"] || "");
    const platform = String(context["platform"] || "");
    const bot = this._bot_controller();

    if (bot && typeof bot.is_tool_allowed === "function" && bot.is_tool_allowed(platform, tool_name)) {
      if (typeof bot.audit_operation === "function") {
        bot.audit_operation(
          platform,
          String(context["user_id"] || ""),
          String(context["session_id"] || ""),
          tool_name,
          "allow",
          false,
          ""
        );
      }
      return;
    }

    const reason = `'${tool_name}' is disabled for remote sessions`;
    if (bot && typeof bot.audit_operation === "function") {
      bot.audit_operation(
        platform,
        String(context["user_id"] || ""),
        String(context["session_id"] || ""),
        tool_name,
        "deny_tool",
        true,
        reason
      );
    }
    event.block(`${reason}. Run it from the desktop app if you really need it.`);
  }
}

// ── Singletons & Factory Functions ───────────────────────────────────────────

let _controller: RiskController | null = null;
let _remote_decorator: RemoteSessionRiskDecorator | null = null;

export function get_risk_controller(): RiskController {
  if (_controller === null) {
    _controller = new RiskController();
  }
  return _controller;
}

export function get_remote_risk_decorator(): RemoteSessionRiskDecorator {
  if (_remote_decorator === null) {
    _remote_decorator = new RemoteSessionRiskDecorator();
  }
  return _remote_decorator;
}

export function init_risk_controller(
  mode: PermissionMode | string = DEFAULT_PERMISSION
): RiskController {
  _controller = new RiskController(coerce_permission(mode));
  _controller.mount();
  get_remote_risk_decorator().mount();
  return _controller;
}

export function reset_risk_controller(): void {
  if (_controller) {
    _controller.unmount();
    _controller = null;
  }
  if (_remote_decorator) {
    _remote_decorator.unmount();
    _remote_decorator = null;
  }
}

// CamelCase aliases
export const getRiskController = get_risk_controller;
export const getRemoteRiskDecorator = get_remote_risk_decorator;
export const initRiskController = init_risk_controller;
export const resetRiskController = reset_risk_controller;
export const coercePermission = coerce_permission;
export const isReadOnly = is_read_only;
export const describePermission = describe_permission;
export const promptBlock = prompt_block;
export const isReadonlyCommand = is_readonly_command;
export const parseConsent = parse_consent;
