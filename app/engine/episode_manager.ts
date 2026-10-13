/**
 * episode_manager.ts — 会话主题片段 (ConversationEpisode) 管理器。
 *
 * Ported from `app/backend/episode_manager.py` (185 lines, wave-6, unit 153).
 *
 * ## 解决什么
 *
 * 一个 Session 是一个独立对话世界；同一 Session 内按主题、意图、Goal 切换或
 * 闲置超时，切成相互独立的 Episode。每个 Episode 独立追踪 Turn 列表，封存
 * (seal) 时写一条 episode.sealed 事件并触发进化引擎的独立观察。本模块是该状
 * 态机的唯一裁决者：它不碰数据库，所有持久化都走注入的 storage 对象，所以
 * "什么条件下换段、换段时先封哪一段" 是纯逻辑，可逐比特对齐。
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/episode_manager.py -> app/engine/episode_manager.ts.
 *       Public python names stay snake_case, verbatim: EPISODE_IDLE_TIMEOUT_SEC,
 *       detect_topic_shift, EpisodeManager (get_or_create_active_episode /
 *       record_turn / seal_episode_once / seal_episode / check_idle_episodes),
 *       get_episode_manager. Instance attribute stays `_storage`.
 *   §2  every truth gate goes through pyTruth and the python `or` idiom:
 *       `str(prompt or "")`, `topic or "General Dialogue"`,
 *       `branch_id or ""`, `goal_id or ""`, `reason or "manual"`,
 *       `ep.get("last_activity_at") or ep.get("started_at") or now`,
 *       `storage or get_storage()`, `... get_episode(episode_id) or ep`,
 *       `return ep or {}`. `or` returns the OPERAND, so a present-but-null
 *       `.get()` never folds into the default until the `or` says so.
 *   §2  present-but-null: `dictGet` returns the stored null for a key that IS
 *       there; only a MISSING key takes the default — so
 *       `ep.get("generation", 1)` with a stored NULL yields null in the sealed
 *       payload (quirk §20), while `ep.get("turn_ids", [])` with a stored NULL
 *       yields None and `len(None)` raises TypeError (quirk §20).
 *   §2  `x.get(...)` is an ATTRIBUTE of a mapping: a str/list/None receiver
 *       raises AttributeError('... object has no attribute 'get') through
 *       `getAttr`, and `.lower()` likewise raises for a non-str
 *       (`pyLower`). Where python has no try around them the exception escapes
 *       (detect_topic_shift with a non-str `topic`, `ep["episode_id"]`);
 *       where python DOES have one (the two event blocks, the evolution arm,
 *       check_idle_episodes) the catch swallows it verbatim — inventory
 *       BROAD-SWALLOW dispositions, kept as-is.
 *   §2  `ep["episode_id"]` is a SUBSCRIPT, not a `.get`: `dictIndex` raises
 *       KeyError('episode_id') for a missing key and CPython's own subscript
 *       TypeError wording for a list/str receiver (quirk §13).
 *   §2  `float(...)` is `pyFloatCoerce` (str/num/bool, inf/nan tokens,
 *       digit-group underscores, CPython's ValueError wording).
 *   §2  `len(...)` is `pyLen` (codepoints for str, elements for list,
 *       keys for a plain object; TypeError 'object of type 'X' has no len()').
 *   §2  `for ep in active_eps` is `pyIter` — a dict iterates its KEYS, a string
 *       its characters, a non-iterable raises TypeError (all three land in
 *       check_idle_episodes' own except and become the printed line).
 *   §2  slicing: `cleaned[:40]` counts CODEPOINTS (pcSlice), which is the only
 *       astral-sensitive slice in the module. `p[1:p.index("]")]` slices up to
 *       the first ']' — JS indexOf/slice cut at the same character, so the
 *       RESULT is identical even though the unit count differs.
 *   §2  `marker in lower_p` / `"]" in p` are substring tests
 *       (`String.includes`), and `p.split(marker)[-1]` is the LAST chunk of a
 *       real separator split — python's "no match returns [p]" behaviour is
 *       exactly JS's, so the case quirk §2 transfers bit-for-bit.
 *   §2  exception identity: KeyErrorP/AttributeErrorP/TypeErrorP/ValueErrorP/
 *       ImportErrorP carry the python class name in `.name` and the python
 *       `str(exc)` in `.message`, so the probe compares [type, str] pairs.
 *   §2  `if engine and engine.enabled()`: an engine object is truthy
 *       (pyTruth's object arm), the gate is really `enabled()`.
 *   §2  module-singleton: `_episode_manager` is created once and every later
 *       `get_episode_manager(st)` call IGNORES `st` (quirk §26).
 *   §2  the two print lines are the module's only loud arms and keep their
 *       verbatim f-string text, including `[episode_manager] ` and `: {exc}`
 *       (`str(exc)` — a python exception's str() has no class name).
 *
 * LATENT QUIRKS KEPT BUG-FOR-BUG (all pinned by tmp/em_probe_py.py +
 * tmp/em_probe_ts.mjs)
 *   §1  detect_topic_shift normalises with `str(prompt or "").strip()` BEFORE
 *       the emptiness test, so a whitespace-only prompt returns None through
 *       `if not p`, while a falsy non-string (0 / [] / None) never reaches
 *       `.strip()` at all.
 *   §2  the marker loop tests membership on `lower_p` but SPLITS on `p`: the
 *       three case-bearing ASCII markers ("/newtopic", "reset topic",
 *       "new topic:") are matched case-insensitively yet only cut
 *       case-sensitively. A prompt that hits them in another case
 *       ("用 /NewTopic 一下") finds no separator, `[-1]` is the WHOLE prompt,
 *       and the returned "topic" is the prompt's first 40 characters. The CJK
 *       markers have no case, so they are unaffected.
 *   §3  `p.split(marker)[-1]` takes the tail after the LAST occurrence of the
 *       FIRST marker in tuple order — not the earliest position in the string:
 *       "另外讨论X 换个话题Y" shifts on 换个话题 (tuple order), and
 *       "换个话题A 换个话题B" returns "B".
 *   §4  `.strip(" :：，,。")` is a character SET (ASCII space/colon/comma plus
 *       the fullwidth '：','，' and the ideographic full stop '。'), not a
 *       substring, and it runs before the 40-cap.
 *   §5  `return cleaned[:40] if cleaned else "New Topic"` — the gate reads the
 *       PRE-slice value, so the cap can never produce the sentinel: "New Topic"
 *       appears only when the strip emptied the tail.
 *   §6  the `[Tag]` branch requires the strip-ed prompt to start with "[",
 *       cuts at the FIRST "]", re-strips the tag, compares
 *       case-insensitively against `current_topic`, and returns the tag in its
 *       ORIGINAL case. An empty tag ("[] rest") or a tag equal to the current
 *       topic falls through to None.
 *   §7  `get_or_create_active_episode("")` → `{}`: the falsy-session_id exit is
 *       an empty DICT, not None, so callers that only test truthiness see
 *       "no episode" and callers indexing it see a KeyError.
 *   §8  `inferred_topic` starts as `topic` and is only ever replaced when
 *       `ep and prompt and not topic` — an explicit topic disables detection
 *       completely, and with no active episode detection never runs either.
 *   §9  the three换段分支 are `if / elif / elif`: idle_timeout beats
 *       goal_switch beats topic_shift, exactly ONE seal happens per call, and
 *       the idle branch additionally requires `not ep.get("goal_id")` — a
 *       goal-bound episode NEVER idle-seals.
 *   §10 the seal branches read `ep["episode_id"]` (subscript) while the rest of
 *       the module uses `.get`, so an episode dict without that key raises out
 *       of a seal path but not out of record_turn.
 *   §11 the topic-shift guard's sentinel test `inferred_topic != "General
 *       Dialogue"` is CASE-SENSITIVE and sits AFTER the case-INSENSITIVE
 *       inequality, so it is only ever reachable as an EXEMPTION: a detected
 *       topic of exactly "General Dialogue" never seals, while the lowercase
 *       "general dialogue" (which is the same topic modulo case) DOES seal.
 *   §12 the create path uses `topic or "General Dialogue"`, NOT `inferred_topic`:
 *       a prompt-detected shift seals the old episode and the new one starts as
 *       "General Dialogue" — the detected topic is thrown away. Same value is
 *       what the episode.started payload carries.
 *   §13 `last_act = float(ep.get("last_activity_at") or ep.get("started_at") or
 *       now)`: the `or` chain runs FIRST, so a stored `0.0`/`""`/null falls
 *       through to started_at, and a stored non-numeric string raises
 *       ValueError. That statement is unprotected in
 *       get_or_create_active_episode (escapes to the caller) and protected in
 *       check_idle_episodes (becomes the printed line and aborts the sweep) —
 *       identical expression, two different error exposures, both kept.
 *   §14 the started-event payload keeps `goal_id` RAW (`"goal_id": goal_id`)
 *       while its sibling keys use `branch_id or ""`, and the created row gets
 *       `goal_id or ""` — so a None/"" goal differs between the row and the
 *       event ledger only in the branch_id direction, and the episode row never
 *       sees a null goal.
 *   §15 the created episode is re-read with `get_episode(eid)` and returned as
 *       `ep or {}`: a storage whose get_episode returns None yields `{}` AFTER
 *       episode.started was already written.
 *   §16 `record_turn`'s no-session/no-turn exit is the empty STRING "", and its
 *       episode id is `str(ep.get("episode_id") or "")` — an int id stringifies
 *       and a present-but-null id becomes "" (no append_turn_to_episode call).
 *   §17 seal_episode_once returns TRUE for an UNKNOWN episode id
 *       (`if not ep or status == 'sealed'`): "nothing to seal" is success, and
 *       only a falsy episode_id is False.
 *   §18 `reason or "manual"` goes to storage while the episode.sealed payload
 *       carries the RAW `reason` — a default seal logs reason "manual" in the
 *       row and reason "" in the event. Kept (inventory BUG(port)); callers
 *       that read the event ledger must not assume the two agree.
 *   §19 the sealed payload's `turn_count` is `len(ep.get("turn_ids", []))` and
 *       `generation` is `ep.get("generation", 1)` — no `or` guards, so stored
 *       nulls raise (turn_count) or stay null (generation); either way the
 *       broad except only swallows the RAISE, and the seal already happened.
 *   §20 the two events normalise their dimension keys differently: sealed uses
 *       `bid or None` / `ep.get("goal_id") or None`, started uses
 *       `branch_id or None` / `goal_id or None` — an empty string becomes None
 *       in both, so the visible gap is only the missing `or ""` on the sealed
 *       `goal_id` read (a stored null stays null → `or None` → None).
 *   §21 the evolution arm runs only when the seal returned truthy AND the
 *       engine is present AND `enabled()`; it RE-READS the episode
 *       (`get_episode(episode_id) or ep`) so the engine observes the sealed row
 *       and falls back to the pre-seal dict when the re-read misses.
 *   §22 `seal_episode` is an alias that forwards ONLY `reason`; `event_id`
 *       stays "" even though seal_episode_once accepts it.
 *   §23 `check_idle_episodes` hard-codes `list_active_episodes(limit=100)`,
 *       keeps the `not ep.get("goal_id")` guard, appends only on a truthy seal,
 *       and the whole loop sits INSIDE one try — a raising row aborts the sweep
 *       and the already-collected ids are still returned.
 *   §24 `get_episode_manager(storage)` binds the singleton on the FIRST call
 *       only; a later call with a different storage still returns the first
 *       manager (and `storage or get_storage()` was evaluated once, too).
 *   §25 `check_idle_episodes(idle_timeout_s=EPISODE_IDLE_TIMEOUT_SEC)` binds
 *       the default at DEF time in python, while
 *       get_or_create_active_episode re-reads the module global at CALL time —
 *       see the constant-binding divergence below.
 *   §26 in both event blocks the `from event_types import EventType` line is the
 *       FIRST statement, so when that import fails the storage's
 *       `get_event_store()` is never reached (probe b33/d11: 3 ledger entries,
 *       not 5). The port therefore resolves the event-type name into a local
 *       BEFORE looking the store up; the `.value` read itself cannot fail, so
 *       the hoist is unobservable except in exactly this ordering case.
 *
 * MIGRATION DECISIONS / DIVERGENCES (documented dispositions)
 *   DIVERGENCE(port, constant binding): JS default parameters are evaluated per
 *       CALL, so the port freezes python's def-time default explicitly
 *       (`_IDLE_DEFAULT` captured at module load) — the *default* therefore
 *       matches python exactly. The call-time re-read of the module global in
 *       the idle branch is a `const` here, so rebinding
 *       `episode_manager.EPISODE_IDLE_TIMEOUT_SEC` at runtime (python only)
 *       would move one side but not the other. Nothing in the repository ever
 *       rebinds it (grep over app/: only the definition and the two reads), and
 *       both sides see the same 1800.0, so production behaviour is identical.
 *   DIVERGENCE(port, kwargs -> positional): `storage.create_episode(
 *       session_id=…, topic=…, goal_id=…, branch_id=…, metadata=…)`,
 *       `seal_episode(episode_id, reason=…, event_id=…)`,
 *       `list_active_episodes(limit=100)` and `es.append(event_type=…,
 *       session_id=…, payload=…, branch_id=…, goal_id=…)` become the landed
 *       TS signatures' positional/opts calls (storage/domains/recall and
 *       event_store.EventStore.append). Every keyword maps onto the SAME
 *       parameter name, and the parity probe compares each collaborator's
 *       BOUND argument values (defaults filled) rather than the spelling, so a
 *       mis-ordered mapping fails the probe.
 *   DIVERGENCE(port, lazy import seam): `from event_types import EventType` and
 *       `import evolution; evolution.get_evolution_engine()` are call-time
 *       lookups inside a try. Both names are landed TS siblings, so the port
 *       binds them statically and reaches them through EPISODE_SEAMS.eventType
 *       / EPISODE_SEAMS.evolutionEngine: an override that throws reproduces
 *       python's ImportError/ModuleNotFoundError arm at the same statement, and
 *       the two surrounding excepts stay verbatim. event_types.ts stores the
 *       member VALUES ("episode.started"/"episode.sealed"), which is exactly
 *       what python's `.value` yields.
 *   DIVERGENCE(port, import time): python imports `evolution` lazily, i.e. the
 *       heavy module graph loads at the first seal; the port's static
 *       `import * as evolution` loads it when episode_manager.js is first
 *       imported. The evolution graph is pure declarations (verified: no
 *       module-level I/O — storage/event_store/sqlite are only touched inside
 *       functions), and there is no cycle back to this module, so the only
 *       observable difference is when the one-time load cost is paid.
 *   DIVERGENCE(port, sync API): python's `print(...)` -> `EPISODE_SEAMS.log`
 *       (console.log), and `time.time()` -> `EPISODE_SEAMS.now()`. Both stay
 *       synchronous, so seal_episode_once/check_idle_episodes keep python's
 *       return types (raw seal value / id array) instead of becoming promises.
 *   DIVERGENCE(port, call-time global lookup): python's
 *       `get_or_create_active_episode` resolves `detect_topic_shift` and
 *       `EPISODE_IDLE_TIMEOUT_SEC` through the module dict at every call, so a
 *       runtime `episode_manager.detect_topic_shift = ...` patch would move the
 *       class; the port calls the module-local binding, which no external
 *       reassignment can reach. Nothing in app/ patches either name (grep over
 *       app/: only the definitions and the in-module calls), and both sides see
 *       the same function and the same 1800.0, so production behaviour is
 *       identical. The probe therefore drives detection through its ARGUMENTS
 *       (prompt/topic values), not through a patch.
 *   DIVERGENCE(port, whitespace/case): `str.strip()` is isspace()-set based —
 *       the port uses the house `pyStrip` table (incl. U+0085/U+00A0/U+2028…),
 *       which is what the probe drives; `str.lower()` vs `toLowerCase()` differ
 *       only for special mappings (final sigma, Turkish İ) that no marker, tag
 *       or topic in this module's domain contains, and the CJK markers are
 *       case-less by definition. Same disposition as gui_action_classifier /
 *       context_compactor.
 *   DIVERGENCE(port, sqlite row type): python's storage returns sqlite3.Row
 *       dicts and `ep.get` works on both; the landed storage port returns plain
 *       objects, so dictGet/getAttr reproduce present-but-null and the
 *       non-mapping AttributeError identically.
 *   DIVERGENCE(port, object truthiness): python's `storage or get_storage()`
 *       tests a single object, so `bool(x)` is only ever False for None/""/0 —
 *       the house `pyTruth` mirrors that by applying the empty-container rule
 *       through `isPyDict` (plain or prototype-less object, not Buffer/Error)
 *       and treating any other object as True, which is python's default
 *       `__bool__`. Without that distinction a JS `new Storage()` with no own
 *       enumerable fields would look falsy and silently swap in the singleton.
 *   DIVERGENCE(port, number repr): JS has one number type, so
 *       `str(prompt or "")` cannot tell a python int from an integral float —
 *       an integral value renders like an int ("1", not "1.0"). Only nan/inf
 *       take python's spelling. The probe drives the non-string cases (a07 int
 *       123 → "123", a08 [1, 2] → "[1, 2]", a09 {'a': 1} → "{'a': 1}"); a caller
 *       passing 1.0 would see "1.0" in python and "1" here, and no caller does
 *       (app/ passes `str` prompts only). Same disposition as confirm_meta.
 *   The collaborator seams are the only I/O in the module: with a scripted
 *   storage, an event store and an engine provider, every branch above is a
 *   pure decision over the caller's arguments and the fake's ledger.
 */

