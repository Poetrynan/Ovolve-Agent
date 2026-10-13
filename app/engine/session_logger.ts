/**
 * session_logger.ts — full-link conversation, reasoning and tool-execution log.
 *
 * Ported from `app/backend/session_logger.py` (323 lines).
 *
 * For every conversation between the agent and the user this maintains two
 * artefacts:
 *   1. `session.log`      — human-readable structured Markdown.
 *   2. `transcript.jsonl` — machine-readable event stream (agent transcript
 *                           standard), one JSON object per line.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/session_logger.py -> app/engine/session_logger.ts
 *   §2  timestamps: Python's `isoformat()` is NOT `toISOString()`; see below
 *   §2  broad swallow: the unparseable-line skip in read_transcript is kept
 *   §2  module-level mutable state: the singleton is preserved
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { homeDir } from "./user_dirs.js";

export type JsonDict = Record<string, unknown>;

/**
 * RULEBOOK §2 (timestamps): Python's `datetime.now(timezone.utc).isoformat()`
 * emits `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` — six fractional digits and a `+00:00`
 * offset. `Date.prototype.toISOString()` emits three digits and a `Z`. The value
 * lands in `transcript.jsonl`, which is a stored format other readers parse, so
 * the Python shape is reproduced rather than approximated.
 *
 * Python also omits the fractional part entirely when it is zero, which
 * `isoformat()` does by default. Reproduced.
 */
