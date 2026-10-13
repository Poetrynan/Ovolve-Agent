/**
 * _activity_child.ts — the child-process side of activity_exec.
 *
 * Ported from `app/backend/_activity_child.py` (109 file lines / 33 manifest
 * code lines, sha256_16 134200dcf8012179 — STRICTLY READ-ONLY; CPython is the
 * judge for every face below).
 *
 * A fresh runtime that does exactly one thing: read a spec, resolve a function,
 * call it once with `(args, context)`, write the result to stdout as a
 * `@@ACTIVITY_RESULT@@` sentinel line, and exit immediately. Any `print` the
 * tool itself makes appears before the sentinel, and the parent only reads the
 * LAST sentinel line, so interleaved output is harmless.
 *
 * On a crash (import failure, segfault, kill) there is no sentinel line — the
 * exit code and stderr are the whole truth, and the parent reports the effect
 * as unknown rather than inventing a failure.
 *
 * RULEBOOK CITATIONS
 *   §0  the process boundary is preserved: this stays a separate process, it
 *       does not become an in-process call.
 *   §2  `except BaseException` -> the catch is broad on purpose; see below.
 *   §2  sentinel returns: the exit codes 0/1/2 are a contract, reproduced.
 *   §4  naming: app/backend/_activity_child.py -> app/engine/_activity_child.ts
 *   §M  every CPython semantic primitive (truthiness `or`, `str()`, `repr()`,
 *       type names, dict/get/subscript access, exception mirrors, UTF-8 byte
 *       counting) is IMPORTED from the single-source mirror layer
 *       `./server/http_server_keys.js` - no private copy of py_strip/ntpath/
 *       truthiness lives in this file.
 *
 * CALL-SITE PROTOCOL NOTES (evidence: tmp/actc_oracle_facts.json, printed by
 * tmp/actc_oracle_py.py under the pinned CPython 3.13.12):
 *   - the source serialises with `json.dumps(obj, ensure_ascii=False,
 *     default=str)` using json.dumps DEFAULT separators (`", "` / `": "`), and
 *     allow_nan is at its default True, so NaN/Infinity/−Infinity emit as the
 *     bare literals `NaN` / `Infinity` / `-Infinity`. §M's `py_json_dumps`
 *     mirrors a DIFFERENT call site (the http_server one, where non-finite
 *     values raise), so the encoder below is this call site's own faithful
 *     mirror built ON TOP OF the §M primitives (py_str / py_type_name), not a
 *     re-implementation of any §M export. Float spelling follows CPython
 *     `repr`: scientific when the decimal point sits outside
 *     `[-3, 16]` (oracle O2_floats: 1e16 -> "1e+16", 1e15 -> "1000000000000000.0",
 *     1e-5 -> "1e-05", 0.0001 -> "0.0001"); §M's py_float_repr predates the
 *     1e16..1e20 exponent switch and is not used for this gate.
 *   - the truncation message counts CODE POINTS (`len(encoded)` in Python);
 *     the size gate counts UTF-8 BYTES (`len(encoded.encode("utf-8", "replace"))`).
 *   - `str(getattr(result, "error", "") or "")` is CPython `or` (falsy -> ""),
 *     `bool(result.ok)` is CPython truthiness (`[]`, `{}`, `0`, `""`, None are
 *     falsy; NaN is truthy) — both through §M's py_or / py_truth.
 *   - a tool RESULT is detected structurally with hasattr semantics: class
 *     instances carry attributes; JSON data faces (plain object = py dict,
 *     array = py list, Set = py set, Uint8Array = py bytes) carry NONE — a
 *     dict `{"ok":..,"error":..}` is a BARE value in CPython (oracle
 *     O12_default_str.hasattr_dict), and `hasattr(x, "ok")` on primitives is
 *     False. Ported tool results therefore model py objects as JS class
 *     instances and py data as JSON data - the same fixture law the passing
 *     evobri/capabilities siblings use.
 *   - import failure wording (oracle O5_import): empty name ->
 *     `ValueError: Empty module name`; a dotted name whose first segment is
 *     not importable -> `ModuleNotFoundError: No module named '<first>'`; a
 *     dotted name whose parent IS a loaded module (never a package here) ->
 *     `ModuleNotFoundError: No module named '<full>'` (oracle
 *     O5_import.parent_loaded_child_missing). On Windows the module finder is
 *     case-SENSITIVE even though the file system is not (oracle
 *     O5_import.upper_missing), so the resolved file's real name must match.
 *   - spec decoding mirrors CPython json's error wording and CODE-POINT
 *     positions (oracle O8_decode); strict mode rejects control characters in
 *     strings, and NaN/Infinity literals are accepted as floats.
 *   - arity of the tool call (oracle O7_arity): the source calls
 *     `fn(args, context)`; CPython rejects a wrong count BEFORE the body runs
 *     with `'<qualname>() takes N positional argument(s) but M were given'` /
 *     `'... missing 1 required positional argument: <repr>'` / for a class
 *     without `__init__`: `'ActcCls() takes no arguments'`. The mirror below
 *     reads the declared parameter list (fixture law: plain identifiers, no
 *     defaults, no *args/**kwargs — every tool face obeys it) and reproduces
 *     the wording using the spec's qualname, exactly like CPython's
 *     `__qualname__` does.
 *
 * Deliberately OUT of the compared contract (recorded in tmp/actc_STATE.md,
 * NOT silently ignored): py function objects as tool results (`str(fn)`
 * carries a memory address), lone surrogates in values (encode(..., "replace")
 * byte math is platform detail), py ints beyond IEEE-double precision,
 * non-string dict key order (JSON faces only ever carry string keys), and
 * canonical-INTEGER dict key order: a JS object forces numeric-ascending
 * order for integer-like string keys where CPython keeps insertion order —
 * the mirror layer models py dicts as JS objects (shared §M law), so the
 * case table carries no integer-like keys; every ORDINARY key order the
 * gate does exercise is insertion order (oracle O12_default_str.key_order
 * style faces with string keys). INDIFFERENTIABLE-FLOAT faces are also out:
 * an integral-valued py float (3.0, -0.0, 1e16, 1e21) collapses onto the int
 * face in the JS number model — the shared §M convention is
 * `Number.isInteger(x) ? String(x) : py_float_repr(x)` — so the case table
 * carries non-integral float faces only (0.1, 1e-05, 5e-324, NaN/Infinity
 * bare literals, ...), which the repr switch above mirrors exactly.
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModuleNotFoundErrorP,
  PyExcP,
  PyKeyError,
  PyOSErrorP,
  PyTypeErrorP,
  exc_str,
  py_dict_get,
  py_getattr_or,
  py_or,
  py_repr,
  py_str,
  py_truth,
  py_type_name,
  utf8_encode_strict,
} from "./server/http_server_keys.js";

/** The line prefix the parent scans for. Never change this — it is a wire contract. */
export const RESULT_SENTINEL = "@@ACTIVITY_RESULT@@";

