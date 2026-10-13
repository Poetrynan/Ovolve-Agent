/**
 * tool_policy.ts — Composable multi-layer tool authorization pipeline (B4).
 *
 * Ported from `app/backend/tool_policy.py` (369 lines, wave-5 TS).
 * Ends the "permission combination explosion" problem: instead of one big
 * if/else in RiskController, authorization walks an ordered pipeline of small,
 * labelled layers. Each layer returns allow / ask / deny (or abstains). The
 * first layer that returns a non-allow verdict wins, and every step is recorded
 * in an audit trail so we can answer "why was this blocked?".
 *
 * Layer order (least-specific → most-specific, first non-allow wins):
 *     profile → provider-profile → global → global-provider → agent →
 *     agent-provider → group → sender → sandbox → subagent → inherited
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/tool_policy.py -> app/engine/tool_policy.ts.
 *   §2  `str, Enum` in CPython 3.13 hashes by VALUE (verified live:
 *       `hash(PolicyAction.ASK) == hash("ask")` and `"ask" in _STRICTNESS` is
 *       True), so a raw string and the enum member are interchangeable as keys
 *       and as `==` operands. That is what lets the members be plain string
 *       constants here: `action === PolicyAction.ASK` has exactly python's
 *       operand set for `==`, and `_layers` / `_STRICTNESS` key lookups match
 *       python's dict behaviour. Two things strings still cannot do are carry
 *       `.value` and render like a member under `str()`; both are pinned as
 *       representation divergences below (probe scenarios e6b / e21 / e22 / e23,
 *       where e23 is `register("global", fn)`: python raises AttributeError on
 *       `layer.value` before the entry is ever stored).
 *   §2  every truthiness gate goes through pyTruth (python `label or
 *       layer.value`, `if who:`, `bool(writers)`, `reason or f"..."`).
 *   §2  present-but-null: `context.get(key, default)` is dictGet, so a key
 *       present with a null value yields null, not the default.
 *   §2  dataclass `field(default_factory=dict)` allocates a FRESH object per
 *       instance (no shared-default aliasing) — same here.
 *   §2  `PolicyDecision.to_dict()` reads `self.action.value` / `self.layer.value`,
 *       so a decision carrying a NON-member crashes with
 *       `AttributeError: '<type>' object has no attribute 'value'`. `enumValue()`
 *       reproduces that: it returns the value for anything inside the enum's
 *       value set and throws the same AttributeError text otherwise. Because the
 *       audit-trail write happens BEFORE the strictness lookup, that crash is
 *       what a bad verdict actually produces on both sides.
 *   §2  `_STRICTNESS[decision.action]` therefore stays unreachable through
 *       `evaluate()` (the KeyError needs a member, and every member is a key);
 *       the lookup is kept verbatim, including python's short-circuit in
 *       `winner is None or _STRICTNESS[...] > ...` which never looks the table
 *       up for the FIRST non-allow verdict.
 *   §2  `sorted(set)` is code-point order — Array.sort()'s default matches for
 *       BMP strings, which is the whole reachable set for writer names.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, enum identity): a `class X(str, Enum)` member is BOTH a str
 *       and an object with `.value`, so python can tell `PolicyAction.ASK` apart
 *       from the literal `"ask"` — `to_dict()` and `register()`'s
 *       `label or layer.value` read `.value`, so a literal crashes there while
 *       the member does not. Here the members are the literal strings (see the
 *       §2 finding above), so that distinction cannot be carried. Equivalence
 *       argument: the two representations agree on every value a member can hold
 *       (`to_dict()` publishes `member.value`, i.e. the same string), the port
 *       still rejects anything outside each enum's value set with python's own
 *       AttributeError text, and the surviving difference is only observable if
 *       a caller hands a verdict or a layer in as a raw literal instead of the
 *       exported constant — which no producer in this tree does. Pinned as
 *       SKIP(repr-divergent): e6b (str(member)), e21, e22, e23.
 *   DIVERGENCE(port, exception reach): python's `except Exception` leaves
 *       BaseException (KeyboardInterrupt/SystemExit) escaping the layer; node
 *       has no such split, so every throw is turned into the fail-safe DENY.
 *       No python-style exit-signal path exists in the engine, so nothing that
 *       could reach it differs.
 *   DIVERGENCE(port, `f"{exc}"`): python renders an exception with one arg as
 *       that arg and with several as the tuple repr; Error.message is the single
 *       string the TS throw site supplies. The parity probe pins the
 *       `policy layer error: <message>` envelope with a one-arg error on both
 *       sides, which is the only shape a layer factory in this tree raises.
 *   Enums are const-object unions rather than TS `enum` because python's values
 *       are the wire/audit strings ("provider-profile", "command"), which a TS
 *       numeric enum could not carry.
 */