import * as evolution from "./evolution.js";
import { EventType } from "./event_types.js";
import { get_storage } from "./storage.js";

// ── python-semantics helpers (house style: file-local) ───────────────────────

class KeyErrorP extends Error {
    constructor(key: string) {
        super(key);
        this.name = "KeyError";
    }
}
class AttributeErrorP extends Error {
    constructor(obj: unknown, attr: string) {
        super(`'${pyTypeName(obj)}' object has no attribute '${attr}'`);
        this.name = "AttributeError";
    }
}
class TypeErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "TypeError";
    }
}
class ValueErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}
class ImportErrorP extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ImportError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate (same shape as memory_layer's): a value that IS a python
 *  dict — a plain or prototype-less object, not a class instance. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (Buffer.isBuffer(v) || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    // A class instance is a python OBJECT: bool() is True whatever its own
    // fields are (nothing in this domain defines __bool__/__len__), so the
    // empty-container rule applies only to dict-shaped values.
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
    if (typeof v === "object") return true;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python `str(x)` (containers render through repr). */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    if (v instanceof Map) {
        return "{" + Array.from(v.entries()).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

/** python `repr(x)` for the string leaf. */
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

/** python float repr for `str()`: JS numbers carry no int/float tag, so an
 *  integral value renders like a python int (`1`, not `1.0`) — the house
 *  convention (same as confirm_meta's `String(v)`); only nan/inf take
 *  python's spelling. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

/** python `str(exc)` — the args text, without the class name. */
function pyStrExc(e: unknown): string {
    if (e instanceof Error) return e.message;
    return pyStr(e);
}

/** python `dict.get(key, dflt)`: present-but-null returns the stored null. */
function dictGet(dict: unknown, key: string, dflt: unknown = null): unknown {
    if (dict !== null && typeof dict === "object" && !Array.isArray(dict) &&
        !(dict instanceof Map) && !(dict instanceof Set) &&
        key in (dict as Record<string, unknown>)) {
        return (dict as Record<string, unknown>)[key];
    }
    return dflt;
}

/** python `obj.get(key, dflt)` as an ATTRIBUTE: a non-mapping raises. */
function getAttr(obj: unknown, key: string, dflt: unknown = null): unknown {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj) ||
        obj instanceof Map || obj instanceof Set) {
        throw new AttributeErrorP(obj, "get");
    }
    return dictGet(obj, key, dflt);
}

/** python `obj[key]` on a mapping-shaped receiver. */
function dictIndex(obj: unknown, key: string): unknown {
    if (Array.isArray(obj)) {
        throw new TypeErrorP("list indices must be integers or slices, not str");
    }
    if (typeof obj === "string") {
        throw new TypeErrorP("string indices must be integers, not 'str'");
    }
    if (obj === null || typeof obj !== "object") {
        throw new TypeErrorP(`'${pyTypeName(obj)}' object is not subscriptable`);
    }
    const o = obj as Record<string, unknown>;
    if (!(key in o)) throw new KeyErrorP(pyRepr(key));
    return o[key];
}

/** python `len(x)`. */
function pyLen(v: unknown): number {
    if (typeof v === "string") return Array.from(v).length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Map || v instanceof Set) return v.size;
    if (v !== null && typeof v === "object") return Object.keys(v as Record<string, unknown>).length;
    throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `iter(x)` for a `for` loop. */
function pyIter(v: unknown): unknown[] {
    if (Array.isArray(v)) return v.slice();
    if (typeof v === "string") return Array.from(v);
    if (v instanceof Set) return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (v !== null && typeof v === "object") return Object.keys(v as Record<string, unknown>);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `str.strip()` with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python `str.strip(chars)`: a character SET, codepoint-aware. */
function pyStripChars(s: string, chars: string): string {
    const set = new Set(Array.from(chars));
    const arr = Array.from(s);
    let i = 0;
    let j = arr.length;
    while (i < j && set.has(arr[i] ?? "")) i++;
    while (j > i && set.has(arr[j - 1] ?? "")) j--;
    return arr.slice(i, j).join("");
}

/** python `x.lower()` on an unknown receiver: non-str raises AttributeError. */
function pyLower(v: unknown): string {
    if (typeof v !== "string") throw new AttributeErrorP(v, "lower");
    return v.toLowerCase();
}

/** python `x.startswith(y)` / `y in x` on an unknown receiver. */
function pyStartsWith(v: unknown, prefix: string): boolean {
    if (typeof v !== "string") throw new AttributeErrorP(v, "startswith");
    return v.startsWith(prefix);
}

/** python `obj.name(*args)`: a missing/non-callable attribute raises
 *  AttributeError with python's own wording, so the evolution arm's print
 *  reads identically on both sides. */
function callMethod(obj: unknown, name: string, args: unknown[] = []): unknown {
    const fn = obj === null || obj === undefined
        ? undefined
        : (obj as Record<string, unknown>)[name];
    if (typeof fn !== "function") throw new AttributeErrorP(obj, name);
    return fn.apply(obj, args);
}

/** python `float(x)`. */
function pyFloatCoerce(raw: unknown): number {
    if (typeof raw === "boolean") return raw ? 1 : 0;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
        const v = pyStrip(raw);
        if (/^[+-]?inf(inity)?$/i.test(v)) return v.startsWith("-") ? -Infinity : Infinity;
        if (/^nan$/i.test(v)) return NaN;
        if (!/^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?|\.\d+)?(?:e[+-]?\d+)?|\.[0-9](?:_?[0-9])*(?:e[+-]?\d+)?)$/i.test(v)) {
            throw new ValueErrorP(`could not convert string to float: ${pyRepr(raw)}`);
        }
        return Number(v.replaceAll("_", ""));
    }
    throw new TypeErrorP(`float() argument must be a string or a real number, not '${pyTypeName(raw)}'`);
}

