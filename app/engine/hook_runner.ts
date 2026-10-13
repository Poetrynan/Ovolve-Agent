/**
 * hook_runner.ts — port of app/backend/hook_runner.py (unit 156, wave 6).
 *
 * SOURCE: app/backend/hook_runner.py (794 lines) — external script/HTTP hooks
 * mounted on the event bus: config discovery, strict validation, subprocess /
 * HTTP execution, the exit-code + JSON output protocol, and the bus glue.
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4)
 *   §4  naming: every module-level python name keeps its spelling verbatim —
 *     HOOK_EVENTS, BUS_TO_HOOK, SUBAGENT_TERMINAL_STATUSES,
 *     SUBAGENT_START_STATUSES, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT,
 *     STOP_CONTINUE_LIMIT, HTTP_HOOK_FIELDS, HTTP_METHODS,
 *     ALLOWED_OUTPUT_KEYS, VALID_DECISIONS, HookOutcome, HookRunner,
 *     get_hook_runner, init_hooks, and every method (load, _build_group,
 *     _validate_hook, _validate_http_hook, _variables, _expand, run_one,
 *     _run_http, _parse_output, _record, _match_value_for, _hook_payload_for,
 *     _hook_event_for, fire, mount, _make_handler, config_paths, to_dict).
 *     File-local helpers are prefixed py* so they never collide with a
 *     sibling's.
 *   §2  `raise X(...)` -> throw new XP(...); exception identity (class name +
 *     str) is load-bearing: the parity probe compares [type, str(exc)] for
 *     every escape path, and user-facing reason strings embed str(e)
 *     verbatim (JSONDecodeError, OSError, HTTPError codes, re PatternError).
 *   §2  broad swallows preserved exactly: `except OSError` in run_one, the
 *     per-file `except (OSError, json.JSONDecodeError)` in load, and the
 *     `except Exception` arms in _run_http — each keeps its python catch set
 *     (TimeoutErrorP extends OSErrorP; HTTPErrorP extends OSErrorP; the
 *     catch-all mirrors `except Exception` and cannot represent
 *     KeyboardInterrupt/SystemExit).
 *   §2  dict literals are insertion-ordered contracts: the load() summary, the
 *     validated hook spec, the merged env, the _record log entry, the
 *     HookOutcome.to_dict and the stdin/envelope JSON all pin key order, and
 *     the comparator walks it.
 *   §2  asyncio -> async/await: run_one/_run_http/fire/_make_handler were
 *     async in the source and stay async; asyncio.wait_for / to_thread /
 *     create_subprocess_exec / create_subprocess_shell go through
 *     HOOK_RUNNER_SEAMS (the probe drives them with scripted fakes; the real
 *     implementations use node child_process and a timer race).
 *   §4.5/§22  arity wording: the pyMissing/pyTooMany/pyTooManyRange helpers
 *     reproduce CPython's messages for HookOutcome/HookRunner/__init__
 *     arities, counting `self` exactly like CPython instance construction
 *     ("takes from 2 to 7 positional arguments but 9 were given").
 *   §4.9  late binding: `web_outbound.open_url` and `get_event_bus` are
 *     resolved through HOOK_RUNNER_SEAMS so the probe can swap them per
 *     scenario exactly like the python side swaps module globals.
 *   §23  every decision in this module is code-driven: matcher regexes,
 *     validation tables, the timeout resolution order, the exit-code
 *     protocol and the 4xx/5xx handling are pure table/function logic with
 *     zero model participation.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. load() resets matchers and problems but NOT enabled/timeout_ms/
 *      max_output — a second load with `enabled: false` keeps the runner
 *      enabled from the first config.
 *   2. cfg "timeoutMs": true passes `isinstance(..., int)` (bool IS an int) so
 *      runner.timeout_ms stores True VERBATIM; a hook inheriting it divides
 *      True/1000.0 -> 0.001 s and the timeout reason reads "killed after
 *      Truems".
 *   3. Hook specs use isinstance(x, (int, float)) which also accepts bools:
 *      timeoutMs: true -> int(True) = 1 ms; timeout: true -> int(True*1000) =
 *      1000 ms. timeoutMs: 5.9 truncates to 5.
 *   4. A hook spec timeoutMs of Infinity (JSON "Infinity") raises
 *      OverflowError("cannot convert float infinity to integer") out of
 *      _validate_hook, out of load, out of init_hooks.
 *   5. Command/shell hooks never type-check "args": a STRING iterates by
 *      character (args: "abc" -> ["a", "b", "c"]), a dict iterates its keys,
 *      and a number raises TypeError("'int' object is not iterable") out of
 *      load(). Only `process` hooks reject non-array args.
 *   6. The matcher is str()'d before compiling: matcher 0 -> "0", False ->
 *      "True" (False is not in (None, "")), ["a"] -> "['a']" (a character
 *      class of quote and a). Invalid regexes record the problem with the
 *      raw_matcher repr and the 3.13 PatternError text.
 *   7. The strict output schema: an unknown key invalidates the whole payload;
 *      the _record error embeds the RAW SET repr ("{'x'}" — python's order is
 *      hash-randomised for >1 key, the port emits sorted order and the probe
 *      pins single-key sets), while the outcome reason uses sorted(extra).
 *   8. permissionDecision is validated against VALID_DECISIONS and reset to ""
 *      when unknown; the outcome is "block" only for ask/deny — allow and ""
 *      pass. reason stores permissionDecisionReason RAW (may be a non-str);
 *      context goes through str() and continue through bool().
 *   9. Exit protocol: rc 2 -> block/deny (reason = stdout or "hook exited 2");
 *      rc None passes through to the JSON parser; any other rc errors with
 *      stderr[:512] stripped or "exit N".
 *  10. stdout is bytes-sliced to max_output FIRST, then utf-8/replace-decoded,
 *      then stripped; stderr uses the same pipeline cut at 512.
 *  11. The shell branch appends " " + " ".join(shlex.quote(a)) — the command
 *      itself is never quoted. shlex.quote's safe set is the ASCII
 *      [A-Za-z0-9_@%+=:,./-]; an empty arg becomes "''".
 *  12. HTTP hooks build the JSON envelope even for GET (a non-serializable
 *      payload raises TypeError even then); data = body if body is not None
 *      else envelope; Content-Type is appended only when a body exists and no
 *      case-insensitive content-type key is present.
 *  13. 4xx -> _record("warning") + HookOutcome("pass") with "(4xx does not
 *      block the main flow)"; the code is getattr(e, "code", 0) or 0, and a
 *      non-int code raises TypeError inside the handler (it escapes — a
 *      handler's own exceptions are not caught by its try).
 *  14. resp.read() failure still runs the finally (close called); a close()
 *      failure REPLACES the in-flight error (python finally semantics).
 *  15. The subprocess timeout arm kills, waits, records "timeout" and returns
 *      "killed after Nms"; a kill() failure escapes run_one (the outer
 *      `except OSError` does not wrap the except body).
 *  16. A communicate() OSError becomes an error outcome; a communicate()
 *      RuntimeError escapes run_one entirely.
 *  17. _record appends {event, matchValue, command, type, source, status,
 *      durationMs, error, ts} and trims the log to its LAST 100 entries when
 *      it exceeds 200 (replacing the list object); ts is the third time.time()
 *      call of an execution (t0, duration, ts).
 *  18. session_before_compact slimming keeps key order minus "messages" and
 *      appends messageCount = len(messages or []) — a string counts
 *      characters, an unsized type raises TypeError out of fire.
 *  19. match values: tool events take payload["tool_name"] RAW (a non-str
 *      reaching a pattern raises "expected string or bytes-like object");
 *      output/subagentType are str()'d; the output value is cut at 200 CODE
 *      POINTS (emoji-safe); session_start's reason is NOT str()'d.
 *  20. tool_result: ok = (payload.get("result") or {}).get("ok", True) —
 *      result 5 or "junk" raise AttributeError ('int'/'str' object has no
 *      attribute 'get'); ok falsy -> PostToolUseFailure.
 *  21. The bus handler mutates event.payload in place: hook_context via
 *      setdefault(...).append (a non-list existing value raises
 *      AttributeError), hook_decision overwritten, and block(reason or
 *      "Blocked by hook") only for pre_tool_use/permission_request — then
 *      returns, skipping the remaining outcomes' payload effects.
 *  22. A config file with invalid UTF-8 raises UnicodeDecodeError (a
 *      ValueError) which load does NOT catch; a non-dict cfg (JSON array)
 *      raises AttributeError('list' object has no attribute 'get').
 *  23. mount() calls bus.on for the 9 BUS_TO_HOOK keys in dict order with
 *      priority -50; `bus or get_event_bus()` means a falsy bus argument
 *      re-resolves the singleton through the seam.
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   DIVERGENCE(port, regex dialect): python `re.compile(str(matcher))` is
 *     reimplemented as pyReCompile — a scanner that validates the pattern
 *     with CPython 3.13's sre error texts/positions (missing ), unbalanced
 *     parenthesis, unterminated character set, nothing/multiple repeat, min >
 *     max, bad escape, bad/missing/duplicate group name, invalid group
 *     reference, global-flags position, unterminated comment, bad character
 *     range) and translates the dialect: \d->\p{Nd}, \w->[\p{L}\p{N}_],
 *     \s->[\s\x1c-\x1f\x85] (unicode-aware, matching str-pattern semantics),
 *     \b/\B via unicode lookarounds, \A->^, \Z->(?![\s\S]), python's
 *     end-or-before-final-newline $ -> (?=\n?$), . -> [^\n] (python's dot
 *     only excludes \n), (?P<name>)->(?<name>), (?P=name)->\k<name>, (?#...)
 *     comments, global (?flags) at the start -> i/m/s/x(u/a no-op), literal
 *     braces escaped for the u flag. Constructs outside this dialect
 *     ((?(...)conditionals, scoped (?-i:...) flag resets, \N{...}, exotic
 *     case folding) either pass through to JS (possible SyntaxError or a
 *     match divergence) or raise PatternError where python would compile —
 *     none is reachable from the product's hooks.json shapes or the probe's
 *     pinned battery; the battery pins every translated construct and every
 *     error family above.
 *   DIVERGENCE(port, sync -> async): run_one/_run_http/fire and the bus
 *     handler return Promises (the source used asyncio coroutines); every
 *     raise site surfaces as a rejection. Same house precedent as
 *     web_outbound.ts / mcp_oauth.ts. check_egress-style helpers
 *     (load/_parse_output/_record/...) stay synchronous exactly as the
 *     source's sync methods are.
 *   DIVERGENCE(port, subprocess seams): asyncio.create_subprocess_exec /
 *     create_subprocess_shell go through HOOK_RUNNER_SEAMS; the real
 *     implementations spawn node child_process with the recorded argv shape
 *     (exec = argv array, shell = single command string) and the merged env,
 *     and expose the same {communicate, kill, wait, returncode} surface the
 *     source drives. The probe injects recording fakes, so no scenario can
 *     start a real process.
 *   DIVERGENCE(port, web_outbound seam): the source calls
 *     `asyncio.to_thread(web_outbound.open_url, url, timeout=..., headers=...,
 *     data=..., method=...)`; the port routes the call through
 *     SEAMS.toThread -> SEAMS.openUrl, whose real implementation awaits the
 *     landed web_outbound.ts open_url. The TS open_url resolves 4xx/5xx as a
 *     response object instead of raising urllib's HTTPError — that is the
 *     web_outbound unit's own contract; this port's HTTPError arm is
 *     reproduced verbatim and is exercised by the probe through a scripted
 *     HTTPErrorP. The real TS response carries no close(), so the finally's
 *     getattr(resp, "close", None) degrades to a no-op there (the body is
 *     already fully materialised by read()).
 *   DIVERGENCE(port, os.environ): `env = {**os.environ, **self._variables()}`
 *     reads the environment through SEAMS.environ() (a fresh snapshot of
 *     process.env). Merge order (environ keys first, the four OVOLVE_/
 *     PROJECT_/SESSION_ variables appended-or-overwritten at the end) is
 *     pinned by the ledger.
 *   DIVERGENCE(port, os.path): ntpath.join/splitroot are reimplemented
 *     faithfully (drive/root reset rules, the UNC separator fix) because the
 *     config path strings are observable; expanduser/isfile are seams (home
 *     dir + filesystem). expanduser's fake-able part is only the home lookup;
 *     the real implementation mirrors ntpath.expanduser's USERPROFILE/
 *     HOMEPATH logic.
 *   DIVERGENCE(port, json): json.dumps(..., ensure_ascii=False) and
 *     json.loads are reimplemented (pyJsonDumps/pyJsonLoads) to keep CPython's
 *     separators (", "/": "), key coercion (int/float/bool/None keys), the
 *     "Object of type X is not JSON serializable" / "keys must be str, int,
 *     float, bool or None, not X" TypeErrors, and the exact JSONDecodeError
 *     texts (including 3.13's "Illegal trailing comma ..."). Integers beyond
 *     2^53 lose precision (IEEE doubles) — unreachable from the pinned
 *     battery and the product's hook payloads.
 *   DIVERGENCE(port, number repr): integral values render int-style (house
 *     convention) EXCEPT values tagged PyFloat by pyJsonLoads (python's
 *     parse_float), which render float-style ("2.0") — that covers every
 *     observable path where python's int/float distinction is visible here
 *     (cfg timeoutMs int-check, additionalContext str()).
 *   NOTE: `Result` is imported (and re-exported) for module-surface parity —
 *   the source imports it without using it. `_stop_continues` and
 *   STOP_CONTINUE_LIMIT are equally dead in the source and are kept.
 */

