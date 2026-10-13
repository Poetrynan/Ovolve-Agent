/**
 * web_outbound.ts — port of app/backend/web_outbound.py (unit 155, wave 6).
 *
 * SOURCE: app/backend/web_outbound.py (147 lines) — the single exit for
 * tool-side HTTP:  open_url(url, ...) = egress policy check → proxy opener → urllib.
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4)
 *   §4 naming: every module-level python name keeps its spelling verbatim —
 *     _KV_NS, _KV_PROXY, _KV_TAVILY, EgressBlocked, get_outbound_settings,
 *     set_outbound_settings, _opener, check_egress, open_url. The two private
 *     urllib helpers this port needs are file-local and prefixed py*
 *     (pyUrlHostname, pyBuildRequest) so they never collide with a sibling's.
 *   §2 pyTruth/pyStr/pyStrip: proxy_url and tavily_key pass through python's
 *     `.strip()` (isspace set, not JS \s) and `str(x)`; `if not proxy_url`
 *     and `if block:` are pyTruth tests, not `!== undefined`.
 *   §2 `isinstance(x, str)` → typeof x === "string" (a Storage value that is
 *     an int/None/list leaves the field at its "" default in BOTH languages).
 *   §2 dict literal key order: get_outbound_settings returns
 *     {"proxy_url","tavily_key"} in that order; the parity comparator is
 *     key-order significant, so the object literal below is the contract.
 *   §2 tuple unpack `verdict, hit = outcome` → pyUnpack2 with CPython's own
 *     ValueError wording ("not enough values to unpack (expected 2, got 1)" /
 *     "too many values to unpack (expected 2, got 3)").
 *   §2 exception identity: the probe compares [type(e).__name__, str(e)], so
 *     EgressBlocked keeps its class name AND RuntimeError as its JS base
 *     (RuntimeErrorP), and the TypeError arity messages are byte-exact.
 *   §2/§4.5 keyword-only signature: open_url's `*, timeout, headers, data,
 *     method` becomes an options bag; any second positional is python's
 *     "takes 1 positional argument but N were given" TypeError.
 *   §4.9 late binding: python imports `get_egress_policy` at module level
 *     *specifically* so tests can monkeypatch `web_outbound.get_egress_policy`
 *     and so check_egress resolves it at call time. ESM import bindings are
 *     read-only, so the resolution goes through WEB_OUTBOUND_SEAMS — see the
 *     DIVERGENCE note; call-time lookup (the semantic that matters) is kept.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. get_outbound_settings is fail-open twice over: each of the two blocks
 *      has its OWN try/except, and its own `from storage import get_storage`,
 *      so a storage that dies on the second read still yields the proxy_url
 *      read by the first. set_outbound_settings has NO try at all — a missing
 *      storage raises there while the reader swallows it.
 *   2. Empty string vs None in set_outbound_settings: None means "don't touch
 *      this key", "" means "clear it". Because the test is `is not None`,
 *      falsy non-None values (0, False, [], {}) are str()'d and WRITTEN —
 *      `set_outbound_settings(0)` stores the two-character proxy "0".
 *   3. tavily_key is written encrypted only when non-empty after strip; a
 *      whitespace-only key clears the row instead of sealing "" into it.
 *   4. _opener returns None (not a default opener) when no proxy is set, and
 *      that is deliberate: urlopen's own default already honours
 *      env/system proxies, and replacing it would silently drop them.
 *   5. check_egress fail-opens on a host it cannot parse and on a policy
 *      subsystem that raises; the policy is asked about exactly one host
 *      (`check([host])`), unlike the shell path which asks about all of them.
 *   6. The restricted message interpolates `hit` — which is the policy's
 *      SECOND element, a two-item list [host, rule] — so the model-facing
 *      text carries python's list repr ("['evil.com', 'bad']"), while the
 *      closed-mode message interpolates `host`, a bare string. Asymmetric and
 *      load-bearing: it is what makes the two branches distinguishable.
 *   7. Any verdict other than the literal "restricted" falls into the
 *      closed-whitelist branch, including "review" and a nonsense string.
 *   8. bytes/str duality: python's urlparse ACCEPTS a bytes URL —
 *      _coerce_args decodes it ascii/strict, parses, then re-encodes every
 *      field, so urlparse(b"http://a.b").hostname is the BYTES b'a.b'. The
 *      check_egress `(x or "").lower()` then runs bytes.lower() (ASCII-only
 *      folding) and the model-facing closed-mode message interpolates
 *      str(host) — the repr b'a.b', not the bare host. The port keeps the
 *      Buffer form end to end: pyUrlHostname returns a Buffer, pyLower folds
 *      ASCII-only, the policy ledger records the bytes type tag, and the
 *      message goes through pyStr. A non-ASCII byte raises
 *      UnicodeDecodeError inside urlparse, which the outer except swallows
 *      into host="" — mirrored by the seam throwing the same-shaped error.
 *   9. `verdict, hit = outcome` unpacks ANY iterable: a 2-char str yields
 *      ("a","b") and a dict yields its keys, so policy junk like "ab" sails
 *      through with verdict "a" while "review" raises. CPython 3.13 wording:
 *      the too-many text has NO ", got N" suffix, the not-enough text does.
 *      Empty containers never reach the unpack — `if not outcome` returns
 *      first, so a policy answering () or [] fail-opens like a None.
 *
 * DIVERGENCE(port, lazy import → seam): python resolves `storage`,
 *     `model_registry`, `urllib.request`, `urllib.parse` and `tools` at call
 *     time. The port routes the two that can fail app-side (storage,
 *     model_registry) and the three transport calls through
 *     WEB_OUTBOUND_SEAMS. Equivalence: a throwing seam is observed exactly as
 *     a throwing import is — inside get_outbound_settings' try (swallowed),
 *     inside set_outbound_settings (propagates), or in check_egress/open_url
 *     (propagates). Stdlib import failure is unreachable in both languages.
 *   DIVERGENCE(port, sync → async): python's urlopen is blocking and returns a
 *     file-like response; the port's open_url returns a Promise of the same
 *     read()/status surface, and because the body is one function, EVERY raise
 *     site inside it (EgressBlocked, the Request ValueError, the arity
 *     TypeErrors) surfaces as a rejection instead of a synchronous raise. Same
 *     house precedent as mcp_oauth.ts and browser_agent.ts (BA_SEAMS.urlopen).
 *     Callers in the TS layer await; no python-visible value is lost, only the
 *     blocking-ness. check_egress / _opener / the two settings functions stay
 *     synchronous.
 *   DIVERGENCE(port, monkeypatch target): `web_outbound.get_egress_policy` ↔
 *     `WEB_OUTBOUND_SEAMS.get_egress_policy`. Both are resolved at call time
 *     by check_egress, so the test lever behaves identically; only its name
 *     changes. Hooked up and exercised by probe family F (patch → observe →
 *     restore → observe).
 *   DIVERGENCE(port, proxy transport): python builds
 *     `urllib.request.build_opener(ProxyHandler({"http": p, "https": p}))`;
 *     the port hands the proxy URL to the injected transport (fetch cannot
 *     speak to a proxy without an agent, and adding one is a dependency
 *     decision, not a parity one). The opener IS still chosen only when a
 *     proxy is configured, the proxy dict still carries both schemes, and the
 *     ledger records the identical call order — which is the observable
 *     behaviour of this module.
 *   DIVERGENCE(port, Request object): python's urllib.request.Request is
 *     reproduced field-by-field by pyBuildRequest (unwrap/strip, '#'-tag
 *     split, _splittype validation, `key.capitalize()` header keys, method
 *     truthiness, data!=None POST default) rather than as a class. The probe
 *     compares the four fields any caller can read; nothing else in this
 *     module touches the object.
 *   DIVERGENCE(port, str.lower): the hostname lowercasing INSIDE pyUrlHostname
 *     (python's SplitResult.hostname property) uses JS toLowerCase, which
 *     applies the Greek final-sigma context rule that CPython's str.lower
 *     does not. Only reachable for a non-ASCII netloc that survives NFKC
 *     checking; a host name reaching get_egress_policy in that state is not a
 *     shape the product can produce. The SECOND lower — check_egress'
 *     `(x or "").lower()` — is ASCII-only folding (pyLower) in the port,
 *     because on the bytes channel python runs bytes.lower(), which IS
 *     ASCII-only; widening it to the Unicode rule would add a new
 *     incomparability on the bytes path.
 *
 *   NOTE: `EgressBlocked` extends RuntimeErrorP (name "RuntimeError"), so a
 *   catcher of python's `except RuntimeError` keeps working after the port.
 */

