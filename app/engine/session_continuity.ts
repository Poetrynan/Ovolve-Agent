/**
 * session_continuity.ts — 会话断点自愈与崩溃恢复引擎 (Phase 64 核心硬内化)。
 *
 * Ported from `app/backend/session_continuity.py` (137 lines).
 *
 * 1. 在长任务或多轮交互中，定期落盘会话快照 (Checkpoint)；
 * 2. 异常退出、崩溃或网络重连时，主代理自动探测断点并无缝自愈恢复；
 * 3. 恢复后向用户明确呈现已恢复状态与未完成目标。
 *
 * RULEBOOK CITATIONS
 *   §1  node:fs / node:path。
 *   §2  json.dump(indent=2, ensure_ascii=False) → JSON.stringify(data, null, 2)
 *       （JS 默认不转义非 ASCII，与 ensure_ascii=False 一致）。
 *   §2  Python logging → console 前缀（engine 内无 logging 框架，写入
 *       agent_logger 的调用方语义不变；此处保持与源一致的轻量输出）。
 *   §4  naming: session_continuity.py → session_continuity.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 生产级会话断点自愈引擎。 */
export class SessionContinuityEngine {
  checkpoints_dir: string;

  constructor(checkpoints_dir: string) {
    this.checkpoints_dir = checkpoints_dir;
    fs.mkdirSync(this.checkpoints_dir, { recursive: true });
  }

  _get_path(session_id: string): string {
    const safe_id = Array.from(session_id)
      .filter((c) => /[A-Za-z0-9\-_]/.test(c))
      .join("");
    return path.join(this.checkpoints_dir, `${safe_id}.checkpoint.json`);
  }

  save_checkpoint(kwargs: {
    session_id: string;
    goal_id?: string;
    current_step?: number;
    turn_seq?: number;
    uncommitted_files?: string[] | null;
    context_summary?: string;
    meta?: Record<string, unknown> | null;
  }): string {
    /** 持久化保存会话断点快照。 */
    const {
      session_id,
      goal_id = "",
      current_step = 0,
      turn_seq = 0,
      uncommitted_files = null,
      context_summary = "",
      meta = null,
    } = kwargs;
    if (!session_id) {
      return "";
    }

    const p = this._get_path(session_id);
    const payload = {
      session_id,
      goal_id,
      current_step,
      turn_seq,
      uncommitted_files: uncommitted_files ?? [],
      context_summary,
      meta: meta ?? {},
      timestamp: Date.now() / 1000,
      status: "in_progress",
    };
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf-8");

    console.log(
      `[SessionContinuityEngine] Checkpoint saved for ${session_id} at step ${current_step}`
    );
    return p;
  }

  /** 加载指定会话的断点快照。 */
  load_checkpoint(session_id: string): Record<string, unknown> | null {
    const p = this._get_path(session_id);
    if (!fs.existsSync(p)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    } catch (exc) {
      console.log(
        `[SessionContinuityEngine] Failed to load checkpoint ${p}: ${exc instanceof Error ? exc.message : String(exc)}`
      );
      return null;
    }
  }

  /** 会话圆满完成，标记或归档断点快照。 */
  mark_completed(session_id: string): boolean {
    const p = this._get_path(session_id);
    if (!fs.existsSync(p)) {
      return false;
    }
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      data["status"] = "completed";
      data["finished_at"] = Date.now() / 1000;
      fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  /** 列出所有可自愈恢复的未完结会话断点。 */
  list_recoverable_sessions(): Record<string, unknown>[] {
    const recoverable: Record<string, unknown>[] = [];
    if (!fs.existsSync(this.checkpoints_dir)) {
      return recoverable;
    }

    for (const fname of fs.readdirSync(this.checkpoints_dir)) {
      if (!fname.endsWith(".checkpoint.json")) {
        continue;
      }
      const fpath = path.join(this.checkpoints_dir, fname);
      try {
        const data = JSON.parse(fs.readFileSync(fpath, "utf-8")) as Record<string, unknown>;
        if (data["status"] === "in_progress") {
          recoverable.push(data);
        }
      } catch {
        continue;
      }
    }
    return recoverable.sort(
      (a, b) => Number(b["timestamp"] ?? 0) - Number(a["timestamp"] ?? 0)
    );
  }

  /** 物理清理断点文件。 */
  purge_checkpoint(session_id: string): boolean {
    const p = this._get_path(session_id);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
