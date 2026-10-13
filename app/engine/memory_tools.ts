/**
 * memory_tools.ts — the model's own hand for writing long-term memory.
 *
 * Ported from `app/backend/memory_tools.py` (146 lines, wave-9, unit 192).
 *
 * Why this exists
 * ---------------
 * Before this module the agent had **no way to keep a promise**. Memory was
 * injected into every prompt (five channels, see `router.get_system_prompt`) but
 * the only writers were (a) the settings page and (b) `memory_layer`'s debounced
 * extractor, which fires on file writes and never on conversation. So when a user
 * said "以后我想看电脑配置" the model would answer "知道了，下次直接这样查" — and
 * nothing anywhere recorded it. The next session started from zero.
 *
 * That is the worst kind of failure: the reply was *syntactically* a promise and
 * *semantically* a lie, and nothing in the system could tell the difference.
 *
 * The fix has two halves and this is the second one:
 *
 * 1. `system_prompt.md` P-06 forbids promising future behaviour unless the turn
 *    actually called something that writes it down.
 * 2. This tool is that something.
 *
 * Design notes
 * ------------
 * * **Tier defaults to LONG_TERM**, matching `handle_memory_entry_create`: a
 *   thing the user asked to be remembered must be *always-injected*, not left to
 *   retrieval scoring where it might simply never resurface.
 * * **Visible, not silent.** Unlike the debounced extractor, a tool call renders
 *   as a card in the UI, so the user sees the write happen. That visibility is the
 *   reason this is allowed to run without a separate confirmation step: the user
 *   asking to be remembered *is* the confirmation, and double-prompting for it
 *   would train them to click through prompts.
 * * **Returns what was actually stored**, not "ok". The model is required to
 *   describe only the line it really wrote, so it needs that line back.
 *
 * RULEBOOK CITATIONS
 *   §2  `len()` / slicing are code-point based → `pyLen` / `pySlice`; `str.strip()`
 *       / `str.rstrip()` use CPython's whitespace set → `pyStrip` / `pyRstrip`.
 *   §2  `min(1.0, max(0.0, x))` → `pyMin2` / `pyMax2`, NOT `Math.min`/`Math.max`:
 *       CPython's two-arg max/min keep the current value when the comparison is
 *       False, so `max(0.0, nan)` is `0.0` (and `float('nan')` therefore lands on
 *       importance 0.0), while `Math.max(0, NaN)` is NaN. Probe-pinned.
 *   §2  `except (TypeError, ValueError)` around `float()` stays narrow: only those
 *       two are swallowed, anything else propagates.
 *   §2  `except Exception as exc` around the two imports is a real error path, not
 *       a no-op — it returns a failure naming the exception (source comment says so).
 *   §4  naming: app/backend/memory_tools.py -> app/engine/memory_tools.ts.
 *
 * DIVERGENCE(port): `from memory_layer import ...` / `from memory_tiers import ...`
 * are function-local imports in the source (inside the try). They resolve through
 * `MEMORY_TOOLS_SEAMS` so the failure branch is probe-reachable; the defaults are
 * the real static imports (both modules are landed units).
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import { Result } from "./result.js";
import * as _memory_layer_mod from "./memory_layer.js";
import * as _memory_tiers_mod from "./memory_tiers.js";
import * as _tools_mod from "./tools.js";

// ── python 语义小工具（本仓惯例：各文件自带局部实现） ─────────────────────────

/** CPython str.strip()/rstrip() whitespace set (probe-pinned; see bot_remote.ts). */
const PY_WS = "\\t\\n\\v\\f\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