/** python codepoint slice `s[:n]`. */
function pcSlice(s: string, n: number): string {
    const chars = Array.from(s);
    return chars.length > n ? chars.slice(0, n).join("") : s;
}

type JsonDict = Record<string, unknown>;

// ── 协作者缝（parity/测试注入点；产品路径取默认值） ──────────────────────────

/** what this module needs from the injected storage object. */
export interface EpisodeStorage {
    get_active_episode(session_id: unknown, branch_id?: unknown): JsonDict | null;
    create_episode(
        session_id: unknown, topic?: unknown, goal_id?: unknown,
        branch_id?: unknown, metadata?: JsonDict | null, episode_id?: unknown
    ): unknown;
    get_episode(episode_id: unknown): JsonDict | null;
    append_turn_to_episode(episode_id: unknown, turn_id: unknown): unknown;
    seal_episode(episode_id: unknown, reason?: unknown, event_id?: unknown, metadata?: JsonDict | null): unknown;
    list_active_episodes(limit?: unknown): unknown;
    get_event_store(): EpisodeEventStore;
}

/** what this module needs from `storage.get_event_store()`. */
export interface EpisodeEventStore {
    append(
        session_id: unknown, event_type: unknown, payload: JsonDict,
        opts?: { branch_id?: unknown, goal_id?: unknown }
    ): unknown;
}

