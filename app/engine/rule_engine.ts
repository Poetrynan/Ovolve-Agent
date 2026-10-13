/**
 * rule_engine.ts — Ovolve Layer 1 记忆：用户可编辑的规则库（规则装配器）。
 *
 * Ported from `app/backend/rule_engine.py` (227 lines).
 *
 * 系统将用户与工作区编写的规则文件作为 prompt 上下文的一部分，让模型理解
 * 自然语言安全与编码约定。本文件不做"引擎"，做**规则装配器**：
 *   · 扫描 rules/ 目录下所有 *.md
 *   · 每个文件 YAML frontmatter 声明 priority / enabled / scope
 *   · 按优先级组装成一大段规则文本，塞进 system prompt
 *   · 模型读到 "删除前必须确认"，它自己就会遵守
 *
 * 分层存储：
 *   · WORKSPACE 级：<workspace>/.ovolve/rules/*.md —— 项目特有
 *   · USER 级：~/.ovolve/rules/*.md —— 全局用户偏好，跨项目生效
 *
 * 与 AGENTS.md 的关系：AGENTS.md 是机器产出的沉淀（memory_layer 写）；
 * rules/ 是用户手写的规范。两者不冲突。
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:fs, node:path, node:os) + the shared mirror layer.
 *   §M  single source: whitespace / strip / lower all import
 *       `./server/http_server_keys.js` (`PY_ISSPACE`, `py_strip`, `py_lower`,
 *       `rstrip_chars`, `PyTypeErrorP`). **No private whitespace table in this file.**
 *       The two regexes get their `\s` class rendered **from** `PY_ISSPACE`
 *       (precedent: `browser_policy_guard.ts:156`), because CPython's `\s` on str is
 *       the 29-codepoint `isspace()` set while JS `\s` is 25 codepoints:
 *       PY_ONLY = U+1C U+1D U+1E U+1F U+85, JS_ONLY = U+FEFF
 *       (measured on the pinned interpreter, `tmp/ruleen_STATE.md` §8).
 *   §2  `str.splitlines()` boundaries are **not** `\r?\n`: measured 10 single
 *       codepoints U+A U+B U+C U+D U+1C U+1D U+1E U+85 U+2028 U+2029 plus `\r\n` as
 *       one boundary, and **U+1F is NOT a boundary**. §M exports no splitlines
 *       mirror, so `pySplitlines` lives here (precedent: `patch_engine.ts` keeps its
 *       own `splitlines`).
 *   §2  `str.upper()`: V8 folds 27 codepoints CPython 3.13 leaves alone
 *       (U+19B U+264 U+1C8A U+A7CD U+A7DB U+10D70–U+10D85); `pyUpper` uses the same
 *       segment-and-protect design as §M's `py_lower`. §M has no `py_upper` yet.
 *   §2  code points, not UTF-16 units: `body[:200]` (excerpt), the frontmatter
 *       `text[m.end():]` offset, `len(value)` for the quote strip, and the id
 *       tie-break order (CPython compares strings by code point; `localeCompare` is
 *       locale-aware) all go through code-point helpers.
 *   §2  call signatures: JS ignores missing/extra positional args, CPython raises
 *       `TypeError` at the call site. `pyArity` mirrors the measured wording —
 *       `self` is counted in "takes N positional arguments" but never appears in the
 *       missing-argument list, defaulted params give the "takes from R to T" form,
 *       and ≥3 names take the Oxford comma.
 *   §2  Python sort stability: `Array.prototype.sort` is stable in modern engines and
 *       the key tuple is compared field-by-field, so the source order is reproduced.
 *   §4  naming: app/backend/rule_engine.py -> app/engine/rule_engine.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PY_ISSPACE,
  PyTypeErrorP,
  py_lower,
  py_strip,
  rstrip_chars,
} from "./server/http_server_keys.js";

/** `PY_ISSPACE` 的字符集串（给 §M 的 `rstrip_chars(s, chars)` 用）。 */
const PY_ISSPACE_CHARS = String.fromCodePoint(...Array.from(PY_ISSPACE));

/** python `len(s)` —— 码点数，不是 UTF-16 单元数。 */
function pyLen(s: string): number {
  return Array.from(s).length;
}

/** python `s[:n]` —— 按码点切。 */
function pyHead(s: string, n: number): string {
  return Array.from(s).slice(0, n).join("");
}

