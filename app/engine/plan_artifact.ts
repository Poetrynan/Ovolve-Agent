/**
 * plan_artifact.ts — port of app/backend/plan_artifact.py (unit 157, wave 7).
 *
 * SOURCE: app/backend/plan_artifact.py (134 lines) — Plan mode's first-class
 * artifact: save a plan as a contract (status=ready), approve/discard it,
 * find the latest ready plan for a session, render the execution-round
 * contract text, and extract ```plan fences from model output. Storage goes
 * through the storage kv (ns="plan_artifact"); the module is fail-open by
 * contract — get-side errors are swallowed, save/approve propagate.
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4 / RULEBOOK)
 *   §4 naming: python spellings verbatim — save_plan_artifact,
 *     get_plan_artifact, latest_ready_for_session, approve_plan_artifact,
 *     discard_plan_artifact, render_contract, extract_plan_block,
 *     _KV_NS, _MAX_CHARS, and the private _kv_key/_session_index_key.
 *   §2 json.dumps(ensure_ascii=False): pyJsonDumps with python's default
 *     separators (", " / ": ") — same helper shape as cron_manager.ts.
 *   §2 dict key order: the artifact literal is the contract —
 *     plan_id, session_id, plan_md, status, created_at, chars, meta — and
 *     the parity comparator walks the kv JSON strings byte-for-byte.
 *   §4.9 lazy import: python imports storage INSIDE each function (module
 *     level comment: tests patch it); the port routes through
 *     PLAN_ARTIFACT_SEAMS.import_storage — a throwing seam is observed
 *     exactly as a throwing import (save/latest/approve/discard propagate
 *     on their own arms; get_plan_artifact's try swallows).
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. save_plan_artifact's chars field is min(len(plan_md), _MAX_CHARS)
 *      where plan_md is the UNTRUNCATED stripped text — the stored plan_md is
 *      truncated in the literal, so chars == len only when no truncation.
 *   2. created_at = time.time() is read AFTER the uuid (uuid seam first).
 *   3. The session index is a kv value holding a JSON list; a non-list
 *      stored value is REPLACED by a fresh list, the new id appended, and
 *      only the LAST 50 ids are written back (idx[-50:]).
 *   4. get_plan_artifact checks `if not plan_id` BEFORE importing storage —
 *      an empty plan_id never touches the ledger. Its try covers ONLY the
 *      kv_get; a stored dict is returned AS-IS (the live object), a bad JSON
 *      string or a non-str non-dict raw returns None.
 *   5. latest_ready_for_session's try ALSO covers the json.loads of a non-
 *      list index (bad JSON -> None, not a fallback to []), and the walk is
 *      `reversed(ids)` over the list-checked ids only.
 *   6. approve_plan_artifact: approved_with = str(approved_with or "auto")
 *      (None/""/0 -> "auto", a falsy int stays "auto" via str()); it mutates
 *      the artifact OBJECT returned by get_plan_artifact and writes it back;
 *      approved_at = time.time() (second clock read).
 *   7. discard is terminal: only status=="ready" flips; the second call on
 *      the same id returns False.
 *   8. render_contract's frame text is byte-exact, md is
 *      str(artifact.get("plan_md") or "").strip() — a missing plan_md
 *      renders the empty body.
 *   9. extract_plan_block: text.find("```plan") anywhere (NOT line-anchored);
 *      the body starts after the FIRST newline following the marker; the
 *      closing ``` search starts at body_start+1; a missing closing fence
 *      runs to end-of-string; no marker -> the whole stripped text.
 *  10. The kv ledger sees THREE arities: save reads the index with
 *      default=[], get_plan_artifact reads its key WITHOUT a default, and
 *      both writes are kv_set(key, json, ns) — the recording fake pins the
 *      default=[] arm vs the bare arm.
 *
 * DIVERGENCE(port, lazy import -> seam): python imports storage inside every
 *     function; the port goes through PLAN_ARTIFACT_SEAMS.import_storage,
 *     which returns the get_storage callable (import failure and call
 *     failure stay distinguishable, matching the web_outbound seam shape).
 * DIVERGENCE(port, json error text): get/latest swallow JSONDecodeError and
 *     TypeError without inspecting them, so the port's JSON.parse failure
 *     never surfaces its own wording; pyJsonLoads' python-literal fallback
 *     (NaN/Infinity) is kept from the cron_manager helper for parity.
 *
 * FIXED(port, save arity wording — oracle tmp/plana_oracle_facts.json
 *   ar_save_four): save_plan_artifact has a defaulted `meta` parameter, so
 *   CPython words a too-many call as "save_plan_artifact() takes from 2 to 3
 *   positional arguments but 4 were given" — NOT the flat "takes 3" a
 *   no-default signature produces. The save guard passes takes="from 2 to 3"
 *   to pyTooMany so the emitted TypeError text matches CPython verbatim.
 */

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

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
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
    if (v instanceof Uint8Array) return v.length > 0;
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** house predicate: a value that IS a python dict — plain or prototype-less. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (v instanceof Uint8Array || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Map) {
        return "{" + Array.from(v.entries()).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    return pyStr(v);
}

