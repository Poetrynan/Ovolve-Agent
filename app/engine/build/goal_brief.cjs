"use strict";
/**
 * goal_brief.ts 鈥?structured Goal Brief contract and category derivation.
 *
 * Ported from `app/backend/goal_brief.py` (334 lines).
 *
 * Every goal entering the system MUST carry a GoalBrief that the router and
 * scheduler can inspect without parsing free-text prompts. This is the canonical
 * shape for "what should be done", distinct from the GoalManager lifecycle state
 * machine ("is it done yet").
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/goal_brief.py -> app/engine/goal_brief.ts
 *   搂2  `str, Enum` -> const object + union, values preserved
 *   搂2  dataclass -> class; `asdict`/`from_dict` -> toDict/fromDict
 *   搂2  string slicing counts CODE POINTS in Python; Array.from reproduces it
 *   搂2  `except ValueError` -> membership check, same fallback
 *
 * PORT STATUS: confidence=high todos=0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalBrief = exports.AcceptanceContract = exports.CATEGORY_DEFAULTS = exports.GoalCategory = void 0;
exports.deriveGoalCategory = deriveGoalCategory;
exports.buildBriefFromPrompt = buildBriefFromPrompt;
/** Derived goal taxonomy 鈥?each maps to a default agent profile and cost cap. */
exports.GoalCategory = {
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
};
const ALL_CATEGORIES = Object.values(exports.GoalCategory);
/** Default constraints per category. */
exports.CATEGORY_DEFAULTS = {
    [exports.GoalCategory.CODE]: { maxIter: 15, costCapMicros: 500_000, agent: "file_agent" },
    [exports.GoalCategory.RESEARCH]: { maxIter: 8, costCapMicros: 200_000, agent: "search_agent" },
    [exports.GoalCategory.FILE_OPS]: { maxIter: 10, costCapMicros: 100_000, agent: "file_agent" },
    [exports.GoalCategory.SYSTEM]: { maxIter: 5, costCapMicros: 150_000, agent: "computer_agent" },
    [exports.GoalCategory.BROWSER]: { maxIter: 10, costCapMicros: 300_000, agent: "browser_agent" },
    [exports.GoalCategory.CREATIVE]: { maxIter: 6, costCapMicros: 400_000, agent: null },
    [exports.GoalCategory.GOAL_MGMT]: { maxIter: 3, costCapMicros: 50_000, agent: null },
    [exports.GoalCategory.UNKNOWN]: { maxIter: 10, costCapMicros: 300_000, agent: null },
};
class AcceptanceContract {
    version;
    goalId;
    deliverables;
    acceptanceCriteria;
    requiredArtifacts;
    verificationPlan;
    allowedPaths;
    forbiddenPaths;
    humanAcceptanceRequired;
    outOfScope;
    maxIterations;
    constructor(f = {}) {
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
    toDict() {
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
     * RULEBOOK 搂2 (sentinel returns / falsy fallback): every field is read with
     * `or`, so an empty string or empty list falls through to the next key and
     * then to the default. Reproduced with `??`-style chaining that also treats
     * falsy values the same way.
     */
    static fromDict(d) {
        let vplan = d["verificationPlan"] ?? d["verification_plan"] ?? [];
        if (typeof vplan === "string") {
            vplan = vplan ? [vplan] : [];
        }
        return new AcceptanceContract({
            version: String(d["version"] ?? "1"),
            goalId: d["goalId"] || d["goal_id"] || "",
            deliverables: d["deliverables"] || [],
            acceptanceCriteria: d["acceptanceCriteria"] || d["acceptance_criteria"] || [],
            requiredArtifacts: d["requiredArtifacts"] || d["required_artifacts"] || [],
            verificationPlan: vplan,
            allowedPaths: d["allowedPaths"] || d["allowed_paths"] || [],
            forbiddenPaths: d["forbiddenPaths"] || d["forbidden_paths"] || [],
            humanAcceptanceRequired: Boolean(d["humanAcceptanceRequired"] || d["human_acceptance_required"] || false),
            outOfScope: d["outOfScope"] || d["out_of_scope"] || [],
            // RULEBOOK 搂2: `int(x or 10)` 鈥?a missing or zero value becomes 10.
            maxIterations: Number(d["maxIterations"] || d["max_iterations"] || 10),
        });
    }
}
exports.AcceptanceContract = AcceptanceContract;
/**
 * Structured contract every goal must satisfy before scheduling.
 *
 * Validates completeness: summary and at least one deliverable are required. The
 * rest default to empty lists or empty strings so a minimal brief is still
 * expressible.
 */
class GoalBrief {
    summary;
    assumptions;
    deliverables;
    acceptanceCriteria;
    verificationPlan;
    outOfScope;
    designStyle;
    category;
    rawPrompt;
    constructor(f = {}) {
        this.summary = f.summary ?? "";
        this.assumptions = f.assumptions ?? [];
        this.deliverables = f.deliverables ?? [];
        this.acceptanceCriteria = f.acceptanceCriteria ?? [];
        this.verificationPlan = f.verificationPlan ?? "";
        this.outOfScope = f.outOfScope ?? [];
        this.designStyle = f.designStyle ?? "";
        this.category = f.category ?? exports.GoalCategory.UNKNOWN;
        this.rawPrompt = f.rawPrompt ?? "";
    }
    /**
     * Minimal completeness check.
     *
     * RULEBOOK 搂2: the source returns a `(bool, reason)` tuple. TS has no tuple
     * type with the same ergonomics, so this returns a readonly pair. Callers
     * destructure it the same way.
     */
    isValid() {
        if (!this.summary || !this.summary.trim()) {
            return [false, "summary is required"];
        }
        // RULEBOOK 搂2: Python `len(str)` counts code points; Array.from matches it
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
    toDict() {
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
    static fromDict(d) {
        const cat = d["category"] ?? "unknown";
        // RULEBOOK 搂2 (`except ValueError`): an unrecognised category falls back to
        // UNKNOWN rather than throwing. Reproduced as a membership test.
        const category = ALL_CATEGORIES.includes(cat)
            ? cat
            : exports.GoalCategory.UNKNOWN;
        return new GoalBrief({
            summary: d["summary"] ?? "",
            assumptions: d["assumptions"] || [],
            deliverables: d["deliverables"] || [],
            acceptanceCriteria: d["acceptanceCriteria"] || d["acceptance_criteria"] || [],
            verificationPlan: d["verificationPlan"] || d["verification_plan"] || "",
            outOfScope: d["outOfScope"] || d["out_of_scope"] || [],
            designStyle: d["designStyle"] || d["design_style"] || "",
            category,
            rawPrompt: d["rawPrompt"] || d["raw_prompt"] || "",
        });
    }
    /** Render the brief as a concise system-prompt block the agent sees. */
    systemContext() {
        const parts = [`## Goal: ${this.summary}`];
        if (this.assumptions.length) {
            parts.push("Assumptions: " + this.assumptions.join("; "));
        }
        if (this.deliverables.length) {
            parts.push("Deliverables: " + this.deliverables.join("; "));
        }
        if (this.acceptanceCriteria.length) {
            parts.push("Done when: " + this.acceptanceCriteria.join("; "));
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
    getDefaults() {
        return exports.CATEGORY_DEFAULTS[this.category] ?? exports.CATEGORY_DEFAULTS[exports.GoalCategory.UNKNOWN];
    }
}
exports.GoalBrief = GoalBrief;
/** Python's `len(str)` counts code points, not UTF-16 units. */
function codePointLength(s) {
    return Array.from(s).length;
}
/** Python's `s[:n]` slices by code point. */
function codePointSlice(s, n) {
    return Array.from(s).slice(0, n).join("");
}
// --------------------------------------------------------------------------- //
// Category derivation                                                          //
// --------------------------------------------------------------------------- //
/**
 * Keyword signals per category; order matters (first match wins when categories
 * tie, so more specific categories come first).
 */
const CATEGORY_SIGNALS = [
    [exports.GoalCategory.CODE, [
            "鍐欎唬鐮?, "鍐欐枃浠?, "瀹炵幇", "閲嶆瀯", "fix", "bug", "test", "娴嬭瘯",
            "缂栫爜", "浠ｇ爜", "function", "class", "缂栧啓", "淇敼浠ｇ爜", "review",
            "compile", "build", "lint", "鏍煎紡鍖?, "type check",
        ]],
    [exports.GoalCategory.BROWSER, [
            "娴忚鍣?, "鎵撳紑缃戦〉", "缃戠珯", "browser", "scrape", "navigate",
            "鐖彇", "濉〃", "form", "鎴浘", "screenshot", "缃戦〉",
        ]],
    [exports.GoalCategory.RESEARCH, [
            "鎼滅储", "search", "鏌ユ壘", "鐮旂┒", "compare", "瀵规瘮", "璋冪爺",
            "浜嗚В", "瀛︿範", "鏂囨。", "documentation", "wiki", "璁烘枃",
        ]],
    [exports.GoalCategory.SYSTEM, [
            "瀹夎", "install", "鍗歌浇", "uninstall", "杩涚▼", "process",
            "鏈嶅姟", "service", "绯荤粺", "docker", "閮ㄧ讲", "deploy", "鐜",
        ]],
    [exports.GoalCategory.FILE_OPS, [
            "鎵归噺", "batch", "rename", "閲嶅懡鍚?, "move", "绉诲姩", "鍘嬬缉",
            "compress", "convert", "杞崲", "copy", "澶嶅埗", "娓呯悊", "clean",
        ]],
    [exports.GoalCategory.CREATIVE, [
            "鍐欎綔", "write", "鏂囨", "鍗氬", "blog", "鐢诲浘", "鐢熸垚鍥?,
            "image", "缈昏瘧", "translate", "璁捐", "design", "鏂囩珷",
        ]],
    [exports.GoalCategory.GOAL_MGMT, [
            "璁″垝", "plan", "鎷嗗垎", "鍒嗚В", "goal", "鐩爣", "瀛愪换鍔?,
            "浼樺厛绾?, "priority", "鎺掓湡", "schedule",
        ]],
];
/** Deliverable patterns that strongly indicate a category regardless of keywords. */
const DELIVERABLE_PATTERNS = [
    [exports.GoalCategory.CODE, /\.(py|ts|tsx|js|jsx|rs|go|java|c|cpp|h)\b/i],
    [exports.GoalCategory.FILE_OPS, /\b(zip|tar|gz|csv|pdf|docx|xlsx)\b/i],
    [exports.GoalCategory.BROWSER, /https?:\/\//i],
];
/**
 * Infer a GoalCategory from textual cues.
 *
 * Scoring: each matching keyword adds 1 point. Deliverable pattern matches add 2.
 * Highest total wins. Tie-breaking: the category that appears first in
 * CATEGORY_SIGNALS wins, so more specific categories are preferred.
 */
function deriveGoalCategory(summary, deliverables, rawPrompt = "") {
    const text = `${summary} ${rawPrompt}`.toLowerCase();
    const deliverableText = (deliverables ?? []).join(" ").toLowerCase();
    const scores = new Map();
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
        return exports.GoalCategory.UNKNOWN;
    }
    // First category with bestScore wins (preserves CATEGORY_SIGNALS order).
    for (const [cat] of CATEGORY_SIGNALS) {
        if (scores.get(cat) === bestScore) {
            return cat;
        }
    }
    return exports.GoalCategory.UNKNOWN;
}
/**
 * Sentence terminators for summary extraction. CJK marks (銆傦紒锛? are
 * unambiguous, but a bare ASCII "." is usually part of a token in this domain
 * ("router.py", "1.5", "v2.0"), so it only counts as a terminator when followed
 * by whitespace or end-of-string. Without that guard, "閲嶆瀯 router.py 鐨勫伐鍏峰垎鍙?
 * became the summary "閲嶆瀯 router." 鈥?a truncated filename that also poisoned
 * category derivation, since the `.py` signal is what marks it as a code goal.
 */
const SENTENCE_END = /[銆傦紒锛焅n]|[.!?](?=\s|$)/;
/**
 * Build a minimal GoalBrief heuristically from a plain-language prompt.
 *
 * This is the fast path that doesn't require an LLM call. For a richer brief,
 * the router can call the LLM with a structured extraction prompt and then
 * `GoalBrief.fromDict` the result.
 */
function buildBriefFromPrompt(prompt) {
    const m = SENTENCE_END.exec(prompt);
    let summary;
    if (m && m.index < 140) {
        summary = codePointSlice(prompt, m.index + m[0].length).trim();
    }
    else {
        summary = codePointSlice(prompt, 140).trim();
        if (codePointLength(prompt) > 140) {
            summary += "鈥?;
        }
    }
    // Category is derived from the FULL prompt, not just the summary: the signal
    // that decides the category is often in a later sentence.
    const category = deriveGoalCategory(summary, null, prompt);
    return new GoalBrief({
        summary,
        deliverables: ["瀹屾垚鐢ㄦ埛璇锋眰鐨勪换鍔?],
        category,
        rawPrompt: prompt,
    });
}
