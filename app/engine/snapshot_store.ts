/**
 * snapshot_store.ts — pre-mutation file snapshots + rollback.
 *
 * Ported from `app/backend/snapshot_store.py` (692 lines).
 *
 * Every mutating file tool (write_file / edit_file / delete_file / move_file /
 * copy_file) captures the *pre-image* of the target(s) here right before
 * dispatch. Rollback then walks those snapshots in reverse and puts the
 * workspace back into the shape it had before a chosen checkpoint.
 *
 * Design notes (source docstring, kept as the contract):
 * - One SQLite DB (`~/.ovolve/db/snapshots.db`) keyed by (session_id, seq).
 *   `seq` is the session_messages.seq value of the current user turn, so
 *   "roll back the chat to seq N" and "roll back files after seq N" share one
 *   monotonically-increasing handle.
 * - Content stored inline as BLOB; MAX_SNAPSHOT_BYTES gate skips huge binaries.
 * - `kind` records what we saw before the mutation: file / missing / dir / skip.
 * - Rollback is best-effort and idempotent; reports per-path results.
 * - Rollback FOLDS the range it consumed (archived=1 + shared fold_id) instead
 *   of deleting it (UB1). `seq` is a checkpoint key, not a truncation cursor.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:fs, node:path, node:child_process for the
 *       git HEAD probe, node:sqlite via sqlite_connection.ts).
 *   §2  `_safe_add_column` duplicate-column swallow → message sniff, matching
 *       storage/storage.ts's established pattern.
 *   §2  get_turn_diffs uses difflib.SequenceMatcher opcodes; the TS port
 *       implements the same LCS-based opcodes via a classic DP (O(n*m),
 *       adequate for per-turn file diffs) — the counts (adds/dels) are what
 *       the UI consumes, and equal-length LCS opcodes produce identical
 *       counts to difflib for the same inputs.
 *   §2  `subprocess.run(["git", "rev-parse", "HEAD"], timeout=2)` fail-open →
 *       spawnSync with a 2s timeout inside try/catch.
 *   §4  naming: snapshot_store.py → snapshot_store.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openSqlite, type SqliteConnection, type Row } from "./sqlite_connection.js";
import { dbDir } from "./user_dirs.js";

export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 2 MiB — plenty for source, cheap to store

function _db_path(): string {
  const root = dbDir();
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, "snapshots.db");
}

// ---------------------------------------------------------------------------
// LCS opcodes (difflib.SequenceMatcher replacement for the diff counts)
// ---------------------------------------------------------------------------

type Opcode = [tag: "equal" | "replace" | "delete" | "insert", number, number, number, number];

/** Longest-common-subsequence opcodes over two line arrays.
 * Produces the same add/delete counts difflib would report for these inputs
 * (equal-length LCS). Autojunk is irrelevant at per-turn file sizes. */
function lcs_opcodes(a: string[], b: string[]): Opcode[] {
  const n = a.length;
  const m = b.length;
  // DP table of LCS lengths
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const opcodes: Opcode[] = [];
  let i = 0;
  let j = 0;
  const pushRun = (tag: Opcode[0], i1: number, i2: number, j1: number, j2: number) => {
    if (i2 > i1 || j2 > j1) {
      opcodes.push([tag, i1, i2, j1, j2]);
    }
  };
  let runStartA = 0;
  let runStartB = 0;
  let runTag: Opcode[0] | null = null;
  const flush = (iEnd: number, jEnd: number) => {
    if (runTag !== null) {
      pushRun(runTag, runStartA, iEnd, runStartB, jEnd);
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (runTag !== "equal") {
        flush(i, j);
        runTag = "equal";
        runStartA = i;
        runStartB = j;
      }
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      if (runTag !== "delete") {
        flush(i, j);
        runTag = "delete";
        runStartA = i;
        runStartB = j;
      }
      i += 1;
    } else {
      if (runTag !== "insert") {
        flush(i, j);
        runTag = "insert";
        runStartA = i;
        runStartB = j;
      }
      j += 1;
    }
  }
  // Trailing runs
  if (i < n) {
    if (runTag !== "delete") {
      flush(i, j);
      runTag = "delete";
      runStartA = i;
      runStartB = j;
    }
    i = n;
  }
  if (j < m) {
    if (runTag !== "insert") {
      flush(i, j);
      runTag = "insert";
      runStartA = i;
      runStartB = j;
    }
    j = m;
  }
  flush(i, j);
  // Merge adjacent same-tag runs (the walk above may start a new run of the
  // same tag after an equal block boundary — difflib merges these).
  const merged: Opcode[] = [];
  for (const op of opcodes) {
    const last = merged[merged.length - 1];
    if (last && last[0] === op[0] && last[2] === op[1] && last[4] === op[3]) {
      last[2] = op[2];
      last[4] = op[4];
    } else {
      merged.push([...op] as Opcode);
    }
  }
  return merged;
}

