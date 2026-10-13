/**
 * project_memory_protocol.ts — Ovolve Project Memory Protocol (v1.0).
 *
 * Ported from `app/backend/project_memory_protocol.py` (420 lines).
 *
 * Implements:
 * 1. Strict 5-section standard structure for project-level MEMORY.md.
 * 2. Capacity guardrails: 200 lines / 2500 tokens.
 * 3. Explicit persistence intent gating.
 *
 * RULEBOOK CITATIONS
 *   §1  node:fs / node:path（DualTierMemoryManager 落盘）。
 *   §M  CPython 语义一律走共享镜像层 `./server/http_server_keys.js`
 *       （py_strip / py_lstrip_chars / PY_ISSPACE），无私有副本。
 *   §2  Python re 语义：意图/询问正则逐字转换（\b 在 JS 语义一致；
 *       re.IGNORECASE → i flag）；parse_line 的 [YYYY-MM-DD] 捕获组对齐
 *       （\d → \p{Nd}，\s → PY_ISSPACE 字符类，见下）。
 *   §2  `glob.glob` 目录扫描 → fs.readdirSync + 前缀过滤 + reverse sort
 *       （Python glob 返回全路径排序；TS 等价实现并保持"最新在前"）。
 *   §2  time.strftime → 手写 ymd/hms helpers（本地时区，与源一致）。
 *   §4  naming: project_memory_protocol.py → project_memory_protocol.ts
 *
 * REWRITE EVIDENCE（钉住的 CPython 3.13.12 事实，
 * `D:/ovolve-migration/tmp/mcond_oracle_facts.json`）：
 *   F7_splitlines — str.splitlines() 的边界集是
 *     \n \r \r\n(一个) \v \f \x1c \x1d \x1e \x85 \u2028 \u2029（不含 \x1f/\u200b/\ufeff）；
 *     空串 → []；"a\n" → ["a"]；"\n" → [""]。JS split(/\r\n|\r|\n/) 会漏
 *     \v\f\x1c-\x1e\x85\u2028\u2029 —— 故用本地 pmp_splitlines 镜像。
 *   F11_budget — tokens 用**码点**长度（`\U0001F600`*5002 → 2501，UTF-16 长度会翻倍）；
 *     estimate_token_count: 空串→0，否则 max(1, len//2)。
 *   F14_parse / F19_universal_read — parse 的 line.strip()/lstrip("- ").strip()
 *     是 CPython 空白集；[日期] 捕获 \d 匹配 Unicode Nd（如 ١٢٣٤），\s 是 PY_ISSPACE。
 *   F7/F19 — validate_memory_budget 的 lines = len(splitlines(text))。
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { PyAttributeErrorP, py_lstrip_chars, py_strip, PY_ISSPACE } from "./server/http_server_keys.js";

/**
 * `str.splitlines()`（F7）：按 Python 边界集切行（不带行尾），\r\n 记一个边界，
 * 尾部边界不产生空行，空串返回 []。码点级（代理对不拆）。
 */
export function pmp_splitlines(s: string): string[] {
  const BOUNDARY = new Set<number>([
    0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
  ]);
  const cps = Array.from(s);
  const lines: string[] = [];
  let cur: string[] = [];
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i] as string;
    const cp = ch.codePointAt(0) as number;
    if (BOUNDARY.has(cp)) {
      if (cp === 0x0d && i + 1 < cps.length && (cps[i + 1] as string) === "\n") i++; // \r\n 一个边界
      lines.push(cur.join(""));
      cur = [];
    } else {
      cur.push(ch);
    }
  }
  if (cur.length > 0) lines.push(cur.join(""));
  return lines;
}

export const PROTOCOL_VERSION = "2026-09-19.ovolve-project-memory.v1";
export const MAX_MEMORY_LINES = 200;
export const MAX_MEMORY_TOKENS = 2500;

export const SECTION_TITLES = [
  "1. 项目概览",
  "2. 当前状态",
  "3. 稳定信息与工作约定",
  "4. 决策记录",
  "5. 可复用经验与最佳实践",
];