/** python float repr for `str()`: integral values render int-style. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

/** python float marker: time.time() is ALWAYS a float, and python's
 *  json.dumps(1700000000.0) writes "1700000000.0" while json.loads keeps it
 *  float through round-trips — a JS number cannot tell. Values read back
 *  from kv JSON or produced by time.time() carry this box so dumps/ser stay
 *  byte-identical with CPython (cron_manager's NaN-revival precedent). */
export class PyFloatBox {
    constructor(public readonly n: number) {}
}
export function pyFloat(n: number): PyFloatBox { return new PyFloatBox(n); }
function pyFloatRepr(n: number): string {
    return Number.isInteger(n) && Number.isFinite(n) ? `${n}.0` : pyNumStr(n);
}

/** python str.strip() with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python's "missing N required positional argument(s)" TypeError text. */
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

type JsonDict = Record<string, unknown>;

/**
 * json.dumps(obj, ensure_ascii=False) with python's default `", "` / `": "`
 * separators (same helper shape as cron_manager.ts).
 */
function pyJsonDumps(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v instanceof PyFloatBox) return pyFloatRepr(v.n);
    if (typeof v === "number") {
        if (Number.isNaN(v)) return "NaN";
        if (v === Infinity) return "Infinity";
        if (v === -Infinity) return "-Infinity";
        return String(v);
    }
    if (typeof v === "string") {
        // ensure_ascii=False keeps U+2028/U+2029 raw where JSON.stringify escapes
        return JSON.stringify(v)
            .split("\\u2028").join(String.fromCharCode(0x2028))
            .split("\\u2029").join(String.fromCharCode(0x2029));
    }
    if (typeof v === "function" || v instanceof Error || v instanceof Map || v instanceof Set) {
        throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
    }
    if (Array.isArray(v)) return "[" + v.map(pyJsonDumps).join(", ") + "]";
    if (isPyDict(v)) {
        return (
            "{" +
            Object.keys(v)
                .map((k) => pyJsonDumps(k) + ": " + pyJsonDumps((v as JsonDict)[k]))
                .join(", ") +
            "}"
        );
    }
    throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

/** json.loads — only the dict/non-dict/raises outcome is observable here
 *  (every caller swallows the error), so the python-only literals
 *  NaN/Infinity/-Infinity decode instead of throwing. */
function pyJsonLoads(s: unknown): unknown {
    if (typeof s !== "string") {
        throw new TypeErrorP(
            `the JSON object must be str, bytes or bytearray, not ${pyTypeName(s)}`
        );
    }
    const reviveFloats = (x: unknown): unknown => {
        if (typeof x === "string" && x.startsWith("__PF__") && x.endsWith("__")) {
            const n = Number(x.slice(6, -2));
            if (Number.isFinite(n)) return pyFloat(n);
        }
        if (Array.isArray(x)) return x.map(reviveFloats);
        if (isPyDict(x)) {
            const o: JsonDict = {};
            for (const k of Object.keys(x as JsonDict)) o[k] = reviveFloats((x as JsonDict)[k]);
            return o;
        }
        return x;
    };
    try {
        // python json.loads keeps "….0" numbers float through round-trips;
        // park them behind a sentinel string so JSON.parse cannot flatten them.
        const patched = s.replace(/(:\s*)(-?\d+\.0)(?=[,\s}\]])/g, '$1"__PF__$2__"');
        return reviveFloats(JSON.parse(patched));
    } catch {
        /* fall through to the python-literal handling below */
    }
    const t = s.trim();
    if (t === "NaN") return NaN;
    if (t === "Infinity") return Infinity;
    if (t === "-Infinity") return -Infinity;
    throw new ValueErrorP("Expecting value: line 1 column 1 (char 0)");
}

/** python `dict(x)` for the meta field: a dict copies, a non-iterable
 *  raises TypeError (5 -> "'int' object is not iterable"). */
function pyDictCopy(x: unknown): JsonDict {
    if (!pyTruth(x)) return {};
    if (isPyDict(x)) return { ...(x as JsonDict) };
    if (x instanceof Map) return Object.fromEntries(x.entries());
    if (Array.isArray(x)) {
        const o: JsonDict = {};
        for (let i = 0; i < x.length; i++) {
            const item = x[i];
            const pair = Array.isArray(item) ? item : null;
            if (!pair || pair.length !== 2) {
                throw new TypeErrorP(
                    `dictionary update sequence element #${i} has length ${pair ? pair.length : 0}; 2 is required`);
            }
            o[pyStr(pair[0])] = pair[1];
        }
        return o;
    }
    throw new TypeErrorP(`'${pyTypeName(x)}' object is not iterable`);
}

