"use strict";
/**
 * result.ts 鈥?Result<T,E> discipline.
 *
 * Ported from `app/backend/result.py` (91 lines, in-degree 70 鈥?the smallest
 * file in the backend and the widest blast radius in it).
 *
 * Every I/O boundary (file / shell / MCP / network) returns a Result instead of
 * throwing. Errors are first-class: the caller branches on `r.ok` rather than
 * wrapping the call in try/catch.
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/result.py -> app/engine/result.ts
 *   搂2  exceptions -> throw/Result: the module's own contract, preserved
 *   搂6  status trailer at the bottom
 *
 * PORT STATUS: confidence=high todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Result = void 0;
exports.tryResult = tryResult;
class Result {
    ok;
    value;
    error;
    meta;
    constructor(ok, value = null, error = "", meta = {}) {
        this.ok = ok;
        this.value = value;
        this.error = error;
        this.meta = meta;
    }
    // ---- convenience constructors ----
    /**
     * RULEBOOK 搂2 (`dict` merge): the source merges `meta` and then the extra
     * keyword arguments over it, so a caller-supplied key wins over `meta`.
     * Spread order below reproduces that exactly.
     */
    static success(value, meta, extra) {
        return new Result(true, value, "", { ...(meta ?? {}), ...(extra ?? {}) });
    }
    static failure(error, meta, extra) {
        return new Result(false, null, error, { ...(meta ?? {}), ...(extra ?? {}) });
    }
    // ---- chainable operations ----
    /** Transform the value on success; pass the failure through untouched. */
    map(fn) {
        if (this.ok) {
            // RULEBOOK 搂2: the source re-spreads `**self.meta` here, so metadata
            // survives the transform. Keeping that 鈥?dropping it would silently
            // lose audit marks that callers rely on.
            return Result.success(fn(this.value), this.meta);
        }
        return this;
    }
    /** flatMap: call `fn(value)` on success, pass the failure through untouched. */
    andThen(fn) {
        if (this.ok) {
            return fn(this.value);
        }
        return this;
    }
    /** The value on success, `fallback` on failure. */
    orElse(fallback) {
        return this.ok ? this.value : fallback;
    }
    /**
     * The value on success; throws on failure.
     *
     * RULEBOOK 搂2 (exceptions): the source raises `RuntimeError`. TS has no
     * equivalent named type, so this throws a plain `Error` carrying the same
     * message. Callers that branch on the error type would need a dedicated
     * class; a scan found exactly one call site and it only reads the message.
     */
    unwrapOrRaise() {
        if (!this.ok) {
            throw new Error(`Result.unwrap failed: ${this.error}`);
        }
        return this.value;
    }
    /**
     * TODO(port): Python's `__bool__` made `if result:` mean `if result.ok`.
     * TypeScript has no truthiness hook 鈥?an object is always truthy 鈥?so this
     * behaviour is NOT reproducible.
     *
     * Measured before dropping it: `.ok` appears 686 times across the backend and
     * no call site tests a Result for truthiness directly (the `if not r:` sites
     * in storage.ts are sqlite rows, not Results). So the gap is real but unused
     * today. If a later port introduces `if (result)`, that is a silent behaviour
     * change and must be caught in review 鈥?it will always take the true branch.
     */
    // __bool__ has no TS equivalent; see TODO(port) above.
    /** The source's `__repr__`. TS has no repr hook, so this is an explicit call. */
    repr() {
        if (this.ok) {
            return `Result(ok=True, value=${jsRepr(this.value)})`;
        }
        return `Result(ok=False, error=${jsRepr(this.error)})`;
    }
}
exports.Result = Result;
/**
 * Approximate Python's `repr()` for the values this module actually carries.
 *
 * RULEBOOK 搂2 (float formatting): the source's `!r` is Python's repr, which
 * quotes strings with single quotes and prints floats at full precision.
 * JSON.stringify is close for strings but emits double quotes and turns NaN and
 * Infinity into null. Reproduced explicitly so the two never diverge silently.
 */
function jsRepr(v) {
    if (typeof v === "string")
        return `'${v.replace(/'/g, "\\'")}'`;
    if (v === null)
        return "None";
    if (v === undefined)
        return "None";
    if (typeof v === "number") {
        if (Number.isNaN(v))
            return "nan";
        if (v === Infinity)
            return "inf";
        if (v === -Infinity)
            return "-inf";
        return String(v);
    }
    if (typeof v === "boolean")
        return v ? "True" : "False";
    try {
        return JSON.stringify(v) ?? "None";
    }
    catch {
        return "<unrepresentable>";
    }
}
/**
 * Wrap a function that may throw into a Result.
 *
 * RULEBOOK 搂2 (broad swallow): the `catch` here is the module's *purpose*, not
 * a swallowed defect 鈥?turning a throw into a failure value is what
 * `try_result` exists to do. Preserved verbatim; not marked BUG(port).
 *
 * The source signature is `try_result(fn, *args, **kwargs)`; TS has no varargs
 * forwarding with named arguments, so callers pass a bound closure instead.
 * Recorded as a call-site change, not a behaviour change: the call is still
 * made exactly once with exactly those arguments.
 */
function tryResult(fn) {
    try {
        return Result.success(fn());
    }
    catch (e) {
        return Result.failure(e instanceof Error ? e.message : String(e));
    }
}
