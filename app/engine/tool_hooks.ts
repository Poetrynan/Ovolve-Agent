/**
 * tool_hooks.ts — Pre / Post / OnAbort three-stage tool hooks (B5).
 *
 * Ported from `app/backend/tool_hooks.py` (629 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/tool_hooks.py -> app/engine/tool_hooks.ts (SPLIT,
 *       TS half: the pure policy logic). Public names keep the Python
 *       snake_case (redact_secrets / sanitize_injection_tags / get_tool_hooks
 *       / run_pre ...) per the get_output_guard / inspect_code precedent in
 *       output_guard.ts; the already-landed TS dependencies are imported by
 *       their own export names (classifyToolCall / payloadOf / getDenialCache
 *       from danger_classifier, scanText / generateLeakReport from
 *       secret_scan, FullScopeDeliveryGuard from output_guard).
 *   §2  CONFIRM is imported by the source but never referenced — omitted
 *       (a dead import would be noise; behaviour identical).
 *   §2  regex (RULEBOOK §2): Python inline (?i)/(?m) become the i/m flags
 *       where portable. Python's \b and \w are Unicode-aware while JS's are
 *       ASCII-only, so every \b is expanded to
 *       (?<![\p{L}\p{N}_]) / (?![\p{L}\p{N}_]) and every \w to [\p{L}\p{N}_]
 *       — without this, "sk-...key值" (CJK adjacency) would be redacted by JS
 *       but NOT by the source. DIVERGENCE(port): residual only for exotic
 *       code points str.isalnum() counts beyond the L and N categories
 *       (none occur in credential/tag shapes). \s keeps the JS class; the
 *       Python-only \x1c-\x1f/\x85 whitespace chars do not occur in the
 *       matched shapes.
 *   §2  MULTILINE: Python re.M ^/$ are \n-only line markers; JS /m also
 *       treats \r (and \u2028/\u2029) as line terminators, which would make
 *       the loose-tag rule fire on CRLF tool output the source ignores.
 *       Emulated re.M exactly without /m: (?:^|(?<=\n)) … (?=\n|$).
 *   §2  present-but-null: args.get("k", d) yields None when the key is
 *       PRESENT with a null value — dictGet mirrors that; the
 *       `str(args.get("command") or args.get("cmd") or … or "")` chains are
 *       Python falsy or-gates, mirrored with pyTruthGate, never folded with
 *       ??/||.
 *   §2  latent quirks kept — BUG(port): the source's secret_leak_guard_hook
 *       evaluates `os.getcwd()` although the module never imports os; when
 *       context["cwd"] and args["Cwd"] are both absent/falsy the source
 *       raises NameError, swallowed by the same `except Exception: pass`, so
 *       the git-push scan is skipped entirely. Reproduced: same lazy
 *       position, same throw, same catch. Also kept: the
 *       credential-assignment substitution always emits `=` even when the
 *       matched text used `:`.
 *   §2  `f"{m.group(1)}={_REDACTED}"` replacement, str(int) interpolations
 *       and the full-width CJK punctuation of every veto message are
 *       reproduced byte-for-byte.
 *
 * MIGRATION DECISIONS (not divergences)
 *   `from output_guard import …` / `from secret_scan import …` execute inside
 *   the try per call in Python (an ImportError would be swallowed); static
 *   ESM imports resolve at module load and both modules exist, so each catch
 *   wraps the same callable bodies.
 *   subprocess.run(["git","diff","--cached"], timeout=10) → spawnSync with
 *   timeout 10000 and a 64MB maxBuffer (Node's 1MB default would ENOBUFS on
 *   diffs the source scans fine); spawn/timeout failures throw into the same
 *   except-pass, mirroring FileNotFoundError/TimeoutExpired. DIVERGENCE(port):
 *   the exception TEXT of a spawn failure is Node's wording, OS- and
 *   language-dependent on both sides already; only the control flow is
 *   compared (scan skipped → hook falls through to the write check).
 *   fnmatch.fnmatch case-folding: on the Windows host fnmatch normalizes via
 *   ntpath (lowercase); both sides are lowercased here. [seq] classes are
 *   not translated (house fnmatch from path_guard.ts) — no registered
 *   pattern uses one.
 *   HookStage(str, Enum) → string-literal union + coercer that throws the
 *   same message ValueError does: `'x' is not a valid HookStage`.
 *   telemetry: none in this module — nothing to delete.
 */

