/**
 * confirm_meta.ts — 确认停点的场景语义载荷（U 波次：确认弹窗场景化）。
 *
 * Ported from `app/backend/confirm_meta.py` (192 lines, wave-6 TS).
 *
 * ## 解决什么
 *
 * 确认停点此前只有一个自然语言 prompt（`block_reason`）：前端审批卡看得见
 * "要你确认"，看不见"为什么是这一档"、"以后都允许"能不能买断。本模块把
 * guard 层已有的裁决（gui_action_classifier 裸档 + U2 场景地板）**同源重算**
 * 成结构化字段，附在确认停点的 meta 上——判定逻辑零新增：这里只做
 * gui_action_classifier 纯函数的只读编排，与 cua_actions.check_permission、
 * make_gui_action_guard_layer 消费同一套词表与合成定律。
 *
 * ## meta 字段契约（tool_result 帧 / 停点 Result.meta）
 *
 *   · confirm_reason      guard 层拦截原因原文。handoff 停点例外：带的是
 *                         guard 层对移交类的标准理由（与 check_permission /
 *                         action-guard 同一文案公式），ask 的确认 prompt 语声
 *                         （"回复同意我就继续"）不能当驳回理由展示。
 *   · scenario_tags       detect_scenario_tags 同源重算（SCENARIO_TAGS 固定序）。
 *                         仅 GUI/computer_* 动作视图可得；拿不到就省略，绝不编造。
 *   · confirmation_class  裸档 tier 按映射约定合成（OK→standard / AWARE→
 *                         pre_approval / CONFIRM→always_confirm / HANDOFF→
 *                         handoff，词表见 CONFIRMATION_CLASSES）；动作规格显式
 *                         声明了非 standard 政策类时以声明为准。
 *   · allow_always        bool。"以后都允许"按钮的置灰依据：handoff / 必弹场景
 *                         （ALWAYS_CONFIRM_SCENARIOS）/ 裸档 CONFIRM → false；
 *                         可预批准场景与无场景信息 → true（与既有 prompt 里
 *                         「以后都允许」要约的语义一致）。
 *   · handoff             仅裁决为 HANDOFF 档时置 true；该动作停成 denied 而
 *                         不是 needs_confirmation——移交人这件事没有"批准"可选。
 *
 * 非 GUI 工具（shell / 文件读写等）拿不到动作视图：meta 只带 confirm_reason
 * 与 allow_always=true，scenario_tags / confirmation_class / handoff 一律省略。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/confirm_meta.py -> app/engine/confirm_meta.ts.
 *       Public python names (snake_case) and the meta dict key names kept verbatim.
 *   §2  every truth gate goes through the shared §M mirror (py_truth / py_or):
 *       `str(r or "")`, `if tags:`, `reasons or []`, `context or {}`,
 *       `str(spec.confirmation_class or "standard") ... or "standard"`.
 *       §M py_truth is NaN-TRUEY (CPython `bool(float('nan')) is True`) —
 *       证据 tmp/cfmt_oracle_facts.json F3_reason_nan（confirm_reason="nan"）。
 *   §2  `str(...)` spelling goes through §M py_str/py_float_repr: nan→"nan",
 *       inf→"inf", 2.0→"2.0", True→"True", containers via repr.
 *       证据 F3_reason_nan / F3_reason_inf / F3_reason_two_float / F3_reason_true /
 *       F3_reason_dict_one / F3_reason_bytes_two。
 *   §2  `args.get("action")` returns a stored null for present-but-null, not the
 *       default — §M py_dict_get (non-dict receiver → PyAttributeErrorP('get')).
 *   §2  `{k: v for k, v in (context or {}).items() ...}` on a non-mapping
 *       (str/list/None-after-or) raises AttributeError('... object has no
 *       attribute 'items'') and the exception LEAKS out of build_confirm_meta —
 *       there is no try around the fallback. dictItems() reproduces the raise
 *       on §M PyAttributeErrorP/py_type_name. 证据 F5_nodetect_* / F5_absent_*
 *       （'str'/'list'/'int'/'bool' object has no attribute 'items'）。
 *   §2  `spec.name == action_name` / `spec.guard_tool` / `spec.confirmation_class`
 *       / `spec.scenario_tags` / `spec.name` are ATTRIBUTE lookups: §M py_getattr
 *       raises PyAttributeErrorP exactly where python does (inside the generator
 *       → caught by except Exception → spec=None; outside → leaks out of
 *       _action_view). No more "undefined keeps scanning" divergence.
 *   §2  `tier is Tier.HANDOFF`: str-Enum members hash/compare by value
 *       (same finding as gui_action_classifier §2), so `===` on the exported
 *       string constants carries the identity semantics here.
 *   §2  TIER_TO_CONFIRMATION_CLASS is keyed by Tier members; a value-keyed
 *       Record is equivalent (str-Enum hashing finding, 证据
 *       F7_tier_isinstance_str=[true,true,true,true]).
 *   §2  meta key INSERTION ORDER is part of the contract (the dict is dumped
 *       into Result.meta): confirm_reason → scenario_tags → confirmation_class
 *       → (handoff → confirm_reason-overwrite → allow_always) | allow_always.
 *       JS objects, like python dicts, keep the original slot when an existing
 *       key is reassigned, so the HANDOFF overwrite of confirm_reason stays in
 *       position exactly as in python. 证据 F6_order_handoff /
 *       F6_order_handoff_noreason / F6_order_normal。
 *   §2  whitespace: `.strip()` everywhere is §M py_strip (CPython isspace set:
 *       strips 0x1c-0x1f/0x85/0xa0/0x3000…, does NOT strip U+FEFF / U+200B),
 *       never JS `.trim()`. 证据 F1_strip_bom_sandwich / F1_strip_rs_only /
 *       F1_strip_unit_sep_pad / F1_strip_nel_pad / F1_strip_zwsp_pad。
 *   §2  `.lower()` is §M py_lower (UCP 27-codepoint preservation law).
 *   §2  `[:_REASON_MAX_CHARS]` slices UNICODE CODE POINTS, not UTF-16 units:
 *       pyHead() iterates Array.from (same law as §M py_iter/str-iteration).
 *       证据 F2_astral_900（meta 尾部 [128512,128512]，800 码点）。
 *   §2  `tuple(iterable)` iterates through §M py_iter (array / string -> code
 *       points / Set / Map keys / plain object keys; non-iterable raises
 *       PyTypeErrorP with CPython wording `'X' object is not iterable`).
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, lazy import seam): python resolves `from cua_actions import
 *       ACTION_SPECS` / `_detect_ctx_of` at CALL time inside try/except Exception
 *       (module missing → spec=None → fields omitted; `_detect_ctx_of` missing →
 *       dict-comprehension fallback). cua_actions is still python-side (wave-6
 *       Native), so TS consumes it through an injectable provider
 *       (set_cua_actions_provider). An unset provider throws at the same point
 *       the ImportError would, and every call site catches exactly like python,
 *       so the omitted-field and fallback behaviours are bit-for-bit reachable.
 *       证据 F10_*（std/absent/nodetect/empty × cua/gui/shell 全矩阵两侧一致）。
 *   DIVERGENCE(port, keyword-only args): python `build_confirm_meta(tool, args,
 *       *, block_reason="", context=None)` has KEYWORD-ONLY params after `*`;
 *       JS has no kwargs, so callers pass a trailing plain-object bag
 *       ({ block_reason, context }) and the port VALIDATES it like CPython's
 *       binder: non-object 3rd positional → `takes 2 positional arguments but 3
 *       were given`, unknown key → `got an unexpected keyword argument '<k>'`,
 *       missing arity → `missing N required positional arguments: ...`.
 *       The exact CPython wordings are reproduced from tmp/cfmt_oracle_facts.json
 *       F8_build_* / F8_handoff_* / F8_view_* (arity battery ar# rows).
 *   The per-field guards stay pure: build_confirm_meta performs no I/O, raises
 *   no error for the shapes real callers pass, and never fabricates a field it
 *   cannot honestly derive (view=None → only confirm_reason + allow_always).
 */

