/**
 * memory_condenser.ts — Ovolve Project Memory Condensation Engine (v1.0).
 *
 * Ported from `app/backend/memory_condenser.py` (133 lines, sha16 824896fb0d762f3d).
 * This revision was REWRITTEN from pinned-CPython evidence:
 * `D:/ovolve-migration/tmp/mcond_oracle_facts.json` (interpreter
 * C:/Users/ZhuanZ1/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe).
 *
 * EVIDENCE → BEHAVIOR MAP (face ids are keys of mcond_oracle_facts.json):
 *  · F1_strip_sub / F1b_re_s_faces — `str.strip()` and `re \s` use the CPython
 *    isspace set (PY_ISSPACE from §M): 0x1c-0x1f and 0x85 ARE whitespace,
 *    0x200b (ZWSP) and 0xfeff (BOM) are NOT. JS trim/\s disagree → we use
 *    §M `py_strip` + local `mcond_collapse_ws` (no §M name reuse).
 *  · F2_lstrip_faces / F4_norm_pipeline — the dedup norm is
 *    `re.sub(r"\s+", " ", c.strip().lower().lstrip("- "))` in exactly that
 *    order: strip → py_lower → py_lstrip_chars("- ") → collapse runs to ONE " ".
 *  · F3_lower — `py_lower` (§M, PY_LOWER_PRESERVE 27 codepoints) for U+1C89 etc.
 *  · F5_sort / F17_caps_full.dec_* / F18_bad_items — decisions are ordered by a
 *    binary-insertion mirror of CPython listsort (codepoint compare, stability,
 *    and the exact `'<' not supported between instances of 'str' and 'int'`
 *    operand order for mixed-type dates); `.date` access mirrors AttributeError.
 *  · F6_len / F11_budget — token count is CODE-POINT length based (protocol).
 *  · F7_splitlines / F19_universal_read — text reads do CPython universal-newline
 *    translation (\r\n and lone \r → \n); line counting is splitlines (protocol).
 *  · F8_decode_err — strict UTF-8 decode with the exact CPython UnicodeDecodeError
 *    wording incl. "byte 0x.. in position N" vs "bytes in position S-E",
 *    reasons invalid start/continuation byte + unexpected end of data
 *    (20-sequence rule table in mcond_oracle_facts.json).
 *  · F10_arity — `len > None/str` raises `'>' not supported between instances
 *    of 'int' and 'NoneType'/'str'`; float cap raises the slice wording
 *    "slice indices must be integers or None or have an __index__ method";
 *    non-str item → `'<t>' object has no attribute 'strip'`;
 *    isfile(None/dict/list) → "_path_isfile: path should be string, bytes,
 *    os.PathLike or integer, not <t>".
 *  · F17_caps_full — Python slice quirks: `x[:-0]` is [] while `x[-0:]` is ALL
 *    (max_decisions=0 → zero pruned but the doc is STILL re-sorted), negative
 *    caps slice from the tail and `pruned = len - cap` can exceed len,
 *    True acts as int 1.
 *  · F12_stats_milestone / F13_defaults — stats key set and milestone wording.
 *  · F15_file_* — atomic write uses `filepath + ".tmp.<int(time*1000)>"` then
 *    os.replace; text-mode write translates "\n"→os.linesep (\r\n on Windows,
 *    written_has_crlf=true), second pass is "skipped" once within budget.
 *
 * RULEBOOK CITATIONS
 *   §1  node:fs (atomic write = temp + renameSync == os.replace).
 *   §M  shared CPython mirror layer `./server/http_server_keys.js` is the ONLY
 *       source for py_strip/py_lower/py_lstrip_chars/PY_ISSPACE/py_truth/py_str/
 *       py_iter/exc_str/PyExcP family/utf8_encode_strict — no private copies.
 *   §2  naming: memory_condenser.py → memory_condenser.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";

import {
  PY_ISSPACE,
  PyAttributeErrorP,
  PyExcP,
  PyTypeErrorP,
  exc_str,
  py_iter,
  py_lower,
  py_lstrip_chars,
  py_str,
  py_strip,
  py_truth,
  py_type_name,
  utf8_encode_strict,
} from "./server/http_server_keys.js";

import {
  make_decision_record,
  pmd_parse,
  pmd_to_markdown,
  validate_memory_budget,
  type DecisionRecord,
  type ProjectMemoryDocument,
} from "./project_memory_protocol.js";

/** `UnicodeDecodeError`（§M 只有 Encode 版；此处镜像 Decode 文案族，见 F8）。 */
class McondUnicodeDecodeErrorP extends PyExcP {
  constructor(message: string) {
    super("UnicodeDecodeError", message);
  }
}