import { Result } from "./result.js";
import { Event } from "./event_bus.js";
import { getEventBus as _realGetEventBus } from "./event_bus.js";
import { open_url as _realOpenUrl, OpenUrlOpts } from "./web_outbound.js";
import * as nodeFs from "node:fs";
import * as nodeCp from "node:child_process";

export { Result };

// ── error classes (python exception identities) ──────────────────────────────

export class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}
export class ValueErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ValueError"; }
}
export class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}
export class KeyErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "KeyError"; }
}
export class OverflowErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OverflowError"; }
}
/** python's OSError base — TimeoutError and HTTPError inherit from it. */
export class OSErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "OSError"; }
}
/** asyncio.TimeoutError IS builtin TimeoutError, an OSError subclass. */
export class TimeoutErrorP extends OSErrorP {
    constructor(msg = "") { super(msg); this.name = "TimeoutError"; }
}
/** urllib.error.HTTPError stand-in (URLError -> OSError chain). */
export class HTTPErrorP extends OSErrorP {
    code: unknown;
    constructor(code: unknown, msg = "") {
        super(msg);
        this.name = "HTTPError";
        this.code = code;
    }
}
export class JSONDecodeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "JSONDecodeError"; }
}
export class UnicodeDecodeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "UnicodeDecodeError"; }
}
/** re.PatternError (3.13's concrete name; re.error is its alias). */
export class PatternErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "PatternError"; }
}

// ── python-semantics helpers (house style: file-local) ───────────────────────

type JsonDict = Record<string, unknown>;

/** Tag for python floats parsed by pyJsonLoads: json "2.0" is a float where
 *  python's isinstance(x, int) is False but JS Number cannot tell. */
export class PyFloat {
    constructor(readonly n: number) {}
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (v instanceof PyFloat) return "float";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Set) return "set";
    if (v instanceof Map) return "dict";
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return "bytes";
    if (v instanceof RegExp) return "Pattern";
    if (typeof v === "function") return "function";
    if (v instanceof Error) return v.name;
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate: a value that IS a python dict — plain or prototype-less. */
function isPyDict(v: unknown): v is JsonDict {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (Buffer.isBuffer(v) || v instanceof Error || v instanceof PyFloat) return false;
    if (v instanceof RegExp || v instanceof Set || v instanceof Map) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (v instanceof PyFloat) return v.n !== 0 && !Number.isNaN(v.n);
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.length > 0;
    if (isPyDict(v)) return Object.keys(v).length > 0;
    return true;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

/** python `dict.get(key, default)` on any mapping-ish object. */
function pyGet(obj: unknown, key: string, defaultValue: unknown): unknown {
    if (obj === null || obj === undefined || !isPyDict(obj)) {
        throw new AttributeErrorP(
            `'${pyTypeName(obj)}' object has no attribute 'get'`);
    }
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : defaultValue;
}

/** python `obj[key]` — KeyError with python's quoted-message identity. */
function pyKeyGet(obj: unknown, key: string): unknown {
    if (obj === null || obj === undefined || !isPyDict(obj)) {
        throw new AttributeErrorP(
            `'${pyTypeName(obj)}' object has no attribute '__getitem__'`);
    }
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new KeyErrorP(`'${key}'`);
    }
    return obj[key];
}

/** python `getattr(obj, name, default)` — primitives yield the default. */
function pyGetattr(obj: unknown, name: string, defaultValue: unknown): unknown {
    if (obj === null || obj === undefined || typeof obj !== "object") return defaultValue;
    return name in (obj as object) ? (obj as Record<string, unknown>)[name] : defaultValue;
}

/** python `dict.setdefault(key, default)`. */
function pySetdefault(obj: JsonDict, key: string, defaultValue: unknown): unknown {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = defaultValue;
    return obj[key];
}

/** python `list.append` — a non-list raises python's AttributeError text. */
function pyAppend(target: unknown, value: unknown): void {
    if (Array.isArray(target)) { target.push(value); return; }
    throw new AttributeErrorP(
        `'${pyTypeName(target)}' object has no attribute 'append'`);
}

/** python `dict.items()` — non-dicts raise python's AttributeError text. */
function pyItems(v: unknown): [string, unknown][] {
    if (isPyDict(v)) return Object.entries(v) as [string, unknown][];
    throw new AttributeErrorP(
        `'${pyTypeName(v)}' object has no attribute 'items'`);
}

/** python iteration protocol for the shapes this module can meet. */
function pyIterate(v: unknown): unknown[] {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return Array.from(v);
    if (isPyDict(v)) return Object.keys(v);
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `len()` for the shapes this module can meet (strings BY CODE POINT). */
function pyLen(v: unknown): number {
    if (typeof v === "string") return Array.from(v).length;
    if (Array.isArray(v)) return v.length;
    if (isPyDict(v)) return Object.keys(v).length;
    if (v instanceof Set) return v.size;
    throw new TypeErrorP(`object of type '${pyTypeName(v)}' has no len()`);
}

/** python `int(x)` for the numeric shapes this module can meet. */
function pyIntCoerce(v: unknown): number {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof PyFloat) v = v.n;
    if (typeof v !== "number") {
        throw new TypeErrorP(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(v)}'`);
    }
    if (Number.isNaN(v)) throw new ValueErrorP("cannot convert float NaN to integer");
    if (!Number.isFinite(v)) throw new OverflowErrorP("cannot convert float infinity to integer");
    return Math.trunc(v);
}

