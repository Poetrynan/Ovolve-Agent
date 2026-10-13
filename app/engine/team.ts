/**
 * team.ts — port of app/backend/team.py (unit 175, wave 7, SPLIT).
 *
 * SOURCE: app/backend/team.py (948 lines) — Subagent Team 协作原语：
 *   TaskSpec/派单合同 · REVIEW_PERSPECTIVE_TEMPLATES + Reviewer-Critic 裁决 ·
 *   ROLE_PRESETS + F3 分模型路由 · ResultContract 契约验收（enforce_contracts）·
 *   TaskLease（sqlite upsert 租约）· TeamBoard（DAG 看板）· DispatchPipeline。
 *
 * SPLIT 口径：本文件是 TS 侧（全部纯逻辑 + 契约 + 看板 + 路由裁决）；python 侧
 *   留在 app/backend/team.py 的原样不动，sqlite 方言（ON CONFLICT … WHERE）由
 *   两端各自的真实 SQLite 引擎执行（见 acquire_lease 的 DIVERGENCE 说明），
 *   本模块只负责拼 SQL、绑参、读 rowcount——与原码一致。
 *
 * RULEBOOK CITATIONS
 *   §4 naming: 每个模块级 python 名字原样保留拼写 —— TaskSpec, build_task_spec,
 *     validate_task_spec, format_task_spec_contract, prefetch_context_refs,
 *     REVIEW_PERSPECTIVE_TEMPLATES, ReviewVerdict, adjudicate_review_findings,
 *     ROLE_PRESETS, role_spec, MODEL_ROLES, ROLE_MODEL_ROLE_DEFAULTS,
 *     resolve_model_for_role, resolve_subagent_model, check_result_contract,
 *     _SUMMARY_CONTRACT, PERSONA_RESULT_SCHEMAS, get_persona_contract,
 *     _emit_contract_telemetry, _emit_quarantine_telemetry, enforce_contracts,
 *     _LEASE_DDL, _ensure_lease_table, acquire_lease, release_lease, TeamBoard,
 *     DispatchPipeline。本文件自用的 python 语义助手是 file-local 且带 py* 前缀，
 *     不与兄弟模块的同名助手冲突。
 *   §2 真值/None 三态：`x or y`、`if not x`、`if x`、`is False`、
 *     `if not payload.get("summary")` 全部走 pyTruth／严格 false 判定，
 *     绝不塌成 `!== undefined`；"省略参数"用 arguments.length，
 *     "传了 None"用 null（QUIRK 6、9、13）。
 *   §2 `str()`/repr：`f"{ref}"`、`f"… got {type(x).__name__}"`、
 *     `f"unknown review verdict {verdict!r}"` 里的插值分别是 str()（容器走 repr）
 *     和 repr()（字符串带引号），由 pyStr/pyRepr 分别建模；`type(x).__name__`
 *     由 pyTypeName 给出 str/list/dict/int/float/bool/NoneType 与类名。
 *   §2 键插入顺序即契约：TaskSpec.to_dict、role_spec、enforce_contracts 的
 *     contract 字典、persona_breakdown、TeamBoard 条目与 view() 的合并顺序，
 *     全部按 python 源码的字面顺序构造（比较器对键序敏感）。
 *   §2 `dict | {…}`（TeamBoard.view）：python 3.9 的合并在 JS 里按
 *     "先复制非 spec 键、再覆盖 role、末尾追加 tools" 建模，保持原顺序语义。
 *   §2 数字→字符串：pyNumStr 保证整数值渲染成 int 样式（见 DIVERGENCE）。
 *   §2 异常身份：探针比对 [type(e).__name__, str(e)]，所以 ValueError/TypeError/
 *     AttributeError/KeyError/OverflowError 的文案逐字照抄 CPython 3.13。
 *   §2 `str.strip()`：pyStrip 用 python 的 isspace() 集合（含 \x1c-\x1f、\x85、
 *     \xa0、\u2028/\u2029、\u3000），而不是 JS 的 \s；
 *     `l.strip("- *• ")` 是**字符集**剥离，另用 pyStripChars。
 *   §2 `str.splitlines()`：pySplitLines 覆盖 \n \r \r\n \v \f \x1c \x1d \x1e
 *     \x85 \u2028 \u2029，且末尾换行不产生空尾元素。
 *   §2 迭代/解包：`for x in y` 用 pyIter（str 按码点、dict 按键、非可迭代抛
 *     python 文案的 TypeError）；`verdict, reason = critic_fn(f)` 用 pyUnpack2。
 *   §2 `int(x)`：pyInt 建模截断、bool、下划线数字字面量与三条 CPython 错误文案。
 *   §2 `round(x, 3)`：pyRound 是**精确**的 banker's rounding（BigInt 有理数），
 *     因为 1/16=0.0625 这类恰好半分点 JS 的 toFixed 会给 0.063 而 python 给 0.062。
 *   §2 `json.dumps(x)`：pyJsonDumps 复刻 CPython 的 `", "`/`": "` 分隔、
 *     插入顺序键、ensure_ascii 转义（telemetry 载荷里 persona_breakdown 走它）。
 *   §4.9 晚绑定：原码在**函数体内** `from code_graph import get_code_graph`、
 *     `from telemetry import …`，每次调用重新解析；端口把这两路放进 TEAM_SEAMS，
 *     取不到时抛 ImportErrorP，与原码的 ImportError 走同一条 except 臂。
 *   §4.12 telemetry 是 DELETE 单元（不存在 telemetry.ts）：调用点不删，
 *     改为默认 seam 抛 ImportError —— 与原码 `except Exception: pass` 的
 *     生产行为**逐字相同**（静默无副作用），同时让探针能绑定假模块把
 *     attributes 变成一等比对事实（否则这段代码永远不可观察）。
 *   §2/§4.5 关键字参数：`role_spec(role, *, overrides)`、
 *     `acquire_lease(..., *, ttl_s)`、`add_task(..., *, depends_on, overrides,
 *     task_spec)`、`DispatchPipeline.dispatch(..., *, fork, task_spec)` 变成
 *     options 位；多余位置实参按 CPython 文案抛 "takes N positional argument(s)"，
 *     有默认值的签名用 "takes from N to M …"。
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. build_task_spec 的 goal 校验是三段式：`not goal` 先挡掉 0/False/[]/None，
 *      再 isinstance(str)，最后 strip() 非空——所以 goal="   " 报的是
 *      "goal must be a non-empty string"，而 goal=[1] 报的是同一句话（不是类型错）。
 *      写进合同的 goal 是 **strip 之后**的值。
 *   2. validate_task_spec 的 `type(spec_data).__name__` 出现在返回的 problems 里
 *      ——传 int 得到 "…got int"，传 TaskSpec 实例走 to_dict 分支永远不会走到这句。
 *   3. validate_task_spec 只看 `field_name in d`：in_scope 键**不存在**时不报错，
 *      存在但为 None 才报 "must be a list"；acceptance 是 list **或 tuple** 都算数。
 *   4. format_task_spec_contract 的空判定在最外层 `if not spec_data`：
 *      空 dict、空 TaskSpec-ish 列表都会返回 ""；但未知类型（int）返回 ""，
 *      而**非空非 dict**（如 [1]）也返回 "" —— 三条臂各有入口条件。
 *      每个列表项先 `str(x)` 再 `if str(x).strip()`，所以 [0, " "] → 只剩 []，
 *      进而该段整行不输出（clean_in 为空）。
 *   5. context_refs 段先按真值过滤 `[r for r in refs if r]`（0/""/[] 被丢掉，
 *      留下的是 dict 才进 ref 明细臂），`kind` 为 "symbol"/"reference" 时
 *      **不打印** [kind]；`loc` 需要 path 和 line **同时**为真；
 *      parts 为空时打印的是 `str(ref)`（整个 dict 的 python repr）。
 *   6. prefetch_context_refs 的降级臂：refs 为空才补占位（{"symbol","path",
 *      "line","kind"} —— 注意**没有 "doc" 键**，所以占位项渲染时不打印 "- doc"）。
 *      外层 try 包住整个循环：中途任何异常（find_symbol 抛错、res 不是 dict、
 *      `int(res["line"])` 的 ValueError）都**吞掉**，已收集的部分结果若非空就不再降级。
 *      `doc` 被 `[:200]` 截断，`line` 走 `int(x or 0)`。
 *   7. ROLE_PRESETS 的 result_schema 在 role_spec 里是 `dict(base[...])` ——
 *      **浅拷贝**：两次 role_spec("planner") 拿到的 spec.result_schema 是不同对象，
 *      但它们的 "types" 子对象是同一个引用（改一处会污染预设）。
 *   8. 模块级 for 循环给每个预设补 "model_role"（插在字典**末尾**），
 *      但 role_spec 的返回体**不含** model_role —— 想拿档位必须走
 *      ROLE_MODEL_ROLE_DEFAULTS / resolve_subagent_model。
 *   9. role_spec 的 tools 取法是 `(overrides.get("tools") or base["tools"]) if overrides
 *      else base["tools"]`：overrides 存在但 tools 为空 → 回落 base 工具表；
 *      tools 给字符串 "ab" → `list("ab")` 变成 ["a","b"]。
 *      budget_tokens/deadline_s 是 `int(overrides.get(...) or 默认)`：0/"" 会落默认值。
 *      未知角色走那个**没有 model_role 键**的兜底预设（tools=[]，50_000，summary）。
 *  10. resolve_model_for_role 先查 `not config or role not in MODEL_ROLES`；
 *      config 是非 dict 的真值（如 [1]）时 subagent_cfg=None → 直接 None。
 *      `str(model) if model else None`：档位配 0/""/[] 都当"没配"。
 *  11. resolve_subagent_model 四级优先里，第 1、2 级都是**真值**判定
 *      （model_override="" 会让位给 persona_model），第 3 级未命中才 "inherit"；
 *      persona 不在 ROLE_MODEL_ROLE_DEFAULTS 时档位取 "subagent"，而
 *      resolve_model_for_role 允许 "subagent"（在 MODEL_ROLES 集合里）→ 可解析。
 *  12. check_result_contract 的 bool/int 陷阱（原码注释里写明的那个）：
 *      要求 int 而实得 True/False 时报 "expected int, got bool" 并 **continue**；
 *      bool 检查写在 isinstance 之前才有效。多余键不拦。
 *      `pytype.get(want, object)` 使未知 want 恒通过。
 *  13. get_persona_contract **返回模块级共享对象**（不拷贝）：
 *      两个调用方拿到同一个 dict（原码如此）。result_schema 命中优先于 persona_name，
 *      两者都不中才 _SUMMARY_CONTRACT。
 *  14. enforce_contracts 的账本密度：work_copy.changes() 在"空文本 + 有改动"这一条路上
 *      被调用 **4** 次（has_actual_changes、write 过滤、delete 过滤、_contract_note 的
 *      len），其余路径 1 次；`payload` 在 r["payload"] 本身是 dict 时是**同一个对象**，
 *      于是补字段会直接改写调用方交付里的 payload。
 *  15. enforce_contracts 只碰 r["ok"] 的**唯一**一处是 validator 业务结论
 *      `payload.get("passed") is False`（严格 False；0/""/None 不算）；
 *      契约格式失败只挂 warning 不改 ok（P0-1 的原意）。
 *  16. reviewer/validator 的关键字猜判里有 `"ok" in text.lower()` —— 子串匹配，
 *      "bookkeeper"、"token" 都会命中；中文判据（"通过"/"成功"/"失败"）用**原文**
 *      而非 lower()。
 *  17. 未知 persona（既不是 artifact 型也不是文本型）在无 summary 时得到
 *      `{"ok": True, "problems": [], "severity": "skip"}` —— 注意这个 contract
 *      没有 "warning" 键，与其他分支的键集**不同**（键序也不同）。
 *  18. 末段 persona_breakdown 对**全部** results 统计（包括开头被 `not r.get("ok")`
 *      跳过的），`r.get("contract", {})` 只补"键不存在"的情况：显式写 None 会
 *      AttributeError 冒出函数外（'NoneType' object has no attribute 'get'）。
 *  19. TeamBoard.add_task 返回的条目就是看板内部对象（同一个引用），
 *      改返回值等于改看板；view() 丢掉 "spec" 但补 role/tools 计数，
 *      键序 = 原条目键序（role 仍在原位）+ tools 追加末尾。
 *  20. can_run 用 `t["status"]`（硬索引）而 depends_on 用 `t.get(...)`：
 *      条目缺 status 键会 KeyError；依赖里引用不存在的任务 → False（不是"忽略"）。
 *  21. cascade_failures 在遍历中改状态并 **break**（一个失败前置只算一次），
 *      已 blocked 的任务不再进入（status != pending）。
 *  22. set_review 只认 delivered；合法 verdict 五个，未知值抛
 *      `unknown review verdict 'x'`（repr 带引号）；note 截断 [:300]。
 *  23. acquire_lease 的 SQL 语义就是全部逻辑：ON CONFLICT DO UPDATE 带
 *      `WHERE team_leases.owner=? OR team_leases.expires_at<?`，
 *      两个 ? 绑定 (owner, now)；rowcount>0 才算拿到。ttl_s 默认 900，
 *      acquired/expires 用 `int(time.time())`（整数秒）。release_lease 只有本人能删。
 *  24. DispatchPipeline.dispatch 的 child_session_id = "subagent-" + uuid4().hex[:8]，
 *      role_info 用 .get("role","coder")/.get("persona","coder")，
 *      task_spec 真值才加 "spec" 键（空 dict 不加）。
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, python type objects → tokens): ROLE_PRESETS /
 *     PERSONA_RESULT_SCHEMAS 的 `types: {"plan": list}` 用的是 python 类型对象，
 *     JS 没有对等物；端口用 PY_TYPE 令牌（"str"/"list"/"dict"/"bool"/"int"/"float"），
 *     对外文案仍渲染成 python 的 `<class 'list'>`。等价性：令牌只在
 *     check_result_contract 内部消费（`pytype.get`/`want is int`），
 *     渲染走 pyTypeStr；探针两侧的 schema 序列化都取 `<class 'x'>` 形态，
 *     因此任何"把 want 当字符串用"的漂移都会翻红。
 *   DIVERGENCE(port, int/float): JS 只有一个 number。pyTypeName 把非整数记 float、
 *     整数记 int，因此 `isinstance(1.0, float)` 在端口里是 False。可观察面：
 *     只有当某 schema 声明 float，或声明 int 而实得 python 侧的 1.0 时才有差别。
 *     本仓所有 schema（ROLE_PRESETS、PERSONA_RESULT_SCHEMAS、_SUMMARY_CONTRACT）
 *     只出现 str/list/bool/dict —— 无 float；int 只在 "passed"/"budget_tokens"
 *     这类非 schema 路径上出现。论证为"当前不可观察"，探针把 float/int 的实际
 *     行为钉住（float schema + 整数值 → 端口报 expected float, got int）。
 *   DIVERGENCE(port, number repr): pyNumStr 让整数值 float 渲染成 int 样式
 *     （python str(1.0)="1.0"）。可观察面是 `f"{line}"` 之类的插值：端口在
 *     TaskSpec/refs 的 line 上走 `int(...)`（真 int），dispatched_at 只进 span
 *     属性的 JSON（float 保持小数形态），因此不参与相等判断。
 *   DIVERGENCE(port, lazy import → seam): `from code_graph import get_code_graph`
 *     与 `from telemetry import …` 改为 TEAM_SEAMS.import_code_graph() /
 *     TEAM_SEAMS.telemetry()。等价性：两路都只在 try/except 里被调用，
 *     seam 抛错与被拦住的 ImportError 走同一条臂（前者 graph 保持 None → 降级占位；
 *     后者整个 span 构造被跳过）；假模块可用时两侧都拿得到同一个对象面。
 *   DIVERGENCE(port, sqlite): `_ensure_lease_table/acquire_lease/release_lease`
 *     仍然把 SQL 文本、参数绑定顺序、rowcount>0 判据原样搬过来；SQL 由调用方
 *     注入的 `storage._db("sessions")` 句柄执行（生产是同一个 sqlite3 连接对象，
 *     探针两侧各用**各自语言自带的真 SQLite 引擎**：python 的 sqlite3 与
 *     node:sqlite 的 DatabaseSync，内存库、不落文件）。等价性：端口这一侧
 *     没有任何 SQL 语义的自己实现，ON CONFLICT…WHERE 的取舍完全由 SQLite 决定，
 *     所以两端对拍是对 SQL 行为的对拍，不是对我写的模拟器的对拍。
 *   DIVERGENCE(port, dataclass repr/eq): TaskSpec 不实现 __eq__/__repr__。
 *     grep 证据：team.py 里没有任何位置对 TaskSpec 做 `==` 或放进 f-string
 *     （format_task_spec_contract 的 `str(ref)` 臂只在 ref **不是 dict** 时触发，
 *     而 TaskSpec 实例只会出现在 spec_contract 位）。因此不造 repr；
 *     探针按 vars() 顺序比字段。
 *   DIVERGENCE(port, keyword-only): 见 RULEBOOK §2/§4.5 那段；options 位上多余的
 *     位置实参按 CPython 文案抛错，测试杠杆名从 `team.X` 的 monkeypatch 改为
 *     `TEAM_SEAMS.X` 赋值（调用时解析，语义相同）。
 *
 *   NOTE: 决策全部代码化——契约通过/警告、reviewer/validator 的关键字判定、
 *     角色路由优先级、DAG 依赖放行与级联阻塞、租约归属，都是可读的纯函数/纯表，
 *     没有任何一处把裁决交给模型判断（架构红线 9）。
 */