import {
    ALWAYS_CONFIRM_SCENARIOS,
    CONFIRMATION_CLASSES,
    GUI_TOOLS,
    Tier,
    classify_action,
    detect_scenario_tags,
    escalate_tiers,
    resolve_confirmation_tier,
    type GUIActionVerdict,
    type TierValue,
} from "./gui_action_classifier.js";
import {
    py_truth as pyTruth,
    py_or as pyOr,
    py_str as pyStr,
    py_type_name as pyTypeName,
    py_dict_get as pyDictGet,
    py_getattr as pyGetattr,
    py_iter as pyIter,
    py_strip as pyStrip,
    py_lower as pyLower,
    PyAttributeErrorP,
    PyTypeErrorP,
} from "./server/http_server_keys.js";

// ── python-semantics helpers (house style: built ON the §M mirror, no private
//    copies of py_strip/ntpath/truthiness — RULEBOOK §M single-source law) ────

/** python `obj.items()` as an ATTRIBUTE: non-dict receiver raises AttributeError
 *  ('str'/'list' object has no attribute 'items'). Leaks through the
 *  build_confirm_meta fallback exactly like python (F5_*). Built on §M
 *  PyAttributeErrorP + py_type_name. */
function dictItems(obj: unknown): Array<[string, unknown]> {
    if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
        throw new PyAttributeErrorP(obj, "items");
    }
    return Object.entries(obj as Record<string, unknown>);
}