import { spawnSync } from "node:child_process";

import {
  classifyToolCall,
  payloadOf,
  getDenialCache,
  DENY,
} from "./danger_classifier.js";
import type { JsonDict } from "./danger_classifier.js";
import { FullScopeDeliveryGuard } from "./output_guard.js";
import { scanText, generateLeakReport } from "./secret_scan.js";

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

function isPyDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** python dict.get(k, dflt): present-but-null returns null, not dflt. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (!isPyDict(obj)) {
    throw new Error(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in obj ? obj[key] : dflt;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/**
 * str(exc): every Error that can reach _safe_call is constructed in this
 * codebase with `.message` set to the exact Python exception text, so the
 * catch site uses `exc.message` directly.
 */

/** `a or b or c or dflt` — first truthy operand, else the tail default. */
function pyTruthGate(candidates: unknown[], dflt: unknown): unknown {
  for (const v of candidates) {
    if (pyTruth(v)) return v;
  }
  return dflt;
}

/** python repr() of a str (single quotes unless the value itself has one). */
function pyReprStr(v: string): string {
  return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replaceAll("'", "\\'")}'`;
}

/**
 * `fnmatch.fnmatch` (Windows host: ntpath.normcase lowercases both sides).
 * House implementation from path_guard.ts plus the casefold; [seq] classes
 * are translated as literals — see header DIVERGENCE note.
 */
function fnmatchPy(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return rx.test(name.toLowerCase());
}

/** python re.subn with a constant replacement: [text, count]. */
function subnStr(rx: RegExp, text: string, repl: string): [string, number] {
  let n = 0;
  const out = text.replace(rx, () => {
    n += 1;
    return repl;
  });
  return [out, n];
}

// ── HookStage / HookOutcome ─────────────────────────────────────────────────

export const HookStage = {
  PRE: "pre",
  POST: "post",
  ABORT: "abort",
} as const;
export type HookStage = (typeof HookStage)[keyof typeof HookStage];

/** `HookStage(stage)` — ValueError for anything else. */
function coerceStage(stage: HookStage | string): HookStage {
  if (stage === HookStage.PRE || stage === HookStage.POST || stage === HookStage.ABORT) {
    return stage;
  }
  throw new Error(`${pyReprStr(String(stage))} is not a valid HookStage`);
}

export class HookOutcome {
  /** What a hook wants to happen next (dataclass with defaults). */
  blocked: boolean;
  reason: string;
  replace_args: JsonDict | null;
  replace_content: string | null;
  redactions: number;
  label: string;

  constructor(opts: {
    blocked?: boolean;
    reason?: string;
    replace_args?: JsonDict | null;
    replace_content?: string | null;
    redactions?: number;
    label?: string;
  } = {}) {
    this.blocked = opts.blocked ?? false;
    this.reason = opts.reason ?? "";
    this.replace_args = opts.replace_args ?? null;
    this.replace_content = opts.replace_content ?? null;
    this.redactions = opts.redactions ?? 0;
    this.label = opts.label ?? "";
  }

  static veto(reason: string, label = ""): HookOutcome {
    return new HookOutcome({ blocked: true, reason, label });
  }

  static rewrite(args: JsonDict, reason = "", label = ""): HookOutcome {
    return new HookOutcome({ replace_args: args, reason, label });
  }

  static sanitize(content: string, redactions = 0, label = ""): HookOutcome {
    return new HookOutcome({ replace_content: content, redactions, label });
  }
}

/** A hook is `(tool_name, payload, context) -> HookOutcome | None`. */
export type HookFn = (toolName: string, payload: unknown, context: JsonDict) => HookOutcome | null;

interface Registration {
  pattern: string;
  fn: HookFn;
  label: string;
  priority: number;
}

// ── Secret redaction ────────────────────────────────────────────────────────

// Python's \b is Unicode-aware (RULEBOOK §2, see header): expand to explicit
// lookarounds so CJK adjacency behaves exactly like re on str.
const WB = String.raw`(?<![\p{L}\p{N}_])`;
const WE = String.raw`(?![\p{L}\p{N}_])`;

/**
 * Patterns for credentials that must never reach the context window. Ordered
 * most-specific first. Compiled once without /g where only .test is used;
 * /g-bearing ones are consumed exclusively via String.replace (which pins
 * lastIndex to 0, so no state leaks between scans).
 */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; rx: RegExp }> = [
  { name: "openai-key", rx: new RegExp(WB + String.raw`sk-[A-Za-z0-9_-]{16,}` + WE, "gu") },
  { name: "anthropic-key", rx: new RegExp(WB + String.raw`sk-ant-[A-Za-z0-9_-]{16,}` + WE, "gu") },
  { name: "github-token", rx: new RegExp(WB + String.raw`gh[pousr]_[A-Za-z0-9]{16,}` + WE, "gu") },
  { name: "slack-token", rx: new RegExp(WB + String.raw`xox[abposr]-[A-Za-z0-9_-]{10,}` + WE, "gu") },
  { name: "google-key", rx: new RegExp(WB + String.raw`AIza[0-9A-Za-z_-]{30,}` + WE, "gu") },
  { name: "aws-access-key", rx: new RegExp(WB + String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}` + WE, "gu") },
  { name: "bearer-token", rx: new RegExp(WB + String.raw`bearer\s+[A-Za-z0-9._-]{20,}`, "giu") },
  {
    name: "jwt",
    rx: new RegExp(
      WB + String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` + WE,
      "gu",
    ),
  },
  {
    name: "private-key",
    rx: new RegExp(
      String.raw`-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----`,
      "g",
    ),
  },
  // Generic `KEY=value` / `"token": "value"` assignments in env dumps & JSON.
  {
    name: "credential-assignment",
    rx: new RegExp(
      WB +
        String.raw`([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"',}]{8,})`,
      "giu",
    ),
  },
];