/** python slice-index coercion (bools count as ints). */
function pyIndex(v: unknown): number {
    return pyIntCoerce(v);
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

/** CPython 3.13 reports the interval when defaults exist. */
function pyTooManyRange(fname: string, min: number, max: number, given: number): TypeErrorP {
    const noun = max === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${min} to ${max} ${noun} but ${given} ${verb} given`);
}

/** python `str.strip()` with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python float repr (repr(float)): shortest round-trip, fixed form for
 *  decimal exponents in [-4, 16), two-digit zero-padded exponents. */
function pyFloatRepr(x: number): string {
    if (Number.isNaN(x)) return "nan";
    if (x === Infinity) return "inf";
    if (x === -Infinity) return "-inf";
    if (x === 0) return 1 / x === Infinity ? "0.0" : "-0.0";
    const neg = x < 0;
    const ax = Math.abs(x);
    const s = String(ax);
    let digits: string;
    let exp10: number;
    const ei = s.indexOf("e");
    if (ei >= 0) {
        const mant = s.slice(0, ei).replace(".", "");
        digits = mant.replace(/0+$/, "") || "0";
        exp10 = parseInt(s.slice(ei + 1), 10);
    } else if (s.startsWith("0.")) {
        const frac = s.slice(2);
        const nz = frac.search(/[1-9]/);
        digits = frac.slice(nz);
        exp10 = -(nz + 1);
    } else {
        const dot = s.indexOf(".");
        const ip = dot >= 0 ? s.slice(0, dot) : s;
        const fp = dot >= 0 ? s.slice(dot + 1) : "";
        digits = ip + fp;
        exp10 = ip.length - 1;
    }
    let body: string;
    if (exp10 >= -4 && exp10 < 16) {
        if (exp10 >= 0) {
            if (digits.length > exp10 + 1) {
                body = digits.slice(0, exp10 + 1) + "." + digits.slice(exp10 + 1);
            } else {
                body = digits.padEnd(exp10 + 1, "0") + ".0";
            }
        } else {
            body = "0." + "0".repeat(-exp10 - 1) + digits;
        }
    } else {
        const head = digits.slice(0, 1);
        const rest = digits.slice(1);
        const sign = exp10 < 0 ? "-" : "+";
        body = head + (rest ? "." + rest : "") + "e" + sign +
            String(Math.abs(exp10)).padStart(2, "0");
    }
    return (neg ? "-" : "") + body;
}

/** python `str()` of a number: integral renders int-style (house convention;
 *  genuine floats arrive tagged as PyFloat or non-integral). */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
}

function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (v instanceof PyFloat) return pyFloatRepr(v.n);
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return pyBytesRepr(v);
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Set) return "{" + Array.from(v).map(pyRepr).join(", ") + "}";
    if (isPyDict(v)) {
        return "{" + Object.entries(v).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    return String(v);
}

/** CPython bytes repr (only needed for error/str surfaces on byte values). */
function pyBytesRepr(v: Uint8Array): string {
    let hasSquote = false;
    let hasDquote = false;
    for (let i = 0; i < v.length; i++) {
        if (v[i] === 0x27) hasSquote = true;
        else if (v[i] === 0x22) hasDquote = true;
    }
    const quote = hasSquote && !hasDquote ? 0x22 : 0x27;
    let out = "b" + String.fromCharCode(quote);
    for (let i = 0; i < v.length; i++) {
        const c = v[i] as number;
        if (c === quote || c === 0x5c) out += "\\" + String.fromCharCode(c);
        else if (c === 0x09) out += "\\t";
        else if (c === 0x0a) out += "\\n";
        else if (c === 0x0d) out += "\\r";
        else if (c < 0x20 || c >= 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
        else out += String.fromCharCode(c);
    }
    return out + String.fromCharCode(quote);
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    if (v instanceof Uint8Array) return pyBytesRepr(v);
    return pyStr(v);
}

/** python sorted() over strings: code-point order. */
function pyCmpStr(a: string, b: string): number {
    const A = Array.from(a);
    const B = Array.from(b);
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
        const ca = (A[i] as string).codePointAt(0) as number;
        const cb = (B[i] as string).codePointAt(0) as number;
        if (ca !== cb) return ca - cb;
    }
    return A.length - B.length;
}

function pySorted(items: string[]): string[] {
    return [...items].sort(pyCmpStr);
}

/** python `set - set` over string keys. */
function pySetDiff(keys: readonly string[], sub: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    for (const k of keys) if (!sub.has(k)) out.add(k);
    return out;
}

/** python set literal repr. python's order is hash-randomised for >1 element;
 *  the port emits code-point order (the probe pins single-element sets). */
function pySetRepr(s: ReadonlySet<unknown>): string {
    return "{" + pySorted(Array.from(s).map((x) => pyStr(x))).map((x) => pyRepr(x)).join(", ") + "}";
}

/** python `400 <= code < 500` — chained comparison with its TypeError text. */
function pyIn400Range(code: unknown): boolean {
    if (typeof code === "number" || typeof code === "boolean") {
        const n = typeof code === "boolean" ? (code ? 1 : 0) : code;
        return 400 <= n && n < 500;
    }
    throw new TypeErrorP(
        `'<=' not supported between instances of 'int' and '${pyTypeName(code)}'`);
}

// ── ntpath.join / splitroot (path strings are observable) ────────────────────

function pyPathSplitRoot(p: string): [string, string, string] {
    const normp = p.split("/").join("\\");
    if (normp.slice(0, 1) === "\\") {
        if (normp.slice(1, 2) === "\\") {
            const start = normp.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
            const index = normp.indexOf("\\", start);
            if (index === -1) return [p, "", ""];
            const index2 = normp.indexOf("\\", index + 1);
            if (index2 === -1) return [p, "", ""];
            return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
        }
        return ["", p.slice(0, 1), p.slice(1)];
    }
    if (normp.slice(1, 2) === ":") {
        if (normp.slice(2, 3) === "\\") return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
        return [p.slice(0, 2), "", p.slice(2)];
    }
    return ["", "", p];
}

/** ntpath.join — drive/root reset rules and the UNC separator fix, verbatim. */
function pyPathJoin(path: string, ...paths: string[]): string {
    const sep = "\\";
    for (const a of [path, ...paths]) {
        if (typeof a !== "string") {
            throw new TypeErrorP(
                `expected str, bytes or os.PathLike object, not ${pyTypeName(a)}`);
        }
    }
    let [resultDrive, resultRoot, resultPath] = pyPathSplitRoot(path);
    for (const p of paths) {
        const [pDrive, pRoot, pPath] = pyPathSplitRoot(p);
        if (pRoot) {
            if (pDrive || !resultDrive) resultDrive = pDrive;
            resultRoot = pRoot;
            resultPath = pPath;
            continue;
        } else if (pDrive && pDrive !== resultDrive) {
            if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) {
                resultDrive = pDrive;
                resultRoot = pRoot;
                resultPath = pPath;
                continue;
            }
            resultDrive = pDrive;
        }
        if (resultPath && !"\\/"?.includes(resultPath.slice(-1))) resultPath += sep;
        resultPath += pPath;
    }
    if (resultPath && !resultRoot && resultDrive &&
        !"\\/:?"?.includes(resultDrive.slice(-1))) {
        return resultDrive + sep + resultPath;
    }
    return resultDrive + resultRoot + resultPath;
}

// ── shlex.quote ──────────────────────────────────────────────────────────────

const _SHLEX_UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/;

/** shlex.quote: safe subset verbatim, else single-quote with '"'"' splicing. */
function pyShlexQuote(s: string): string {
    if (!pyTruth(s)) return "''";
    if (!_SHLEX_UNSAFE.test(s)) return s;
    return "'" + s.split("'").join("'\"'\"'") + "'";
}

// ── pyJsonLoads / pyJsonDumps (CPython json semantics) ───────────────────────

function jdErr(msg: string, s: string, pos: number): JSONDecodeErrorP {
    let lines = 0;
    for (let i = 0; i < pos && i < s.length; i++) if (s[i] === "\n") lines++;
    const rfind = s.lastIndexOf("\n", pos - 1);
    const colno = pos - rfind;
    return new JSONDecodeErrorP(`${msg}: line ${lines + 1} column ${colno} (char ${pos})`);
}

const _JSON_WS = " \t\n\r";

function pyJsonLoads(text: string): unknown {
    let i = 0;
    const skipWs = () => { while (i < text.length && _JSON_WS.includes(text.charAt(i))) i++; };
    const parseString = (): string => {
        // opening quote at i
        const start = i;
        i++;
        let out = "";
        for (;;) {
            if (i >= text.length) throw jdErr("Unterminated string starting at", text, start);
            const c = text.charAt(i);
            if (c === '"') { i++; return out; }
            if (c === "\\") {
                const escPos = i;
                i++;
                if (i >= text.length) throw jdErr("Unterminated string starting at", text, start);
                const e = text.charAt(i);
                if (e === '"') { out += '"'; i++; }
                else if (e === "\\") { out += "\\"; i++; }
                else if (e === "/") { out += "/"; i++; }
                else if (e === "b") { out += "\b"; i++; }
                else if (e === "f") { out += "\f"; i++; }
                else if (e === "n") { out += "\n"; i++; }
                else if (e === "r") { out += "\r"; i++; }
                else if (e === "t") { out += "\t"; i++; }
                else if (e === "u") {
                    let hex = "";
                    for (let k = 0; k < 4; k++) {
                        i++;
                        const h = i < text.length ? text.charAt(i) : "";
                        if (!/^[0-9a-fA-F]$/.test(h)) {
                            throw jdErr("Invalid \\escape", text, escPos);
                        }
                        hex += h;
                    }
                    i++;
                    let code = parseInt(hex, 16);
                    // combine a UTF-16 surrogate pair like CPython's scanner
                    if (code >= 0xd800 && code <= 0xdbff && text.charAt(i) === "\\" &&
                        text.charAt(i + 1) === "u") {
                        let hex2 = "";
                        let ok = true;
                        for (let k = 0; k < 4; k++) {
                            const h = text.charAt(i + 2 + k);
                            if (!/^[0-9a-fA-F]$/.test(h)) { ok = false; break; }
                            hex2 += h;
                        }
                        const lo = ok ? parseInt(hex2, 16) : -1;
                        if (lo >= 0xdc00 && lo <= 0xdfff) {
                            i += 6;
                            code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
                            out += String.fromCodePoint(code);
                            continue;
                        }
                    }
                    out += String.fromCharCode(code);
                } else {
                    throw jdErr("Invalid \\escape", text, escPos);
                }
                continue;
            }
            const cp = text.codePointAt(i) as number;
            if (cp <= 0x1f) throw jdErr("Invalid control character at", text, i);
            out += String.fromCodePoint(cp);
            i += cp > 0xffff ? 2 : 1;
        }
    };
    const parseNumber = (): unknown => {
        const start = i;
        if (text.charAt(i) === "-") i++;
        if (text.charAt(i) === "0") {
            i++;
        } else if (/^[1-9]$/.test(text.charAt(i) || "")) {
            while (i < text.length && /^[0-9]$/.test(text.charAt(i))) i++;
        } else {
            throw jdErr("Expecting value", text, start);
        }
        let isFloat = false;
        if (text.charAt(i) === "." && /^[0-9]$/.test(text.charAt(i + 1) || "")) {
            isFloat = true;
            i++;
            while (i < text.length && /^[0-9]$/.test(text.charAt(i))) i++;
        }
        if ((text.charAt(i) === "e" || text.charAt(i) === "E")) {
            let j = i + 1;
            if (text.charAt(j) === "+" || text.charAt(j) === "-") j++;
            if (/^[0-9]$/.test(text.charAt(j) || "")) {
                isFloat = true;
                i = j;
                while (i < text.length && /^[0-9]$/.test(text.charAt(i))) i++;
            }
        }
        const lexeme = text.slice(start, i);
        if (!isFloat) {
            const n = Number(lexeme);
            return Number.isSafeInteger(n) ? n : n;   // int (precision loss >2^53 documented)
        }
        const f = Number(lexeme);
        if (Number.isInteger(f) && Number.isFinite(f)) return new PyFloat(f);
        return f;
    };
    const parseValue = (): unknown => {
        skipWs();
        if (i >= text.length) throw jdErr("Expecting value", text, i);
        const c = text.charAt(i);
        if (c === "{") {
            i++;
            const obj: JsonDict = {};
            skipWs();
            if (text.charAt(i) === "}") { i++; return obj; }
            for (;;) {
                skipWs();
                if (text.charAt(i) !== '"') {
                    throw jdErr("Expecting property name enclosed in double quotes", text, i);
                }
                const key = parseString();
                skipWs();
                if (text.charAt(i) !== ":") throw jdErr("Expecting ':' delimiter", text, i);
                i++;
                obj[key] = parseValue();
                skipWs();
                const d = text.charAt(i);
                if (d === ",") {
                    i++;
                    skipWs();
                    if (text.charAt(i) === "}") {
                        throw jdErr("Illegal trailing comma before end of object", text, i);
                    }
                    continue;
                }
                if (d === "}") { i++; return obj; }
                throw jdErr("Expecting ',' delimiter", text, i);
            }
        }
        if (c === "[") {
            i++;
            const arr: unknown[] = [];
            skipWs();
            if (text.charAt(i) === "]") { i++; return arr; }
            for (;;) {
                arr.push(parseValue());
                skipWs();
                const d = text.charAt(i);
                if (d === ",") {
                    i++;
                    skipWs();
                    if (text.charAt(i) === "]") {
                        throw jdErr("Illegal trailing comma before end of array", text, i);
                    }
                    continue;
                }
                if (d === "]") { i++; return arr; }
                throw jdErr("Expecting ',' delimiter", text, i);
            }
        }
        if (c === '"') return parseString();
        if (text.startsWith("NaN", i)) { i += 3; return Number.NaN; }
        if (text.startsWith("Infinity", i)) { i += 8; return Infinity; }
        if (c === "-" && text.startsWith("-Infinity", i)) { i += 9; return -Infinity; }
        if (text.startsWith("true", i)) { i += 4; return true; }
        if (text.startsWith("false", i)) { i += 5; return false; }
        if (text.startsWith("null", i)) { i += 4; return null; }
        if (c === "-" || /^[0-9]$/.test(c)) return parseNumber();
        throw jdErr("Expecting value", text, i);
    };
    const v = parseValue();
    skipWs();
    if (i < text.length) throw jdErr("Extra data", text, i);
    return v;
}

const _JSON_ESCAPES: Record<string, string> = {
    '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f",
    "\n": "\\n", "\r": "\\r", "\t": "\\t",
};

function pyJsonDumpString(s: string): string {
    let out = '"';
    for (const ch of s) {
        const esc = _JSON_ESCAPES[ch];
        if (esc !== undefined) out += esc;
        else if (ch.codePointAt(0)! < 0x20) {
            out += "\\u" + ch.codePointAt(0)!.toString(16).padStart(4, "0");
        } else out += ch;
    }
    return out + '"';
}

function pyJsonDumpFloat(v: number): string {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return pyFloatRepr(v);
}

function pyJsonDumpKey(k: unknown): string {
    if (typeof k === "string") return pyJsonDumpString(k);
    if (typeof k === "boolean") return k ? "true" : "false";
    if (k === null || k === undefined) return "null";
    if (k instanceof PyFloat) return pyJsonDumpFloat(k.n);
    if (typeof k === "number") return Number.isInteger(k) ? String(k) : pyJsonDumpFloat(k);
    throw new TypeErrorP(`keys must be str, int, float, bool or None, not ${pyTypeName(k)}`);
}

function pyJsonDumpValue(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v instanceof PyFloat) return pyJsonDumpFloat(v.n);
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyJsonDumpFloat(v);
    if (typeof v === "string") return pyJsonDumpString(v);
    if (Array.isArray(v)) return "[" + v.map(pyJsonDumpValue).join(", ") + "]";
    if (v instanceof Map) {
        // dict stand-in for non-string keys (python coerces int/float/bool/None)
        return "{" + Array.from(v.entries()).map(([k, x]) => pyJsonDumpKey(k) + ": " + pyJsonDumpValue(x)).join(", ") + "}";
    }
    if (isPyDict(v)) {
        return "{" + Object.entries(v).map(([k, x]) => pyJsonDumpKey(k) + ": " + pyJsonDumpValue(x)).join(", ") + "}";
    }
    if (v instanceof Set) throw new TypeErrorP("Object of type set is not JSON serializable");
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
        throw new TypeErrorP("Object of type bytes is not JSON serializable");
    }
    throw new TypeErrorP(`Object of type ${pyTypeName(v)} is not JSON serializable`);
}

/** python json.dumps(v, ensure_ascii=False) — ", "/": " separators included. */
function pyJsonDumps(v: unknown): string {
    return pyJsonDumpValue(v);
}

// ── re.compile(str(matcher)) — sre validation + JS translation ───────────────

const _PY_WORD = "[\\p{L}\\p{N}_]";
const _PY_SPACE = "[\\s\\x1c-\\x1f\\x85]";

interface PyPattern {
    search(value: unknown): boolean;
}

function reErr(msg: string, pos: number): PatternErrorP {
    return new PatternErrorP(`${msg} at position ${pos}`);
}

function pyIsIdentifier(name: string): boolean {
    return /^[\p{L}_\p{Nl}][\p{L}\p{N}_\p{Nl}]*$/u.test(name);
}

const _HEX = /^[0-9a-fA-F]$/;
const _OCT = /^[0-7]$/;
const _DIG = /^[0-9]$/;

/** re.compile(pattern): validates with CPython 3.13 sre error texts/positions
 *  and translates the pinned dialect to a JS RegExp (u flag). */
function pyReCompile(pattern: string): PyPattern {
    let out = "";
    let flags = "";
    let verbose = false;
    let i = 0;
    const groupStack: { pos: number }[] = [];
    const groupNames = new Map<string, number>();
    let groupCount = 0;
    let sawAtom = false;         // any non-global-flag token emitted
    let quantifiable = false;    // previous token can take a quantifier
    let justQuantified = false;  // previous token WAS a quantifier
    const s = pattern;
    const len = s.length;

    const emit = (t: string) => { out += t; };
    const setQuantifiable = () => { quantifiable = true; justQuantified = false; sawAtom = true; };

    const classEscape = (n: string): string => {
        switch (n) {
            case "d": return "[\\p{Nd}]";
            case "D": return "[^\\p{Nd}]";
            case "w": return `[${_PY_WORD}]`;
            case "W": return `[^${_PY_WORD}]`;
            case "s": return _PY_SPACE;
            case "S": return `[^${_PY_SPACE.slice(1, -1)}]`;
            default: return "";
        }
    };

    // ── character-class scanner (self-contained; classes are atoms) ─────────
    // Parses one class starting at "[" (i points at it). Returns the new index.
    const scanClass = (): void => {
        const clsStart = i;
        let neg = false;
        emit("[");
        i++;
        if (s.charAt(i) === "^") { neg = true; emit("^"); i++; }
        if (s.charAt(i) === "]") { emit("\\]"); i++; }
        const parseItem = (): { start: number; end: number; cp: number | null; cls: string | null } => {
            const start = i;
            if (s.charAt(i) !== "\\") {
                const cp = s.codePointAt(i) as number;
                i += cp > 0xffff ? 2 : 1;
                return { start, end: i - 1, cp, cls: null };
            }
            if (i + 1 >= len) throw reErr("bad escape (end of pattern)", i);
            const n = s.charAt(i + 1);
            if (_DIG.test(n)) {
                let j = i + 1;
                let oct = "";
                while (j < len && _OCT.test(s.charAt(j)) && oct.length < 3) { oct += s.charAt(j); j++; }
                const cp = parseInt(oct, 8);
                i = j;
                return { start, end: i - 1, cp, cls: null };
            }
            if (n === "d" || n === "D" || n === "w" || n === "W" || n === "s" || n === "S") {
                i += 2;
                return { start, end: i - 1, cp: null, cls: classEscape(n) };
            }
            if (n === "x") {
                const h1 = s.charAt(i + 2), h2 = s.charAt(i + 3);
                if (!_HEX.test(h1) || !_HEX.test(h2)) throw reErr("incomplete escape \\x", start);
                i += 4;
                return { start, end: i - 1, cp: parseInt(h1 + h2, 16), cls: null };
            }
            if (n === "u") {
                let hex = "";
                for (let k = 0; k < 4; k++) {
                    const h = s.charAt(i + 2 + k);
                    if (!_HEX.test(h)) throw reErr("incomplete escape \\u", start);
                    hex += h;
                }
                i += 6;
                return { start, end: i - 1, cp: parseInt(hex, 16), cls: null };
            }
            if (n === "b") { i += 2; return { start, end: i - 1, cp: 8, cls: null }; }
            if (n === "a") { i += 2; return { start, end: i - 1, cp: 7, cls: null }; }
            if (/[A-Za-z]/.test(n)) throw reErr(`bad escape \\${n}`, start);
            i += 2;
            return { start, end: i - 1, cp: n.codePointAt(0) as number, cls: null };
        };
        const emitItem = (it: { start: number; end: number; cp: number | null; cls: string | null }): void => {
            if (it.cls !== null) { emit(it.cls); return; }
            const ch = String.fromCodePoint(it.cp as number);
            if ("\\]^-".includes(ch)) emit("\\" + ch);
            else emit(ch);
        };
        for (;;) {
            if (i >= len) throw reErr("unterminated character set", clsStart);
            if (s.charAt(i) === "]") { i++; break; }
            const lo = parseItem();
            if (s.charAt(i) === "-" && i + 1 < len && s.charAt(i + 1) !== "]") {
                i++;                                   // consume '-'
                const hi = parseItem();
                if (lo.cp === null || hi.cp === null || (lo.cp as number) > (hi.cp as number)) {
                    throw reErr(`bad character range ${s.slice(lo.start, hi.end + 1)}`, lo.start);
                }
                emit(s.slice(lo.start, hi.end + 1));
                continue;
            }
            emitItem(lo);
        }
        emit("]");
        setQuantifiable();
        void neg;
    };

    while (i < len) {
        if (verbose) {
            const c0 = s[i];
            if (c0 === " " || c0 === "\t" || c0 === "\n" || c0 === "\r" || c0 === "\f" || c0 === "\v") { i++; continue; }
            if (c0 === "#") {
                while (i < len && s[i] !== "\n") i++;
                continue;
            }
        }
        const c = s.charAt(i);
        if (c === "\\") {
            if (i + 1 >= len) throw reErr("bad escape (end of pattern)", i);
            const n = s.charAt(i + 1);
            if (_DIG.test(n)) {
                if (n === "0") {
                    let j = i + 2;
                    let oct = "";
                    while (j < len && _OCT.test(s.charAt(j)) && oct.length < 2) { oct += s.charAt(j); j++; }
                    emit("\\x" + parseInt("0" + oct, 8).toString(16).padStart(2, "0"));
                    i = j;
                    setQuantifiable();
                    continue;
                }
                let j = i + 1;
                let num = "";
                while (j < len && _DIG.test(s.charAt(j)) && num.length < 2) { num += s.charAt(j); j++; }
                const ref = parseInt(num, 10);
                if (ref >= 1 && ref <= groupCount) {
                    emit("\\" + ref);
                    i = j;
                    setQuantifiable();
                    continue;
                }
                throw reErr(`invalid group reference ${ref}`, i + 1);
            }
            switch (n) {
                case "b":
                    emit(`(?:(?<=[${_PY_WORD}])(?![${_PY_WORD}])|(?<![${_PY_WORD}])(?=[${_PY_WORD}]))`);
                    i += 2;
                    setQuantifiable();
                    continue;
                case "B":
                    emit(`(?:(?<=[${_PY_WORD}])(?=[${_PY_WORD}])|(?<![${_PY_WORD}])(?![${_PY_WORD}]))`);
                    i += 2;
                    setQuantifiable();
                    continue;
                case "A":
                    // absolute start; under the m flag JS "^" would be multiline
                    // (dialect boundary — the battery never combines them)
                    emit("^");
                    i += 2;
                    setQuantifiable();
                    continue;
                case "Z":
                    emit("(?![\\s\\S])");
                    i += 2;
                    setQuantifiable();
                    continue;
                case "d": case "D": case "w": case "W": case "s": case "S":
                    emit(classEscape(n));
                    i += 2;
                    setQuantifiable();
                    continue;
                case "x": {
                    const h1 = s.charAt(i + 2), h2 = s.charAt(i + 3);
                    if (!_HEX.test(h1) || !_HEX.test(h2)) throw reErr("incomplete escape \\x", i);
                    emit("\\x" + h1 + h2);
                    i += 4;
                    setQuantifiable();
                    continue;
                }
                case "u": {
                    let hex = "";
                    for (let k = 0; k < 4; k++) {
                        const h = s.charAt(i + 2 + k);
                        if (!_HEX.test(h)) throw reErr("incomplete escape \\u", i);
                        hex += h;
                    }
                    emit("\\u" + hex);
                    i += 6;
                    setQuantifiable();
                    continue;
                }
                case "g": {
                    if (s.charAt(i + 2) !== "<") throw reErr("bad escape \\g", i);
                    const close = s.indexOf(">", i + 3);
                    if (close < 0) throw reErr("missing >, unterminated name", i + 3);
                    const ref = s.slice(i + 3, close);
                    if (_DIG.test(ref.charAt(0))) {
                        const num = parseInt(ref, 10);
                        if (!(num >= 1 && num <= groupCount)) {
                            throw reErr(`invalid group reference ${num}`, i + 3);
                        }
                        emit("\\" + num);
                    } else {
                        if (!groupNames.has(ref)) throw reErr(`unknown group name '${ref}'`, i + 3);
                        emit("\\k<" + ref + ">");
                    }
                    i = close + 1;
                    setQuantifiable();
                    continue;
                }
                default:
                    if (/[A-Za-z]/.test(n)) throw reErr(`bad escape \\${n}`, i);
                    emit("\\" + n);
                    i += 2;
                    setQuantifiable();
                    continue;
            }
        }
        if (c === "[") {
            scanClass();
            continue;
        }
        if (c === "(") {
            quantifiable = false;
            justQuantified = false;
            if (s.charAt(i + 1) === "?") {
                const parenPos = i;
                const qPos = i + 1;
                const e = s.charAt(i + 2);
                if (e === "") throw reErr("unexpected end of pattern", i + 2);
                if (e === "P") {
                    const after = s.charAt(i + 3);
                    if (after === "") throw reErr("unexpected end of pattern", i + 3);
                    if (after === "<") {
                        const nameStart = i + 4;
                        let j = nameStart;
                        while (j < len && s.charAt(j) !== ">") j++;
                        const name = s.slice(nameStart, j);
                        if (j >= len) {
                            throw reErr(name === "" ? "missing group name" : "missing >, unterminated name", nameStart);
                        }
                        if (name === "") throw reErr("missing group name", nameStart);
                        if (!pyIsIdentifier(name)) {
                            throw reErr(`bad character in group name '${name}'`, nameStart);
                        }
                        if (groupNames.has(name)) {
                            throw reErr(
                                `redefinition of group name '${name}' as group ${groupCount + 1}; was group ${groupNames.get(name)}`,
                                nameStart);
                        }
                        groupCount += 1;
                        groupNames.set(name, groupCount);
                        groupStack.push({ pos: parenPos });
                        emit(`(?<${name}>`);
                        i = j + 1;
                        continue;
                    }
                    if (after === "=") {
                        const nameStart = i + 4;
                        let j = nameStart;
                        while (j < len && s.charAt(j) !== ")") j++;
                        const name = s.slice(nameStart, j);
                        if (!groupNames.has(name)) {
                            throw reErr(`unknown group name '${name}'`, nameStart);
                        }
                        emit(`\\k<${name}>`);
                        i = j + 1;
                        setQuantifiable();
                        continue;
                    }
                    throw reErr(`unknown extension ?P${after}`, qPos);
                }
                if (e === "=" || e === "!") {
                    groupStack.push({ pos: parenPos });
                    emit("(?" + e);
                    i += 3;
                    continue;
                }
                if (e === "<") {
                    const n2 = s.charAt(i + 3);
                    if (n2 !== "=" && n2 !== "!") throw reErr("unknown extension ?<", qPos);
                    groupStack.push({ pos: parenPos });
                    emit("(?<" + n2);
                    i += 4;
                    continue;
                }
                if (e === ":") {
                    groupStack.push({ pos: parenPos });
                    emit("(?:");
                    i += 3;
                    continue;
                }
                if (e === "#") {
                    let j = i + 3;
                    while (j < len && s.charAt(j) !== ")") j++;
                    if (j >= len) throw reErr("missing ), unterminated comment", parenPos);
                    i = j + 1;
                    continue;
                }
                if (/[a-zA-Z]/.test(e) && !"aiLmsxu".includes(e)) {
                    // a letter outside the flag alphabet is not a flag group
                    throw reErr(`unknown extension ?${e}`, qPos);
                }
                if (/[a-zA-Z]/.test(e) || e === "-") {
                    // flag group
                    let j = i + 2;
                    let fl = "";
                    let neg2 = false;
                    while (j < len && /[a-zA-Z]/.test(s.charAt(j))) { fl += s.charAt(j); j++; }
                    if (s.charAt(j) === "-") {
                        neg2 = true;
                        j++;
                        while (j < len && /[a-zA-Z]/.test(s.charAt(j))) { fl += s.charAt(j); j++; }
                    }
                    if (j >= len) {
                        throw reErr(neg2 ? "missing :" : "missing -, : or )", j);
                    }
                    if (fl.includes("L")) {
                        throw reErr("bad inline flags: cannot use 'L' flag with a str pattern", j);
                    }
                    if (s.charAt(j) === ")") {
                        if (neg2) throw reErr("missing :", j);
                        if (sawAtom) throw reErr("global flags not at the start of the expression", parenPos);
                        for (const f of fl) {
                            if (f === "i" && !flags.includes("i")) flags += "i";
                            else if (f === "m" && !flags.includes("m")) flags += "m";
                            else if (f === "s" && !flags.includes("s")) flags += "s";
                            else if (f === "x") verbose = true;
                            // u/a are no-ops for a str pattern in this dialect
                        }
                        i = j + 1;
                        continue;
                    }
                    if (s.charAt(j) === ":") {
                        // scoped flags — dialect: emit (?: and drop the scope
                        groupStack.push({ pos: parenPos });
                        emit("(?:");
                        i = j + 1;
                        continue;
                    }
                    throw reErr("missing -, : or )", j);
                }
                throw reErr(`unknown extension ?${e}`, qPos);
            }
            groupCount += 1;
            groupStack.push({ pos: i });
            emit("(");
            i++;
            continue;
        }
        if (c === ")") {
            if (groupStack.length === 0) throw reErr("unbalanced parenthesis", i);
            groupStack.pop();
            emit(")");
            i++;
            setQuantifiable();
            continue;
        }
        if (c === "|") {
            emit("|");
            i++;
            quantifiable = false;
            justQuantified = false;
            continue;
        }
        if (c === "*" || c === "+" || c === "?") {
            if (!quantifiable) throw reErr("nothing to repeat", i);
            if (justQuantified) throw reErr("multiple repeat", i);
            emit(c);
            i++;
            if (s.charAt(i) === "?") { emit("?"); i++; }   // non-greedy marker
            justQuantified = true;
            continue;
        }
        if (c === "{") {
            const m = /^\{(\d*)(,(\d*)?)?\}/.exec(s.slice(i));
            if (m) {
                if (!quantifiable) throw reErr("nothing to repeat", i);
                if (justQuantified) throw reErr("multiple repeat", i);
                const minS = m[1] ?? "";
                const hasComma = m[2] !== undefined;
                const maxS = m[3];
                const min = minS === "" ? 0 : parseInt(minS, 10);
                let max: number;
                let maxText: string;
                if (!hasComma) { max = min; maxText = minS; }
                else if (maxS === undefined || maxS === "") { max = Infinity; maxText = ""; }
                else { max = parseInt(maxS, 10); maxText = maxS; }
                if (max !== Infinity && min > max) {
                    throw reErr("min repeat greater than max repeat", i + 1);
                }
                emit("{" + (minS === "" ? "0" : minS) + (hasComma ? "," + maxText : "") + "}");
                i += m[0].length;
                if (s.charAt(i) === "?") { emit("?"); i++; }
                justQuantified = true;
                continue;
            }
            emit("\\{");
            i++;
            setQuantifiable();
            continue;
        }
        if (c === "}") { emit("\\}"); i++; setQuantifiable(); continue; }
        if (c === "]") { emit("\\]"); i++; setQuantifiable(); continue; }
        if (c === "^") { emit("^"); i++; setQuantifiable(); continue; }
        if (c === "$") {
            // python: end of string, or just before a FINAL newline
            emit(flags.includes("m") ? "$" : "(?=\\n?$)");
            i++;
            setQuantifiable();
            continue;
        }
        if (c === ".") {
            // python's dot excludes ONLY \n (DOTALL makes it match everything)
            emit(flags.includes("s") ? "[\\s\\S]" : "[^\\n]");
            i++;
            setQuantifiable();
            continue;
        }
        emit(c);
        i++;
        setQuantifiable();
    }
    if (groupStack.length > 0) {
        const open = groupStack[groupStack.length - 1] as { pos: number };
        throw reErr("missing ), unterminated subpattern", open.pos);
    }
    let re: RegExp;
    try {
        re = new RegExp(out, flags + "u");
    } catch {
        re = new RegExp(out, flags);   // dialect boundary: let JS speak
    }
    return {
        search(value: unknown): boolean {
            if (typeof value !== "string") {
                throw new TypeErrorP(
                    `expected string or bytes-like object, got '${pyTypeName(value)}'`);
            }
            return re.test(value);
        },
    };
}

// ── module constants ─────────────────────────────────────────────────────────

export const HOOK_EVENTS: readonly string[] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
];

export const BUS_TO_HOOK: Record<string, readonly string[]> = {
    session_start: ["SessionStart"],
    user_prompt_submit: ["UserPromptSubmit"],
    pre_tool_use: ["PreToolUse"],
    permission_request: ["PermissionRequest"],
    tool_result: ["PostToolUse", "PostToolUseFailure"],
    session_before_compact: ["PreCompact"],
    context_folded: ["PostCompact"],
    subagent_state: ["SubagentStart", "SubagentStop"],
    output: ["Stop"],
};

export const SUBAGENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    "completed", "error", "killed", "timeout", "stale",
    "spawn_error", "lost", "orphan_recovered",
]);

export const SUBAGENT_START_STATUSES: ReadonlySet<string> = new Set(["spawning"]);

export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_MAX_OUTPUT = 64 * 1024;
export const STOP_CONTINUE_LIMIT = 3;

export const HTTP_HOOK_FIELDS: ReadonlySet<string> = new Set([
    "type", "url", "method", "headers", "body", "timeoutMs", "statusMessage",
]);
export const HTTP_METHODS: ReadonlySet<string> = new Set([
    "GET", "POST", "PUT", "PATCH", "DELETE",
]);

export const ALLOWED_OUTPUT_KEYS: ReadonlySet<string> = new Set([
    "additionalContext",
    "permissionDecision",
    "permissionDecisionReason",
    "continue",
    "stopReason",
    "systemMessage",
]);
export const VALID_DECISIONS: readonly string[] = ["allow", "ask", "deny"];

// ── 测试缝（子进程 / 环境 / 文件 / 网络 / 事件总线 / 时钟） ──────────────────

/** python `asyncio.create_subprocess_exec/shell` 返回的进程面。 */
export interface HookProc {
    communicate(stdinData: Uint8Array): Promise<[Uint8Array, Uint8Array]>;
    kill(): void;
    wait(): Promise<unknown>;
    returncode: unknown;
}

interface SpawnOpts {
    stdin: number;
    stdout: number;
    stderr: number;
    env: Record<string, string>;
    cwd: unknown;
}

function makeNodeProc(child: import("node:child_process").ChildProcess): HookProc {
    let stdout: Buffer[] = [];
    let stderr: Buffer[] = [];
    let exitCode: unknown = null;
    let exited = false;
    const waiters: (() => void)[] = [];
    child.stdout?.on("data", (d: Buffer) => stdout.push(d));
    child.stderr?.on("data", (d: Buffer) => stderr.push(d));
    child.on("exit", (code) => { exited = true; exitCode = code; for (const w of waiters) w(); });
    child.on("error", () => { exited = true; exitCode = null; for (const w of waiters) w(); });
    const done = () => new Promise<void>((res) => (exited ? res() : waiters.push(res)));
    return {
        returncode: null,
        async communicate(stdinData) {
            if (stdinData.length > 0) child.stdin?.write(Buffer.from(stdinData));
            child.stdin?.end();
            await done();
            (this as HookProc).returncode = exitCode;
            return [Buffer.concat(stdout), Buffer.concat(stderr)];
        },
        kill() { child.kill(); },
        async wait() { await done(); return this.returncode; },
    };
}

export const HOOK_RUNNER_SEAMS = {
    /** python `time.time()` — 浮点秒。 */
    now: (): number => Date.now() / 1000,
    /** python `os.getcwd()`。 */
    getcwd: (): string => process.cwd(),
    /** python `os.environ`（只读快照，键序即合并序）。 */
    environ: (): Record<string, string> => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === "string") env[k] = v;
        }
        return env;
    },
    /** python `os.path.expanduser`（home 查找是唯一宿主触点）。 */
    expanduser: (p: string): string => {
        if (!p.startsWith("~")) return p;
        let i = 1;
        while (i < p.length && p[i] !== "\\" && p[i] !== "/") i++;
        const env = HOOK_RUNNER_SEAMS.environ();
        let userhome: string | null = null;
        if ("USERPROFILE" in env) userhome = env["USERPROFILE"] ?? null;
        else if (!("HOMEPATH" in env)) return p;
        else {
            const drive = env["HOMEDRIVE"] ?? "";
            userhome = pyPathJoin(drive, env["HOMEPATH"] ?? "");
        }
        if (userhome === null) return p;
        if (i !== 1) {
            const targetUser = p.slice(1, i);
            const current = env["USERNAME"] ?? null;
            if (targetUser !== current) return p;
        }
        return userhome + p.slice(i);
    },
    /** python `os.path.isfile`。 */
    isfile: (p: unknown): boolean => {
        try {
            if (typeof p !== "string") return false;
            return nodeFs.statSync(p).isFile();
        } catch {
            return false;
        }
    },
    /** python `open(path, "r", encoding="utf-8")` 的 read()：utf-8 fatal +
     *  universal newlines（\r\n/\r -> \n，BOM 保留为 U+FEFF）。 */
    readConfig: (p: string): string => {
        const bytes = nodeFs.readFileSync(p);
        const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        const text = dec.decode(bytes);
        return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    },
    /** python `asyncio.create_subprocess_exec(argv[0], *argv[1:], **opts)`。 */
    createSubprocessExec: async (argv: string[], opts: SpawnOpts): Promise<HookProc> =>
        makeNodeProc(nodeCp.spawn(argv[0] as string, argv.slice(1), {
            env: opts.env,
            cwd: typeof opts.cwd === "string" ? opts.cwd : undefined,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
        })),
    /** python `asyncio.create_subprocess_shell(cmd, **opts)`。 */
    createSubprocessShell: async (argv: string[], opts: SpawnOpts): Promise<HookProc> =>
        makeNodeProc(nodeCp.spawn(argv[0] as string, {
            env: opts.env,
            cwd: typeof opts.cwd === "string" ? opts.cwd : undefined,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
        })),
    /** python `asyncio.wait_for(aw, timeout=...)` — 超时即拒 TimeoutError。 */
    waitFor: async <T,>(p: Promise<T>, timeout: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                p,
                new Promise<never>((_res, rej) => {
                    timer = setTimeout(() => rej(new TimeoutErrorP()), timeout * 1000);
                }),
            ]) as T;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    },
    /** python `asyncio.to_thread(fn, *args, **kwargs)`。 */
    toThread: async (_fnName: string, url: unknown,
        opts: { timeout: unknown; headers: JsonDict; data: unknown; method: string }): Promise<unknown> =>
        HOOK_RUNNER_SEAMS.openUrl(url, opts),
    /** python `web_outbound.open_url(url, timeout=..., headers=..., data=...,
     *  method=...)` — 走已落地的 web_outbound.ts。 */
    openUrl: (url: unknown, opts: { timeout: unknown; headers: JsonDict; data: unknown; method: string }): Promise<unknown> =>
        _realOpenUrl(url, opts as OpenUrlOpts),
    /** python `event_bus.get_event_bus()`（mount 的晚绑定目标）。 */
    getEventBus: (): unknown => _realGetEventBus(),
};

/** python `asyncio.subprocess.PIPE`。 */
export const SUBPROCESS_PIPE = -1;

// ── HookOutcome ──────────────────────────────────────────────────────────────

export class HookOutcome {
    status: unknown;
    decision: unknown;
    reason: unknown;
    context: unknown;
    continue_: unknown;
    duration_ms: unknown;

    constructor(status?: unknown, decision?: unknown, reason?: unknown,
        context?: unknown, continue_?: unknown, duration_ms?: unknown) {
        const given = arguments.length;
        if (given === 0) throw pyMissing("HookOutcome.__init__", ["status"]);
        if (given > 7) {
            throw pyTooManyRange("HookOutcome.__init__", 2, 7, given + 1);
        }
        // house convention: a dataclass default fires on === undefined (python
        // omitted keyword), an explicit null is stored as None.
        this.status = status;
        this.decision = decision === undefined ? "" : decision;
        this.reason = reason === undefined ? "" : reason;
        this.context = context === undefined ? "" : context;
        this.continue_ = continue_ === undefined ? false : continue_;
        this.duration_ms = duration_ms === undefined ? 0 : duration_ms;
    }

    to_dict(): JsonDict {
        return {
            status: this.status,
            decision: this.decision,
            reason: this.reason,
            context: this.context,
            continue: this.continue_,
            durationMs: this.duration_ms,
        };
    }
}

// ── HookRunner ───────────────────────────────────────────────────────────────

export class HookRunner {
    project_dir: unknown;
    session_id: unknown;
    enabled = false;
    timeout_ms: unknown = DEFAULT_TIMEOUT_MS;
    max_output: unknown = DEFAULT_MAX_OUTPUT;
    matchers: Record<string, JsonDict[]> = {};
    log: JsonDict[] = [];
    problems: string[] = [];
    _stop_continues = 0;

    constructor(project_dir?: unknown, session_id?: unknown) {
        const given = arguments.length;
        if (given > 2) throw pyTooManyRange("HookRunner.__init__", 1, 3, given + 1);
        const pd = given >= 1 ? project_dir : null;
        const sid = given >= 2 ? session_id : "";
        // python `project_dir or os.getcwd()` — getcwd only when falsy
        this.project_dir = pyTruth(pd) ? pd : HOOK_RUNNER_SEAMS.getcwd();
        this.session_id = sid;
        this.enabled = false;
        this.timeout_ms = DEFAULT_TIMEOUT_MS;
        this.max_output = DEFAULT_MAX_OUTPUT;
        const m: Record<string, JsonDict[]> = {};
        for (const e of HOOK_EVENTS) m[e] = [];
        this.matchers = m;
        this.log = [];
        this.problems = [];
        this._stop_continues = 0;
    }

    // ── config loading ───────────────────────────────────────────────────────

    config_paths(): string[] {
        return [
            pyPathJoin(this.project_dir as string, ".agents", "hooks.json"),
            HOOK_RUNNER_SEAMS.expanduser(pyPathJoin("~", ".agents", "hooks.json")),
        ];
    }

    load(paths?: unknown): JsonDict {
        const usePaths = paths !== null && paths !== undefined
            ? paths
            : this.config_paths();
        const m: Record<string, JsonDict[]> = {};
        for (const e of HOOK_EVENTS) m[e] = [];
        this.matchers = m;
        this.problems = [];
        const sources: string[] = [];
        let registered = 0;

        for (const path of pyIterate(usePaths)) {
            if (!HOOK_RUNNER_SEAMS.isfile(path)) continue;
            let cfg: unknown;
            try {
                cfg = pyJsonLoads(HOOK_RUNNER_SEAMS.readConfig(path as string));
            } catch (e) {
                if (e instanceof OSErrorP || e instanceof JSONDecodeErrorP) {
                    this.problems.push(`${pyStr(path)}: unreadable (${pyStr(e)})`);
                    continue;
                }
                throw e;
            }

            sources.push(path as string);
            if (pyGet(cfg, "enabled", null) === true) this.enabled = true;
            const cfgTimeout = pyGet(cfg, "timeoutMs", null);
            if (pyIsIntOnly(cfgTimeout) && pyGtZero(cfgTimeout)) this.timeout_ms = cfgTimeout;
            const cfgMax = pyGet(cfg, "maxOutputBytes", null);
            if (pyIsIntOnly(cfgMax) && pyGtZero(cfgMax)) this.max_output = cfgMax;

            const events = pyOr(pyOr(pyGet(cfg, "events", null), pyGet(cfg, "hooks", null)), {});
            if (!isPyDict(events)) {
                this.problems.push(`${pyStr(path)}: 'events' must be an object`);
                continue;
            }

            for (const event_name of Object.keys(events)) {
                if (!HOOK_EVENTS.includes(event_name)) {
                    this.problems.push(
                        `${pyStr(path)}: unsupported event '${event_name}' ` +
                        `(supported: ${HOOK_EVENTS.join(", ")})`);
                    continue;
                }
                const groups = pyGet(events, event_name, null);
                if (!Array.isArray(groups)) {
                    this.problems.push(`${pyStr(path)}: ${event_name} must be an array`);
                    continue;
                }
                for (const group of groups) {
                    const entry = this._build_group(group, event_name, path as string);
                    if (entry) {
                        (this.matchers[event_name] as JsonDict[]).push(entry);
                        registered += (entry["hooks"] as unknown[]).length;
                    }
                }
            }
        }

        return {
            enabled: this.enabled,
            registered,
            sources,
            problems: this.problems,
        };
    }

    _build_group(group: unknown, event_name: string, path: string): JsonDict | null {
        if (!isPyDict(group)) {
            this.problems.push(`${pyStr(path)}: ${event_name} entry must be an object`);
            return null;
        }
        const raw_matcher = pyGet(group, "matcher", null);
        let pattern: PyPattern | null = null;
        if (raw_matcher !== null && raw_matcher !== "") {
            try {
                // Case-sensitive by design: `bash` must not match `Bash`.
                pattern = pyReCompile(pyStr(raw_matcher));
            } catch (e) {
                if (e instanceof PatternErrorP) {
                    this.problems.push(
                        `${pyStr(path)}: ${event_name} matcher ${pyRepr(raw_matcher)} is not a valid regex (${pyStr(e)}); ` +
                        "it would never fire");
                    return null;
                }
                throw e;
            }
        }

        const specs: JsonDict[] = [];
        for (const spec of pyIterate(pyOr(pyGet(group, "hooks", null), []))) {
            const validated = this._validate_hook(spec, event_name, path);
            if (validated) specs.push(validated);
        }
        if (specs.length === 0) return null;

        return { matcher: raw_matcher, pattern: pattern as unknown, hooks: specs, source: path };
    }

    _validate_hook(spec: unknown, event_name: string, path: string): JsonDict | null {
        if (!isPyDict(spec)) {
            this.problems.push(`${pyStr(path)}: ${event_name} hook must be an object`);
            return null;
        }

        const hook_type = pyGet(spec, "type", "command");
        if (hook_type !== "command" && hook_type !== "process" && hook_type !== "http") {
            this.problems.push(`${pyStr(path)}: ${event_name} unknown hook type ${pyRepr(hook_type)}`);
            return null;
        }

        if (hook_type === "http") {
            return this._validate_http_hook(spec, event_name, path);
        }

        const command = pyGet(spec, "command", null);
        if (!pyTruth(command) || typeof command !== "string") {
            this.problems.push(`${pyStr(path)}: ${event_name} hook needs a 'command' string`);
            return null;
        }

        const allowed: ReadonlySet<string> = hook_type === "process"
            ? new Set(["type", "command", "args", "timeoutMs", "statusMessage"])
            : new Set(["type", "command", "shell", "timeout", "timeoutMs", "statusMessage"]);
        const extra = pySetDiff(Object.keys(spec), allowed);
        if (extra.size > 0) {
            this.problems.push(
                `${pyStr(path)}: ${event_name} ${pyStr(hook_type)} hook has fields not valid for its type: ` +
                `${pySorted(Array.from(extra)).join(", ")}`);
            return null;
        }

        // Timeout resolution order: timeoutMs -> timeout(seconds) -> config default.
        let timeout_ms: unknown;
        if (pyIsNumLike(pyGet(spec, "timeoutMs", null)) && pyGtZero(pyGet(spec, "timeoutMs", null))) {
            timeout_ms = pyIntCoerce(pyGet(spec, "timeoutMs", null));
        } else if (pyIsNumLike(pyGet(spec, "timeout", null)) && pyGtZero(pyGet(spec, "timeout", null))) {
            timeout_ms = pyIntCoerce((pyGet(spec, "timeout", null) as number) * 1000);
        } else {
            timeout_ms = this.timeout_ms;
        }

        const args = pyOr(pyGet(spec, "args", null), []);
        if (hook_type === "process" && !Array.isArray(args)) {
            this.problems.push(`${pyStr(path)}: ${event_name} process hook 'args' must be an array`);
            return null;
        }

        return {
            type: hook_type,
            command,
            args: pyIterate(args).map((a) => pyStr(a)),
            shell: pyGet(spec, "shell", null),
            timeout_ms,
            status_message: pyGet(spec, "statusMessage", ""),
            source: path,
        };
    }

    _validate_http_hook(spec: unknown, event_name: string, path: string): JsonDict | null {
        const url = pyGet(spec, "url", null);
        if (!pyTruth(url) || typeof url !== "string") {
            this.problems.push(`${pyStr(path)}: ${event_name} http hook needs a 'url' string`);
            return null;
        }

        const method = pyStr(pyGet(spec, "method", "POST")).toUpperCase();
        if (!HTTP_METHODS.has(method)) {
            this.problems.push(
                `${pyStr(path)}: ${event_name} http hook method ${pyRepr(method)} not in ` +
                `${pySorted(Array.from(HTTP_METHODS)).join(", ")}`);
            return null;
        }

        const headers = pyOr(pyGet(spec, "headers", null), {});
        if (!isPyDict(headers)) {
            this.problems.push(`${pyStr(path)}: ${event_name} http hook 'headers' must be an object`);
            return null;
        }
        let badHeaders = false;
        for (const [k, v] of Object.entries(headers)) {
            if (typeof k !== "string" || typeof v !== "string") { badHeaders = true; break; }
        }
        if (badHeaders) {
            this.problems.push(
                `${pyStr(path)}: ${event_name} http hook 'headers' must be string -> string`);
            return null;
        }

        const extra = pySetDiff(Object.keys(spec as JsonDict), HTTP_HOOK_FIELDS);
        if (extra.size > 0) {
            this.problems.push(
                `${pyStr(path)}: ${event_name} http hook has fields not valid for its type: ` +
                `${pySorted(Array.from(extra)).join(", ")}`);
            return null;
        }

        let timeout_ms: unknown;
        if (pyIsNumLike(pyGet(spec, "timeoutMs", null)) && pyGtZero(pyGet(spec, "timeoutMs", null))) {
            timeout_ms = pyIntCoerce(pyGet(spec, "timeoutMs", null));
        } else {
            timeout_ms = this.timeout_ms;
        }

        return {
            type: "http",
            command: url,          // reuse the log/record field
            args: [],
            shell: null,
            url: this._expand(url),
            method,
            headers: Object.fromEntries(
                Object.entries(headers).map(([k, v]) => [pyStr(k), this._expand(pyStr(v))])),
            body: pyGet(spec, "body", null),
            timeout_ms,
            status_message: pyGet(spec, "statusMessage", ""),
            source: path,
        };
    }

    // ── template expansion ───────────────────────────────────────────────────

    _variables(): JsonDict {
        return {
            OVOLVE_PROJECT_DIR: this.project_dir,
            PROJECT_DIR: this.project_dir,
            OVOLVE_SESSION_ID: this.session_id,
            SESSION_ID: this.session_id,
        };
    }

    _expand(text: unknown): string {
        let t = text;
        for (const [key, value] of Object.entries(this._variables())) {
            if (typeof t !== "string") {
                throw new AttributeErrorP(
                    `'${pyTypeName(t)}' object has no attribute 'replace'`);
            }
            if (typeof value !== "string") {
                // python: str.replace with a non-str replacement
                throw new TypeErrorP(
                    `replace() argument 2 must be str, not ${pyTypeName(value)}`);
            }
            t = t.split("${" + key + "}").join(value);
        }
        return t as string;
    }

    // ── execution ────────────────────────────────────────────────────────────

    async run_one(spec: JsonDict, match_value: unknown, hook_event: string,
        payload: unknown): Promise<HookOutcome> {
        if (pyKeyGet(spec, "type") === "http") {
            return await this._run_http(spec, hook_event, match_value, payload);
        }

        const command = this._expand(pyKeyGet(spec, "command"));
        const args = pyIterate(pyKeyGet(spec, "args")).map((a) => this._expand(a));

        // Build stdin input that a hook script can read (matches upstream spec).
        const stdin_data = pyJsonDumps({
            event: hook_event,
            matchValue: match_value,
            payload,
        });

        const env = { ...HOOK_RUNNER_SEAMS.environ(), ...this._variables() } as Record<string, string>;
        const t0 = HOOK_RUNNER_SEAMS.now();

        let proc: HookProc;
        let stdout: Uint8Array;
        let stderr: Uint8Array;
        try {
            if (pyKeyGet(spec, "type") === "process") {
                proc = await HOOK_RUNNER_SEAMS.createSubprocessExec(
                    [command, ...args],
                    {
                        stdin: SUBPROCESS_PIPE, stdout: SUBPROCESS_PIPE, stderr: SUBPROCESS_PIPE,
                        env, cwd: this.project_dir,
                    });
            } else {
                let shell_cmd: string = command;
                if (pyTruth(args)) {
                    shell_cmd += " " + args.map((a) => pyShlexQuote(a as string)).join(" ");
                }
                proc = await HOOK_RUNNER_SEAMS.createSubprocessShell(
                    [shell_cmd],
                    {
                        stdin: SUBPROCESS_PIPE, stdout: SUBPROCESS_PIPE, stderr: SUBPROCESS_PIPE,
                        env, cwd: this.project_dir,
                    });
            }

            try {
                const comm = proc.communicate(Buffer.from(stdin_data, "utf8"));
                (comm as unknown as { __name__?: string }).__name__ = "communicate";
                const pair = await HOOK_RUNNER_SEAMS.waitFor(
                    comm, (pyKeyGet(spec, "timeout_ms") as number) / 1000.0);
                stdout = pair[0];
                stderr = pair[1];
            } catch (e) {
                if (e instanceof TimeoutErrorP) {
                    proc.kill();
                    await proc.wait();
                    const duration = pyIntCoerce((HOOK_RUNNER_SEAMS.now() - t0) * 1000);
                    this._record(spec, hook_event, match_value, "timeout", duration);
                    return new HookOutcome("timeout", undefined,
                        `killed after ${pyStr(pyKeyGet(spec, "timeout_ms"))}ms`,
                        undefined, undefined, duration);
                }
                throw e;
            }
        } catch (e) {
            if (e instanceof OSErrorP) {
                const duration = pyIntCoerce((HOOK_RUNNER_SEAMS.now() - t0) * 1000);
                this._record(spec, hook_event, match_value, "error", duration, pyStr(e));
                return new HookOutcome("error", undefined, pyStr(e), undefined, undefined, duration);
            }
            throw e;
        }

        const duration = pyIntCoerce((HOOK_RUNNER_SEAMS.now() - t0) * 1000);
        const rc = proc.returncode;
        const out = pyStrip(Buffer.from(stdout)
            .slice(0, pyIndex(this.max_output)).toString("utf8"));

        // Exit code protocol: 0=pass, 2=block/deny, other=error.
        // python `rc == 2` / `rc not in (0, None)` use ==, so False counts as
        // 0 (parse path) and 2.0 counts as 2 (block path).
        if (pyEq(rc, 2)) {
            this._record(spec, hook_event, match_value, "block", duration);
            return new HookOutcome("block", "deny", pyOr(out, "hook exited 2"),
                undefined, undefined, duration);
        }
        if (!pyEq(rc, 0) && !pyEq(rc, null)) {
            const err_msg = pyOr(
                pyStrip(Buffer.from(stderr).slice(0, 512).toString("utf8")),
                `exit ${pyStr(rc)}`);
            this._record(spec, hook_event, match_value, "error", duration, err_msg);
            return new HookOutcome("error", undefined, err_msg, undefined, undefined, duration);
        }

        return this._parse_output(out, spec, hook_event, match_value, duration);
    }

    async _run_http(spec: JsonDict, hook_event: string, match_value: unknown,
        payload: unknown): Promise<HookOutcome> {
        let body: Uint8Array | null = null;
        if (pyGet(spec, "body", null) !== null) {
            body = Buffer.from(pyJsonDumps(pyGet(spec, "body", null)), "utf8");
        }
        const headers = { ...(pyDictCtor(pyOr(pyGet(spec, "headers", null), {})) as JsonDict) };
        if (body !== null &&
            !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
            headers["Content-Type"] = "application/json";
        }

        const envelope = Buffer.from(pyJsonDumps({
            event: hook_event,
            matchValue: match_value,
            payload,
        }), "utf8");

        const method = pyKeyGet(spec, "method");
        let data: Uint8Array | null;
        if (method === "GET") {
            data = null;
        } else {
            data = body !== null ? body : envelope;
        }

        const t0 = HOOK_RUNNER_SEAMS.now();
        let resp: unknown;
        let raw: Uint8Array;
        try {
            resp = await HOOK_RUNNER_SEAMS.waitFor(
                HOOK_RUNNER_SEAMS.toThread("open_url", pyKeyGet(spec, "url"), {
                    timeout: (pyKeyGet(spec, "timeout_ms") as number) / 1000.0,
                    headers,
                    data,
                    method: method as string,
                }),
                (pyKeyGet(spec, "timeout_ms") as number) / 1000.0 + 1,
            );
            try {
                raw = (resp as { read(): Uint8Array }).read() as Uint8Array;
            } finally {
                const close = pyGetattr(resp, "close", null) as (() => unknown) | null;
                if (close) close();
            }
        } catch (e) {
            if (e instanceof TimeoutErrorP) {
                const duration = pyIntCoerce((HOOK_RUNNER_SEAMS.now() - t0) * 1000);
                this._record(spec, hook_event, match_value, "timeout", duration,
                    `no response within ${pyStr(pyKeyGet(spec, "timeout_ms"))}ms`);
                return new HookOutcome("timeout", undefined,
                    `HTTP hook timed out after ${pyStr(pyKeyGet(spec, "timeout_ms"))}ms`,
                    undefined, undefined, duration);
            }
            if (e instanceof HTTPErrorP) {
                const duration = pyIntCoerce((HOOK_RUNNER_SEAMS.now() - t0) * 1000);
                const code = pyOr(pyGetattr(e, "code", 0), 0);
                if (pyIn400Range(code)) {
                    // Our request was wrong, not the user's turn. Warn and move on.
                    this._record(spec, hook_event, match_value, "warning", duration,
                        `HTTP ${pyStr(code)}`);
                    return new HookOutcome("pass", undefined,
                        `HTTP ${pyStr(code)} (4xx does not block the main flow)`,
                        undefined, undefined, duration);
                }
                this._record(spec, hook_event, match_value, "error", duration, `HTTP ${pyStr(code)}`);
                return new HookOutcome("error", undefined, `HTTP ${pyStr(code)}`,
                    undefined, undefined, duration);
            }
            const duration = pyIntCoerce((HOOK_RUNNER_SEAMS.now() - t0) * 1000);
            this._record(spec, hook_event, match_value, "error", duration, pyStr(e));
            return new HookOutcome("error", undefined, pyStr(e), undefined, undefined, duration);
        }

        const duration = pyIntCoerce((HOOK_RUNNER_SEAMS.now() - t0) * 1000);
        const out = pyStrip(Buffer.from(raw)
            .slice(0, pyIndex(this.max_output)).toString("utf8"));
        return this._parse_output(out, spec, hook_event, match_value, duration);
    }

    _parse_output(out: unknown, spec: JsonDict, hook_event: string,
        match_value: unknown, duration: unknown): HookOutcome {
        // If the output is empty: pass with no side effects.
        if (!pyTruth(out)) {
            this._record(spec, hook_event, match_value, "pass", duration);
            return new HookOutcome("pass", undefined, undefined, undefined, undefined, duration);
        }

        // Parse JSON output (strict schema: extra keys -> invalid).
        let data: unknown;
        try {
            data = pyJsonLoads(out as string);
        } catch (e) {
            if (e instanceof JSONDecodeErrorP) {
                this._record(spec, hook_event, match_value, "invalid", duration, pyStr(e));
                return new HookOutcome("invalid", undefined, `output not JSON: ${pyStr(e)}`,
                    undefined, undefined, duration);
            }
            throw e;
        }
        if (!isPyDict(data)) {
            this._record(spec, hook_event, match_value, "invalid", duration,
                "output must be a JSON object");
            return new HookOutcome("invalid", undefined, "output must be a JSON object",
                undefined, undefined, duration);
        }
        const extra = pySetDiff(Object.keys(data), ALLOWED_OUTPUT_KEYS);
        if (extra.size > 0) {
            this._record(spec, hook_event, match_value, "invalid", duration,
                `unknown keys: ${pySetRepr(extra)}`);
            return new HookOutcome("invalid", undefined,
                `unknown output keys: ${pySorted(Array.from(extra)).join(", ")}`,
                undefined, undefined, duration);
        }

        // Extract structured fields.
        let decision = pyGet(data, "permissionDecision", "");
        if (pyTruth(decision) && !VALID_DECISIONS.includes(decision as string)) {
            decision = "";
        }
        const context = pyStr(pyGet(data, "additionalContext", ""));
        const cont = pyTruth(pyGet(data, "continue", false));

        this._record(spec, hook_event, match_value, "pass", duration);
        return new HookOutcome(
            !pyTruth(decision) || decision === "allow" ? "pass" : "block",
            decision,
            pyGet(data, "permissionDecisionReason", ""),
            context,
            cont,
            duration,
        );
    }

    _record(spec: JsonDict, event: unknown, match_value: unknown,
        status: string, duration_ms: unknown, error: unknown = ""): void {
        this.log.push({
            event,
            matchValue: match_value,
            command: pyKeyGet(spec, "command"),
            type: pyKeyGet(spec, "type"),
            source: pyGet(spec, "source", ""),
            status,
            durationMs: duration_ms,
            error,
            ts: HOOK_RUNNER_SEAMS.now(),
        });
        // Keep the log from growing unbounded.
        if (this.log.length > 200) {
            this.log = this.log.slice(-100);
        }
    }

    // ── event bus integration ────────────────────────────────────────────────

    _match_value_for(bus_event_name: string, payload: unknown): unknown {
        if (bus_event_name === "pre_tool_use" || bus_event_name === "tool_result" ||
            bus_event_name === "permission_request") {
            return pyGet(payload, "tool_name", "");
        }
        if (bus_event_name === "user_prompt_submit") {
            return pyGet(payload, "message", "");
        }
        if (bus_event_name === "session_start") {
            return pyGet(payload, "reason", "startup");
        }
        if (bus_event_name === "output") {
            return Array.from(pyStr(pyGet(payload, "text", ""))).slice(0, 200).join("");
        }
        if (bus_event_name === "subagent_state") {
            return pyStr(pyGet(payload, "subagentType", ""));
        }
        if (bus_event_name === "session_before_compact" || bus_event_name === "context_folded") {
            return pyTruth(pyGet(payload, "manual", null)) ? "manual" : "auto";
        }
        return "";
    }

    _hook_payload_for(bus_event_name: string, payload: unknown): unknown {
        if (bus_event_name === "session_before_compact") {
            const slim: JsonDict = {};
            for (const [k, v] of pyItems(payload)) {
                if (k !== "messages") slim[k] = v;
            }
            slim["messageCount"] = pyLen(pyOr(pyGet(payload, "messages", null), []));
            return slim;
        }
        if (bus_event_name === "context_folded") {
            const slim: JsonDict = {};
            for (const [k, v] of pyItems(payload)) {
                if (k !== "summary") slim[k] = v;
            }
            return slim;
        }
        return payload;
    }

    _hook_event_for(bus_event_name: string, payload: unknown): unknown {
        const candidates = pyGet(BUS_TO_HOOK, bus_event_name, null);
        if (!pyTruth(candidates)) {
            return "";
        }
        if (bus_event_name === "tool_result") {
            const ok = pyGet(pyOr(pyGet(payload, "result", null), {}), "ok", true);
            return pyTruth(ok) ? "PostToolUse" : "PostToolUseFailure";
        }
        if (bus_event_name === "subagent_state") {
            const status = pyStr(pyGet(payload, "status", ""));
            if (SUBAGENT_START_STATUSES.has(status)) {
                return "SubagentStart";
            }
            if (!SUBAGENT_TERMINAL_STATUSES.has(status)) {
                return "";
            }
            return "SubagentStop";
        }
        return (candidates as readonly string[])[0];
    }

    async fire(bus_event_name: string, payload: unknown): Promise<HookOutcome[]> {
        if (!pyTruth(this.enabled)) {
            return [];
        }

        const hook_event = this._hook_event_for(bus_event_name, payload);
        if (!pyTruth(hook_event)) {
            return [];
        }

        const match_value = this._match_value_for(bus_event_name, payload);
        const hook_payload = this._hook_payload_for(bus_event_name, payload);
        const outcomes: HookOutcome[] = [];

        for (const group of pyGet(this.matchers, hook_event as string, []) as JsonDict[]) {
            // Matcher filtering: None matches everything; a compiled pattern
            // must match the value.
            const pat = pyKeyGet(group, "pattern") as PyPattern | null;
            if (pat !== null && !pat.search(match_value)) {
                continue;
            }

            for (const spec of pyIterate(pyKeyGet(group, "hooks")) as JsonDict[]) {
                const outcome = await this.run_one(spec, match_value, hook_event as string, hook_payload);
                outcomes.push(outcome);

                // A blocking outcome short-circuits remaining hooks in this
                // event, matching the upstream behaviour.
                if (pyStr(outcome.status) === "block") {
                    return outcomes;
                }
            }
        }

        return outcomes;
    }

    mount(bus?: unknown): void {
        // python `bus = bus or get_event_bus()` — the seam resolves lazily
        const b = (pyTruth(bus) ? bus : HOOK_RUNNER_SEAMS.getEventBus()) as BusLike;
        for (const bus_event of Object.keys(BUS_TO_HOOK)) {
            b.on(bus_event, this._make_handler(bus_event), -50);
        }
    }

    _make_handler(bus_event_name: string): (event: Event) => Promise<void> {
        return async (event: Event): Promise<void> => {
            const outcomes = await this.fire(bus_event_name, event.payload);
            for (const o of outcomes) {
                if (pyTruth(o.context)) {
                    // Inject additional context so downstream consumers (router,
                    // system prompt) can use it.
                    pyAppend(pySetdefault(event.payload, "hook_context", []), o.context);
                }
                if (pyTruth(o.decision)) {
                    // allow / ask / deny — surfaced for the router's permission
                    // resolution on pre_tool_use / permission_request.
                    event.payload["hook_decision"] = o.decision;
                }
                if (pyStr(o.status) === "block") {
                    if (bus_event_name === "pre_tool_use" || bus_event_name === "permission_request") {
                        event.block(pyOr(o.reason, "Blocked by hook") as string);
                    }
                    return;
                }
            }
        };
    }
}

interface BusLike {
    on(eventName: string, handler: (event: Event) => unknown, priority: number): void;
}

/** python `dict(x)` for the header-copy shapes this module can meet. */
function pyDictCtor(v: unknown): unknown {
    if (!pyTruth(v)) return {};
    if (isPyDict(v)) return { ...v };
    if (Array.isArray(v)) {
        const out: JsonDict = {};
        for (let idx = 0; idx < v.length; idx++) {
            const item = v[idx];
            if (!Array.isArray(item) || item.length !== 2) {
                throw new ValueErrorP(
                    `dictionary update sequence element #${idx} has length ${Array.isArray(item) ? item.length : 1}; 2 is required`);
            }
            out[pyStr(item[0])] = item[1];
        }
        return out;
    }
    if (typeof v === "string") {
        throw new ValueErrorP("dictionary update sequence element #0 has length 1; 2 is required");
    }
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python `==` for the shapes run_one's returncode can take. */
function pyEq(a: unknown, b: unknown): boolean {
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    const num = (v: unknown): number | null => {
        if (typeof v === "boolean") return v ? 1 : 0;
        if (v instanceof PyFloat) return v.n;
        return typeof v === "number" ? v : null;
    };
    const na = num(a);
    const nb = num(b);
    if (na !== null && nb !== null) return na === nb;
    if (typeof a === "string" && typeof b === "string") return a === b;
    return a === b;
}