import { randomUUID } from "node:crypto";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
class KeyErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "KeyError"; }
}
class IndexErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "IndexError"; }
}
class OverflowErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OverflowError"; }
}
class ImportErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ImportError"; }
}

type JsonDict = Record<string, unknown>;

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return v instanceof PyTuple ? "tuple" : "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate: a value that IS a python dict — plain or prototype-less. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (Buffer.isBuffer(v) || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

/** python `isinstance(x, dict)` — a class instance is NOT a dict. */
function pyIsDict(v: unknown): boolean {
    return isPyDict(v) || v instanceof Map;
}
function pyIsList(v: unknown): boolean {
    return Array.isArray(v) && !(v instanceof PyTuple);
}
/** python `isinstance(x, (list, tuple))`: both channels are JS arrays. */
function pyIsListOrTuple(v: unknown): boolean {
    return Array.isArray(v);
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.length > 0;
    // A class instance is a python OBJECT: bool() is True whatever its fields
    // are, so the empty-container rule applies only to dict-shaped values.
    if (isPyDict(v)) return Object.keys(v as JsonDict).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python float repr for `str()`: integral values render int-style. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

function pyReprStr(s: string): string {
    const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
    const esc = s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
    if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
    return '"' + esc.replaceAll('"', '\\"') + '"';
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") return pyReprStr(v);
    if (v instanceof PyTuple) {
        return "(" + Array.from(v).map(pyRepr).join(", ") +
            (v.length === 1 ? "," : "") + ")";
    }
    return pyStr(v);
}

/** python `str(x)` (containers render through repr). */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return pyRepr(v);
    if (v instanceof PyTuple) return pyRepr(v);
    if (Array.isArray(v)) return "[" + Array.from(v).map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    if (v instanceof Map) {
        return "{" + Array.from(v.entries()).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as JsonDict;
        const keys = Object.keys(o);
        if (keys.length === 0 && (v as { constructor?: { name?: string } }).constructor?.name
            && (v as { constructor?: { name?: string } }).constructor?.name !== "Object") {
            // python prints <module.Class object at 0x…> for instances without
            // __repr__; the address is unreproducible, so this is the
            // DIVERGENCE(port, dataclass repr) case documented in the header.
            return `<${(v as { constructor: { name: string } }).constructor.name} object>`;
        }
        return "{" + keys.map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

/** python's tuple is distinct from list for isinstance()/repr(), so the port
 *  keeps a marker class for the one channel that can carry one (see
 *  DIVERGENCE(port, tuple≡list) — it is NOT collapsed). */
export class PyTuple extends Array<unknown> { }

/** python `str.strip()` with no args: strips isspace() chars. */
const PY_SPACE_ONE =
    /[\x09\x0a\x0b\x0c\x0d\x1c\x1d\x1e\x1f\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
function pyStrip(s: string): string {
    let a = 0;
    let b = s.length;
    while (a < b && PY_SPACE_ONE.test(s[a] as string)) a++;
    while (b > a && PY_SPACE_ONE.test(s[b - 1] as string)) b--;
    return s.slice(a, b);
}

/** python `str.strip(chars)` — a CHARACTER SET, both ends. */
function pyStripChars(s: string, chars: string): string {
    if (chars.length === 0) return s;
    const set = new Set(Array.from(chars));
    let a = 0;
    let b = s.length;
    const arr = Array.from(s);
    while (a < b && set.has(arr[a] as string)) a++;
    while (b > a && set.has(arr[b - 1] as string)) b--;
    return arr.slice(a, b).join("");
}

/** python ASCII-only lowercasing (JS toLowerCase would fold non-ASCII). */
function pyLower(s: string): string {
    return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** python `str.splitlines()`. */
const PY_LINEBREAK = /\r\n|[\n\v\f\r\x1c\x1d\x1e\u0085\u2028\u2029]/;
function pySplitLines(s: string): string[] {
    return s.split(PY_LINEBREAK).filter((x, i, a) => !(x === "" && i === a.length - 1));
}

/** python iteration order for every iterable this module touches. */
function pyIter(v: unknown): unknown[] {
    if (typeof v === "string") return Array.from(v);
    if (Array.isArray(v)) return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (v instanceof Set) return Array.from(v);
    if (isPyDict(v)) return Object.keys(v as JsonDict);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `obj.get(key, default)` — raises AttributeError on non-dicts. */
function pyGet(obj: unknown, key: string, dflt?: unknown): unknown {
    if (obj instanceof Map) return obj.has(key) ? obj.get(key) : dflt;
    if (isPyDict(obj)) {
        const o = obj as JsonDict;
        return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : dflt;
    }
    if (typeof obj === "object" && obj !== null) {
        throw new AttributeErrorP(
            `'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    throw new AttributeErrorP(
        `'${pyTypeName(obj)}' object has no attribute 'get'`);
}

/** python `key in dict`. */
function pyIn(obj: unknown, key: string): boolean {
    if (obj instanceof Map) return obj.has(key);
    if (isPyDict(obj)) return Object.prototype.hasOwnProperty.call(obj, key);
    if (typeof obj === "string") return obj.includes(key);
    if (Array.isArray(obj)) return obj.some((x) => x === key);
    throw new TypeErrorP(`argument of type '${pyTypeName(obj)}' is not iterable`);
}

/** python `obj[key]` on a dict/list with CPython's KeyError/IndexError text. */
function pySub(obj: unknown, key: string | number): unknown {
    if (typeof key === "number" && Array.isArray(obj)) {
        if (key >= obj.length || key < -obj.length) {
            throw new IndexErrorP("list index out of range");
        }
        return obj[key < 0 ? obj.length + key : key];
    }
    if (obj instanceof Map) {
        if (!obj.has(key as string)) throw new KeyErrorP(pyReprStr(String(key)));
        return obj.get(key as string);
    }
    if (isPyDict(obj)) {
        const o = obj as JsonDict;
        const k = String(key);
        if (!Object.prototype.hasOwnProperty.call(o, k)) {
            throw new KeyErrorP(pyReprStr(k));
        }
        return o[k];
    }
    if (typeof obj === "string") return obj[Number(key)];
    if (Array.isArray(obj)) return (obj as unknown[])[Number(key)];
    throw new TypeErrorP(
        `'${pyTypeName(obj)}' object is not subscriptable`);
}

/** python `list(x)` — shallow copy of any iterable. */
function pyListCopy(v: unknown): unknown[] {
    if (v instanceof Map) return Array.from(v.keys());
    return pyIter(v).slice();
}

/** python `dict(x)` — mapping copy or sequence-of-pairs, CPython errors. */
function pyDictCopy(v: unknown): JsonDict {
    const out: JsonDict = {};
    if (v instanceof Map) {
        for (const [k, x] of v.entries()) out[String(k)] = x;
        return out;
    }
    if (isPyDict(v)) return { ...(v as JsonDict) };
    if (typeof v === "string" || Array.isArray(v)) {
        const items = typeof v === "string" ? Array.from(v) : v;
        items.forEach((it, i) => {
            let pair: unknown[];
            if (typeof it === "string") pair = Array.from(it);
            else if (Array.isArray(it)) pair = Array.from(it);
            else if (it instanceof Map) pair = Array.from(it.entries());
            else if (isPyDict(it)) pair = Object.keys(it as JsonDict);
            else throw new TypeErrorP(`'${pyTypeName(it)}' object is not iterable`);
            if (pair.length !== 2) {
                throw new ValueErrorP(
                    `dictionary update sequence element #${i} has length ${
                        pair.length}; 2 is required`);
            }
            out[String(pair[0])] = pair[1];
        });
        return out;
    }
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `int(x)` with CPython's three error texts. */
function pyInt(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") {
        if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
        if (!Number.isFinite(v)) {
            throw new OverflowErrorP("cannot convert float infinity to integer");
        }
        return Math.trunc(v);
    }
    if (typeof v === "string") {
        const t = pyStrip(v);
        const m = /^([+-]?)(0*)?((?:\d_?)*\d)?$/.exec(t);
        if (!m || !m[3]) {
            throw new ValueErrorP(`invalid literal for int() with base 10: ${pyReprStr(v)}`);
        }
        const digits = (m[3] as string).replaceAll("_", "");
        if (!/^\d+$/.test(digits) || /__/.test(t)) {
            throw new ValueErrorP(`invalid literal for int() with base 10: ${pyReprStr(v)}`);
        }
        const n = Number(digits);
        return m[1] === "-" ? -n : n;
    }
    throw new TypeErrorP(
        `int() argument must be a string, a bytes-like object or a real number, ` +
        `not '${pyTypeName(v)}'`);
}

/** CPython's round(x, nd): exact half-to-even on the binary value. */
function pyRound(v: number, nd: number): number {
    if (!Number.isFinite(v)) return v;
    const neg = v < 0;
    const a = Math.abs(v);
    const scale = BigInt(10) ** BigInt(nd);
    // exact rational a = M * 2^E (M integer, from the IEEE-754 bits)
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, a);
    const bits = buf.getBigUint64(0);
    const rawExp = Number((bits >> 52n) & 0x7ffn);
    const frac = bits & ((1n << 52n) - 1n);
    let m: bigint;
    let e: number;
    if (rawExp === 0) { m = frac; e = -1074; } else { m = frac | (1n << 52n); e = rawExp - 1075; }
    // T = a * scale = m * 10^nd * 2^e as num/den
    let num = m * scale;
    let den = 1n;
    if (e < 0) den = 1n << BigInt(-e);
    else num = num << BigInt(e);
    const q = num / den;
    const r = num % den;
    let rounded = q;
    const twice = r * 2n;
    if (twice > den || (twice === den && (q & 1n) === 1n)) rounded = q + 1n;
    const out = Number(rounded) / Number(scale);
    return neg ? -out : out;
}

/** python `max(a, b)` for the two ints this module uses it on. */
function pyMax(a: number, b: number): number {
    return a >= b ? a : b;
}

/** python's missing-argument TypeError. */
function pyMissing(fname: string, names: readonly string[]): TypeErrorP {
    const q = names.map((s) => `'${s}'`);
    const list = q.length === 1
        ? (q[0] as string)
        : q.length === 2
            ? `${q[0]} and ${q[1]}`
            : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
    const plural = names.length === 1 ? "positional argument" : "positional arguments";
    return new TypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

/** python's "takes <takes> positional argument(s) but N was/were given". */
function pyTooMany(fname: string, takes: string, given: number): TypeErrorP {
    const noun = takes === "1" ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes ${takes} ${noun} but ${given} ${verb} given`);
}

/** python's "takes from MIN to MAX positional arguments" wording. */
function pyTooManyRange(fname: string, min: number, max: number, given: number): TypeErrorP {
    const noun = max === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${min} to ${max} ${noun} but ${given} ${verb} given`);
}

/** `verdict, reason = critic_fn(f)` — CPython's unpack errors verbatim. */
function pyUnpack2(outcome: unknown): [unknown, unknown] {
    let items: unknown[];
    if (typeof outcome === "string") items = Array.from(outcome);
    else if (Array.isArray(outcome)) items = Array.from(outcome);
    else if (outcome instanceof Set || outcome instanceof Map) {
        items = Array.from(outcome as Iterable<unknown>);
    } else if (isPyDict(outcome)) items = Object.keys(outcome as JsonDict);
    else throw new TypeErrorP(`cannot unpack non-iterable ${pyTypeName(outcome)} object`);
    if (items.length < 2) {
        throw new ValueErrorP(`not enough values to unpack (expected 2, got ${items.length})`);
    }
    if (items.length > 2) {
        throw new ValueErrorP("too many values to unpack (expected 2)");
    }
    return [items[0] as unknown, items[1] as unknown];
}

/** python `hasattr(obj, name)` — attribute lookup, never dict keys. */
function pyHasAttr(obj: unknown, name: string): boolean {
    if (obj === null || obj === undefined) return false;
    if (isPyDict(obj)) return false;
    return (obj as Record<string, unknown>)[name] !== undefined;
}
function pyGetAttr(obj: unknown, name: string, dflt?: unknown): unknown {
    if (obj === null || obj === undefined) {
        if (dflt !== undefined) return dflt;
        throw new AttributeErrorP(
            `'${pyTypeName(obj)}' object has no attribute '${name}'`);
    }
    if (isPyDict(obj)) {
        if (dflt !== undefined) return dflt;
        throw new AttributeErrorP(
            `'${pyTypeName(obj)}' object has no attribute '${name}'`);
    }
    const v = (obj as Record<string, unknown>)[name];
    if (v === undefined) {
        if (dflt !== undefined) return dflt;
        throw new AttributeErrorP(
            `'${(obj as { constructor?: { name?: string } }).constructor?.name ?? pyTypeName(obj)}' ` +
            `object has no attribute '${name}'`);
    }
    return v;
}

/** json.dumps(v, ensure_ascii=True): CPython separators, key order, escaping. */
function pyJsonDumps(v: unknown, ensureAscii: boolean): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
        return jsonNum(v);
    }
    if (typeof v === "string") return pyJsonStr(v, ensureAscii);
    if (typeof v === "function" || v instanceof Error) {
        throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
    }
    if (Array.isArray(v)) return "[" + v.map((x) => pyJsonDumps(x, ensureAscii)).join(", ") + "]";
    if (isPyDict(v)) {
        const o = v as JsonDict;
        return "{" + Object.keys(o)
            .map((k) => pyJsonStr(k, ensureAscii) + ": " + pyJsonDumps(o[k], ensureAscii))
            .join(", ") + "}";
    }
    throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

/** python's json float formatting keeps ".0" for integral floats. */
function jsonNum(v: number): string {
    return String(v);
}

function pyJsonStr(s: string, ensureAscii: boolean): string {
    let out = '"';
    for (const ch of s) {
        const cp = ch.codePointAt(0) as number;
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else if (cp < 0x20 || cp === 0x7f) out += "\\u" + cp.toString(16).padStart(4, "0");
        else if (ensureAscii && cp > 0x7e) {
            if (cp > 0xffff) {
                const c = cp - 0x10000;
                const hi = 0xd800 + (c >> 10);
                const lo = 0xdc00 + (c & 0x3ff);
                out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
            } else {
                out += "\\u" + cp.toString(16).padStart(4, "0");
            }
        } else out += ch;
    }
    return out + '"';
}

// ── python 类型令牌（见 DIVERGENCE(port, python type objects → tokens)）─────

export type PyTypeToken = "str" | "list" | "dict" | "bool" | "int" | "float";

export const PY_TYPE = {
    str: "str" as PyTypeToken,
    list: "list" as PyTypeToken,
    dict: "dict" as PyTypeToken,
    bool: "bool" as PyTypeToken,
    int: "int" as PyTypeToken,
    float: "float" as PyTypeToken,
};

/** python `str(list)` → "<class 'list'>" — the text the problems array carries. */
function pyTypeStr(want: unknown): string {
    return `<class '${String(want)}'>`;
}

/** python `isinstance(value, token)` for the six tokens in pytype's table. */
function pyIsinstance(value: unknown, want: unknown): boolean {
    switch (want) {
        case PY_TYPE.str: return typeof value === "string";
        case PY_TYPE.list: return Array.isArray(value) && !(value instanceof PyTuple);
        case PY_TYPE.dict: return pyIsDict(value);
        case PY_TYPE.bool: return typeof value === "boolean";
        case PY_TYPE.int: return typeof value === "number" && Number.isInteger(value);
        case PY_TYPE.float: return typeof value === "number" && !Number.isInteger(value);
        default: return true;   // pytype.get(want, object) → isinstance(x, object)
    }
}

// ── 测试缝 ───────────────────────────────────────────────────────────────────

/** sqlite 句柄的最小面：python 侧就是 sqlite3.Connection。 */
export type TeamCursor = { rowcount: number };
export type TeamDbLike = {
    execute(sql: string, params?: readonly unknown[]): TeamCursor;
    commit(): void;
};
export type TeamStorageLike = { _db(name: string): TeamDbLike };

/** telemetry 模块面（telemetry.py 是 DELETE 单元，默认取不到）。 */
export type TelemetrySpanLike = {
    name: string;
    start_time: number;
    end_time: number;
    attributes: JsonDict;
    add_event(name: string, kwargs?: JsonDict): void;
};
export type TelemetryModule = {
    Span: (init: {
        name: string; start_time: number; end_time: number; attributes: JsonDict;
    }) => TelemetrySpanLike;
    SpanName: { CONTRACT_ENFORCE: { value: string }; SUBAGENT_QUARANTINE: { value: string } };
    flush_span: (span: TelemetrySpanLike) => void;
};

export const TEAM_SEAMS = {
    /** python `time.time()` — 浮点秒。 */
    now: (): number => Date.now() / 1000,
    /** python `uuid.uuid4().hex` — 32 位小写十六进制。 */
    uuid4_hex: (): string => randomUUID().replaceAll("-", ""),
    /** python `from code_graph import get_code_graph`（函数级 import）。 */
    import_code_graph: (): ((rootDir: string) => unknown) => {
        throw new ImportErrorP("No module named 'code_graph'");
    },
    /** python `from telemetry import …`（telemetry 是 DELETE 单元 → 抛错被吞）。 */
    telemetry: (): TelemetryModule => {
        throw new ImportErrorP("No module named 'telemetry'");
    },
};

// ── M-3: TaskSpec (Spec-Driven 派单合同) ───────────────────────────────────

export class TaskSpec {
    goal: string;
    in_scope: unknown[];
    out_of_scope: unknown[];
    acceptance: unknown[];
    context_refs: unknown[];
    metadata: JsonDict;

    constructor(opts?: {
        goal?: string;
        in_scope?: unknown;
        out_of_scope?: unknown;
        acceptance?: unknown;
        context_refs?: unknown;
        metadata?: unknown;
    }) {
        // python 的 @dataclass：default_factory 只在**没传**该参数时生效，
        // 传进来的列表/字典是**直接赋值**（不拷贝）——别名关系由探针钉住。
        const o = opts ?? {};
        this.goal = o.goal === undefined ? "" : o.goal;
        this.in_scope = o.in_scope === undefined ? [] : o.in_scope as unknown[];
        this.out_of_scope = o.out_of_scope === undefined ? [] : o.out_of_scope as unknown[];
        this.acceptance = o.acceptance === undefined ? [] : o.acceptance as unknown[];
        this.context_refs = o.context_refs === undefined ? [] : o.context_refs as unknown[];
        this.metadata = o.metadata === undefined ? {} : o.metadata as JsonDict;
    }

    to_dict(): JsonDict {
        if (arguments.length > 0) {
            throw pyTooMany("TaskSpec.to_dict", "1", arguments.length + 1);
        }
        return {
            "goal": this.goal,
            "in_scope": this.in_scope.slice(),
            "out_of_scope": this.out_of_scope.slice(),
            "acceptance": this.acceptance.slice(),
            "context_refs": this.context_refs.slice(),
            "metadata": { ...this.metadata },
        };
    }

    /** python `@classmethod from_dict(cls, data)`。 */
    static from_dict(data: unknown): TaskSpec {
        if (arguments.length > 1) {
            throw pyTooMany("TaskSpec.from_dict", "1", arguments.length);
        }
        const d = pyDictCopy(pyOr(data, {}));
        return new TaskSpec({
            goal: pyStr(pyOr(d["goal"], "")),
            in_scope: pyListCopy(pyOr(d["in_scope"], [])),
            out_of_scope: pyListCopy(pyOr(d["out_of_scope"], [])),
            acceptance: pyListCopy(pyOr(d["acceptance"], [])),
            context_refs: pyListCopy(pyOr(d["context_refs"], [])),
            metadata: pyDictCopy(pyOr(d["metadata"], {})),
        });
    }
}

/** 构造结构化派单合同字典。若 goal 为空抛出 ValueError。 */
export function build_task_spec(
    goal: unknown,
    in_scope?: unknown,
    out_of_scope?: unknown,
    acceptance?: unknown,
    context_refs?: unknown,
    metadata?: unknown,
): JsonDict {
    if (arguments.length > 6) {
        throw pyTooManyRange("build_task_spec", 1, 6, arguments.length);
    }
    if (!pyTruth(goal) || (typeof goal !== "string") || pyStrip(goal).length === 0) {
        throw new ValueErrorP("goal must be a non-empty string");
    }
    const spec = new TaskSpec({
        goal: pyStrip(goal as string),
        in_scope: pyListCopy(pyOr(in_scope, [])),
        out_of_scope: pyListCopy(pyOr(out_of_scope, [])),
        acceptance: pyListCopy(pyOr(acceptance, [])),
        context_refs: pyListCopy(pyOr(context_refs, [])),
        metadata: pyDictCopy(pyOr(metadata, {})),
    });
    return spec.to_dict();
}

/** 校验派单合同有效性与完备度，检测 spec_ambiguity（缺少 acceptance 等）。 */
export function validate_task_spec(spec_data: unknown): [boolean, unknown[]] {
    if (arguments.length > 1) throw pyTooMany("validate_task_spec", "1", arguments.length);
    const problems: unknown[] = [];
    const d = pyHasAttr(spec_data, "to_dict")
        ? (spec_data as { to_dict: () => JsonDict }).to_dict()
        : spec_data;
    if (!pyIsDict(d)) {
        return [false, [`task spec must be dict or TaskSpec, got ${pyTypeName(spec_data)}`]];
    }
    const dd = d as JsonDict;
    const goal = pyStrip(pyStr(pyOr(dd["goal"], "")));
    if (!pyTruth(goal)) problems.push("missing goal in spec");

    const acceptance = dd["acceptance"];
    if (!pyIsListOrTuple(acceptance) || (acceptance as unknown[]).length === 0) {
        problems.push("missing acceptance criteria in spec (spec_ambiguity)");
    }
    for (const fieldName of ["in_scope", "out_of_scope", "context_refs"]) {
        if (pyIn(dd, fieldName) && !pyIsListOrTuple(dd[fieldName])) {
            problems.push(`field '${fieldName}' must be a list`);
        }
    }
    return [problems.length === 0, problems];
}

/** Format a TaskSpec or dict into a structured markdown contract block. */
export function format_task_spec_contract(spec_data: unknown): string {
    if (arguments.length > 1) {
        throw pyTooMany("format_task_spec_contract", "1", arguments.length);
    }
    if (!pyTruth(spec_data)) return "";
    let d: JsonDict;
    if (pyHasAttr(spec_data, "to_dict")) {
        d = (spec_data as { to_dict: () => JsonDict }).to_dict();
    } else if (pyIsDict(spec_data)) {
        d = spec_data as JsonDict;
    } else {
        return "";
    }

    const lines: string[] = ["### 📋 派单合同 (Task Contract)"];
    const goal = pyStrip(pyStr(pyOr(d["goal"], "")));
    if (pyTruth(goal)) lines.push(`- **Goal / 目标**: ${goal}`);

    const inScope = d["in_scope"];
    if (pyTruth(inScope) && pyIsListOrTuple(inScope)) {
        const cleanIn = (inScope as unknown[]).map(pyStr).filter((x) => pyTruth(pyStrip(x)));
        if (cleanIn.length) lines.push(`- **In Scope / 范围约束**: ${cleanIn.join(", ")}`);
    }

    const outOfScope = d["out_of_scope"];
    if (pyTruth(outOfScope) && pyIsListOrTuple(outOfScope)) {
        const cleanOut = (outOfScope as unknown[]).map(pyStr).filter((x) => pyTruth(pyStrip(x)));
        if (cleanOut.length) lines.push(`- **Out of Scope / 严禁越界**: ${cleanOut.join(", ")}`);
    }

    const acceptance = d["acceptance"];
    if (pyTruth(acceptance) && pyIsListOrTuple(acceptance)) {
        const cleanAcc = (acceptance as unknown[]).map(pyStr).filter((x) => pyTruth(pyStrip(x)));
        if (cleanAcc.length) {
            lines.push("- **Acceptance Criteria / 验收断言**:");
            for (const item of cleanAcc) lines.push(`  - [ ] ${item}`);
        }
    }

    const contextRefs = d["context_refs"];
    if (pyTruth(contextRefs) && pyIsListOrTuple(contextRefs)) {
        const cleanRefs = (contextRefs as unknown[]).filter(pyTruth);
        if (cleanRefs.length) {
            lines.push("- **Context References / 关键符号与上下文**:");
            for (const ref of cleanRefs) {
                if (pyIsDict(ref)) {
                    const r = ref as JsonDict;
                    const sym = r["symbol"] === undefined ? "" : r["symbol"];
                    const path = r["path"] === undefined ? "" : r["path"];
                    const line = r["line"] === undefined ? 0 : r["line"];
                    const kind = r["kind"] === undefined ? "" : r["kind"];
                    const doc = r["doc"] === undefined ? "" : r["doc"];
                    const loc = (pyTruth(path) && pyTruth(line))
                        ? `${pyStr(path)}:${pyStr(line)}`
                        : pyStr(pyOr(path, ""));
                    const parts: string[] = pyTruth(sym) ? [`\`${pyStr(sym)}\``] : [];
                    if (pyTruth(loc)) parts.push(`(${loc})`);
                    if (pyTruth(kind) && kind !== "symbol" && kind !== "reference") {
                        parts.push(`[${pyStr(kind)}]`);
                    }
                    if (pyTruth(doc)) parts.push(`- ${pyStr(doc)}`);
                    lines.push(`  - ${parts.length ? parts.join(" ") : pyStr(ref)}`);
                } else {
                    lines.push(`  - ${pyStr(ref)}`);
                }
            }
        }
    }

    return lines.join("\n");
}