/**
 * CPython **位置**调用绑定文案（F10_arity；与 stream_scrubber.ts /
 * token_analytics.ts 的 pyMissing/pyTooManyRange 同一镜像法，本单元自带前缀避免
 * §M 名称冲突）：
 *  · `f()` 少必填 → "f() missing 1 required positional argument: 'doc'"
 *  · 超全部形参 → "f() takes from 1 to 4 positional arguments but 6 were given"
 * CPython 的 `f(doc, bogus=1)`（unexpected keyword）在 JS 没有可表达的调用形式，
 * 因此**不进入用例表**（与 strsc 把 strip(bytes) 面留在 STATE/oracle 不入表同理），
 * 该事实记录在 tmp/mcond_STATE.md。
 */
function mcond_py_missing(fname: string, names: readonly string[]): PyTypeErrorP {
  const q = names.map((s) => `'${s}'`);
  const list = q.length === 1
    ? (q[0] as string)
    : q.length === 2
      ? `${q[0]} and ${q[1]}`
      : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
  const plural = names.length === 1 ? "positional argument" : "positional arguments";
  return new PyTypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

function mcond_py_too_many_range(fname: string, lo: number, hi: number, given: number): PyTypeErrorP {
  const verb = given === 1 ? "was" : "were";
  return new PyTypeErrorP(
    `${fname}() takes from ${lo} to ${hi} positional arguments but ${given} ${verb} given`,
  );
}

/** `obj.attr` 的属性面（F18: `'str' object has no attribute 'date'`）。 */
function mcond_get_attr(obj: unknown, attr: string): unknown {
  if (obj === null || obj === undefined) throw new PyAttributeErrorP(obj, attr);
  if (typeof obj !== "object" && typeof obj !== "function") throw new PyAttributeErrorP(obj, attr);
  if (!(attr in (obj as object))) throw new PyAttributeErrorP(obj, attr);
  return (obj as Record<string, unknown>)[attr];
}

/** `len(x)`（F18: `object of type 'NoneType' has no len()`）。 */
function mcond_len(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return Array.from(v).length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v !== null && typeof v === "object") return Object.keys(v).length;
  throw new PyTypeErrorP(`object of type '${py_type_name(v)}' has no len()`);
}

/**
 * `re.sub(r"\s+", " ", s)`（F1b）：Python str 模式的 \s == PY_ISSPACE 集
 * （含 0x1c-0x1f/0x85，不含 0x200b/0xfeff），每个连续段替换为**一个**空格。
 */
function mcond_collapse_ws(s: string): string {
  let out = "";
  let in_run = false;
  for (const ch of Array.from(s)) {
    if (PY_ISSPACE.has(ch.codePointAt(0) as number)) {
      if (!in_run) {
        out += " ";
        in_run = true;
      }
    } else {
      out += ch;
      in_run = false;
    }
  }
  return out;
}

/** dedup norm：`re.sub(r"\s+", " ", c.strip().lower().lstrip("- "))`（F2/F4）。 */
function mcond_norm_item(v: unknown): string {
  if (typeof v !== "string") throw new PyAttributeErrorP(v, "strip");
  return mcond_collapse_ws(py_lstrip_chars(py_lower(py_strip(v)), "- "));
}