/** 1 MB, matching the source's 1_000_000-byte gate. */
const MAX_PAYLOAD_BYTES = 1_000_000;

/* ── §M-consistent exception mirrors §M does not export (subclass of §M bases) */

class PyValueErrorP extends PyExcP {
  constructor(message: string) {
    super("ValueError", message);
  }
}

/** `FileNotFoundError` (OSError subclass; str(exc) == "[Errno 2] ...: '<path>'"). */
class PyFileNotFoundErrorP extends PyOSErrorP {
  constructor(pathRepr: string) {
    super(`[Errno 2] No such file or directory: ${pathRepr}`);
    this.pyName = "FileNotFoundError";
    this.name = "FileNotFoundError";
  }
}

/** `json.JSONDecodeError` (a ValueError subclass; carries CPython wording). */
class PyJSONDecodeErrorP extends PyExcP {
  constructor(message: string) {
    super("JSONDecodeError", message);
  }
}

/**
 * `ModuleNotFoundError` with CPython's `; '<parent>' is not a package` tail
 * (oracle O5_import.parent_loaded_child_missing): raised when the dotted name's
 * parent IS an importable module but is not a package.
 */
class PyModuleNotAPackageP extends PyExcP {
  constructor(fullName: string, parentName: string) {
    super("ModuleNotFoundError", `No module named '${fullName}'; '${parentName}' is not a package`);
  }
}

