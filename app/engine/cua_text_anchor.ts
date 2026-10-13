/**
 * cua_text_anchor.ts — 本地 OCR 文本锚点解析与 DPI 自适应中心坐标计算.
 *
 * Ported from `app/backend/cua_text_anchor.py` (181 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/cua_text_anchor.py -> app/engine/cua_text_anchor.ts
 *   §M  single-source mirror law: every CPython mirror this file needs already
 *       lives in `app/engine/server/http_server_keys.ts` — py_truth / py_or /
 *       py_str / py_type_name / py_float / py_int / py_strip / py_lower /
 *       py_iter / py_dict_get / PyAttributeErrorP / PyTypeErrorP are IMPORTED,
 *       never re-implemented here. (An earlier revision of this file carried
 *       private copies; that is exactly the class of defect that flipped
 *       verdicts elsewhere, so the copies are gone.)
 *       Only genuinely local helpers remain: `pyArity` (call-signature gate,
 *       same shape as the rule_engine port), `pyRound`/`pyIntRound`,
 *       `pyDiv`/`pyMul`/`pySubOne`/`pyListIndex` (operand-type gates for the
 *       four operators this file actually uses), `isPyDict`, `ownKey`,
 *       `PyIndexErrorP` (§M has no IndexError mirror).
 *   §2  behaviour: the lower()/strip() ASYMMETRY in find_text_boxes (case mode
 *       keeps the raw query object — no str() — so an int query only dies at
 *       `q in candidate`, while non-case mode dies earlier at query.lower());
 *       falsy chains `text or content or ""`, `box or bbox or rect`,
 *       `scale_factor or 1.0`; key-existence gate "x" and "y" and "width" and
 *       "height" (present-but-None still enters the float() arm and crashes —
 *       uncaught by design, bug-for-bug); polygon points filtered by
 *       `len(pt) >= 2` before min/max; reversed coords normalized via
 *       min()/abs(); a dict `b` with no usable points falls out of the dict
 *       arm and returns None.
 *   §2  strip set = CPython `str.isspace()` (29 code points, §M PY_ISSPACE) and
 *       lower set = CPython UCD (27 protected code points, §M PY_LOWER_PRESERVE).
 *       JS `trim()`/`toLowerCase()` disagree on U+1C–U+1F, U+85 (trim keeps
 *       them; CPython strips) and on U+FEFF (trim strips; CPython keeps) —
 *       17 pinned rows in `tmp/cuatex_z_triage.txt` F2 hang on that.
 *   §2  `float(x)`/`int(x)` accept PEP 515 underscores and print CPython's own
 *       TypeError wording (§M py_float/py_int, evidence
 *       `tmp/lead_keys_underscore2.txt`, 53 rows off the pinned 3.13.15).
 *   §2  int(round(v)) is python HALF-EVEN rounding (round(62.5)==62,
 *       round(2.5)==2) — Math.round would round half-UP; pyRound reproduces
 *       banker's rounding and the conversion is `py_int(pyRound(v))`, so the
 *       NaN face (`ValueError: cannot convert float NaN to integer`) and the
 *       ±Inf face (`OverflowError: cannot convert float infinity to integer`)
 *       come from §M, not from a local guess.
 *   §8e CPython call-signature mirror: JS ignores missing/extra arguments,
 *       CPython raises TypeError at the call site. pyArity reproduces the
 *       measured wording — qualname in the message, `self`/`cls` counted in
 *       "takes N …"/"but G were given" but never in the missing-argument list,
 *       defaults give "takes from R to T positional arguments" (always plural),
 *       no defaults give singular/plural by N, ≥3 missing names join with the
 *       Oxford comma. `resolve_click_target` is a **classmethod**, so its bound
 *       `cls` is counted (selfCount=1): measured face
 *       `TextAnchorResolver.resolve_click_target() takes from 3 to 7 positional
 *       arguments but 8 were given` for a 7-arg call. The two @staticmethods
 *       count 0.
 *   §2  operand-type faces, all measured against the pinned interpreter
 *       (`tmp/cuatex_z_triage.txt` F5/F6/F7/F8): `query.lower()` on a non-str ->
 *       AttributeError `'int' object has no attribute 'lower'`; `q in candidate`
 *       with a non-str q -> TypeError `'in <string>' requires string as left
 *       operand, not int`; `x / factor` -> TypeError
 *       `unsupported operand type(s) for /: 'NoneType' and 'float'` (factor is
 *       always a float because of `float(scale_factor or 1.0)`); `x * factor`
 *       with a str/list -> TypeError
 *       `can't multiply sequence by non-int of type 'float'`; `occurrence - 1`
 *       -> TypeError `unsupported operand type(s) for -: 'str' and 'int'`;
 *       `for raw_box in ocr_boxes` -> §M py_iter, which iterates a dict's KEYS
 *       (so a dict of boxes yields [] exactly like python) and raises TypeError
 *       `'int' object is not iterable`; `matches[0.5]` -> TypeError
 *       `list indices must be integers or slices, not float` (unquoted type).
 *   DIVERGENCE(port): py kwargs (exact=, case_sensitive=, scale_factor=,
 *       to_logical=) become positional/optional params; call sites are inside
 *       this repo and are rewritten accordingly.
 *   DIVERGENCE(port): python tuples and lists both arrive as JS arrays, so the
 *       IndexError from an empty pair payload prints the LIST wording
 *       (`list index out of range`), never `tuple index out of range`. Only an
 *       in-repo caller can hit it, and it can only hit it with a list.
 *   DIVERGENCE(port): JS has one number type, so an integral python float
 *       (2.0) is indistinguishable from int 2 here. Faces that depend on that
 *       distinction are not represented in the case table.
 *
 * 全部计算在本地完成，图像不上传至任何多模态服务。
 */