/** python `art.get("status")` is a METHOD call — a list/str artifact (a
 *  json.loads non-dict that slipped through) raises AttributeError('get'). */
function pyGetCall(art: unknown, key: string): unknown {
    if (art === null || art === undefined || Array.isArray(art) || typeof art !== "object") {
        throw new AttributeErrorP(`'${pyTypeName(art)}' object has no attribute 'get'`);
    }
    return (art as Record<string, unknown>)[key];
}

// ── module constants ─────────────────────────────────────────────────────────

export const _KV_NS = "plan_artifact";
export const _MAX_CHARS = 40000;

export type PaStorage = {
    kv_get(key: string, ns?: string, defaultValue?: unknown): unknown;
    kv_set(key: string, value: unknown, ns?: string): unknown;
};

export const PLAN_ARTIFACT_SEAMS = {
    /** python `from storage import get_storage` — returns the callable; the
     *  import and the CALL stay separately observable. */
    import_storage: (): (() => PaStorage) => {
        throw new (class extends Error {
            constructor() { super("No module named 'storage'"); this.name = "ModuleNotFoundError"; }
        })();
    },
    /** python `uuid.uuid4().hex[:12]` — the probe scripts the hex. */
    uuidHex12: (): string => "",
    /** python `time.time()`. */
    timeNow: (): number => 0.0,
};

// ── private key builders ─────────────────────────────────────────────────────

export function _kv_key(plan_id: unknown): string {
    return `pa:${pyStr(plan_id)}`;
}

export function _session_index_key(session_id: unknown): string {
    return `pa_idx:${pyStr(session_id)}`;
}

// ── save_plan_artifact ───────────────────────────────────────────────────────

/** 把一份方案文本存为一等产物（status=ready），返回完整 artifact。 */
export function save_plan_artifact(session_id: unknown, plan_md: unknown,
                                   meta?: unknown): JsonDict {
    if (arguments.length < 2) {
        throw pyMissing("save_plan_artifact", ["session_id", "plan_md"].slice(arguments.length));
    }
    // meta has a default, so CPython words too-many as the RANGE "from 2 to 3"
    // (oracle ar_save_four). The range string flows straight through pyTooMany.
    if (arguments.length > 3) throw pyTooMany("save_plan_artifact", "from 2 to 3", arguments.length);
    const getStorage = PLAN_ARTIFACT_SEAMS.import_storage();
    const st = getStorage() as PaStorage;
    const md = pyStrip(pyStr(pyOr(plan_md, "")));
    const artifact: JsonDict = {
        plan_id: `pa_${PLAN_ARTIFACT_SEAMS.uuidHex12()}`,
        session_id: session_id as string,
        plan_md: md.slice(0, _MAX_CHARS),
        status: "ready",
        created_at: pyFloat(PLAN_ARTIFACT_SEAMS.timeNow()),
        chars: Math.min(md.length, _MAX_CHARS),
        meta: pyDictCopy(meta),
    };
    st.kv_set(_kv_key(artifact.plan_id), pyJsonDumps(artifact), _KV_NS);
    let idx: unknown = st.kv_get(_session_index_key(session_id), _KV_NS, []);
    if (!Array.isArray(idx)) idx = [];
    (idx as unknown[]).push(artifact.plan_id);
    // 单会话上限 50 份：防长期会话把 kv 索引刷爆；旧方案按需 get_plan_artifact 直取。
    st.kv_set(_session_index_key(session_id), pyJsonDumps((idx as unknown[]).slice(-50)), _KV_NS);
    return artifact;
}

// ── get_plan_artifact ────────────────────────────────────────────────────────

export function get_plan_artifact(plan_id: unknown): JsonDict | null {
    if (arguments.length === 0) throw pyMissing("get_plan_artifact", ["plan_id"]);
    if (arguments.length > 1) throw pyTooMany("get_plan_artifact", "1", arguments.length);
    if (!pyTruth(plan_id)) return null;
    const getStorage = PLAN_ARTIFACT_SEAMS.import_storage();
    let raw: unknown;
    try {
        raw = (getStorage() as PaStorage).kv_get(_kv_key(plan_id), _KV_NS);
    } catch {
        return null;
    }
    if (!pyTruth(raw)) return null;
    // kv_get 对字符串值会自动 json.loads——存进去的 JSON 串取出来已是 dict；
    // 兼容两种形态，不重复解码。
    if (isPyDict(raw)) return raw as JsonDict;
    try {
        return pyJsonLoads(raw) as JsonDict;
    } catch {
        return null;
    }
}

// ── latest_ready_for_session ─────────────────────────────────────────────────