/**
 * `x[:k]` / `x[-k:]` 的 Python 切片归一（F17）：bool 即 int；float 抛
 * "slice indices must be integers or None or have an __index__ method"；
 * None 只可能来自 x[:None]（源里 len>None 已先行抛错，不可达，仍镜像语义）。
 */
function mcond_py_index(k: unknown, len_: number): number {
  if (typeof k === "boolean") return k ? 1 : 0;
  if (typeof k === "number") {
    if (!Number.isFinite(k) || !Number.isInteger(k)) {
      throw new PyTypeErrorP("slice indices must be integers or None or have an __index__ method");
    }
    const kk = k < 0 ? Math.max(0, len_ + k) : k;
    return Math.min(len_, kk);
  }
  if (k === null || k === undefined) return len_; // x[:None] == whole
  throw new PyTypeErrorP("slice indices must be integers or None or have an __index__ method");
}

/** `n > x`（F10/F17）：int 与 None/str/容器比较 → CPython TypeError 文案。 */
function mcond_gt_int(n: number, x: unknown): boolean {
  if (typeof x === "boolean") return n > (x ? 1 : 0);
  if (typeof x === "number") return n > x; // NaN → false（与 CPython 一致）
  throw new PyTypeErrorP(`'>' not supported between instances of 'int' and '${py_type_name(x)}'`);
}

/**
 * `x[-m:]` 的 start 归一（F17 dec_zero/dec_neg/dec_true）：先算一元负号 `-m`
 * （None → "bad operand type for unary -: 'NoneType'"，源里 len>None 已先行抛错，
 * 该臂仅在直接调用切片时可达），再按 Python slice start 钳位。
 * m=0 → start=0 → kept=ALL；m=-1 → start=1；float → 切片 TypeError 文案。
 */
function mcond_py_slice_start_neg(m: unknown, len_: number): number {
  let v: number;
  if (typeof m === "boolean") v = m ? -1 : 0;
  else if (typeof m === "number") {
    if (!Number.isFinite(m) || !Number.isInteger(m)) {
      throw new PyTypeErrorP("slice indices must be integers or None or have an __index__ method");
    }
    v = -m;
  } else if (m === null || m === undefined) {
    throw new PyTypeErrorP("bad operand type for unary -: 'NoneType'");
  } else {
    throw new PyTypeErrorP(`bad operand type for unary -: '${py_type_name(m)}'`);
  }
  if (v < 0) return Math.max(0, len_ + v);
  // -0 与 0 同臂（Python `x[-0:]` == `x[0:]` == 全量；slice(-0) 在 JS 即 slice(0)）
  return Math.min(len_, v);
}

/** `len - x`（F17 pruned 值可为 float/负，先于切片发生）。 */
function mcond_sub_int(n: number, x: unknown): number {
  if (typeof x === "boolean") return n - (x ? 1 : 0);
  if (typeof x === "number") return n - x;
  throw new PyTypeErrorP(`unsupported operand type(s) for -: 'int' and '${py_type_name(x)}'`);
}

/** 码点级字符串比较（F5: "\uffff" < "\U0001F600"，非 UTF-16 单元序）。 */
function mcond_codepoint_cmp(a: string, b: string): number {
  const xs = Array.from(a);
  const ys = Array.from(b);
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    const ca = xs[i]!.codePointAt(0) as number;
    const cb = ys[i]!.codePointAt(0) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  if (xs.length === ys.length) return 0;
  return xs.length < ys.length ? -1 : 1;
}

/**
 * Python `a < b`（F18: `'<' not supported between instances of 'str' and 'int'`
 * 的操作数顺序由比较方向决定）。int/bool 互为数值，str/str 走码点序。
 */
function mcond_py_lt(a: unknown, b: unknown): boolean {
  const na = typeof a === "boolean" ? (a ? 1 : 0) : a;
  const nb = typeof b === "boolean" ? (b ? 1 : 0) : b;
  if (typeof na === "number" && typeof nb === "number") return na < nb;
  if (typeof na === "string" && typeof nb === "string") return mcond_codepoint_cmp(na, nb) < 0;
  throw new PyTypeErrorP(
    `'<' not supported between instances of '${py_type_name(na)}' and '${py_type_name(nb)}'`,
  );
}