/* ── type(exc).__name__ / str(exc) mirrors (§M exception faces) ────────────── */

function pyExcName(e: unknown): string {
  if (e instanceof PyExcP) return e.pyName;
  if (e instanceof PyKeyError) return "KeyError";
  if (e instanceof Error) {
    if (typeof e.name === "string" && e.name !== "Error") return e.name;
    return (e.constructor && e.constructor.name) || "Error";
  }
  return py_type_name(e);
}

function pyExcStr(e: unknown): string {
  // CPython: str(KeyError('k')) == repr('k') == "'k'" (the class name is NOT
  // part of str()); §M's PyKeyError keeps that repr in .keyText.
  if (e instanceof PyKeyError) return e.keyText;
  return exc_str(e);
}

/* ── json.dumps(obj, ensure_ascii=False, default=str), call-site faithful ─── */

/** python len(s): CODE POINTS, not UTF-16 units. */
function cpsLen(s: string): number {
  return Array.from(s).length;
}

/** CPython repr(float) for finite doubles, via JS shortest-round-trip digits. */
function pyFloatRepr(x: number): string {
  if (Object.is(x, -0)) return "-0.0";
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x) + ".0";
  const s = String(x);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return s;
  const sign = m[1] || "";
  const intp = m[2] || "0";
  const frac = m[3] || "";
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  let digits = intp + frac;
  let decpt = intp.length + exp;
  while (digits.length > 1 && digits.startsWith("0")) {
    digits = digits.slice(1);
    decpt -= 1;
  }
  while (digits.length > 1 && digits.endsWith("0")) digits = digits.slice(0, -1);
  if (decpt < -3 || decpt > 16) {
    const e = decpt - 1;
    const mant = digits.length > 1 ? digits.slice(0, 1) + "." + digits.slice(1) : digits;
    return sign + mant + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
  }
  if (decpt <= 0) return sign + "0." + "0".repeat(-decpt) + digits;
  if (decpt >= digits.length) return sign + digits + "0".repeat(decpt - digits.length) + ".0";
  return sign + digits.slice(0, decpt) + "." + digits.slice(decpt);
}

function jsonNumber(x: number): string {
  if (Number.isNaN(x)) return "NaN"; // allow_nan=True default (oracle O2_floats)
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (Number.isInteger(x)) return String(x);
  return pyFloatRepr(x);
}

/** py_encode_basestring with ensure_ascii=False (oracle O3_strings). */
function pyJsonQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const c = ch.codePointAt(0) as number;
      if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
      else out += ch;
    }
  }
  return out + '"';
}

/**
 * `json.dumps(v, ensure_ascii=False, default=str)` with the DEFAULT separators
 * (`", "` / `": "`). Non-JSON data faces (class instances = py objects,
 * Set = py set, Uint8Array = py bytes, Map = py dict-with-repr-face) fall
 * through to `default=str` via §M's py_str. Cycles raise the CPython wording.
 */
function dumpsPy(v: unknown): string {
  const seen = new WeakSet<object>();
  const enc = (x: unknown): string => {
    if (x === null || x === undefined) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") return jsonNumber(x);
    if (typeof x === "string") return pyJsonQuote(x);
    if (typeof x === "function") return pyJsonQuote(py_str(x));
    const o = x as object;
    if (Array.isArray(o)) {
      if (seen.has(o)) throw new PyValueErrorP("Circular reference detected");
      seen.add(o);
      const body = o.map(enc).join(", ");
      seen.delete(o);
      return "[" + body + "]";
    }
    const isPlainData =
      o instanceof Map
        ? false
        : Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null;
    if (!isPlainData) {
      // py object / set / bytes / anything json cannot encode: default=str
      return pyJsonQuote(py_str(x));
    }
    if (seen.has(o)) throw new PyValueErrorP("Circular reference detected");
    seen.add(o);
    const parts = Object.keys(o).map((k) => pyJsonQuote(k) + ": " + enc((o as Record<string, unknown>)[k]));
    seen.delete(o);
    return "{" + parts.join(", ") + "}";
  };
  return enc(v);
}

/* ── json.load(text) mirror: CPython wording + code-point positions ───────── */