import { get_egress_policy as _realGetEgressPolicy } from "./command_classifier.js";
import { format_tool_error as _realFormatToolError } from "./tools.js";
import { get_storage as _realGetStorage } from "./storage.js";
import { CredentialCipher as _RealCredentialCipher } from "./model_registry_impl.js";

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
class ImportErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "ImportError"; }
}
/** python's UnicodeDecodeError ('ascii' codec, strict) — swallowed by
 *  check_egress' except into host="", like python's. */
class UnicodeDecodeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "UnicodeDecodeError"; }
}
/** python's RuntimeError base class — EgressBlocked inherits from this. */
export class RuntimeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "RuntimeError"; }
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

/** house predicate: a value that IS a python dict — plain or prototype-less. */
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
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.length > 0;
    // A class instance is a python OBJECT: bool() is True whatever its fields
    // are, so the empty-container rule applies only to dict-shaped values.
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
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

/** CPython bytes repr: printable ASCII (0x20-0x7E) verbatim, `\t \n \r \\` and
 *  the chosen quote escaped, every other byte `\xNN` (lowercase hex, DEL and
 *  non-ASCII included). Quote choice matches the str rule: `'` unless the
 *  bytes contain `'` and no `"`. */
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

/** python `str(x)` (containers render through repr).
 *  bytes are NOT decoded here: CPython's `str(b'a')` is the literal "b'a'",
 *  which is exactly what reaches the model-facing error text. */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return pyRepr(v);
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

