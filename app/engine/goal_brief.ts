/**
 * goal_brief.ts — structured Goal Brief contract and category derivation.
 *
 * Ported from `app/backend/goal_brief.py` (334 lines).
 *
 * Every goal entering the system MUST carry a GoalBrief that the router and
 * scheduler can inspect without parsing free-text prompts. This is the canonical
 * shape for "what should be done", distinct from the GoalManager lifecycle state
 * machine ("is it done yet").
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/goal_brief.py -> app/engine/goal_brief.ts
 *   §2  `str, Enum` -> const object + union, values preserved
 *   §2  dataclass -> class; `asdict`/`from_dict` -> toDict/fromDict
 *   §2  string slicing counts CODE POINTS in Python; Array.from reproduces it
 *   §2  `except ValueError` -> membership check, same fallback
 *
 * PORT STATUS: confidence=high todos=0
 */

/** Derived goal taxonomy — each maps to a default agent profile and cost cap. */
export const GoalCategory = {
  /** writing / editing / reviewing source code */
  CODE: "code",
  /** web search, reading docs, comparing options */
  RESEARCH: "research",
  /** bulk rename, move, compress, convert */
  FILE_OPS: "file-ops",
  /** shell commands, process management, install */
  SYSTEM: "system",
  /** navigation, scraping, form fill */
  BROWSER: "browser",
  /** writing prose, generating images */
  CREATIVE: "creative",
  /** meta: managing other goals, planning */
  GOAL_MGMT: "goal-mgmt",
  /** fallback when no signal matches */
  UNKNOWN: "unknown",
} as const;

export type GoalCategoryValue = (typeof GoalCategory)[keyof typeof GoalCategory];

const ALL_CATEGORIES: readonly GoalCategoryValue[] = Object.values(GoalCategory);

export interface CategoryDefaults {
  /** continuation cap */
  maxIter: number;
  /** hard spend limit (1 micro = $0.000001) */
  costCapMicros: number;
  agent: string | null;
}

/** Default constraints per category. */
export const CATEGORY_DEFAULTS: Record<GoalCategoryValue, CategoryDefaults> = {
  [GoalCategory.CODE]: { maxIter: 15, costCapMicros: 500_000, agent: "file_agent" },
  [GoalCategory.RESEARCH]: { maxIter: 8, costCapMicros: 200_000, agent: "search_agent" },
  [GoalCategory.FILE_OPS]: { maxIter: 10, costCapMicros: 100_000, agent: "file_agent" },
  [GoalCategory.SYSTEM]: { maxIter: 5, costCapMicros: 150_000, agent: "computer_agent" },
  [GoalCategory.BROWSER]: { maxIter: 10, costCapMicros: 300_000, agent: "browser_agent" },
  [GoalCategory.CREATIVE]: { maxIter: 6, costCapMicros: 400_000, agent: null },
  [GoalCategory.GOAL_MGMT]: { maxIter: 3, costCapMicros: 50_000, agent: null },
  [GoalCategory.UNKNOWN]: { maxIter: 10, costCapMicros: 300_000, agent: null },
};

/** Versioned Goal Acceptance Contract. */
export interface AcceptanceContractFields {
  version?: string;
  goalId?: string;
  deliverables?: string[];
  acceptanceCriteria?: string[];
  requiredArtifacts?: string[];
  verificationPlan?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  humanAcceptanceRequired?: boolean;
  outOfScope?: string[];
  maxIterations?: number;
}

export class AcceptanceContract {
  version: string;
  goalId: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  requiredArtifacts: string[];
  verificationPlan: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  humanAcceptanceRequired: boolean;
  outOfScope: string[];
  maxIterations: number;