/**
 * CPython `listsort` 的**二分插入**镜像（F5 stability + F18 比较顺序）：
 * while lo<hi: mid=(lo+hi)>>1; if key < L[mid]: hi=mid else lo=mid+1 ——
 * 与 CPython `_bisect` 式插入逐对同向比较，等键保持原序（稳定）。
 */
function mcond_sorted_by<T>(data: readonly T[], keyf: (t: T) => unknown): T[] {
  const out = data.slice();
  for (let i = 1; i < out.length; i++) {
    const key = out[i] as T;
    const kk = keyf(key);
    let lo = 0;
    let hi = i;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mcond_py_lt(kk, keyf(out[mid] as T))) hi = mid;
      else lo = mid + 1;
    }
    for (let j = i; j > lo; j--) out[j] = out[j - 1] as T;
    out[lo] = key;
  }
  return out;
}

/**
 * strict UTF-8 解码（F8 20 例规则）：CPython UnicodeDecodeError 文案逐字复刻。
 * 单字节区间 → `byte 0x.. in position N`；多字节区间 → `bytes in position S-E`。
 */
function mcond_utf8_decode(buf: Uint8Array): string {
  const err = (start: number, end: number, reason: string): never => {
    const span = end - start;
    const where = span === 1
      ? `byte 0x${(buf[start] as number).toString(16).padStart(2, "0")} in position ${start}`
      : `bytes in position ${start}-${end - 1}`;
    throw new McondUnicodeDecodeErrorP(`'utf-8' codec can't decode ${where}: ${reason}`);
  };
  const n = buf.length;
  let i = 0;
  const cps: number[] = [];
  while (i < n) {
    const b = buf[i] as number;
    if (b < 0x80) {
      cps.push(b);
      i++;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b === 0xe0) { need = 2; lo = 0xa0; }
    else if (b >= 0xe1 && b <= 0xec) need = 2;
    else if (b === 0xed) { need = 2; hi = 0x9f; }
    else if (b === 0xee || b === 0xef) need = 2;
    else if (b === 0xf0) { need = 3; lo = 0x90; }
    else if (b >= 0xf1 && b <= 0xf3) need = 3;
    else if (b === 0xf4) { need = 3; hi = 0x8f; }
    else err(i, i + 1, "invalid start byte"); // 0x80-0xbf, 0xc0, 0xc1, 0xf5-0xff
    let cp = 0;
    if (need === 1) cp = b & 0x1f;
    else if (need === 2) cp = b & 0x0f;
    else cp = b & 0x07;
    let j = 1;
    while (j <= need) {
      if (i + j >= n) err(i, i + j, "unexpected end of data");
      const c = buf[i + j] as number;
      const cl = j === 1 ? lo : 0x80;
      const ch = j === 1 ? hi : 0xbf;
      if (c < cl || c > ch) err(i, i + j, "invalid continuation byte");
      cp = (cp << 6) | (c & 0x3f);
      j++;
    }
    cps.push(cp);
    i += need + 1;
  }
  return String.fromCodePoint(...cps);
}

/** `open(p, 'r', encoding='utf-8')` 的两步：strict decode + 万能换行翻译（F9/F19）。 */
function mcond_read_text_file(filepath: string | number): string {
  const buf = new Uint8Array(fs.readFileSync(filepath as number));
  const decoded = mcond_utf8_decode(buf);
  return decoded.replace(/\r\n?/g, (m) => (m === "\r\n" ? "\n" : "\n"));
}