import {
  PyAttributeErrorP,
  PyTypeErrorP,
  py_dict_get,
  py_float,
  py_int,
  py_iter,
  py_lower,
  py_or,
  py_strip,
  py_str,
  py_truth,
  py_type_name,
} from "./server/http_server_keys.js";

type JsonDict = Record<string, unknown>;

function isPyDict(v: unknown): v is JsonDict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** python `k in d` for a dict: own keys only, never the prototype chain. */
function ownKey(d: JsonDict, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(d, k);
}

/** `IndexError` — §M carries no IndexError mirror, so this file owns the one
 *  arm that can raise it (empty pair payload in the list form). */
class PyIndexErrorP extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "IndexError";
  }
}

function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * CPython 调用签名检查。`required`/`optional` 只列**非 self** 形参名；
 * `selfCount` 是已绑定的 `self`/`cls` 个数（classmethod 经类访问时 cls 已绑定，
 * CPython 把它计入 "takes N positional arguments"，但缺参列表不含它）。
 */
function pyArity(
  qualName: string,
  required: readonly string[],
  optional: readonly string[],
  selfCount: number,
  given: number,
): void {
  const missing = required.slice(Math.max(0, given));
  if (missing.length > 0) {
    throw new PyTypeErrorP(
      `${qualName}() missing ${missing.length} required positional ` +
        `${missing.length === 1 ? "argument" : "arguments"}: ` +
        joinNames(missing.map((p) => `'${p}'`)),
    );
  }
  const maxTakes = required.length + optional.length + selfCount;
  const got = given + selfCount;
  if (got > maxTakes) {
    const minTakes = required.length + selfCount;
    const range =
      minTakes === maxTakes
        ? `takes ${maxTakes} positional ${maxTakes === 1 ? "argument" : "arguments"}`
        : `takes from ${minTakes} to ${maxTakes} positional arguments`;
    throw new PyTypeErrorP(
      `${qualName}() ${range} but ${got} ${got === 1 ? "was" : "were"} given`,
    );
  }
}