/** Placeholder keeps the shape of the output intact. */
const REDACTED = "[已脱敏]";

/**
 * Scrub credentials from tool output.
 *
 * Returns `[cleaned_text, count, kinds]` — kinds lists the pattern names hit.
 */
export function redact_secrets(text: unknown): [unknown, number, string[]] {
  if (!pyTruth(text) || typeof text !== "string") {
    return [text, 0, []];
  }
  let total = 0;
  const kinds: string[] = [];
  let cleaned: string = text;

  for (const { name, rx } of SECRET_PATTERNS) {
    let n: number;
    if (name === "credential-assignment") {
      // Preserve the key name, redact only the value. NOTE(kept): the source
      // always emits `=` here, even when the matched text used `:`.
      let count = 0;
      cleaned = cleaned.replace(rx, (_whole: string, g1: string) => {
        count += 1;
        return `${g1}=${REDACTED}`;
      });
      n = count;
    } else {
      [cleaned, n] = subnStr(rx, cleaned, REDACTED);
    }
    if (n > 0) {
      total += n;
      kinds.push(name);
    }
  }
  return [cleaned, total, kinds];
}

/** POST hook: strip credentials from a tool result before it enters context. */
export function secret_redaction_hook(
  _tool_name: string,
  payload: unknown,
  _context: JsonDict,
): HookOutcome | null {
  if (typeof payload !== "string") {
    return null;
  }
  const [cleaned, count, kinds] = redact_secrets(payload);
  if (!count) {
    return null;
  }
  return HookOutcome.sanitize(cleaned as string, count, "secret-redaction:" + kinds.join(","));
}

// ── Tool-result anti-injection ──────────────────────────────────────────────

/**
 * Tier A — tags that essentially never occur in legitimate output; any
 * occurrence is neutralized wherever it appears. `\w+` (antml:) is Unicode
 * like Python's; no /m needed (no ^/$).
 */