/** python `import evolution; evolution.get_evolution_engine()` surface. */
export interface EvolutionEngineLike {
    enabled(): unknown;
    observe_episode_completion(episode: unknown): unknown;
}

export const EPISODE_SEAMS = {
    /** python `time.time()` — 浮点秒。 */
    now: (): number => Date.now() / 1000,
    /** python `from storage import get_storage`（`storage or get_storage()`）。 */
    get_storage: (): EpisodeStorage => get_storage() as unknown as EpisodeStorage,
    /** python `from event_types import EventType` 的名字解析（成员即 .value）。 */
    eventType: (name: "EPISODE_STARTED" | "EPISODE_SEALED"): string => EventType[name],
    /** python `import evolution; evolution.get_evolution_engine()`。 */
    evolutionEngine: (): EvolutionEngineLike | null => evolution.get_evolution_engine(),
    /** python `print(...)`。 */
    log: (msg: string): void => {
        console.log(msg);
    },
};

// ── 常量（与 python 逐字对齐） ───────────────────────────────────────────────

export const EPISODE_IDLE_TIMEOUT_SEC = 1800.0; // 30 minutes of inactivity -> new episode

/** python 在 def 时求值一次默认值（quirk §25）：显式冻结以对齐。 */
const _IDLE_DEFAULT = EPISODE_IDLE_TIMEOUT_SEC;