// ── python-semantics helpers (house style: file-local) ───────────────────────

class KeyErrorP extends Error {
    constructor(key: string) {
        super(`'${key}'`);
        this.name = "KeyError";
    }
}

class AttributeErrorP extends Error {
    constructor(obj: unknown, attr = "value") {
        super(`'${pyTypeName(obj)}' object has no attribute '${attr}'`);
        this.name = "AttributeError";
    }
}

/** python `type(x).__name__` for the shapes this module can be handed. */
function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (typeof v === "function") return v.name || "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

function dictGet(dict: unknown, key: string, dflt: unknown = null): unknown {
    if (dict !== null && typeof dict === "object" && !Array.isArray(dict) &&
        key in (dict as Record<string, unknown>)) {
        return (dict as Record<string, unknown>)[key];
    }
    return dflt;
}

/** python `str(exc)` for the exception types a layer can raise. */
function pyStrExc(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

type JsonDict = Record<string, unknown>;

// ── layers & actions ─────────────────────────────────────────────────────────

/** The ordered authorization layers. String values double as audit labels. */
export const PolicyLayer = {
    PROFILE: "profile",
    PROVIDER_PROFILE: "provider-profile",
    GLOBAL: "global",
    GLOBAL_PROVIDER: "global-provider",
    AGENT: "agent",
    AGENT_PROVIDER: "agent-provider",
    GROUP: "group",
    SENDER: "sender",
    SANDBOX: "sandbox",
    SUBAGENT: "subagent",
    COMMAND: "command",
    INHERITED: "inherited",
} as const;
export type PolicyLayerValue = (typeof PolicyLayer)[keyof typeof PolicyLayer];

/** Canonical evaluation order. The pipeline walks layers in this sequence. */
export const LAYER_ORDER: PolicyLayerValue[] = [
    PolicyLayer.PROFILE,
    PolicyLayer.PROVIDER_PROFILE,
    PolicyLayer.GLOBAL,
    PolicyLayer.GLOBAL_PROVIDER,
    PolicyLayer.AGENT,
    PolicyLayer.AGENT_PROVIDER,
    PolicyLayer.GROUP,
    PolicyLayer.SENDER,
    PolicyLayer.SANDBOX,
    PolicyLayer.SUBAGENT,
    PolicyLayer.COMMAND,
    PolicyLayer.INHERITED,
];

// COMMAND sits between SUBAGENT and INHERITED on purpose. It grades the
// *content* of a command ("is this dangerous?"), so:
//   * after SUBAGENT — a sub-agent's own denylist is a narrower, more specific
//     rule and should be seen first;
//   * before INHERITED — the walk treats DENY as terminal and CLEAR as only able
//     to downgrade a prior ASK, so this ordering gives exactly the behaviour we
//     want: a RESTRICTED command cannot be unlocked by a standing grant, while a
//     merely REVIEW-worthy one can be cleared by the user having already granted
//     that class of permission.

/**
 * A single layer's verdict. Strictness order: ALLOW < ASK < DENY.
 *
 * CLEAR is special: it explicitly cancels a prior ASK (but not DENY), used by
 * the "granted-permission" layer so an earlier ask can be overridden by a later
 * explicit allow. The pipeline must only treat CLEAR as lowering ASK→ALLOW; it
 * cannot touch DENY.
 */
export const PolicyAction = {
    ALLOW: "allow",
    ASK: "ask",
    DENY: "deny",
    CLEAR: "clear",
} as const;
export type PolicyActionValue = (typeof PolicyAction)[keyof typeof PolicyAction];

const POLICY_LAYER_VALUES = new Set<string>(Object.values(PolicyLayer));
const POLICY_ACTION_VALUES = new Set<string>(Object.values(PolicyAction));

/**
 * python's `x.value` on an enum member. A member's value is what `to_dict`
 * publishes, and anything that is not a member has no `value` attribute at all
 * (CPython raises `AttributeError: '<type>' object has no attribute 'value'`),
 * so the domain check is what keeps `to_dict` honest here.
 */
function enumValue(v: string, domain: Set<string>): string {
    if (typeof v === "string" && domain.has(v)) return v;
    throw new AttributeErrorP(v);
}

/** Numeric strictness so we can ratchet: a later layer may raise but not lower. */
const STRICTNESS = new Map<string, number>([
    [PolicyAction.ALLOW, 0],
    [PolicyAction.ASK, 1],
    [PolicyAction.DENY, 2],
    [PolicyAction.CLEAR, -1],
]);

/** `_STRICTNESS[action]` — unknown action raises KeyError, exactly like python. */
function strictness(action: string): number {
    if (!STRICTNESS.has(action)) throw new KeyErrorP(action);
    return STRICTNESS.get(action) as number;
}

// ── request / decision / result records ──────────────────────────────────────

/** Everything a layer needs to make a decision. Read-only by convention. */
export class PolicyRequest {
    tool_name: string;
    args: JsonDict | null;
    context: JsonDict | null;
    risk_level: string;   // low / medium / high, as classified upstream
    provider: string;     // llm provider id, for provider-scoped layers
    agent: string;        // owning agent role, for agent-scoped layers

    constructor(tool_name: string, args?: JsonDict | null,
                context?: JsonDict | null, risk_level = "",
                provider = "", agent = "") {
        // dataclass default_factory=dict fires only when the argument is
        // OMITTED: `PolicyRequest("t", None)` really stores None, and a layer
        // that then does `context.get(...)` gets python's AttributeError.
        this.tool_name = tool_name;
        this.args = args === undefined ? {} : args;
        this.context = context === undefined ? {} : context;
        this.risk_level = risk_level;
        this.provider = provider;
        this.agent = agent;
    }

    /** Read a context flag (session_id, is_remote, is_subagent, ...). */
    flag(key: string, dflt: unknown = null): unknown {
        if (this.context === null || this.context === undefined) {
            throw new AttributeErrorP(this.context, "get");
        }
        return dictGet(this.context, key, dflt);
    }
}

/** A layer's verdict plus the label/reason that produced it (for audit). */
export class PolicyDecision {
    action: string;
    layer: string;
    label: string;
    reason: string;

    constructor(action: string, layer: string, label = "", reason = "") {
        this.action = action;
        this.layer = layer;
        this.label = label;
        this.reason = reason;
    }

    get is_allow(): boolean {
        return this.action === PolicyAction.ALLOW;
    }

    to_dict(): JsonDict {
        return {
            "action": enumValue(this.action, POLICY_ACTION_VALUES),
            "layer": enumValue(this.layer, POLICY_LAYER_VALUES),
            "label": this.label,
            "reason": this.reason,
        };
    }
}

/** A layer is any callable that inspects a request and optionally objects. */
export type PolicyLayerFn = (req: PolicyRequest) => PolicyDecision | null;

/** Final verdict of a full pipeline walk, with the complete audit trail. */
export class PipelineResult {
    action: string;
    decision: PolicyDecision | null;   // the winning (strictest) decision
    trail: JsonDict[];

    constructor(action: string, decision: PolicyDecision | null = null,
                trail: JsonDict[] | null = null) {
        this.action = action;
        this.decision = decision;
        this.trail = trail ?? [];
    }

    get allowed(): boolean {
        return this.action === PolicyAction.ALLOW;
    }

    get reason(): string {
        return this.decision !== null ? this.decision.reason : "";
    }

    get label(): string {
        return this.decision !== null ? this.decision.label : "";
    }
}

// ── the pipeline ─────────────────────────────────────────────────────────────

/**
 * Ordered, composable set of authorization layers.
 *
 * Register a callable against a :data:`PolicyLayer`; ``evaluate`` walks the
 * layers in :data:`LAYER_ORDER`, collecting every non-abstaining verdict into
 * an audit trail and returning the strictest one. ``deny`` short-circuits the
 * walk (nothing can override a hard deny); ``ask`` keeps walking in case a
 * later layer escalates to ``deny``.
 */
export class ToolPolicyPipeline {
    /** layer -> ordered list of [label, fn]; multiple fns per layer allowed. */
    _layers: Map<string, [string, PolicyLayerFn][]>;

    constructor() {
        this._layers = new Map();
    }

    /**
     * Attach a decision function to a layer.
     *
     * @param layer Which pipeline stage this function belongs to.
     * @param fn `(request) -> PolicyDecision | null`. None = abstain.
     * @param label Short human tag for the audit trail (defaults to layer name).
     */
    register(layer: string, fn: PolicyLayerFn, label = ""): void {
        if (!this._layers.has(layer)) this._layers.set(layer, []);
        // python's `label or layer.value` short-circuits, so `.value` — and the
        // AttributeError it can raise — is only reached when label is falsy.
        const effective = pyTruth(label) ? label : enumValue(layer, POLICY_LAYER_VALUES);
        (this._layers.get(layer) as [string, PolicyLayerFn][]).push([effective, fn]);
    }

    /** Remove all functions for a layer, or the whole pipeline when None. */
    clear(layer: string | null = null): void {
        if (layer === null || layer === undefined) {
            this._layers.clear();
        } else {
            this._layers.delete(layer);
        }
    }

    /**
     * Walk every layer in order and return the strictest verdict.
     *
     * A ``deny`` from any layer terminates the walk immediately. A ``CLEAR``
     * from a later layer downgrades a prior ``ASK`` back to ``ALLOW`` (but
     * cannot rescue a ``DENY``). Otherwise the strictest verdict across all
     * layers wins; ties keep the earliest layer.
     */
    evaluate(request: PolicyRequest): PipelineResult {
        const trail: JsonDict[] = [];
        let winner: PolicyDecision | null = null;

        for (const layer of LAYER_ORDER) {
            for (const [label, fn] of (this._layers.get(layer) ?? [])) {
                let decision: PolicyDecision | null;
                try {
                    decision = fn(request);
                } catch (exc) {
                    // a broken layer must fail safe (deny)
                    decision = new PolicyDecision(PolicyAction.DENY, layer, label,
                        `policy layer error: ${pyStrExc(exc)}`);
                }
                if (decision === null || decision === undefined) continue;
                // Normalize the label/layer so callers always see consistent data.
                decision.layer = layer;
                decision.label = pyOr(decision.label, label);
                trail.push(decision.to_dict());

                if (decision.action === PolicyAction.CLEAR) {
                    // CLEAR downgrades an earlier ASK → ALLOW. Has no effect if
                    // no prior ASK exists, or if the prior was DENY (untouchable).
                    if (winner !== null && winner.action === PolicyAction.ASK) {
                        winner = null;
                    }
                    continue;
                }

                if (decision.is_allow) continue;  // explicit allow is just an abstain that got logged

                // First non-allow, or a stricter verdict than what we have.
                if (winner === null || strictness(decision.action) > strictness(winner.action)) {
                    winner = decision;
                }

                if (decision.action === PolicyAction.DENY) {
                    // Hard deny is terminal — stop the whole walk.
                    return new PipelineResult(PolicyAction.DENY, winner, trail);
                }
            }
        }

        return new PipelineResult(winner !== null ? winner.action : PolicyAction.ALLOW, winner, trail);
    }
}

// --------------------------------------------------------------------------- //
// Built-in layer factories                                                    //
// --------------------------------------------------------------------------- //

/**
 * Build the GLOBAL layer from RiskController's existing risk table.
 *
 * Keeps the least-privilege table as the baseline policy: low risk allows,
 * anything needing approval asks. This lets RiskController delegate its core
 * logic to the pipeline without changing behavior.
 *
 * @param classify `(tool_name, args) -> "low"|"medium"|"high"`.
 * @param needs_approval `(tool_name, args) -> bool` from the active mode.
 */
export function make_global_risk_layer(
    classify: (tool_name: string, args: JsonDict | null) => string,
    needs_approval: (tool_name: string, args: JsonDict | null) => boolean,
): PolicyLayerFn {
    return function _layer(req: PolicyRequest): PolicyDecision | null {
        const level = classify(req.tool_name, req.args);
        if (!needs_approval(req.tool_name, req.args)) {
            return null;  // abstain — baseline is fine with it
        }
        return new PolicyDecision(PolicyAction.ASK, PolicyLayer.GLOBAL,
            `risk:${level}`, `${req.tool_name} is ${level}-risk and needs confirmation`);
    };
}

/** Build a hard-deny layer from a predicate (e.g. remote-session denylist). */
export function make_denylist_layer(
    layer: string,
    is_denied: (req: PolicyRequest) => boolean,
    label = "denylist",
    reason = "",
): PolicyLayerFn {
    return function _layer(req: PolicyRequest): PolicyDecision | null {
        if (is_denied(req)) {
            return new PolicyDecision(PolicyAction.DENY, layer, label,
                pyOr(reason, `'${req.tool_name}' denied by ${label}`) as string);
        }
        return null;
    };
}

/** The context flag the SANDBOX layer gates on. */
export const SANDBOX_READONLY_FLAG = "sandbox_readonly";

/**
 * Subsystems that have declared they can turn `sandbox_readonly` on.
 *
 * Why this exists: the SANDBOX layer below is registered in the pipeline and
 * reads like a working confinement layer, but nothing in the tree ever sets its
 * flag — `run_confined` has zero call sites and `sandbox.py` is imported by
 * nobody. A security layer that can never fire is worse than an absent one,
 * because the pipeline listing it makes everyone (including the next reader of
 * this file) believe confinement exists. Rather than hardcode "off" — which
 * would go stale the moment someone implements it — the flag's writer registers
 * itself here, and `sandbox_layer_status()` tells the truth either way.
 */
const _sandbox_flag_writers = new Set<string>();

/**
 * Declare that ``who`` sets ``sandbox_readonly`` on tool contexts.
 *
 * Call this from whatever finally implements confinement (e.g. the module that
 * runs tools inside a restricted interpreter). Once anything registers, the
 * startup warning and the settings-page notice disappear on their own.
 */
export function declare_sandbox_flag_writer(who: string): void {
    if (pyTruth(who)) _sandbox_flag_writers.add(who);
}

/** Whether the SANDBOX policy layer can actually deny anything. */
export function sandbox_layer_status(): JsonDict {
    const writers = [..._sandbox_flag_writers].sort();
    return {
        "registered": true,          // the layer is always installed
        "effective": pyTruth(writers),  // …but only decides if someone raises the flag
        "flag": SANDBOX_READONLY_FLAG,
        "writers": writers,
        "note": writers.length === 0 ? (
            "沙箱只读层已注册但当前不生效：没有任何代码设置 " +
            "`" + SANDBOX_READONLY_FLAG + "` 标志。工具的实际约束来自权限档位、" +
            "danger_classifier 与 path_guard，不要把这一层算进防护。"
        ) : "沙箱只读层生效中。",
    };
}

/**
 * SANDBOX layer: in a read-only sandbox, only whitelisted reads pass.
 *
 * Currently inert — see ``sandbox_layer_status``. Kept registered so the
 * pipeline's shape does not change when confinement lands.
 */
export function make_sandbox_layer(readonly_tools: Set<string>): PolicyLayerFn {
    return function _layer(req: PolicyRequest): PolicyDecision | null {
        if (!pyTruth(req.flag(SANDBOX_READONLY_FLAG))) return null;
        if (readonly_tools.has(req.tool_name) || req.risk_level === "low") return null;
        return new PolicyDecision(PolicyAction.DENY, PolicyLayer.SANDBOX, "sandbox:readonly",
            "sandbox is read-only; only read operations are allowed");
    };
}

/** SUBAGENT layer: subagents can't dispatch further or touch fenced tools. */
export function make_subagent_layer(denied_tools: Set<string>): PolicyLayerFn {
    return function _layer(req: PolicyRequest): PolicyDecision | null {
        if (!pyTruth(req.flag("is_subagent"))) return null;
        if (denied_tools.has(req.tool_name)) {
            return new PolicyDecision(PolicyAction.DENY, PolicyLayer.SUBAGENT, "subagent:fenced",
                `subagents may not call '${req.tool_name}'`);
        }
        return null;
    };
}

// PORT STATUS: confidence=high todos=[0]