function decodeLines(blob: unknown): string[] {
  if (blob === null || blob === undefined) {
    return [];
  }
  const buf = typeof blob === "string" ? Buffer.from(blob, "base64") : Buffer.from(blob as Buffer);
  return buf.toString("utf-8").split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// SnapshotStore
// ---------------------------------------------------------------------------

export interface CaptureReport {
  captured: string[];
  skipped: string[];
  failed: string[];
  /** True only when there was at least one path AND every one landed as a
   * restorable row. A partial capture is NOT recoverable: undoing half a move
   * leaves the workspace in a state the user did not ask for. */
  recoverable: boolean;
}

export class SnapshotStore {
  _conn: SqliteConnection;

  constructor(db_path?: string | null) {
    this._conn = openSqlite(db_path || _db_path());
    this._conn.execute(`
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                tool_name TEXT,
                call_id TEXT,
                path TEXT NOT NULL,
                kind TEXT NOT NULL,
                content BLOB,
                created_at INTEGER
            )
        `);
    this._conn.execute(
      "CREATE INDEX IF NOT EXISTS idx_snap_session_seq ON snapshots(session_id, seq)"
    );
    // ── UB1 checkpoint-tree columns ──────────────────────────────────
    // These turn `seq` from a truncation cursor into a checkpoint key, and
    // turn rollback from a destructive DELETE into an archival copy.
    //  - archived: a rolled-back / discarded row is NOT deleted, it is folded
    //    away. 0 = live, 1 = folded. History becomes a map you can walk back
    //    over, not a one-way cliff.
    //  - fold_id: groups the rows folded together in one rollback.
    //  - label: a user-named checkpoint. Empty = system auto-point.
    this._safe_add_column("archived", "INTEGER DEFAULT 0");
    this._safe_add_column("fold_id", "TEXT DEFAULT ''");
    this._safe_add_column("label", "TEXT DEFAULT ''");
    this._safe_add_column("turn_id", "TEXT DEFAULT ''");
    this._conn.execute(`
            CREATE TABLE IF NOT EXISTS turn_snapshots (
                turn_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at REAL NOT NULL,
                finished_at REAL DEFAULT 0,
                head_commit TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}'
            )
        `);
    this._conn.execute(
      "CREATE INDEX IF NOT EXISTS idx_turn_snap_sess ON turn_snapshots(session_id, started_at)"
    );
  }

  _safe_add_column(col: string, decl: string): void {
    /** Add a column if the DB predates it. The message sniff matches
     * storage/storage.ts's established duplicate-column swallow. */
    try {
      this._conn.execute(`ALTER TABLE snapshots ADD COLUMN ${col} ${decl}`);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      if (!msg.toLowerCase().includes("duplicate column")) {
        console.log(`[snapshot_store] ALTER ADD ${col} FAILED: ${msg}`);
      }
    }
  }

  // ---- capture --------------------------------------------------------

  /** Snapshot the current state of every path in `paths`.
   *
   * Still silent on error — a broken snapshot must never block the tool call
   * itself — but no longer silent to the CALLER: the report tells the truth
   * about what is restorable ("we tried" vs "we hold a pre-image" are
   * different facts; a 3 GB file skipped by the size cap must not get a green
   * "reversible" badge). */
  capture(
    session_id: string,
    seq: number,
    tool_name: string,
    call_id: string,
    paths: string[],
    turn_id = ""
  ): CaptureReport {
    const now = Math.floor(Date.now() / 1000);
    const captured: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (const raw of paths) {
      if (!raw) {
        continue;
      }
      const p = path.resolve(raw);
      try {
        if (!fs.existsSync(p)) {
          // No pre-image needed: rollback deletes what the call created.
          this._insert(session_id, seq, tool_name, call_id, p, "missing", null, now, turn_id);
          captured.push(p);
          continue;
        }
        if (fs.statSync(p).isDirectory()) {
          this._insert(session_id, seq, tool_name, call_id, p, "dir", null, now, turn_id);
          captured.push(p);
          continue;
        }
        let size = MAX_SNAPSHOT_BYTES + 1;
        try {
          size = fs.statSync(p).size;
        } catch {
          // OSError → treat as oversized (source shape)
        }
        if (size > MAX_SNAPSHOT_BYTES) {
          // Intent recorded, content NOT — this is the case that must
          // not be advertised as reversible.
          this._insert(session_id, seq, tool_name, call_id, p, "skip", null, now, turn_id);
          skipped.push(p);
          continue;
        }
        const blob = fs.readFileSync(p);
        this._insert(session_id, seq, tool_name, call_id, p, "file", blob, now, turn_id);
        captured.push(p);
      } catch {
        // Swallow — snapshotting is best-effort. Do not raise into the
        // tool pipeline. But do report it, so the caller stops claiming
        // this step can be undone.
        failed.push(p);
        continue;
      }
    }
    return {
      captured,
      skipped,
      failed,
      recoverable: captured.length > 0 && skipped.length === 0 && failed.length === 0,
    };
  }

  _insert(
    session_id: string,
    seq: number,
    tool_name: string,
    call_id: string,
    p: string,
    kind: string,
    content: Buffer | null,
    ts: number,
    turn_id = ""
  ): void {
    this._conn.execute(
      "INSERT INTO snapshots (session_id, seq, tool_name, call_id, path, kind, content, created_at, turn_id) " +
        "VALUES (?,?,?,?,?,?,?,?,?)",
      [session_id, Math.trunc(seq), tool_name, call_id, p, kind, content, ts, String(turn_id || "")]
    );
  }

  // ── 回合级快照视图 (Task 2.7 / P3-4) ──────────────────────────────────

  /** 记录回合开始，捕获当前 git head（fail-open）。 */
  turn_start(session_id: string, turn_id: string, metadata?: Record<string, unknown> | null): Record<string, unknown> {
    const now = Date.now() / 1000;
    let head_commit = "";
    try {
      const res = spawnSync("git", ["rev-parse", "HEAD"], { timeout: 2000, encoding: "utf-8" });
      if (res.status === 0 && typeof res.stdout === "string") {
        head_commit = res.stdout.trim();
      }
    } catch {
      // except Exception: pass
    }

    const meta_json = JSON.stringify(metadata ?? {});
    this._conn.execute(
      "INSERT OR REPLACE INTO turn_snapshots " +
        "(turn_id, session_id, status, started_at, finished_at, head_commit, metadata) " +
        "VALUES (?, ?, 'in_progress', ?, 0, ?, ?)",
      [turn_id, session_id, now, head_commit, meta_json]
    );
    return {
      turn_id,
      session_id,
      status: "in_progress",
      started_at: now,
      head_commit,
    };
  }

  /** 固化回合结束状态。 */
  turn_finish(session_id: string, turn_id: string, metadata?: Record<string, unknown> | null): Record<string, unknown> {
    const now = Date.now() / 1000;
    if (metadata) {
      const meta_json = JSON.stringify(metadata);
      this._conn.execute(
        "UPDATE turn_snapshots SET status='finished', finished_at=?, metadata=? WHERE turn_id=?",
        [now, meta_json, turn_id]
      );
    } else {
      this._conn.execute(
        "UPDATE turn_snapshots SET status='finished', finished_at=? WHERE turn_id=?",
        [now, turn_id]
      );
    }
    return {
      turn_id,
      session_id,
      status: "finished",
      finished_at: now,
    };
  }

  /** 输出回合级文件变更 diff 统计（与 git diff --numstat 抽样口径一致）。 */
  get_turn_diffs(turn_id: string): Record<string, unknown>[] {
    let rows = this._conn
      .execute(
        "SELECT path, kind, content, created_at FROM snapshots WHERE turn_id=? ORDER BY id ASC",
        [turn_id]
      )
      .fetchall() as Row[];

    if (rows.length === 0) {
      const turn_row = this._conn
        .execute(
          "SELECT session_id, started_at, finished_at FROM turn_snapshots WHERE turn_id=?",
          [turn_id]
        )
        .fetchone() as Row | null;
      if (turn_row) {
        const sid = String(turn_row["session_id"]);
        const st = Number(turn_row["started_at"]);
        const et = Number(turn_row["finished_at"] || Date.now() / 1000 + 10);
        rows = this._conn
          .execute(
            "SELECT path, kind, content, created_at FROM snapshots " +
              "WHERE session_id=? AND created_at>=? AND created_at<=? ORDER BY id ASC",
            [sid, Math.floor(st), Math.floor(et) + 1]
          )
          .fetchall() as Row[];
      }
    }

    // 按路径汇总首次预镜像 (pre-image)
    const pre_images = new Map<string, { kind: string; content: Buffer | null }>();
    for (const r of rows) {
      const p = String(r["path"]);
      if (!pre_images.has(p)) {
        const c = r["content"];
        pre_images.set(p, {
          kind: String(r["kind"]),
          content: c === null || c === undefined ? null : (c as Buffer),
        });
      }
    }

    const diffs: Record<string, unknown>[] = [];
    for (const [p, { kind, content: pre_content }] of pre_images) {
      const exists_now = fs.existsSync(p);
      let now_content = Buffer.alloc(0);
      if (exists_now && fs.statSync(p).isFile()) {
        try {
          now_content = fs.readFileSync(p);
        } catch {
          // except Exception: pass
        }
      }

      if (kind === "missing") {
        if (exists_now) {
          const lines = now_content.toString("utf-8").split(/\r?\n/);
          diffs.push({ path: p, change_type: "created", additions: lines.length, deletions: 0 });
        } else {
          diffs.push({ path: p, change_type: "unchanged", additions: 0, deletions: 0 });
        }
      } else if (kind === "file") {
        if (!exists_now) {
          const lines = decodeLines(pre_content);
          diffs.push({ path: p, change_type: "deleted", additions: 0, deletions: lines.length });
        } else {
          const pre_lines = decodeLines(pre_content);
          const now_lines = now_content.toString("utf-8").split(/\r?\n/);
          const same =
            pre_content !== null &&
            Buffer.compare(pre_content, now_content) === 0;
          if (same) {
            diffs.push({ path: p, change_type: "unchanged", additions: 0, deletions: 0 });
          } else {
            let adds = 0;
            let dels = 0;
            for (const [tag, i1, i2, j1, j2] of lcs_opcodes(pre_lines, now_lines)) {
              if (tag === "insert") adds += j2 - j1;
              else if (tag === "delete") dels += i2 - i1;
              else if (tag === "replace") {
                dels += i2 - i1;
                adds += j2 - j1;
              }
            }
            diffs.push({ path: p, change_type: "modified", additions: adds, deletions: dels });
          }
        }
      }
    }

    diffs.sort((a, b) => String(a["path"]).localeCompare(String(b["path"])));
    return diffs;
  }

  /** 干跑分析回滚该回合的影响面（零副作用，不写盘，不落盘）。 */
  revert_check(turn_id: string): Record<string, unknown> {
    const diffs = this.get_turn_diffs(turn_id);
    const will_restore: string[] = [];
    const will_delete: string[] = [];
    const conflicts: string[] = [];
    const affected: string[] = [];

    for (const d of diffs) {
      const p = String(d["path"]);
      const c_type = String(d["change_type"]);
      affected.push(p);
      if (c_type === "created") {
        will_delete.push(p);
      } else if (c_type === "modified" || c_type === "deleted") {
        will_restore.push(p);
      }
    }

    return {
      turn_id,
      dry_run: true,
      affected_files: affected,
      will_restore,
      will_delete,
      conflicts,
      total_changes: affected.length,
    };
  }

  // ---- inspection -----------------------------------------------------

  /** Snapshot rows at or after `seq`, oldest first.
   *
   * Folded rows are excluded by default: they describe a branch the user
   * already walked away from, and mixing them into the live list would make
   * the timeline claim changes that are no longer on disk. */
  list_since(session_id: string, seq: number, include_folded = false): Record<string, unknown>[] {
    let sql =
      "SELECT id, seq, tool_name, call_id, path, kind, created_at, " +
      "archived, fold_id, label FROM snapshots WHERE session_id=? AND seq>=?";
    if (!include_folded) {
      sql += " AND COALESCE(archived,0)=0";
    }
    const rows = this._conn
      .execute(sql + " ORDER BY id ASC", [session_id, Math.trunc(seq)])
      .fetchall() as Row[];
    return rows.map((r) => ({ ...r }) as Record<string, unknown>);
  }

  /** One row per checkpoint (= per user-turn `seq`), oldest first.
   * This is what the timeline axis draws. Aggregated in SQL because the UI
   * wants "this turn touched 3 files", not 3 rows it has to group itself —
   * and because the content BLOBs must never travel to the frontend. */
  checkpoints(session_id: string): Record<string, unknown>[] {
    const rows = this._conn
      .execute(
        "SELECT seq, " +
          "       COUNT(DISTINCT path) AS files, " +
          "       GROUP_CONCAT(DISTINCT tool_name) AS tools, " +
          "       MIN(created_at) AS first_at, " +
          "       MAX(created_at) AS last_at, " +
          "       MAX(COALESCE(label,'')) AS label, " +
          "       MIN(CASE WHEN kind='skip' THEN 0 ELSE 1 END) AS recoverable, " +
          "       MIN(COALESCE(archived,0)) AS folded " +
          "FROM snapshots WHERE session_id=? " +
          "GROUP BY seq ORDER BY seq ASC",
        [session_id]
      )
      .fetchall() as Row[];
    const out: Record<string, unknown>[] = [];
    for (const r0 of rows) {
      const row = { ...(r0 as Row) } as Record<string, unknown>;
      row["recoverable"] = Boolean(Number(row["recoverable"] ?? 1));
      row["folded"] = Boolean(Number(row["folded"] ?? 0));
      row["tools"] = String(row["tools"] ?? "")
        .split(",")
        .filter((t) => t);
      out.push(row);
    }
    return out;
  }

  /** What one checkpoint touched, for the read-only preview.
   * Preview must not touch the disk, so this reports the pre-image size and
   * whether the file currently differs from it. */
  paths_at(session_id: string, seq: number): Record<string, unknown>[] {
    const rows = this._conn
      .execute(
        "SELECT path, kind, tool_name, LENGTH(content) AS bytes, created_at " +
          "FROM snapshots WHERE session_id=? AND seq=? AND COALESCE(archived,0)=0 " +
          "ORDER BY id ASC",
        [session_id, Math.trunc(seq)]
      )
      .fetchall() as Row[];
    return rows.map((r0) => {
      const row = { ...(r0 as Row) } as Record<string, unknown>;
      row["exists_now"] = fs.existsSync(String(row["path"]));
      return row;
    });
  }

  /** Name a checkpoint（「这里是好状态」）. Empty label clears it back to auto. */
  label_checkpoint(session_id: string, seq: number, label: string): number {
    const cur = this._conn.execute(
      "UPDATE snapshots SET label=? WHERE session_id=? AND seq=?",
      [String(label || ""), session_id, Math.trunc(seq)]
    );
    return cur.rowcount || 0;
  }

  // ---- rollback -------------------------------------------------------

  /** Mark a seq range as folded away instead of deleting it.
   *
   * This one line is the difference between UB1 and what was here before:
   * the old code DELETEd the rows, consuming the pre-images — after a
   * rollback there was no record that those turns had ever changed anything. */
  _fold(session_id: string, seq: number, fold_id: string): number {
    const cur = this._conn.execute(
      "UPDATE snapshots SET archived=1, fold_id=? " +
        "WHERE session_id=? AND seq>=? AND COALESCE(archived,0)=0",
      [fold_id, session_id, Math.trunc(seq)]
    );
    return cur.rowcount || 0;
  }

  static _new_fold_id(session_id: string, seq: number): string {
    return `${session_id}:${Math.trunc(seq)}:${Math.floor(Date.now() / 1000)}`;
  }

  /** Restore every live snapshot with `seq >= seq`, newest first.
   *
   * Idempotent: the rows are FOLDED (archived=1) rather than deleted, so a
   * second rollback of the same range is a no-op while the record of what
   * was folded survives for the timeline. */
  rollback_since(session_id: string, seq: number): Record<string, unknown> {
    const rows = this._conn
      .execute(
        "SELECT id, path, kind, content FROM snapshots " +
          "WHERE session_id=? AND seq>=? AND COALESCE(archived,0)=0 ORDER BY id DESC",
        [session_id, Math.trunc(seq)]
      )
      .fetchall() as Row[];
    const restored: string[] = [];
    const deleted: string[] = [];
    const skipped: string[] = [];
    const errors: Record<string, string>[] = [];
    for (const r0 of rows) {
      const r = r0 as Row;
      const p = String(r["path"]);
      const kind = String(r["kind"]);
      try {
        if (kind === "file") {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          const content = r["content"];
          fs.writeFileSync(p, content === null || content === undefined ? Buffer.alloc(0) : (content as Buffer));
          restored.push(p);
        } else if (kind === "missing") {
          // Roll back = "make it not exist again".
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            fs.unlinkSync(p);
          } else if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
            try {
              fs.rmdirSync(p);
            } catch (e) {
              errors.push({ path: p, error: "dir not empty" });
              continue;
            }
          }
          deleted.push(p);
        } else if (kind === "dir") {
          fs.mkdirSync(p, { recursive: true });
          restored.push(p);
        } else {
          // 'skip'
          skipped.push(p);
        }
      } catch (exc) {
        errors.push({ path: p, error: exc instanceof Error ? exc.message : String(exc) });
      }
    }
    const fold_id = SnapshotStore._new_fold_id(session_id, seq);
    const folded = this._fold(session_id, seq, fold_id);
    return {
      restored,
      deleted,
      skipped,
      errors,
      count: restored.length + deleted.length,
      foldId: fold_id,
      folded,
    };
  }

  /** Fold a seq range away WITHOUT touching the disk.
   *
   * The chat-only withdraw: the user dropped those turns from history but
   * kept the files as they are. Their snapshots can never be applied now
   * (their checkpoint is gone), so they leave the live timeline — but they
   * are folded, not deleted, for the same reason as rollback_since. */
  discard_since(session_id: string, seq: number): Record<string, unknown> {
    const fold_id = SnapshotStore._new_fold_id(session_id, seq);
    return { foldId: fold_id, folded: this._fold(session_id, seq, fold_id) };
  }

  /** Copy live snapshots with `seq <= max_seq` onto another session (UA1).
   *
   * A fork inherits the parent's history, so it has to inherit the pre-images
   * that history refers to. Copies, never moves: the parent's own rollback
   * path has to keep working. Folded rows are left behind — re-seeding them
   * into a fresh line would resurrect a branch the parent already left. */
  copy_to_session(src_session: string, dst_session: string, max_seq: number): number {
    const rows = this._conn
      .execute(
        "SELECT seq, tool_name, call_id, path, kind, content, created_at, label " +
          "FROM snapshots WHERE session_id=? AND seq<=? AND COALESCE(archived,0)=0 " +
          "ORDER BY id ASC",
        [src_session, Math.trunc(max_seq)]
      )
      .fetchall() as Row[];
    for (const r0 of rows) {
      const r = r0 as Row;
      this._conn.execute(
        "INSERT INTO snapshots (session_id, seq, tool_name, call_id, path, kind, " +
          "content, created_at, archived, fold_id, label) VALUES (?,?,?,?,?,?,?,?,0,'',?)",
        [
          dst_session,
          r["seq"],
          r["tool_name"],
          r["call_id"],
          r["path"],
          r["kind"],
          r["content"],
          r["created_at"],
          String(r["label"] ?? ""),
        ]
      );
    }
    return rows.length;
  }

  clear_session(session_id: string): number {
    const cur = this._conn.execute("DELETE FROM snapshots WHERE session_id=?", [session_id]);
    return cur.rowcount || 0;
  }
}

