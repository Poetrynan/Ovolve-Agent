/**
 * http_server_s5.ts — 单元 218 `app/backend/server/http_server.py`（8819 源行）的 **段 S5**。
 * 分段方案 `tmp/w218_SEGMENTS.md` · 契约表 `tmp/w218_SURFACE.md` · 镜像层单一来源 keys.ts §M。
 * 风格母版：已落地的 S3（`http_server_s3.ts`）与验收草稿 S4（`http_server_s4.ts`）——
 *   seam 对象 + fail-closed 缺省 + CPython 异常镜像**从 keys.ts import**（本段**不带**任何镜像层副本）。
 *
 * 覆盖源区间 **3866–4576**（技能 / 学习 / episode / mailbox / 市场 handler 簇）：
 *   3866–3871  handle_skills                 GET    /api/skills
 *   3874–3888  handle_skill_experiences      GET    /api/skills/experiences
 *   3890–3915  handle_relations              GET    /api/relations
 *   3917–3929  handle_approvals_pending      GET    /api/approvals/pending
 *   3932–4002  handle_session_learning       GET    /api/sessions/{id}/learning      (logging NameError = S5-B1)
 *   4005–4099  handle_learning_item_action   POST   /api/learning-items/{id}/{action} (logging NameError = S5-B2；except Exception -> {})
 *   4102–4186  handle_learning_item_trace    GET    /api/learning-items/{id}/trace    (validate_scope 死 import = S5-B3；except Exception -> 500)
 *   4190–4200  handle_episodes_list          GET    /api/episodes                    (int() 在 try 之外 = S5-B4)
 *   4203–4238  handle_episode_seal           POST   /api/episodes/seal                (body 解析 except Exception -> {})
 *   4242–4271  handle_history_trace          GET    /api/history/trace                (int() 在 try 之外 = S5-B5)
 *   4273–4286  handle_mailbox_list           GET    /api/mailbox/{box_id}
 *   4288–4297  handle_mailbox_drain          POST   /api/mailbox/{box_id}/drain
 *   4299–4308  handle_skill_candidates       GET    /api/skills/candidates
 *   4310–4318  handle_skill_candidate_create POST   /api/skills/candidates            (BARE json 4314)
 *   4320–4364  handle_skill_candidate_action POST   /api/skills/candidates/{id}/{verb} (4 条注册 #49–#52；except Exception -> {})
 *   4367–4379  handle_import_skill           POST   /api/skills/import                (BARE json 4370)
 *   4382–4389  handle_marketplace_catalog    GET    /api/skills/marketplace
 *   4392–4401  handle_uninstall_skill        POST   /api/skills/{name}/uninstall
 *   4404–4413  handle_skill_detail           GET    /api/skills/{name}
 *   4416–4440  handle_install_skill          POST   /api/skills/install               (BARE json 4420)
 *   4444–4454  handle_search_sessions        GET    /api/sessions/search              (int() 无 try + 先算后判 = S5-B6)
 *   4457–4493  handle_vet_skill              POST   /api/skills/vet                   (BARE json 4475)
 *   4497–4504  handle_enable_skill           POST   /api/skills/{name}/enable
 *   4507–4514  handle_disable_skill          POST   /api/skills/{name}/disable
 *   4519–4525  handle_plugins                GET    /api/plugins
 *   4528–4541  handle_import_plugin          POST   /api/plugins/import               (except JSONDecodeError -> 400 invalid JSON)
 *   4544–4549  handle_plugin_enable          POST   /api/plugins/{name}/enable
 *   4552–4557  handle_plugin_disable         POST   /api/plugins/{name}/disable
 *   4560–4567  handle_plugin_remove          DELETE /api/plugins/{name}
 *
 * **计数**：32 条注册 / 29 个 handler（`handle_skill_candidate_action` 挂 promote/approve/reject/rollback 四条，#49–#52）。
 * 本段**不注册任何路由**（S10 装配）；ROUTE_TABLE 里 `seg: "S5"` 的 32 行 → 就是本文件的导出。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 源码自带死路 / 不一致：逐字复制、只标注不修（RULEBOOK §2 BUG 规则）。编号 S5-Bn：
 * S5-B1  4000–4002 handle_session_learning 的 `except Exception as exc:` 里调用 **未在本函数 import、
 *        也不在模块顶层 import 的 `logging`**（源 16 行只 import json/asyncio/os/re/time/urllib.parse，
 *        `import logging` 只出现在别的 handler 函数体内）⇒ 走异常臂时 `logging` 是自由名 → NameError
 *        逃逸 handler，`json_response({"error":...}, 500)`（4002）**永不可达**。端口用 PyNameErrorP 复刻，
 *        不修：改了就等于"替源补一条 import"，是"改进"而非"对齐"。
 * S5-B2  4097–4099 handle_learning_item_action 与 S5-B1 完全同型的 `logging` NameError（4098）。
 *        整段业务体（含函数级 import、get_storage、svc.decide）都在同一个 try 里，因此**任何**异常
 *        最终都变成 NameError 逃逸，而不是文档里承诺的 500。端口逐字复刻。
 * S5-B3  4109 handle_learning_item_trace 函数级 `from scope_guard import validate_scope` **从未被使用**
 *        （真正的校验在 4120–4128 手写）。端口只声明 `validate_scope()` 这条 seam、不调用它，
 *        把这条死 import 留在注释里（同 S4-B17 的先例）。
 * S5-B4  4194 handle_episodes_list：`limit = max(1, min(int(request.query.get("limit","50")), 100))`
 *        在 try **之外**（try 从 4195 才开始）⇒ `?limit=abc` 的 ValueError 冒出 handler，不进 except Exception->500。
 * S5-B5  4248 handle_history_trace 同型：`int(request.query.get("limit","100"))` 在 try（4249 起）之外。
 * S5-B6  4449 handle_search_sessions：`limit = int(... or 10)` **整函数无 try**，而且写在
 *        `if not q: return 400`（4450）**之前** ⇒ 缺 q 但 limit=abc 时先抛 ValueError 逃逸、到不了那条 400。
 *        取值口径（`rel_url.query`）与 episodes/history 的 `query` 是同一个 MultiDict（见 §DIVERGENCE D1）。
 * S5-B7  4209–4212 handle_episode_seal：body 解析 `try/except -> {}` 在 4208 就结束，随后的
 *        `data.get("episodeId")` 等 `.get` 落在**两段 try 之间**（4215 才是第二段 try）⇒
 *        body 是 JSON 数组/字符串时 `.get` 抛 AttributeError 冒出 handler（S0 NOTES B4 家族在 S5 的实例）。
 * S5-B8  4338 handle_skill_candidate_action 的 reject 支：`reason = str((data or {}).get("reason") or "")`
 *        的 `.get` 在 reject 自己的 json-try（4334–4337）**之外**、且整个 handler 无外层 try ⇒
 *        body 是数组时 AttributeError 逃逸。
 * S5-B9  4277 vs 4292 两条 mailbox 路由对 `box_id` 的取值口径不一致：list 是
 *        `match_info.get("box_id") or request.query.get("box_id") or ""`（**兜 query**），
 *        drain 是 `match_info.get("box_id") or ""`（**不兜 query**）。端口保留两样写法。
 * S5-B10 3905–3914 handle_relations：try 只罩 `relations_from/relations_to` 且**只兜 ValueError**（3908）；
 *        随后的 `"staleCount": sum(1 for e in (outgoing+incoming) if e.get("stale"))`（3914）在 try **之外**，
 *        任一条边是**非 dict**（storage 假件给 list/str）→ `.get` 抛 AttributeError 冒出 handler。
 * S5-B11 4422–4439 handle_install_skill：三条分支中 `skill_id` 支提前 return，其余两支 fall-through 到
 *        底部 `if result.ok: return {**result.value, "registry": agentskills_info()}`。`result.value`
 *        若不是 mapping（sync_lockfile/install_from_github 假件给 None/list）→ `**` 解包抛 TypeError，
 *        整函数无 try ⇒ 逃逸。端口用 py_dict_spread 复刻该 TypeError。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DIVERGENCE(port):
 *  D1 `request.rel_url.query`（源 4385–4387/4447–4449）与 `request.query` 在 aiohttp 里是**同一个**
 *    MultiDict；keys.ts 的 WebRequest 只暴露 `query`，端口统一走 `request.query`。等价性与 S4 的 D1 同论证。
 *    （源里没有 request.text()/post()/url/remote/content/multipart；本段一条都没写。）
 *  D2 CPython 里 `.get(name)`（**单参**）缺键返回 None；本段每一处单参 query/match_info 读值后**立刻**
 *    接 `or <默认>` 链（`... or None` / `... or ""`），端口用 `query.get(name, "")` 再 `py_or(..., null)`
 *    表达同一 `or` 结论——"缺键/空串"两种假值经 `or` 后落点完全相同，因此无需像 S4 那样保留 raw-None 面。
 *    （S5 没有任何一处对 query/match_info 做 `is not None` 判定——那条是 S4 D2 的专属，本段不涉及。）
 *  D3 CPython `len(s)` / `v[:500]` / `p.items()` / `x in y` 按**码点**，JS 按 UTF-16 单元：
 *    这些私有工具（py_len / py_head / py_dict_items / py_contains / py_dict_index / py_tuple2 /
 *    py_dict_spread）本段自带一份，全部先 `Array.from` 再算。已登记为"私有镜像候选"。
 *  D4 `str.lower()` 用 JS `toLowerCase()`：本段唯一消费点是 trace 的 `k.lower()` 敏感键匹配，
 *    这些 ASCII 子串（token/cookie/...）对跨字符小写差异**一律不命中**，python 与端口结论相同。
 *  D5 `str(exc)`（异常文案）统一走 keys.ts §M 的 `exc_str`；`except` 的**族判定**用本段私有的
 *    `catches_classes`（看 name 与 `XxxError:` 文案前缀，见 D3 候选清单）——与 S4 的 D7 同法，
 *    这样 keys.ts 的 py_int（把 ValueError 装在 JS TypeError 里）也能被 `except (ValueError, TypeError)` 认出来。
 *  D6 未捕获异常（BARE json、seam 抛的非兜底类、S5-B1/B2 的 NameError、S5-B4/5/6 的 ValueError）在端口里
 *    是 rejected promise 向上冒，**不在本文件渲染**；最终状态码归装配层 `CreateServerSeams.render_uncaught`。
 *    端口不自创 400/500。
 *  D7 函数级 `from M import f`：端口的 seam getter 若被设计成"调用即抛 ModuleNotFound"，那它的抛出点
 *    在**源真正第一次调用 f 的位置**，而不是源的 `import` 语句本身。本段据此把每条 seam 放在与源相同的
 *    try 作用域内（例如 relations 的 `get_storage()` 在 try 外、`relations_from` 在 try 内，端口同位）。
 *    approvals_pending 的 except 有本地 `import logging`（3927）⇒ 端口调 `log_exception()`；
 *    session_learning/learning_item_action **没有**本地 import ⇒ 端口调 `py_undefined_logging()` 抛 NameError。
 */