/** `os.path.isfile(x)` 的完整面（F10/F17：bool/int 走 fd，None/dict/list 抛文案）。 */
function mcond_os_path_isfile(v: unknown): boolean {
  if (typeof v === "string") {
    try {
      return fs.statSync(v).isFile();
    } catch {
      return false;
    }
  }
  if (typeof v === "boolean") {
    try {
      return fs.fstatSync(v ? 1 : 0).isFile(); // CPython：bool 当 fd（RuntimeWarning 走 stderr，不入事实）
    } catch {
      return false;
    }
  }
  if (typeof v === "number" && Number.isInteger(v)) {
    try {
      return fs.fstatSync(v).isFile();
    } catch {
      return false;
    }
  }
  if (v instanceof Uint8Array) {
    try {
      return fs.statSync(Buffer.from(v).toString("latin1")).isFile();
    } catch {
      return false;
    }
  }
  // CPython wording (tmp/mcond_oracle_facts.json F10_arity.file_none /
  // F17_caps_full.file_dict / file_list): the offending type name is NOT quoted —
  // "…or integer, not NoneType" / "…not dict" / "…not list".
  throw new PyTypeErrorP(
    `_path_isfile: path should be string, bytes, os.PathLike or integer, not ${py_type_name(v)}`,
  );
}

export function condense_document(...args: unknown[]): [ProjectMemoryDocument, Record<string, number>] {
  /** Perform deterministic rule-based condensation on a ProjectMemoryDocument. */
  // F10_arity 调用绑定面（CPython `def condense_document(doc, max_decisions=15,
  // max_practices=10, max_conventions=20)`）：0 实参 → missing 'doc'；>4 → too many。
  if (args.length === 0) throw mcond_py_missing("condense_document", ["doc"]);
  if (args.length > 4) throw mcond_py_too_many_range("condense_document", 1, 4, args.length);
  const doc: unknown = args[0];
  const max_decisions: unknown = args.length > 1 ? args[1] : 15;
  const max_practices: unknown = args.length > 2 ? args[2] : 10;
  const max_conventions: unknown = args.length > 3 ? args[3] : 20;
  if (doc === null || doc === undefined || typeof doc !== "object") {
    throw new PyAttributeErrorP(doc, "decisions"); // F10 doc_none（dict 字面量先取 len(doc.decisions)）
  }
  const d0 = doc as Record<string, unknown>;
  const decisions0 = mcond_get_attr(d0, "decisions");
  const conventions0 = mcond_get_attr(d0, "conventions");
  const practices0 = mcond_get_attr(d0, "practices");
  const stats: Record<string, number> = {
    original_decisions: mcond_len(decisions0),
    original_conventions: mcond_len(conventions0),
    original_practices: mcond_len(practices0),
    pruned_decisions: 0,
    pruned_conventions: 0,
    pruned_practices: 0,
  };

  // 1. Deduplicate conventions (case-insensitive substring overlap)
  const unique_conv: unknown[] = [];
  const seen_conv = new Set<string>();
  for (const c of py_iter(conventions0)) {
    const norm = mcond_norm_item(c);
    if (norm && !seen_conv.has(norm)) {
      seen_conv.add(norm);
      unique_conv.push(c);
    }
  }
  if (mcond_gt_int(unique_conv.length, max_conventions)) {
    stats["pruned_conventions"] = mcond_sub_int(unique_conv.length, max_conventions);
    unique_conv.length = mcond_py_index(max_conventions, unique_conv.length);
  }
  d0["conventions"] = unique_conv;

  // 2. Deduplicate practices
  const unique_prac: unknown[] = [];
  const seen_prac = new Set<string>();
  for (const p of py_iter(practices0)) {
    const norm = mcond_norm_item(p);
    if (norm && !seen_prac.has(norm)) {
      seen_prac.add(norm);
      unique_prac.push(p);
    }
  }
  if (mcond_gt_int(unique_prac.length, max_practices)) {
    stats["pruned_practices"] = mcond_sub_int(unique_prac.length, max_practices);
    unique_prac.length = mcond_py_index(max_practices, unique_prac.length);
  }
  d0["practices"] = unique_prac;

  // 3. Compact decisions: keep most recent N, summarize older ones
  const dec_now = mcond_get_attr(d0, "decisions") as unknown[];
  if (mcond_gt_int(dec_now.length, max_decisions)) {
    stats["pruned_decisions"] = mcond_sub_int(dec_now.length, max_decisions);
    // Sort by date if available（CPython listsort 二分插入镜像，F5/F18）
    const sorted_dec = mcond_sorted_by(dec_now, (d) => mcond_get_attr(d, "date"));
    const cut = mcond_py_slice_start_neg(max_decisions, sorted_dec.length); // start == -max
    const older = sorted_dec.slice(0, cut);
    const kept = sorted_dec.slice(cut);

    // Create one milestone line for the older decisions
    if (older.length > 0) {
      const start_d = mcond_get_attr(older[0], "date");
      const end_d = mcond_get_attr(older[older.length - 1], "date");
      const summary_dec = make_decision_record({
        date: `${py_str(start_d)}..${py_str(end_d)}`,
        decision: `早期历史决策聚合归档（共 ${older.length} 项历史演进）`,
        reason: "遵循容量守护协议进行周期性浓缩",
        impact: "历史细节已精简，当前工程主线保持清晰",
        source: "memory_condenser",
      });
      kept.unshift(summary_dec);
    }
    d0["decisions"] = kept;
  }

  return [d0 as unknown as ProjectMemoryDocument, stats];
}