const INJECTION_TAG_STRICT = new RegExp(
  String.raw`<\s*/?\s*(
    tool_call|tool_calls|tool_result|tool_results|tool_use
    |function_call|function_calls|function_result|function_results
    |system-reminder|system_reminder|system_prompt|systemprompt
    |antml:[\p{L}\p{N}_]+
    |\|?im_start\|?|\|?im_end\|?|\|?endoftext\|?|\|?eot_id\|?
    |\|?start_header_id\|?|\|?end_header_id\|?
  )(?:\s[^>]*)?\s*/?>`.replace(/\n\s*/g, ""),
  "giu",
);

/**
 * Tier B — ordinary English words that are ALSO prompt-framing tags; only
 * rewritten in the shape an injection actually takes: the tag alone on its
 * own line. See header: re.M emulated without /m (JS /m would also match
 * before \r, which Python's `$` does not).
 */
const INJECTION_TAG_LOOSE = new RegExp(
  String.raw`(?:^|(?<=\n))[ \t]*(<\s*/?\s*(?:system|assistant|user|human|instructions?|important_instructions)(?:\s[^>]*)?\s*/?>)[ \t]*(?=\n|$)`,
  "gi",
);

/** Full-width lookalikes keep the text readable while making it inert. */
const LT_FULL = "\uff1c"; // ＜
const GT_FULL = "\uff1e"; // ＞

/** Swap the outer `<`/`>` of one tag for full-width variants. */
function neutralizeTag(text: string): string {
  return LT_FULL + text.slice(1, -1) + GT_FULL;
}

/**
 * Neutralize prompt-framing tags smuggled in through tool output.
 * Returns `[cleaned_text, count]`.
 */
export function sanitize_injection_tags(text: unknown): [unknown, number] {
  if (!pyTruth(text) || typeof text !== "string") {
    return [text, 0];
  }
  let cleaned: string = text;
  let strictHits = 0;
  cleaned = cleaned.replace(INJECTION_TAG_STRICT, (whole: string) => {
    strictHits += 1;
    return neutralizeTag(whole);
  });
  let looseHits = 0;
  cleaned = cleaned.replace(INJECTION_TAG_LOOSE, (whole: string, g1: string) => {
    looseHits += 1;
    // python str.replace replaces ALL occurrences (here group(1) can occur
    // only once inside group(0), so replaceAll == replace-as-str semantics).
    return whole.replaceAll(g1, neutralizeTag(g1));
  });
  return [cleaned, strictHits + looseHits];
}

/** POST hook: defang control tags in a tool result before it enters context. */
export function anti_injection_hook(
  _tool_name: string,
  payload: unknown,
  _context: JsonDict,
): HookOutcome | null {
  if (typeof payload !== "string") {
    return null;
  }
  const [cleaned, count] = sanitize_injection_tags(payload);
  if (!count) {
    return null;
  }
  return HookOutcome.sanitize(cleaned as string, count, `anti-injection:${count}`);
}

// ── Destructive command guard ───────────────────────────────────────────────

/**
 * Shell shapes that are catastrophic and effectively never intended; vetoed
 * outright rather than escalated to a confirmation. Each `.search` becomes a
 * non-global RegExp.test (fresh object not needed — no /g, no lastIndex).
 */
const CATASTROPHIC: ReadonlyArray<{ rx: RegExp; what: string }> = [
  {
    rx: new RegExp(
      WB +
        String.raw`rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|` +
        WB +
        String.raw`rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]`,
      "u",
    ),
    what: "递归强制删除",
  },
  {
    rx: new RegExp(
      WB + String.raw`(?:format|mkfs(?:\.[\p{L}\p{N}_]+)?)` + WE + String.raw`\s+(?:/dev/|[a-zA-Z]:)`,
      "iu",
    ),
    what: "格式化磁盘",
  },
  { rx: new RegExp(WB + String.raw`dd\s+.*` + WB + String.raw`of=/dev/`, "iu"), what: "裸写块设备" },
  {
    rx: new RegExp(WB + String.raw`Remove-Item` + WE + String.raw`.*-Recurse.*-Force`, "iu"),
    what: "递归强制删除",
  },
  { rx: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/i, what: "fork 炸弹" },
  { rx: new RegExp(WB + String.raw`chmod\s+(-R\s+)?777\s+/\s*$`, "iu"), what: "根目录权限放开" },
  {
    rx: new RegExp(WB + String.raw`(?:drop\s+database|truncate\s+table)` + WE, "iu"),
    what: "删库/清表",
  },
];