  constructor(f: AcceptanceContractFields = {}) {
    this.version = f.version ?? "1";
    this.goalId = f.goalId ?? "";
    this.deliverables = f.deliverables ?? [];
    this.acceptanceCriteria = f.acceptanceCriteria ?? [];
    this.requiredArtifacts = f.requiredArtifacts ?? [];
    this.verificationPlan = f.verificationPlan ?? [];
    this.allowedPaths = f.allowedPaths ?? [];
    this.forbiddenPaths = f.forbiddenPaths ?? [];
    this.humanAcceptanceRequired = f.humanAcceptanceRequired ?? false;
    this.outOfScope = f.outOfScope ?? [];
    this.maxIterations = f.maxIterations ?? 10;
  }

  toDict(): Record<string, unknown> {
    return {
      version: this.version,
      goalId: this.goalId,
      deliverables: this.deliverables,
      acceptanceCriteria: this.acceptanceCriteria,
      requiredArtifacts: this.requiredArtifacts,
      verificationPlan: this.verificationPlan,
      allowedPaths: this.allowedPaths,
      forbiddenPaths: this.forbiddenPaths,
      humanAcceptanceRequired: this.humanAcceptanceRequired,
      outOfScope: this.outOfScope,
      maxIterations: this.maxIterations,
    };
  }

  /**
   * RULEBOOK §2 (sentinel returns / falsy fallback): every field is read with
   * `or`, so an empty string or empty list falls through to the next key and
   * then to the default. Reproduced with `??`-style chaining that also treats
   * falsy values the same way.
   */
  static fromDict(d: Record<string, unknown>): AcceptanceContract {
    let vplan = d["verificationPlan"] ?? d["verification_plan"] ?? [];
    if (typeof vplan === "string") {
      vplan = vplan ? [vplan] : [];
    }
    return new AcceptanceContract({
      version: String(d["version"] ?? "1"),
      goalId: (d["goalId"] as string) || (d["goal_id"] as string) || "",
      deliverables: (d["deliverables"] as string[]) || [],
      acceptanceCriteria:
        (d["acceptanceCriteria"] as string[]) || (d["acceptance_criteria"] as string[]) || [],
      requiredArtifacts:
        (d["requiredArtifacts"] as string[]) || (d["required_artifacts"] as string[]) || [],
      verificationPlan: vplan as string[],
      allowedPaths: (d["allowedPaths"] as string[]) || (d["allowed_paths"] as string[]) || [],
      forbiddenPaths:
        (d["forbiddenPaths"] as string[]) || (d["forbidden_paths"] as string[]) || [],
      humanAcceptanceRequired: Boolean(
        d["humanAcceptanceRequired"] || d["human_acceptance_required"] || false
      ),
      outOfScope: (d["outOfScope"] as string[]) || (d["out_of_scope"] as string[]) || [],
      // RULEBOOK §2: `int(x or 10)` — a missing or zero value becomes 10.
      maxIterations: Number(d["maxIterations"] || d["max_iterations"] || 10),
    });
  }
}

export interface GoalBriefFields {
  summary?: string;
  assumptions?: string[];
  deliverables?: string[];
  acceptanceCriteria?: string[];
  verificationPlan?: string;
  outOfScope?: string[];
  designStyle?: string;
  category?: GoalCategoryValue;
  /** Raw user prompt that produced this brief (for audit / re-derivation). */
  rawPrompt?: string;
}

/**
 * Structured contract every goal must satisfy before scheduling.
 *
 * Validates completeness: summary and at least one deliverable are required. The
 * rest default to empty lists or empty strings so a minimal brief is still
 * expressible.
 */
export class GoalBrief {
  summary: string;
  assumptions: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
  verificationPlan: string;
  outOfScope: string[];
  designStyle: string;
  category: GoalCategoryValue;
  rawPrompt: string;

  constructor(f: GoalBriefFields = {}) {
    this.summary = f.summary ?? "";
    this.assumptions = f.assumptions ?? [];
    this.deliverables = f.deliverables ?? [];
    this.acceptanceCriteria = f.acceptanceCriteria ?? [];
    this.verificationPlan = f.verificationPlan ?? "";
    this.outOfScope = f.outOfScope ?? [];
    this.designStyle = f.designStyle ?? "";
    this.category = f.category ?? GoalCategory.UNKNOWN;
    this.rawPrompt = f.rawPrompt ?? "";
  }

