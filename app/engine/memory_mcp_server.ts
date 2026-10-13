/**
 * memory_mcp_server.ts — Ovolve 本地 MCP 记忆服务器
 *
 * Ported from `app/backend/memory_mcp_server.py` (226 lines).
 *
 * 命名说明（源注释保留为合同）：`mcp_server/` 那个包是**客户端**侧基础设施
 * （auth / server / tools，用于连接外部 MCP 服务）。本文件是**服务端** ——
 * 把 Ovolve 自己的记忆暴露给别的 Agent。职责相反，所以不共用一个名字。
 *
 * 实现选择：Python 源用官方 `mcp` SDK（FastMCP）。TS 生态无同一 SDK 且本
 * 引擎已自带事件总线与 stdio 传输所需的全部原语，因此这里实现协议面：
 * tools/list + tools/call 的 JSON-RPC 2.0 子集（MCP stdio 传输的必经路径），
 * 工具处理器与源逐字对应。依赖策略（2026-09-22）允许加包，但 MCP 官方 TS
 * SDK 的传输层与引擎现有 fetch/event_bus 形状冲突较大，自持 120 行协议层
 * 比引入 SDK 更贴源语义 —— 此处为刻意选择，非占位。
 *
 * 暴露的工具（都是本地的，不出户）：
 *   - memory_search  —— 语义 + 关键词混合召回；embed 缺席时自动退回关键词
 *   - memory_add     —— 写入一条记忆，立即落盘到 SQLite
 *   - memory_list    —— 分页列出当前工作区的所有记忆
 *   - rules_list     —— 读取用户可编辑的 rules/*.md 规则库
 *
 * 传输：stdio —— 客户端把服务器作为子进程 spawn 起来，双方读写 stdin /
 * stdout 交换 JSON-RPC。stderr 留给日志。
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:process for stdio lines).
 *   §2  memory_layer.py / evolution.py 是 wave-4 SPLIT 单元：通过计算型
 *       动态 import 惰性解析，缺席时工具返回与源 except 分支一致的错误形状
 *       （`{"error": ...}` dict），不抛出、不崩进程。
 *   §2  诊断日志走 stderr，绝不污染 stdout（JSON-RPC 通道）。
 *   §4  naming: memory_mcp_server.py → memory_mcp_server.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as process2 from "node:process";
import * as readline from "node:readline";

import { get_rule_engine } from "./rule_engine.js";

export const SERVER_NAME = "ovolve-memory";
export const SERVER_VERSION = "0.2.0";

/** 诊断日志走 stderr，绝对不能污染 stdout（那是 JSON-RPC 通道）。 */
function _log(msg: string): void {
  process2.stderr.write(`[mcp] ${msg}\n`);
}

/** MCP 服务器没有"当前工作区"概念，走环境变量或当前目录。 */
function _get_workspace(): string {
  return process2.env["OVOLVE_WORKSPACE"] || process2.cwd();
}

// ---------------------------------------------------------------------------
// Optional SPLIT-unit accessors (memory_layer / storage)
// ---------------------------------------------------------------------------
interface MemoryLayerLike {
  has_embeddings: boolean;
  _embed_text(q: string): number[] | null;
  _extract_keywords(q: string): string[];
  store(mem: unknown): { ok: boolean; value?: unknown; error?: string };
}

interface StorageLike {
  search_memory_semantic(kwargs: {
    root: string;
    query_embedding: unknown;
    keywords: unknown;
    limit: number;
  }): Record<string, unknown>[];
}