/** Filesystem roots that must never be the target of a recursive delete. */
const ROOT_TARGETS = new RegExp(
  String.raw`(?:\s|^)(?:/|/\*|~|~/|~/\*|/home/?\*?|/usr/?\*?|/etc/?\*?|/var/?\*?|[A-Za-z]:\\?\*?|[A-Za-z]:\\\*)(?:\s|$)`,
);

/** PRE hook: veto catastrophic shell commands before they ever run. */
export function destructive_command_hook(
  tool_name: string,
  payload: unknown,
  _context: JsonDict,
): HookOutcome | null {
  if (
    !["bash", "shell_executor", "python_executor", "native_action_chain", "node_executor", "sql_executor"].includes(
      tool_name,
    )
  ) {
    return null;
  }
  const args: JsonDict = isPyDict(payload) ? payload : {};
  const cmd = pyStr(
    pyTruthGate([dictGet(args, "command"), dictGet(args, "cmd"), dictGet(args, "code")], ""),
  );
  if (!cmd) {
    return null;
  }

  // ── Layer 1: legacy quick table (kept intact) ──
  for (const { rx, what } of CATASTROPHIC) {
    if (rx.test(cmd)) {
      // A recursive delete scoped inside the workspace is normal work; only
      // veto when it reaches a filesystem root or home directory.
      if (what === "递归强制删除" && !ROOT_TARGETS.test(cmd)) {
        continue;
      }
      return HookOutcome.veto(
        `这条命令属于「${what}」，我不会执行——它的破坏是不可逆的，` +
          "确认弹窗也兜不住。要做类似的事，请把目标缩小到具体路径再说一次。",
        `destructive:${what}`,
      );
    }
  }

  // ── Layer 2: cross-interpreter classifier + denial cache ──
  const cache = getDenialCache();
  const keyText = payloadOf(tool_name, args);

  // 命中缓存 → 直接返回上次的理由，省掉重复弹窗
  const cached = cache.check(tool_name, keyText);
  if (cached !== null) {
    return HookOutcome.veto(
      `已拒绝过相同请求（${cached.what}）。同一命令不会重试，请换一种做法。`,
      `denial-cache:${cached.pattern}`,
    );
  }

  const verdict = classifyToolCall(tool_name, args);
  if (verdict.blocked) {
    cache.remember(tool_name, keyText, verdict);
    return HookOutcome.veto(
      `这条命令属于「${verdict.what}」（${verdict.interpreter}），` +
        "我不会执行——破坏不可逆。缩小目标范围或换一种方式。",
      `danger-classify:${verdict.pattern}`,
    );
  }
  // confirm 级别：返回 None 让 risk_control 走正常确认流程（tool_hooks 层
  // 只管 deny；confirm 交给已有的 RiskController）。
  return null;
}

/**
 * PRE hook: 按写入目标 + 写入内容判定是否放行。只 veto deny 档；confirm 档
 * 交给 RiskController 的确认流程。
 */
export function write_content_guard_hook(
  tool_name: string,
  payload: unknown,
  _context: JsonDict,
): HookOutcome | null {
  if (!["write_file", "edit_file"].includes(tool_name)) {
    return null;
  }
  const args: JsonDict = isPyDict(payload) ? payload : {};

  const cache = getDenialCache();
  const keyText = payloadOf(tool_name, args);
  const cached = cache.check(tool_name, keyText);
  if (cached !== null && cached.level === DENY) {
    return HookOutcome.veto(
      `已拒绝过相同写入（${cached.what}）。同一内容不会重试，请换一种做法。`,
      `denial-cache:${cached.pattern}`,
    );
  }

  const verdict = classifyToolCall(tool_name, args);
  if (verdict.blocked) {
    cache.remember(tool_name, keyText, verdict);
    return HookOutcome.veto(
      `这次写入的内容属于「${verdict.what}」，我不会落盘——` +
        "写下来再执行和直接执行是同一件事。请改掉这段内容再来。",
      `write-guard:${verdict.pattern}`,
    );
  }
  return null;
}