/** detect_topic_shift 的显式换题线索元组：顺序即匹配优先级（quirk §3）。 */
const shift_markers: readonly string[] = [
    "换个话题", "新建主题", "另外问一个", "另外讨论", "新的任务", "切换到",
    "/newtopic", "reset topic", "new topic:",
];

// ── 函数 ─────────────────────────────────────────────────────────────────────

/**
 * python `detect_topic_shift(prompt, current_topic="")`.
 * Lightweight, local interpretable topic shift detection without external
 * dependencies (P1-7). See quirk §1–§6 for the case/slice/strip semantics.
 */
export function detect_topic_shift(prompt: unknown, current_topic: unknown = ""): string | null {
    const p = pyStrip(pyStr(pyOr(prompt, "")));
    if (!pyTruth(p)) return null;
    const lower_p = pyLower(p);

    for (const marker of shift_markers) {
        if (lower_p.includes(marker)) {
            const parts = p.split(marker);
            const cleaned = pyStripChars(parts[parts.length - 1] ?? "", " :：，,。");
            return pyTruth(cleaned) ? pcSlice(cleaned, 40) : "New Topic";
        }
    }

    if (pyStartsWith(p, "[") && p.includes("]")) {
        const tag = pyStrip(p.slice(1, p.indexOf("]")));
        if (pyTruth(tag) && pyLower(tag) !== pyLower(pyOr(current_topic, ""))) return tag;
    }

    return null;
}