function decodePosAt(doc: string[], end: number): string {
  let lineno = 1;
  for (let i = 0; i < end; i++) if (doc[i] === "\n") lineno++;
  let last = 0;
  for (let i = 0; i < end; i++) if (doc[i] === "\n") last = i + 1;
  const colno = end - last + 1;
  return `line ${lineno} column ${colno} (char ${end})`;
}

function errAt(err: string, doc: string[], pos: number): never {
  throw new PyJSONDecodeErrorP(`${err}: ${decodePosAt(doc, pos)}`);
}

const WS_JSON = new Set([" ", "\t", "\n", "\r"]);

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};

const JSON_LITERALS: Array<[string, unknown]> = [
  ["true", true], ["false", false], ["null", null],
  ["-Infinity", -Infinity], ["Infinity", Infinity], ["NaN", NaN],
];

/** CPython json (strict=True, default parse of NaN/Infinity) - mirrors O8_decode. */
function pyJsonLoadText(text: string): unknown {
  const doc = Array.from(text); // code-point array: positions match CPython chars
  const n = doc.length;
  const at = (i: number): string => (i >= 0 && i < n ? (doc[i] as string) : "");

  function skipWs(i: number): number {
    while (i < n && WS_JSON.has(at(i))) i++;
    return i;
  }
  function parseString(i: number): [string, number] {
    // at(i) === '"'
    let j = i + 1;
    let out = "";
    for (;;) {
      if (j >= n) errAt("Unterminated string starting at", doc, i);
      const c = at(j);
      if (c === '"') return [out, j + 1];
      if (c === "\\") {
        if (j + 1 >= n) errAt("Unterminated string starting at", doc, i);
        const e = at(j + 1);
        const esc = SIMPLE_ESCAPES[e];
        if (esc !== undefined) {
          out += esc;
          j += 2;
        } else if (e === "u") {
          const hex = doc.slice(j + 2, j + 6).join("");
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) errAt("Invalid \\uXXXX escape", doc, j);
          out += String.fromCharCode(parseInt(hex, 16));
          j += 6;
        } else errAt("Invalid \\escape", doc, j);
      } else if ((c.codePointAt(0) as number) < 0x20) {
        errAt("Invalid control character at", doc, j);
      } else {
        out += c;
        j += 1;
      }
    }
  }
  function parseValue(i0: number): [unknown, number] {
    const i = i0;
    if (i >= n) errAt("Expecting value", doc, i);
    const c = at(i);
    // CPython scan_once's switch raises the BOM error at the value position
    // (after leading whitespace), wording + char from oracle O8_decode.bom.
    if (c === "\ufeff") errAt("Unexpected UTF-8 BOM (decode using utf-8-sig)", doc, i);
    if (c === '"') {
      const [s, j] = parseString(i);
      return [s, j];
    }
    if (c === "{") return parseObject(i + 1);
    if (c === "[") return parseArray(i + 1);
    for (const [lit, val] of JSON_LITERALS) {
      if (doc.slice(i, i + lit.length).join("") === lit) return [val, i + lit.length];
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i;
      if (at(j) === "-") j++;
      while (j < n && at(j) >= "0" && at(j) <= "9") j++;
      if (j < n && at(j) === ".") {
        j++;
        while (j < n && at(j) >= "0" && at(j) <= "9") j++;
      }
      if (j < n && (at(j) === "e" || at(j) === "E")) {
        j++;
        if (at(j) === "+" || at(j) === "-") j++;
        while (j < n && at(j) >= "0" && at(j) <= "9") j++;
      }
      const numText = doc.slice(i, j).join("");
      if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(numText)) errAt("Expecting value", doc, i);
      return [Number(numText), j];
    }
    errAt("Expecting value", doc, i);
  }
  function parseObject(i0: number): [Record<string, unknown>, number] {
    const obj: Record<string, unknown> = {};
    let i = i0;
    i = skipWs(i);
    if (at(i) === "}") return [obj, i + 1];
    for (;;) {
      i = skipWs(i);
      if (at(i) !== '"') errAt("Expecting property name enclosed in double quotes", doc, i);
      const [key, i1] = parseString(i);
      i = skipWs(i1);
      if (at(i) !== ":") errAt("Expecting ':' delimiter", doc, i);
      i = skipWs(i + 1);
      const [val, i2] = parseValue(i);
      obj[key] = val; // duplicate keys: last wins, like CPython
      i = skipWs(i2);
      if (at(i) === "}") return [obj, i + 1];
      if (at(i) !== ",") errAt("Expecting ',' delimiter", doc, i);
      i = skipWs(i + 1);
      if (at(i) === "}") errAt("Trailing comma not allowed", doc, i);
    }
  }
  function parseArray(i0: number): [unknown[], number] {
    const arr: unknown[] = [];
    let i = i0;
    i = skipWs(i);
    if (at(i) === "]") return [arr, i + 1];
    for (;;) {
      const [val, i1] = parseValue(skipWs(i));
      arr.push(val);
      i = skipWs(i1);
      if (at(i) === "]") return [arr, i + 1];
      if (at(i) !== ",") errAt("Expecting ',' delimiter", doc, i);
      i = skipWs(i + 1);
      if (at(i) === "]") errAt("Trailing comma not allowed", doc, i);
    }
  }

  const [value, end] = parseValue(skipWs(0));
  const tail = skipWs(end);
  // CPython reports "Extra data" at the first NON-WS char after the value
  // (oracle O8_decode.extra_ws: '{"a": 1} x' -> char 9, not the raw end 8).
  if (tail !== n) errAt("Extra data", doc, tail);
  return value;
}