/** python `s[:n]` — a CODE-POINT prefix (F2_astral_900: the tail of the reason
 *  is [128512,128512], i.e. astral pairs count as ONE char, UTF-16 units do not). */
function pyHead(s: string, n: number): string {
    return Array.from(s).slice(0, n).join("");
}

/** CPython binder wordings (F8_* verbatim). The faces in the case table exercise
 *  exactly these shapes; the join keeps CPython's `'a' and 'b'` two-name form. */
function pyMissing(fn: string, names: string[]): never {
    const n = names.length;
    const quoted = names.map((x) => `'${x}'`);
    const list = n === 1 ? quoted[0] : `${quoted.slice(0, n - 1).join(", ")} and ${quoted[n - 1]}`;
    throw new PyTypeErrorP(`${fn}() missing ${n} required positional argument${n === 1 ? "" : "s"}: ${list}`);
}

function pyTooMany(fn: string, allowed: number, given: number): never {
    throw new PyTypeErrorP(`${fn}() takes ${allowed} positional argument${allowed === 1 ? "" : "s"} but ${given} were given`);
}

function pyUnexpectedKw(fn: string, key: string): never {
    throw new PyTypeErrorP(`${fn}() got an unexpected keyword argument '${key}'`);
}

/** the trailing kwargs bag of a keyword-only python signature must be a plain
 *  object; anything else is a positional 3rd arg and the binder rejects it. */
function kwargsBag(fn: string, raw: unknown, allowed: string[]): Record<string, unknown> {
    if (raw === undefined) return {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) pyTooMany(fn, 2, 3);
    const bag = raw as Record<string, unknown>;
    for (const k of Object.keys(bag)) {
        if (!allowed.includes(k)) pyUnexpectedKw(fn, k);
    }
    return bag;
}

type JsonDict = Record<string, unknown>;

// ── cua_actions 惰性导入缝 ───────────────────────────────────────────────────

/** python `import cua_actions` 的最小视图：只用到这两个名字。 */
export interface CuaActionsModule {
    ACTION_SPECS?: unknown;
    _detect_ctx_of?: (ctx: JsonDict) => unknown;
}

export type CuaActionsProvider = () => CuaActionsModule;

let _cua_provider: CuaActionsProvider | null = null;

/** 注入 cua_actions 模块提供者（测试与宿主接线用）；null 恢复"模块不存在"。 */
export function set_cua_actions_provider(provider: CuaActionsProvider | null): void {
    _cua_provider = provider;
}

/** python `from cua_actions import ...`：未接线/模块缺失时抛 ImportError 同位
 *  异常，被两侧消费点的 except Exception / catch 捕获，行为与 python 对齐。 */
function _importCuaActions(): CuaActionsModule {
    if (_cua_provider === null) {
        throw new Error("ModuleNotFoundError: No module named 'cua_actions'");
    }
    return _cua_provider();
}

/** python `from cua_actions import NAME`：名字缺失抛 ImportError 同位异常；
 *  存在但为 null 时如实返回 null（后续迭代/调用处再抛 TypeError），两个消费
 *  点的 except Exception / catch 把两类异常都收成 python 同款行为。 */
function _moduleAttr(mod: CuaActionsModule, name: string): unknown {
    if (!(name in (mod as object))) {
        throw new Error(`ImportError: cannot import name '${name}' from 'cua_actions'`);
    }
    return (mod as Record<string, unknown>)[name];
}

// ── 常量（与 python 逐字对齐） ───────────────────────────────────────────────

/** CUA 动作层入口工具名（computer_agent 注册的唯一 CUA 门面工具）。
 *  它的 args 里带具体动作名（action=click/fill/...），动作视图按 ACTION_SPECS 解析。 */
export const CUA_ACTION_TOOL = "cua_action";

/** 裸档 tier → confirmation_class 映射约定（gui_action_classifier 词表注释同款）。 */
export const TIER_TO_CONFIRMATION_CLASS: Record<TierValue, string> = {
    ok: "standard",
    aware: "pre_approval",
    confirm: "always_confirm",
    handoff: "handoff",
};