/** python 的字符串序：逐码点比，短者在前（`localeCompare` 是 locale 序，不能用）。 */
function pyStrCmp(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const min = Math.min(ca.length, cb.length);
  for (let i = 0; i < min; i++) {
    const x = ca[i]!.codePointAt(0)!;
    const y = cb[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (ca.length === cb.length) return 0;
  return ca.length < cb.length ? -1 : 1;
}

/**
 * `str.strip()`（无参）走 §M `py_strip`；这里是它的右半边：
 * `"\n".join(lines).rstrip()`。字符集仍来自 §M 的 `PY_ISSPACE`，本文件不建第二张表。
 */
function pyRstrip(s: string): string {
  return rstrip_chars(s, PY_ISSPACE_CHARS);
}

/**
 * python `str.splitlines()`：实测边界 = U+A U+B U+C U+D U+1C U+1D U+1E U+85 U+2028
 * U+2029 这 10 个单码点，外加 `\r\n` 作**一个**边界；U+1F **不是**边界。
 * 空串 → `[]`；串尾的边界不产生空尾行。
 */
const PY_LINE_BOUNDARIES = new Set<number>([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

function pySplitlines(s: string): string[] {
  const cps = Array.from(s);
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < cps.length) {
    const cp = cps[i]!.codePointAt(0)!;
    const next = i + 1 < cps.length ? cps[i + 1]!.codePointAt(0)! : -1;
    if (cp === 0x0d && next === 0x0a) {
      out.push(cps.slice(start, i).join(""));
      i += 2;
      start = i;
      continue;
    }
    if (PY_LINE_BOUNDARIES.has(cp)) {
      out.push(cps.slice(start, i).join(""));
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  if (start < cps.length) out.push(cps.slice(start).join(""));
  return out;
}

/**
 * `str.upper()`：V8 会折、CPython 3.13 原样返回的 27 个码点（实测
 * `tmp/ruleen_lead_class_diff.txt`，全码点差分，V8_vs_CPYTHON 值差=0）。
 * 与 §M `py_lower` 同设计：按被保护码点切段，段内用 V8，被保护字符原样放回。
 */
const PY_UPPER_PRESERVE = new Set<number>([
  0x19b, 0x264, 0x1c8a, 0xa7cd, 0xa7db,
  0x10d70, 0x10d71, 0x10d72, 0x10d73, 0x10d74, 0x10d75, 0x10d76, 0x10d77, 0x10d78,
  0x10d79, 0x10d7a, 0x10d7b, 0x10d7c, 0x10d7d, 0x10d7e, 0x10d7f, 0x10d80, 0x10d81,
  0x10d82, 0x10d83, 0x10d84, 0x10d85,
]);

function pyUpper(s: string): string {
  let out = "";
  let seg = "";
  for (const ch of s) {
    if (PY_UPPER_PRESERVE.has(ch.codePointAt(0)!)) {
      out += seg.toUpperCase();
      seg = "";
      out += ch;
    } else {
      seg += ch;
    }
  }
  return out + seg.toUpperCase();
}

/** python `Path(name).stem`：忽略前导点，只去**最后一个**后缀；无后缀则原样返回。 */
function pyStem(name: string): string {
  const trimmed = name.startsWith(".") ? name.slice(1) : name;
  const i = trimmed.lastIndexOf(".");
  if (i <= 0) return name;
  return name.slice(0, name.length - (trimmed.length - i));
}

/** CPython 的 `', '.join` + 末位 `', and '`（≥3 项带牛津逗号，2 项是 `'a' and 'b'`）。 */
function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * 调用签名检查：JS 忽略缺参/多参，CPython 在调用点就抛 TypeError。
 * `required`/`optional` 只列**非 self** 形参名；`selfCount` 是已绑定的 `self` 个数
 * （CPython 把 self 计入 "takes N positional arguments"，但缺参列表不含 self）。
 * 模块级端口里把 self 显式建模成第一个必传形参（如 `Rule.priority_value(r)`），
 * 这样 0 参调用也能报出 `missing 1 required positional argument: 'self'`。
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

/** 优先级从高到低。CRITICAL 永远最先注入，不可被忽略语义盖过。 */
export const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** 一条规则 —— 来自一个 .md 文件的解析结果。 */
export interface Rule {
  /** 稳定 id：`{scope}:{stem}` */
  id: string;
  /** 从 `# H1` 或 frontmatter.name 取 */
  title: string;
  /** markdown 正文（去掉 frontmatter 后的部分） */
  body: string;
  priority: string;
  enabled: boolean;
  /** "workspace" | "user" */
  scope: string;
  /** 让用户能一眼看到规则出处 */
  source_path: string;
}

/** `Rule.priority_value(self)` —— self 建模成第一个必传形参。 */
export function priority_value(...args: unknown[]): number {
  pyArity("Rule.priority_value", ["self"], [], 0, args.length);
  const r = args[0] as Rule;
  return PRIORITY_ORDER[pyUpper(r.priority)] ?? 4;
}

// 简易 YAML frontmatter 解析器 —— 只支持 `key: value` 单行键值对。
// 不引 YAML 库是刻意的：一层规则文件不该拉一个 YAML 解析器进来。
// `\s` 由 §M 的 PY_ISSPACE 渲染（CPython 的 `\s` = isspace 的 29 码点全集，
// JS 原生 `\s` 少 U+1C–U+1F 与 U+85、多 U+FEFF）。
const PY_S_CLASS =
  "[" +
  Array.from(PY_ISSPACE)
    .sort((a, b) => a - b)
    .map((cp) => "\\u" + cp.toString(16).padStart(4, "0"))
    .join("") +
  "]";

const _FRONTMATTER_RE = new RegExp(
  "^---" + PY_S_CLASS + "*\\n([\\s\\S]*?)\\n---" + PY_S_CLASS + "*\\n?",
);
// 源里 `\w` 的键名字符集与 JS 不同（实测差 4 382 码点），但键随后只与
// {enabled, priority, name} 比较，非 ASCII 键在两侧都被忽略 —— 该差分在本模块
// 不可观测（论证见 tmp/ruleen_STATE.md §8b，_faces kv#nonascii_* 负责证明）。
const _KV_RE = new RegExp(
  "^([A-Za-z_][\\w-]*)" + PY_S_CLASS + "*:" + PY_S_CLASS + "*(.+?)" + PY_S_CLASS + "*$",
);

/** 返回 [meta_dict, body_without_frontmatter]。 */
export function _parse_frontmatter(...args: unknown[]): [Record<string, string>, string] {
  pyArity("_parse_frontmatter", ["text"], [], 0, args.length);
  const text = args[0] as string;
  const m = _FRONTMATTER_RE.exec(text);
  if (!m) {
    return [{}, text];
  }
  const block = m[1] ?? "";
  // text[m.end():] —— m.end() 是**码点**下标，UTF-16 的 slice 会错位。
  const body = Array.from(text).slice(Array.from(m[0]!).length).join("");
  const meta: Record<string, string> = {};
  for (const rawLine of pySplitlines(block)) {
    const line = py_strip(rawLine);
    if (!line || line.startsWith("#")) {
      continue;
    }
    const kv = _KV_RE.exec(line);
    if (kv) {
      let value = Array.from(kv[2]!);
      // 去掉包围引号（len 与下标都按码点）
      if (
        value.length >= 2 &&
        value[0] === value[value.length - 1] &&
        (value[0] === '"' || value[0] === "'")
      ) {
        value = value.slice(1, -1);
      }
      meta[py_lower(kv[1]!)] = value.join("");
    }
  }
  return [meta, body];
}

/** 优先取第一个 `# H1`，否则用文件名兜底。 */
export function _extract_title(...args: unknown[]): string {
  pyArity("_extract_title", ["body", "fallback"], [], 0, args.length);
  const body = args[0] as string;
  const fallback = args[1] as string;
  for (const line of pySplitlines(body)) {
    const stripped = py_strip(line);
    if (stripped.startsWith("# ")) {
      // 前两个码点固定是 '#' 和 ' '，[2:] 与 UTF-16 slice 等价。
      return py_strip(stripped.slice(2));
    }
    // 空行继续；有内容但不是标题就停 —— 避免把正文首行当标题。
    if (stripped) {
      break;
    }
  }
  return fallback;
}

/** 接受 true/yes/on/1，忽略大小写。默认真。源的 `v` 无默认值 —— 1 个必传形参。 */
export function _truthy(...args: unknown[]): boolean {
  pyArity("_truthy", ["v"], [], 0, args.length);
  const v = args[0];
  if (v === null || v === undefined) {
    return true;
  }
  return ["true", "yes", "on", "1"].includes(py_lower(py_strip(v as string)));
}

export class RuleEngine {
  /** 扫描 rules/ 目录并把规则渲染成 system prompt 片段。 */
  /** WORKSPACE 规则默认放在项目根的这个相对路径下。 */
  static WORKSPACE_SUBDIR = ".ovolve/rules";
  /** USER 全局规则的路径。 */
  static USER_SUBDIR = ".ovolve/rules";

  workspace_dir: string | null;
  user_home: string;

  constructor(...args: unknown[]) {
    pyArity("RuleEngine.__init__", [], ["workspace_dir", "user_home"], 1, args.length);
    const workspace_dir = args[0] as string | null | undefined;
    const user_home = args[1] as string | null | undefined;
    this.workspace_dir = workspace_dir ? path.resolve(workspace_dir) : null;
    this.user_home = user_home || os.homedir();
  }

  /** 返回 [[path, scope], ...]。USER 优先扫，让 WORKSPACE 规则能压过它。 */
  _dirs(...args: Array<[string, string]>): Array<[string, string]> {
    pyArity("RuleEngine._dirs", [], [], 1, args.length);
    const out: Array<[string, string]> = [];
    const user_dir = path.join(this.user_home, RuleEngine.USER_SUBDIR);
    if (fs.existsSync(user_dir) && fs.statSync(user_dir).isDirectory()) {
      out.push([user_dir, "user"]);
    }
    if (this.workspace_dir) {
      const ws_dir = path.join(this.workspace_dir, RuleEngine.WORKSPACE_SUBDIR);
      if (fs.existsSync(ws_dir) && fs.statSync(ws_dir).isDirectory()) {
        out.push([ws_dir, "workspace"]);
      }
    }
    return out;
  }

  /** 扫描并返回启用的规则，按优先级排序。禁用规则会被过滤。 */
  load(...args: Rule[]): Rule[] {
    pyArity("RuleEngine.load", [], [], 1, args.length);
    const rules: Rule[] = [];
    for (const [dirpath, scope] of this._dirs()) {
      let md_files: string[];
      try {
        md_files = fs
          .readdirSync(dirpath)
          .filter((f) => f.endsWith(".md"))
          .sort(pyStrCmp);
      } catch {
        continue;
      }
      for (const fname of md_files) {
        const md = path.join(dirpath, fname);
        let text: string;
        try {
          text = fs.readFileSync(md, "utf-8");
        } catch {
          // except OSError: continue
          continue;
        }
        const [meta, body] = _parse_frontmatter(text);
        const enabled = _truthy(meta["enabled"]);
        if (!enabled) {
          continue;
        }
        let priority = pyUpper(meta["priority"] || "MEDIUM");
        if (!(priority in PRIORITY_ORDER)) {
          priority = "MEDIUM";
        }
        const stem = pyStem(fname);
        const title = meta["name"] || _extract_title(body, stem);
        rules.push({
          id: `${scope}:${stem}`,
          title,
          body: py_strip(body),
          priority,
          enabled: true,
          scope,
          source_path: md,
        });
      }
    }
    // 稳定排序：优先级 > 作用域 > id。同优先级下 workspace 排在 user 前，
    // 因为项目规则更贴近当下手头的事，模型看到得早。
    const scope_key: Record<string, number> = { workspace: 0, user: 1 };
    rules.sort(
      (a, b) =>
        priority_value(a) - priority_value(b) ||
        (scope_key[a.scope] ?? 9) - (scope_key[b.scope] ?? 9) ||
        pyStrCmp(a.id, b.id),
    );
    return rules;
  }

  /** 把规则渲染成一段可直接拼进 system prompt 的文本。
   *  空规则集返回空串 —— 让上游能用 `if (block)` 干净跳过。 */
  render_for_prompt(...args: Array<Rule[] | null | undefined>): string {
    pyArity("RuleEngine.render_for_prompt", [], ["rules"], 1, args.length);
    const rules = args[0];
    const list = rules !== null && rules !== undefined ? [...rules] : this.load();
    if (list.length === 0) {
      return "";
    }
    const lines: string[] = [
      "## 规则库（用户手写，必须遵守）",
      "",
      "以下规则来自项目 `.ovolve/rules/` 和用户全局 `~/.ovolve/rules/`，" +
        "按优先级从高到低排列。CRITICAL 规则不可忽略。",
        "",
    ];
    for (const r of list) {
      const badge = `[${r.priority}]`;
      const scope_tag = r.scope === "workspace" ? "项目" : "全局";
      lines.push(`### ${badge} ${r.title}  <sub>${scope_tag} · ${r.id}</sub>`);
      lines.push("");
      if (r.body) {
        lines.push(r.body);
        lines.push("");
      }
    }
    return pyRstrip(lines.join("\n")) + "\n";
  }

  /** 把当前规则库序列化成 dict，方便 IPC / WS 传给前端。 */
  snapshot(...args: Rule[][]): Record<string, unknown> {
    pyArity("RuleEngine.snapshot", [], [], 1, args.length);
    const rules = this.load();
    return {
      rules: rules.map((r) => ({
        id: r.id,
        title: r.title,
        priority: r.priority,
        scope: r.scope,
        sourcePath: r.source_path,
        excerpt: pyHead(r.body, 200),
      })),
      count: rules.length,
    };
  }
}

let _engine: RuleEngine | null = null;

/** 全局单例。第一次调用时确定 workspace_dir，之后 lazy 重载。 */
export function get_rule_engine(...args: Array<string | null | undefined>): RuleEngine {
  pyArity("get_rule_engine", [], ["workspace_dir"], 0, args.length);
  const workspace_dir = args[0];
  if (_engine === null) {
    _engine = new RuleEngine(workspace_dir);
  } else if (workspace_dir && _engine.workspace_dir !== path.resolve(workspace_dir)) {
    // 切换工作区时重建（避免旧 workspace 的规则残留）
    _engine = new RuleEngine(workspace_dir);
  }
  return _engine;
}