/* ── spec subscript / dict faces (source: spec["module"], spec.get("args")) ── */

/** `d[k]` on the json.load face: dict hit / KeyError / per-type TypeError wording. */
function pySubscript(obj: unknown, key: string): unknown {
  if (Array.isArray(obj)) throw new PyTypeErrorP("list indices must be integers or slices, not str");
  if (typeof obj === "string") throw new PyTypeErrorP("string indices must be integers, not 'str'");
  if (obj !== null && typeof obj === "object" && !(obj instanceof Map) && !(obj instanceof Set) && !(obj instanceof Uint8Array)) {
    const rec = obj as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, key)) throw new PyKeyError(py_repr(key));
    return rec[key];
  }
  throw new PyTypeErrorP(`'${py_type_name(obj)}' object is not subscriptable`);
}

/* ── _resolve_function: module + dotted qualname -> callable ──────────────── */

function isClassFn(f: Function): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(f));
}

/**
 * The importable engine root: the source imports flat from its own directory
 * (sys.path.insert(0, backend_dir)); the port imports from the engine dir
 * beside it. Sandbox note: the probe imports the EMITTED copy from
 * tmp/<prefix>_tout, where "../engine/" lands on tmp/engine - the same
 * flat-import shape, one directory up (harness law, see tmp/actc_STATE.md).
 */
function engineUrl(name: string): URL {
  return new URL(`../engine/${encodeURIComponent(name)}.js`, import.meta.url);
}

/** Windows case-insensitive FS must not smuggle a wrong-cased module in. */
function exactCaseExists(name: string): boolean {
  try {
    const u = engineUrl(name);
    const file = fileURLToPath(u);
    if (!fs.existsSync(file)) return false;
    const real = fs.realpathSync.native ? fs.realpathSync.native(file) : fs.realpathSync(file);
    return path.basename(real) === path.basename(file);
  } catch {
    return false;
  }
}

export async function _resolve_function(moduleName: unknown, qualname: unknown): Promise<unknown> {
  // CPython's `importlib.import_module` evaluates `name.startswith('.')` as its
  // FIRST operation, with no type check (importlib/__init__.py). A non-str
  // receiver therefore raises
  //   AttributeError: '<type>' object has no attribute 'startswith'
  // (recorded CPython facts for the resolve_face int/none faces; the source
  // pre-`str()`s spec["module"], so only direct callers can reach this face).
  if (typeof moduleName !== "string") {
    attrErrorWith(`'${py_type_name(moduleName)}' object`, "startswith");
  }
  if (moduleName === "") throw new PyValueErrorP("Empty module name");
  const parts = String(qualname).split(".");
  let mod: Record<string, unknown>;
  try {
    if (!exactCaseExists(moduleName)) throw new Error("not-found");
    mod = (await import(engineUrl(moduleName).href)) as Record<string, unknown>;
  } catch {
    if (moduleName.includes(".")) {
      const parent = moduleName.slice(0, moduleName.indexOf("."));
      if (exactCaseExists(parent)) {
        // parent imports as a plain module, never a package (oracle
        // O5_import.parent_loaded_child_missing): `No module named '<full>';
        // '<parent>' is not a package`.
        throw new PyModuleNotAPackageP(moduleName, parent);
      }
      // CPython reports the first missing segment (oracle O5_import.dotted2).
      throw new ModuleNotFoundErrorP(parent);
    }
    throw new ModuleNotFoundErrorP(moduleName);
  }
  let obj: unknown = mod;
  let isModuleFace = true;
  for (const part of parts) {
    obj = walkAttr(obj, part, moduleName, isModuleFace);
    isModuleFace = false;
  }
  return obj;
}

