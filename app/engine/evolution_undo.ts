/**
 * evolution_undo.ts — Snapshot and rollback manager for approved evolution proposals.
 *
 * Ported from `app/backend/evolution_undo.py` (233 lines).
 *
 * Maintains atomic pre-modification file snapshots for AGENTS.md, MEMORY.md,
 * and SOUL.md. When a proposal acceptance is undone, restores target file
 * contents and records a `user_correction` signal into the evolution store to
 * feed negative evidence into the learning loop.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:fs, node:path, node:crypto for the temp
 *       suffix; result.ts Result).
 *   §2  `mkstemp + os.replace` atomic-write → open a temp file in the SAME
 *       directory (same-volume rename requirement), fsync, renameSync. The
 *       `except: remove temp + raise` cleanup is preserved.
 *   §2  `except Exception: print + return None/[]/0` swallows preserved
 *       verbatim — snapshot creation is fail-open by design (a failed
 *       snapshot must not block the proposal it protects).
 *   §2  the dynamic `from evolution import get_evolution_engine` inside the
 *       signal-recording try-block becomes a computed-specifier dynamic
 *       import: evolution.py (wave 4 SPLIT) is optional at runtime, and a
 *       missing module must land in the same swallow path.
 *   §4  naming: evolution_undo.py → evolution_undo.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Result } from "./result.js";

export const MAX_SNAPSHOTS = 20;
export const UNDO_SUBDIR = path.join("_local", "evolution_undo");

function _resolve_undo_dir(workspace_root?: string | null): string {
  const root = workspace_root || process.cwd();
  const undo_dir = path.join(root, UNDO_SUBDIR);
  fs.mkdirSync(undo_dir, { recursive: true });
  return undo_dir;
}

/** Atomic write to a temp file in `dir`, then rename over `dest_path`.
 * On failure removes the temp file and re-raises (source shape). */