  /**
   * Minimal completeness check.
   *
   * RULEBOOK §2: the source returns a `(bool, reason)` tuple. TS has no tuple
   * type with the same ergonomics, so this returns a readonly pair. Callers
   * destructure it the same way.
   */
  isValid(): readonly [boolean, string] {
    if (!this.summary || !this.summary.trim()) {
      return [false, "summary is required"];
    }
    // RULEBOOK §2: Python `len(str)` counts code points; Array.from matches it
    // where `.length` (UTF-16 units) would not.
    const len = codePointLength(this.summary);
    if (len > 300) {
      return [false, `summary too long (${len} chars, max 300)`];
    }
    if (!this.deliverables || this.deliverables.length === 0) {
      return [false, "at least one deliverable is required"];
    }
    return [true, ""];
  }

  toDict(): Record<string, unknown> {
    return {
      summary: this.summary,
      assumptions: this.assumptions,
      deliverables: this.deliverables,
      acceptanceCriteria: this.acceptanceCriteria,
      verificationPlan: this.verificationPlan,
      outOfScope: this.outOfScope,
      designStyle: this.designStyle,
      category: this.category,
      rawPrompt: this.rawPrompt,
    };
  }

  static fromDict(d: Record<string, unknown>): GoalBrief {
    const cat = d["category"] ?? "unknown";
    // RULEBOOK §2 (`except ValueError`): an unrecognised category falls back to
    // UNKNOWN rather than throwing. Reproduced as a membership test.
    const category: GoalCategoryValue = ALL_CATEGORIES.includes(cat as GoalCategoryValue)
      ? (cat as GoalCategoryValue)
      : GoalCategory.UNKNOWN;
    return new GoalBrief({
      summary: (d["summary"] as string) ?? "",
      assumptions: (d["assumptions"] as string[]) || [],
      deliverables: (d["deliverables"] as string[]) || [],
      acceptanceCriteria:
        (d["acceptanceCriteria"] as string[]) || (d["acceptance_criteria"] as string[]) || [],
      verificationPlan:
        (d["verificationPlan"] as string) || (d["verification_plan"] as string) || "",
      outOfScope: (d["outOfScope"] as string[]) || (d["out_of_scope"] as string[]) || [],
      designStyle: (d["designStyle"] as string) || (d["design_style"] as string) || "",
      category,
      rawPrompt: (d["rawPrompt"] as string) || (d["raw_prompt"] as string) || "",
    });
  }

  /** Render the brief as a concise system-prompt block the agent sees. */
  systemContext(): string {
    const parts = [`## Goal: ${this.summary}`];
    if (pyTruth(this.assumptions)) {
      parts.push("Assumptions: " + pyJoinStr(this.assumptions, "; "));
    }
    if (pyTruth(this.deliverables)) {
      parts.push("Deliverables: " + pyJoinStr(this.deliverables, "; "));
    }
    if (pyTruth(this.acceptanceCriteria)) {
      parts.push("Done when: " + pyJoinStr(this.acceptanceCriteria, "; "));
    }
    if (this.verificationPlan) {
      parts.push(`Verify: ${this.verificationPlan}`);
    }
    if (this.outOfScope.length) {
      parts.push("Out of scope: " + this.outOfScope.join("; "));
    }
    if (this.designStyle) {
      parts.push(`Style: ${this.designStyle}`);
    }
    return parts.join("\n");
  }

  /** Category-derived defaults (maxIter, costCapMicros, agent). */
  getDefaults(): CategoryDefaults {
    return CATEGORY_DEFAULTS[this.category] ?? CATEGORY_DEFAULTS[GoalCategory.UNKNOWN];
  }
}

