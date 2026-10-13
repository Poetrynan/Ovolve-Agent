/**
 * tool_output_spill.ts — 工具超长输出溢出转储与精简预览系统。
 *
 * Ported from `app/backend/tool_output_spill.py` (127 lines).
 *
 * 职责：
 * 1. 拦截超过阈值（默认 16,000 字符 / ~4,000 tokens）的超大工具执行输出；
 * 2. 自动将完整无损内容持久化落盘至本地会话 Spill 文件（`spills/spill_*.txt`）；
 * 3. 向模型上下文返回包含 Head-Tail 双端关键信息的紧凑有界预览；
 * 4. 彻底净化 Agent 上下文与自进化记忆提取（Pre-compaction Flush）。
 *
 * RULEBOOK CITATIONS
 *   §1  node:fs / node:path / node:os / node:crypto（uuid hex[:8]）。
 *   §2  源预览头 `[?? ...]` 的 `??` 是控制台 mojibake —— 字节探针证实为
 *       U+26A0 U+FE0F（⚠️），本移植直接使用真实字符（DIVERGENCE(port)：源文件字节即乱码显示，真实字符经探针证实后采用 —— 比源显示更忠实）。
 *   §2  `open(..., errors="replace")` → fs.readFileSync/writeFileSync 的
 *       utf-8 解码在 Node 下无效字节为 U+FFFD（与 errors="replace" 一致）。
 *   §4  naming: tool_output_spill.py → tool_output_spill.ts
 *
 * DIVERGENCE-FIXES (port rewritten to match CPython bug-for-bug; oracle facts
 * recorded in tmp/sptx_oracle_facts.json):
 *   A  len() code-point vs String.length UTF-16 (threshold gate, total_chars,
 *      omitted_chars) → pyLen();  evidence F3_charlen.emoji total_chars=1.
 *   B  str.splitlines() 11 boundaries + trailing-drop + ""→[] (total_lines,
 *      lines) → pySplitlines();  evidence F2_splitlines (cr/vtab/nel/"" faces).
 *   C  尾部标签 min(tail_lines, len(lines)-head_lines) may be NEGATIVE
 *      (single >threshold-char line → -39) → dropped the Math.max(0,…) clamp
 *      that had been added;  evidence template line 98 (F5 pending re-pin).
 *   D  readlines() universal-newline translation (\r\n, lone \r → \n) with
 *      terminators → pyReadlines();  evidence F6_read.crlf_file "a\r\nb\r\n"→"a\nb\n".
 *
 * PORT STATUS: confidence=high todos=0 (divergences A/B/C/D fixed)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── CPython-faithful primitives (divergence fixes A/B/D) ──────────────────
// DIVERGENCE-A (code-point length): Python len() counts CODE POINTS; JS
//   String.length counts UTF-16 code units. An astral char (😀 = U+1F600) is
//   len()==1 in CPython but .length==2 in JS. Oracle F3 (sptx_oracle_facts.json
//   F3_charlen.emoji) reports total_chars=1 for 😀. pyLen() closes the gap for
//   the threshold gate and total_chars/omitted_chars.
function pyLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// DIVERGENCE-B (splitlines): Python str.splitlines() recognises 11 line
//   boundaries (\n, \r, \r\n-as-one, \v, \f, \x1c, \x1d, \x1e, \x85, \u2028,
//   \u2029), drops the trailing empty element a final boundary would create,
//   and returns [] for "". JS String.split(/\r\n|\r|\n/) uses only 3 boundaries
//   and yields [""] for "". Oracle F2 (F2_splitlines) pins every boundary face;
//   e.g. "a\rb"->2, "a\x0bb"->2, "abc\n\n"->2, "\n"->1, ""->0.
function pySplitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/g);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// DIVERGENCE-D (readlines universal newlines): Python open(..., "r") in text
//   mode translates \r\n and lone \r to \n before readlines(); Node's
//   readFileSync returns raw decoded bytes with no translation. Oracle F6
//   (F6_read.crlf_file) pins b"a\r\nb\r\n" -> "a\nb\n". pyReadlines() emulates
//   the translation and keeps terminators on each line.
function pyReadlines(content: string): string[] {
  const translated = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (translated === "") return [];
  const seg = translated.split("\n");
  const lines = seg.map((l, i) => (i < seg.length - 1 ? l + "\n" : l));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export interface SpillResult {
  is_spilled: boolean;
  content: string;
  spill_id: string;
  spill_path: string;
  total_chars: number;
  total_lines: number;
}

/** 工具超长输出管理与安全转储器。 */
export class ToolOutputSpillManager {
  threshold_chars: number;
  head_lines: number;
  tail_lines: number;
  spill_dir: string;