/** Session-level conversation episode manager with hard session & branch isolation. */
export class EpisodeManager {
    _storage: EpisodeStorage;

    constructor(storage: unknown = null) {
        this._storage = (pyTruth(storage) ? storage : EPISODE_SEAMS.get_storage()) as EpisodeStorage;
    }

    /** Get current active episode or create a fresh one. */
    get_or_create_active_episode(
        session_id: unknown, topic: unknown = "", goal_id: unknown = "",
        branch_id: unknown = "", prompt: unknown = ""
    ): JsonDict {
        if (!pyTruth(session_id)) return {};
        let ep = this._storage.get_active_episode(session_id, pyOr(branch_id, ""));
        const now = EPISODE_SEAMS.now();

        // P1-7: Check for interpretable topic shift from prompt if active episode exists
        let inferred_topic: unknown = topic;
        if (pyTruth(ep) && pyTruth(prompt) && !pyTruth(topic)) {
            const detected = detect_topic_shift(prompt, getAttr(ep, "topic", ""));
            if (pyTruth(detected)) inferred_topic = detected;
        }

        if (pyTruth(ep)) {
            const last_act = pyFloatCoerce(pyOr(
                pyOr(getAttr(ep, "last_activity_at"), getAttr(ep, "started_at")),
                now
            ));
            // Check if idle timeout exceeded on last activity
            if ((now - last_act) > EPISODE_IDLE_TIMEOUT_SEC && !pyTruth(getAttr(ep, "goal_id"))) {
                this.seal_episode_once(dictIndex(ep, "episode_id"), "idle_timeout");
                ep = null;
            } else if (pyTruth(goal_id) && pyTruth(getAttr(ep, "goal_id")) &&
                       getAttr(ep, "goal_id") !== goal_id) {
                // Goal changed -> switch episode
                this.seal_episode_once(dictIndex(ep, "episode_id"), "goal_switch");
                ep = null;
            } else if (pyTruth(inferred_topic) && pyTruth(getAttr(ep, "topic")) &&
                       pyLower(inferred_topic) !== pyLower(getAttr(ep, "topic", "")) &&
                       inferred_topic !== "General Dialogue") {
                // Explicit topic shift
                this.seal_episode_once(dictIndex(ep, "episode_id"), "topic_shift");
                ep = null;
            }
        }

        if (!pyTruth(ep)) {
            const eid = this._storage.create_episode(
                session_id,
                pyOr(topic, "General Dialogue"),
                pyOr(goal_id, ""),
                pyOr(branch_id, ""),
                { created_reason: "active_demand" }
            );
            ep = this._storage.get_episode(eid);
            // Emit episode.started event
            try {
                // python statement order: the `from event_types import EventType`
                // line runs BEFORE get_event_store(), so a broken import must not
                // reach the store. The `.value` lookup itself cannot fail.
                const started_type = EPISODE_SEAMS.eventType("EPISODE_STARTED");
                const es = this._storage.get_event_store();
                es.append(
                    session_id,
                    started_type,
                    {
                        episode_id: eid,
                        topic: pyOr(topic, "General Dialogue"),
                        goal_id: goal_id,
                        branch_id: pyOr(branch_id, ""),
                    },
                    { branch_id: pyOr(branch_id, null), goal_id: pyOr(goal_id, null) }
                );
            } catch {
                /* python: except Exception: pass — the row already exists. */
            }
        }

        return pyOr(ep, {}) as JsonDict;
    }