import {
  json_response,
  py_int,
  py_or,
  py_str,
  py_truth,
  py_type_name,
  py_is_none,
  py_strip,
  py_dict_get,
  py_getattr,
  py_getattr_or,
  py_iter,
  py_path_str,
  os_path_join,
  exc_str,
  PyExcP,
  ModuleNotFoundErrorP,
  PyAttributeErrorP,
  PyTypeErrorP,
  type JsonDict,
  type WebRequest,
  type WebResponse,
} from "./http_server_keys.js";

/* ──────────────────────────────────────────────────────────────────────────
 * §0 CPython 异常镜像补充（keys.ts §M 没有 ValueError / NameError 两类；见"私有镜像候选"）
 * ──────────────────────────────────────────────────────────────────────── */

/** `ValueError`（keys.ts 的 py_int/py_float 把 ValueError 装在 JS TypeError 文案里，本段族判定认前缀）。 */
class PyValueErrorP extends PyExcP {
  constructor(message: string) {
    super("ValueError", message);
  }
}

/** `NameError`（S5-B1/S5-B2：引用未导入的自由名 `logging`）。 */
class PyNameErrorP extends PyExcP {
  constructor(name: string) {
    super("NameError", `name '${name}' is not defined`);
  }
}

/**
 * S5-B1/S5-B2 的执行者：源里 `logging.getLogger(__name__).exception(...)` 的 `logging` 是自由名
 * （本函数没 import、模块顶层也没 import）⇒ 运行到就 NameError。返回型不是 never，
 * 好让 TS 认为后面的 `return json_response(...,500)` 仍"可达"（源里那行确实写着），
 * 而运行时它一定抛、永远走不到——这正是端口要对齐的"死代码假象"。
 */
function py_undefined_logging(): void {
  throw new PyNameErrorP("logging");
}

/** 一次 except 族判定要用的 python 类名集合（D5；键：镜像类 name 与 `XxxError:` 文案前缀）。 */
function py_exc_classes(exc: unknown): string[] {
  const out: string[] = [];
  if (exc instanceof Error) {
    if (exc.name) out.push(exc.name);
    const lead = /^([A-Za-z_]*Error)\b/.exec(exc.message ?? "");
    if (lead && lead[1] !== undefined) out.push(lead[1]);
  }
  return out;
}

/** `except (A, B):` —— 族判定按 python 类名（对 keys.ts 跨模块异常同样有效）。 */
function catches_classes(exc: unknown, classes: readonly string[]): boolean {
  return py_exc_classes(exc).some((g) => classes.includes(g));
}

const VALUE_OR_TYPE_ERROR: readonly string[] = ["ValueError", "TypeError"];
const VALUE_ERROR: readonly string[] = ["ValueError"];

/* ──────────────────────────────────────────────────────────────────────────
 * §1 CPython 语义小工具（keys.ts §M 未提供的部分；全部登记为"私有镜像候选"）
 * ──────────────────────────────────────────────────────────────────────── */

/** 端口侧的"python dict"：非 null 的对象，且不是 list / bytes / set / Map 之外的东西。 */
function is_pydict(v: unknown): v is JsonDict | Map<unknown, unknown> {
  if (v === null || v === undefined) return false;
  if (typeof v !== "object") return false;
  if (Array.isArray(v) || v instanceof Uint8Array || v instanceof Set) return false;
  return true;
}

/** `len(x)`：str 按码点、list/dict/set/bytes 按项，其余 TypeError。 */
function py_len(v: unknown): number {
  if (typeof v === "string") return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v instanceof Uint8Array) return v.length;
  if (is_pydict(v)) return Object.keys(v as JsonDict).length;
  throw new PyTypeErrorP(`object of type '${py_type_name(v)}' has no len()`);
}

/** `key in container`：dict→键、list/tuple→成员、str→子串、Set→成员；其余 TypeError。 */
function py_contains(container: unknown, key: unknown): boolean {
  if (Array.isArray(container)) return container.some((el) => el === key);
  if (container instanceof Set) return [...(container as Set<unknown>)].some((el) => el === key);
  if (is_pydict(container)) {
    if (container instanceof Map) {
      for (const k of container.keys()) if (k === key) return true;
      return false;
    }
    return Object.prototype.hasOwnProperty.call(container, String(key));
  }
  if (typeof container === "string") {
    if (typeof key !== "string") {
      throw new PyTypeErrorP(`'in <string>' requires string as left operand, not ${py_type_name(key)}`);
    }
    return container.includes(key);
  }
  throw new PyTypeErrorP(`argument of type '${py_type_name(container)}' is not iterable`);
}

/** `d.items()`：非 dict → AttributeError（文案里是 'items'）。 */
function py_dict_items(target: unknown): Array<[string, unknown]> {
  if (!is_pydict(target)) throw new PyAttributeErrorP(target, "items");
  if (target instanceof Map) return [...target.entries()].map(([k, v]) => [String(k), v] as [string, unknown]);
  const out: Array<[string, unknown]> = [];
  for (const k of Object.keys(target)) out.push([k, (target as JsonDict)[k]]);
  return out;
}

/** `d[k]`（**下标**读）：dict 缺键 KeyError；list/str 走 TypeError（本段只用于 install_skill 的 data[...]）。 */
function py_dict_index(target: unknown, key: string): unknown {
  if (is_pydict(target)) {
    if (target instanceof Map) {
      for (const [k, v] of target.entries()) if (k === key) return v;
      throw new PyValueErrorP(`KeyError: ${key}`);
    }
    if (!Object.prototype.hasOwnProperty.call(target, key)) throw new PyValueErrorP(`KeyError: ${key}`);
    return (target as JsonDict)[key];
  }
  if (typeof target === "string") throw new PyTypeErrorP("string indices must be integers, not 'str'");
  if (Array.isArray(target)) throw new PyTypeErrorP("list indices must be integers or slices, not str");
  throw new PyTypeErrorP(`'${py_type_name(target)}' object is not subscriptable`);
}

