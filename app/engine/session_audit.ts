/**
 * session_audit.ts — the per-session model I/O audit track.
 *
 * Ported from `app/backend/session_audit.py` (375 lines).
 *
 * Division of labour: SQLite (sessions/usage/events.db) is the **query face**;
 * this module's per-session jsonl is the **audit / replay face**. Both are
 * written in parallel and neither replaces the other.
 *
 * Design discipline, preserved in full:
 *   append-only  one `model_io.jsonl` per session, appended and never rewritten;
 *                rolled by size into N numbered files (`model_io.jsonl.1` newest,
 *                higher numbers older), in the same directory layout as
 *                `session_logger`.
 *   fail-open    an audit write failure NEVER blocks the main flow — log a
 *                warning, count the drop, keep going. Losing a stretch of audit
 *                is an observable loss; failing a conversation is not acceptable.
 *   replayable   every record carries a canonical `event_type`, so `read()`
 *                output can be replayed into a fresh EventStore and pass
 *                `verify_chain` — the same semantics as golden replay.
 *   parent link  every record carries `parent_ref`; sub-agent session ids look
 *                like `bench-x::sub::y`, so the directory name is sanitised
 *                exactly as `session_logger` does it. The logical id is not
 *                touched.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/session_audit.py -> app/engine/session_audit.ts
 *   §2  timestamps: reuses session_logger's Python-shaped isoformat helper
 *   §2  broad swallow: every fail-open catch is preserved, and the dropped count
 *       is kept so the loss stays observable
 *   §2  module-level mutable state: the singleton is preserved
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { SessionLogger, isoNowUtc } from "./session_logger.js";
import { homeDir } from "./user_dirs.js";

export type JsonDict = Record<string, unknown>;

/** Direction of each record. */
export const DIRECTION_REQUEST = "request";
export const DIRECTION_RESPONSE = "response";
export const DIRECTION_EVENT = "event";
export const DIRECTIONS: readonly string[] = [DIRECTION_REQUEST, DIRECTION_RESPONSE, DIRECTION_EVENT];

/**
 * Turn-event short name -> canonical EventType value (for replay). A name not in
 * this table falls to the DIRECTION_EVENT default: the audit track would rather
 * record the raw name than reject a record.
 */
const EVENT_TYPE_FOR_EVENT_NAME: Record<string, string> = {
  usage: "llm.response_completed",
  turn_started: "agent.turn_started",
  turn_completed: "agent.turn_completed",
  turn_paused: "agent.turn_paused",
  turn_resumed: "agent.turn_resumed",
  turn_cancelled: "agent.turn_cancelled",
  error: "llm.error_encountered",
  subagent_spawned: "subagent.spawned",
  subagent_completed: "subagent.completed",
  subagent_failed: "subagent.failed",
  tool_call: "tool.call_requested",
};

const DEFAULT_EVENT_TYPE: Record<string, string> = {
  [DIRECTION_REQUEST]: "llm.request_sent",
  [DIRECTION_RESPONSE]: "llm.response_completed",
  [DIRECTION_EVENT]: "agent.turn_started",
};

/**
 * A single payload larger than this is truncated — the audit track is a stream,
 * not a dumping ground, and one runaway tool output must not eat the whole
 * rolling quota on its own.
 */
const MAX_PAYLOAD_CHARS = 256 * 1024;

const TRUNCATION_MARK = "…[truncated by session audit track]";

/**
 * Shrink an oversized payload by truncating long string values; the facts still
 * land on disk.
 *
 * RULEBOOK §2 (numeric/string policy): preserved quirk — the size test is in
 * BYTES (`len(x.encode("utf-8"))`) while the slice is by CHARACTERS (`x[:N]`).
 * For non-ASCII text the two differ, so the truncated value can be shorter than
 * the limit suggests. Reproduced rather than "fixed": changing it would change
 * what lands in an existing audit format.
 */