// EVIDENCE tmp/mmsrv_oracle_facts.json F7_memory_class: the CPython source constructs
// `Memory(content=..., mem_type=..., importance=..., scope=..., tags=...,
// session_id=..., root_dir=...)` and memory_layer.Memory stores those under the SAME
// attribute names (`self.type = mem_type`, `self.tags = tags or []`). The TS sibling
// app/engine/memory_layer.ts exports `class Memory` with the identical positional
// constructor (content, mem_type, importance, scope, root_dir, session_id, tags, ...),
// and app/engine/app_agent.ts already binds it as
// `Memory: new (content, mem_type, importance, scope, root_dir, session_id) => unknown`.
// The port therefore constructs the entry from the module's own Memory class - the
// measured divergence of the old plain-object literal (`mem_type` key, no `.type`
// attribute, constructor name "Object") is recorded in tmp/mmsrv_STATE.md.
interface MemoryModuleLike {
  get_memory_layer(): MemoryLayerLike;
  Memory: new (
    content: any, mem_type?: any, importance?: any, scope?: any,
    root_dir?: any, session_id?: any, tags?: any,
  ) => unknown;
}

async function get_memory_module(): Promise<MemoryModuleLike | null> {
  try {
    const spec = "./memory_layer" + ".js";
    const mod = (await import(/* @vite-ignore */ spec)) as unknown as MemoryModuleLike;
    return mod;
  } catch {
    return null;
  }
}

async function get_storage_like(): Promise<StorageLike | null> {
  try {
    const mod = (await import("./storage.js")) as unknown as {
      get_storage: () => StorageLike;
    };
    return mod.get_storage();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CPython coercion mirrors (measured, never guessed)
// ---------------------------------------------------------------------------
//
// Five expressions in the source are CPython-specific and are NOT answered the
// same way by Number()/String()/trim():
//   (query or "").strip()            str.isspace() whitespace set + AttributeError
//   max(1, min(int(limit or 5), 50)) int() parsing + ValueError / OverflowError
//   float(importance)                float() parsing + ValueError
//   [str(t) for t in (tags or [])]   iteration protocol + str() spelling
//   (r.get("content") or "")[:200]   code-point slicing + TypeError
// The mirrors below reproduce CPython's observable RESULT and, where the source
// raises, the exception type name and message text the parity table compares.
// Every spelling used here was printed by the certified interpreter into
// tmp/mmsrv_oracle_facts.json and reprinted in tmp/mmsrv_STATE.md before this
// block was written; the exercised input shapes are the ones declared by
// tmp/mmsrv_cases.json.
//
// RULEBOOK: §2 (a port that silently answers differently is a defect, not a
// simplification), §4 (naming: the helpers are CPython-named on purpose).

/** An exception whose `name` is the CPython class name the parity table compares. */
class PyExc extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** CPython `type(v).__name__` over the value shapes this port can receive. */
function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (Array.isArray(v)) return "list";
  return "dict";
}

/** CPython truthiness (`bool(v)`). */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v as Record<string, unknown>).length > 0;
}

/** CPython `str.isspace()` code points (NOT the JS WhiteSpace+LineTerminator set). */
const PY_WS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** CPython `s.strip()` over code points. */
function pyStrip(s: string): string {
  const cps = Array.from(s);
  let i = 0;
  let j = cps.length;
  while (i < j && PY_WS.has(cps[i]!.codePointAt(0)!)) i++;
  while (j > i && PY_WS.has(cps[j - 1]!.codePointAt(0)!)) j--;
  return cps.slice(i, j).join("");
}

/** CPython `(v or "").strip()`: falsy -> "", non-str truthy -> AttributeError. */
function pyOrEmptyStrip(v: unknown): string {
  if (!pyTruth(v)) return "";
  if (typeof v !== "string") {
    throw new PyExc("AttributeError", `'${pyTypeName(v)}' object has no attribute 'strip'`);
  }
  return pyStrip(v);
}

/** CPython repr() of a str over the shapes this table carries. */
function pyReprStr(s: string): string {
  return "'" + s + "'";
}

/** CPython repr() of a value (str gets its quotes, everything else str()). */
function pyReprValue(v: unknown): string {
  if (typeof v === "string") return pyReprStr(v);
  return pyStr(v);
}