/** python `round(v)` without ndigits: half-EVEN on the exact binary value. */
function pyRound(v: number): number {
  if (!Number.isFinite(v)) return v;
  const f = Math.floor(v);
  const diff = v - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** python `int(round(v))`; the NaN/Inf faces are §M py_int's. */
function pyIntRound(v: number): number {
  return py_int(pyRound(v));
}

/** `a / factor` — factor is always a python float (`float(scale_factor or 1.0)`). */
function pyDiv(a: unknown, factor: number): number {
  if (typeof a !== "number" && typeof a !== "boolean") {
    throw new PyTypeErrorP(
      `unsupported operand type(s) for /: '${py_type_name(a)}' and 'float'`);
  }
  const left = typeof a === "boolean" ? (a ? 1 : 0) : a;
  return left / factor;
}

/** `a * factor` — str/list operands get python's sequence wording. */
function pyMul(a: unknown, factor: number): number {
  if (typeof a === "string" || Array.isArray(a)) {
    throw new PyTypeErrorP(`can't multiply sequence by non-int of type 'float'`);
  }
  if (typeof a !== "number" && typeof a !== "boolean") {
    throw new PyTypeErrorP(
      `unsupported operand type(s) for *: '${py_type_name(a)}' and 'float'`);
  }
  const left = typeof a === "boolean" ? (a ? 1 : 0) : a;
  return left * factor;
}

/** `occurrence - 1` — bool is an int in python, everything else dies here. */
function pySubOne(a: unknown): number {
  if (typeof a === "boolean") return (a ? 1 : 0) - 1;
  if (typeof a !== "number") {
    throw new PyTypeErrorP(
      `unsupported operand type(s) for -: '${py_type_name(a)}' and 'int'`);
  }
  return a - 1;
}

/** `seq[i]` — a float index raises even when it is in range (F8). */
function pyListIndex(seq: readonly unknown[], i: number): unknown {
  if (!Number.isInteger(i)) {
    throw new PyTypeErrorP(`list indices must be integers or slices, not ${py_type_name(i)}`);
  }
  return seq[i];
}

/** 统一规范化 OCR 文本框结构。 */
export function _normalize_box(box: unknown): JsonDict | null {
  pyArity("_normalize_box", ["box"], [], 0, arguments.length);

  if (isPyDict(box)) {
    const picked = py_or(py_or(py_dict_get(box, "text"), py_dict_get(box, "content")), "");
    const text = py_strip(py_str(picked));
    if (!py_truth(text)) return null;
    if (ownKey(box, "x") && ownKey(box, "y") && ownKey(box, "width") && ownKey(box, "height")) {
      return {
        text,
        x: py_float(box["x"]),
        y: py_float(box["y"]),
        width: py_float(box["width"]),
        height: py_float(box["height"]),
      };
    }
    const b = py_or(py_or(py_dict_get(box, "box"), py_dict_get(box, "bbox")), py_dict_get(box, "rect"));
    if (Array.isArray(b) && b.length >= 4) {
      if (Array.isArray(b[0])) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const pt of b) {
          if (Array.isArray(pt) && pt.length >= 2) xs.push(py_float(pt[0]));
        }
        for (const pt of b) {
          if (Array.isArray(pt) && pt.length >= 2) ys.push(py_float(pt[1]));
        }
        if (py_truth(xs) && py_truth(ys)) {
          const min_x = Math.min(...xs), max_x = Math.max(...xs);
          const min_y = Math.min(...ys), max_y = Math.max(...ys);
          return {
            text, x: min_x, y: min_y,
            width: max_x - min_x, height: max_y - min_y,
          };
        }
      } else {
        const x1 = py_float(b[0]), y1 = py_float(b[1]);
        const x2 = py_float(b[2]), y2 = py_float(b[3]);
        return {
          text,
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        };
      }
    }
  }

  if (Array.isArray(box)) {
    // [x1, y1, x2, y2, text]
    if (box.length >= 5 && typeof box[4] === "string") {
      const x1 = py_float(box[0]), y1 = py_float(box[1]);
      const x2 = py_float(box[2]), y2 = py_float(box[3]);
      return {
        text: py_strip(py_str(box[4])),
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }
    // [[x1, y1, x2, y2], (text, conf)]
    if (box.length >= 2 && Array.isArray(box[0]) && (box[0] as unknown[]).length >= 4) {
      const coords = box[0] as unknown[];
      const x1 = py_float(coords[0]), y1 = py_float(coords[1]);
      const x2 = py_float(coords[2]), y2 = py_float(coords[3]);
      const second = box[1];
      let text: unknown;
      if (Array.isArray(second)) {
        if (second.length === 0) throw new PyIndexErrorP("list index out of range");
        text = second[0];
      } else {
        text = py_str(second);
      }
      return {
        text: py_strip(py_str(text)),
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }
  }

  return null;
}

export class TextAnchorResolver {
  /** 在 OCR 候选框列表中检索所有匹配文本框，并计算中心点。 */
  static find_text_boxes(
    ocr_boxes: unknown,
    query: unknown,
    exact: boolean = false,
    case_sensitive: boolean = false,
  ): JsonDict[] {
    pyArity("TextAnchorResolver.find_text_boxes", ["ocr_boxes", "query"],
      ["exact", "case_sensitive"], 0, arguments.length);
    if (!py_truth(query) || !py_truth(ocr_boxes)) return [];

    // 源 100：case 模式**不碰** query（非 str 到 109 行才死），非 case 模式先 lower 再 strip。
    const q: unknown = case_sensitive
      ? query
      : (() => {
          if (typeof query !== "string") throw new PyAttributeErrorP(query, "lower");
          return py_strip(py_lower(query));
        })();

    const matched: JsonDict[] = [];

    for (const raw_box of py_iter(ocr_boxes)) {
      const norm = _normalize_box(raw_box);
      // 源 105 `if not norm`；`|| norm === null` 只是把同一条判定喂给 TS 收窄，不改语义。
      if (!py_truth(norm) || norm === null) continue;

      const candidate = case_sensitive
        ? (norm["text"] as string)
        : py_lower(norm["text"] as string);
      let isHit: boolean;
      if (exact) {
        isHit = typeof q === "string" && candidate === q;
      } else {
        if (typeof q !== "string") {
          throw new PyTypeErrorP(
            `'in <string>' requires string as left operand, not ${py_type_name(q)}`);
        }
        isHit = candidate.includes(q);
      }

      if (isHit) {
        const cx = (norm["x"] as number) + (norm["width"] as number) / 2.0;
        const cy = (norm["y"] as number) + (norm["height"] as number) / 2.0;
        const item: JsonDict = { ...norm };
        item["center_x"] = cx;
        item["center_y"] = cy;
        matched.push(item);
      }
    }

    return matched;
  }

  /** 进行 DPI 物理像素与逻辑坐标转换。 */
  static calculate_dpi_compensated_coords(
    x: unknown,
    y: unknown,
    scale_factor: unknown = 1.0,
    to_logical: boolean = true,
  ): [number, number] {
    pyArity("TextAnchorResolver.calculate_dpi_compensated_coords", ["x", "y"],
      ["scale_factor", "to_logical"], 0, arguments.length);
    let factor = py_float(py_or(scale_factor, 1.0));
    if (factor <= 0.01) factor = 1.0;

    let target_x: number, target_y: number;
    if (to_logical) {
      target_x = pyDiv(x, factor);
      target_y = pyDiv(y, factor);
    } else {
      target_x = pyMul(x, factor);
      target_y = pyMul(y, factor);
    }

    return [pyIntRound(target_x), pyIntRound(target_y)];
  }

  /** 高层解析接口：查找第 N 个匹配的文本中心点并返回补偿后的坐标。 */
  static resolve_click_target(
    ocr_boxes: unknown,
    text: unknown,
    occurrence: unknown = 1,
    exact: boolean = false,
    scale_factor: unknown = 1.0,
    to_logical: boolean = true,
  ): [boolean, unknown] {
    // classmethod：CPython 把已绑定的 cls 计入 "takes N"，所以 selfCount=1。
    pyArity("TextAnchorResolver.resolve_click_target", ["ocr_boxes", "text"],
      ["occurrence", "exact", "scale_factor", "to_logical"], 1, arguments.length);
    const matches = TextAnchorResolver.find_text_boxes(ocr_boxes, text, exact);
    if (!py_truth(matches)) {
      return [false, `在当前屏幕 OCR 中未检测到文本 '${py_str(text)}'`];
    }

    const idx = pySubOne(occurrence);
    if (idx < 0 || idx >= matches.length) {
      return [
        false,
        `检测到文本 '${py_str(text)}' 共 ${matches.length} 处，指定的序号 occurrence=${py_str(occurrence)} 超出范围`,
      ];
    }

    const target_box = pyListIndex(matches, idx) as JsonDict;
    const [px, py_] = TextAnchorResolver.calculate_dpi_compensated_coords(
      target_box["center_x"],
      target_box["center_y"],
      scale_factor,
      to_logical,
    );
    return [true, [px, py_]];
  }
}

// PORT STATUS: confidence=high todos=[0]