  constructor(kwargs?: {
    threshold_chars?: number;
    head_lines?: number;
    tail_lines?: number;
    spill_dir?: string | null;
  }) {
    const { threshold_chars = 16000, head_lines = 40, tail_lines = 40, spill_dir = null } = kwargs ?? {};
    this.threshold_chars = threshold_chars;
    this.head_lines = head_lines;
    this.tail_lines = tail_lines;
    this.spill_dir = spill_dir || path.join(os.homedir(), ".ovolve", "spills");
    try {
      fs.mkdirSync(this.spill_dir, { recursive: true });
    } catch {
      // except Exception: pass
    }
  }

  /** 检查并处理超长输出。若未超限原样返回，超限则安全转储。 */
  process_output(
    raw_output: string,
    tool_name = "tool",
    session_id = "default",
    workspace?: string | null
  ): SpillResult {
    void session_id;
    if (!raw_output || pyLen(raw_output) <= this.threshold_chars) {
      const s = raw_output || "";
      return {
        is_spilled: false,
        content: s,
        spill_id: "",
        spill_path: "",
        total_chars: pyLen(s),
        total_lines: pySplitlines(s).length,
      };
    }

    const lines = pySplitlines(raw_output);
    const total_lines = lines.length;
    const total_chars = pyLen(raw_output);

    const spill_id = `spill_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    let target_dir = this.spill_dir;
    if (workspace && fs.existsSync(workspace) && fs.statSync(workspace).isDirectory()) {
      target_dir = path.join(workspace, ".ovolve", "spills");
    }
    try {
      fs.mkdirSync(target_dir, { recursive: true });
    } catch {
      target_dir = this.spill_dir;
    }

    const spill_path = path.join(target_dir, `${spill_id}_${tool_name}.txt`);

    // 写入全量无损文本；写失败时降级为错误串路径（源把 spill_path 变量
    // 重赋值为 "write_failed: ..."，预览与返回值都用降级串）
    let spill_path_out = spill_path;
    try {
      fs.writeFileSync(spill_path, raw_output, "utf-8");
    } catch (e) {
      spill_path_out = `write_failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    const head_part = lines.slice(0, this.head_lines).join("\n");
    const tail_part =
      total_lines > this.head_lines ? lines.slice(-this.tail_lines).join("\n") : "";
    const omitted_lines = Math.max(0, total_lines - this.head_lines - this.tail_lines);
    const omitted_chars = Math.max(0, total_chars - pyLen(head_part) - pyLen(tail_part));

    const rendered_preview =
      `[⚠️ 工具 \`${tool_name}\` 输出过长（共 ${total_chars} 字符 / ${total_lines} 行），已自动安全转储至磁盘以节省 Token 并防止上下文污染]\n` +
      `· 转储文件路径: ${spill_path_out}\n` +
      `· Spill ID: ${spill_id}\n\n` +
      `=== 头部输出 (前 ${Math.min(this.head_lines, total_lines)} 行) ===\n` +
      `${head_part}\n\n` +
      `... [中间已安全省略 ${omitted_lines} 行 / ${omitted_chars} 字符；如需精准查阅，可通过文件读取工具查看完整文件] ...\n\n` +
      `=== 尾部输出 (后 ${Math.min(this.tail_lines, lines.length - this.head_lines)} 行) ===\n` +
      `${tail_part}`;

    return {
      is_spilled: true,
      content: rendered_preview,
      spill_id,
      spill_path: spill_path_out,
      total_chars,
      total_lines,
    };
  }

  /** 从转储文件中切片读取特定行范围。 */
  read_spill(file_path: string, start_line = 1, line_count = 100): string {
    if (!fs.existsSync(file_path) || !fs.statSync(file_path).isFile()) {
      return `Error: Spill file not found: ${file_path}`;
    }
    try {
      const lines = pyReadlines(fs.readFileSync(file_path, "utf-8"));
      const start_idx = Math.max(0, start_line - 1);
      const end_idx = Math.min(lines.length, start_idx + line_count);
      return lines.slice(start_idx, end_idx).join("");
    } catch (e) {
      return `Error reading spill file: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// 全局单例
const _default_spill_mgr = new ToolOutputSpillManager();

export function get_spill_manager(): ToolOutputSpillManager {
  return _default_spill_mgr;
}