export function truncatePayload(payload: JsonDict): JsonDict {
  try {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, "utf8") <= MAX_PAYLOAD_CHARS) {
      return payload;
    }
  } catch {
    // RULEBOOK §2 (broad swallow): an unserialisable payload becomes a repr of
    // itself rather than taking down the write.
    return { unserializable: String(payload).slice(0, 2000) };
  }

  const cut = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(cut);
    }
    if (node !== null && typeof node === "object") {
      const out: JsonDict = {};
      for (const [k, v] of Object.entries(node as JsonDict)) {
        out[k] = cut(v);
      }
      return out;
    }
    if (typeof node === "string" && Buffer.byteLength(node, "utf8") > MAX_PAYLOAD_CHARS) {
      // Character slice, matching the source.
      return node.slice(0, MAX_PAYLOAD_CHARS) + TRUNCATION_MARK;
    }
    return node;
  };

  return cut(payload) as JsonDict;
}

export interface AuditEntryFields {
  model?: string;
  turn?: number | null;
  turnId?: string;
  event?: string;
  eventType?: string;
  tokens?: JsonDict | null;
  payload?: JsonDict | null;
  parentRef?: string | null;
}

/** A duck-typed event store, as the source's `replay_into_store` expects. */
export interface ReplayStore {
  append(sessionId: string, eventType: string, payload: JsonDict): unknown;
}

/** Per-session model I/O jsonl audit track. Every write path is fail-open. */
export class SessionAuditTrack {
  static readonly FILE_NAME = "model_io.jsonl";

  baseDir: string;
  rotateBytes: number;
  keepFiles: number;
  /** Observability: how many audit writes fail-open dropped. A loss must be countable. */
  droppedWrites = 0;

  private _logger: SessionLogger | null;
  private _seqCounters: Map<string, number> = new Map();
  private _parentCache: Map<string, string> = new Map();
  private _parentLookup: ((sid: string) => string) | null;

  constructor(
    baseDir?: string | null,
    sessionLogger?: SessionLogger | null,
    parentLookup?: ((sid: string) => string) | null,
    opts: { rotateBytes?: number; keepFiles?: number } = {}
  ) {
    if (sessionLogger) {
      this._logger = sessionLogger;
      this.baseDir = sessionLogger.baseDir;
    } else {
      this._logger = null;
      // The source reads OVOLVE_LOGS_DIR twice; only one name ever mattered.
      const override = process.env["OVOLVE_LOGS_DIR"];
      this.baseDir = baseDir
        ? baseDir
        : override
          ? override
          : path.join(homeDir(), "logs", "sessions");
    }
    this.rotateBytes = Math.max(64, Math.trunc(opts.rotateBytes ?? 8 * 1024 * 1024));
    this.keepFiles = Math.max(1, Math.trunc(opts.keepFiles ?? 4));
    this._parentLookup = parentLookup ?? null;
  }

  // ── paths and naming ───────────────────────────────────────────────────

  private _sessionDir(sessionId: string): string {
    if (this._logger) {
      return this._logger.getSessionDir(sessionId);
    }
    const sdir = path.join(this.baseDir, SessionLogger._fsSafe(sessionId));
    fs.mkdirSync(sdir, { recursive: true });
    return sdir;
  }

  private _livePath(sessionId: string): string {
    return path.join(this._sessionDir(sessionId), SessionAuditTrack.FILE_NAME);
  }

  /** Rolled files, oldest -> newest (`.N` … `.1`). */
  private _rotatedPaths(sessionId: string): string[] {
    const sdir = this._sessionDir(sessionId);
    const out: string[] = [];
    for (let i = this.keepFiles; i > 0; i--) {
      const p = path.join(sdir, `${SessionAuditTrack.FILE_NAME}.${i}`);
      if (fs.existsSync(p)) {
        out.push(p);
      }
    }
    return out;
  }

  // ── parent linkage ─────────────────────────────────────────────────────

  /** Register the parent directly (known at create_session time, no lookup). */
  noteParent(sessionId: string, parentSessionId: string): void {
    this._parentCache.set(sessionId, String(parentSessionId || ""));
  }