/** 使用 CKG / 代码符号索引预取关键符号定义与上下文，注入派单合同。 */
export function prefetch_context_refs(
    symbols: unknown,
    root_dir?: unknown,
    graph?: unknown,
): JsonDict[] {
    if (arguments.length > 3) {
        throw pyTooManyRange("prefetch_context_refs", 1, 3, arguments.length);
    }
    if (!pyTruth(symbols)) return [];

    let g: unknown = graph === undefined ? null : graph;
    const refs: JsonDict[] = [];
    try {
        if (g === null) {
            try {
                const getCodeGraph = TEAM_SEAMS.import_code_graph();
                g = pyTruth(root_dir) ? getCodeGraph(pyStr(root_dir)) : null;
            } catch {
                /* pass */
            }
        }

        if (g !== null && g !== undefined && pyHasAttr(g, "find_symbol")) {
            for (const sym of pyIter(symbols)) {
                const res = (g as { find_symbol(s: unknown): unknown }).find_symbol(sym);
                if (pyTruth(res)) {
                    const r = res as JsonDict;
                    refs.push({
                        "symbol": sym,
                        "path": pyStr(pyOr(pyOr(r["file"], r["path"]), "")),
                        "line": pyInt(pyOr(r["line"], 0)),
                        "kind": pyStr(pyOr(r["kind"], "symbol")),
                        "doc": pyStr(pyOr(r["doc"], "")).slice(0, 200),
                    });
                }
            }
        }
    } catch {
        /* pass */
    }

    if (!pyTruth(refs)) {
        // 降级占位回退，保证派单合同格式统一（注意：原码这里不写 "doc" 键）
        for (const sym of pyIter(symbols)) {
            refs.push({ "symbol": sym, "path": "", "line": 0, "kind": "reference" });
        }
    }
    return refs;
}