// Explicit intent regex for durable memory persistence
const _INTENT_PATTERNS = [
  "记住",
  "存入记忆",
  "写入记忆",
  "保存(?:到)?记忆",
  "保存下来",
  "记录下来",
  "作为(?:团队|工程)?(?:工作)?(?:规范|约定)",
  "工作约定",
  "更新(?:项目)?记忆",
  "忘记",
  "删除记忆",
  "整理记忆",
  "\\bremember\\b",
  "\\bsave\\s+(?:to\\s+)?memory\\b",
  "\\bupdate\\s+memory\\b",
  "\\bkeep\\s+in\\s+mind\\b",
];
const _COMPILED_INTENTS = _INTENT_PATTERNS.map((p) => new RegExp(p, "i"));

// Inquiry phrases that shouldn't trigger persistence writes
const _INQUIRY_PATTERNS = [
  "^(?:你能|你会)?记住什么",
  "查(?:询|看)记忆",
  "什么是记忆",
  "how\\s+do\\s+you\\s+remember",
];
const _COMPILED_INQUIRIES = _INQUIRY_PATTERNS.map((p) => new RegExp(p, "i"));

/** Check if the user prompt explicitly requested durable memory storage. */
export function is_explicit_persistence_intent(user_text: string): boolean {
  const text = (user_text || "").trim();
  if (!text) {
    return false;
  }

  // Inquiries do not count as persistence requests
  for (const inq of _COMPILED_INQUIRIES) {
    if (inq.test(text)) {
      return false;
    }
  }

  for (const pat of _COMPILED_INTENTS) {
    if (pat.test(text)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// DecisionRecord
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  date: string;
  decision: string;
  reason: string;
  impact: string;
  source: string;
}

export function make_decision_record(kwargs: {
  date: string;
  decision: string;
  reason?: string;
  impact?: string;
  source?: string;
}): DecisionRecord {
  return {
    date: kwargs.date,
    decision: kwargs.decision,
    reason: kwargs.reason ?? "",
    impact: kwargs.impact ?? "",
    source: kwargs.source ?? "",
  };
}

export function decision_format_line(d: DecisionRecord): string {
  const parts: string[] = [`[${d.date}] ${d.decision}`];
  if (d.reason) {
    parts.push(`原因：${d.reason}`);
  }
  if (d.impact) {
    parts.push(`影响：${d.impact}`);
  }
  if (d.source) {
    parts.push(`来源：${d.source}`);
  }
  return "- " + parts.join("；");
}

export function decision_parse_line(line: string): DecisionRecord | null {
  // 源：raw = line.strip(); raw[1:] 是**码点**切片；re.match 的 \d == Unicode Nd、
  // \s == CPython 空白集（F14/F19 证据）；(.+) 不吃 \n，$ 只允许**末尾**换行。
  let raw = py_strip(line);
  if (raw.startsWith("-")) {
    raw = py_strip(Array.from(raw).slice(1).join(""));
  }
  const m = PMP_DATE_LINE_RE.exec(raw);
  if (!m) {
    return null;
  }
  const dt = m[1]!;
  const body = m[2]!;
  const chunks = body
    .split(/[；;]/)
    .map((c) => py_strip(c))
    .filter((c) => c);
  const decision = chunks.length > 0 ? chunks[0]! : "";
  let reason = "";
  let impact = "";
  let source = "";
  for (const chunk of chunks.slice(1)) {
    if (chunk.startsWith("原因：") || chunk.startsWith("原因:")) {
      reason = py_strip(Array.from(chunk).slice(3).join(""));
    } else if (chunk.startsWith("影响：") || chunk.startsWith("影响:")) {
      impact = py_strip(Array.from(chunk).slice(3).join(""));
    } else if (chunk.startsWith("来源：") || chunk.startsWith("来源:")) {
      source = py_strip(Array.from(chunk).slice(3).join(""));
    } else {
      if (!reason) {
        reason = chunk;
      } else if (!impact) {
        impact = chunk;
      } else {
        source = chunk;
      }
    }
  }
  return { date: dt, decision, reason, impact, source };
}

/**
 * PY_ISSPACE 的 JS 字符类源码（29 码点，与 §M 集逐位一致）。
 * 从集合生成，保证不漂移：\s 在 Python str 模式 == 这个集合（F1b）。
 */
const PMP_WS_CLASS = (() => {
  const parts: string[] = [];
  const arr = [...PY_ISSPACE].sort((a, b) => a - b);
  let i = 0;
  while (i < arr.length) {
    let j = i;
    while (j + 1 < arr.length && arr[j + 1] === (arr[j] ?? 0) + 1) j++;
    const lo = arr[i] as number;
    const hi = arr[j] as number;
    parts.push(lo === hi ? `\\u${lo.toString(16).padStart(4, "0")}` : `\\u${lo.toString(16).padStart(4, "0")}-\\u${hi.toString(16).padStart(4, "0")}`);
    i = j + 1;
  }
  return `[${parts.join("")}]`;
})();

const PMP_DATE_LINE_RE = new RegExp(
  `^\\[([\\p{Nd}]{4}-[\\p{Nd}]{2}-[\\p{Nd}]{2})\\]${PMP_WS_CLASS}*([^\\n]+)\\n?$`,
  "u",
);

// ---------------------------------------------------------------------------
// ProjectMemoryDocument
// ---------------------------------------------------------------------------

export interface ProjectMemoryDocument {
  overview: string[];
  current_status: string[];
  conventions: string[];
  decisions: DecisionRecord[];
  practices: string[];
}

export function make_pmd(): ProjectMemoryDocument {
  return { overview: [], current_status: [], conventions: [], decisions: [], practices: [] };
}

function _ymd(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function _hms(d = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function pmd_to_markdown(doc: ProjectMemoryDocument): string {
  const lines: string[] = [
    `# 项目记忆（PROJECT MEMORY）· ${PROTOCOL_VERSION}`,
    "",
    "> 本文件为项目级接力摘要与工程基线规范。受 200 行 / 2500 tokens 容量红线保护。",
    "",
  ];

  const sections: [string, string[]][] = [
    ["## 1. 项目概览", doc.overview],
    ["## 2. 当前状态", doc.current_status],
    ["## 3. 稳定信息与工作约定", doc.conventions],
  ];

  for (const [heading, items] of sections) {
    lines.push(heading);
    if (items.length === 0) {
      lines.push("- （暂无）");
    } else {
      for (const item of items) {
        let clean = pmd_strip_str(item); // 源：item.strip()（CPython 空白集）
        if (!clean.startsWith("-")) {
          clean = "- " + clean;
        }
        lines.push(clean);
      }
    }
    lines.push("");
  }

  lines.push("## 4. 决策记录");
  if (doc.decisions.length === 0) {
    lines.push("- （暂无）");
  } else {
    for (const dec of doc.decisions) {
      lines.push(decision_format_line(dec));
    }
  }
  lines.push("");

  lines.push("## 5. 可复用经验与最佳实践");
  if (doc.practices.length === 0) {
    lines.push("- （暂无）");
  } else {
    for (const prac of doc.practices) {
      let clean = pmd_strip_str(prac); // 源：prac.strip()
      if (!clean.startsWith("-")) {
        clean = "- " + clean;
      }
      lines.push(clean);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function pmd_parse(markdown_text: string): ProjectMemoryDocument {
  const doc = make_pmd();
  let current_sec: number | null = null;
  // F7/F19：markdown_text.splitlines() —— Python 边界集（pmp_splitlines），
  // 每个 token 再 .strip()（CPython 空白集）。
  const lines = pmp_splitlines(markdown_text);
  for (const line0 of lines) {
    const stripped = py_strip(line0);
    if (!stripped || stripped.startsWith("# ") || stripped.startsWith(">")) {
      continue;
    }

    if (stripped.startsWith("## 1.") || stripped.includes("项目概览")) {
      current_sec = 1;
      continue;
    } else if (stripped.startsWith("## 2.") || stripped.includes("当前状态")) {
      current_sec = 2;
      continue;
    } else if (stripped.startsWith("## 3.") || stripped.includes("稳定信息") || stripped.includes("工作约定")) {
      current_sec = 3;
      continue;
    } else if (stripped.startsWith("## 4.") || stripped.includes("决策记录")) {
      current_sec = 4;
      continue;
    } else if (stripped.startsWith("## 5.") || stripped.includes("可复用经验") || stripped.includes("最佳实践")) {
      current_sec = 5;
      continue;
    } else if (stripped.startsWith("##")) {
      current_sec = null;
      continue;
    }

    if (current_sec === null || stripped === "- （暂无）") {
      continue;
    }

    if (current_sec === 1) {
      doc.overview.push(stripped);
    } else if (current_sec === 2) {
      doc.current_status.push(stripped);
    } else if (current_sec === 3) {
      doc.conventions.push(stripped);
    } else if (current_sec === 4) {
      const rec = decision_parse_line(stripped);
      if (rec) {
        doc.decisions.push(rec);
      } else {
        doc.decisions.push(
          make_decision_record({
            date: _ymd(),
            decision: py_strip(py_lstrip_chars(stripped, "- ")), // 源：stripped.lstrip("- ").strip()
          })
        );
      }
    } else if (current_sec === 5) {
      doc.practices.push(stripped);
    }
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** `x.strip()` 的接收者面：非 str → CPython AttributeError（§M PyAttributeErrorP）。 */
function pmd_strip_str(v: unknown): string {
  if (typeof v !== "string") throw new PyAttributeErrorP(v, "strip");
  return py_strip(v);
}

/** Fast, deterministic heuristic token count estimate.
 * 2.5 characters per token is a safe benchmark.（F6/F11：len 是**码点**数） */
export function estimate_token_count(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.floor(Array.from(text).length / 2));
}

export function validate_memory_budget(markdown_text: string): Record<string, unknown> {
  // F7/F11/F19：lines = len(text.splitlines())，边界集见 pmp_splitlines
  const content_lines = pmp_splitlines(markdown_text).length;
  const token_count = estimate_token_count(markdown_text);

  const exceeds_lines = content_lines > MAX_MEMORY_LINES;
  const exceeds_tokens = token_count > MAX_MEMORY_TOKENS;
  const is_valid = !exceeds_lines && !exceeds_tokens;

  return {
    valid: is_valid,
    lines: content_lines,
    max_lines: MAX_MEMORY_LINES,
    tokens: token_count,
    max_tokens: MAX_MEMORY_TOKENS,
    exceeds_lines,
    exceeds_tokens,
  };
}

// ---------------------------------------------------------------------------
// DualTierMemoryManager
// ---------------------------------------------------------------------------

/** Manages the two-tier memory hierarchy:
 * 1. Top-level MEMORY.md — strictly limited to 200 lines / 2500 tokens.
 * 2. Slice files in .ovolve/memory/ (daily/ + topics/). */
export class DualTierMemoryManager {
  workspace_root: string;
  memory_dir: string;
  daily_dir: string;
  topics_dir: string;

  constructor(workspace_root: string) {
    this.workspace_root = path.resolve(workspace_root);
    this.memory_dir = path.join(this.workspace_root, ".ovolve", "memory");
    this.daily_dir = path.join(this.memory_dir, "daily");
    this.topics_dir = path.join(this.memory_dir, "topics");
  }

  _ensure_dirs(): void {
    fs.mkdirSync(this.daily_dir, { recursive: true });
    fs.mkdirSync(this.topics_dir, { recursive: true });
  }

  append_daily_log(text: string, session_id = "", date_str?: string | null): string {
    this._ensure_dirs();
    const ds = date_str || _ymd();
    const daily_path = path.join(this.daily_dir, `daily-${ds}.md`);

    const is_new = !fs.existsSync(daily_path);
    const t_str = _hms();
    const sess_prefix = session_id ? ` [session: ${session_id}]` : "";
    const entry = `- [${t_str}]${sess_prefix} ${text.trim()}\n`;

    if (is_new) {
      fs.appendFileSync(daily_path, `# 活动与记忆日记 (${ds})\n\n`, "utf-8");
    }
    fs.appendFileSync(daily_path, entry, "utf-8");

    return daily_path;
  }

  create_or_update_topic_slice(
    topic_id: string,
    title: string,
    content: string,
    tags?: string[] | null
  ): string {
    this._ensure_dirs();
    const safe_topic = topic_id
      .replace(/[^\w\-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const filename = `topic-${safe_topic}.md`;
    const topic_path = path.join(this.topics_dir, filename);

    const tags_str = (tags ?? []).map((t) => `"${t}"`).join(", ");
    const now = new Date();
    const updated_at = `${_ymd(now)} ${_hms(now)}`;

    const slice_text =
      `---\n` +
      `topic: ${topic_id}\n` +
      `title: ${title}\n` +
      `tags: [${tags_str}]\n` +
      `updated_at: "${updated_at}"\n` +
      `---\n\n` +
      `# ${title}\n\n` +
      `${content.trim()}\n`;

    fs.writeFileSync(topic_path, slice_text, "utf-8");

    return topic_path;
  }

  sync_index(): string {
    this._ensure_dirs();
    const mem_file = path.join(this.workspace_root, "MEMORY.md");

    let doc = make_pmd();
    if (fs.existsSync(mem_file)) {
      try {
        doc = pmd_parse(fs.readFileSync(mem_file, "utf-8"));
      } catch {
        // except Exception: pass
      }
    }

    // Scan recent daily logs (latest 7 days) — Python glob sorted reverse
    const daily_files = fs
      .readdirSync(this.daily_dir)
      .filter((f) => f.startsWith("daily-") && f.endsWith(".md"))
      .map((f) => path.join(this.daily_dir, f))
      .sort()
      .reverse();
    // Scan topic files
    const topic_files = fs
      .readdirSync(this.topics_dir)
      .filter((f) => f.startsWith("topic-") && f.endsWith(".md"))
      .map((f) => path.join(this.topics_dir, f))
      .sort();

    // Rebuild status section with slice index links
    const non_index_status = doc.current_status.filter(
      (item) => !item.includes("daily-") && !item.includes("topic-") && !item.includes("记忆切片索引")
    );

    const slice_links: string[] = ["活跃记忆切片索引与追踪："];
    for (const df of daily_files.slice(0, 7)) {
      const bname = path.basename(df);
      const rel = `.ovolve/memory/daily/${bname}`;
      slice_links.push(`日记索引: [${bname}](${rel})`);
    }

    for (const tf of topic_files.slice(0, 15)) {
      const bname = path.basename(tf);
      const rel = `.ovolve/memory/topics/${bname}`;
      let title = bname;
      try {
        const content = fs.readFileSync(tf, "utf-8");
        for (const line of content.split("\n")) {
          if (line.startsWith("title:")) {
            title = line.replace("title:", "").trim().replace(/^["']|["']$/g, "");
            break;
          }
        }
      } catch {
        // except Exception: pass
      }
      slice_links.push(`主题切片: [${title}](${rel})`);
    }

    doc.current_status = [...non_index_status, ...slice_links];

    let markdown_text = pmd_to_markdown(doc);

    // Verify budget guardrail
    const budget = validate_memory_budget(markdown_text);
    if (!budget["valid"]) {
      const lines = markdown_text.split("\n").slice(0, MAX_MEMORY_LINES);
      markdown_text = lines.join("\n");
    }

    fs.writeFileSync(mem_file, markdown_text, "utf-8");

    // Mirror into .ovolve/memory/MEMORY.md
    const ovolve_mem = path.join(this.memory_dir, "MEMORY.md");
    try {
      fs.writeFileSync(ovolve_mem, markdown_text, "utf-8");
    } catch {
      // except Exception: pass
    }

    return mem_file;
  }
}