/** python isinstance(x, int) — True for bools, False for floats (PyFloat). */
function pyIsIntOnly(v: unknown): boolean {
    if (typeof v === "boolean") return true;
    if (v instanceof PyFloat) return false;
    return typeof v === "number" && Number.isInteger(v);
}

/** python isinstance(x, (int, float)) — bools included. */
function pyIsNumLike(v: unknown): boolean {
    return typeof v === "boolean" || v instanceof PyFloat || typeof v === "number";
}

function pyGtZero(v: unknown): boolean {
    if (v instanceof PyFloat) v = v.n;
    if (typeof v === "boolean") return v;
    if (typeof v !== "number") return false;
    return v > 0;
}

// ── singleton ────────────────────────────────────────────────────────────────

let _runner: HookRunner | null = null;

export function get_hook_runner(project_dir?: unknown, session_id?: unknown): HookRunner {
    const given = arguments.length;
    if (given > 2) throw pyTooManyRange("get_hook_runner", 0, 2, given);
    if (_runner === null) {
        const pd = given >= 1 ? project_dir : null;
        const sid = given >= 2 ? session_id : "";
        _runner = new HookRunner(pd, sid);
    }
    return _runner;
}

/** 探针缝：rebinds python's module-level `_runner` singleton. */
export function _set_hook_runner_for_parity(v: HookRunner | null): void {
    _runner = v;
}

export function init_hooks(project_dir?: unknown, session_id?: unknown): JsonDict {
    const given = arguments.length;
    if (given > 2) throw pyTooManyRange("init_hooks", 0, 2, given);
    // python binds the defaults BEFORE the call, so get_hook_runner always
    // receives two positional arguments from here.
    const pd = given >= 1 ? project_dir : null;
    const sid = given >= 2 ? session_id : "";
    const runner = get_hook_runner(pd, sid);
    const summary = runner.load();
    if (pyTruth(runner.enabled)) {
        runner.mount();
    }
    return summary;
}

// PORT STATUS: confidence=high todos=[0]