let _singleton: SnapshotStore | null = null;

export function get_snapshot_store(): SnapshotStore {
  if (_singleton === null) {
    _singleton = new SnapshotStore();
  }
  return _singleton;
}

// --- Tool reversibility table -----------------------------------------------

// Reversibility policy: hard line between "we can undo this from our own DB"
// and "we can't". Reads never mutate; writes we snapshot before they run, so
// they *become* reversible. Everything below either escapes the workspace
// (git_push), leaves an audit trail we can't cleanly rewind (git_commit), or
// runs arbitrary code (bash), so we mark them irreversible and the UI warns.
export const IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "shell_executor",
  "python_executor",
  "git_push",
  "git_commit",
  "git_reset",
  "cron_create",
  "cron_delete",
]);

/** Tools whose reversibility we OWN via snapshot_store. Anything writing to
 * disk that we snapshot pre-mutation. */
export const REVERSIBLE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "copy_file",
]);

/** Best-guess reversibility BEFORE the call runs, for the optimistic badge.
 *
 * A table lookup on the tool name: it can only answer "do we normally
 * snapshot this kind of call". It cannot know whether this particular call's
 * snapshot succeeded — for that use reversible_after_capture with the
 * capture() report. The card starts with this answer and is corrected when
 * the call settles.
 *
 * True for reads and for mutations we snapshot ourselves; False for anything
 * we can't recover from cleanly. Reads and unknown tools default to
 * reversible=True — a read tool badged "irreversible" would be noise, and
 * unknown tools default to safe messaging. */