/** python `str.strip()` with no args: strips isspace() chars. */
function pyStrip(s: string): string {
    return s.replace(/^[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
        .replace(/[\s\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** python `str.capitalize()`: first char titlecased, the rest lowercased. */
function pyCapitalize(s: string): string {
    return s.length === 0 ? s : s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase();
}

/** python `s.partition(sep)` → [before, sep, after] (sep "" when absent). */
function pyPartition(s: string, sep: string): [string, string, string] {
    const i = s.indexOf(sep);
    return i < 0 ? [s, "", ""] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** python `s.rpartition(sep)` → [before, sep, after] ("", "", s) if absent. */
function pyRPartition(s: string, sep: string): [string, string, string] {
    const i = s.lastIndexOf(sep);
    return i < 0 ? ["", "", s] : [s.slice(0, i), sep, s.slice(i + sep.length)];
}

/** python `str(x).strip()` for the settings values (None is not stripped). */
function pyStripped(v: unknown): string {
    return pyStrip(pyStr(v));
}

/** python's second `.lower()` in check_egress: `(urlparse(url).hostname or
 *  "").lower()`. On the str channel this is str.lower(); on the bytes channel
 *  python runs bytes.lower(), which folds ONLY ASCII A-Z — so the port folds
 *  ASCII-only in both channels and never reaches for JS toLowerCase here
 *  (that would smuggle the Greek final-sigma rule onto the bytes path). */
function pyLower(v: string | Buffer): string | Buffer {
    if (typeof v === "string") return v.replace(/[A-Z]/g, (c) => c.toLowerCase());
    return Buffer.from(v.toString("binary").replace(/[A-Z]/g, (c) => c.toLowerCase()), "binary");
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

/** Same, for signatures where some parameters have defaults: CPython 3.13
 *  reports the interval — "takes from MIN to MAX positional arguments". */
function pyTooManyRange(fname: string, min: number, max: number, given: number): TypeErrorP {
    const noun = max === 1 ? "positional argument" : "positional arguments";
    const verb = given === 1 ? "was" : "were";
    return new TypeErrorP(`${fname}() takes from ${min} to ${max} ${noun} but ${given} ${verb} given`);
}

/** `verdict, hit = outcome` — CPython's unpack errors kept verbatim.
 *  Anything iterable unpacks: a str iterates BY CODE POINT ("ab" → "a","b"),
 *  a dict iterates its keys. 3.13 wording: "not enough …" carries the got
 *  count, "too many …" does NOT (the probe pinned both texts). */
function pyUnpack2(outcome: unknown): [unknown, unknown] {
    let items: unknown[];
    if (typeof outcome === "string") items = Array.from(outcome);
    else if (Array.isArray(outcome)) items = outcome;
    else if (outcome instanceof Set || outcome instanceof Map) items = Array.from(outcome as Iterable<unknown>);
    else if (isPyDict(outcome)) items = Object.keys(outcome as Record<string, unknown>);
    else throw new TypeErrorP(`cannot unpack non-iterable ${pyTypeName(outcome)} object`);
    if (items.length < 2) {
        throw new ValueErrorP(`not enough values to unpack (expected 2, got ${items.length})`);
    }
    if (items.length > 2) {
        throw new ValueErrorP("too many values to unpack (expected 2)");
    }
    return [items[0] as unknown, items[1] as unknown];
}

type JsonDict = Record<string, unknown>;

// ── urllib.parse.urlparse(url).hostname ──────────────────────────────────────

const _SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

function pyIsAscii(s: string): boolean {
    return !/[^\x00-\x7f]/.test(s);
}

function isIPv4Octet(s: string): boolean {
    if (s.length === 0 || s.length > 3) return false;
    if (!/^[0-9]+$/.test(s)) return false;
    if (s.length > 1 && s[0] === "0") return false;   // "0177" is rejected
    return Number(s) <= 255;
}

function pyIsIPv4Address(s: string): boolean {
    if (s.length === 0) return false;
    const octets = s.split(".");
    return octets.length === 4 && octets.every(isIPv4Octet);
}

/** ipaddress.IPv6Address._ip_int_from_string, decision-only. */
function pyIsIPv6Address(addrStr: string): boolean {
    if (addrStr.length === 0) return false;
    if (addrStr.includes("/")) return false;
    let s = addrStr;
    const [head, sep, scopeId] = pyPartition(addrStr, "%");
    if (sep) {
        // scope id: non-empty, and either all digits or a hostname-ish token
        if (scopeId.length === 0) return false;
        if (!/^[A-Za-z0-9._~-]+$/.test(scopeId)) return false;
        s = head;
        if (s.length === 0) return false;
    }
    if (s.length > 45) return false;
    const parts = s.split(":");
    if (parts.length < 3) return false;                 // needs ≥2 colons
    if (parts[parts.length - 1] !== undefined && parts[parts.length - 1]!.includes(".")) {
        const v4 = parts[parts.length - 1] as string;
        if (!pyIsIPv4Address(v4)) return false;
        parts.pop();
        parts.push("0", "0");                           // two hextets, validity only
    }
    if (parts.length > 9) return false;
    let skipIndex: number | null = null;
    for (let i = 1; i < parts.length - 1; i++) {
        if (!parts[i]) {
            if (skipIndex !== null) return false;       // more than one '::'
            skipIndex = i;
        }
    }
    const hextetOk = (h: string): boolean => /^[0-9a-fA-F]{1,4}$/.test(h);
    let partsHi: number;
    let partsLo: number;
    if (skipIndex !== null) {
        partsHi = skipIndex;
        partsLo = parts.length - skipIndex - 1;
        if (!parts[0]) {
            partsHi -= 1;
            if (partsHi > 0) return false;              // leading ':' only in '::'
        }
        if (!parts[parts.length - 1]) {
            partsLo -= 1;
            if (partsLo > 0) return false;              // trailing ':' only in '::'
        }
        if (8 - (partsHi + partsLo) < 1) return false;
    } else {
        if (parts.length !== 8) return false;
        if (!parts[0]) return false;
        if (!parts[parts.length - 1]) return false;
        partsHi = parts.length;
        partsLo = 0;
    }
    for (let i = 0; i < partsHi; i++) if (!hextetOk(parts[i] as string)) return false;
    for (let i = -partsLo; i < 0; i++) if (!hextetOk(parts[i + parts.length] as string)) return false;
    return true;
}

function checkBracketedHost(hostname: string): void {
    if (hostname.startsWith("v")) {
        // python \Z is an absolute end-of-string anchor; JS has no \Z (a bare
        // \Z is an identity escape matching the LETTER Z), so pin the end with
        // a zero-width lookahead instead.
        if (!/^v[a-fA-F0-9]+\.[\s\S]+(?![\s\S])/.test(hostname)) {
            throw new ValueErrorP("IPvFuture address is invalid");
        }
        return;
    }
    if (pyIsIPv4Address(hostname)) {
        throw new ValueErrorP("An IPv4 address cannot be in brackets");
    }
    if (!pyIsIPv6Address(hostname)) {
        throw new ValueErrorP(
            `'${hostname}' does not appear to be an IPv4 or IPv6 address`);
    }
}

/** urllib.parse._check_bracketed_netloc — mirrors _hostinfo's splitting. */
function checkBracketedNetloc(netloc: string): void {
    const hostnameAndPort = pyRPartition(netloc, "@")[2];
    const [beforeBracket, haveOpenBr, bracketed] = pyPartition(hostnameAndPort, "[");
    let hostname: string;
    if (haveOpenBr) {
        if (beforeBracket) throw new ValueErrorP("Invalid IPv6 URL");
        const [, , port] = pyPartition(bracketed, "]");
        if (port && !port.startsWith(":")) throw new ValueErrorP("Invalid IPv6 URL");
        hostname = pyPartition(bracketed, "]")[0];
    } else {
        hostname = pyPartition(hostnameAndPort, ":")[0];
    }
    checkBracketedHost(hostname);
}

/** urllib.parse._checknetloc — NFKC-expanded netloc may not smuggle delimiters. */
function checkNetloc(netloc: string): void {
    if (!netloc || pyIsAscii(netloc)) return;
    const n = netloc.split("@").join("").split(":").join("")
        .split("#").join("").split("?").join("");
    const normalized = n.normalize("NFKC");
    if (n === normalized) return;
    for (const c of ["/", "?", "#", "@", ":"]) {
        if (normalized.includes(c)) {
            throw new ValueErrorP(
                `netloc '${netloc}' contains invalid characters under NFKC normalization`);
        }
    }
}

function splitnetloc(url: string, start: number): string {
    let delim = url.length;
    for (const c of ["/", "?", "#"]) {
        const w = url.indexOf(c, start);
        if (w >= 0 && w < delim) delim = w;
    }
    return url.slice(start, delim);
}

/** SplitResult.hostname for `urlparse(url)`; throws where python throws.
 *  python's urlparse accepts a bytes URL too (_coerce_args: ascii/strict
 *  decode up front, every result field re-encoded ascii/strict), so the str
 *  and Buffer channels run the SAME algorithm and the result is handed back
 *  in the caller's type: null / str for str input, null / Buffer for bytes
 *  input. A non-ASCII byte raises UnicodeDecodeError where python raises it. */
function pyUrlHostname(url: unknown): string | Buffer | null {
    if (typeof url !== "string" && !Buffer.isBuffer(url)) {
        throw new AttributeErrorP(
            `'${pyTypeName(url)}' object has no attribute 'lstrip'`);
    }
    if (Buffer.isBuffer(url)) {
        for (let i = 0; i < url.length; i++) {
            const byte = url[i] as number;
            if (byte >= 0x80) {
                throw new UnicodeDecodeErrorP(
                    `'ascii' codec can't decode byte 0x${byte.toString(16).padStart(2, "0")}` +
                    ` in position ${i}: ordinal not in range(128)`);
            }
        }
        // recursion on the decoded str; that channel only returns str | null
        const host = pyUrlHostname(url.toString("latin1"));
        if (host !== null && typeof host === "string") return Buffer.from(host, "ascii");
        return null;
    }
    // urlsplit(): lstrip WHATWG C0-control-or-space, then drop tab/CR/LF.
    let s = url.replace(/^[\x00-\x1f ]+/, "");
    for (const b of ["\t", "\r", "\n"]) s = s.split(b).join("");
    let rest = s;
    const colon = s.indexOf(":");
    if (colon > 0) {
        const c0 = s.charAt(0);
        if (pyIsAscii(c0) && /[a-zA-Z]/.test(c0)) {
            let schemeShape = true;
            for (const c of s.slice(0, colon)) {
                if (!_SCHEME_CHARS.includes(c)) { schemeShape = false; break; }
            }
            if (schemeShape) rest = s.slice(colon + 1);
        }
    }
    let netloc = "";
    if (rest.startsWith("//")) {
        netloc = splitnetloc(rest, 2);
        if ((netloc.includes("[") && !netloc.includes("]"))
            || (netloc.includes("]") && !netloc.includes("["))) {
            throw new ValueErrorP("Invalid IPv6 URL");
        }
        if (netloc.includes("[") && netloc.includes("]")) checkBracketedNetloc(netloc);
    }
    checkNetloc(netloc);
    // SplitResult._hostinfo + .hostname
    const hostinfo = pyRPartition(netloc, "@")[2];
    const [, haveOpenBr, bracketed] = pyPartition(hostinfo, "[");
    const hostname = haveOpenBr ? pyPartition(bracketed, "]")[0] : pyPartition(hostinfo, ":")[0];
    if (!hostname) return null;
    // scoped IPv6 keeps its zone id, which must not be lowercased
    const [hostPart, percent, zone] = pyPartition(hostname, "%");
    return hostPart.toLowerCase() + percent + zone;
}

// ── urllib.request.Request ───────────────────────────────────────────────────

/** urllib.parse.unwrap: '<URL:http://a/>' → 'http://a/'; unchanged otherwise. */
function pyUnwrap(url: unknown): string {
    let s = pyStrip(pyStr(url));
    if (s.startsWith("<") && s.endsWith(">")) s = pyStrip(s.slice(1, -1));
    if (s.startsWith("URL:")) s = pyStrip(s.slice(4));
    return s;
}

/** Request.full_url setter+getter: unwrap(), then _splittag — (path, frag)
 *  with frag None when there is no '#', "" for a trailing '#'. The getter
 *  rejoins `path#frag` only when frag is TRUTHY, so a trailing '#' is lost
 *  while an inner '#' (tag may itself contain '#') survives. */
function requestFullUrl(url: unknown): string {
    const unwrapped = pyUnwrap(url);
    const i = unwrapped.indexOf("#");
    if (i < 0) return unwrapped;
    const path = unwrapped.slice(0, i);
    const tag = unwrapped.slice(i + 1);
    return tag ? `${path}#${tag}` : path;
}

/** urllib.request._splittype: `<scheme>:` with no '/' before the colon. */
function splitType(url: string): string | null {
    const m = /^([^/:]+):/.exec(url);
    return m ? m[1]!.toLowerCase() : null;
}

/** python's `dict(headers or {})`, including its errors. Returns a Map so a
 *  non-string key survives as itself: python's `{1: "a"}` keeps an int key and
 *  dies on `key.capitalize()` — a JS object would silently string it. The
 *  parity probe passes a Map to speak for a python dict with an int key. */
function pyDictCopy(headers: unknown): Map<unknown, unknown> {
    if (!pyTruth(headers)) return new Map();
    if (headers instanceof Map) return new Map(headers);
    if (isPyDict(headers)) return new Map(Object.entries(headers as Record<string, unknown>));
    if (Array.isArray(headers)) {
        const out = new Map();
        for (let i = 0; i < headers.length; i++) {
            const item = headers[i];
            const pair = Array.isArray(item) ? item : (typeof item === "string" ? item.split("") : null);
            if (!pair || pair.length !== 2) {
                const len = pair === null ? 0 : pair.length;
                throw new ValueErrorP(
                    `dictionary update sequence element #${i} has length ${len}; 2 is required`);
            }
            out.set(pair[0], pair[1]);
        }
        return out;
    }
    if (typeof headers === "string") {
        throw new ValueErrorP(
            `dictionary update sequence element #0 has length 1; 2 is required`);
    }
    throw new TypeErrorP(`'${pyTypeName(headers)}' object is not iterable`);
}

export interface WoUrlRequest {
    /** python: `req.full_url` */
    url: string;
    /** python: `req.headers` — keys already `.capitalize()`d, insertion order kept */
    headers: JsonDict;
    /** python: `req.data` */
    data: unknown;
    /** python: `req.method` — only set when the keyword was truthy */
    method: unknown;
    /** python: `req.get_method()` */
    resolvedMethod: unknown;
    /** python: `req.type` */
    type: string | null;
}

/** urllib.request.Request(url, headers=..., data=..., method=...). */
function pyBuildRequest(url: unknown, headers: unknown, data: unknown, method: unknown): WoUrlRequest {
    const full = requestFullUrl(url);
    const type = splitType(full);
    if (type === null) throw new ValueErrorP(`unknown url type: ${pyRepr(full)}`);
    const hdrs: JsonDict = {};
    const copied = pyDictCopy(pyOr(headers, {}));
    for (const [key, value] of copied.entries()) {
        if (typeof key !== "string") {
            throw new AttributeErrorP(`'${pyTypeName(key)}' object has no attribute 'capitalize'`);
        }
        hdrs[pyCapitalize(key)] = value;
    }
    const hasMethod = pyTruth(method);
    const resolved = hasMethod ? method : (data !== null && data !== undefined ? "POST" : "GET");
    return { url: full, headers: hdrs, data, method: hasMethod ? method : null, resolvedMethod: resolved, type };
}

// ── 测试缝（storage / 加密器 / 出口策略 / urllib / 错误格式化） ──────────────

/** python `get_storage()` 在本模块用到的两个方法。 */
export type OutboundStorage = {
    kv_get(key: string, ns?: string, defaultValue?: unknown): unknown;
    kv_set(key: string, value: unknown, ns?: string): unknown;
};

/** python `get_egress_policy()` 的返回值在本模块用到的一个方法。
 *  bytes URL 时 check_egress 传给它的 host 是 Buffer（python 侧是 bytes）。 */
export type EgressPolicyLike = {
    check(hosts: (string | Buffer)[]): unknown;
};

export type WoOpener = {
    open(req: WoUrlRequest, timeout: unknown): unknown | Promise<unknown>;
};

export const WEB_OUTBOUND_SEAMS = {
    /**
     * python `from storage import get_storage` —— import 与调用是两件事：
     * import 失败（ModuleNotFoundError/ImportError）在 get_outbound_settings 的
     * try 里被吞掉，在 set_outbound_settings 里直接抛出，而 import 本身不可观察。
     * 所以这里返回"取 storage 的函数"，调用点与 python 一一对应。
     */
    import_storage: (): (() => OutboundStorage) => _realGetStorage as unknown as (() => OutboundStorage),
    /** python `from model_registry import CredentialCipher; CredentialCipher()`。 */
    cipherFactory: (): CredentialCipherLike =>
        new _RealCredentialCipher() as unknown as CredentialCipherLike,
    /** python `from tools import format_tool_error`。 */
    format_tool_error: (message: string, suggestion?: string, recovery?: string): string =>
        _realFormatToolError(message, suggestion, recovery),
    /** python `get_egress_policy()`（模块级晚绑定 → monkeypatch 缝）。 */
    get_egress_policy: (): EgressPolicyLike =>
        _realGetEgressPolicy() as unknown as EgressPolicyLike,
    /** python `urllib.parse.urlparse(url).hostname` — bytes URL keeps the
     *  result a Buffer (SplitResultBytes.hostname), mirroring python. */
    hostname: (url: unknown): string | Buffer | null => pyUrlHostname(url),
    /** python `urllib.request.Request(...)`。 */
    build_request: (url: unknown, headers: unknown, data: unknown, method: unknown): WoUrlRequest =>
        pyBuildRequest(url, headers, data, method),
    /** python `urllib.request.build_opener(ProxyHandler(proxies))`。 */
    build_proxy_opener: (proxyUrl: string, proxies: Record<string, string>): WoOpener => ({
        open: (req, timeout) => WEB_OUTBOUND_SEAMS.urlopen(req, timeout, proxyUrl),
    }),
    /** python `urllib.request.urlopen(req, timeout=timeout)`。 */
    urlopen: async (req: WoUrlRequest, timeout: unknown, _proxyUrl?: string | null): Promise<unknown> => {
        const controller = new AbortController();
        const ms = Number(timeout) * 1000;
        const timer = Number.isFinite(ms) && ms > 0 ? setTimeout(() => controller.abort(), ms) : null;
        try {
            const body = req.data === null || req.data === undefined
                ? undefined
                : (typeof req.data === "string" ? req.data : Buffer.isBuffer(req.data) ? req.data : pyStr(req.data));
            const init: RequestInit = {
                method: pyStr(req.resolvedMethod),
                headers: req.headers as Record<string, string>,
                signal: controller.signal,
            };
            if (body !== undefined && init.method !== "GET" && init.method !== "HEAD") init.body = body;
            const resp = await fetch(req.url, init);
            const buf = Buffer.from(await resp.arrayBuffer());
            return { read: () => buf, status: resp.status };
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    },
};

type CredentialCipherLike = {
    encrypt(plaintext: string): string;
    decrypt(stored: string): string;
};

// ── 设置存取 ─────────────────────────────────────────────────────────────────

export const _KV_NS = "network_outbound";
export const _KV_PROXY = "proxy_url";
export const _KV_TAVILY = "tavily_key";

/** 出口策略拒绝本次请求。`String(exc)` 即给模型看的三段式错误。 */
export class EgressBlocked extends RuntimeErrorP {
    constructor(msg: string) {
        super(msg);
        this.name = "EgressBlocked";
    }
}

/**
 * 读取出站设置。任何失败都按"未配置"处理（fail-open）。
 *
 * python 的两个 try 各自 import 一次 storage：第二次失败不会吃掉第一次读到的
 * proxy_url，所以这里也必须是两次独立的取用。
 */
export function get_outbound_settings(): { proxy_url: string; tavily_key: string } {
    if (arguments.length > 0) throw pyTooMany("get_outbound_settings", "0", arguments.length);
    const out: { proxy_url: string; tavily_key: string } = { proxy_url: "", tavily_key: "" };
    try {
        const getStorage = WEB_OUTBOUND_SEAMS.import_storage();
        const proxy = getStorage().kv_get(_KV_PROXY, _KV_NS);
        if (typeof proxy === "string") out.proxy_url = pyStrip(proxy);
    } catch {
        /* pass */
    }
    try {
        const getStorage = WEB_OUTBOUND_SEAMS.import_storage();
        const sealed = getStorage().kv_get(_KV_TAVILY, _KV_NS);
        if (typeof sealed === "string" && pyTruth(sealed)) {
            out.tavily_key = WEB_OUTBOUND_SEAMS.cipherFactory().decrypt(sealed);
        }
    } catch {
        /* pass */
    }
    return out;
}

/** 写设置。传 None = 不动该项；空串 = 清除该项。两个形参都有默认值，
 *  所以 CPython 的超员文案是 "takes from 0 to 2 positional arguments"。 */
export function set_outbound_settings(proxyUrl?: unknown, tavilyKey?: unknown): void {
    if (arguments.length > 2) throw pyTooManyRange("set_outbound_settings", 0, 2, arguments.length);
    const getStorage = WEB_OUTBOUND_SEAMS.import_storage();
    if (proxyUrl !== null && proxyUrl !== undefined) {
        getStorage().kv_set(_KV_PROXY, pyStripped(proxyUrl), _KV_NS);
    }
    if (tavilyKey !== null && tavilyKey !== undefined) {
        let key = pyStripped(tavilyKey);
        if (pyTruth(key)) key = WEB_OUTBOUND_SEAMS.cipherFactory().encrypt(key);
        getStorage().kv_set(_KV_TAVILY, key, _KV_NS);
    }
    return undefined;
}

// ── 代理 ─────────────────────────────────────────────────────────────────────

/**
 * 配置了代理就返回显式 opener；没配置返回 None（走 urllib 默认——默认行为
 * 本身就读环境变量与系统代理，不能反而把它弄丢）。
 */
export function _opener(): WoOpener | null {
    if (arguments.length > 0) throw pyTooMany("_opener", "0", arguments.length);
    const proxyUrl = get_outbound_settings().proxy_url;
    if (!pyTruth(proxyUrl)) return null;
    return WEB_OUTBOUND_SEAMS.build_proxy_opener(proxyUrl, { http: proxyUrl, https: proxyUrl });
}

// ── 出口策略 ─────────────────────────────────────────────────────────────────

/** 对目标 URL 做出口策略检查。拒绝时返回给模型的错误文本，放行返回 None。 */
export function check_egress(url: unknown, ...extra: unknown[]): string | null {
    if (arguments.length === 0) throw pyMissing("check_egress", ["url"]);
    if (extra.length > 0) throw pyTooMany("check_egress", "1", 1 + extra.length);
    const formatToolError = WEB_OUTBOUND_SEAMS.format_tool_error;
    let host: string | Buffer;
    try {
        // python: host = (urlparse(url).hostname or "").lower() — the None arm
        // of `or` is the null arm here (a parsed-empty hostname is None in
        // python and null in the port, never "").
        const hn = WEB_OUTBOUND_SEAMS.hostname(url);
        host = pyLower(hn === null ? "" : hn);
    } catch {
        host = "";
    }
    if (!pyTruth(host)) return null;   // 解析不出 host 的畸形 URL 交给 urllib 自己报错
    let outcome: unknown;
    try {
        outcome = WEB_OUTBOUND_SEAMS.get_egress_policy().check([host]);
    } catch {
        return null;   // fail-open: 策略子系统故障不拦正常请求
    }
    if (!pyTruth(outcome)) return null;
    const [verdictRaw, hitRaw] = pyUnpack2(outcome);
    const verdict = pyStr(verdictRaw);
    if (verdict === "restricted") {
        // hit 是策略返回的第二项——一个 [host, rule] 列表，python 用列表 repr 渲染它
        return formatToolError(
            `网络出口策略拦截：${pyStr(hitRaw)} 在永不访问名单中`,
            "该域名被设置页的「永不访问」名单禁止；确认名单无误",
            "如确需访问，请在 设置 → 安全与权限 → 上网权限 中移除该条目",
        );
    }
    // closed 模式白名单未命中。与 shell 路径的 REVIEW→审批卡不同：
    // 工具内置请求没有审批卡可弹，这里只能是"拒绝 + 指路"。
    // bytes URL 时 python 插值 str(host)＝repr，模型看到的是 b'a.b'。
    return formatToolError(
        `网络出口为白名单模式：${pyStr(host)} 不在允许访问名单中`,
        "把该域名加入 设置 → 安全与权限 → 上网权限 的允许访问名单",
        "或将上网权限切回「默认放行」模式",
    );
}

// ── 统一入口 ─────────────────────────────────────────────────────────────────

export type OpenUrlOpts = {
    timeout?: number;
    headers?: unknown;
    data?: unknown;
    method?: unknown;
};

/**
 * 工具内 HTTP 出站唯一入口。被策略拦截时抛 EgressBlocked（String 即错误文本）。
 *
 * 返回 urlopen 风格的响应对象（`{read(), status}`）。python 是同步的，端口按
 * 本仓既有先例（mcp_oauth / browser_agent）返回 Promise —— 见头部 DIVERGENCE。
 */
export async function open_url(url: unknown, opts?: OpenUrlOpts): Promise<unknown> {
    if (arguments.length === 0) throw pyMissing("open_url", ["url"]);
    if (arguments.length > 2) throw pyTooMany("open_url", "1", arguments.length);
    if (arguments.length === 2 && !isPyDict(opts)) throw pyTooMany("open_url", "1", 2);
    const kw = (opts === null || opts === undefined) ? {} as Required<OpenUrlOpts> : opts as Required<OpenUrlOpts>;
    const timeout = kw.timeout === undefined ? 10 : kw.timeout;
    const headers = kw.headers === undefined ? null : kw.headers;
    const data = kw.data === undefined ? null : kw.data;
    const method = kw.method === undefined ? null : kw.method;
    const block = check_egress(url);
    if (pyTruth(block)) throw new EgressBlocked(pyStr(block));
    const req = WEB_OUTBOUND_SEAMS.build_request(url, headers, data, method);
    const opener = _opener();
    if (opener !== null) return opener.open(req, timeout);
    return WEB_OUTBOUND_SEAMS.urlopen(req, timeout);
}

// PORT STATUS: confidence=high todos=[0]
