/**
 * browser_idle_reaper.ts — Browser idle auto-suspend and zombie reaper.
 *
 * Ported from `app/backend/browser_idle_reaper.py` (118 lines, wave 5 TS).
 * Periodically scans browser sessions and suspends those idle beyond a configurable timeout,
 * shielding active runs and preserving state for subsequent resumption.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/browser_idle_reaper.py -> app/engine/browser_idle_reaper.ts
 *   §2  exact CPython semantics for idle detection, active_until guarding,
 *       and fail-open error handling.
 *   §M  CPython-semantics helpers are imported from
 *       app/engine/server/http_server_keys.ts (py_float / py_truth / py_or);
 *       no local mirror of any §M-exported name exists in this file
 *       (tmp/lead_mirror_single_source_check.mjs law).
 *
 * MIGRATION DECISIONS / DIVERGENCES
 *   async suspend: manager.suspend_session is Promise<Result>; scan is async Promise<string[]>.
 *   daemon timer: background thread mapped to unref'd setInterval timer.
 *
 * PORT FIX PROVENANCE (brief §4: the port was edited ONLY because `python -B`
 * CPython measurements on the pinned 3.13.12 interpreter proved the 165-line
 * brief-time port (sha256_16 f3444f6791413036) deviated from the source on
 * language-defined faces. Evidence (oracle artifacts, produced by this chain):
 *   D1 env/active_until/last_active float strictness -
 *      tmp/brows2_oracle_py.json keys float_str / float_nonstr /
 *      active_until_expr / last_active_expr: CPython float("12abc"),
 *      float("0x10"), float([1]), float(None) RAISE (ValueError/TypeError),
 *      while JS Number("12abc")=NaN-silent, Number([1])=1 and
 *      parseFloat("0x10")=0 kept scanning and could suspend sessions CPython
 *      skips (fail-open). Fixed by §M py_float, which raises like CPython.
 *   D2 clock truthiness gate - browser_idle_reaper.py:38 `clock or time.time`
 *      is a TRUTHiness face (tmp/brows2_oracle_py.json truth[*]); the old
 *      `clock ?? ...` treated 0/""/false as a clock, so scan(now omitted)
 *      threw on JS while CPython fell back to the wall clock. Fixed via
 *      §M py_truth.
 *   D3 tabs mapping face - browser_idle_reaper.py:84 calls tabs.values():
 *      tmp/brows2_oracle_py.json values_attr[emptylist] / values_attr[list] /
 *      values_attr[str] show AttributeError (fail-open skip) for non-mappings,
 *      while Object.values(list) iterated silently and could suspend. Fixed:
 *      arrays and non-mappings raise into the per-session fail-open.
 *   D4 manager snapshot face - browser_idle_reaper.py:74 calls
 *      _sessions.items(): tmp/brows2_oracle_py.json items_attr[emptylist] /
 *      items_attr[none] / items_attr[str] show AttributeError escaping scan(),
 *      while the old port silently scanned [] or Object.entries(list).
 *      Fixed: only Map/plain-object mappings snapshot; other present values
 *      raise out of scan (no per-session try covers this line, same as PY).
 *      The raise carries an `AttributeError: ` message prefix (same §M
 *      convention as py_float's TypeError("ValueError: ...")) so probes can
 *      derive CPython's exception face across the JS type system.
 *   Registered-caliber note: py_float follows CPython for all corpus-tested
 *   shapes; CPython additionally accepts underscore separators, "Infinity"
 *   spellings and non-ASCII decimal digits (tmp/brows2_oracle_py.json
 *   float_str['1_000'] / float_str['Infinity'] / float_str full-width faces)
 *   which §M py_float deliberately rejects. Those shapes are therefore NOT
 *   part of this unit's parity domain (they would test unit 218's shared
 *   layer, not this port); the exclusion is measured, not assumed.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import { BrowserSessionManager, TAB_ACTIVE, SESSION_SEAMS } from "./browser_sessions.js";
import { py_float, py_or, py_truth } from "./server/http_server_keys.js";

export const REAPER_SEAMS = {
    now: (): number => SESSION_SEAMS.now(),
    getEnv: (key: string): string | undefined => process.env[key],
};

export class IdleReaper {
    manager: BrowserSessionManager;
    idle_timeout_s: number;
    scan_interval_s: number;
    on_notify: ((event: string, taskIds: string[]) => void) | null;
    _thread: { is_alive: () => boolean } | null = null;
    private _clock: () => number;
    private _timer: NodeJS.Timeout | null = null;
    private _running = false;

    constructor(
        manager: BrowserSessionManager,
        idle_timeout_s = 1800.0,
        scan_interval_s = 60.0,
        on_notify: ((event: string, taskIds: string[]) => void) | null = null,
        clock: (() => number) | null = null,
    ) {
        this.manager = manager;
        const env_val = REAPER_SEAMS.getEnv("OVOLVE_BROWSER_IDLE_TIMEOUT_S");
        if (env_val !== undefined && env_val !== null) {
            // py_float raises on unconvertible strings exactly where CPython
            // float() raises ValueError; `except: pass` keeps the argument
            // (D1/tmp/brows2_oracle_py.json float_str).
            try {
                idle_timeout_s = py_float(env_val);
            } catch {
                // pass
            }
        }
        this.idle_timeout_s = idle_timeout_s;
        this.scan_interval_s = scan_interval_s;
        this.on_notify = on_notify;
        // `clock or time.time` is a truthiness face (D2): falsy clocks fall
        // back to the wall clock, truthy non-callables blow up at call time.
        this._clock = py_truth(clock) ? (clock as () => number) : (): number => REAPER_SEAMS.now();
    }

    start(): void {
        if (this.idle_timeout_s <= 0) {
            return;
        }
        if (this._running) {
            return;
        }
        this._running = true;
        this._thread = { is_alive: () => this._running };
        this._timer = setInterval(() => {
            void this.scan().catch(() => {});
        }, Math.max(1, this.scan_interval_s * 1000));
        if (this._timer && typeof this._timer.unref === "function") {
            this._timer.unref();
        }
    }

    stop(): void {
        this._running = false;
        if (this._timer !== null) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._thread = null;
    }

    async scan(now?: number | null): Promise<string[]> {
        if (this.idle_timeout_s <= 0) {
            return [];
        }

        const current_time = now !== null && now !== undefined ? now : this._clock();
        const reaped: string[] = [];

        // Safe iteration over sessions snapshot. `_sessions.items()` face (D4):
        // missing attribute -> {}; Map/object mappings snapshot; anything else
        // that is PRESENT (list/None/str/int) raises out of scan() exactly like
        // AttributeError escapes browser_idle_reaper.py:74 (outside the
        // per-session try - that is observable, tmp/brows2_oracle_py.json
        // items_attr[emptylist] / items_attr[none]).
        const rawSessions = (this.manager as any)._sessions;
        let sessions_items: [string, any][] = [];
        if (rawSessions === undefined) {
            sessions_items = [];
        } else if (rawSessions instanceof Map) {
            sessions_items = Array.from(rawSessions.entries());
        } else if (rawSessions !== null && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
            sessions_items = Object.entries(rawSessions);
        } else {
            throw new TypeError("AttributeError: scan(): _sessions has no .items() face");
        }

        for (const [task_id, session] of sessions_items) {
            try {
                // 1. Active-run guard: do not reap if session is marked active_until.
                // float(getattr(...) or 0.0) with §M strictness (D1):
                // "abc"/[1] raise into the per-session fail-open, like CPython.
                const active_until = py_float(py_or((session as any)?.active_until, 0.0));
                if (current_time < active_until) {
                    continue;
                }

                // 2. Check if there are any active tabs in this session.
                // tabs.values() face (D3): missing attribute -> {} (empty);
                // Map/object mappings yield their values; list/None/str/int
                // raise AttributeError into the fail-open (values_attr faces).
                const rawTabs = (session as any)?.tabs;
                let tabsList: any[];
                if (rawTabs === undefined) {
                    tabsList = [];
                } else if (rawTabs instanceof Map) {
                    tabsList = Array.from(rawTabs.values());
                } else if (rawTabs !== null && typeof rawTabs === "object" && !Array.isArray(rawTabs)) {
                    tabsList = Object.values(rawTabs);
                } else {
                    throw new TypeError("AttributeError: scan(): tabs has no .values() face");
                }
                const has_active_tabs = tabsList.some(
                    (tab) => (tab as any)?.state === TAB_ACTIVE,
                );
                if (!has_active_tabs) {
                    continue;
                }

                // 3. Check idle duration. getattr defaults are evaluated
                // EAGERLY in source order (last_active, then created_at, then
                // current_time), and float() is strict on the found value (D1,
                // last_active_expr: an EXISTING last_active=None raises
                // TypeError -> fail-open skip, while a MISSING one falls through).
                const obj = session !== null && session !== undefined && typeof session === "object"
                    ? (session as any) : null;
                let rawLastActive: unknown;
                if (obj !== null && "last_active" in obj) {
                    rawLastActive = obj.last_active;
                } else if (obj !== null && "created_at" in obj) {
                    rawLastActive = obj.created_at;
                } else {
                    rawLastActive = current_time;
                }
                const last_active = py_float(rawLastActive);

                const idle_s = current_time - last_active;
                if (idle_s >= this.idle_timeout_s) {
                    const res = await this.manager.suspend_session(task_id);
                    if (res && (res as any).ok) {
                        reaped.push(task_id);
                    }
                }
            } catch {
                // Fail-open: continue scanning remaining sessions even if one is broken
                continue;
            }
        }

        if (reaped.length > 0 && py_truth(this.on_notify)) {
            try {
                this.on_notify!("idle_suspend", reaped);
            } catch {
                // pass
            }
        }

        return reaped;
    }
}

// PORT STATUS: confidence=high todos=[0]