// ── M-1 & M-2: Reviewer-Critic 结构化分歧裁决与四视角模板 ─────────────────

export const REVIEW_PERSPECTIVE_TEMPLATES: JsonDict = {
    "security": {
        "name": "Security Audit",
        "focus": "Vulnerabilities, injection risks, credential leakage, path traversal, untrusted input handling",
        "tools": ["read_text", "search_code", "diff_files"],
    },
    "perf": {
        "name": "Performance Analysis",
        "focus": "Algorithmic complexity, quadratic loops, redundant I/O, regex recompilation, memory bloat",
        "tools": ["read_text", "search_code", "diff_files"],
    },
    "maintainability": {
        "name": "Maintainability Review",
        "focus": "Modularity, naming clarity, cyclomatic complexity, code duplication, adherence to conventions",
        "tools": ["read_text", "search_code", "diff_files"],
    },
    "test-coverage": {
        "name": "Test & Reliability Verification",
        "focus": "Missing unit tests, untested edge cases, assertion validity, regression prevention, swallowed exceptions",
        "tools": ["read_text", "search_code", "diff_files"],
    },
};

export class ReviewVerdict {
    static readonly CONFIRMED = "confirmed";
    static readonly REJECTED = "rejected";
    static readonly ESCALATED = "escalated";
}