  private _resolveParent(sessionId: string): string {
    const cached = this._parentCache.get(sessionId);
    if (cached !== undefined) {
      return cached;
    }
    let resolved = "";
    if (this._parentLookup) {
      try {
        resolved = String(this._parentLookup(sessionId) || "");
      } catch {
        // RULEBOOK §2: preserved — a lookup failure must not stop the audit write.
        resolved = "";
      }
    }
    this._parentCache.set(sessionId, resolved);
    return resolved;
  }

  // ── write ──────────────────────────────────────────────────────────────

  private _countLines(paths: string[]): number {
    let n = 0;
    for (const p of paths) {
      try {
        const buf = fs.readFileSync(p);
        // Count "\n" occurrences; every writer here terminates each line.
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 0x0a) {
            n++;
          }
        }
      } catch {
        continue;
      }
    }
    return n;
  }

  /** Carry seq across a process restart: on first sight, continue from the files' line counts. */
  private _nextSeq(sessionId: string): number {
    let cur = this._seqCounters.get(sessionId);
    if (cur === undefined) {
      cur = this._countLines(this._rotatedPaths(sessionId));
      const live = this._livePath(sessionId);
      if (fs.existsSync(live)) {
        cur += this._countLines([live]);
      }
    }
    const nxt = cur + 1;
    this._seqCounters.set(sessionId, nxt);
    return nxt;
  }

  private _rotateIfNeeded(sessionId: string): void {
    const live = this._livePath(sessionId);
    let size: number;
    try {
      size = fs.statSync(live).size;
    } catch {
      return;
    }
    if (size < this.rotateBytes) {
      return;
    }
    const sdir = path.dirname(live);
    for (let i = this.keepFiles - 1; i > 0; i--) {
      const src = path.join(sdir, `${SessionAuditTrack.FILE_NAME}.${i}`);
      const dst = path.join(sdir, `${SessionAuditTrack.FILE_NAME}.${i + 1}`);
      if (fs.existsSync(src)) {
        // RULEBOOK §2: Python's os.replace overwrites an existing destination on
        // Windows. Node's renameSync maps to MoveFileEx with REPLACE_EXISTING,
        // so it matches.
        fs.renameSync(src, dst);
      }
    }
    fs.renameSync(live, path.join(sdir, `${SessionAuditTrack.FILE_NAME}.1`));
    this._seqCounters.delete(sessionId); // line counts changed; recount next time
  }

  /**
   * Append one model I/O record. Returns whether it landed.
   *
   * fail-open: a failure only logs a warning and never throws — an audit track
   * has no standing to take down the session it is auditing.
   */
  record(sessionId: string, direction: string, f: AuditEntryFields = {}): boolean {
    try {
      let dir = direction;
      if (!DIRECTIONS.includes(dir)) {
        dir = DIRECTION_EVENT;
      }
      let etype = String(f.eventType ?? "").trim();
      if (!etype) {
        if (dir === DIRECTION_EVENT && f.event) {
          etype = EVENT_TYPE_FOR_EVENT_NAME[String(f.event)] ?? DEFAULT_EVENT_TYPE[dir]!;
        } else {
          etype = DEFAULT_EVENT_TYPE[dir]!;
        }
      }
      const entry: JsonDict = {
        seq: this._nextSeq(sessionId),
        ts: isoNowUtc(),
        // RULEBOOK §2: `time.time()` is epoch SECONDS as a float, not millis.
        ts_epoch: Date.now() / 1000,
        session_id: sessionId,
        direction: dir,
        event_type: etype,
        model: String(f.model ?? ""),
        // RULEBOOK §2 (nullability): `int(turn) if turn is not None` — 0 is a
        // real turn number and must survive; only null becomes null.
        turn: f.turn !== null && f.turn !== undefined ? Math.trunc(f.turn) : null,
        turn_id: String(f.turnId ?? ""),
        parent_ref: String(
          f.parentRef !== null && f.parentRef !== undefined ? f.parentRef : this._resolveParent(sessionId)
        ),
        tokens: { ...(f.tokens ?? {}) },
        event: String(f.event ?? ""),
        payload: truncatePayload({ ...(f.payload ?? {}) }),
      };
      const line = JSON.stringify(entry);
      this._rotateIfNeeded(sessionId);
      fs.appendFileSync(this._livePath(sessionId), line + "\n", "utf8");
      return true;
    } catch (exc) {
      this.droppedWrites += 1;
      // RULEBOOK §2 (fail-open discipline): preserved. The count above is the
      // reason this is not silent.
      console.warn(
        `[session_audit] model I/O track write failed for session=${sessionId} direction=${direction}: ${String(exc)}`
      );
      return false;
    }
  }

  // ── read / replay / archive ────────────────────────────────────────────

  /**
   * Read the whole stream back (oldest -> newest). Corrupt lines are skipped and
   * an unreadable directory returns whatever was read; never throws.
   */
  read(sessionId: string): JsonDict[] {
    const entries: JsonDict[] = [];
    try {
      const paths = this._rotatedPaths(sessionId);
      const live = this._livePath(sessionId);
      if (fs.existsSync(live)) {
        paths.push(live);
      }
      for (const p of paths) {
        try {
          const text = fs.readFileSync(p, "utf8");
          for (const raw of text.split("\n")) {
            const line = raw.trim();
            if (!line) {
              continue;
            }
            try {
              entries.push(JSON.parse(line) as JsonDict);
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }
      }
    } catch (exc) {
      console.warn(`[session_audit] read failed for session=${sessionId}: ${String(exc)}`);
    }
    // RULEBOOK §2 (sort stability): a stable sort on seq; missing seq sorts as 0.
    entries.sort((a, b) => Number(a["seq"] ?? 0) - Number(b["seq"] ?? 0));
    return entries;
  }

  /**
   * Replay the jsonl stream into an EventStore (same semantics as golden replay).
   *
   * Each record is appended under its canonical `event_type`, with the audit
   * metadata carried in the payload. The caller then runs
   * `store.verify_chain(session_id)` to prove the chain.
   */
  replayIntoStore(sessionId: string, store: ReplayStore): JsonDict {
    const entries = this.read(sessionId);
    let appended = 0;
    const problems: string[] = [];
    for (const e of entries) {
      const payloadOut: JsonDict = {};
      for (const [k, v] of Object.entries(e)) {
        if (k !== "seq") {
          payloadOut[k] = v;
        }
      }
      try {
        store.append(sessionId, (e["event_type"] as string) || "llm.request_sent", payloadOut);
        appended += 1;
      } catch (exc) {
        problems.push(`replay append failed at seq=${e["seq"]}: ${String(exc)}`);
      }
    }
    return { session_id: sessionId, appended, total: entries.length, problems };
  }

  /**
   * Archive a session: move every model_io file into an archive subdirectory and
   * return the destination path (null when there is nothing to archive). After
   * the call the session's seq restarts from 0.
   */
  archiveSession(sessionId: string, destName = ""): string | null {
    try {
      const sdir = this._sessionDir(sessionId);
      const dest = path.join(
        sdir,
        "model_io_archive",
        destName || localStamp()
      );
      const candidates = this._rotatedPaths(sessionId);
      const live = this._livePath(sessionId);
      if (fs.existsSync(live)) {
        candidates.push(live);
      }
      if (candidates.length === 0) {
        return null;
      }
      fs.mkdirSync(dest, { recursive: true });
      for (const p of candidates) {
        fs.renameSync(p, path.join(dest, path.basename(p)));
      }
      this._seqCounters.delete(sessionId);
      return dest;
    } catch (exc) {
      console.warn(`[session_audit] archive failed for session=${sessionId}: ${String(exc)}`);
      return null;
    }
  }
}

/** `datetime.now().strftime("%Y%m%d-%H%M%S")` — local time. */
function localStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// ── process-level singleton ────────────────────────────────────────────────

let _globalAuditTrack: SessionAuditTrack | null = null;

export function getSessionAuditTrack(
  baseDir?: string | null,
  sessionLogger?: SessionLogger | null,
  parentLookup?: ((sid: string) => string) | null
): SessionAuditTrack {
  if (_globalAuditTrack === null) {
    _globalAuditTrack = new SessionAuditTrack(baseDir, sessionLogger, parentLookup);
  }
  return _globalAuditTrack;
}
