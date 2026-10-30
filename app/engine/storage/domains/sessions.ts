/**
 * sessions.ts — storage domain mixin: sessions, messages, workspaces,
 * turn status, compaction, and the event-store/logger/audit passthroughs.
 *
 * Ported from `app/backend/storage.py` lines 1839–2329 + 3039–3164 (M1 domain).
 *
 * RULEBOOK CITATIONS:
 * - §1 node: builtins only (node:os for the bench-workspace basename check).
 * - §2 broad swallows around the trace/logger/audit writes are preserved
 *   verbatim — each failure lands in _audit_write_failed with its site name.
 * - §2 `str[:n]` codepoint slicing: list_user_turns previews and
 *   autotitle_session use Array.from(s) so the cut lands on the same
 *   character boundary as Python (HANDOFF §6.2).
 * - §2 dict ordering in upsert_workspace patch: Object.keys preserves the
 *   caller's insertion order exactly as the source's dict did.
 * - §4 naming: part of the storage unit (storage.py → storage/domains/).
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as os from "node:os";

import type { Row, JsonDict } from "../storage_types.js";
import { StorageBase, intSeconds } from "../../storage.js";
import { Result } from "../../result.js";
import { EventType } from "../../event_types.js";
import type { EventStore } from "../../event_store.js";
import { PROCESS_GENERATION, SUBAGENT_TERMINAL_STATUSES } from "../storage_consts.js";
import { pyJsonDumps } from "../storage_funcs.js";

/** The isolation a conversation owns, as stored on its row. */
export interface WorktreeBinding {
  path: string;
  branch: string;
  base: string;
  repo: string;
}

export interface SessionsDomainI {
  create_session(
    sid: string,
    title?: string,
    parent_id?: string | null,
    branch_point?: string | null,
    workspace?: string,
    worktree?: WorktreeBinding | null
  ): Result<string>;
  set_session_worktree(sid: string, worktree: WorktreeBinding): Result<string>;
  clear_session_worktree(sid: string): Result<string>;
  set_session_workspace(sid: string, path: string): Result<string>;
  branch(
    parent_id: string,
    branch_point: string | number,
    new_sid: string,
    title?: string
  ): Result<string>;
  add_message(
    sid: string,
    role: string,
    content: string,
    msg_type?: string,
    metadata?: JsonDict | null
  ): Result<string>;
  get_event_store(): EventStore;
  get_events(
    sid: string,
    from_seq?: number,
    to_seq?: number | null,
    limit?: number | null
  ): unknown[];
  verify_event_chain(sid: string): unknown;
  project_session_state(sid: string, at_seq?: number | null): unknown;
  fork_at_seq(
    source_sid: string,
    fork_seq: number,
    new_sid: string,
    title?: string | null
  ): unknown;
  get_session_log(sid: string): string;
  get_session_transcript(sid: string): JsonDict[];
  get_session_log_info(sid: string): JsonDict;
  get_messages(sid: string, limit?: number, offset?: number): JsonDict[];
  get_recent_messages(sid: string, limit?: number): JsonDict[];
  count_messages(sid: string): number;
  seq_of_last_message(sid: string): number;
  list_user_turns(sid: string, preview_chars?: number): JsonDict[];
  seq_of_nth_user_message(sid: string, ordinal: number): number | null;
  truncate_after_seq(sid: string, seq: number): Result<number>;
  list_sessions(limit?: number, workspace?: string | null): JsonDict[];
  list_workspaces(always_include?: string): JsonDict[];
  upsert_workspace(path: string, opts?: { touch_opened?: boolean } & Record<string, unknown>): void;
  rename_workspace(path: string, display_name: string): void;
  set_workspace_pinned(path: string, pinned: boolean | number): void;
  set_workspace_hidden(path: string, hidden: boolean | number): void;
  get_workspace_settings(path: string): JsonDict;
  set_workspace_settings(path: string, settings: JsonDict | null): JsonDict | void;
  get_session(sid: string): JsonDict | null;
  delete_session(sid: string): Result<string>;
  rename_session(sid: string, title: string): Result<string>;
  set_session_pinned(sid: string, pinned: boolean | number): Result<boolean>;
  set_turn_status(sid: string, status: string, substatus?: string, updated_at?: number): Result<string>;
  reset_stale_turn_status(stale?: string, to?: string): number;
  autotitle_session(sid: string, text: string, max_len?: number): Result<string>;
  cleanup_sessions(): [number, number];
  add_compaction(sid: string, summary: string, tb: unknown, ta: unknown): Result<string>;
}

