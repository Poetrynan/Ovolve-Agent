/**
 * session_host.ts — Manages multiple Router sessions in a single process.
 *
 * Ported from `app/backend/session_host.py` (346 lines, wave-8, unit 189).
 *
 * Implements the "Agent Host" pattern (VS Code 2026 / Zed ACP):
 *   - One backend process holds N independent agent sessions.
 *   - Each session owns its own Router instance (workspace, mode, compactor, etc.).
 *   - Low-level services (storage, bus, tools, models, LLM) are shared.
 *   - Concurrent windows connect to their respective sessions via WS.
 *
 * Usage from http_server.ts:
 *     const host = new SessionHost(cfg.system_prompt);
 *     const router = host.get_or_create(session_id, workspace);
 *     const result = await router.handle(message, context);
 *
 * RULEBOOK CITATIONS
 *   §2  `class X(RuntimeError)` → `class X extends Error` with `name` pinned, so
 *       the type survives as a distinguishable value (`instanceof`).
 *   §2  `dict` used as an ordered structure → `Map` (the source relies on
 *       insertion order for `next(iter(...))`, oldest-first eviction and
 *       `list_sessions`); RULEBOOK §2's Map branch.
 *   §2  `uuid.uuid4().hex` → node:crypto `randomUUID().replace(/-/g, "")` — 32
 *       lowercase hex chars, NOT the hyphenated form (`str(uuid4())` is a
 *       different thing and is used elsewhere in this repo).
 *   §2  `time.monotonic()` → `performance.now() / 1000` (monotonic by contract in
 *       Node; the absolute origin differs, which is fine — the source only ever
 *       compares monotonic values against each other). Seam-replaceable.
 *   §2  `repr(str)` in the LifecycleMismatch message → `pyRepr` (CPython's quote
 *       rule: double quotes when the value holds a `'` and no `"`).
 *   §2  `os.getcwd()` → `process.cwd()`. Seam-replaceable (host touchpoint).
 *   §4  naming: app/backend/session_host.py -> app/engine/session_host.ts.
 *       Private field names are preserved verbatim (`_sessions`, `_dedupe`,
 *       `_pending_runs`, `_shared_mounted`, `_generation_id`, `_system_prompt`,
 *       `_default_workspace`) because the port's probes and any future reviewer
 *       read them against the source.
 *
 * DIVERGENCE(port): `from router import Router` is a static import in python and
 * the module exists. `router.ts` is an unported unit (188), so the constructor is
 * injected through `SESSION_HOST_SEAMS.Router`. Default = the real `./router.js`
 * once unit 188 lands; until then the default throws a named error so a caller
 * cannot silently get a half-built host. Behaviour of every method below is
 * unchanged.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

// ── python 语义小工具（本仓惯例：各文件自带局部实现） ─────────────────────────

/** python `repr(x)` — only used for the stale-generation error message. */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const hasSingle = v.includes("'");
    const hasDouble = v.includes('"');
    if (hasSingle && !hasDouble) {
      return `"${v}"`;
    }
    return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return String(v);
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** How long a failed run stays "pending" before its error becomes terminal.
 *
 * A dropped LLM socket, a 503 from the provider or a 5s DNS stall are all
 * things that resolve themselves in under a second on retry. Failing the turn
 * on first contact turns a blip into a visible error the user has to re-drive;
 * holding it for a grace window lets a retry settle the SAME run successfully
 * and the user never learns anything went wrong.
 */
export const PENDING_RUN_GRACE = 15.0;

/** Dedupe TTLs. A caller-supplied id (bot platform message id, client-minted
 * uuid) is authoritative, so it can be remembered for minutes. A key DERIVED
 * from message text is a guess — two identical texts really can be two
 * separate intents ("继续" twice) — so it only covers the double-fire window
 * of a double-click or a reconnect replay.
 */
export const DEDUPE_TTL_ID = 300.0;
export const DEDUPE_TTL_TEXT = 3.0;

/** Cap on the dedupe registry. Unbounded, it is a slow memory leak on a
 * long-lived desktop process; oldest-first eviction keeps it flat.
 */
export const DEDUPE_MAX_KEYS = 512;

// ── 异常 ─────────────────────────────────────────────────────────────────────

/** Raised when a run tagged with a stale generation tries to finalize.
 *
 * Every server start rotates a fresh `generation_id`; any pending run whose
 * tag doesn't match must be aborted rather than silently reported to a UI
 * that has since reconnected under new state. This mirrors the industry's
 * ``AbortError`` for lifecycle generation.
 */
export class LifecycleMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleMismatch";
    // RULEBOOK §2: keep `instanceof` working across the ES2022 target.
    Object.setPrototypeOf(this, LifecycleMismatch.prototype);
  }
}

