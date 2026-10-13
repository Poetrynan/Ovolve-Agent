/**
 * providers/index.ts — IM platform providers for bot remote control.
 *
 * Ported from `app/backend/providers/__init__.py` (56 lines).
 * RULEBOOK §4: package `__init__.py` -> `index.ts`.
 *
 * Concrete providers are imported lazily so that a missing optional
 * dependency or an unconfigured platform never breaks the package import.
 *
 * Adding a platform means two edits here plus the provider module itself:
 * register the id in `_REGISTRY` and, if it takes inbound webhooks, add a
 * route in `server/http_server.py`. Everything downstream — controller
 * dispatch, message logging, the settings UI status list — reads off this
 * registry.
 *
 * RULEBOOK CITATIONS
 *   §2  behaviour: `(platform or "").lower()` falsy gate AND the non-str
 *       AttributeError (an int platform id dies on .lower() before the
 *       registry lookup); the ValueError message interpolates the ORIGINAL
 *       platform value, not the lowered key; dict-like lookup is a Map so a
 *       "__proto__" key misses exactly like python.
 *   DIVERGENCE(port): `__import__` is synchronous, dynamic `import()` is not
 *       — get_provider becomes async (call sites already live in async
 *       bot/controller code; mirrors the pick_backend precedent).
 *   DIVERGENCE(port): py `**kwargs` becomes a single options object — the TS
 *       provider constructors take `(kwargs: JsonDict)` and pull their named
 *       fields from it, so forwarding stays byte-identical for every call
 *       shape the registry serves.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { IMProvider } from "./base.js";

type JsonDict = Record<string, unknown>;

/** py attribute access on a module namespace: missing name -> AttributeError. */
class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "AttributeError";
    }
}

class ValueErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}

/** python truthiness for the `(platform or "")` gate: None/False/0/""/[]/{}
 *  are all falsy and take the empty-string branch. */
function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v as object).length > 0;
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    return "dict";
}

/** python `str(x)` for f-string interpolation. */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "nan";
        if (v === Infinity) return "inf";
        if (v === -Infinity) return "-inf";
        return String(v);
    }
    if (typeof v === "string") return v;
    try { return JSON.stringify(v) ?? "None"; } catch { return String(v); }
}

/** platform id -> (module, class name). Lazy on purpose: importing every
 *  provider up front would drag optional deps into the boot path of a user
 *  who only ever configures one platform. Key order is the UI display order:
 *  the two platforms that shipped first stay first. */
const _REGISTRY = new Map<string, [string, string]>([
    ["telegram", ["telegram_provider", "TelegramProvider"]],
    ["feishu", ["feishu_provider", "FeishuProvider"]],
    ["dingtalk", ["dingtalk_provider", "DingTalkProvider"]],
    ["wecom", ["wecom_provider", "WeComProvider"]],
    ["slack", ["slack_provider", "SlackProvider"]],
    ["discord", ["discord_provider", "DiscordProvider"]],
]);

/** List the platform ids this package can construct. */
export function available_providers(): string[] {
    return [..._REGISTRY.keys()];
}

/** Construct a provider by platform id.
 *
 *  Args:
 *    platform: One of `available_providers()`.
 *    kwargs: Forwarded to the provider constructor.
 *
 *  Raises ValueError (name preserved) when the platform id is unknown;
 *  py `getattr(module, class_name)` miss becomes AttributeError. */
export async function get_provider(platform: unknown, kwargs: JsonDict = {}): Promise<IMProvider> {
    let key: string;
    if (!pyTruth(platform)) {
        // py: (None or "").lower() / (0 or "").lower() -> "" -> ValueError
        key = "";
    } else if (typeof platform === "string") {
        key = platform.toLowerCase();
    } else {
        // py: (5 or "").lower() -> AttributeError: 'int' object has no attribute 'lower'
        throw new AttributeErrorP(
            `'${pyTypeName(platform)}' object has no attribute 'lower'`);
    }
    const entry = _REGISTRY.get(key);
    if (entry === undefined) {
        throw new ValueErrorP(`Unknown IM platform: ${pyStr(platform)}`);
    }
    const [moduleFile, className] = entry;
    const spec = `./${moduleFile}.js`;
    const mod = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
    const ctor = mod[className];
    if (typeof ctor !== "function") {
        throw new AttributeErrorP(
            `module 'providers.${moduleFile}' has no attribute '${className}'`);
    }
    return new (ctor as new (kw: JsonDict) => IMProvider)(kwargs);
}

export { IMProvider };

// PORT STATUS: confidence=high todos=[0]