/** HANDOFF 停点的标准理由前缀——与 cua_actions.check_permission（HANDOFF 分支）
 *  和 make_gui_action_guard_layer（action-guard:handoff）同一文案公式。 */
export const _HANDOFF_REASON_PREFIX = "这类动作需要用户亲手执行";

/** confirm_reason 的长度护栏——guard 原文照搬，但防极端参数把它撑爆。 */
const _REASON_MAX_CHARS = 800;

// ── 函数 ─────────────────────────────────────────────────────────────────────

/** 合成 HANDOFF 停点的驳回理由（guard 层标准语声，非编造）。
 *  rest-args 形态只为忠实复刻 CPython 绑定文案（F8_handoff_*）。 */
export function handoff_message(...callArgs: unknown[]): string {
    if (callArgs.length === 0) pyMissing("handoff_message", ["reasons"]);
    if (callArgs.length > 1) pyTooMany("handoff_message", 1, callArgs.length);
    const reasons = callArgs[0];
    const list = pyIter(pyOr(reasons, []));
    const clean: string[] = [];
    for (const r of list) {
        const s = pyStrip(pyStr(pyOr(r, "")));
        if (pyTruth(s)) clean.push(s);
    }
    if (pyTruth(clean)) {
        return `${_HANDOFF_REASON_PREFIX}（${clean.slice(0, 3).join("；")}）`;
    }
    return `${_HANDOFF_REASON_PREFIX}。`;
}

export interface ActionView {
    guard_tool: string;
    params: JsonDict;
    declared_class: string;
    declared_tags: unknown[];
    view_tool: string;
}

/** 把一次工具调用解析成动作分级视图（同源：ACTION_SPECS / GUI_TOOLS）。
 *  返回视图或 null（非 GUI/computer_* 域——拿不到视图就省略场景字段，绝不编造）。
 *  arity 守卫复刻源绑定（F8_view_*）。 */
export function _action_view(...callArgs: unknown[]): ActionView | null {
    if (callArgs.length < 1) pyMissing("_action_view", ["tool_name", "args"]);
    if (callArgs.length === 1) pyMissing("_action_view", ["args"]);
    if (callArgs.length > 2) pyTooMany("_action_view", 2, callArgs.length);
    let [tool_name, args] = callArgs as [unknown, unknown];
    if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};
    const tool = pyStrip(pyStr(pyOr(tool_name, "")));
    if (tool === CUA_ACTION_TOOL) {
        // cua_action 门面：按 args.action 解析到注册表动作规格，参数体去掉
        // 动作名本身——与 cua_actions.CuaActionRegistry.execute 同一拆包方式。
        const action_name = pyStrip(pyStr(pyOr(pyDictGet(args, "action"), "")));
        const params: JsonDict = {};
        for (const [k, v] of Object.entries(args as JsonDict)) {
            if (k !== "action") params[k] = v;
        }
        let spec: unknown = null;
        try {
            const mod = _importCuaActions();
            const specs = pyIter(_moduleAttr(mod, "ACTION_SPECS"));
            for (const s of specs) {
                // python `s.name == action_name`：缺 name 属性的成员在这里抛
                // AttributeError，被同一个 except 捕获 ⇒ 整个查找作废（spec=None）。
                if (pyGetattr(s, "name") === action_name) { spec = s; break; }
            }
        } catch {
            spec = null;
        }
        if (spec === null) return null;
        // python returns `str(spec.confirmation_class or "standard")` VERBATIM
        // here — the strip().lower() normalisation happens later, in
        // build_confirm_meta (av11 pins the un-normalised view field).
        return {
            guard_tool: pyGetattr(spec, "guard_tool") as string,
            params,
            declared_class: pyStr(pyOr(pyGetattr(spec, "confirmation_class"), "standard")),
            declared_tags: [...pyIter(pyOr(pyGetattr(spec, "scenario_tags"), [] as unknown[]))],
            view_tool: pyGetattr(spec, "name") as string,
        };
    }
    if (GUI_TOOLS.has(tool)) {
        return {
            guard_tool: tool,
            params: args as JsonDict,
            declared_class: "standard",
            declared_tags: [],
            view_tool: tool,
        };
    }
    return null;
}