/** Python's `len(str)` counts code points, not UTF-16 units. */
function codePointLength(s: string): number {
  return Array.from(s).length;
}

// ── python-semantics helpers (added by the goal_manager parity round, unit
// 163: python's str.join semantics are observable through derive_goal_category
// and system_context) ────────────────────────────────────────────────────────

class TypeErrorP extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TypeError";
  }
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  if (v instanceof Set) return "set";
  if (typeof v === "function") return "function";
  if (typeof v === "object") {
    const ctor = (v as { constructor?: { name?: string } }).constructor;
    return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
  }
  return typeof v;
}

/** python truthiness: only dict-shaped values take the empty-container rule;
 *  a class instance is always True. */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Set) return v.size > 0;
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return Object.keys(v).length > 0;
    return true;
  }
  return true;
}

/** python `sep.join(iterable)`: a STRING iterates code points, a non-str
 *  element raises `sequence item N: expected str instance, <t> found`, dict
 *  keys are the elements, and a non-iterable raises `can only join an
 *  iterable`. */
function pyJoinStr(v: unknown, sep: string): string {
  if (typeof v === "string") return Array.from(v).join(sep);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] !== "string") {
        throw new TypeErrorP(`sequence item ${i}: expected str instance, ${pyTypeName(v[i])} found`);
      }
    }
    return (v as string[]).join(sep);
  }
  if (typeof v === "object" && v !== null) {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      return Object.keys(v as Record<string, unknown>).join(sep);
    }
    if (v instanceof Set) {
      const elems = Array.from(v);
      for (let i = 0; i < elems.length; i++) {
        if (typeof elems[i] !== "string") {
          throw new TypeErrorP(`sequence item ${i}: expected str instance, ${pyTypeName(elems[i])} found`);
        }
      }
      return (elems as string[]).join(sep);
    }
  }
  throw new TypeErrorP("can only join an iterable");
}