function walkAttr(obj: unknown, part: string, rootModuleName: string, isModuleFace: boolean): unknown {
  const found = (() => {
    if (isModuleFace) {
      const rec = obj as Record<string, unknown>;
      return typeof obj === "object" && obj !== null && Object.prototype.hasOwnProperty.call(rec, part)
        ? { hit: true, value: rec[part] }
        : { hit: false, value: undefined };
    }
    if (obj === null || obj === undefined) return { hit: false, value: undefined };
    const t = typeof obj;
    if (t !== "object" && t !== "function") return { hit: false, value: undefined };
    // py data faces (dict/list/set/bytes) carry NO attributes for our faces;
    // class instances / functions carry exactly their JS properties.
    if (Array.isArray(obj) || obj instanceof Set || obj instanceof Uint8Array) return { hit: false, value: undefined };
    if (t === "object" && (obj as { constructor?: unknown }).constructor === Object) return { hit: false, value: undefined };
    return nameIn(obj as object, part)
      ? { hit: true, value: (obj as Record<string, unknown>)[part] }
      : { hit: false, value: undefined };
  })();
  if (!found.hit || found.value === undefined) {
    // CPython AttributeError wording per receiver face (oracle O6_getattr):
    //   module 'x' has no attribute 'p'        (module face)
    //   type object 'C' has no attribute 'p'   (class face)
    //   'function' object has no attribute 'p' (plain function face)
    //   'ActcObj' object has no attribute 'p'  (instance / primitive face)
    const subject = isModuleFace
      ? `module '${rootModuleName}'`
      : typeof obj === "function"
        ? isClassFn(obj)
          ? `type object '${obj.name || part}'`
          : "'function' object"
        : `'${py_type_name(obj)}' object`;
    attrErrorWith(subject, part);
  }
  return found.value;
}

function nameIn(o: object, name: string): boolean {
  return name in o;
}

function attrErrorWith(subject: string, part: string): never {
  throw new PyExcWrapperError(subject, part);
}

/** carries CPython's AttributeError wording with the right receiver subject */
class PyExcWrapperError extends PyExcP {
  constructor(subject: string, part: string) {
    super("AttributeError", `${subject} has no attribute '${part}'`);
  }
}

/* ── _to_payload: tool Result -> protocol dict; bare value -> success ─────── */

/**
 * hasattr mirror: only py "object" faces carry attributes. JSON data faces
 * (plain object = dict, array = list, Set, Uint8Array) and primitives do not
 * (oracle O12_default_str.hasattr_dict: hasattr({...},'ok') is False).
 */
function pyHasattr(obj: unknown, name: string): boolean {
  if (obj === null || obj === undefined) return false;
  const t = typeof obj;
  if (t === "function") return name in (obj as object);
  if (t !== "object") return false;
  if (Array.isArray(obj) || obj instanceof Set || obj instanceof Uint8Array) return false;
  if ((obj as { constructor?: unknown }).constructor === Object) return false; // dict face
  if (obj instanceof Map) return false; // dict face (Map models py dict where used)
  return name in (obj as object);
}