/**
 * 确认停点的结构化 meta。纯函数：不落库、不发事件、不改任何状态。
 *
 * keyword-only 参数（block_reason / context）走尾部 plain-object 包（见文件头
 * DIVERGENCE(port, keyword-only args)），键名/缺省/异常文案与 CPython 绑定一致。
 *
 * 返回对象仅包含可诚实给出的字段：
 *   - confirm_reason 恒在（原文非空时；handoff 停点为 guard 标准理由）；
 *   - scenario_tags / confirmation_class 仅动作视图可得时存在；
 *   - allow_always 恒在（bool）；
 *   - handoff 仅裁决为 HANDOFF 档时存在且恒 true。
 */
export function build_confirm_meta(...callArgs: unknown[]): JsonDict {
    if (callArgs.length < 1) pyMissing("build_confirm_meta", ["tool_name", "args"]);
    if (callArgs.length === 1) pyMissing("build_confirm_meta", ["args"]);
    const tool_name = callArgs[0];
    const args = callArgs[1];
    const opts = kwargsBag("build_confirm_meta", callArgs.length > 2 ? callArgs[2] : undefined,
        ["block_reason", "context"]);
    if (callArgs.length > 3) pyTooMany("build_confirm_meta", 2, callArgs.length);

    const block_reason: unknown = Object.prototype.hasOwnProperty.call(opts, "block_reason")
        ? opts.block_reason : "";
    const context: unknown = Object.prototype.hasOwnProperty.call(opts, "context")
        ? opts.context : null;

    const meta: JsonDict = {};

    const reason = pyStrip(pyStr(pyOr(block_reason, "")));
    if (pyTruth(reason)) {
        meta["confirm_reason"] = pyHead(reason, _REASON_MAX_CHARS);
    }

    const view = _action_view(tool_name, args);
    if (view === null) {
        // 无场景信息：与现状等价——"以后都允许"不被本模块置灰。
        meta["allow_always"] = true;
        return meta;
    }

    // 场景标签：spec 静态声明 + 参数语料现检，与 cua_actions.check_permission
    // 完全同源（含 ctx 控制键剔除）。ctx 里拿不到或判定器弃权（空元组）→ 省略。
    let tags: unknown[] = [...view.declared_tags];
    let detect_ctx: unknown;
    try {
        const fn = _moduleAttr(_importCuaActions(), "_detect_ctx_of");
        detect_ctx = (fn as (ctx: JsonDict) => unknown)(
            context !== null && typeof context === "object" && !Array.isArray(context)
                ? context as JsonDict : {});
    } catch {
        const src = pyOr(context, {});
        const fb: JsonDict = {};
        for (const [k, v] of dictItems(src)) {
            if (k !== "pre_approval_source") fb[k] = v;
        }
        detect_ctx = fb;
    }
    tags = tags.concat(detect_scenario_tags(view.view_tool, view.params, detect_ctx));
    if (pyTruth(tags)) {
        meta["scenario_tags"] = [...tags];
    }

    // 裸档（classify_action 对非 GUI guard 工具恒 OK 空裁决——不编造）。
    const verdict: GUIActionVerdict = classify_action(view.guard_tool, view.params);

    // confirmation_class：规格显式声明的非 standard 政策类优先，否则按裸档
    // tier 映射约定合成。declared 归一化与 python 同位（视图字段是原文）。
    const declared = pyLower(pyStrip(pyStr(pyOr(view.declared_class, "standard")))) || "standard";
    const cls = CONFIRMATION_CLASSES.has(declared) && declared !== "standard"
        ? declared : TIER_TO_CONFIRMATION_CLASS[verdict.tier];
    meta["confirmation_class"] = cls;

    // 最终档：场景地板 × 裸档取高（合成定律，预批准在停点视角一律未获得——
    // 预批准只能由下一次交互产生，不能由本停点自证）。
    const floor = resolve_confirmation_tier(cls, tags, false);
    const tier = escalate_tiers(verdict.tier, floor);

    if (tier === Tier.HANDOFF) {
        meta["handoff"] = true;
        // guard 标准理由覆盖 ask 语声的 block_reason：确认 prompt（"回复同意
        // 我就继续"）不能当移交理由展示。
        meta["confirm_reason"] = handoff_message(verdict.reasons);
        meta["allow_always"] = false;
        return meta;
    }

    // "以后都允许"的发言权：handoff / 必弹场景 / 裸档 CONFIRM（合成类
    // always_confirm）买不动；可预批准场景与无雷区命中 → true。
    const must_confirm = (
        cls === "handoff" || cls === "always_confirm"
        || tags.some((t) => ALWAYS_CONFIRM_SCENARIOS.has(t as string))
    );
    meta["allow_always"] = !must_confirm;
    return meta;
}

// PORT STATUS: confidence=high todos=[0]