/** CPython `int(v)`: bool/int, float truncation, base-10 str parsing. */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new PyExc("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new PyExc("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const s = pyStrip(v);
    if (/^[+-]?[0-9](?:_?[0-9])*$/.test(s)) {
      const n = Number(s.replace(/^[+-]/, "").replace(/_/g, ""));
      return s.charAt(0) === "-" ? -n : n;
    }
    throw new PyExc("ValueError", "invalid literal for int() with base 10: " + pyReprStr(v));
  }
  throw new PyExc("TypeError",
    `int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
}

/** CPython `float(v)`: numbers pass through, strings parse, else TypeError. */
function pyFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = pyStrip(v);
    const low = s.toLowerCase();
    if (low === "inf" || low === "+inf" || low === "infinity" || low === "+infinity") return Number.POSITIVE_INFINITY;
    if (low === "-inf" || low === "-infinity") return Number.NEGATIVE_INFINITY;
    if (low === "nan" || low === "+nan" || low === "-nan") return Number.NaN;
    if (/^[+-]?(?:[0-9](?:_?[0-9])*\.?(?:[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9]+)?$/.test(s)) {
      return Number(s.replace(/_/g, ""));
    }
    throw new PyExc("ValueError", "could not convert string to float: " + pyReprStr(v));
  }
  throw new PyExc("TypeError",
    `float() argument must be a string or a real number, not '${pyTypeName(v)}'`);
}

/** CPython `str(v)` over the value shapes this table carries. */
function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "[" + v.map((x) => pyReprValue(x)).join(", ") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => pyReprValue(k) + ": " + pyReprValue(o[k])).join(", ") + "}";
  }
  return String(v);
}

/** CPython iteration over the container shapes this table carries. */
function pyIter(v: unknown): unknown[] {
  if (typeof v === "string") return Array.from(v);
  if (Array.isArray(v)) return v.slice();
  if (v !== null && typeof v === "object") return Object.keys(v as Record<string, unknown>);
  throw new PyExc("TypeError", `'${pyTypeName(v)}' object is not iterable`);
}

/** CPython `[str(t) for t in v]`. */
function pyStrList(v: unknown): string[] {
  const out: string[] = [];
  for (const t of pyIter(v)) out.push(pyStr(t));
  return out;
}

/** CPython `v[:200]` — code-point slice for str, element slice for list. */
function pySlice200(v: unknown): unknown {
  if (typeof v === "string") return Array.from(v).slice(0, 200).join("");
  if (Array.isArray(v)) return v.slice(0, 200);
  // EVIDENCE (live, certified 3.13.15): `({"a":1} or "")[:200]` raises
  // KeyError: slice(None, 200, None) — slices became HASHABLE in 3.12, so a
  // dict subscript is a plain missing-key lookup, NOT "unhashable type".
  // Measured twice: tmp/mmsrv_oracle_facts.json F5_slice.dict_truthy and the
  // pre-probe measurement recorded in tmp/mmsrv_STATE.md.
  if (v !== null && typeof v === "object") throw new PyExc("KeyError", "slice(None, 200, None)");
  throw new PyExc("TypeError", `'${pyTypeName(v)}' object is not subscriptable`);
}


// Tool handlers (verbatim with the source)
// ---------------------------------------------------------------------------

/** CPython `**kwargs` binding for the TOOLS view: the source's handlers are
 * `lambda args: memory_search(**args)` / `memory_add(**args)` / `memory_list(**args)`,
 * so the TS view binds BY NAME with the same observable failures - a non-mapping
 * argument, an unknown key, a missing required key. Wording measured by the pinned
 * interpreter into tmp/mmsrv_oracle_facts.json (F10_tools_binding), never guessed. */
function pyKwargs(
  fn_name: string,
  args: unknown,
  required: string[],
  known: string[],
): Record<string, unknown> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new PyExc("TypeError", "memory_mcp_server." + fn_name + "() argument after ** must be a mapping, not " + pyTypeName(args));
  }
  const src = args as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!known.includes(k)) {
      throw new PyExc("TypeError", `${fn_name}() got an unexpected keyword argument '${k}'`);
    }
  }
  for (const r of required) {
    if (!(r in src)) {
      throw new PyExc("TypeError", `${fn_name}() missing 1 required positional argument: '${r}'`);
    }
  }
  return src;
}

/** 语义 + 关键词召回记忆。返回结构化条目列表。 */
export async function memory_search(query: unknown, limit: unknown = 5): Promise<Record<string, unknown>> {
  const q = pyOrEmptyStrip(query);
  if (!pyTruth(q)) {
    return { error: "query 不能为空" };
  }
  const lim = Math.max(1, Math.min(pyInt(pyTruth(limit) ? limit : 5), 50));
  const mod = await get_memory_module();
  const memory = mod === null ? null : mod.get_memory_layer();
  const storage = await get_storage_like();
  if (mod === null || memory === null || storage === null) {
    // TS-only SPLIT-unit guard (memory_layer.ts / storage.ts ship in their own waves).
    // CPython has NO counterpart - it would raise AttributeError on a missing layer -
    // so this arm is UNREACHABLE BY CONSTRUCTION in the parity table: it stays out of
    // tmp/mmsrv_cases.json with that justification recorded in tmp/mmsrv_STATE.md.
    // It is deliberately NOT hidden by any whitelist entry (zero-divergence law).
    return { error: "memory_layer/storage unavailable" };
  }
  // ``prefetch`` 返回给 system prompt 用的 XML 字符串；MCP 客户端要结构化，
  // 所以直接走底层 search_memory_semantic 拿原始条目。
  const q_emb = pyTruth(memory.has_embeddings) ? memory._embed_text(q) : null;
  const keywords = memory._extract_keywords(q);
  const rows = storage.search_memory_semantic({
    root: _get_workspace(),
    query_embedding: q_emb,
    keywords: pyTruth(keywords) ? keywords : null,
    limit: lim,
  });
  return {
    results: rows.map((r) => ({
      // ``r.get("id")`` answers None for an absent key; ``r["id"]`` answers
      // undefined, which JSON.stringify then DROPS - measured divergence
      // (tmp/mmsrv_STATE.md), fixed here with an explicit null.
      id: r["id"] ?? null,
      content: r["content"] ?? null,
      type: r["type"] ?? null,
      importance: r["importance"] ?? null,
      created_at: r["created_at"] ?? null,
    })),
    backend: pyTruth(q_emb) ? "semantic" : "keyword",
  };
}

/** 写入一条记忆，落盘到本地 SQLite。 */
// 参数形状与源逐字对应：`memory_add(content, type="fact", scope="workspace",
// importance=0.5, tags=None)` —— 源是五个位置参数，不是一个 kwargs 字典
// （TOOLS 视图的 `memory_add(**args)` 由 pyKwargs 按名绑定后再按位转交）。
export async function memory_add(
  content: unknown,
  type: unknown = "fact",
  scope: unknown = "workspace",
  importance: unknown = 0.5,
  tags: unknown = null,
): Promise<Record<string, unknown>> {
  const content_ = pyOrEmptyStrip(content);
  if (!pyTruth(content_)) {
    return { error: "content 不能为空" };
  }
  const mod = await get_memory_module();
  const memory = mod === null ? null : mod.get_memory_layer();
  if (mod === null || memory === null) {
    // TS-only SPLIT-unit guard; unreachable by construction (see memory_search).
    // The old "(not ported yet)" wording was stale - app/engine/memory_layer.ts
    // EXISTS and exports get_memory_layer + Memory (evidence in tmp/mmsrv_STATE.md).
    return { error: "memory_layer unavailable" };
  }
  // The source constructs the layer's OWN data class:
  //   Memory(content=content, mem_type=type or MemoryType.FACT, scope=...,
  //          importance=float(...), tags=[str(t) for t in (tags or [])],
  //          session_id="mcp", root_dir=_get_workspace())
  // which stores `self.type = mem_type` / `self.tags = tags or []`. The TS mirror
  // constructs the module's Memory with the same positional signature - measured
  // evidence: tmp/mmsrv_oracle_facts.json F7_memory_class, and the engine already
  // binds `Memory: new (content, mem_type, importance, scope, root_dir, session_id)`
  // in app_agent.ts. The old plain-object literal carried a `mem_type` key and no
  // `.type` attribute at all - a measured divergence (tmp/mmsrv_STATE.md).
  const mem = new mod.Memory(
    content_,
    pyTruth(type) ? type : "fact",
    pyFloat(importance === null || importance === undefined ? 0.5 : importance),
    pyTruth(scope) ? scope : "workspace",
    _get_workspace(),
    "mcp",
    pyStrList(pyTruth(tags) ? tags : []),
  );
  const result = memory.store(mem);
  return {
    ok: result.ok,
    id: pyTruth(result.ok) ? result.value : null,
    error: pyTruth(result.ok) ? null : result.error,
  };
}

/** 列出当前工作区的所有记忆，按 importance 排序。 */
export async function memory_list(limit: unknown = 20, offset: unknown = 0): Promise<Record<string, unknown>> {
  const lim = Math.max(1, pyInt(pyTruth(limit) ? limit : 20));
  const off = Math.max(0, pyInt(pyTruth(offset) ? offset : 0));
  const storage = await get_storage_like();
  if (storage === null) {
    // TS-only SPLIT-unit guard; unreachable by construction (see memory_search).
    return { error: "storage unavailable" };
  }
  const rows = storage.search_memory_semantic({
    root: _get_workspace(),
    query_embedding: null,
    keywords: null,
    limit: lim + off,
  });
  const slice_ = rows.slice(off, off + lim);
  return {
    items: slice_.map((r) => ({
      id: r["id"] ?? null,
      // ``(r.get("content") or "")[:200]``: falsy -> "", truthy str -> CODE-POINT
      // slice (JS String.slice counts UTF-16 units - measured divergence on astral
      // content), truthy list -> element slice, truthy dict -> TypeError
      // "unhashable type: 'slice'" (tmp/mmsrv_STATE.md).
      content: pySlice200(pyTruth(r["content"]) ? r["content"] : ""),
      type: r["type"] ?? null,
      importance: r["importance"] ?? null,
    })),
    total_returned: slice_.length,
  };
}

/** 读取用户可编辑的规则库（.ovolve/rules/*.md）。让别的 Agent 也能看到项目约定。 */
export function rules_list(): Record<string, unknown> {
  return get_rule_engine(_get_workspace()).snapshot();
}

// ---------------------------------------------------------------------------
// TOOLS compatibility view (old hand-written server test surface)

// ---------------------------------------------------------------------------
// TOOLS compatibility view (old hand-written server test surface)
// ---------------------------------------------------------------------------
/** 之前的手写版对外暴露了 `TOOLS` 字典以便离线单测。协议由本文件的 JSON-RPC
 * 层驱动，但工具处理器本身就是普通函数 —— 用一个 `TOOLS` 视图把它们串起来，
 * 让原有的单测能沿用同样的调用形状。 */
export const TOOLS: Record<
  string,
  { description: string; handler: (args: unknown) => Promise<Record<string, unknown>> }
> = {
  memory_search: {
    description: "语义 + 关键词召回记忆。返回结构化条目列表。",
    // 源：`lambda args: memory_search(**args)` —— 按名绑定，绑定错误的类型与
    // 措辞与 CPython 逐字一致（pyKwargs；词法由 oracle F10_tools_binding 测量，
    // 不是猜的）。limit 缺席时走默认参数，与 CPython 的默认值语义相同。
    handler: (args: unknown): Promise<Record<string, unknown>> => {
      const kw = pyKwargs("memory_search", args, ["query"], ["query", "limit"]);
      return "limit" in kw ? memory_search(kw["query"], kw["limit"]) : memory_search(kw["query"]);
    },
  },
  memory_add: {
    description: "写入一条记忆，落盘到本地 SQLite。",
    // 源：`lambda args: memory_add(**args)`。memory_add 是五个位置参数，所以这里
    // 按源参数顺序 (content, type, scope, importance, tags) 把出现的键转成位置实参；
    // 缺席的键补 undefined，落到 TS 默认参数（与 CPython 默认值逐字一致）。
    handler: (args: unknown): Promise<Record<string, unknown>> => {
      const kw = pyKwargs("memory_add", args, ["content"],
        ["content", "type", "scope", "importance", "tags"]);
      const order = ["content", "type", "scope", "importance", "tags"];
      let n = order.length;
      while (n > 1 && !(order[n - 1]! in kw)) n--;
      const vals = order.slice(0, n).map((k) => (k in kw ? kw[k] : undefined));
      return memory_add(vals[0], vals[1], vals[2], vals[3], vals[4]);
    },
  },
  memory_list: {
    description: "列出当前工作区的所有记忆，按 importance 排序。",
    // 源：`lambda args: memory_list(**args)`；两个参数都有默认值。
    handler: (args: unknown): Promise<Record<string, unknown>> => {
      const kw = pyKwargs("memory_list", args, [], ["limit", "offset"]);
      if ("limit" in kw && "offset" in kw) return memory_list(kw["limit"], kw["offset"]);
      if ("limit" in kw) return memory_list(kw["limit"]);
      if ("offset" in kw) return memory_list(undefined, kw["offset"]);
      return memory_list();
    },
  },
  rules_list: {
    description: "读取用户可编辑的规则库（.ovolve/rules/*.md）。让别的 Agent 也能看到项目约定。",
    // 源：`lambda _args: rules_list()` —— 参数被完全忽略（非映射、未知键、
    // 任意形状都不报错，因为根本不绑定）。
    handler: (): Promise<Record<string, unknown>> => Promise.resolve(rules_list()),
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (MCP stdio transport subset)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (MCP stdio transport subset)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: JsonRpcRequest["id"], result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle_rpc(req: JsonRpcRequest): Promise<string | null> {
  const { method, id } = req;
  // notifications (id === null/undefined) get no response
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "notifications/initialized") {
    return null; // notification ack: no body
  }
  if (method === "tools/list") {
    return rpcResult(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: { type: "object" },
      })),
    });
  }
  if (method === "tools/call") {
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const tool = params["name"] ? TOOLS[String(params["name"])] : undefined;
    if (!tool) {
      return rpcError(id, -32602, `unknown tool: ${String(params["name"] ?? "")}`);
    }
    try {
      const result = await tool.handler(params["arguments"] ?? {});
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    } catch (e) {
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify({ error: String(e) }) }],
        isError: true,
      });
    }
  }
  if (method === "ping") {
    return rpcResult(id, {});
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

/** 默认 stdio 传输 —— MCP 客户端标配。 */
export function main(): void {
  _log(`${SERVER_NAME} v${SERVER_VERSION} 启动，工作区 = ${_get_workspace()}`);
  const rl = readline.createInterface({ input: process2.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process2.stdout.write(rpcError(null, -32700, "parse error") + "\n");
      return;
    }
    void handle_rpc(req).then((resp) => {
      if (resp !== null) {
        process2.stdout.write(resp + "\n");
      }
    });
  });
  rl.on("close", () => {
    _log("stdin closed, exiting");
  });
}

// Allow `node memory_mcp_server.js` style direct execution (the source's
// `python -m memory_mcp_server` entry).
if (
  typeof process2.argv[1] === "string" &&
  process2.argv[1].replace(/\\/g, "/").endsWith("memory_mcp_server.ts")
) {
  main();
}