export function _to_payload(result: unknown): string {
  let value: unknown;
  let error: string;
  let ok: boolean;
  if (pyHasattr(result, "ok") && pyHasattr(result, "error")) {
    value = py_getattr_or(result, "value", null);
    error = py_str(py_or(py_getattr_or(result, "error", ""), ""));
    ok = py_truth((result as { ok: unknown }).ok);
  } else {
    value = result;
    error = "";
    ok = true;
  }
  let encoded = dumpsPy({ ok, value, error });
  if (utf8_encode_strict(encoded).length > MAX_PAYLOAD_BYTES) {
    // second gate: the tool layer should have truncated; report the ORIGINAL
    // encoding's CODE-POINT length, exactly like the source's f-string.
    encoded = dumpsPy({
      ok,
      value: `[activity child: result too large, ${cpsLen(encoded)} bytes truncated]`,
      error,
    });
  }
  return encoded;
}

/* ── the tool call: CPython positional-arity mirror (fixture law above) ───── */

function declaredParams(fn: Function): string[] {
  const src = Function.prototype.toString.call(fn);
  const open = src.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [];
  const inner = src.slice(open + 1, close);
  if (inner.trim() === "") return [];
  return inner.split(",").map((p) => p.trim().split(/[:=\s]/)[0] as string);
}

function callTool(fn: unknown, argvs: unknown[], qualname: string): unknown {
  if (typeof fn !== "function") {
    throw new PyTypeErrorP(`'${py_type_name(fn)}' object is not callable`);
  }
  if (isClassFn(fn)) {
    if (argvs.length > 0) throw new PyTypeErrorP(`${qualname}() takes no arguments`);
    return new (fn as new () => unknown)();
  }
  const params = declaredParams(fn);
  if (argvs.length > params.length) {
    const noun = params.length === 1 ? "argument" : "arguments";
    throw new PyTypeErrorP(
      `${qualname}() takes ${params.length} positional ${noun} but ${argvs.length} were given`,
    );
  }
  if (argvs.length < params.length) {
    const missing = params.slice(argvs.length);
    if (missing.length === 1) {
      throw new PyTypeErrorP(
        `${qualname}() missing 1 required positional argument: ${py_repr(missing[0] as string)}`,
      );
    }
    throw new PyTypeErrorP(`${qualname}() missing ${missing.length} required positional arguments`);
  }
  return (fn as (...a: unknown[]) => unknown)(...argvs);
}

/* ── stdout emission (the sentinel line is the wire) ──────────────────────── */

function emit(body: string): void {
  process.stdout.write(`${RESULT_SENTINEL}${body}\n`);
}

/* ── main: the one-shot child entry, exit codes 0/1/2 are the contract ────── */

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length < 1) {
    // sys.stdout.write(_RESULT_SENTINEL + json.dumps(...) + "\n") then return 2
    emit(dumpsPy({ ok: false, value: null, error: "missing spec path" }));
    return 2;
  }
  const specPath = argv[0] as string;
  let body: string;
  try {
    let text: string;
    try {
      text = fs.readFileSync(specPath, "utf8");
    } catch {
      throw new PyFileNotFoundErrorP(py_repr(specPath));
    }
    const spec = pyJsonLoadText(text);
    const moduleStr = py_str(pySubscript(spec, "module"));
    const qualnameStr = py_str(pySubscript(spec, "qualname"));
    const fn = await _resolve_function(moduleStr, qualnameStr);
    const args = py_or(py_dict_get(spec, "args", null), {});
    const context = py_or(py_dict_get(spec, "context", null), {});
    const result = await callTool(fn, [args, context], qualnameStr);
    body = _to_payload(result);
  } catch (exc) {
    // RULEBOOK §2 (broad swallow, preserved): the source catches BaseException
    // so even a SystemExit from inside the tool reports back instead of dying
    // silently; TS has no SystemExit, the catch stays broad anyway — narrowing
    // it would let a tool's deliberate exit skip the sentinel line and the
    // parent would report "unknown effect" for a failure we could name.
    body = dumpsPy({ ok: false, value: null, error: `${pyExcName(exc)}: ${pyExcStr(exc)}` });
    tryUnlink(specPath);
    emit(body);
    return 1;
  }
  tryUnlink(specPath);
  emit(body);
  return 0;
}

/** Best-effort spec cleanup; failure is fine, the temp directory is the fallback. */
function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* RULEBOOK §2: preserved — the source ignores OSError here. */
  }
}

// RULEBOOK §4: entry point. The source runs under `if __name__ == "__main__"`.
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, "/")) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