/** `s[:n]`（**码点**前缀切片）。 */
function py_head(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/** `a[:n]`（列表前缀切片；python 越界不报错）。 */
function py_list_head<T>(arr: readonly T[], n: number): T[] {
  return arr.slice(0, n < 0 ? 0 : n);
}

/** `{**value, "k": extra}`：value 非 mapping → `TypeError: ... is not a mapping`。 */
function py_dict_spread(value: unknown, extra: JsonDict): JsonDict {
  if (py_is_none(value) || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) {
    throw new PyTypeErrorP(`argument of type '${py_type_name(value)}' is not a mapping`);
  }
  const out: JsonDict = {};
  for (const [k, v] of py_dict_items(value)) out[k] = v;
  for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

/** `a, b = seq`（2 元解包）：长度不为 2 → ValueError（文案逐字复刻）。 */
function py_tuple2(v: unknown): [unknown, unknown] {
  let arr: readonly unknown[] | null = null;
  if (Array.isArray(v)) arr = v;
  else if (v instanceof Set) arr = [...(v as Set<unknown>)];
  else {
    try { arr = py_iter(v); } catch { arr = null; }
  }
  if (arr === null) throw new PyTypeErrorP(`cannot unpack non-iterable ${py_type_name(v)} object`);
  if (arr.length < 2) throw new PyValueErrorP(`not enough values to unpack (expected 2, got ${arr.length})`);
  if (arr.length > 2) throw new PyValueErrorP(`too many values to unpack (expected 2)`);
  return [arr[0], arr[1]];
}

/** `isinstance(v, str)`。 */
function py_isinstance_str(v: unknown): v is string {
  return typeof v === "string";
}

/** 从 (dict/list-of-pairs) 造 python `set(...)`；端口只需 Set<unknown> 的成员语义。 */
function py_set_str(values: Iterable<unknown>): Set<string> {
  const out = new Set<string>();
  for (const x of values) out.add(py_str(x));
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * §2 接缝表（红线 5：本段唯一的对外触碰面；探针在此插假件；缺省一律 fail-closed）
 * ──────────────────────────────────────────────────────────────────────── */

/** python `Result` 的鸭子面（`skill_lifecycle.*` / 各 `loader.*` / `registry.*` 返回值的 .ok/.error/.value/.meta）。 */
export interface ResultLike {
  readonly ok: unknown;
  readonly error: unknown;
  readonly value: unknown;
  readonly meta?: unknown;
}

/** 有 `to_dict()` 的返回值（VetResult / AgentEvent.from_row(...).to_dict()）。 */
export interface ToDictLike {
  to_dict(): unknown;
}

/** `skill_loader.get_skill_loader()`（源 3867/3973/4323/4368/4418/4498/4508）。 */
export interface SkillLoaderLike {
  discover(): void;
  list_skills(opts?: { include_disabled: boolean }): readonly unknown[];
  import_skill(path: unknown, trust: unknown): ResultLike;
  uninstall_skill(name: string): ResultLike;
  get_skill_detail(name: string): ResultLike;
  enable_skill(name: string): ResultLike;
  disable_skill(name: string): ResultLike;
}

/** `storage.get_storage()` 的本段消费面（多 handler 共用）。 */
export interface StorageLike {
  readonly workspace_root?: unknown;
  list_skill_experiences(opts: { skill_id: unknown; goal_id: unknown; limit: number }): readonly unknown[];
  relations_from(node_type: string, node_id: string, relation: unknown): readonly unknown[];
  relations_to(node_type: string, node_id: string, relation: unknown): readonly unknown[];
  list_episodes(opts: { session_id: string; branch_id: string; limit: number }): readonly unknown[];
  list_learning_items(opts: { session_id: string; branch_id: string; limit: number }): readonly unknown[];
  get_active_episode(opts: { session_id: string; branch_id: string }): unknown;
  get_learning_item(item_id: string): unknown;
  get_episode(episode_id: string): unknown;
  get_event_store(): EventStoreLike;
  list_skill_candidates(opts: { status: unknown; limit: number }): readonly unknown[];
  search_sessions_fts(q: string, opts: { workspace: string; limit: number }): readonly unknown[];
}

/** `storage.get_event_store()`：trace 用 read_stream，history 用 `_db.execute(...).fetchall()`（源 4256）。 */
export interface EventStoreLike {
  read_stream(session_id: string): readonly unknown[];
  readonly _db: {
    execute(sql: string, params: readonly unknown[]): { fetchall(): readonly unknown[] };
  };
}

/** `memory_domain.MemoryDomain(st)`（源 3955/3956）。 */
export interface MemoryDomainLike {
  list_items(workspace_root: unknown, opts: { statuses: readonly unknown[]; limit: number }): [readonly unknown[], unknown];
}

/** `learning_service.get_learning_service(st)`（源 4018/4020）——decide 返回的是 **dict**（源 `res.get(...)`）。 */
export interface LearningServiceLike {
  decide(opts: {
    item_id: string;
    action: string;
    session_id: string;
    branch_id: string;
    expected_version: unknown;
    idempotency_key: string;
    edited_content: unknown;
    reason: string;
  }): JsonDict;
}

/** `episode_manager.get_episode_manager(st)`（源 4233/4234）。 */
export interface EpisodeManagerLike {
  seal_episode_once(episode_id: string, reason: string): unknown;
}

/** `skill_lifecycle` 模块（源 4312/4322 的 `import skill_lifecycle as lifecycle`）。 */
export interface SkillLifecycleLike {
  create_candidate(storage: unknown, data: unknown): ResultLike;
  promote(storage: unknown, cand_id: string, loader: SkillLoaderLike): ResultLike;
  approve(storage: unknown, loader: SkillLoaderLike, cand_id: string): ResultLike;
  reject(storage: unknown, cand_id: string, reason: string): ResultLike;
  rollback(storage: unknown, loader: SkillLoaderLike, cand_id: string): ResultLike;
}

/** `plugin_registry.get_plugin_registry()`（源 4521/4530/4545/4553/4563）。 */
export interface PluginRegistryLike {
  list_plugins(): readonly unknown[];
  import_plugin(path: string): ResultLike;
  enable(name: string): ResultLike;
  disable(name: string): ResultLike;
  remove(name: string): ResultLike;
}

/** `skill_registry` 的四个安装/编目入口 + `agentskills_info`（源 4384/4419）。 */
export interface SkillRegistrySeams {
  marketplace_catalog(opts: { category: unknown; query: unknown; type_filter: unknown }): readonly unknown[];
  install_marketplace_skill(skill_id: string, loader: SkillLoaderLike): ResultLike;
  sync_lockfile(loader: SkillLoaderLike): ResultLike;
  install_from_github(source: string, skill_path: string, loader: SkillLoaderLike, name: unknown): ResultLike;
  agentskills_info(): unknown;
}

export interface HttpS5Seams {
  /** 源 3867 `from skill_loader import get_skill_loader`。 */
  skill_loader_get(): SkillLoaderLike;
  /** 源 4368 `from skill_loader import ... TrustLevel`；`TrustLevel(x)` 构造。 */
  skill_trust_level_from_str(trust_str: string): unknown;
  /** 源 4373 `TrustLevel.UNTRUSTED`（类属性）。 */
  skill_trust_untrusted(): unknown;
  /** 源 3878/3923/... `from storage import get_storage`。 */
  storage_get(): StorageLike;
  /** 源 3922/3925 `from approvals_projection import pending_approvals` + `pending_approvals(get_storage())`。 */
  pending_approvals(storage: unknown): unknown;
  /** 源 3955 `from memory_domain import MemoryDomain` + `MemoryDomain(st)`。 */
  memory_domain_ctor(storage: unknown): MemoryDomainLike;
  /** 源 4018/4020 `from learning_service import get_learning_service`。 */
  learning_service_get(storage: unknown): LearningServiceLike;
  /** 源 4217/4224 `from scope_guard import validate_scope` + 元组返回（trace 里 import 了但不用，见 S5-B3）。 */
  scope_validate_scope(opts: {
    expected_session: string;
    expected_branch: string;
    actual_session: string;
    actual_branch: string;
  }): [unknown, unknown];
  /** 源 4233/4234 `from episode_manager import get_episode_manager`。 */
  episode_manager_get(storage: unknown): EpisodeManagerLike;
  /** 源 4275/4286 `from mailbox import unread`。 */
  mailbox_unread(storage: unknown, box_id: string, opts: { limit: number }): readonly unknown[];
  /** 源 4290/4295 `from mailbox import drain`。 */
  mailbox_drain(storage: unknown, box_id: string): readonly unknown[];
  /** 源 4312/4322 `import skill_lifecycle as lifecycle`。 */
  skill_lifecycle_get(): SkillLifecycleLike;
  /** 源 4352/4353 `from event_bus import get_event_bus` + `await get_event_bus().emit(...)`。 */
  event_bus_emit(topic: string, payload: JsonDict): Promise<void>;
  /** `skill_registry` 全家（源 4384/4419）。 */
  skill_registry(): SkillRegistrySeams;
  /** 源 4473/4492 `from skill_vetter import vet_skill`（返回带 to_dict 的对象）。 */
  skill_vetter_vet(content: unknown): ToDictLike;
  /** 源 4521/4530/4545/4553/4563 `from plugin_registry import get_plugin_registry`。 */
  plugin_registry_get(): PluginRegistryLike;
  /** 源 4521 `from plugin_registry import SUPPORTED_CONTRIBUTIONS`（`list(...)` 消费）。 */
  plugin_supported_contributions(): readonly unknown[];
  /** 源 4259/4260 `from event_types import AgentEvent` + `AgentEvent.from_row(r)`。 */
  event_types_from_row(row: unknown): ToDictLike;
  /** 源 3957 `os.getcwd()`（session_learning 的 workspace 兜底支）。 */
  os_getcwd(): string;
  /** 源 4481 `os.path.isfile(skill_md)`（vet_skill）。 */
  fs_isfile(path: string): boolean;
  /** 源 4484 `open(skill_md, "r", encoding="utf-8").read()`（vet_skill，UTF-8 严格）。 */
  fs_read_text(path: string): string;
  /** 源 3928/4001/4098 `logging.getLogger(__name__).exception(...)`（**仅 approvals_pending 会走到**，另两处见 S5-B1/B2）。 */
  log_exception(message: string): void;
  /** 源 4362 `print(f"[skills] insight broadcast failed: {exc}")`。 */
  print_sink(line: string): void;
}

/** 源里每个函数级 import 的模块名（缺省臂的 ModuleNotFound 文案来源）。 */
const MOD = {
  skill_loader: "skill_loader",
  storage: "storage",
  approvals_projection: "approvals_projection",
  memory_domain: "memory_domain",
  learning_service: "learning_service",
  scope_guard: "scope_guard",
  episode_manager: "episode_manager",
  mailbox: "mailbox",
  skill_lifecycle: "skill_lifecycle",
  event_bus: "event_bus",
  skill_registry: "skill_registry",
  skill_vetter: "skill_vetter",
  plugin_registry: "plugin_registry",
  event_types: "event_types",
} as const;

function module_not_found(name: string): ModuleNotFoundErrorP {
  return new ModuleNotFoundErrorP(name);
}

/** 本段接缝名（`keyof HttpS5Seams`）——注册表的键域，也是探针"少接一臂"的核对面。 */
export type HttpS5SeamKey = keyof HttpS5Seams;

const _s5_seam_getters: Record<string, () => any> = {};

/** 装配层把真件接进本段（与 S7/S8/S9 同族的注册表）；未注册的臂保持缺省 fail-closed。 */
export function register_s5_seam<K extends HttpS5SeamKey>(key: K, getter: () => any): void {
  _s5_seam_getters[key] = getter;
}

export function reset_s5_seams_for_probe(): void {
  for (const k of Object.keys(_s5_seam_getters)) delete _s5_seam_getters[k];
}

/**
 * 解析当前生效的接缝表：已注册的臂用真件，其余回落缺省（fail-closed）。
 * handler 的 `seams` 默认值**每次调用**都重新解析 ⇒ 装配只需在服务启动时注册一次。
 */
export function resolve_http_s5_seams(): HttpS5Seams {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(HTTP_S5_SEAMS)) {
    const getter = _s5_seam_getters[key];
    out[key] = getter ? getter() : (HTTP_S5_SEAMS as any)[key];
  }
  return out as unknown as HttpS5Seams;
}

/**
 * 缺省 = 未接线 = 什么都不许悄悄成功：模块面抛 CPython 的 ModuleNotFoundError
 * （源里那些**不在 try** 的函数级 import 会直接冒出 handler；在 try 里的被同一臂吞成 500——逐点姿势不统一，
 * 端口也不统一，见各 handler 的 try 范围注释）。os_getcwd / fs_* / log_exception / print_sink 未接线一律抛。
 */
export const HTTP_S5_SEAMS: HttpS5Seams = {
  skill_loader_get(): SkillLoaderLike {
    throw module_not_found(MOD.skill_loader);
  },
  skill_trust_level_from_str(_trust_str: string): unknown {
    throw module_not_found(MOD.skill_loader);
  },
  skill_trust_untrusted(): unknown {
    throw module_not_found(MOD.skill_loader);
  },
  storage_get(): StorageLike {
    throw module_not_found(MOD.storage);
  },
  pending_approvals(_storage: unknown): unknown {
    throw module_not_found(MOD.approvals_projection);
  },
  memory_domain_ctor(_storage: unknown): MemoryDomainLike {
    throw module_not_found(MOD.memory_domain);
  },
  learning_service_get(_storage: unknown): LearningServiceLike {
    throw module_not_found(MOD.learning_service);
  },
  scope_validate_scope(_opts: {
    expected_session: string;
    expected_branch: string;
    actual_session: string;
    actual_branch: string;
  }): [unknown, unknown] {
    throw module_not_found(MOD.scope_guard);
  },
  episode_manager_get(_storage: unknown): EpisodeManagerLike {
    throw module_not_found(MOD.episode_manager);
  },
  mailbox_unread(_storage: unknown, _box_id: string, _opts: { limit: number }): readonly unknown[] {
    throw module_not_found(MOD.mailbox);
  },
  mailbox_drain(_storage: unknown, _box_id: string): readonly unknown[] {
    throw module_not_found(MOD.mailbox);
  },
  skill_lifecycle_get(): SkillLifecycleLike {
    throw module_not_found(MOD.skill_lifecycle);
  },
  async event_bus_emit(_topic: string, _payload: JsonDict): Promise<void> {
    throw module_not_found(MOD.event_bus);
  },
  skill_registry(): SkillRegistrySeams {
    throw module_not_found(MOD.skill_registry);
  },
  skill_vetter_vet(_content: unknown): ToDictLike {
    throw module_not_found(MOD.skill_vetter);
  },
  plugin_registry_get(): PluginRegistryLike {
    throw module_not_found(MOD.plugin_registry);
  },
  plugin_supported_contributions(): readonly unknown[] {
    throw module_not_found(MOD.plugin_registry);
  },
  event_types_from_row(_row: unknown): ToDictLike {
    throw module_not_found(MOD.event_types);
  },
  os_getcwd(): string {
    throw new PyNameErrorP("os_getcwd seam is not wired (fail closed)");
  },
  fs_isfile(_path: string): boolean {
    throw new PyNameErrorP("fs_isfile seam is not wired (fail closed)");
  },
  fs_read_text(_path: string): string {
    throw new PyNameErrorP("fs_read_text seam is not wired (fail closed)");
  },
  log_exception(_message: string): void {
    throw new PyNameErrorP("log_exception seam is not wired (fail closed)");
  },
  print_sink(_line: string): void {
    throw new PyNameErrorP("print_sink seam is not wired (fail closed)");
  },
};

/** 本段全部接缝名（S10/探针核对"少接一臂"用；顺序 = 接口字段名字典序，与源行号无关）。 */
export const HTTP_S5_SEAM_KEYS: readonly string[] = Object.keys(HTTP_S5_SEAMS).sort();

/* ──────────────────────────────────────────────────────────────────────────
 * §3 skills / experiences / relations / approvals（源 3866–3929）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/skills（源 3866–3871）。函数级 import 不在 try（3867）⇒ 未接线冒出 handler。
 * `loader.discover()` 先跑（3869），`list_skills(include_disabled=True)` 后跑（3870）。
 */
export async function handle_skills(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  void request;
  const loader = seams.skill_loader_get();
  loader.discover();
  const skills = loader.list_skills({ include_disabled: true });
  return json_response({ skills });
}

/**
 * GET /api/skills/experiences（源 3874–3888）。
 * `int(query.get("limit","50"))` **在 try 内**（3879–3882），坏值 → ValueError/TypeError 被兜成 50，钳位 1..200。
 * skill_id/goal_id 走 `query.get(name)` 单参 + `or None`（D2 → py_or(get,""), null）。
 */
export async function handle_skill_experiences(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  let limit: number;
  try {
    limit = Math.max(1, Math.min(py_int(request.query.get("limit", "50")), 200));
  } catch (exc) {
    if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc;
    limit = 50;
  }
  const skill_id = py_or(request.query.get("skill_id", ""), null);
  const goal_id = py_or(request.query.get("goal_id", ""), null);
  const rows = seams.storage_get().list_skill_experiences({ skill_id, goal_id, limit });
  return json_response({ experiences: rows });
}

/**
 * GET /api/relations（源 3890–3915）。
 * try 只罩 relations_from/to，且**只兜 ValueError**（3908）；缺参 400 在 try 之前（3901–3903）。
 * S5-B10：`staleCount` 的 `e.get("stale")`（3914）在 try **之外** ⇒ 非 dict 边的 `.get` 抛 AttributeError 逃逸。
 * `outgoing + incoming` 是列表拼接（不是 zip）。
 */
export async function handle_relations(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const node_type = request.query.get("node_type", "");
  const node_id = request.query.get("node_id", "");
  const relation = py_or(request.query.get("relation", ""), null);
  if (!py_truth(node_type) || !py_truth(node_id)) {
    return json_response({ error: "node_type and node_id are required" }, 400);
  }
  const st = seams.storage_get();
  let outgoing: readonly unknown[];
  let incoming: readonly unknown[];
  try {
    outgoing = st.relations_from(node_type, node_id, relation);
    incoming = st.relations_to(node_type, node_id, relation);
  } catch (exc) {
    if (!catches_classes(exc, VALUE_ERROR)) throw exc;
    return json_response({ error: exc_str(exc) }, 400);
  }
  const edges = [...outgoing, ...incoming];
  let stale_count = 0;
  for (const e of edges) {
    if (py_truth(py_dict_get(e, "stale"))) stale_count += 1;
  }
  return json_response({
    node: { type: node_type, id: node_id },
    outgoing,
    incoming,
    staleCount: stale_count,
  });
}

/**
 * GET /api/approvals/pending（源 3917–3929）。
 * try 罩 `pending_approvals(get_storage())`（3925）⇒ 任何异常都进 except Exception → 500。
 * 这一臂**有**本地 `import logging`（3927）⇒ 端口调 `log_exception()`（真 stdlib 不抛；未接线时抛，见 D7）。
 */
export async function handle_approvals_pending(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  void request;
  try {
    return json_response(await seams.pending_approvals(seams.storage_get()));
  } catch (exc) {
    seams.log_exception("GET /api/approvals/pending failed");
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §4 session learning（源 3932–4002）—— S5-B1 落点
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/sessions/{id}/learning（源 3932–4002）。
 * 前置：`session_id = match_info.get("id") or query.get("sessionId") or ""`（D2 折叠），缺 → 400。
 * 主体在**一个大 try**（3938）里；内部 memory/skill 两块各有 `except Exception: pass`（3986/3988）吞掉局部失败。
 * counts 用 `len([i for i in items if ...])` 列表推导（i.get 在非 dict 上抛 AttributeError → 冒到外层 try）。
 * S5-B1：外层 except（4000）先碰**未导入的自由名 `logging`** → NameError 逃逸，4002 的 500 不可达。
 */
export async function handle_session_learning(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const session_id = py_str(py_or(py_or(request.match_info.get("id", ""), request.query.get("sessionId", "")), ""));
  const branch_id = request.query.get("branchId", "");
  if (!py_truth(session_id)) {
    return json_response({ error: "sessionId is required" }, 400);
  }
  try {
    const st = seams.storage_get();
    const episodes = st.list_episodes({ session_id, branch_id, limit: 50 });
    const items = st.list_learning_items({ session_id, branch_id, limit: 100 });
    const active_ep = st.get_active_episode({ session_id, branch_id });

    const items_arr = py_iter(items);
    const counts: JsonDict = {
      total: py_len(items_arr),
      actionable: items_arr.filter((i) =>
        py_contains(["proposed", "staged"], py_dict_get(i, "status")) || py_dict_get(i, "user_verdict") === "pending",
      ).length,
      published: items_arr.filter((i) =>
        py_dict_get(i, "status") === "published" || py_dict_get(i, "user_verdict") === "approved",
      ).length,
      deferred: items_arr.filter((i) =>
        py_dict_get(i, "status") === "deferred" || py_dict_get(i, "user_verdict") === "deferred",
      ).length,
      failed: items_arr.filter((i) =>
        py_contains(["failed", "unknown"], py_dict_get(i, "status")),
      ).length,
    };

    const cross_session: unknown[] = [];
    try {
      const md = seams.memory_domain_ctor(st);
      const ws = py_or(py_getattr_or(st, "workspace_root", ""), seams.os_getcwd());
      const [mem_items] = py_tuple2(md.list_items(ws, { statuses: ["active"], limit: 20 }));
      for (const m of py_iter(mem_items)) {
        if (py_str(py_or(py_getattr_or(m, "source", ""), "")) !== session_id) {
          cross_session.push({
            id: py_getattr(m, "id"),
            kind: "memory",
            content: py_getattr(m, "content"),
            scope: py_or(py_getattr_or(m, "scope", "workspace"), "workspace"),
            source: py_str(py_or(py_getattr_or(m, "source", ""), "cross_session")),
            why: "Published active memory matching current workspace",
          });
        }
      }
      try {
        const loader = seams.skill_loader_get();
        for (const sk of py_iter(loader.list_skills())) {
          if (py_getattr_or(sk, "status", "") === "active" && py_truth(py_getattr_or(sk, "name", ""))) {
            const nm = py_getattr(sk, "name");
            cross_session.push({
              id: `skill-${py_str(nm)}`,
              kind: "skill",
              name: nm,
              content: py_or(py_or(py_getattr_or(sk, "description", ""), py_getattr_or(sk, "purpose", "")), nm),
              scope: "workspace",
              source: "skill_library",
              why: "Active verified skill available in runtime",
            });
          }
        }
      } catch {
        // except Exception: pass（3986–3987）
      }
    } catch {
      // except Exception: pass（3988–3989）
    }

    return json_response({
      sessionId: session_id,
      branchId: branch_id,
      episodes,
      learningItems: items,
      activeEpisode: active_ep,
      counts,
      crossSessionReused: cross_session,
    });
  } catch (exc) {
    py_undefined_logging();               // S5-B1：`logging` 是未导入自由名 → NameError 逃逸
    return json_response({ error: exc_str(exc) }, 500); // 源 4002 —— 端口里同样不可达
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §5 learning item action / trace（源 4005–4186）—— S5-B2 / S5-B3 落点
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/learning-items/{id}/{action}（源 4005–4099）。
 * 缺参 400 早退（4009–4010）→ `try: data=request.json() except Exception: data={}`（4011–4014）→ 主体大 try（4016）。
 * 严格幂等键（4035）与 scope 校验（4047–4071）都在大 try 内，任何异常 → except（4097）→ **S5-B2 的 logging NameError**。
 * `svc.decide(...)` 返回 dict，status_code 映射按 `res.get("status")`（4084–4094）。
 */
export async function handle_learning_item_action(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const item_id = request.match_info.get("id", "");
  const action = request.match_info.get("action", "");
  if (!(py_truth(item_id) && py_truth(action))) {
    return json_response({ ok: false, status: "invalid_request", error: "id and action required" }, 400);
  }
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    data = {};
  }
  try {
    const st = seams.storage_get();
    const svc = seams.learning_service_get(st);
    const item = st.get_learning_item(item_id);
    if (!py_truth(item)) {
      return json_response({ ok: false, status: "not_found", error: "Learning item not found" }, 404);
    }
    const session_id = py_strip(py_str(py_or(py_or(py_dict_get(data, "sessionId"), request.query.get("sessionId", "")), "")));
    const branch_id = py_strip(py_str(py_or(py_or(py_dict_get(data, "branchId"), request.query.get("branchId", "")), "")));
    const edited_content = py_dict_get(data, "content");
    const reason = py_str(py_or(py_dict_get(data, "reason"), ""));
    const expected_version = py_dict_get(data, "version");
    const idempotency_key = py_strip(py_str(py_or(py_or(py_dict_get(data, "idempotencyKey"), py_dict_get(data, "idempotency_key")), "")));

    if (!py_truth(idempotency_key)) {
      return json_response({
        ok: false,
        status: "idempotency_required",
        error: "idempotencyKey is required for mutation actions",
      }, 400);
    }

    const item_scope = py_str(py_or(py_dict_get(item, "scope"), "workspace"));
    const item_sid = py_strip(py_str(py_or(py_or(py_dict_get(item, "session_id"), py_dict_get(item, "source_session_id")), "")));
    const item_bid = py_strip(py_str(py_or(py_dict_get(item, "branch_id"), "")));

    if (item_scope !== "global") {
      if (!py_truth(item_sid)) {
        return json_response({ ok: false, status: "scope_mismatch", error: "Non-global learning item missing canonical session scope" }, 409);
      }
      if (!py_truth(session_id)) {
        return json_response({ ok: false, status: "scope_required", error: "sessionId is required for non-global learning item" }, 400);
      }
      if (session_id !== item_sid) {
        return json_response({ ok: false, status: "scope_mismatch", error: `sessionId mismatch: expected '${item_sid}', got '${session_id}'` }, 409);
      }
      if (branch_id !== item_bid) {
        return json_response({ ok: false, status: "scope_mismatch", error: `branchId mismatch: expected '${item_bid}', got '${branch_id}'` }, 409);
      }
    }

    const res = svc.decide({
      item_id,
      action,
      session_id,
      branch_id,
      expected_version,
      idempotency_key,
      edited_content,
      reason,
    });

    let status_code = 200;
    if (!py_truth(py_dict_get(res, "ok"))) {
      const st_val = py_dict_get(res, "status");
      if (py_contains(["scope_mismatch", "version_conflict", "idempotency_conflict"], st_val)) {
        status_code = 409;
      } else if (st_val === "not_found") {
        status_code = 404;
      } else if (py_contains(["scope_required", "idempotency_required", "invalid_request", "invalid_content"], st_val)) {
        status_code = 400;
      } else {
        status_code = 400;
      }
    }
    return json_response(res, status_code);
  } catch (exc) {
    py_undefined_logging();               // S5-B2：与 S5-B1 同型
    return json_response({ ok: false, status: "server_error", error: exc_str(exc) }, 500); // 源 4099 —— 不可达
  }
}

/**
 * GET /api/learning-items/{id}/trace（源 4102–4186）。
 * 与 action 不同的取值口径：query 读 **不** `.strip()` 之外的 None 面；session_id/branch_id `.strip()` 后使用。
 * 手写 scope 校验（4120–4128）与 global 流的严格隔离（4131–4142）；`src_ids = set(str(x) ...)`（4147）。
 * 敏感键掩码：`any(s in k.lower() for s in (...))`（4166）→ "[REDACTED]"；长串 `v[:500] + "..."`（4169，码点切片 D3）。
 * 外层 except Exception → **500**（这一臂**没有** logging，见源 4185，因此本 handler 不中招 S5-B1/B2）。
 */
export async function handle_learning_item_trace(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const item_id = request.match_info.get("id", "");
  const session_id = py_strip(request.query.get("sessionId", ""));
  const branch_id = py_strip(request.query.get("branchId", ""));
  try {
    const st = seams.storage_get();
    // S5-B3：源 4109 `from scope_guard import validate_scope` 从未被使用；端口不 import/不调用它。
    const item = st.get_learning_item(item_id);
    if (!py_truth(item)) {
      return json_response({ error: "Item not found" }, 404);
    }
    const item_scope = py_str(py_or(py_dict_get(item, "scope"), "workspace"));
    const sid = py_strip(py_str(py_or(py_or(py_dict_get(item, "session_id"), py_dict_get(item, "source_session_id")), "")));
    const bid = py_strip(py_str(py_or(py_dict_get(item, "branch_id"), "")));

    if (item_scope !== "global") {
      if (!py_truth(sid)) return json_response({ error: "Non-global learning item missing canonical session scope" }, 409);
      if (!py_truth(session_id)) return json_response({ error: "sessionId is required for non-global learning item trace" }, 400);
      if (session_id !== sid) return json_response({ error: `sessionId mismatch: expected '${sid}', got '${session_id}'` }, 409);
      if (branch_id !== bid) return json_response({ error: `branchId mismatch: expected '${bid}', got '${branch_id}'` }, 409);
    }

    let target_stream_sid = "";
    if (item_scope === "global") {
      if (py_truth(session_id) && session_id === sid) target_stream_sid = sid;
      else if (py_truth(session_id)) target_stream_sid = session_id;
      else target_stream_sid = "";
    } else {
      target_stream_sid = sid;
    }

    const es = st.get_event_store();
    const events: unknown[] = [];
    if (py_truth(target_stream_sid)) {
      const src_ids = py_set_str(py_iter(py_dict_get(item, "source_event_ids", [])));
      const target_turn_id = py_str(py_or(py_dict_get(item, "source_turn_id"), ""));
      for (const ev of py_iter(es.read_stream(target_stream_sid))) {
        const d = py_call_to_dict(ev);
        const ev_id = py_str(py_or(py_or(py_getattr_or(ev, "event_id", ""), py_dict_get(d, "event_id")), ""));
        const ev_idem = py_str(py_or(py_dict_get(d, "idempotency_key"), ""));
        const ev_turn = py_str(py_or(py_or(py_getattr_or(ev, "turn_id", ""), py_dict_get(d, "turn_id")), ""));
        const p = py_or(py_dict_get(d, "payload"), {});

        const matched =
          (py_truth(ev_id) && py_contains(src_ids, ev_id)) ||
          (py_truth(ev_idem) && py_contains(src_ids, ev_idem)) ||
          (py_truth(target_turn_id) && ev_turn === target_turn_id) ||
          (py_str(py_or(py_or(py_dict_get(p, "learning_item_id"), py_dict_get(p, "itemId")), "")) === item_id);

        if (matched) {
          const sanitized_payload: JsonDict = {};
          for (const [k, v] of py_dict_items(p)) {
            const kl = py_str(k).toLowerCase();
            if (["token", "cookie", "secret", "password", "key", "auth"].some((s) => py_contains(kl, s))) {
              sanitized_payload[k] = "[REDACTED]";
            } else if (py_isinstance_str(v) && py_len(v) > 500) {
              sanitized_payload[k] = py_head(v, 500) + "...";
            } else {
              sanitized_payload[k] = v;
            }
          }
          events.push({
            seq: py_dict_get(d, "seq", 0),
            eventId: ev_id,
            eventType: py_dict_get(d, "event_type", ""),
            timestamp: py_dict_get(d, "timestamp", 0),
            sessionId: py_dict_get(d, "session_id", ""),
            branchId: py_dict_get(d, "branch_id", ""),
            turnId: ev_turn,
            summary: py_str(py_or(py_or(py_or(py_dict_get(p, "why"), py_dict_get(p, "content")), py_dict_get(p, "title")), py_dict_get(d, "event_type", ""))),
            payload: sanitized_payload,
          });
        }
      }
    }
    return json_response({ itemId: item_id, events });
  } catch (exc) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §6 episodes / history trace（源 4190–4271）—— S5-B4 / S5-B5 落点
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/episodes（源 4190–4200）。
 * S5-B4：`int(query.get("limit","50"))` 在 try **之外**（4194）⇒ `?limit=abc` 的 ValueError 冒出 handler。
 * try（4195–4198）只兜 list_episodes。
 */
export async function handle_episodes_list(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const session_id = request.query.get("sessionId", "");
  const branch_id = request.query.get("branchId", "");
  const limit = Math.max(1, Math.min(py_int(request.query.get("limit", "50")), 100)); // S5-B4：无 try
  try {
    const st = seams.storage_get();
    return json_response({ episodes: st.list_episodes({ session_id, branch_id, limit }) });
  } catch (exc) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/**
 * POST /api/episodes/seal（源 4203–4238）。
 * 第一段 try 只罩 `request.json()`（4205–4208，except Exception -> {}）；
 * S5-B7：4209–4212 的 `data.get(...)` 在两段 try 之间 ⇒ 数组 body 的 AttributeError 逃逸。
 * 第二段 try（4215）罩 storage/validate_scope/em.seal；缺 ep → 404；validate_scope 返回元组 `is_valid, err`。
 * `em.seal_episode_once` 的返回值直接进 body 的 `ok`（不判真假）。
 */
export async function handle_episode_seal(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    data = {};
  }
  const episode_id = py_str(py_or(py_or(py_dict_get(data, "episodeId"), py_dict_get(data, "id")), ""));
  const reason = py_str(py_or(py_dict_get(data, "reason"), "user_request"));
  const session_id = py_str(py_or(py_dict_get(data, "sessionId"), ""));
  const branch_id = py_str(py_or(py_dict_get(data, "branchId"), ""));
  if (!py_truth(episode_id)) {
    return json_response({ error: "episodeId is required" }, 400);
  }
  try {
    const st = seams.storage_get();
    const ep = st.get_episode(episode_id);
    if (!py_truth(ep)) {
      return json_response({ error: "Episode not found" }, 404);
    }
    if (py_truth(session_id)) {
      const [is_valid, err] = seams.scope_validate_scope({
        expected_session: session_id,
        expected_branch: branch_id,
        actual_session: py_str(py_or(py_dict_get(ep, "session_id"), "")),
        actual_branch: py_str(py_or(py_dict_get(ep, "branch_id"), "")),
      });
      if (!py_truth(is_valid)) {
        return json_response({ error: `Scope mismatch: ${py_str(err)}` }, 409);
      }
    }
    const em = seams.episode_manager_get(st);
    const ok = em.seal_episode_once(episode_id, reason);
    return json_response({ ok });
  } catch (exc) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/**
 * GET /api/history/trace（源 4242–4271）。
 * S5-B5：`int(query.get("limit","100"))` 在 try（4249）之外 ⇒ ValueError 逃逸。
 * 有 session_id 走 read_stream；否则 `es._db.execute(SQL, (limit,)).fetchall()` + `AgentEvent.from_row(r).to_dict()`。
 * 三条后置过滤 goal_id/run_id/turn_id 都在 try 内；`events[:limit]` 列表前缀。
 */
export async function handle_history_trace(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const session_id = request.query.get("sessionId", "");
  const goal_id = request.query.get("goalId", "");
  const run_id = request.query.get("runId", "");
  const turn_id = request.query.get("turnId", "");
  const limit = Math.max(1, Math.min(py_int(request.query.get("limit", "100")), 500)); // S5-B5：无 try
  try {
    const es = seams.storage_get().get_event_store();
    let events: unknown[];
    if (py_truth(session_id)) {
      events = py_iter(es.read_stream(session_id)).map((e) => py_call_to_dict(e));
    } else {
      const rows = py_iter(es._db.execute("SELECT * FROM events ORDER BY seq DESC LIMIT ?", [limit]).fetchall());
      events = rows.map((r) => py_call_to_dict(seams.event_types_from_row(r)));
    }
    if (py_truth(goal_id)) events = events.filter((e) => py_dict_get(e, "goal_id") === goal_id);
    if (py_truth(run_id)) events = events.filter((e) => py_dict_get(e, "run_id") === run_id);
    if (py_truth(turn_id)) events = events.filter((e) => py_dict_get(e, "turn_id") === turn_id);
    return json_response({ events: py_list_head(events, limit) });
  } catch (exc) {
    return json_response({ error: exc_str(exc) }, 500);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * §7 mailbox / skill candidates（源 4273–4364）—— S5-B8 / S5-B9 / S5-B1 家族
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/mailbox/{box_id}（源 4273–4286）。
 * S5-B9：box_id = `match_info.get("box_id") or query.get("box_id") or ""`（**兜 query**）。
 * int 钳位在 try 内（4280–4283），坏值 → 50。`unread(get_storage(), box_id, limit=limit)`。
 */
export async function handle_mailbox_list(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const box_id = py_str(py_or(py_or(request.match_info.get("box_id", ""), request.query.get("box_id", "")), ""));
  if (!py_truth(box_id)) {
    return json_response({ error: "box_id is required" }, 400);
  }
  let limit: number;
  try {
    limit = Math.max(1, Math.min(py_int(request.query.get("limit", "50")), 200));
  } catch (exc) {
    if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc;
    limit = 50;
  }
  return json_response({ boxId: box_id, messages: seams.mailbox_unread(seams.storage_get(), box_id, { limit }) });
}

/**
 * POST /api/mailbox/{box_id}/drain（源 4288–4297）。
 * S5-B9：box_id **只**从 match_info 取（不兜 query）——与 list 不一致，逐字保留。
 * 无 try；`drain` 与 `get_storage()` 冒错即逃逸。
 */
export async function handle_mailbox_drain(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const box_id = py_str(py_or(request.match_info.get("box_id", ""), ""));
  if (!py_truth(box_id)) {
    return json_response({ error: "box_id is required" }, 400);
  }
  const msgs = seams.mailbox_drain(seams.storage_get(), box_id);
  return json_response({ boxId: box_id, drained: py_len(msgs), messages: msgs });
}

/**
 * GET /api/skills/candidates（源 4299–4308）。status 单参 + `or None`；int 钳位在 try 内 → 50。
 */
export async function handle_skill_candidates(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const status = py_or(request.query.get("status", ""), null);
  let limit: number;
  try {
    limit = Math.max(1, Math.min(py_int(request.query.get("limit", "50")), 200));
  } catch (exc) {
    if (!catches_classes(exc, VALUE_OR_TYPE_ERROR)) throw exc;
    limit = 50;
  }
  return json_response({ candidates: seams.storage_get().list_skill_candidates({ status, limit }) });
}

/**
 * POST /api/skills/candidates（源 4310–4318）。
 * **BARE json**（4314，B4）：异常冒出 handler。`create_candidate(get_storage(), data or {})`。
 * `res.ok`/`res.error`/`res.value` 走属性访问（源 4316/4317/4318）。
 */
export async function handle_skill_candidate_create(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const lifecycle = seams.skill_lifecycle_get();
  const data: unknown = await request.json();                         // BARE（4314）
  const res = lifecycle.create_candidate(seams.storage_get(), py_or(data, {}));
  if (!py_truth(py_getattr(res, "ok"))) {
    return json_response({ error: py_getattr(res, "error") }, 400);
  }
  return json_response({ candidate: py_getattr(res, "value") });
}

/**
 * POST /api/skills/candidates/{id}/{action}（源 4320–4364，#49–#52 四条注册同一个 handler）。
 * `cand_id = match_info["id"]` / `action = match_info["action"]` 是**方括号取值**（4325/4326，缺键 KeyError）。
 * reject 支才有 json 兜底（4334–4337），且 `reason = str((data or {}).get("reason") or "")` 在兜底 try 之外
 *   （S5-B8：数组 body → AttributeError 逃逸）。未知动词 → 404。
 * 失败 → 409 `{error, candidate: getattr(res,"value",None)}`；成功后广播 evolution_insight（try/except print）。
 * 最终 body：`{candidate: res.value, **({"detail": res.meta.get("detail")} if getattr(res,"meta",None) and ... else {})}`。
 */
export async function handle_skill_candidate_action(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const lifecycle = seams.skill_lifecycle_get();
  const loader = seams.skill_loader_get();
  const cand_id = request.match_info.index("id");
  const action = request.match_info.index("action");
  const st = seams.storage_get();
  let res: ResultLike;
  if (action === "promote") {
    res = lifecycle.promote(st, cand_id, loader);
  } else if (action === "approve") {
    res = lifecycle.approve(st, loader, cand_id);
  } else if (action === "reject") {
    let data: unknown;
    try {
      data = await request.json();
    } catch {
      data = {};
    }
    const reason = py_str(py_or(py_dict_get(py_or(data, {}), "reason"), "")); // S5-B8：.get 在 try 外（data 是数组时抛）
    res = lifecycle.reject(st, cand_id, reason);
  } else if (action === "rollback") {
    res = lifecycle.rollback(st, loader, cand_id);
  } else {
    return json_response({ error: `unknown action ${action}` }, 404);
  }
  if (!py_truth(py_getattr(res, "ok"))) {
    return json_response({ error: py_getattr(res, "error"), candidate: py_getattr_or(res, "value", null) }, 409);
  }
  const cand = py_or(py_getattr(res, "value"), {}) as JsonDict;
  const kind_map: JsonDict = {
    promote: "candidate_staged", approve: "candidate_active",
    reject: "candidate_archived", rollback: "rolled_back",
  };
  try {
    await seams.event_bus_emit("evolution_insight", {
      kind: py_dict_get(kind_map, action, action),
      detail: py_str(py_or(
        py_dict_get(py_or(py_getattr_or(res, "meta", null), {}), "detail"),
        `${action}: ${py_dict_get(cand, "name")}`,
      )),
      candidateId: py_dict_get(cand, "id"),
      skillName: py_dict_get(cand, "name"),
      status: py_dict_get(cand, "status"),
      decision: action === "promote" ? "needs_approval" : null,
    });
  } catch (exc) {
    seams.print_sink(`[skills] insight broadcast failed: ${exc_str(exc)}`);
  }
  const meta = py_getattr_or(res, "meta", null);
  const detail_extra: JsonDict = (py_truth(meta) && py_truth(py_dict_get(meta, "detail")))
    ? { detail: py_dict_get(meta, "detail") }
    : {};
  const body = py_dict_spread({ candidate: py_getattr(res, "value") }, detail_extra);
  return json_response(body);
}

/* ──────────────────────────────────────────────────────────────────────────
 * §8 skills 市场 / 安装 / 卸载 / 详情 / 启停（源 4367–4514）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/skills/import（源 4367–4379）。**BARE json**（4370）。
 * `data.get("path","")` / `data.get("trust","untrusted")`；trust 在成员元组内才 `TrustLevel(x)`，否则 UNTRUSTED。
 * `if not path` 400；`loader.import_skill(path, trust)`；ok → value，否则 400。
 */
export async function handle_import_skill(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const loader = seams.skill_loader_get();
  const data: unknown = await request.json();                         // BARE（4370）
  const path = py_dict_get(data, "path", "");
  const trust_str = py_dict_get(data, "trust", "untrusted");
  const trust = py_contains(["own", "verified", "untrusted"], trust_str)
    ? seams.skill_trust_level_from_str(py_str(trust_str))
    : seams.skill_trust_untrusted();
  if (!py_truth(path)) {
    return json_response({ error: "path required" }, 400);
  }
  const result = loader.import_skill(path, trust);
  if (py_truth(py_getattr(result, "ok"))) {
    return json_response(py_getattr(result, "value"));
  }
  return json_response({ error: py_getattr(result, "error") }, 400);
}

/**
 * GET /api/skills/marketplace（源 4382–4389）。
 * 三个 filter 都是 `rel_url.query.get(name,"").strip() or None`（D1 → request.query；D3 码点 strip）。
 * `total: len(catalog)`。
 */
export async function handle_marketplace_catalog(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const category = py_or(py_strip(request.query.get("category", "")), null);
  const query = py_or(py_strip(request.query.get("q", "")), null);
  const type_filter = py_or(py_strip(request.query.get("type", "")), null);
  const catalog = seams.skill_registry().marketplace_catalog({ category, query, type_filter });
  return json_response({ catalog, total: py_len(catalog) });
}

/** POST /api/skills/{name}/uninstall（源 4392–4401）。ok → 硬编码 `status:"disabled"`，否则 400 `{ok:false,error}`。 */
export async function handle_uninstall_skill(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const name = request.match_info.get("name", "");
  if (!py_truth(name)) {
    return json_response({ error: "name required" }, 400);
  }
  const res = seams.skill_loader_get().uninstall_skill(name);
  if (py_truth(py_getattr(res, "ok"))) {
    return json_response({ ok: true, uninstalled: name, status: "disabled" });
  }
  return json_response({ ok: false, error: py_getattr(res, "error") }, 400);
}

/** GET /api/skills/{name}（源 4404–4413）。ok → value，否则 **404**（不是 400）。 */
export async function handle_skill_detail(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const name = request.match_info.get("name", "");
  if (!py_truth(name)) {
    return json_response({ error: "name required" }, 400);
  }
  const res = seams.skill_loader_get().get_skill_detail(name);
  if (py_truth(py_getattr(res, "ok"))) {
    return json_response(py_getattr(res, "value"));
  }
  return json_response({ error: py_getattr(res, "error") }, 404);
}

/**
 * POST /api/skills/install（源 4416–4440）。**BARE json**（4420）。
 * 三叉：skill_id → install_marketplace_skill（**提前 return**）；sync_lockfile；source+skillPath；else 400。
 * S5-B11：fall-through 两支的 `result` 若 value 非 mapping → `**result.value` 抛 TypeError 逃逸。
 * `data["skill_id"]` 方括号（4423）在前置 `if data.get("skill_id")` 之后，故键存在。
 */
export async function handle_install_skill(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const loader = seams.skill_loader_get();
  const registry = seams.skill_registry();
  const data: unknown = await request.json();                         // BARE（4420）
  if (py_truth(py_dict_get(data, "skill_id"))) {
    const result = registry.install_marketplace_skill(py_str(py_dict_index(data, "skill_id")), loader);
    if (py_truth(py_getattr(result, "ok"))) {
      return json_response(py_getattr(result, "value"));
    }
    return json_response({ error: py_getattr(result, "error") }, 400);
  } else if (py_truth(py_dict_get(data, "sync_lockfile"))) {
    const result = registry.sync_lockfile(loader);
    if (py_truth(py_getattr(result, "ok"))) {
      return json_response(py_dict_spread(py_getattr(result, "value"), { registry: registry.agentskills_info() })); // S5-B11
    }
    return json_response({ error: py_getattr(result, "error") }, 400);
  } else if (py_truth(py_dict_get(data, "source")) && py_truth(py_dict_get(data, "skillPath"))) {
    const result = registry.install_from_github(
      py_str(py_dict_index(data, "source")),
      py_str(py_dict_index(data, "skillPath")),
      loader,
      py_dict_get(data, "name"),
    );
    if (py_truth(py_getattr(result, "ok"))) {
      return json_response(py_dict_spread(py_getattr(result, "value"), { registry: registry.agentskills_info() })); // S5-B11
    }
    return json_response({ error: py_getattr(result, "error") }, 400);
  } else {
    return json_response({ error: "skill_id, source+skillPath or sync_lockfile required" }, 400);
  }
}

/**
 * GET /api/sessions/search（源 4444–4454）。
 * S5-B6：`limit = int(...or 10)` 整函数无 try、且在 `if not q` 400 之前 ⇒ `?limit=abc`（哪怕 q 合法/缺失）先抛。
 * `q`/`workspace` 走 rel_url.query（D1）。`search_sessions_fts(q, workspace=..., limit=...)`。
 */
export async function handle_search_sessions(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const q = py_strip(request.query.get("q", ""));
  const workspace = request.query.get("workspace", "");
  const limit = py_int(py_or(request.query.get("limit", "10"), 10)); // S5-B6：无 try
  if (!py_truth(q)) {
    return json_response({ error: "q required" }, 400);
  }
  const hits = seams.storage_get().search_sessions_fts(q, { workspace, limit });
  return json_response({ query: q, hits });
}

/**
 * POST /api/skills/vet（源 4457–4493）。**BARE json**（4475）。
 * content/path 都从 body 取；`not content and path` → 拼 `join(path,"SKILL.md")`（D3：py_path_str 先校验非 str）
 * → isfile 检查（缺 400，文案用**原 path** 而非拼好的 skill_md）→ open+read（try/except → 400，S5-B 家族）。
 * `if not content` 再判一次 400。最后 `vet_skill(content).to_dict()`。
 */
export async function handle_vet_skill(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const data: unknown = await request.json();                         // BARE（4475）
  let content = py_dict_get(data, "content");
  const path = py_dict_get(data, "path");
  if (!py_truth(content) && py_truth(path)) {
    const skill_md = os_path_join(py_path_str(path, "join"), "SKILL.md");
    if (!seams.fs_isfile(skill_md)) {
      return json_response({ error: `SKILL.md not found in ${py_str(path)}` }, 400);
    }
    try {
      content = seams.fs_read_text(skill_md);
    } catch (e) {
      return json_response({ error: `cannot read SKILL.md: ${exc_str(e)}` }, 400);
    }
  }
  if (!py_truth(content)) {
    return json_response({ error: "path or content required" }, 400);
  }
  return json_response(py_call_to_dict(seams.skill_vetter_vet(content)));
}

/** POST /api/skills/{name}/enable（源 4497–4504）——**没有 `if not name` 前置检查**（与 uninstall/detail 不对称）。 */
export async function handle_enable_skill(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const loader = seams.skill_loader_get();
  const name = request.match_info.get("name", "");
  const result = loader.enable_skill(name);
  if (py_truth(py_getattr(result, "ok"))) {
    return json_response({ enabled: name });
  }
  return json_response({ error: py_getattr(result, "error") }, 400);
}

/** POST /api/skills/{name}/disable（源 4507–4514）——同 enable，无 name 前置检查。 */
export async function handle_disable_skill(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const loader = seams.skill_loader_get();
  const name = request.match_info.get("name", "");
  const result = loader.disable_skill(name);
  if (py_truth(py_getattr(result, "ok"))) {
    return json_response({ disabled: name });
  }
  return json_response({ error: py_getattr(result, "error") }, 400);
}

/* ──────────────────────────────────────────────────────────────────────────
 * §9 plugins（源 4519–4567）
 * ──────────────────────────────────────────────────────────────────────── */

/** GET /api/plugins（源 4519–4525）。`supported = list(SUPPORTED_CONTRIBUTIONS)`（S5 用 py_iter 折成数组）。 */
export async function handle_plugins(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  void request;
  return json_response({
    plugins: seams.plugin_registry_get().list_plugins(),
    supported: [...py_iter(seams.plugin_supported_contributions())],
  });
}

/**
 * POST /api/plugins/import（源 4528–4541）。
 * **仅** `except json.JSONDecodeError -> 400 invalid JSON`（4533）：解析失败面比 `except Exception` 窄（B4 的第二族）。
 * 解析成功后 `body.get("path")` 若 body 是数组/非 dict → AttributeError 逃逸（4535 在 try 之外）。
 */
export async function handle_import_plugin(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (exc) {
    // except json.JSONDecodeError —— 只认 JSON 解码族（源把非 JSONDecodeError 视为逃逸）
    if (!catches_classes(exc, JSON_DECODE_ERROR)) throw exc;
    return json_response({ error: "invalid JSON" }, 400);
  }
  const path = py_strip(py_str(py_or(py_dict_get(body, "path"), "")));
  if (!py_truth(path)) {
    return json_response({ error: "path required" }, 400);
  }
  const result = seams.plugin_registry_get().import_plugin(path);
  if (py_truth(py_getattr(result, "ok"))) {
    return json_response(py_getattr(result, "value"));
  }
  return json_response({ error: py_getattr(result, "error") }, 400);
}

/** `json.JSONDecodeError` 的族判定名（其 `name`/文案前缀在端口里落 "JSONDecodeError"/"ValueError"）。 */
const JSON_DECODE_ERROR: readonly string[] = ["JSONDecodeError"];

/** POST /api/plugins/{name}/enable（源 4544–4549）。ok → value，否则 **404**。 */
export async function handle_plugin_enable(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const result = seams.plugin_registry_get().enable(request.match_info.get("name", ""));
  if (py_truth(py_getattr(result, "ok"))) {
    return json_response(py_getattr(result, "value"));
  }
  return json_response({ error: py_getattr(result, "error") }, 404);
}

/** POST /api/plugins/{name}/disable（源 4552–4557）。 */
export async function handle_plugin_disable(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const result = seams.plugin_registry_get().disable(request.match_info.get("name", ""));
  if (py_truth(py_getattr(result, "ok"))) {
    return json_response(py_getattr(result, "value"));
  }
  return json_response({ error: py_getattr(result, "error") }, 404);
}

/** DELETE /api/plugins/{name}（源 4560–4567）。**故意不删磁盘文件**（docstring 4561–4562）。 */
export async function handle_plugin_remove(
  request: WebRequest,
  seams: HttpS5Seams = resolve_http_s5_seams(),
): Promise<WebResponse> {
  const result = seams.plugin_registry_get().remove(request.match_info.get("name", ""));
  if (py_truth(py_getattr(result, "ok"))) {
    return json_response(py_getattr(result, "value"));
  }
  return json_response({ error: py_getattr(result, "error") }, 404);
}

/* ──────────────────────────────────────────────────────────────────────────
 * §10 私有 helper：把 keys.ts 未直接给出的两个组合面收在一处
 * ──────────────────────────────────────────────────────────────────────── */

/** `x.to_dict()`：非可调用属性 → TypeError（`'NoneType' object is not callable` / AttributeError 由 py_getattr 抛）。 */
function py_call_to_dict(x: unknown): unknown {
  const fn = py_getattr(x, "to_dict");
  if (typeof fn !== "function") {
    throw new PyTypeErrorP(`'${py_type_name(fn)}' object is not callable`);
  }
  return (fn as () => unknown).call(x);
}

// PORT STATUS: 本文件无 TODO(port)。