/** Python's `s[:n]` slices by code point. */
function codePointSlice(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

// --------------------------------------------------------------------------- //
// Category derivation                                                          //
// --------------------------------------------------------------------------- //

/**
 * Keyword signals per category; order matters (first match wins when categories
 * tie, so more specific categories come first).
 */
const CATEGORY_SIGNALS: ReadonlyArray<readonly [GoalCategoryValue, readonly string[]]> = [
  [GoalCategory.CODE, [
    "写代码", "写文件", "实现", "重构", "fix", "bug", "test", "测试",
    "编码", "代码", "function", "class", "编写", "修改代码", "review",
    "compile", "build", "lint", "格式化", "type check",
  ]],
  [GoalCategory.BROWSER, [
    "浏览器", "打开网页", "网站", "browser", "scrape", "navigate",
    "爬取", "填表", "form", "截图", "screenshot", "网页",
  ]],
  [GoalCategory.RESEARCH, [
    "搜索", "search", "查找", "研究", "compare", "对比", "调研",
    "了解", "学习", "文档", "documentation", "wiki", "论文",
  ]],
  [GoalCategory.SYSTEM, [
    "安装", "install", "卸载", "uninstall", "进程", "process",
    "服务", "service", "系统", "docker", "部署", "deploy", "环境",
  ]],
  [GoalCategory.FILE_OPS, [
    "批量", "batch", "rename", "重命名", "move", "移动", "压缩",
    "compress", "convert", "转换", "copy", "复制", "清理", "clean",
  ]],
  [GoalCategory.CREATIVE, [
    "写作", "write", "文案", "博客", "blog", "画图", "生成图",
    "image", "翻译", "translate", "设计", "design", "文章",
  ]],
  [GoalCategory.GOAL_MGMT, [
    "计划", "plan", "拆分", "分解", "goal", "目标", "子任务",
    "优先级", "priority", "排期", "schedule",
  ]],
];

/** Deliverable patterns that strongly indicate a category regardless of keywords. */
const DELIVERABLE_PATTERNS: ReadonlyArray<readonly [GoalCategoryValue, RegExp]> = [
  [GoalCategory.CODE, /\.(py|ts|tsx|js|jsx|rs|go|java|c|cpp|h)\b/i],
  [GoalCategory.FILE_OPS, /\b(zip|tar|gz|csv|pdf|docx|xlsx)\b/i],
  [GoalCategory.BROWSER, /https?:\/\//i],
];

/**
 * Infer a GoalCategory from textual cues.
 *
 * Scoring: each matching keyword adds 1 point. Deliverable pattern matches add 2.
 * Highest total wins. Tie-breaking: the category that appears first in
 * CATEGORY_SIGNALS wins, so more specific categories are preferred.
 */
export function deriveGoalCategory(
  summary: string,
  deliverables?: string[] | null,
  rawPrompt = ""
): GoalCategoryValue {
  const text = `${summary} ${rawPrompt}`.toLowerCase();
  // python `" ".join(deliverables or [])`: a STRING deliverables iterates
  // CHAR-BY-CHAR, a non-str element raises
  // `sequence item N: expected str instance, <t> found`, and a non-iterable
  // raises `can only join an iterable` (pinned by the goal_manager parity
  // probe, unit 163, scenario b07/b08).
  const dlRaw: unknown = deliverables ?? [];
  const deliverableText = pyJoinStr(dlRaw, " ").toLowerCase();

  const scores = new Map<GoalCategoryValue, number>();
  for (const [cat] of CATEGORY_SIGNALS) {
    scores.set(cat, 0);
  }

  // Keyword scoring.
  for (const [cat, keywords] of CATEGORY_SIGNALS) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        scores.set(cat, (scores.get(cat) ?? 0) + 1);
      }
    }
  }

  // Deliverable pattern bonus.
  for (const [cat, pattern] of DELIVERABLE_PATTERNS) {
    if (pattern.test(deliverableText) || pattern.test(text)) {
      scores.set(cat, (scores.get(cat) ?? 0) + 2);
    }
  }

  const bestScore = Math.max(...scores.values());
  if (bestScore === 0) {
    return GoalCategory.UNKNOWN;
  }

  // First category with bestScore wins (preserves CATEGORY_SIGNALS order).
  for (const [cat] of CATEGORY_SIGNALS) {
    if (scores.get(cat) === bestScore) {
      return cat;
    }
  }

  return GoalCategory.UNKNOWN;
}

/**
 * Sentence terminators for summary extraction. CJK marks (。！？) are
 * unambiguous, but a bare ASCII "." is usually part of a token in this domain
 * ("router.py", "1.5", "v2.0"), so it only counts as a terminator when followed
 * by whitespace or end-of-string. Without that guard, "重构 router.py 的工具分发"
 * became the summary "重构 router." — a truncated filename that also poisoned
 * category derivation, since the `.py` signal is what marks it as a code goal.
 */
const SENTENCE_END = /[。！？\n]|[.!?](?=\s|$)/;

/**
 * Build a minimal GoalBrief heuristically from a plain-language prompt.
 *
 * This is the fast path that doesn't require an LLM call. For a richer brief,
 * the router can call the LLM with a structured extraction prompt and then
 * `GoalBrief.fromDict` the result.
 */
export function buildBriefFromPrompt(prompt: string): GoalBrief {
  const m = SENTENCE_END.exec(prompt);
  let summary: string;
  if (m && m.index < 140) {
    summary = codePointSlice(prompt, m.index + m[0].length).trim();
  } else {
    summary = codePointSlice(prompt, 140).trim();
    if (codePointLength(prompt) > 140) {
      summary += "…";
    }
  }

  // Category is derived from the FULL prompt, not just the summary: the signal
  // that decides the category is often in a later sentence.
  const category = deriveGoalCategory(summary, null, prompt);

  return new GoalBrief({
    summary,
    deliverables: ["完成用户请求的任务"],
    category,
    rawPrompt: prompt,
  });
}