function pyStrip(s: string): string {
  return s.replace(new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g"), "");
}

function pyRstrip(s: string): string {
  return s.replace(new RegExp(`[${PY_WS}]+$`, "g"), "");
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** python `repr(x)` — only needed by `pyStr` for dict/list rendering. */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const hasSingle = v.includes("'");
    const hasDouble = v.includes('"');
    if (hasSingle && !hasDouble) return `"${v}"`;
    return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  return pyStr(v);
}

/** python `str(x)`. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof Map) {
    return `{${[...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(", ")}}`;
  }
  if (v instanceof Set) return `{${[...v].map(pyRepr).join(", ")}}`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).map((k) => `${pyRepr(k)}: ${pyRepr(o[k])}`).join(", ")}}`;
  }
  return String(v);
}

/** python `len(x)` (code-point based for strings). */
function pyLen(v: unknown): number {
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v !== null && typeof v === "object") return Object.keys(v as object).length;
  throw new TypeError(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `s[:n]` — code-point based. */
function pySlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** python two-arg `max(a, b)`: keeps `a` when `b > a` is False (NaN-safe). */
function pyMax2(a: number, b: number): number {
  return b > a ? b : a;
}

/** python two-arg `min(a, b)`: keeps `a` when `b < a` is False (NaN-safe). */
function pyMin2(a: number, b: number): number {
  return b < a ? b : a;
}

/** python `float(x)`. Throws TypeError / RangeError the way CPython does. */
function pyFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1.0 : 0.0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = pyStrip(v).replace(/_/g, "");
    if (s === "") throw new RangeError("could not convert string to float: ''");
    const low = s.toLowerCase();
    if (low === "inf" || low === "+inf" || low === "infinity" || low === "+infinity") return Infinity;
    if (low === "-inf" || low === "-infinity") return -Infinity;
    if (low === "nan" || low === "+nan" || low === "-nan") return NaN;
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/u.test(s)) return Number(s);
    throw new RangeError(`could not convert string to float: ${pyRepr(v)}`);
  }
  throw new TypeError(
    `float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** python `for x in v` — arrays, strings, Maps (keys), Sets, plain objects (keys). */
function pyIterate(v: unknown): unknown[] {
  if (Array.isArray(v)) return [...v];
  if (typeof v === "string") return [...v];
  if (v instanceof Map) return [...v.keys()];
  if (v instanceof Set) return [...v];
  if (v !== null && typeof v === "object") return Object.keys(v as object);
  throw new TypeError(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `dict.get(k, default)` — present-but-null returns null, not default. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python `str(exc)` (message only, no type prefix). */
function excStr(e: unknown): string {
  const m = (e as { pyMsg?: string })?.pyMsg;
  if (m !== undefined) {
    return m;
  }
  return String((e as Error)?.message ?? e);
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** Long enough for a real preference or decision, short enough that the model
 * cannot smuggle a transcript into always-inject context. */
export const MAX_CONTENT_CHARS = 600;

/** Vocabulary the memory layer already understands. Anything else is coerced to
 * ``fact`` rather than rejected — a wrong bucket is recoverable, a lost memory
 * is not. */
export const ALLOWED_TYPES: readonly string[] = ["fact", "preference", "context", "procedure"];

// ── seams（python 的函数级导入在这里可替换；默认值 = 真端口） ────────────────────

type AnyMod = Record<string, any>;

export const MEMORY_TOOLS_SEAMS = {
  /** python `from memory_layer import get_memory_layer, Memory, MemoryScope`。 */
  memoryLayerModule: (): AnyMod => _memory_layer_mod as unknown as AnyMod,
  /** python `from memory_tiers import MemoryTier, normalize_tier, policy_for`。 */
  memoryTiersModule: (): AnyMod => _memory_tiers_mod as unknown as AnyMod,
  /** python `from tools import ToolDef, get_tool_registry`（不在 try 里，失败会抛）。 */
  toolsModule: (): AnyMod => _tools_mod as unknown as AnyMod,
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof MEMORY_TOOLS_SEAMS>): void {
  Object.assign(MEMORY_TOOLS_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  MEMORY_TOOLS_SEAMS.memoryLayerModule = (): AnyMod => _memory_layer_mod as unknown as AnyMod;
  MEMORY_TOOLS_SEAMS.memoryTiersModule = (): AnyMod => _memory_tiers_mod as unknown as AnyMod;
  MEMORY_TOOLS_SEAMS.toolsModule = (): AnyMod => _tools_mod as unknown as AnyMod;
}

// ── 实现 ─────────────────────────────────────────────────────────────────────

/** Persist one durable memory and report exactly what landed. */
export function _remember_impl(args: Record<string, unknown>, ctx: unknown): Result {
  const content = pyStrip(pyStr(dictGet(args, "content", null) || ""));
  if (!content) {
    return Result.failure("content is required");
  }

  let finalContent = content;
  if (pyLen(content) > MAX_CONTENT_CHARS) {
    finalContent = pyRstrip(pySlice(content, MAX_CONTENT_CHARS)) + "…";
  }

  let mem_type = pyStrip(pyStr(dictGet(args, "type", null) || "fact")).toLowerCase();
  if (!ALLOWED_TYPES.includes(mem_type)) {
    mem_type = "fact";
  }

  let importance: number;
  try {
    importance = pyFloat(dictGet(args, "importance", null) || 0.7);
  } catch (e) {
    // 源为 `except (TypeError, ValueError)` —— 窄吞保持窄。
    if (e instanceof TypeError || e instanceof RangeError) {
      importance = 0.7;
    } else {
      throw e;
    }
  }
  importance = pyMin2(1.0, pyMax2(0.0, importance));

  let memoryLayer: AnyMod;
  let memoryTiers: AnyMod;
  try {
    memoryLayer = MEMORY_TOOLS_SEAMS.memoryLayerModule();
    memoryTiers = MEMORY_TOOLS_SEAMS.memoryTiersModule();
  } catch (exc) {
    // import failure is a real error, not a no-op
    return Result.failure(`memory layer unavailable: ${excStr(exc)}`);
  }
  const get_memory_layer = memoryLayer["get_memory_layer"] as (...a: any[]) => any;
  const Memory = memoryLayer["Memory"] as new (...a: any[]) => any;
  const MemoryScope = memoryLayer["MemoryScope"] as AnyMod;
  const MemoryTier = memoryTiers["MemoryTier"] as AnyMod;
  const normalize_tier = memoryTiers["normalize_tier"] as (v: unknown) => any;
  const policy_for = memoryTiers["policy_for"] as (t: any) => any;

  const tier = normalize_tier(dictGet(args, "tier", null) || MemoryTier.LONG_TERM);
  if (!policy_for(tier).persisted) {
    // A non-persisted tier would accept the write and lose it at session end,
    // which is precisely the silent failure this tool exists to remove.
    return Result.failure(
      `tier '${tier.value}' is not durable; use long_term or semantic`,
    );
  }

  let root = "";
  if (isDict(ctx)) {
    root = pyStr(
      dictGet(ctx, "workspace_root", null) || dictGet(ctx, "effective_workspace", null) || "",
    );
  }

  const tags = pyIterate(dictGet(args, "tags", null) || []).filter(
    (t) => typeof t === "string",
  ) as string[];

  const mem = new Memory(
    finalContent,
    mem_type,
    importance,
    MemoryScope.PROJECT,
    root,
    "",
    tags,
    tier.value,
  );

  const result = get_memory_layer().store(mem);
  if (!result.ok) {
    return Result.failure(result.error || "store failed");
  }

  return Result.success({
    stored: finalContent,
    type: mem_type,
    tier: tier.value,
    importance,
    id: mem.id,
  });
}

/** python `isinstance(v, dict)` — a class instance is NOT a dict. */
function isDict(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) {
    return false;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Register the ``remember`` tool. */
export function register_tools(registry: any = null): void {
  // Not wrapped in a try in the source: a broken tools module is a real error.
  const toolsMod: AnyMod = MEMORY_TOOLS_SEAMS.toolsModule();
  const ToolDef = toolsMod["ToolDef"] as new (...a: any[]) => any;
  const get_tool_registry = toolsMod["get_tool_registry"] as () => any;
  const reg = registry || get_tool_registry();
  reg.register(new ToolDef(
    "remember",
    // Written for the model, not for docs: it states when to call, and — more
    // importantly — that saying "I'll remember" without calling this is a lie.
    "Persist one durable fact, preference or decision to long-term memory so "
    + "it is available in future sessions. Call this whenever the user says to "
    + "remember something, states a lasting preference, or agrees to a way of "
    + "working. Never claim you will remember something unless this succeeded.",
    {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The single thing to remember, phrased so it still "
            + "makes sense months later with no conversation around it.",
        },
        type: {
          type: "string",
          enum: [...ALLOWED_TYPES],
          default: "fact",
        },
        importance: {
          type: "number",
          description: "0-1. Higher survives context pressure longer.",
          default: 0.7,
        },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
    },
    _remember_impl,
    { domain: "general", risk_level: "low" },
  ));
}