    /** Ensure turn is bound to an active episode, returns episode_id. */
    record_turn(
        session_id: unknown, turn_id: unknown, topic: unknown = "",
        goal_id: unknown = "", branch_id: unknown = "", prompt: unknown = ""
    ): string {
        if (!(pyTruth(session_id) && pyTruth(turn_id))) return "";
        const ep = this.get_or_create_active_episode(session_id, topic, goal_id, branch_id, prompt);
        const eid = pyStr(pyOr(getAttr(ep, "episode_id"), ""));
        if (pyTruth(eid)) this._storage.append_turn_to_episode(eid, turn_id);
        return eid;
    }

    /** Seal an episode once (idempotent), record reason, emit event, and trigger learning loop. */
    seal_episode_once(episode_id: unknown, reason: unknown = "", event_id: unknown = ""): unknown {
        if (!pyTruth(episode_id)) return false;
        const ep = this._storage.get_episode(episode_id);
        if (!pyTruth(ep) || getAttr(ep, "status") === "sealed") return true;

        const ok = this._storage.seal_episode(episode_id, pyOr(reason, "manual"), event_id);
        if (pyTruth(ok)) {
            const sid = pyStr(pyOr(getAttr(ep, "session_id"), ""));
            const bid = pyStr(pyOr(getAttr(ep, "branch_id"), ""));
            try {
                // Same statement order as the started event: a broken
                // `from event_types import EventType` must not reach the store.
                const sealed_type = EPISODE_SEAMS.eventType("EPISODE_SEALED");
                const es = this._storage.get_event_store();
                es.append(
                    sid,
                    sealed_type,
                    {
                        episode_id: episode_id,
                        branch_id: bid,
                        reason: reason,
                        turn_count: pyLen(getAttr(ep, "turn_ids", [])),
                        generation: getAttr(ep, "generation", 1),
                    },
                    { branch_id: pyOr(bid, null), goal_id: pyOr(getAttr(ep, "goal_id"), null) }
                );
            } catch {
                /* python: except Exception: pass — the seal already landed. */
            }
            // Trigger learning observation for sealed episode if evolution engine is enabled
            try {
                const engine = EPISODE_SEAMS.evolutionEngine();
                if (pyTruth(engine) && pyTruth(callMethod(engine, "enabled"))) {
                    // Refresh episode record with sealed status
                    const sealed_ep = pyOr(this._storage.get_episode(episode_id), ep);
                    callMethod(engine, "observe_episode_completion", [sealed_ep]);
                }
            } catch (_obs_e) {
                EPISODE_SEAMS.log(
                    `[episode_manager] observe_episode_completion failed: ${pyStrExc(_obs_e)}`
                );
            }
        }
        return ok;
    }