/** Reviewer-Critic 结构化分歧裁决器：confirmed / rejected / escalated 三态。 */
export function adjudicate_review_findings(
    findings: unknown,
    critic_fn?: unknown,
): Record<string, unknown[]> {
    if (arguments.length > 2) {
        throw pyTooManyRange("adjudicate_review_findings", 1, 2, arguments.length);
    }
    const groups: Record<string, unknown[]> = {
        [ReviewVerdict.CONFIRMED]: [],
        [ReviewVerdict.REJECTED]: [],
        [ReviewVerdict.ESCALATED]: [],
    };

    const critic = critic_fn === undefined ? null : critic_fn;

    for (const f of pyIter(findings)) {
        if (critic !== null) {
            try {
                const out = pyUnpack2((critic as (x: unknown) => unknown)(f));
                const verdict = out[0];
                const reason = out[1];
                if (pyHasAttr(f, "verdict")) {
                    (f as Record<string, unknown>)["verdict"] = verdict;
                    (f as Record<string, unknown>)["verdict_reason"] = reason;
                } else if (pyIsDict(f)) {
                    (f as JsonDict)["verdict"] = verdict;
                    (f as JsonDict)["verdict_reason"] = reason;
                }
            } catch (e) {
                const verdict = ReviewVerdict.ESCALATED;
                const msg = e instanceof Error ? e.message : pyStr(e);
                if (pyHasAttr(f, "verdict")) {
                    (f as Record<string, unknown>)["verdict"] = verdict;
                    (f as Record<string, unknown>)["verdict_reason"] =
                        `Critic verification error: ${msg}`;
                } else if (pyIsDict(f)) {
                    (f as JsonDict)["verdict"] = verdict;
                    (f as JsonDict)["verdict_reason"] =
                        `Critic verification error: ${msg}`;
                }
            }
        }

        const raw = pyHasAttr(f, "verdict")
            ? pyGetAttr(f, "verdict", null)
            : (pyIsDict(f) ? pyGet(f, "verdict", null) : null);
        const vClean = pyLower(pyStr(pyOr(raw, "")));
        if (Object.prototype.hasOwnProperty.call(groups, vClean)) {
            (groups[vClean] as unknown[]).push(f);
        } else {
            (groups[ReviewVerdict.CONFIRMED] as unknown[]).push(f);
        }
    }

    return groups;
}

// ── RoleSpec 预设（§13 推荐角色）────────────────────────────────────────────
// 工具名称必须与 ToolRegistry 注册的 canonical 真实名称严格一致：
// read_text, search_code, find_files, list_dir, diff_files, get_file_info,
// write_file, edit_file, delete_file, move_file, copy_file,
// git_status, git_diff, git_log, git_add, git_commit,
// shell_executor, python_executor, web_search, web_fetch, etc.

export const ROLE_PRESETS: Record<string, JsonDict> = {
    "planner": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir", "get_file_info",
            "goal_plan_create", "goal_plan_update",
        ],
        "budget_tokens": 60_000,
        "result_schema": { "required": ["plan"], "types": { "plan": PY_TYPE.list } },
    },
    "researcher": {
        "tools": [
            "web_search", "web_fetch", "academic_search", "read_text",
            "search_code", "find_files", "list_dir", "get_file_info",
        ],
        "budget_tokens": 120_000,
        "result_schema": { "required": ["findings"], "types": { "findings": PY_TYPE.list } },
    },
    "coder": {
        "tools": [
            "read_file", "read_text", "write_file", "edit_file", "delete_file", "move_file", "copy_file",
            "git_status", "git_diff", "git_log", "git_add", "git_commit",
            "shell_executor", "python_executor",
        ],
        "budget_tokens": 200_000,
        "result_schema": {
            "required": ["patch_summary"],
            "types": { "patch_summary": PY_TYPE.str },
        },
    },
    "reviewer": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir",
            "get_file_info", "diff_files", "git_status", "git_diff", "git_log",
        ],
        "budget_tokens": 80_000,
        "result_schema": {
            "required": ["verdict", "issues"],
            "types": { "verdict": PY_TYPE.str, "issues": PY_TYPE.list },
        },
    },
    "validator": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir",
            "get_file_info", "diff_files", "git_status", "git_diff",
            "shell_executor", "python_executor",
        ],
        "budget_tokens": 80_000,
        "result_schema": {
            "required": ["passed", "evidence"],
            "types": { "passed": PY_TYPE.bool },
        },
    },
    "memory_curator": {
        "tools": ["read_text", "list_dir", "memory_query", "memory_store"],
        "budget_tokens": 40_000,
        "result_schema": {
            "required": ["proposals"],
            "types": { "proposals": PY_TYPE.list },
        },
    },
    "explore": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir", "get_file_info", "diff_files",
            "git_status", "git_diff", "git_log",
        ],
        "budget_tokens": 60_000,
        "result_schema": { "required": ["findings"], "types": { "findings": PY_TYPE.list } },
    },
    "diagnostician": {
        "tools": [
            "read_text", "search_code", "find_files", "list_dir", "get_file_info",
            "git_status", "git_diff", "git_log", "diagnose",
        ],
        "budget_tokens": 50_000,
        "result_schema": {
            "required": ["observations"],
            "types": { "observations": PY_TYPE.list },
        },
    },
};

// ── F3: ModelRole 分模型路由 ─────────────────────────────────

/** 角色档位 */
export const MODEL_ROLES: Set<string> = new Set(["main", "compact", "lite", "review", "subagent"]);

/** persona → 默认档位映射（重推理用 main，轻任务用 lite/review） */
export const ROLE_MODEL_ROLE_DEFAULTS: Record<string, string> = {
    "planner": "main",
    "coder": "main",
    "researcher": "lite",
    "explore": "lite",
    "reviewer": "review",
    "validator": "review",
    "verifier": "review",
    "diagnostician": "lite",
    "memory_curator": "lite",
};

// 将 ROLE_PRESETS 里每个 persona 补上 model_role 键（单一来源）
for (const [presetName, preset] of Object.entries(ROLE_PRESETS)) {
    if (!Object.prototype.hasOwnProperty.call(preset, "model_role")) {
        preset["model_role"] = ROLE_MODEL_ROLE_DEFAULTS[presetName] ?? "subagent";
    }
}