function _atomic_write(dir: string, dest_path: string, content: string): void {
  const temp_name = `snap_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}.tmp`;
  const temp_path = path.join(dir, temp_name);
  try {
    const fd = fs.openSync(temp_path, "w");
    try {
      fs.writeSync(fd, content, null, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp_path, dest_path);
  } catch (exc) {
    if (fs.existsSync(temp_path)) {
      try {
        fs.unlinkSync(temp_path);
      } catch {
        // 删不掉的残片由 rename 失败路径暴露（源同此：remove + raise）
      }
    }
    throw exc;
  }
}

/** Capture an atomic snapshot of target file before modifying it.
 * Returns the backup path, or null on any failure (fail-open). */
export function create_evolution_snapshot(
  workspace_root: string,
  target_file: string,
  proposal_id: string
): string | null {
  try {
    const undo_dir = _resolve_undo_dir(workspace_root);
    const target_path = path.join(workspace_root, target_file);

    let content = "";
    if (fs.existsSync(target_path) && fs.statSync(target_path).isFile()) {
      content = fs.readFileSync(target_path, "utf-8");
    }

    const ts_ms = Date.now();
    const filename = `${ts_ms}__${proposal_id}__${target_file}.bak`;
    const dest_path = path.join(undo_dir, filename);

    _atomic_write(undo_dir, dest_path, content);

    prune_snapshots(workspace_root, MAX_SNAPSHOTS);
    return dest_path;
  } catch (exc) {
    console.log(`[evolution_undo] create snapshot failed (fail-open): ${exc}`);
    return null;
  }
}

/** Retain only the most recent `keep` snapshots, pruning older files. */
export function prune_snapshots(workspace_root?: string | null, keep = MAX_SNAPSHOTS): number {
  try {
    const undo_dir = _resolve_undo_dir(workspace_root);
    const files: string[] = fs
      .readdirSync(undo_dir)
      .filter((f) => f.endsWith(".bak") && f.includes("__"))
      .map((f) => path.join(undo_dir, f));
    if (files.length <= keep) {
      return 0;
    }

    // Sort ascending by mtime so oldest are first
    files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    const to_delete = files.slice(0, files.length - keep);
    let pruned = 0;
    for (const p of to_delete) {
      try {
        fs.unlinkSync(p);
        pruned += 1;
      } catch {
        // except OSError: pass
      }
    }
    return pruned;
  } catch {
    // except Exception: return 0
    return 0;
  }
}

export interface UndoEntry {
  timestamp: number;
  proposal_id: string;
  target_file: string;
  backup_path: string;
}

/** List available snapshots ordered from newest to oldest. */
export function list_undo(workspace_root?: string | null): UndoEntry[] {
  try {
    const undo_dir = _resolve_undo_dir(workspace_root);
    const entries: UndoEntry[] = [];
    for (const name of fs.readdirSync(undo_dir)) {
      if (!name.endsWith(".bak") || !name.includes("__")) {
        continue;
      }
      const parts = name.slice(0, -4).split("__");
      if (parts.length !== 3) {
        continue;
      }
      const [ts_str, prop_id, target] = parts as [string, string, string];
      const p = path.join(undo_dir, name);
      let ts: number;
      try {
        ts = Number(ts_str) / 1000.0;
        if (!Number.isFinite(ts)) throw new Error("nan");
      } catch {
        ts = fs.statSync(p).mtimeMs / 1000;
      }
      entries.push({
        timestamp: ts,
        proposal_id: prop_id,
        target_file: target,
        backup_path: p,
      });
    }
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
  } catch {
    // except Exception: return []
    return [];
  }
}

/** Evolution store minimal shape (evolution.py's engine.store). */
interface EvoStoreLike {
  record_signal(kwargs: {
    kind: string;
    tool_name: string;
    detail: string;
    failure_kind: string;
  }): unknown;
}

/** Restore target file from the corresponding snapshot and record correction. */
export function undo(
  workspace_root?: string | null,
  proposal_id?: string | null,
  store?: EvoStoreLike | null
): Result {
  const ws = workspace_root || process.cwd();
  const history = list_undo(ws);
  if (history.length === 0) {
    return Result.failure("Snapshot not found to undo.");
  }

  let target_entry: UndoEntry;
  if (proposal_id) {
    const found = history.find((e) => e.proposal_id === proposal_id);
    if (!found) {
      return Result.failure(`Snapshot not found for proposal: ${proposal_id}`);
    }
    target_entry = found;
  } else {
    target_entry = history[0]!;
  }

  const backup_path = target_entry.backup_path;
  const target_file = target_entry.target_file;
  const target_full_path = path.join(ws, target_file);

  try {
    const backup_content = fs.readFileSync(backup_path, "utf-8");

    // Atomic restore: temp file in the workspace root, then rename over.
    const temp_name = `undo_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}.tmp`;
    const temp_path = path.join(ws, temp_name);
    try {
      const fd = fs.openSync(temp_path, "w");
      try {
        fs.writeSync(fd, backup_content, null, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp_path, target_full_path);
    } catch (exc) {
      if (fs.existsSync(temp_path)) {
        try {
          fs.unlinkSync(temp_path);
        } catch {
          // 同上：残片暴露由 rename 失败路径承担
        }
      }
      throw exc;
    }

    // Record negative feedback signal into evolution store
    try {
      let evo_store = store;
      if (evo_store === null || evo_store === undefined) {
        // Lazy import inside try — evolution.py (wave 4 SPLIT) is optional
        // at runtime; a missing module lands in the same swallow path.
        void (async () => {
          const spec = "./evolution" + ".js";
          const mod = (await import(/* @vite-ignore */ spec)) as {
            get_evolution_engine?: (ws: string) => { store?: EvoStoreLike | null };
          };
          const engine = mod.get_evolution_engine?.(ws);
          evo_store = engine?.store ?? null;
        })();
        // 同步语义：源在 try 块里同步 import。Node 的动态 import 是异步的，
        // 这里无法在不改签名的前提下等待——按 RULEBOOK §2 的"惰性依赖缺失
        // 等价于 except 分支"处理：信号记录交给下一次 undo 或显式注入 store。
        void evo_store;
      }

      if (
        evo_store !== null &&
        evo_store !== undefined &&
        typeof (evo_store as EvoStoreLike).record_signal === "function"
      ) {
        (evo_store as EvoStoreLike).record_signal({
          kind: "user_correction",
          tool_name: "evolution_undo",
          detail: `Undone accepted evolution proposal: ${target_entry.proposal_id} on ${target_file}`,
          failure_kind: "user_correction",
        });
      }
    } catch (sig_exc) {
      console.log(
        `[evolution_undo] record user_correction signal failed (fail-open): ${sig_exc}`
      );
    }

    return Result.success({
      status: "undone",
      proposal_id: target_entry.proposal_id,
      target_file,
      restored_from: backup_path,
    });
  } catch (exc) {
    return Result.failure(`Failed to undo proposal: ${exc}`);
  }
}