/** 该会话最新一份仍为 ready 的方案（已批准/已放弃的不返回）。 */
export function latest_ready_for_session(session_id: unknown): JsonDict | null {
    if (arguments.length === 0) throw pyMissing("latest_ready_for_session", ["session_id"]);
    if (arguments.length > 1) throw pyTooMany("latest_ready_for_session", "1", arguments.length);
    let ids: unknown;
    try {
        const getStorage = PLAN_ARTIFACT_SEAMS.import_storage();
        const raw = (getStorage() as PaStorage).kv_get(_session_index_key(session_id as string), _KV_NS, []);
        ids = Array.isArray(raw) ? raw : pyJsonLoads(raw);
    } catch {
        return null;
    }
    const list = Array.isArray(ids) ? ids : [];
    for (let i = list.length - 1; i >= 0; i--) {
        const art = get_plan_artifact(list[i]);
        // python: art.get("status") — a non-dict artifact raises here
        if (pyTruth(art) && pyGetCall(art, "status") === "ready") return art;
    }
    return null;
}

// ── approve / discard ────────────────────────────────────────────────────────

/** ready -> approved，原子防重：二次批准返回 None（一个方案只许触发一次执行轮）。 */
export function approve_plan_artifact(plan_id: unknown, approved_with: unknown): JsonDict | null {
    if (arguments.length < 2) {
        throw pyMissing("approve_plan_artifact", ["plan_id", "approved_with"].slice(arguments.length));
    }
    if (arguments.length > 2) throw pyTooMany("approve_plan_artifact", "2", arguments.length);
    const art = get_plan_artifact(plan_id);
    if (!pyTruth(art) || pyGetCall(art, "status") !== "ready") return null;
    (art as JsonDict)["status"] = "approved";
    (art as JsonDict)["approved_with"] = pyStr(pyOr(approved_with, "auto"));
    (art as JsonDict)["approved_at"] = pyFloat(PLAN_ARTIFACT_SEAMS.timeNow());
    const getStorage = PLAN_ARTIFACT_SEAMS.import_storage();
    (getStorage() as PaStorage).kv_set(_kv_key(plan_id as string), pyJsonDumps(art), _KV_NS);
    return art;
}

/** ready -> discarded。discarded 是终态：不可再批准。 */
export function discard_plan_artifact(plan_id: unknown): boolean {
    if (arguments.length === 0) throw pyMissing("discard_plan_artifact", ["plan_id"]);
    if (arguments.length > 1) throw pyTooMany("discard_plan_artifact", "1", arguments.length);
    const art = get_plan_artifact(plan_id);
    if (!pyTruth(art) || pyGetCall(art, "status") !== "ready") return false;
    (art as JsonDict)["status"] = "discarded";
    const getStorage = PLAN_ARTIFACT_SEAMS.import_storage();
    (getStorage() as PaStorage).kv_set(_kv_key(plan_id as string), pyJsonDumps(art), _KV_NS);
    return true;
}

// ── render_contract ──────────────────────────────────────────────────────────

/** 把已批准方案渲染成执行轮开头的合同文本。 */
export function render_contract(artifact: unknown): string {
    if (arguments.length === 0) throw pyMissing("render_contract", ["artifact"]);
    if (arguments.length > 1) throw pyTooMany("render_contract", "1", arguments.length);
    // python: artifact.get("plan_md") — None artifact raises AttributeError
    const md = pyStrip(pyStr(pyOr(pyGetCall(artifact, "plan_md"), "")));
    return (
        "[方案合同] 以下是已获用户批准的执行方案，请严格按其分步执行；\n" +
        "每完成一步在回复中标注对应步骤状态（todo/in_progress/done/failed/skipped，" +
        "与 PlanStepStatus 一致），遇阻如实报告，不要擅自扩大范围：\n\n" +
        `${md}\n\n` +
        "[方案合同结束] 超出方案范围的新增改动，先说明并征求用户同意。"
    );
}

// ── extract_plan_block ───────────────────────────────────────────────────────

/** 从模型输出提取 ```plan 围栏内容；无围栏回退全文（去空白）。 */
export function extract_plan_block(text: unknown): string {
    if (arguments.length === 0) throw pyMissing("extract_plan_block", ["text"]);
    if (arguments.length > 1) throw pyTooMany("extract_plan_block", "1", arguments.length);
    const s = pyStr(pyOr(text, ""));
    const marker = "```plan";
    const start = s.indexOf(marker);
    if (start === -1) return pyStrip(s);
    const bodyStart = s.indexOf("\n", start);
    if (bodyStart === -1) return "";
    const end = s.indexOf("```", bodyStart + 1);
    const body = s.slice(bodyStart + 1, end !== -1 ? end : s.length);
    return pyStrip(body);
}

// PORT STATUS: confidence=high todos=[0]