/** PRE hook: 物理全量交付门禁，拦截偷懒占位符（Phase 61 核心硬内化）。 */
export function full_scope_delivery_hook(
  tool_name: string,
  payload: unknown,
  _context: JsonDict,
): HookOutcome | null {
  if (!["write_file", "edit_file", "write_to_file", "replace_file_content"].includes(tool_name)) {
    return null;
  }
  const args: JsonDict = isPyDict(payload) ? payload : {};

  const codeSnippets: unknown[] = [
    dictGet(args, "CodeContent", ""),
    dictGet(args, "ReplacementContent", ""),
    dictGet(args, "content", ""),
    dictGet(args, "code", ""),
  ];

  try {
    for (const snippet of codeSnippets) {
      if (pyTruth(snippet) && typeof snippet === "string") {
        const [hasLazy, matched] = FullScopeDeliveryGuard.inspect_code(snippet);
        if (hasLazy) {
          return HookOutcome.veto(
            `代码中检测到偷工减料占位符「${matched}」。` +
              "本系统强制执行全量交付（Full-Scope Delivery）质量门禁，严禁提交半成品代码，请提供 100% 完整可运行的代码！",
            `full-scope-guard:${matched}`,
          );
        }
      }
    }
  } catch {
    // BROAD-SWALLOW verbatim: `except Exception: pass`.
  }
  return null;
}

const GIT_PUSH_RX = new RegExp(WB + String.raw`git\s+(?:-[^\s]+\s+)*push` + WE, "u");

/**
 * PRE hook: 密钥泄漏防护闸门 (P3-1)。
 * 1. git push 拦截：扫描 git diff --cached，高置信凭据即刻否决并输出报告。
 * 2. 写入类工具拦截：PEM 私钥块与高置信凭据一律 veto 阻止落盘。
 */