export function condense_memory_file(...args: unknown[]): Record<string, unknown> {
  /** Inspect and condense a project MEMORY.md file if needed or forced. */
  // F10_arity 调用绑定面（CPython `def condense_memory_file(filepath, force=False)`）。
  if (args.length === 0) throw mcond_py_missing("condense_memory_file", ["filepath"]);
  if (args.length > 2) throw mcond_py_too_many_range("condense_memory_file", 1, 2, args.length);
  const filepath: unknown = args[0];
  const force: unknown = args.length > 1 ? args[1] : false;
  if (!mcond_os_path_isfile(filepath)) {
    return { status: "error", message: `File not found: ${py_str(filepath)}` };
  }

  let raw_text: string;
  try {
    raw_text = mcond_read_text_file(filepath as string | number);
  } catch (exc) {
    return { status: "error", message: `Read failed: ${exc_str(exc)}` };
  }

  const budget_before = validate_memory_budget(raw_text);
  if (!py_truth(force) && py_truth(budget_before["valid"])) {
    return {
      status: "skipped",
      message: "Memory file is within budget; no condensation required.",
      budget: budget_before,
    };
  }

  const doc = pmd_parse(raw_text);
  const [condensed, stats] = condense_document(doc);
  const new_text = pmd_to_markdown(condensed);
  const budget_after = validate_memory_budget(new_text);

  try {
    // Atomic write to avoid file corruption（源 open('w', newline=None)：
    // text-mode 写把 "\n" 翻译成 os.linesep，F15 written_has_crlf=true）
    const tmp_path = `${py_str(filepath)}.tmp.${Math.floor(Date.now())}`;
    const bytes = utf8_encode_strict(new_text);
    const out = mcond_write_translate(Buffer.from(bytes));
    fs.writeFileSync(tmp_path, out);
    // 数字 fd 的 filepath 在 isfile 臂上必然已短路为 "File not found"（探针面），
    // 到达此处的成功面 filepath 恒为 str。
    fs.renameSync(tmp_path, filepath as string);
  } catch (exc) {
    return { status: "error", message: `Write failed: ${exc_str(exc)}` };
  }

  return {
    status: "success",
    before: budget_before,
    after: budget_after,
    stats,
  };
}

/** text-mode write 换行翻译（Windows: \n→\r\n；镜像 os.linesep）。 */
function mcond_write_translate(b: Buffer): Buffer {
  if (process.platform !== "win32") return b;
  return Buffer.from(b.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
}

export { validate_memory_budget, MAX_MEMORY_LINES, MAX_MEMORY_TOKENS } from "./project_memory_protocol.js";