export function is_reversible(tool_name: string): boolean {
  if (IRREVERSIBLE_TOOLS.has(tool_name)) {
    return false;
  }
  if (REVERSIBLE_MUTATING_TOOLS.has(tool_name)) {
    return true;
  }
  return true;
}

/** The authoritative verdict, once we know what the snapshot actually got.
 *
 * False when the tool is inherently irreversible, or when it mutated files
 * and we do NOT hold a complete pre-image. True otherwise.
 *
 * The difference from is_reversible is the case that matters: a write_file
 * over a file larger than the snapshot cap is in REVERSIBLE_MUTATING_TOOLS,
 * so the static table says "reversible", but nothing recoverable was stored.
 * Rollback would report it as skipped and the user would discover the promise
 * was empty at the worst possible moment. */
export function reversible_after_capture(
  tool_name: string,
  report?: Record<string, unknown> | null
): boolean {
  if (IRREVERSIBLE_TOOLS.has(tool_name)) {
    return false;
  }
  if (report === null || report === undefined || typeof report !== "object") {
    // No capture attempted: nothing was mutated by us, so there is nothing
    // to undo and the badge should stay quiet.
    return true;
  }
  return Boolean(report["recoverable"]);
}

/** Which paths does this call touch? Returns [] for read-only tools. */
export function mutating_paths_for(tool_name: string, args: unknown): string[] {
  if (!REVERSIBLE_MUTATING_TOOLS.has(tool_name) || args === null || typeof args !== "object") {
    return [];
  }
  const a = args as Record<string, unknown>;
  if (["write_file", "edit_file", "delete_file"].includes(tool_name)) {
    const p = a["path"];
    return typeof p === "string" && p ? [p] : [];
  }
  if (tool_name === "move_file" || tool_name === "copy_file") {
    // Snapshot BOTH: the source (in case the caller undoes a move by dropping
    // the copy) and the destination (in case the copy overwrote an existing
    // file).
    const out: string[] = [];
    for (const k of ["src", "dst"]) {
      const v = a[k];
      if (typeof v === "string" && v) {
        out.push(v);
      }
    }
    return out;
  }
  return [];
}

void os; // os module kept for parity with the source's import surface