export function secret_leak_guard_hook(
  tool_name: string,
  payload: unknown,
  context: JsonDict,
): HookOutcome | null {
  const args: JsonDict = isPyDict(payload) ? payload : {};

  // 1. 检查 git push
  let isGitPush = false;
  if (tool_name === "git_push") {
    isGitPush = true;
  } else if (
    ["run_command", "shell_executor", "terminal", "bash", "shell", "exec"].includes(tool_name)
  ) {
    const cmd = pyStr(
      pyTruthGate(
        [dictGet(args, "command"), dictGet(args, "cmd"), dictGet(args, "CommandLine")],
        "",
      ),
    );
    if (GIT_PUSH_RX.test(cmd)) {
      isGitPush = true;
    }
  }

  if (isGitPush) {
    try {
      // BUG(port): the source evaluates `os.getcwd()` here although it never
      // imports os — when both gates below are falsy the NameError fires at
      // exactly this point and the SAME catch swallows it, skipping the
      // git-push scan. Reproduced, not fixed.
      let cwd: unknown = dictGet(context, "cwd");
      if (!pyTruth(cwd)) cwd = dictGet(args, "Cwd");
      if (!pyTruth(cwd)) {
        throw new Error("name 'os' is not defined");
      }
      const proc = spawnSync("git", ["diff", "--cached"], {
        cwd: pyStr(cwd),
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (proc.error) {
        // FileNotFoundError / TimeoutExpired equivalent → same except-pass.
        throw proc.error;
      }
      const cachedDiff = pyTruth(proc.stdout) ? (proc.stdout as string) : "";
      if (cachedDiff) {
        const matches = scanText(cachedDiff);
        const highMatches = matches.filter((m) => m.confidence === "high");
        if (highMatches.length) {
          const report = generateLeakReport(highMatches);
          return HookOutcome.veto(
            `检测到待推送的代码（git diff --cached）中包含高危私钥或凭据泄漏风险：\n${report}\n` +
              "已被安全闸门物理拦截！请撤销提交或清理敏感信息后再试。",
            "secret-leak-guard:git-push",
          );
        }
      }
    } catch {
      // BROAD-SWALLOW verbatim: `except Exception: pass`.
    }
  }

  // 2. 检查写入类工具
  if (["write_file", "edit_file", "write_to_file", "replace_file_content"].includes(tool_name)) {
    const codeSnippets: unknown[] = [
      dictGet(args, "CodeContent", ""),
      dictGet(args, "ReplacementContent", ""),
      dictGet(args, "content", ""),
      dictGet(args, "new_string", ""),
      dictGet(args, "code", ""),
    ];
    try {
      for (const snippet of codeSnippets) {
        if (pyTruth(snippet) && typeof snippet === "string") {
          const matches = scanText(snippet);
          const highMatches = matches.filter((m) => m.confidence === "high" || m.isPem);
          if (highMatches.length) {
            const top = highMatches[0] as (typeof highMatches)[number];
            return HookOutcome.veto(
              `写入内容检测到高风险私钥/凭据（${top.ruleName}），已强制拦截阻止落盘！\n` +
                `详情: ${top.reason} (行号: ${top.lineNumber})`,
              `secret-leak-guard:${top.ruleName}`,
            );
          }
        }
      }
    } catch {
      // BROAD-SWALLOW verbatim: `except Exception: pass`.
    }
  }

  return null;
}

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Declarative registry of pre / post / abort hooks keyed by tool pattern.
 * fnmatch glob; within a stage, higher priority runs first; a raising hook
 * is logged into the trail and skipped.
 */
export class ToolHookRegistry {
  private _hooks: Record<HookStage, Registration[]>;

  constructor(install_builtins: boolean = true) {
    this._hooks = { pre: [], post: [], abort: [] };
    if (install_builtins) {
      this.register(HookStage.POST, "*", secret_redaction_hook, "secret-redaction", 100);
      // Anti-injection runs at lower priority than redaction so secrets
      // are scrubbed first; both are independent single-pass rewrites.
      this.register(HookStage.POST, "*", anti_injection_hook, "anti-injection", 90);
      this.register(HookStage.PRE, "*", destructive_command_hook, "destructive-guard", 100);
      // P3-1: Secret leak guard runs at high priority before writes and git pushes
      this.register(HookStage.PRE, "*", secret_leak_guard_hook, "secret-leak-guard", 98);
      // Write-content guard runs alongside; matches only write_file/edit_file
      // internally so the "*" pattern is cheap for other tools.
      this.register(HookStage.PRE, "*", write_content_guard_hook, "write-content-guard", 95);
      // Full-scope delivery gate: blocks lazy TODO and unfinished placeholders
      this.register(HookStage.PRE, "*", full_scope_delivery_hook, "full-scope-guard", 92);
    }
  }

  /** Attach a hook to a stage for tools matching `pattern`. */
  register(
    stage: HookStage | string,
    pattern: string,
    fn: HookFn,
    label = "",
    priority = 0,
  ): void {
    const s = coerceStage(stage);
    this._hooks[s].push({
      pattern,
      fn,
      label: label || fn.name || "hook",
      priority,
    });
    // python sort(key=lambda r: -r.priority) — descending priority, stable.
    this._hooks[s].sort((a, b) => b.priority - a.priority);
  }

  unregister(stage: HookStage | string, fn: HookFn): void {
    const s = coerceStage(stage);
    this._hooks[s] = this._hooks[s].filter((r) => r.fn !== fn);
  }

  clear(stage?: HookStage | string | null): void {
    if (stage === null || stage === undefined) {
      for (const key of Object.keys(this._hooks) as HookStage[]) {
        this._hooks[key] = [];
      }
    } else {
      this._hooks[coerceStage(stage)] = [];
    }
  }

  private _matching(stage: HookStage, toolName: string): Registration[] {
    return this._hooks[stage].filter((r) => fnmatchPy(toolName, r.pattern));
  }

  /**
   * Run PRE hooks.
   * `{blocked, reason, args, trail}` — args is the possibly-rewritten dict.
   */
  run_pre(tool_name: string, args: JsonDict, context: JsonDict): JsonDict {
    let current = args;
    const trail: JsonDict[] = [];
    for (const reg of this._matching(HookStage.PRE, tool_name)) {
      const outcome = this._safe_call(reg, tool_name, current, context, trail);
      if (outcome === null) {
        continue;
      }
      trail.push({
        stage: "pre",
        label: outcome.label || reg.label,
        blocked: outcome.blocked,
        reason: outcome.reason,
      });
      if (outcome.blocked) {
        return { blocked: true, reason: outcome.reason, args: current, trail };
      }
      if (outcome.replace_args !== null) {
        current = outcome.replace_args;
      }
    }
    return { blocked: false, reason: "", args: current, trail };
  }

  /**
   * Run POST hooks on the result text before it enters the context.
   * `{content, redactions, trail}`.
   */
  run_post(tool_name: string, content: string, context: JsonDict): JsonDict {
    let current = content;
    let redactions = 0;
    const trail: JsonDict[] = [];
    for (const reg of this._matching(HookStage.POST, tool_name)) {
      const outcome = this._safe_call(reg, tool_name, current, context, trail);
      if (outcome === null) {
        continue;
      }
      trail.push({
        stage: "post",
        label: outcome.label || reg.label,
        redactions: outcome.redactions,
      });
      if (outcome.replace_content !== null) {
        current = outcome.replace_content;
      }
      redactions += outcome.redactions;
    }
    return { content: current, redactions, trail };
  }

  /**
   * Run ABORT hooks when a call is cancelled mid-flight.
   * `{notes, trail}` — recovery hints worth putting in the transcript.
   */
  run_abort(tool_name: string, args: JsonDict, context: JsonDict): JsonDict {
    const notes: string[] = [];
    const trail: JsonDict[] = [];
    for (const reg of this._matching(HookStage.ABORT, tool_name)) {
      const outcome = this._safe_call(reg, tool_name, args, context, trail);
      if (outcome === null) {
        continue;
      }
      trail.push({ stage: "abort", label: outcome.label || reg.label, reason: outcome.reason });
      if (pyTruth(outcome.reason)) {
        notes.push(outcome.reason);
      }
    }
    return { notes, trail };
  }

  /** Call a hook, converting any exception into a logged skip. */
  private _safe_call(
    reg: Registration,
    toolName: string,
    payload: unknown,
    context: JsonDict,
    trail: JsonDict[],
  ): HookOutcome | null {
    try {
      return reg.fn(toolName, payload, context);
    } catch (exc) {
      trail.push({
        stage: "error",
        label: reg.label,
        reason: exc instanceof Error ? exc.message : pyStr(exc),
      });
      return null;
    }
  }

  /** Export the registry for the settings UI / audit view. */
  describe(): Record<HookStage, JsonDict[]> {
    const out = {} as Record<HookStage, JsonDict[]>;
    for (const stage of Object.keys(this._hooks) as HookStage[]) {
      out[stage] = this._hooks[stage].map((r) => ({
        pattern: r.pattern,
        label: r.label,
        priority: r.priority,
      }));
    }
    return out;
  }
}

// ── Global registry singleton ───────────────────────────────────────────────

let _registry: ToolHookRegistry | null = null;

/** Get the process-wide hook registry (built-ins installed on first use). */
export function get_tool_hooks(): ToolHookRegistry {
  if (_registry === null) {
    _registry = new ToolHookRegistry();
  }
  return _registry;
}

/** Rebuild the registry from scratch (tests). */
export function reset_tool_hooks(): ToolHookRegistry {
  _registry = new ToolHookRegistry();
  return _registry;
}

// PORT STATUS: confidence=high todos=[0]