/** F3: 档位 → 实际模型解析；未配置返回 null（继承父）。 */
export function resolve_model_for_role(role: string, config?: unknown): string | null {
    if (arguments.length > 2) {
        throw pyTooManyRange("resolve_model_for_role", 1, 2, arguments.length);
    }
    if (!pyTruth(config) || !MODEL_ROLES.has(role)) return null;
    const subagentCfg = pyIsDict(config) ? pyGet(config, "subagent") : null;
    if (!pyIsDict(subagentCfg)) return null;
    const rolesCfg = pyIsDict(pyGet(subagentCfg, "model_roles"))
        ? (pyGet(subagentCfg, "model_roles") as JsonDict)
        : {};
    const model = rolesCfg[role];
    return pyTruth(model) ? pyStr(model) : null;
}

/**
 * F3: 解析子代理最终使用的模型。优先级 model_override > persona_model >
 * ROLE_MODEL_ROLE_DEFAULTS[persona]→config 档位 > 继承父模型。
 */
export function resolve_subagent_model(
    persona: string,
    model_override?: unknown,
    persona_model?: unknown,
    config?: unknown,
): [string | null, string] {
    if (arguments.length > 4) {
        throw pyTooManyRange("resolve_subagent_model", 1, 4, arguments.length);
    }
    // 1. 显式 override 永远赢
    if (pyTruth(model_override)) return [model_override as string, "explicit"];
    // 2. persona 级显式 model
    if (pyTruth(persona_model)) return [persona_model as string, "explicit"];
    // 3. 按角色档位自动路由
    const role = ROLE_MODEL_ROLE_DEFAULTS[persona] ?? "subagent";
    const resolved = resolve_model_for_role(role, config);
    if (pyTruth(resolved)) return [resolved, role];
    // 4. 继承父模型
    return [null, "inherit"];
}

// ── ResultContract ──────────────────────────────────────────────────────────

/** 交付物契约检查：required 键在、类型对。多余键不拦——前向兼容。 */
export function check_result_contract(
    payload: unknown,
    schema: unknown,
): [boolean, unknown[]] {
    if (arguments.length > 2) throw pyTooMany("check_result_contract", "2", arguments.length);
    const problems: unknown[] = [];
    if (!pyIsDict(payload)) {
        return [false, [`payload must be a dict, got ${pyTypeName(payload)}`]];
    }
    const p = payload as JsonDict;
    const s = schema as JsonDict;
    for (const key of pyListCopy(pyOr(s["required"], []))) {
        if (!pyIn(p, String(key))) problems.push(`missing key: ${String(key)}`);
    }
    const types = pyOr(s["types"], {}) as unknown;
    // python: `for key, want in types.items()` — a non-dict `types` raises
    // AttributeError from .items() (bug-for-bug: we raise the same).
    if (!pyIsDict(types)) {
        throw new AttributeErrorP(
            `'${pyTypeName(types)}' object has no attribute 'items'`);
    }
    for (const key of Object.keys(types as Record<string, unknown>)) {
        const want = (types as Record<string, unknown>)[key];
        if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
        const value = p[key];
        // bool 是 int 的子类，所以 `isinstance(True, int)` 为真——要求 int 时
        // 必须先把 bool 挑出来，否则 JSON 里的 `true` 会冒充 1 通过校验。
        // （原码注释：这行以前写在 isinstance 的 else 分支里，从未执行过。）
        if (want === PY_TYPE.int && typeof value === "boolean") {
            problems.push(`key ${key}: expected int, got bool`);
            continue;
        }
        if (!pyIsinstance(value, want)) {
            problems.push(
                `key ${key}: expected ${pyTypeStr(want)}, got ${pyTypeName(value)}`);
        }
    }
    return [problems.length === 0, problems];
}

export const _SUMMARY_CONTRACT: JsonDict = {
    "required": ["summary"], "types": { "summary": PY_TYPE.str },
};

export const PERSONA_RESULT_SCHEMAS: Record<string, JsonDict> = {
    "ResultContract.v1": { "required": ["summary"], "types": { "summary": PY_TYPE.str } },
    "explore": { "required": ["findings"], "types": { "findings": PY_TYPE.list } },
    "researcher": { "required": ["findings"], "types": { "findings": PY_TYPE.list } },
    "reviewer": {
        "required": ["verdict", "issues"],
        "types": { "verdict": PY_TYPE.str, "issues": PY_TYPE.list },
    },
    "planner": { "required": ["plan"], "types": { "plan": PY_TYPE.list } },
    "coder": { "required": ["patch_summary"], "types": { "patch_summary": PY_TYPE.str } },
    "validator": { "required": ["passed"], "types": { "passed": PY_TYPE.bool } },
    "diagnostician": {
        "required": ["observations"],
        "types": { "observations": PY_TYPE.list },
    },
};

/** Get the ResultContract schema for a persona.（原码返回**共享引用**） */
export function get_persona_contract(
    persona_name: string,
    result_schema?: string | null,
): JsonDict {
    if (arguments.length > 2) {
        throw pyTooManyRange("get_persona_contract", 1, 2, arguments.length);
    }
    if (pyTruth(result_schema) &&
        Object.prototype.hasOwnProperty.call(PERSONA_RESULT_SCHEMAS, result_schema as string)) {
        return PERSONA_RESULT_SCHEMAS[result_schema as string] as JsonDict;
    }
    if (Object.prototype.hasOwnProperty.call(PERSONA_RESULT_SCHEMAS, persona_name)) {
        return PERSONA_RESULT_SCHEMAS[persona_name] as JsonDict;
    }
    return _SUMMARY_CONTRACT;
}

// ── RoleSpec 取用 ───────────────────────────────────────────────────────────

/** python `len(x)` for the containers this module measures. */
function pyLen(v: unknown): number {
    if (typeof v === "string") return Array.from(v).length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Map || v instanceof Set) return v.size;
    if (isPyDict(v)) return Object.keys(v as JsonDict).length;
    throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `x.lower()` on a value whose type is only known at runtime. */
