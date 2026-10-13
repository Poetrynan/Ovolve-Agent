/**
 * mcp_server/auth.ts — Signature verification for the MCP gateway.
 *
 * Ported from `app/backend/mcp_server/auth.py` (147 lines).
 *
 * Implements the ``md5(body + timestamp + accessKey + nonce)`` scheme: one
 * gateway endpoint, per-business access keys, replay protection via a
 * timestamp window plus a nonce cache. The access key is never transmitted —
 * only the digest.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/mcp_server/auth.py -> app/engine/mcp_server/auth.ts
 *   §2  behaviour: check ORDER inside verify() (evict + nonce_key built
 *       before the empty-nonce branch) is literal source behaviour; falsy
 *       ``if not access_key`` semantics via py-truth; ``signature or ""``.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

import * as crypto from "node:crypto";
import { Result } from "../result.js";

type JsonDict = Record<string, unknown>;

/** Requests older/newer than this many seconds are rejected (clock skew window). */
export const TIMESTAMP_WINDOW_SECONDS = 300;
/** Nonces are remembered for the timestamp window so replays inside it fail. */
const _NONCE_TTL = TIMESTAMP_WINDOW_SECONDS * 2;

/** Python ``float(str)`` for the strings reachable from ``verify()``:
 *  surrounding whitespace, ``inf``/``-inf``/``nan`` spellings and PEP 515
 *  underscore separators are accepted; anything else raises ValueError. */
class PyValueError extends Error {
    constructor(msg: string) {
        super(msg);
        this.name = "ValueError";
    }
}

function pyFloatStr(s: unknown): number {
    if (typeof s === "number") return s;
    if (typeof s !== "string") {
        throw new TypeError("float() argument must be a string or a number");
    }
    const t = s.trim();
    const low = t.toLowerCase();
    if (low === "inf" || low === "infinity" || low === "+inf" || low === "+infinity") return Infinity;
    if (low === "-inf" || low === "-infinity") return -Infinity;
    if (low === "nan") return NaN;
    // underscores must sit between digits of a numeric run (no leading,
    // trailing, doubled, or adjacent-to-./e/+/- separators)
    if (t.includes("_")) {
        if (/(^|[^0-9])_|_(?![0-9])|__/.test(t)) {
            throw new PyValueError(`could not convert string to float: '${s}'`);
        }
    }
    if (!/^[+-]?(?:(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)$/.test(t)) {
        throw new PyValueError(`could not convert string to float: '${s}'`);
    }
    return Number.parseFloat(t.replace(/_/g, ""));
}

/** Verify gateway request signatures with replay protection. */
export class SignatureVerifier {
    _keys: Map<string, string>;
    _seen_nonces: Map<string, number>;

    constructor(access_keys: JsonDict | Map<string, string> | null = null) {
        // py: dict(access_keys or self._keys_from_env()) -- a falsy (None or
        // empty) mapping falls through to the environment.
        let src: JsonDict | Map<string, string>;
        if (access_keys instanceof Map) {
            src = access_keys.size > 0 ? access_keys : SignatureVerifier._keys_from_env();
        } else if (access_keys && Object.keys(access_keys).length > 0) {
            src = access_keys;
        } else {
            src = SignatureVerifier._keys_from_env();
        }
        this._keys = new Map(src instanceof Map ? src : Object.entries(src as Record<string, string>));
        this._seen_nonces = new Map();
    }

    /** Parse access keys out of the environment. */
    static _keys_from_env(): Map<string, string> {
        const raw = process.env["OVOLVE_MCP_KEYS"] ?? "";
        const out = new Map<string, string>();
        for (const pair of raw.split(",")) {
            if (pair.includes(":")) {
                const idx = pair.indexOf(":");
                let business = pair.slice(0, idx);
                let key = pair.slice(idx + 1);
                business = business.trim();
                key = key.trim();
                if (business && key) out.set(business, key);
            }
        }
        return out;
    }

    /** Register or replace an access key for a business id. */
    register_key(business_id: string, access_key: string): void {
        this._keys.set(business_id, access_key);
    }

    /** Compute the expected signature digest (lowercase hex md5). */
    static compute(body: string, timestamp: string, access_key: string, nonce: string): string {
        const seed = Buffer.from(`${body}${timestamp}${access_key}${nonce}`, "utf8");
        return crypto.createHash("md5").update(seed).digest("hex");
    }

    /** Verify a request signature. Checks, in order: known business id,
     *  timestamp freshness, nonce uniqueness, then digest equality
     *  (constant-time). Returns Result.success(business_id) or a failure with
     *  a semantic code in ``meta``. */
    verify(
        body: string,
        business_id: string,
        timestamp: string,
        nonce: string,
        signature: string,
        now: number | null = null,
    ): Result {
        const access_key = this._keys.get(business_id);
        if (!access_key) {
            return Result.failure(
                `Unknown business id: ${business_id}`, { code: "UnknownBusiness" });
        }

        const current = now !== null && now !== undefined ? now : Date.now() / 1000;
        let ts: number;
        try {
            ts = pyFloatStr(timestamp);
        } catch {
            return Result.failure("Malformed timestamp", { code: "BadTimestamp" });
        }
        if (Math.abs(current - ts) > TIMESTAMP_WINDOW_SECONDS) {
            return Result.failure("Timestamp outside allowed window", { code: "StaleTimestamp" });
        }

        this._evict_expired_nonces(current);
        const nonce_key = `${business_id}:${nonce}`;
        if (!nonce) {
            return Result.failure("Missing nonce", { code: "MissingNonce" });
        }
        if (this._seen_nonces.has(nonce_key)) {
            return Result.failure("Nonce already used (replay)", { code: "ReplayDetected" });
        }

        const expected = SignatureVerifier.compute(body, timestamp, access_key, nonce);
        if (!SignatureVerifier._constant_time_eq(expected, signature || "")) {
            return Result.failure("Signature mismatch", { code: "BadSignature" });
        }

        this._seen_nonces.set(nonce_key, current);
        return Result.success(business_id);
    }

    /** Drop nonces older than the retention window. */
    _evict_expired_nonces(now: number): void {
        const cutoff = now - _NONCE_TTL;
        const doomed: string[] = [];
        for (const [k, seen] of this._seen_nonces) {
            if (seen < cutoff) doomed.push(k);
        }
        for (const k of doomed) this._seen_nonces.delete(k);
    }

    /** Length-and-content comparison that does not short-circuit. */
    static _constant_time_eq(a: string, b: string): boolean {
        const ac = Array.from(a);
        const bc = Array.from(b);
        if (ac.length !== bc.length) return false;
        let diff = 0;
        for (let i = 0; i < ac.length; i++) {
            diff |= (ac[i] as string).codePointAt(0)! ^ (bc[i] as string).codePointAt(0)!;
        }
        return diff === 0;
    }
}

let _verifier: SignatureVerifier | null = null;

/** Get the global SignatureVerifier singleton. */
export function get_verifier(): SignatureVerifier {
    if (_verifier === null) {
        _verifier = new SignatureVerifier();
    }
    return _verifier;
}

// PORT STATUS: confidence=high todos=[0]