/** Loud degradation for audit-side writes (storage.py module-level helper). */
function _audit_write_failed(what: string, exc: unknown): void {
  console.error(`[audit] event write failed during ${what}:`, exc);
}

export function applySessionsDomain(klass: typeof StorageBase): void {
  const proto = klass.prototype as unknown as Record<string, unknown>;

  proto.create_session = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    title = "",
    parent_id: string | null = null,
    branch_point: string | null = null,
    workspace = "",
    worktree: WorktreeBinding | null = null
  ): Result<string> {
    const self = this;
    const c = self._db("sessions");
    const now = intSeconds();
    const wt = worktree ?? null;
    c.execute(
      "INSERT OR IGNORE INTO sessions (id,title,created_at,updated_at,parent_id,branch_point,workspace,worktree_path,worktree_branch,worktree_base,worktree_repo) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        sid,
        title,
        now,
        now,
        parent_id,
        branch_point,
        workspace || "",
        wt ? String(wt.path || "") : "",
        wt ? String(wt.branch || "") : "",
        wt ? String(wt.base || "") : "",
        wt ? String(wt.repo || "") : "",
      ]
    );
    c.commit();
    try {
      self._trace.append({
        session_id: sid,
        event_type: EventType.SESSION_CREATED,
        payload: {
          title,
          parent_id,
          branch_point,
          workspace: workspace || "",
          ...(wt ? { worktree: { path: wt.path, branch: wt.branch, base: wt.base, repo: wt.repo } } : {}),
        },
        importance: "critical",
        // INSERT OR IGNORE above makes a repeated create a no-op for the
        // sessions table; this key makes it a no-op for the ledger too.
        idempotency_key: `session:create:${sid}`,
        actor: "system",
      });
      self._session_logger.initSession(sid, title, workspace || "");
      // 审计轨的父子关联在会话创建时登记。
      self._session_audit.noteParent(sid, String(parent_id ?? ""));
    } catch (exc) {
      _audit_write_failed("create_session", exc);
    }
    return Result.success(sid);
  };

  proto.set_session_worktree = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    worktree: WorktreeBinding
  ): Result<string> {
    const c = this._db("sessions");
    c.execute(
      "UPDATE sessions SET worktree_path=?, worktree_branch=?, worktree_base=?, worktree_repo=? WHERE id=?",
      [
        String(worktree.path || ""),
        String(worktree.branch || ""),
        String(worktree.base || ""),
        String(worktree.repo || ""),
        sid,
      ]
    );
    c.commit();
    return Result.success(sid);
  };

  proto.clear_session_worktree = function (
    this: StorageBase & SessionsDomainI,
    sid: string
  ): Result<string> {
    const c = this._db("sessions");
    c.execute(
      "UPDATE sessions SET worktree_path='', worktree_branch='', worktree_base='', worktree_repo='' WHERE id=?",
      [sid]
    );
    c.commit();
    return Result.success(sid);
  };

  // Re-tag a conversation's project. Used when its isolated copy is gone:
  // the row must fall back to the project the copy was carved from, or the
  // sidebar keeps showing a folder that no longer exists.
  proto.set_session_workspace = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    path: string
  ): Result<string> {
    const c = this._db("sessions");
    c.execute("UPDATE sessions SET workspace=? WHERE id=?", [String(path || ""), sid]);
    c.commit();
    return Result.success(sid);
  };

  proto.branch = function (
    this: StorageBase & SessionsDomainI,
    parent_id: string,
    branch_point: string | number,
    new_sid: string,
    title = ""
  ): Result<string> {
    const self = this;
    const c = self._db("sessions");
    const now = intSeconds();
    const parent = c.execute("SELECT workspace FROM sessions WHERE id=?", [parent_id]).fetchone() as Row | null;
    const workspace = parent ? String(parent["workspace"] ?? "") || "" : "";
    c.execute(
      "INSERT INTO sessions (id,title,created_at,updated_at,parent_id,branch_point,workspace) VALUES (?,?,?,?,?,?,?)",
      [new_sid, title || `Branch of ${parent_id}`, now, now, parent_id, String(branch_point), workspace]
    );
    const rows = c
      .execute(
        "SELECT * FROM session_messages WHERE session_id=? AND seq<=? ORDER BY seq",
        [parent_id, Math.trunc(Number(branch_point))]
      )
      .fetchall() as Row[];
    for (const m of rows) {
      c.execute("INSERT INTO session_messages VALUES (?,?,?,?,?,?,?,?)", [
        `${new_sid}_${m["seq"]}`,
        new_sid,
        m["role"],
        m["content"],
        m["msg_type"],
        m["metadata"],
        m["created_at"],
        m["seq"],
      ]);
    }
    c.commit();
    try {
      self._trace.append({
        session_id: new_sid,
        event_type: EventType.SESSION_FORKED,
        payload: {
          parent_id,
          branch_point: String(branch_point),
          title: title || `Branch of ${parent_id}`,
          workspace,
        },
        importance: "critical",
        idempotency_key: `session:fork:${new_sid}`,
        actor: "system",
      });
      self._session_logger.initSession(new_sid, title || `Branch of ${parent_id}`, workspace || "");
    } catch (exc) {
      _audit_write_failed("branch", exc);
    }
    return Result.success(new_sid);
  };

  proto.add_message = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    role: string,
    content: string,
    msg_type = "message",
    metadata: JsonDict | null = null
  ): Result<string> {
    const self = this;
    const c = self._db("sessions");
    const now = intSeconds();
    const mid = crypto.randomUUID();
    const seqRow = c
      .execute("SELECT COUNT(*) as x FROM session_messages WHERE session_id=?", [sid])
      .fetchone() as Row;
    const seq = Number(seqRow["x"]);
    c.execute("INSERT INTO session_messages VALUES (?,?,?,?,?,?,?,?)", [
      mid,
      sid,
      role,
      content,
      msg_type,
      pyJsonDumps(metadata ?? {}),
      now,
      seq,
    ]);
    c.execute("UPDATE sessions SET updated_at=? WHERE id=?", [now, sid]);
    c.commit();
    self._session_fts_upsert(sid, mid, content);
    const meta = (metadata ?? {}) as JsonDict;
    try {
      const etype =
        role === "user"
          ? EventType.USER_MESSAGE_SUBMITTED
          : role === "assistant"
            ? EventType.LLM_RESPONSE_COMPLETED
            : EventType.SYSTEM_CHECKPOINT_CREATED;
      self._trace.append({
        session_id: sid,
        event_type: etype,
        payload: { message_id: mid, role, content, msg_type, metadata: meta },
        importance: "critical",
        // The message row id is the natural identity of this fact.
        idempotency_key: `msg:${mid}`,
        actor: role === "user" ? "user" : "assistant",
        turn_id: typeof meta["turnId"] === "string" ? (meta["turnId"] as string) : null,
      });
    } catch (exc) {
      _audit_write_failed("add_message", exc);
    }

    try {
      if (role === "user") {
        self._session_logger.logUserInput(
          sid,
          content,
          meta["images"] as unknown[] | null,
          meta
        );
      } else if (role === "assistant") {
        const reasoning = (meta["reasoning"] ?? []) as unknown[];
        for (const r of reasoning) {
          const r_text = typeof r === "object" && r !== null ? String((r as JsonDict)["text"] ?? "") : String(r);
          if (r_text) {
            const dur =
              typeof r === "object" && r !== null ? Number((r as JsonDict)["durationMs"] ?? 0) : 0;
            self._session_logger.logThinking(sid, r_text, dur);
          }
        }
        const toolCalls = (meta["toolCalls"] ?? []) as unknown[];
        for (const tc of toolCalls) {
          if (typeof tc === "object" && tc !== null) {
            const t = tc as JsonDict;
            self._session_logger.logToolCall(
              sid,
              String(t["toolName"] ?? "unknown"),
              String(t["id"] ?? ""),
              (t["args"] ?? {}) as JsonDict,
              String(t["cwd"] ?? ""),
              String(t["riskLevel"] ?? "low")
            );
            self._session_logger.logToolResult(
              sid,
              String(t["toolName"] ?? "unknown"),
              String(t["id"] ?? ""),
              String(t["status"] ?? "completed"),
              Number(t["exitCode"] ?? 0),
              String(t["output"] ?? ""),
              t["result"]
            );
          }
        }
        self._session_logger.logAssistantResponse(
          sid,
          content,
          meta["images"] as unknown[] | null,
          meta
        );
      }
    } catch (exc) {
      _audit_write_failed("session_logger transcript", exc);
    }

    // P1-3 jsonl 审计轨：user=request，assistant=response。record 自身
    // fail-open，此处兜底防 tracker 对象本身异常——审计永不阻塞会话。
    try {
      const turnId = typeof meta["turnId"] === "string" ? (meta["turnId"] as string) : "";
      if (role === "user") {
        self._session_audit.record(sid, "request", {
          turnId: turnId,
          payload: { content, msg_type, metadata: meta },
        });
      } else if (role === "assistant") {
        self._session_audit.record(sid, "response", {
          turnId: turnId,
          model: typeof meta["model"] === "string" ? (meta["model"] as string) : "",
          tokens: (meta["tokens"] as JsonDict | null) ?? null,
          payload: { content, msg_type, metadata: meta },
        });
      }
    } catch (exc) {
      _audit_write_failed("session_audit", exc);
    }

    return Result.success(mid);
  };

  proto.get_event_store = function (this: StorageBase & SessionsDomainI): EventStore {
    const self = this;
    return self.event_store;
  };

  /** 第二参兼容 number（from_seq）与 options 对象（http_server 的 kwargs 口径）。 */
  proto.get_events = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    from_seq_or_opts: number | { from_seq?: number; to_seq?: number | null; limit?: number | null } = 0,
    to_seq: number | null = null,
    limit: number | null = null
  ): unknown[] {
    const self = this;
    let from_seq = 0;
    if (from_seq_or_opts !== null && typeof from_seq_or_opts === "object") {
      from_seq = Number(from_seq_or_opts.from_seq ?? 0);
      to_seq = from_seq_or_opts.to_seq ?? null;
      limit = from_seq_or_opts.limit ?? null;
    } else {
      from_seq = Number(from_seq_or_opts);
    }
    return self.event_store.read_stream(sid, from_seq, to_seq, limit);
  };

  proto.verify_event_chain = function (this: StorageBase & SessionsDomainI, sid: string): unknown {
    const self = this;
    return self.event_store.verify_chain(sid);
  };

  /** 第二参兼容 number（at_seq）与 options 对象（http_server 的 kwargs 口径）。 */
  proto.project_session_state = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    at_seq_or_opts?: number | null | { at_seq?: number | null }
  ): unknown {
    const self = this;
    let at_seq: number | null = null;
    if (at_seq_or_opts !== null && typeof at_seq_or_opts === "object") {
      at_seq = at_seq_or_opts.at_seq ?? null;
    } else {
      at_seq = at_seq_or_opts ?? null;
    }
    return self.projection_engine.project_session(sid, at_seq);
  };

  /** 第四参兼容 string（title）与 options 对象（http_server 的 kwargs 口径）。 */
  proto.fork_at_seq = function (
    this: StorageBase & SessionsDomainI,
    source_sid: string,
    fork_seq: number,
    new_sid: string,
    title_or_opts?: string | null | { title?: string | null }
  ): unknown {
    const self = this;
    let title: string | null = null;
    if (typeof title_or_opts === "string") {
      title = title_or_opts;
    } else if (title_or_opts && typeof title_or_opts === "object") {
      title = title_or_opts.title ?? null;
    }
    return self.projection_engine.fork_at_seq(source_sid, fork_seq, new_sid, title);
  };

  proto.get_session_log = function (this: StorageBase & SessionsDomainI, sid: string): string {
    const self = this;
    return self._session_logger.readLogText(sid);
  };

  proto.get_session_transcript = function (
    this: StorageBase & SessionsDomainI,
    sid: string
  ): JsonDict[] {
    const self = this;
    return self._session_logger.readTranscript(sid);
  };

  proto.get_session_log_info = function (this: StorageBase & SessionsDomainI, sid: string): JsonDict {
    const self = this;
    return self._session_logger.getLogInfo(sid);
  };

  /** 第二参兼容 number（limit）与 options 对象（http_server 的 kwargs 口径）。 */
  proto.get_messages = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    limit_or_opts: number | { limit?: number; offset?: number } = 100,
    offset = 0
  ): JsonDict[] {
    const self = this;
    let limit = 100;
    let off = offset;
    if (limit_or_opts !== null && typeof limit_or_opts === "object") {
      limit = Number(limit_or_opts.limit ?? 100);
      off = Number(limit_or_opts.offset ?? 0);
    } else {
      limit = Number(limit_or_opts);
    }
    // Oldest-first page: ORDER BY seq ascending = the FIRST N rows.
    return (
      self
        ._db("sessions")
        .execute(
          "SELECT * FROM session_messages WHERE session_id=? ORDER BY seq LIMIT ? OFFSET ?",
          [sid, limit, off]
        )
        .fetchall() as Row[]
    ).map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.get_recent_messages = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    limit = 20
  ): JsonDict[] {
    const self = this;
    // The NEWEST `limit` messages, still returned oldest-first.
    const n = Math.max(1, Math.trunc(limit || 1));
    const rows = self
      ._db("sessions")
      .execute(
        "SELECT * FROM session_messages WHERE session_id=? ORDER BY seq DESC LIMIT ?",
        [sid, n]
      )
      .fetchall() as Row[];
    return rows
      .slice()
      .reverse()
      .map((x) => ({ ...(x as Row) }) as JsonDict);
  };

  proto.count_messages = function (this: StorageBase & SessionsDomainI, sid: string): number {
    const self = this;
    const r = self
      ._db("sessions")
      .execute("SELECT COUNT(*) as x FROM session_messages WHERE session_id=?", [sid])
      .fetchone() as Row | null;
    return r ? Math.trunc(Number(r["x"] ?? 0)) : 0;
  };

  proto.seq_of_last_message = function (this: StorageBase & SessionsDomainI, sid: string): number {
    const self = this;
    const r = self
      ._db("sessions")
      .execute("SELECT MAX(seq) as x FROM session_messages WHERE session_id=?", [sid])
      .fetchone() as Row | null;
    return !r || r["x"] === null || r["x"] === undefined ? -1 : Math.trunc(Number(r["x"]));
  };

  proto.list_user_turns = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    preview_chars = 120
  ): JsonDict[] {
    const self = this;
    const rows = self
      ._db("sessions")
      .execute(
        "SELECT seq, content, created_at FROM session_messages " +
          "WHERE session_id=? AND role='user' ORDER BY seq",
        [sid]
      )
      .fetchall() as Row[];
    const out: JsonDict[] = [];
    let i = 0;
    for (const r of rows) {
      const text = String(r["content"] ?? "").trim();
      const cut = Math.trunc(preview_chars);
      // Python str[:n] is codepoint-based — Array.from reproduces the cut
      // boundary (HANDOFF §6.2); preview shows "…" when the text ran over.
      const chars = Array.from(text);
      out.push({
        ordinal: i,
        seq: Math.trunc(Number(r["seq"])),
        preview: chars.slice(0, cut).join("") + (chars.length > cut ? "…" : ""),
        created_at: r["created_at"],
      });
      i += 1;
    }
    return out;
  };

  proto.seq_of_nth_user_message = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    ordinal: number
  ): number | null {
    const self = this;
    const rows = self
      ._db("sessions")
      .execute(
        "SELECT seq FROM session_messages WHERE session_id=? AND role='user' ORDER BY seq",
        [sid]
      )
      .fetchall() as Row[];
    const ord = Math.trunc(ordinal);
    if (ord < 0 || ord >= rows.length) return null;
    return Math.trunc(Number(rows[ord]!["seq"]));
  };

  proto.truncate_after_seq = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    seq: number
  ): Result<number> {
    const self = this;
    const c = self._db("sessions");
    const nRow = c
      .execute(
        "SELECT COUNT(*) as x FROM session_messages WHERE session_id=? AND seq>=?",
        [sid, Math.trunc(seq)]
      )
      .fetchone() as Row;
    const n = Number(nRow["x"]);
    c.execute("DELETE FROM session_messages WHERE session_id=? AND seq>=?", [
      sid,
      Math.trunc(seq),
    ]);
    c.execute("UPDATE sessions SET updated_at=? WHERE id=?", [intSeconds(), sid]);
    c.commit();
    return Result.success(n);
  };

  proto.list_sessions = function (
    this: StorageBase & SessionsDomainI,
    limit = 200,
    workspace?: string | null
  ): JsonDict[] {
    const self = this;
    let rows: Row[];
    if (workspace !== null && workspace !== undefined) {
      rows = self
        ._db("sessions")
        .execute(
          `
                SELECT s.id, s.title, s.created_at, s.updated_at, s.pinned,
                       COALESCE(NULLIF(s.worktree_repo, ''), COALESCE(s.workspace, '')) AS workspace,
                       s.parent_id, CAST(s.branch_point AS INTEGER) AS branch_point,
                       s.worktree_path, s.worktree_branch, s.worktree_base,
                       (SELECT COUNT(*) FROM session_messages m WHERE m.session_id = s.id) AS message_count
                FROM sessions s
                WHERE COALESCE(NULLIF(s.worktree_repo, ''), COALESCE(s.workspace, '')) = ?
                  AND s.id NOT LIKE 'bench-%' AND s.id NOT LIKE 'tool-test-%'
                ORDER BY s.pinned DESC, s.updated_at DESC
                LIMIT ?
            `,
          [workspace, Math.trunc(limit)]
        )
        .fetchall() as Row[];
    } else {
      rows = self
        ._db("sessions")
        .execute(
          `
                SELECT s.id, s.title, s.created_at, s.updated_at, s.pinned,
                       COALESCE(NULLIF(s.worktree_repo, ''), COALESCE(s.workspace, '')) AS workspace,
                       s.parent_id, s.branch_point,
                       s.worktree_path, s.worktree_branch, s.worktree_base,
                       (SELECT COUNT(*) FROM session_messages m WHERE m.session_id = s.id) AS message_count
                FROM sessions s
                WHERE s.id NOT LIKE 'bench-%' AND s.id NOT LIKE 'tool-test-%'
                ORDER BY s.pinned DESC, s.updated_at DESC
                LIMIT ?
            `,
          [Math.trunc(limit)]
        )
        .fetchall() as Row[];
    }
    return (rows as Row[])
      .filter((r) => Number(r["message_count"] ?? 0) > 0)
      .map((r) => ({ ...(r as Row) }) as JsonDict);
  };

  proto.list_workspaces = function (
    this: StorageBase & SessionsDomainI,
    always_include = ""
  ): JsonDict[] {
    const self = this;
    const isBenchWs = (p: string): boolean => {
      if (!p) return false;
      const norm = p.split("\\").join("/").replace(/\/+$/, "");
      const base = norm.substring(norm.lastIndexOf("/") + 1).toLowerCase();
      return (
        base.startsWith("task_") || norm.includes("/task_") || norm.includes("eval_harness") || base.includes("bench-")
      );
    };

    // Session-derived counts + recency.
    const sess_rows = self
      ._db("sessions")
      .execute(
        `
            SELECT COALESCE(NULLIF(s.worktree_repo, ''), COALESCE(s.workspace, '')) AS path,
                   COUNT(DISTINCT s.id) AS session_count,
                   MAX(s.updated_at) AS last_used
            FROM sessions s
            WHERE s.id NOT LIKE 'bench-%' AND s.id NOT LIKE 'tool-test-%'
              AND (SELECT COUNT(*) FROM session_messages m
                   WHERE m.session_id = s.id AND m.role='user'
                   AND TRIM(COALESCE(m.content,'')) != '') > 0
            GROUP BY path
        `
      )
      .fetchall() as Row[];
    const by_path = new Map<string, JsonDict>();
    for (const r of sess_rows) {
      const d = r as Row;
      const path = String(d["path"] ?? "");
      if (isBenchWs(path)) continue;
      by_path.set(path, {
        path,
        session_count: Number(d["session_count"] ?? 0),
        last_used: Number(d["last_used"] ?? 0),
        display_name: "",
        pinned: 0,
        hidden: 0,
      });
    }
    // Overlay the explicit workspace rows.
    const ws_rows = self._db("sessions").execute("SELECT * FROM workspaces").fetchall() as Row[];
    for (const r of ws_rows) {
      const w = r as Row;
      const path = String(w["path"] ?? "");
      if (isBenchWs(path)) continue;
      let entry = by_path.get(path);
      if (entry === undefined) {
        entry = {
          path,
          session_count: 0,
          last_used: 0,
          display_name: "",
          pinned: 0,
          hidden: 0,
        };
        by_path.set(path, entry);
      }
      entry["display_name"] = String(w["display_name"] ?? "");
      entry["pinned"] = Number(w["pinned"] ?? 0);
      entry["hidden"] = Number(w["hidden"] ?? 0);
      // last_opened_at can be newer than any session (opened, not chatted).
      entry["last_used"] = Math.max(Number(entry["last_used"]), Number(w["last_opened_at"] ?? 0));
    }

    // The currently-bound folder always makes the list.
    if (always_include && !by_path.has(always_include)) {
      by_path.set(always_include, {
        path: always_include,
        session_count: 0,
        last_used: intSeconds(),
        display_name: "",
        pinned: 0,
        hidden: 0,
      });
    }

    // Hidden folders drop out unless they still have real sessions.
    const result = Array.from(by_path.values()).filter(
      (e) => !(Number(e["hidden"]) !== 0 && Number(e["session_count"]) === 0)
    );
    // Pinned first, then most-recent. Default workspace ('') sinks unless pinned.
    result.sort(
      (a, b) =>
        Number(b["pinned"]) - Number(a["pinned"]) ||
        (a["path"] === "" ? 0 : 1) - (b["path"] === "" ? 0 : 1) ||
        Number(b["last_used"]) - Number(a["last_used"])
    );
    return result;
  };

  proto.upsert_workspace = function (
    this: StorageBase & SessionsDomainI,
    path: string,
    opts: { touch_opened?: boolean } & Record<string, unknown> = {}
  ): void {
    const self = this;
    const { touch_opened = false, ...fields } = opts;
    // The default workspace has no row; its state is implicit.
    if (!path) return;
    const now = intSeconds();
    const c = self._db("sessions");
    const exists = c.execute("SELECT path FROM workspaces WHERE path=?", [path]).fetchone();
    if (!exists) {
      c.execute(
        "INSERT INTO workspaces (path, created_at, last_opened_at) VALUES (?,?,?)",
        [path, now, touch_opened ? now : 0]
      );
    }
    const allowed = new Set(["display_name", "pinned", "hidden", "settings_json", "last_opened_at"]);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.has(k)) patch[k] = v;
    }
    if (touch_opened) patch["last_opened_at"] = now;
    const keys = Object.keys(patch);
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k}=?`).join(",");
      c.execute(`UPDATE workspaces SET ${sets} WHERE path=?`, [
        ...keys.map((k) => patch[k]),
        path,
      ]);
    }
    c.commit();
  };

  proto.rename_workspace = function (
    this: StorageBase & SessionsDomainI,
    path: string,
    display_name: string
  ): void {
    const self = this;
    // Empty string reverts to path tail.
    self.upsert_workspace(path, { display_name: (display_name || "").trim() });
  };

  proto.set_workspace_pinned = function (
    this: StorageBase & SessionsDomainI,
    path: string,
    pinned: boolean | number
  ): void {
    const self = this;
    self.upsert_workspace(path, { pinned: pinned ? 1 : 0 });
  };

  proto.set_workspace_hidden = function (
    this: StorageBase & SessionsDomainI,
    path: string,
    hidden: boolean | number
  ): void {
    const self = this;
    self.upsert_workspace(path, { hidden: hidden ? 1 : 0 });
  };

  proto.get_workspace_settings = function (
    this: StorageBase & SessionsDomainI,
    path: string
  ): JsonDict {
    const self = this;
    if (!path) return {};
    const r = self
      ._db("sessions")
      .execute("SELECT settings_json FROM workspaces WHERE path=?", [path])
      .fetchone() as Row | null;
    if (!r || !r["settings_json"]) return {};
    try {
      return JSON.parse(String(r["settings_json"])) as JsonDict;
    } catch {
      // (json.JSONDecodeError, TypeError) -> {}
      return {};
    }
  };

  proto.set_workspace_settings = function (
    this: StorageBase & SessionsDomainI,
    path: string,
    settings: JsonDict | null
  ): JsonDict | void {
    const self = this;
    if (!path) return;
    const current = self.get_workspace_settings(path) as JsonDict;
    Object.assign(current, settings ?? {});
    self.upsert_workspace(path, { settings_json: pyJsonDumps(current) });
    return current;
  };

  proto.get_session = function (
    this: StorageBase & SessionsDomainI,
    sid: string
  ): JsonDict | null {
    const self = this;
    const r = self
      ._db("sessions")
      .execute("SELECT * FROM sessions WHERE id=?", [sid])
      .fetchone() as Row | null;
    return r ? ({ ...(r as Row) }) as JsonDict : null;
  };

  proto.delete_session = function (this: StorageBase & SessionsDomainI, sid: string): Result<string> {
    const self = this;
    const c = self._db("sessions");
    c.execute("DELETE FROM session_messages WHERE session_id=?", [sid]);
    c.execute("DELETE FROM sessions WHERE id=?", [sid]);
    // Ledger rows of this PARENT go too; matching on parent_session_id is
    // deliberate — child-session teardown passes the child id and those rows
    // must survive.
    c.execute("DELETE FROM subagent_runs WHERE parent_session_id=?", [sid]);
    c.commit();
    return Result.success(sid);
  };

  proto.rename_session = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    title: string
  ): Result<string> {
    const self = this;
    const c = self._db("sessions");
    c.execute("UPDATE sessions SET title=?, updated_at=? WHERE id=?", [title, intSeconds(), sid]);
    c.commit();
    return Result.success(title);
  };

  proto.set_session_pinned = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    pinned: boolean | number
  ): Result<boolean> {
    const self = this;
    const c = self._db("sessions");
    c.execute("UPDATE sessions SET pinned=? WHERE id=?", [pinned ? 1 : 0, sid]);
    c.commit();
    return Result.success(Boolean(pinned));
  };

  proto.set_turn_status = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    status: string,
    substatus = "",
    updated_at = 0
  ): Result<string> {
    const self = this;
    // Deliberately dumb: no validation, no transition rules (turn_state owns
    // the legality question).
    const c = self._db("sessions");
    c.execute(
      "UPDATE sessions SET turn_status=?, turn_substatus=?, status_updated_at=? WHERE id=?",
      [String(status), String(substatus || ""), Math.trunc(updated_at || intSeconds()), sid]
    );
    c.commit();
    return Result.success(String(status));
  };

  proto.reset_stale_turn_status = function (
    this: StorageBase & SessionsDomainI,
    stale = "running",
    to = "error"
  ): number {
    const self = this;
    const c = self._db("sessions");
    const cur = c.execute(
      "UPDATE sessions SET turn_status=?, turn_substatus='' WHERE turn_status=?",
      [to, stale]
    );
    c.commit();
    return cur.rowcount || 0;
  };

  proto.autotitle_session = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    text: string,
    max_len = 40
  ): Result<string> {
    const self = this;
    // Name a session after its first user message, once. Newlines collapse to
    // spaces because the sidebar row is single-line.
    const cur = self
      ._db("sessions")
      .execute("SELECT title FROM sessions WHERE id=?", [sid])
      .fetchone() as Row | null;
    const existing = (cur ? String(cur["title"] ?? "") : "") || "";
    if (existing && existing !== "Main session" && existing !== "New chat" && existing !== "新对话") {
      return Result.success(existing);
    }
    const clean = (text || "").split(/\s+/).join(" ").trim();
    if (!clean) return Result.success(existing);
    // Codepoint slicing for the title cut (str[:max_len] in Python).
    const chars = Array.from(clean);
    const title = chars.slice(0, max_len).join("") + (chars.length > max_len ? "…" : "");
    return self.rename_session(sid, title);
  };

  proto.cleanup_sessions = function (this: StorageBase & SessionsDomainI): [number, number] {
    const self = this;
    // One-time housekeeping: ghost sessions + placeholder titles.
    const c = self._db("sessions");
    // A session is real if it has at least one non-blank user message.
    const real = new Set(
      (c
        .execute(
          "SELECT DISTINCT session_id FROM session_messages " +
            "WHERE role='user' AND TRIM(COALESCE(content,'')) != ''"
        )
        .fetchall() as Row[]).map((r) => String(r["session_id"]))
    );
    const all_ids = (c.execute("SELECT id FROM sessions").fetchall() as Row[]).map((r) =>
      String(r["id"])
    );

    let deleted = 0;
    for (const sid of all_ids) {
      if (real.has(sid)) continue;
      c.execute("DELETE FROM session_messages WHERE session_id=?", [sid]);
      c.execute("DELETE FROM sessions WHERE id=?", [sid]);
      deleted += 1;
    }

    // Back-fill placeholder titles from the first user message.
    let retitled = 0;
    const placeholders = ["", "Main session", "New chat", "新对话"];
    for (const sid of real) {
      const row = c.execute("SELECT title FROM sessions WHERE id=?", [sid]).fetchone() as Row | null;
      if (!row || !placeholders.includes(String(row["title"] ?? ""))) continue;
      const first = c
        .execute(
          "SELECT content FROM session_messages WHERE session_id=? AND role='user' " +
            "AND TRIM(COALESCE(content,'')) != '' ORDER BY seq LIMIT 1",
          [sid]
        )
        .fetchone() as Row | null;
      if (!first) continue;
      const clean = String(first["content"] ?? "").split(/\s+/).join(" ").trim();
      if (!clean) continue;
      const chars = Array.from(clean);
      const title = chars.slice(0, 40).join("") + (chars.length > 40 ? "…" : "");
      c.execute("UPDATE sessions SET title=? WHERE id=?", [title, sid]);
      retitled += 1;
    }

    c.commit();
    return [deleted, retitled];
  };

  proto.add_compaction = function (
    this: StorageBase & SessionsDomainI,
    sid: string,
    summary: string,
    tb: unknown,
    ta: unknown
  ): Result<string> {
    const self = this;
    return self.add_message(sid, "system", summary, "compaction", {
      tokensBefore: tb,
      estimatedTokensAfter: ta,
    });
  };
}

// Module-level imports used inside the mixin bodies (kept at the bottom so
// the top of the file reads as the public contract).
import * as crypto from "node:crypto";
void os;
void PROCESS_GENERATION;
void SUBAGENT_TERMINAL_STATUSES;