function pyLowerAttr(v: unknown): string {
    if (typeof v !== "string") {
        throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'lower'`);
    }
    return pyLower(v);
}

/** 取角色预设。未知角色返回受限的通用白名单——宁缺勿滥。 */
export function role_spec(role: string, opts?: { overrides?: unknown }): JsonDict {
    if (arguments.length > 2) {
        throw pyTooMany("role_spec", "1", arguments.length + 1);
    }
    const overrides = opts === undefined ? undefined : opts.overrides;
    const known: JsonDict = Object.prototype.hasOwnProperty.call(ROLE_PRESETS, role)
        ? (ROLE_PRESETS[role] as JsonDict)
        : {
            "tools": [] as unknown[],
            "budget_tokens": 50_000,
            // 兜底预设每次调用都是**新对象**（python 的字面量），与预设的共享引用不同
            "result_schema": {
                "required": ["summary"], "types": { "summary": PY_TYPE.str },
            } as JsonDict,
        };
    const ov = pyTruth(overrides) ? (overrides as JsonDict) : null;
    const toolsSrc = ov !== null ? pyOr(pyGet(ov, "tools"), known["tools"]) : known["tools"];
    const spec: JsonDict = {
        "role": role,
        "tools": pyListCopy(toolsSrc),
        "budget_tokens": pyInt(pyOr(
            pyGet(pyOr(overrides, {}), "budget_tokens"),
            known["budget_tokens"])),
        "result_schema": pyDictCopy(known["result_schema"]),
        "deadline_s": pyInt(pyOr(pyGet(pyOr(overrides, {}), "deadline_s"), 600)),
    };
    return spec;
}

// ── 遥测（telemetry.py 是 DELETE 单元：默认 seam 抛 ImportError，被吞）─────

/** Emit a telemetry span for contract enforcement observability. */
export function _emit_contract_telemetry(
    warnings: number,
    total: number,
    persona_breakdown: unknown,
): void {
    if (arguments.length > 3) {
        throw pyTooMany("_emit_contract_telemetry", "3", arguments.length);
    }
    try {
        const tel = TEAM_SEAMS.telemetry();
        const span = tel.Span({
            "name": tel.SpanName.CONTRACT_ENFORCE.value,
            "start_time": TEAM_SEAMS.now(),
            "end_time": TEAM_SEAMS.now(),
            "attributes": {
                "contract.total": total,
                "contract.warnings": warnings,
                "contract.warning_rate": pyRound(warnings / pyMax(total, 1), 3),
                "contract.persona_breakdown": pyJsonDumps(persona_breakdown, true),
            },
        });
        if (warnings > 0) span.add_event("contract_warning", { "count": warnings });
        tel.flush_span(span);
    } catch {
        /* 遥测失败绝不影响主流程 */
    }
}

/** Emit a telemetry span for sub-agent overlay quarantine. */
export function _emit_quarantine_telemetry(
    sub_id: string,
    reason: string,
    path: string | null,
    changes_count: number,
): void {
    if (arguments.length > 4) {
        throw pyTooMany("_emit_quarantine_telemetry", "4", arguments.length);
    }
    try {
        const tel = TEAM_SEAMS.telemetry();
        const span = tel.Span({
            "name": tel.SpanName.SUBAGENT_QUARANTINE.value,
            "start_time": TEAM_SEAMS.now(),
            "end_time": TEAM_SEAMS.now(),
            "attributes": {
                "quarantine.sub_id": sub_id,
                "quarantine.reason": reason,
                "quarantine.changes_count": changes_count,
                "quarantine.saved": path !== null && path !== undefined,
            },
        });
        tel.flush_span(span);
    } catch {
        /* pass */
    }
}

// ── enforce_contracts ───────────────────────────────────────────────────────

/** `wc.changes()` —— 只在 wc 是对象（非 dict）时可调，与原码一致。 */
function pyChanges(wc: unknown): unknown[] {
    if (!pyHasAttr(wc, "changes")) {
        throw new AttributeErrorP(
            `'${pyTypeName(wc)}' object has no attribute 'changes'`);
    }
    return (wc as { changes: () => unknown[] }).changes();
}

const ISSUE_KEYWORDS = ["issue", "error", "warn", "fix", "问题", "缺陷"];

/** 对一批子代理交付做契约验收（§13 的验收边界）。返回契约警告数量。 */
export function enforce_contracts(results: unknown, work_copies?: unknown): number {
    if (arguments.length > 2) {
        throw pyTooManyRange("enforce_contracts", 1, 2, arguments.length);
    }
    let warnings = 0;
    const wcs = pyOr(work_copies, {});

    for (const item of pyIter(results)) {
        if (!pyIsDict(item)) continue;
        const r = item as JsonDict;
        if (!pyTruth(pyGet(r, "ok"))) continue;
        const text = pyStrip(pyStr(pyOr(pyGet(r, "text"), "")));
        const pType = pyStr(pyOr(pyGet(r, "type"), ""));
        const schema = get_persona_contract(pType);
        const rawPayload = pyGet(r, "payload");
        const payload: JsonDict = pyIsDict(rawPayload) ? (rawPayload as JsonDict) : {};

        // ── 智能适配：从 text 推导结构化字段 ──────────────────────────────
        if (!pyIn(payload, "summary") && pyTruth(text)) payload["summary"] = text;
        if (pType === "explore" || pType === "researcher") {
            if (!pyIn(payload, "findings")) {
                // python: `if l.strip()` — 纯空白行也被滤掉（不是 pyTruth(l)）
                const lines = pySplitLines(text).filter((l) => pyTruth(pyStrip(l)))
                    .map((l) => pyStripChars(l, "- *• "));
                payload["findings"] = lines.length ? lines : [text];
            }
        } else if (pType === "planner") {
            if (!pyIn(payload, "plan")) {
                const lines = pySplitLines(text).filter((l) => pyTruth(pyStrip(l)))
                    .map((l) => pyStripChars(l, "- *0123456789.• "));
                payload["plan"] = lines.length ? lines : [text];
            }
        } else if (pType === "reviewer") {
            if (!pyIn(payload, "verdict")) {
                const low = pyLower(text);
                payload["verdict"] =
                    ((low.includes("pass") || low.includes("ok") || text.includes("通过"))
                        && !low.includes("fail"))
                        ? "approved" : "changes_requested";
            }
            if (!pyIn(payload, "issues")) {
                payload["issues"] = pySplitLines(text)
                    .filter((l) => ISSUE_KEYWORDS.some((k) => pyLower(l).includes(k)))
                    .map((l) => pyStripChars(l, "- *• "));
            }
        } else if (pType === "coder") {
            if (!pyIn(payload, "patch_summary")) payload["patch_summary"] = text;
        } else if (pType === "validator" || pType === "verifier") {
            if (!pyIn(payload, "passed")) {
                const low = pyLower(text);
                payload["passed"] =
                    (low.includes("pass") || low.includes("ok")
                        || text.includes("通过") || text.includes("成功"))
                    && !low.includes("fail") && !text.includes("失败");
            }
            if (!pyIn(payload, "evidence")) payload["evidence"] = [text];
        } else if (pType === "diagnostician") {
            if (!pyIn(payload, "observations")) {
                const lines = pySplitLines(text).filter((l) => pyTruth(pyStrip(l)))
                    .map((l) => pyStripChars(l, "- *• "));
                payload["observations"] = lines.length ? lines : [text];
            }
        }

        // ── validator 业务验证未通过 → 仍应失败（唯一改写 r["ok"] 的地方）──
        if ((pType === "validator" || pType === "verifier")
            && pyGet(payload, "passed") === false) {
            r["ok"] = false;
            r["error"] = `validator check failed: ${
                pyTruth(text) ? text : "verification returned passed=False"}`;
            r["contract"] = {
                "ok": false,
                "warning": false,
                "problems": ["validator returned passed=False (business conclusion)"],
                "severity": "error",
            };
            warnings += 1;
            r["payload"] = payload;
            continue;
        }

        // ── P0-2: 空文本 + overlay 有实际改动 → 从 diff 派生摘要 ──────────
        const subId = pyGet(r, "subagent_id", "");
        const wc = pyTruth(subId) ? pyGet(wcs, String(subId)) : null;
        const hasActualChanges = wc !== null && wc !== undefined
            && pyTruth(pyLen(pyChanges(wc)));

        if (!pyTruth(text) && hasActualChanges) {
            // bug-for-bug: python re-evaluates wc.changes() at every use site —
            // this path calls changes() exactly 4× total (1490 + here ×2 + note).
            const changedPaths = pyChanges(wc)
                .filter((c) => pySub(c, "kind") === "write")
                .map((c) => pySub(c, "rel"));
            const deletedPaths = pyChanges(wc)
                .filter((c) => pySub(c, "kind") === "delete")
                .map((c) => pySub(c, "rel"));
            const parts: string[] = [];
            if (changedPaths.length) {
                parts.push("modified " + changedPaths.slice(0, 5).join(", "));
            }
            if (deletedPaths.length) {
                parts.push("deleted " + deletedPaths.slice(0, 5).join(", "));
            }
            const derivedSummary = parts.join("; ");
            payload["patch_summary"] = derivedSummary;
            if (!pyIn(payload, "summary")) payload["summary"] = derivedSummary;
            r["_contract_note"] = `auto-derived summary from ${
                pyLen(pyChanges(wc))} file changes`;
        }

        // ── P0-4: gate 语义修正 — 无 summary 时按 persona 分型处理 ────────
        if (!pyTruth(pyGet(payload, "summary"))
            && !pyTruth(pyGet(payload, "patch_summary"))) {
            if (pType === "coder" || pType === "validator" || pType === "verifier") {
                if (hasActualChanges) {
                    /* 有实际改动但无摘要 → 已通过 P0-2 补上，继续校验 */
                } else {
                    // 无改动无摘要 → 真·空交付，挂警告但不改写 ok
                    r["contract"] = {
                        "ok": false,
                        "warning": true,
                        "problems": ["empty delivery: no text and no file changes"],
                        "severity": "warn",
                    };
                    warnings += 1;
                    r["payload"] = payload;
                    continue;
                }
            } else if (pType === "researcher" || pType === "explorer" || pType === "planner"
                || pType === "reviewer" || pType === "diagnostician") {
                r["contract"] = {
                    "ok": false,
                    "warning": true,
                    "problems": [`empty delivery: ${pType} produced no text summary`],
                    "severity": "warn",
                };
                warnings += 1;
                r["payload"] = payload;
                continue;
            } else {
                // 未知 persona → 跳过格式校验（注意：这个 contract 没有 "warning" 键）
                r["contract"] = { "ok": true, "problems": [], "severity": "skip" };
                r["payload"] = payload;
                continue;
            }
        }

        // ── 契约格式校验（只挂警告，不碰 r["ok"]）────────────────────────
        const outcome = check_result_contract(payload, schema);
        if (!outcome[0]) {
            const problems = outcome[1] as unknown[];
            r["contract"] = {
                "ok": false,
                "warning": true,
                "problems": problems,
                "severity": "warn",
            };
            warnings += 1;
            // P0-1 核心修复：契约失败不改写 ok，只附警告
            r["_contract_warning"] = "contract format mismatch: "
                + pyJoin(pyListCopy(problems), "; ")
                + " — work preserved, please improve report format next time";
        } else {
            r["contract"] = { "ok": true, "problems": [], "severity": "ok" };
        }

        r["payload"] = payload;
    }

    // ── 可观测性：契约执行指标（对**全部** results 统计）─────────────────
    const personaBreakdown: JsonDict = {};
    for (const item of pyIter(results)) {
        if (!pyIsDict(item)) continue;
        const r = item as JsonDict;
        const pt = pyStr(pyOr(pyGet(r, "type"), "unknown"));
        if (!pyIn(personaBreakdown, pt)) {
            personaBreakdown[pt] = { "total": 0, "warnings": 0 };
        }
        const bucket = (personaBreakdown[pt] as JsonDict);
        bucket["total"] = (bucket["total"] as number) + 1;
        const c = pyGet(r, "contract", {});
        if (!pyTruth(pyGet(c, "ok", true))) {
            bucket["warnings"] = (bucket["warnings"] as number) + 1;
        }
    }

    const dictCount = pyIter(results).filter((x) => pyIsDict(x)).length;
    _emit_contract_telemetry(warnings, dictCount, personaBreakdown);

    return warnings;
}

/** python `"; ".join(seq)`（也是 "; " 之外唯一用到的分隔符组合）。 */
function pyJoin(seq: readonly unknown[], sep: string): string {
    return seq.map(pyStr).join(sep);
}

// ── TaskLease ───────────────────────────────────────────────────────────────

export const _LEASE_DDL = `
CREATE TABLE IF NOT EXISTS team_leases (
    task_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
)
`;

function pyDb(storage: unknown, name: string): TeamDbLike {
    if (!pyHasAttr(storage, "_db")) {
        throw new AttributeErrorP(
            `'${pyTypeName(storage)}' object has no attribute '_db'`);
    }
    return (storage as TeamStorageLike)._db(name);
}

export function _ensure_lease_table(storage: unknown): void {
    if (arguments.length > 1) {
        throw pyTooMany("_ensure_lease_table", "1", arguments.length);
    }
    const c = pyDb(storage, "sessions");
    c.execute(_LEASE_DDL);
    c.commit();
}

/** 原子抢占租约。已有人持有效租约 → false；过期/无主 → 接管。 */
export function acquire_lease(
    storage: unknown,
    task_id: string,
    owner: string,
    opts?: { ttl_s?: number },
): boolean {
    if (arguments.length > 4) {
        throw pyTooMany("acquire_lease", "3", arguments.length);
    }
    const ttlS = pyInt(opts === undefined || opts.ttl_s === undefined
        ? 900 : opts.ttl_s);
    _ensure_lease_table(storage);
    const now = Math.trunc(TEAM_SEAMS.now());
    const c = pyDb(storage, "sessions");
    const cur = c.execute(
        "INSERT INTO team_leases (task_id, owner, acquired_at, expires_at)"
        + " VALUES (?,?,?,?)"
        + " ON CONFLICT(task_id) DO UPDATE SET"
        + "   owner=excluded.owner, acquired_at=excluded.acquired_at,"
        + "   expires_at=excluded.expires_at"
        + " WHERE team_leases.owner=? OR team_leases.expires_at<?",
        [task_id, owner, now, now + ttlS, owner, now],
    );
    c.commit();
    return cur.rowcount > 0;
}

/** 只有持有者本人能释放——防误删他人的租约。 */
export function release_lease(
    storage: unknown,
    task_id: string,
    owner: string,
): boolean {
    if (arguments.length > 3) {
        throw pyTooMany("release_lease", "3", arguments.length);
    }
    _ensure_lease_table(storage);
    const c = pyDb(storage, "sessions");
    const cur = c.execute(
        "DELETE FROM team_leases WHERE task_id=? AND owner=?",
        [task_id, owner],
    );
    c.commit();
    return cur.rowcount > 0;
}

// ── TeamBoard ───────────────────────────────────────────────────────────────

/**
 * 一个 parent run 的看板：角色、租约、交付是否过契，一眼看全。
 * 支持 DAG 依赖拓扑（depends_on）与失败级联阻塞（blocked）。
 */
export class TeamBoard {
    storage: unknown;
    parent_run_id: string;
    _tasks: Map<string, JsonDict>;

    constructor(storage: unknown, parent_run_id: string) {
        if (arguments.length > 2) {
            // python: __init__(self, storage, parent_run_id) — self 计入 → takes 3
            throw pyTooMany("TeamBoard.__init__", "3", arguments.length + 1);
        }
        this.storage = storage;
        this.parent_run_id = parent_run_id;
        this._tasks = new Map<string, JsonDict>();
    }

    add_task(
        task_id: string,
        role: string,
        opts?: {
            depends_on?: unknown;
            overrides?: unknown;
            task_spec?: unknown;
        },
    ): JsonDict {
        if (arguments.length > 3) {
            throw pyTooMany("TeamBoard.add_task", "3", arguments.length + 1);
        }
        const o = opts ?? {};
        const spec = role_spec(role, { overrides: o.overrides });
        const ts = o.task_spec;
        let specContract: JsonDict | null = null;
        if (pyTruth(ts)) {
            specContract = pyHasAttr(ts, "to_dict")
                ? (ts as { to_dict: () => JsonDict }).to_dict()
                : pyDictCopy(ts);
        }

        const entry: JsonDict = {
            "task_id": task_id, "role": role, "spec": spec,
            "status": "pending",          // pending|leased|delivered|rejected|failed|blocked
            "lease_owner": "", "result": null, "contract_problems": [],
            "review_status": "none",      // none|approved|changes_requested|rejected|confirmed|escalated
            "review_note": "",
            "depends_on": pyListCopy(pyOr(o.depends_on, [])),
            "spec_contract": specContract,
        };
        this._tasks.set(task_id, entry);
        return entry;
    }

    /** 获取指定任务绑定的 Spec-Driven 合同。 */
    get_task_spec(task_id: string): TaskSpec | null {
        const t = this._tasks.get(task_id);
        if (!pyTruth(t) || !pyTruth(pyGet(t, "spec_contract"))) return null;
        return TaskSpec.from_dict(pySub(t, "spec_contract"));
    }

    /** 检查任务的前置依赖是否全部成功交付。 */
    can_run(task_id: string): boolean {
        const t = this._tasks.get(task_id);
        if (!pyTruth(t) || pySub(t, "status") !== "pending") return false;
        for (const dep of pyListCopy(pyOr(pyGet(t, "depends_on"), []))) {
            const depT = this._tasks.get(String(dep));
            if (!pyTruth(depT)) return false;
            if (pySub(depT, "status") !== "delivered") return false;
            if (pySub(depT, "review_status") === "rejected") return false;
        }
        return true;
    }

    /** 获取当前所有依赖已满足且处于 pending 状态的任务 ID。 */
    get_runnable_tasks(): string[] {
        const out: string[] = [];
        for (const tid of Array.from(this._tasks.keys())) {
            if (this.can_run(tid)) out.push(tid);
        }
        return out;
    }

    /** 若前置依赖失败/打回，级联将下游 pending 任务标记为 blocked。 */
    cascade_failures(): number {
        let blockedCount = 0;
        for (const [, t] of Array.from(this._tasks.entries())) {
            if (pySub(t, "status") !== "pending") continue;
            for (const dep of pyListCopy(pyOr(pyGet(t, "depends_on"), []))) {
                const depT = this._tasks.get(String(dep));
                if (pyTruth(depT) && ["rejected", "failed", "blocked"]
                    .includes(pySub(depT, "status") as string)) {
                    t["status"] = "blocked";
                    t["contract_problems"] = [
                        `prerequisite task '${String(dep)}' ${String(pySub(depT, "status"))}`,
                    ];
                    blockedCount += 1;
                    break;
                }
            }
        }
        return blockedCount;
    }

    claim(task_id: string, worker: string): boolean {
        const t = this._tasks.get(task_id);
        if (!pyTruth(t)) return false;
        const ok = acquire_lease(this.storage,
            `${this.parent_run_id}:${task_id}`, worker);
        if (ok) {
            (t as JsonDict)["status"] = "leased";
            (t as JsonDict)["lease_owner"] = worker;
        }
        return ok;
    }

    /** 交付必须同时满足：仍持有租约 + 过 ResultContract。二者缺一即拒收。 */
    deliver(task_id: string, worker: string, payload: unknown): [boolean, unknown[]] {
        const t = this._tasks.get(task_id);
        if (!pyTruth(t)) return [false, [`unknown task: ${task_id}`]];
        const tt = t as JsonDict;
        if (pySub(tt, "lease_owner") !== worker) {
            return [false, [
                `not lease holder: ${pyStr(worker)} vs ${pyStr(pySub(tt, "lease_owner"))}`,
            ]];
        }
        const schema = pySub(pySub(tt, "spec"), "result_schema");
        const outcome = check_result_contract(payload, schema);
        if (outcome[0]) {
            tt["status"] = "delivered";
            tt["result"] = payload;
        } else {
            tt["status"] = "rejected";
            tt["contract_problems"] = outcome[1];
        }
        return outcome;
    }

    /** reviewer gate：对 delivered 交付的复核裁决（五态）。 */
    set_review(task_id: string, verdict: string, note?: string): boolean {
        const t = this._tasks.get(task_id);
        if (!pyTruth(t) || pySub(t, "status") !== "delivered") return false;
        const validVerdicts = ["approved", "changes_requested", "rejected",
            "confirmed", "escalated"];
        if (!validVerdicts.includes(verdict)) {
            throw new ValueErrorP(`unknown review verdict ${pyReprStr(verdict)}`);
        }
        const tt = t as JsonDict;
        tt["review_status"] = verdict;
        tt["review_note"] = pyStr(pyOr(note === undefined ? "" : note, "")).slice(0, 300);
        if (verdict === "rejected") tt["status"] = "rejected";
        return true;
    }

    view(): JsonDict[] {
        const out: JsonDict[] = [];
        for (const t of Array.from(this._tasks.values())) {
            const o: JsonDict = {};
            for (const k of Object.keys(t)) {
                if (k !== "spec") o[k] = t[k];
            }
            o["role"] = t["role"];
            o["tools"] = pyLen(pySub(pySub(t, "spec"), "tools"));
            out.push(o);
        }
        return out;
    }
}

// ── 4-Stage Dispatch Pipeline ────────────────────────────────

/** 四段式分发管道：Admission → Steer → Dispatch → Delivery。 */
export class DispatchPipeline {
    max_concurrent: number;
    max_depth: number;

    constructor(max_concurrent?: number, max_depth?: number) {
        if (arguments.length > 2) {
            // python: __init__(self, max_concurrent=8, max_depth=2) → from 1 to 3
            throw pyTooManyRange("DispatchPipeline.__init__", 1, 3, arguments.length + 1);
        }
        this.max_concurrent = max_concurrent === undefined ? 8 : max_concurrent;
        this.max_depth = max_depth === undefined ? 2 : max_depth;
    }

    /** Stage 1: Admission 准入控制（并发限额、递归深度与预算检查）。 */
    admit(current_concurrent: number, depth: number, token_budget?: number): [boolean, string] {
        if (arguments.length > 3) {
            throw pyTooManyRange("DispatchPipeline.admit", 3, 4, arguments.length + 1);
        }
        const budget = token_budget === undefined ? 50_000 : token_budget;
        if (current_concurrent >= this.max_concurrent) {
            return [false, `concurrency limit reached (${
                current_concurrent}/${this.max_concurrent})`];
        }
        if (depth > this.max_depth) {
            return [false, `maximum subagent recursion depth exceeded (${
                depth} > ${this.max_depth})`];
        }
        if (budget <= 0) return [false, "insufficient token budget allocated"];
        return [true, ""];
    }

    /** Stage 2: Steer 动态角色特化与工具裁剪。 */
    steer(
        task_prompt: unknown,
        requested_persona?: unknown,
        requested_role?: unknown,
    ): JsonDict {
        if (arguments.length > 3) {
            throw pyTooManyRange("DispatchPipeline.steer", 2, 4, arguments.length + 1);
        }
        const persona = requested_persona === undefined ? "" : requested_persona;
        const role0 = requested_role === undefined ? "" : requested_role;
        let role: unknown = pyOr(role0, "coder");
        if (!pyTruth(role0)) {
            const promptLower = pyLowerAttr(task_prompt);
            if (["review", "diff", "audit", "check"].some((k) => promptLower.includes(k))) {
                role = "reviewer";
            } else if (["search", "find", "explore", "research", "investigate"]
                .some((k) => promptLower.includes(k))) {
                role = "researcher";
            } else if (["plan", "decompose", "design"].some((k) => promptLower.includes(k))) {
                role = "planner";
            } else if (["diagnose", "error", "trace", "bug"].some((k) => promptLower.includes(k))) {
                role = "diagnostician";
            }
        }
        return {
            "role": role,
            "persona": pyOr(persona, role),
            "spec": role_spec(role as string),
        };
    }

    /** Stage 3: Dispatch 会话隔离、派单合同与调度准备（支持 fork 快照继承）。 */
    dispatch(
        task_id: string,
        role_info: unknown,
        parent_session_id: string,
        opts?: { fork?: unknown; task_spec?: unknown },
    ): JsonDict {
        if (arguments.length > 4) {
            throw pyTooMany("DispatchPipeline.dispatch", "4", arguments.length + 1);
        }
        const o = opts ?? {};
        const fork = o.fork === undefined ? false : o.fork;
        const childSessionId = `subagent-${TEAM_SEAMS.uuid4_hex().slice(0, 8)}`;
        const res: JsonDict = {
            "task_id": task_id,
            "child_session_id": childSessionId,
            "parent_session_id": parent_session_id,
            "role": pyGet(role_info, "role", "coder"),
            "persona": pyGet(role_info, "persona", "coder"),
            "dispatched_at": TEAM_SEAMS.now(),
            "forked": fork,
        };
        const ts = o.task_spec;
        if (pyTruth(ts)) {
            res["spec"] = pyHasAttr(ts, "to_dict")
                ? (ts as { to_dict: () => JsonDict }).to_dict()
                : pyDictCopy(ts);
        }
        return res;
    }

    /** Stage 4+ Review: Reviewer-Critic 结构化分歧裁决。 */
    review(findings: unknown, critic_fn?: unknown): Record<string, unknown[]> {
        if (arguments.length > 2) {
            throw pyTooManyRange("DispatchPipeline.review", 2, 3, arguments.length + 1);
        }
        return adjudicate_review_findings(findings, critic_fn);
    }

    /** Stage 4: Delivery 交付物契约校验。 */
    deliver(result_payload: unknown, expected_schema: unknown): [boolean, unknown[]] {
        if (arguments.length > 2) {
            throw pyTooMany("DispatchPipeline.deliver", "3", arguments.length + 1);
        }
        return check_result_contract(result_payload, expected_schema);
    }
}

// PORT STATUS: 本文件无 TODO(port)。
// PORT STATUS: confidence=high todos=[0]