export function isoNowUtc(): string {
  const d = new Date();
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
  const time = `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  const micros = pad(d.getUTCMilliseconds() * 1000, 6);
  const frac = micros === "000000" ? "" : `.${micros}`;
  return `${date}T${time}${frac}+00:00`;
}

/**
 * `datetime.now().strftime("%Y-%m-%d %H:%M:%S")` — LOCAL time, second precision,
 * no timezone. Built from local getters, not UTC ones.
 */
function localNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Thread-safe full-link logger for agent-user conversations. */
export class SessionLogger {
  baseDir: string;
  private _stepCounters: Map<string, number> = new Map();

  constructor(baseDir?: string | null) {
    if (baseDir) {
      this.baseDir = baseDir;
    } else {
      // The source reads OVOLVE_LOGS_DIR twice (a duplicated key in the original
      // expression, which is why only one name ever mattered). Preserved as the
      // single effective lookup.
      const override = process.env["OVOLVE_LOGS_DIR"];
      if (override) {
        this.baseDir = override;
      } else {
        this.baseDir = path.join(homeDir(), "logs", "sessions");
      }
    }
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * Sanitise a session id for use as a directory name.
   *
   * Sub-agent session ids look like `bench-x::sub::y` — on Windows the `:` (and
   * `< > " / \ | ? *`) are illegal in file names and every audit write fails
   * with OSError 22/123. Keep the id readable but filesystem-safe; the
   * in-memory/logical id is untouched.
   */
  static _fsSafe(sessionId: string): string {
    return (sessionId || "").replace(/[<>:"/\\|?*]/g, "_");
  }

  getSessionDir(sessionId: string): string {
    const sdir = path.join(this.baseDir, SessionLogger._fsSafe(sessionId));
    fs.mkdirSync(sdir, { recursive: true });
    return sdir;
  }

  getTranscriptPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), "transcript.jsonl");
  }

  getLogPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), "session.log");
  }

  /**
   * RULEBOOK §2 (module-level mutable state / locks): the source guards this with
   * a `threading.Lock` because Python can run these appends on several threads.
   * Node executes JS on one thread, and every write below is a synchronous fs
   * call, so two appends cannot interleave within a tick. The lock is therefore
   * not reproduced — but the counters stay on the instance for the same reason
   * the source kept them there: the next step number must not restart per call.
   */
  private _nextStep(sessionId: string): number {
    let cur = this._stepCounters.get(sessionId);
    if (cur === undefined) {
      const tpath = this.getTranscriptPath(sessionId);
      if (fs.existsSync(tpath)) {
        try {
          // Python `readlines()` counts lines; splitting on "\n" and dropping the
          // trailing empty element gives the same count for a newline-terminated
          // file, which is what every writer here produces.
          const text = fs.readFileSync(tpath, "utf8");
          const lines = text.length === 0 ? [] : text.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          cur = lines.length;
        } catch {
          // RULEBOOK §2 (broad swallow): preserved — an unreadable transcript
          // restarts the counter at 0 rather than failing the log call.
          cur = 0;
        }
      } else {
        cur = 0;
      }
    }
    const nxt = cur + 1;
    this._stepCounters.set(sessionId, nxt);
    return cur;
  }

  /** Initialise the session directory and write the log header. */
  initSession(sessionId: string, title = "", workspace = ""): void {
    const logPath = this.getLogPath(sessionId);
    if (!fs.existsSync(logPath)) {
      const header =
        `# 📋 SESSION TRACE LOG: ${sessionId}\n` +
        `> **Title**: ${title || "Untitled Session"}\n` +
        `> **Created**: ${localNow()}\n` +
        `> **Workspace**: ${workspace || process.cwd()}\n` +
        `${"=".repeat(80)}\n\n`;
      fs.writeFileSync(logPath, header, "utf8");
    }
  }

  /** Append an event to both transcript.jsonl and session.log. */
  logEvent(
    sessionId: string,
    eventType: string,
    source: string,
    payload: JsonDict,
    humanText?: string | null
  ): void {
    const stepIdx = this._nextStep(sessionId);
    const tsIso = isoNowUtc();

    // 1. Machine-readable JSONL.
    const entry = {
      step_index: stepIdx,
      session_id: sessionId,
      timestamp: tsIso,
      type: eventType,
      source,
      payload,
    };
    // RULEBOOK §2 (string/bytes policy): `ensure_ascii=False` keeps non-ASCII
    // literal, which JSON.stringify does by default. Match.
    fs.appendFileSync(this.getTranscriptPath(sessionId), JSON.stringify(entry) + "\n", "utf8");

    // 2. Human-readable Markdown log.
    if (humanText) {
      fs.appendFileSync(this.getLogPath(sessionId), humanText + "\n\n", "utf8");
    }
  }

  /** Log the user's input prompt. */
  logUserInput(
    sessionId: string,
    content: string,
    images?: unknown[] | null,
    metadata?: JsonDict | null
  ): void {
    let textBlock = `## [${localNow()}] 👤 USER\n${content.trim()}`;
    if (images && images.length) {
      textBlock += `\n*(Attached ${images.length} images)*`;
    }
    this.logEvent(sessionId, "USER_INPUT", "USER", {
      content,
      images: images ?? [],
      metadata: metadata ?? {},
    }, textBlock);
  }

  /** Log an agent reasoning / CoT thinking block. */
  logThinking(sessionId: string, text: string, durationMs = 0.0, startedAt?: number | null): void {
    // RULEBOOK §2 (float formatting): `f"{x/1000:.1f}"` is fixed-point with one
    // decimal; toFixed(1) matches it, including the rounding mode.
    const durStr = durationMs > 0 ? `Thought for ${(durationMs / 1000).toFixed(1)}s` : "Thinking";
    const textBlock = `## [${localNow()}] 🧠 THINKING (${durStr})\n${text.trim()}`;
    this.logEvent(sessionId, "THINKING", "MODEL", {
      text,
      duration_ms: durationMs,
      started_at: startedAt ?? null,
    }, textBlock);
  }

  /** Log an agent tool invocation. */
  logToolCall(
    sessionId: string,
    toolName: string,
    callId: string,
    args: JsonDict,
    cwd = "",
    riskLevel = "low"
  ): void {
    const cmd =
      (args["CommandLine"] as string) ||
      (args["command"] as string) ||
      (args["cmd"] as string) ||
      (args["code"] as string) ||
      "";
    let textBlock = `## [${localNow()}] ⚡ TOOL CALL: \`${toolName}\` (call_id: \`${callId}\`)\n`;
    if (cmd) {
      textBlock += `- **Command / Code**:\n\`\`\`bash\n${cmd}\n\`\`\`\n`;
    }
    if (cwd) {
      textBlock += `- **Directory**: \`${cwd}\`\n`;
    }
    if (riskLevel && riskLevel !== "low") {
      textBlock += `- **Risk Level**: \`${riskLevel.toUpperCase()}\`\n`;
    }
    if (!cmd) {
      // RULEBOOK §2: `indent=2` + `ensure_ascii=False`.
      textBlock += `- **Args**:\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\`\n`;
    }
    this.logEvent(sessionId, "TOOL_CALL", "AGENT", {
      tool_name: toolName,
      call_id: callId,
      args,
      cwd,
      risk_level: riskLevel,
    }, textBlock.trim());
  }

  /** Log a tool execution result / output. */
  logToolResult(
    sessionId: string,
    toolName: string,
    callId: string,
    status = "completed",
    exitCode: number | null = 0,
    output = "",
    result: unknown = null,
    durationMs = 0.0,
    error = ""
  ): void {
    const durStr = durationMs > 0 ? `, Duration: ${(durationMs / 1000).toFixed(1)}s` : "";
    // RULEBOOK §2 (nullability): `exit_code is not None` — 0 is a real exit code
    // and must print, which is why the test is on null and not on falsiness.
    const exitStr = exitCode !== null ? `, Exit Code: ${exitCode}` : "";
    let textBlock =
      `## [${localNow()}] 📋 TOOL RESULT: \`${toolName}\` ` +
      `(Status: \`${status}\`${exitStr}${durStr})\n`;

    // RULEBOOK §2 (sentinel returns): the source chains `or`, so an empty output
    // string falls through to the result, and an empty result falls through to
    // the error. Reproduced with the same short-circuit order.
    const outContent = output || (result !== null && result !== undefined ? String(result) : "") || error;
    if (outContent) {
      textBlock += `\`\`\`\n${outContent.trim()}\n\`\`\``;
    } else {
      textBlock += "*(Completed with no output)*";
    }

    this.logEvent(sessionId, "TOOL_RESULT", "SYSTEM", {
      tool_name: toolName,
      call_id: callId,
      status,
      exit_code: exitCode,
      output,
      result,
      duration_ms: durationMs,
      error,
    }, textBlock);
  }

  /** Log the final assistant answer to the user. */
  logAssistantResponse(
    sessionId: string,
    content: string,
    images?: unknown[] | null,
    metadata?: JsonDict | null
  ): void {
    let textBlock = `## [${localNow()}] 🤖 ASSISTANT\n${content.trim()}`;
    if (images && images.length) {
      textBlock += `\n*(Generated ${images.length} images)*`;
    }
    this.logEvent(sessionId, "ASSISTANT_RESPONSE", "MODEL", {
      content,
      images: images ?? [],
      metadata: metadata ?? {},
    }, textBlock);
  }

  /** Read all events from transcript.jsonl. */
  readTranscript(sessionId: string): JsonDict[] {
    const tpath = this.getTranscriptPath(sessionId);
    if (!fs.existsSync(tpath)) {
      return [];
    }
    const events: JsonDict[] = [];
    for (const raw of fs.readFileSync(tpath, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      try {
        events.push(JSON.parse(line) as JsonDict);
      } catch {
        // RULEBOOK §2 (broad swallow, fail-open): preserved — a corrupt line is
        // skipped so the rest of the transcript still reads. A truncated final
        // line after a crash is the case this exists for.
      }
    }
    return events;
  }

  /** Read the raw text of session.log. */
  readLogText(sessionId: string): string {
    const lpath = this.getLogPath(sessionId);
    if (!fs.existsSync(lpath)) {
      return "";
    }
    return fs.readFileSync(lpath, "utf8");
  }

  /** File paths and statistics for the session logs. */
  getLogInfo(sessionId: string): JsonDict {
    const lpath = this.getLogPath(sessionId);
    const tpath = this.getTranscriptPath(sessionId);
    const lExists = fs.existsSync(lpath);
    const tExists = fs.existsSync(tpath);
    return {
      session_id: sessionId,
      log_path: path.resolve(lpath),
      transcript_path: path.resolve(tpath),
      log_exists: lExists,
      transcript_exists: tExists,
      log_size_bytes: lExists ? fs.statSync(lpath).size : 0,
      transcript_size_bytes: tExists ? fs.statSync(tpath).size : 0,
      step_count: this.readTranscript(sessionId).length,
    };
  }
}

// Singleton accessor.
let _globalSessionLogger: SessionLogger | null = null;

/**
 * RULEBOOK §2 (module-level mutable state): the source guards singleton creation
 * with a `threading.Lock`. Node is single-threaded and `SessionLogger`'s
 * constructor does no awaiting, so two concurrent calls cannot interleave here.
 * The lock is not reproduced; the singleton is.
 */
export function getSessionLogger(baseDir?: string | null): SessionLogger {
  if (_globalSessionLogger === null) {
    _globalSessionLogger = new SessionLogger(baseDir);
  }
  return _globalSessionLogger;
}
