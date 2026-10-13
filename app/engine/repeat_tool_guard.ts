/**
 * repeat_tool_guard.ts — 循环死锁与重复调用主动守卫。
 *
 * Ported from `app/backend/repeat_tool_guard.py` (107 lines).
 *
 * 职责：
 * 1. 在 AgentLoop 工具执行流中实时监控工具调用指纹；
 * 2. 识别连续相似调用且产出无进展的死循环模式；
 * 3. 生成建议性脱困提示（Advisory Context），引导模型跳出局部死锁；
 * 4. 输出结构化故障指纹（Failure Signature），直接作为高质量负反馈信号
 *    喂入 GEPA 自进化引擎。
 *
 * RULEBOOK CITATIONS
 *   §1  node:crypto (md5)；json sort_keys 序列化用 pyJsonDumps（与
 *       storage_funcs.ts 共享，跨构建稳定）。
 *   §2  md5 截断 12 位逐字保留（非安全用途，指纹碰撞可接受——源如此）。
 *   §4  naming: repeat_tool_guard.py → repeat_tool_guard.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";

import { pyJsonDumps } from "./storage/storage_funcs.js";

/** 提取参数的规范化哈希指纹，忽略字典键序与空值微小抖动。 */
function _normalize_args_fingerprint(args: unknown): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return String(args);
  }
  // 提取核心参数键值
  const clean_dict: Record<string, unknown> = {};
  const entries = Object.entries(args as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  for (const [k, v] of entries) {
    if (k === "session_id" || k === "timestamp" || k === "request_id") {
      continue;
    }
    if (typeof v === "string") {
      clean_dict[k] = v.trim();
    } else if (typeof v === "number" || typeof v === "boolean") {
      clean_dict[k] = v;
    } else if (Array.isArray(v) || (v !== null && typeof v === "object")) {
      clean_dict[k] = pyJsonDumps(v, true);
    }
  }
  const serialized = pyJsonDumps(clean_dict, true);
  return crypto.createHash("md5").update(serialized, "utf-8").digest("hex").slice(0, 12);
}

export interface ToolCallEntry {
  tool_name: string;
  args_fingerprint: string;
  args_summary: string;
  timestamp: number;
  outcome_ok: boolean;
  outcome_length: number;
}

/** 工具循环死锁检测器与脱困建议生成器。 */
export class RepeatToolGuard {
  max_window_size: number;
  repeat_threshold: number;
  history: ToolCallEntry[];
  _last_alert_fingerprint: string | null;

  constructor(max_window_size = 10, repeat_threshold = 3) {
    this.max_window_size = max_window_size;
    this.repeat_threshold = repeat_threshold;
    this.history = [];
    this._last_alert_fingerprint = null;
  }

  /** 记录一次工具调用的指纹。 */
  record_call(
    tool_name: string,
    args: Record<string, unknown>,
    outcome_ok = true,
    outcome_content = ""
  ): void {
    const fp = _normalize_args_fingerprint(args);
    const summary = String(JSON.stringify(args)).slice(0, 100);
    const entry: ToolCallEntry = {
      tool_name,
      args_fingerprint: fp,
      args_summary: summary,
      timestamp: Date.now() / 1000,
      outcome_ok,
      outcome_length: String(outcome_content || "").length,
    };
    this.history.push(entry);
    if (this.history.length > this.max_window_size) {
      this.history.shift();
    }
  }

  /** 检查当前窗口是否命中工具死循环模式。 */
  check_loop(): Record<string, unknown> | null {
    if (this.history.length < this.repeat_threshold) {
      return null;
    }

    // 检查尾部连续调用
    const tail = this.history.slice(-this.repeat_threshold);
    const target_tool = tail[0]!.tool_name;
    const target_fp = tail[0]!.args_fingerprint;

    // 如果尾部 N 次全都是同一个工具，且参数指纹一致或相似
    const is_exact_repeat = tail.every(
      (e) => e.tool_name === target_tool && e.args_fingerprint === target_fp
    );

    // 或者滑动窗口内同一工具、同一参数调用次数超过阈值
    const count = this.history.filter(
      (e) => e.tool_name === target_tool && e.args_fingerprint === target_fp
    ).length;

    if ((is_exact_repeat || count >= this.repeat_threshold) && target_fp !== this._last_alert_fingerprint) {
      this._last_alert_fingerprint = target_fp;
      return {
        detected: true,
        tool_name: target_tool,
        repeat_count: count,
        args_summary: tail[tail.length - 1]!.args_summary,
        advisory_message:
          `【系统防死循环守卫提示】: 你已连续 ${count} 次执行类似的 \`${target_tool}\` 操作且未取得新突破。` +
          "请停止重复盲试！请尝试：1) 更换排查关键词或检索策略；2) 查看目录树或文件结构；3) 向用户澄清或说明当前困境。",
        failure_signature: `repeat_loop:${target_tool}:${target_fp}`,
      };
    }
    return null;
  }

  /** 重置守卫历史。 */
  reset(): void {
    this.history.length = 0;
    this._last_alert_fingerprint = null;
  }
}