// ── seams（python 的模块级依赖在这里可替换；默认值 = 真端口） ───────────────────

/** 被调方形状（python 的 duck typing；Router 是未落地单元 188）。 */
export interface RouterLike {
  session_id: string;
  [k: string]: any;
}

export type RouterCtor = new (opts: {
  workspace: string;
  system_prompt: string;
  session_id?: string;
  mount_shared: boolean;
}) => RouterLike;

/** `router.ts` 未落地前的兜底构造器：明确报错，绝不静默给出半成品宿主。 */
function _missingRouter(): never {
  throw new Error(
    "session_host: Router is not wired (app/engine/router.ts is unit 188, unported). "
    + "Inject one through SESSION_HOST_SEAMS.Router.",
  );
}

export const SESSION_HOST_SEAMS = {
  /** python 模块级 `from router import Router`。 */
  Router: _missingRouter as unknown as RouterCtor,
  /** python `uuid.uuid4().hex`（32 位小写十六进制，非连字符形态）。 */
  uuid4_hex: (): string => randomUUIDHex(),
  /** python `time.monotonic()`。 */
  monotonic: (): number => performance.now() / 1000,
  /** python `os.getcwd()`。 */
  cwd: (): string => process.cwd(),
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof SESSION_HOST_SEAMS>): void {
  Object.assign(SESSION_HOST_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  SESSION_HOST_SEAMS.Router = _missingRouter as unknown as RouterCtor;
  SESSION_HOST_SEAMS.uuid4_hex = (): string => randomUUIDHex();
  SESSION_HOST_SEAMS.monotonic = (): number => performance.now() / 1000;
  SESSION_HOST_SEAMS.cwd = (): string => process.cwd();
}

function randomUUIDHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

// ── SessionHost ──────────────────────────────────────────────────────────────

export class SessionHost {
  /** Process-wide registry of live Router sessions.
   *
   * Thread-safety: all mutating methods are called from the single asyncio
   * event loop thread (aiohttp), so no lock is needed. If the design ever
   * migrates to a threaded server, wrap `_sessions` access in a Lock.
   */
  _system_prompt: string;
  _default_workspace: string;
  _sessions: Map<string, RouterLike>;
  /** The first router created mounts shared bus subscribers (guards,
   * sanitizers, risk controller). Subsequent ones skip re-mounting. */
  _shared_mounted: boolean;
  /** Rotated on every startup. Runs, subagent callbacks and steering
   * results tag themselves with the current value; a mismatch on
   * finalize means the process restarted while they were in flight and
   * they must be discarded, not delivered to a UI that has since
   * reconnected under new state. */
  _generation_id: string;
  /** Inbound dedupe registry. key -> (kind, expiry_monotonic). See
   * `dedupe_seen`. Time-bounded and size-capped so it can't leak. */
  _dedupe: Map<string, [string, number]>;
  /** Pending-run grace registry. token -> (session_id, key, expiry).
   * A parked failure that a retry can still cancel. See `pending_arm`. */
  _pending_runs: Map<string, [string, string, number]>;

  constructor(system_prompt = "", default_workspace = "") {
    this._system_prompt = system_prompt;
    this._default_workspace = default_workspace || SESSION_HOST_SEAMS.cwd();
    this._sessions = new Map<string, RouterLike>();
    this._shared_mounted = false;
    this._generation_id = SESSION_HOST_SEAMS.uuid4_hex();
    this._dedupe = new Map<string, [string, number]>();
    this._pending_runs = new Map<string, [string, string, number]>();
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Return the Router for a session, or None if it hasn't been loaded. */
  get(session_id: string): RouterLike | null {
    const r = this._sessions.get(session_id);
    return r === undefined ? null : r;
  }

  /** Return (or construct) a Router bound to the given session.
   *
   * If `session_id` is new, a fresh Router is created with the given
   * workspace. If it already exists, the cached instance is returned
   * (workspace changes within a session go through Router.switch_workspace).
   */
  get_or_create(session_id: string, workspace = ""): RouterLike {
    const existing = this._sessions.get(session_id);
    if (existing !== undefined) {
      return existing;
    }

    const mount_shared = !this._shared_mounted;
    const Router = SESSION_HOST_SEAMS.Router;
    const router = new Router({
      workspace: workspace || this._default_workspace,
      system_prompt: this._system_prompt,
      session_id,
      mount_shared,
    });
    if (mount_shared) {
      this._shared_mounted = true;
    }
    this._sessions.set(session_id, router);
    return router;
  }

  /** Return an already-live Router, creating the bootstrap one if needed.
   *
   * This is the fallback for callers with no session in scope: HTTP routes
   * (git panel, settings, usage) and any WS frame that arrived before the
   * window announced its session. It never invents a second session while
   * one exists, so it cannot silently fan work out across sessions.
   */
  get_primary(): RouterLike {
    if (this._sessions.size > 0) {
      // python `next(iter(self._sessions.values()))` — first inserted.
      return this._sessions.values().next().value as RouterLike;
    }
    // Bootstrap: let Router run its legacy resume-or-create logic, then key
    // the registry by whatever session it actually landed on. Keying by the
    // empty string here would strand the row and make the next lookup build
    // a SECOND router for the same conversation.
    const Router = SESSION_HOST_SEAMS.Router;
    const router = new Router({
      workspace: this._default_workspace,
      system_prompt: this._system_prompt,
      mount_shared: !this._shared_mounted,
    });
    this._shared_mounted = true;
    this._sessions.set(router.session_id, router);
    return router;
  }

  /** Remove a session from the host (e.g. window closed).
   *
   * Does NOT delete the session from storage — the history persists.
   */
  close(session_id: string): void {
    this._sessions.delete(session_id);
  }

  /** Re-key a live Router from `old_id` to `new_id`.
   *
   * Used when a Router changes which session it serves in place — deleting
   * the active session, for instance, calls ``router.new_session()`` and the
   * same instance now owns a different id. Without re-keying, the registry
   * would still file it under the dead id and the next lookup for `new_id`
   * would build a SECOND Router for the same conversation.
   */
  rebind(old_id: string, new_id: string): void {
    if (!new_id || old_id === new_id) {
      return;
    }
    const router = this._sessions.get(old_id);
    this._sessions.delete(old_id);
    if (router !== undefined) {
      this._sessions.set(new_id, router);
    }
  }

  /** Return IDs of all live (in-memory) sessions. */
  list_sessions(): string[] {
    return [...this._sessions.keys()];
  }

  get session_count(): number {
    return this._sessions.size;
  }

  // ------------------------------------------------------------------
  // Lifecycle generation
  // ------------------------------------------------------------------

  /** The current lifecycle generation tag. */
  get generation_id(): string {
    return this._generation_id;
  }

  /** Mint a new generation, invalidating every in-flight run tag.
   *
   * Called on server startup (and available for a hard reset). Anything
   * that was mid-flight under the old tag will fail its
   * `assert_generation` check and abort instead of reporting a result into
   * a world that has moved on.
   */
  rotate_generation(): string {
    this._generation_id = SESSION_HOST_SEAMS.uuid4_hex();
    return this._generation_id;
  }

  /** Does this tag belong to the live generation? */
  is_generation_current(generation_id: string): boolean {
    return Boolean(generation_id) && generation_id === this._generation_id;
  }

  /** Raise LifecycleMismatch when a run's tag is stale.
   *
   * Call this at every point where a long-running operation is about to
   * commit an observable side effect (persist a message, broadcast a
   * terminal frame, apply a file write). Checking only at the start is not
   * enough — the restart happens *during* the run.
   */
  assert_generation(generation_id: string): void {
    if (!this.is_generation_current(generation_id)) {
      throw new LifecycleMismatch(
        `run generation ${pyRepr(generation_id)} is stale `
        + `(current ${pyRepr(this._generation_id)})`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Inbound dedupe registry
  // ------------------------------------------------------------------
  // A message can hit the backend twice for perfectly ordinary reasons: the
  // WebSocket reconnected mid-flight and the client replayed its outbox; a
  // bot platform (Feishu, Telegram) delivered the same event twice under an
  // at-least-once contract; the user double-clicked send. Executing the
  // second copy runs the same tools twice, doubles the LLM cost and can
  // commit a git push twice. A tiny time-bounded set of "keys we've already
  // accepted" catches all three without any protocol changes.
  //
  // Kept on SessionHost (not on the WS handler) so bot providers, HTTP
  // callbacks and WS all share the same view — a duplicate that arrives on a
  // DIFFERENT channel than the original still gets suppressed.

  /** Drop expired keys and cap total size.
   *
   * Called opportunistically from ``dedupe_seen``; no background timer is
   * needed because dedupe is only consulted on inbound traffic.
   */
  _dedupe_gc(): void {
    const now = SESSION_HOST_SEAMS.monotonic();
    const expired: string[] = [];
    for (const [k, entry] of this._dedupe) {
      if (entry[1] <= now) {
        expired.push(k);
      }
    }
    for (const k of expired) {
      this._dedupe.delete(k);
    }
    // If a burst of unique ids blew past the cap, evict oldest-inserted
    // first. dict preserves insertion order in CPython 3.7+, so this is a
    // cheap approximation of an LRU without pulling in an extra structure.
    const overflow = this._dedupe.size - DEDUPE_MAX_KEYS;
    if (overflow > 0) {
      const keys = [...this._dedupe.keys()].slice(0, overflow);
      for (const k of keys) {
        this._dedupe.delete(k);
      }
    }
  }

  /** Return True if this key was already accepted recently.
   *
   * Args:
   *     session_id: which conversation the key lives under; different
   *         sessions can legitimately reuse an id (bot user A and bot user
   *         B may both send `msg_id=1`).
   *     key: caller-supplied identifier. If empty/None, no dedupe happens
   *         (the caller opted out).
   *     channel: transport label included in the key so the same id from
   *         two providers is still two events.
   *     kind: ``"id"`` for authoritative ids (long TTL) vs ``"text"`` for
   *         content-derived guesses (short TTL).
   */
  dedupe_seen(
    session_id: string,
    key: string | null | undefined,
    opts: { channel?: string; kind?: string } = {},
  ): boolean {
    if (!key) {
      return false;
    }
    const channel = opts.channel === undefined ? "ws" : opts.channel;
    const kind = opts.kind === undefined ? "id" : opts.kind;
    this._dedupe_gc();
    const full = `${session_id}|${channel}|${kind}|${key}`;
    const ttl = kind === "id" ? DEDUPE_TTL_ID : DEDUPE_TTL_TEXT;
    const entry = this._dedupe.get(full);
    const now = SESSION_HOST_SEAMS.monotonic();
    if (entry !== undefined && entry[1] > now) {
      return true;
    }
    this._dedupe.set(full, [kind, now + ttl]);
    return false;
  }

  // ------------------------------------------------------------------
  // Pending-run grace registry
  // ------------------------------------------------------------------
  // When a turn errors, we no longer broadcast the terminal frame right
  // away. We hand a token to the caller (WS handler, bot provider) and it
  // decides whether to commit that failure. If the client retries the SAME
  // msg_id inside the grace window, the caller cancels the pending fail and
  // the retry gets a clean run — the user never sees the transient error.
  // Requires no persistence: on process crash, all pending errors are
  // dropped anyway (the client is disconnected too).

  /** Register a pending failure token; returns the token id. */
  pending_arm(session_id: string, key: string): string {
    const token = SESSION_HOST_SEAMS.uuid4_hex();
    const expires = SESSION_HOST_SEAMS.monotonic() + PENDING_RUN_GRACE;
    this._pending_runs.set(token, [session_id, key, expires]);
    return token;
  }

  /** Consume any pending token for (session_id, key).
   *
   * Used by the retry path: a fresh prompt with a matching key wants to
   * cancel whatever error was parked for the previous attempt. Returns
   * the token id so the caller can also cancel its own timer.
   */
  pending_take_by_key(session_id: string, key: string): string | null {
    if (!key) {
      return null;
    }
    for (const [token, entry] of [...this._pending_runs.entries()]) {
      const [sid, k] = entry;
      if (sid === session_id && k === key) {
        this._pending_runs.delete(token);
        return token;
      }
    }
    return null;
  }

  /** Consume a token before firing the parked error.
   *
   * Returns False if the token is already gone (a retry cancelled it, or
   * another timer fired first) — the caller must NOT broadcast in that
   * case, or the user gets a stale error after a successful retry.
   */
  pending_commit(token: string): boolean {
    const existed = this._pending_runs.has(token);
    this._pending_runs.delete(token);
    return existed;
  }

  /** Drop expired tokens whose timers presumably fired without cleanup. */
  pending_gc(): void {
    const now = SESSION_HOST_SEAMS.monotonic();
    const stale: string[] = [];
    for (const [t, entry] of this._pending_runs) {
      if (entry[2] <= now) {
        stale.push(t);
      }
    }
    for (const t of stale) {
      this._pending_runs.delete(t);
    }
  }
}

// ----------------------------------------------------------------------
// Process-wide accessor
// ----------------------------------------------------------------------
// `create_server` builds the host, but `run_server` (which wires the bot) and
// any future entry point need the same instance. A module-level singleton is
// how they share it without threading the object through every signature.
let _host: SessionHost | null = null;

/** Publish the process's SessionHost. Called once during server startup. */
export function set_session_host(host: SessionHost): SessionHost {
  _host = host;
  return _host;
}

/** The process's SessionHost, or None before the server has started. */
export function get_session_host(): SessionHost | null {
  return _host;
}

/** 探针用：清掉进程内单例（对应 python 侧 `reload(session_host)`）。 */
export function _reset_host_for_parity(): void {
  _host = null;
}