    /** Alias for seal_episode_once. */
    seal_episode(episode_id: unknown, reason: unknown = ""): unknown {
        return this.seal_episode_once(episode_id, reason);
    }

    /** Check all active episodes across sessions and seal any that have been idle for > idle_timeout_s. */
    check_idle_episodes(idle_timeout_s: number = _IDLE_DEFAULT): unknown[] {
        const now = EPISODE_SEAMS.now();
        const sealed_ids: unknown[] = [];
        try {
            const active_eps = this._storage.list_active_episodes(100);
            for (const ep of pyIter(active_eps)) {
                const last_act = pyFloatCoerce(pyOr(
                    pyOr(getAttr(ep, "last_activity_at"), getAttr(ep, "started_at")),
                    now
                ));
                if ((now - last_act) > idle_timeout_s && !pyTruth(getAttr(ep, "goal_id"))) {
                    const eid = getAttr(ep, "episode_id");
                    if (pyTruth(eid) && pyTruth(this.seal_episode_once(eid, "idle_timeout"))) {
                        sealed_ids.push(eid);
                    }
                }
            }
        } catch (e) {
            EPISODE_SEAMS.log(`[episode_manager] check_idle_episodes error: ${pyStrExc(e)}`);
        }
        return sealed_ids;
    }
}

let _episode_manager: EpisodeManager | null = null;

export function get_episode_manager(storage: unknown = null): EpisodeManager {
    if (_episode_manager === null) _episode_manager = new EpisodeManager(storage);
    return _episode_manager;
}

/** parity/测试缝：rebinds python's module-level `_episode_manager` singleton. */
export function _set_episode_manager_for_parity(v: EpisodeManager | null): void {
    _episode_manager = v;
}

// PORT STATUS: confidence=high todos=[0]
