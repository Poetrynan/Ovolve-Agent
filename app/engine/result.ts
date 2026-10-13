/**
 * result.ts — Result<T,E> discipline.
 *
 * Ported from `app/backend/result.py` (91 lines, in-degree 70 — the smallest
 * file in the backend and the widest blast radius in it).
 *
 * Every I/O boundary (file / shell / MCP / network) returns a Result instead of
 * throwing. Errors are first-class: the caller branches on `r.ok` rather than
 * wrapping the call in try/catch.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/result.py -> app/engine/result.ts
 *   §2  exceptions -> throw/Result: the module's own contract, preserved
 *   §6  status trailer at the bottom
 *
 * PORT STATUS: confidence=high todos=0
 */

/** Optional metadata carried alongside a Result: elapsed time, origin, audit marks. */
export type ResultMeta = Record<string, unknown>;

export class Result<T = unknown> {
  readonly ok: boolean;
  readonly value: T | null;
  readonly error: string;
  readonly meta: ResultMeta;

  constructor(ok: boolean, value: T | null = null, error = "", meta: ResultMeta = {}) {
    this.ok = ok;
    this.value = value;
    this.error = error;
    this.meta = meta;
  }

  // ---- convenience constructors ----

  /**
   * RULEBOOK §2 (`dict` merge): the source merges `meta` and then the extra
   * keyword arguments over it, so a caller-supplied key wins over `meta`.
   * Spread order below reproduces that exactly.
   */
  static success<T>(value: T, meta?: ResultMeta | null, extra?: ResultMeta): Result<T> {
    return new Result<T>(true, value, "", { ...(meta ?? {}), ...(extra ?? {}) });
  }

  static failure<T = unknown>(error: string, meta?: ResultMeta | null, extra?: ResultMeta): Result<T> {
    return new Result<T>(false, null, error, { ...(meta ?? {}), ...(extra ?? {}) });
  }

  // ---- chainable operations ----

  /** Transform the value on success; pass the failure through untouched. */
  map<U>(fn: (value: T) => U): Result<U> {
    if (this.ok) {
      // RULEBOOK §2: the source re-spreads `**self.meta` here, so metadata
      // survives the transform. Keeping that — dropping it would silently
      // lose audit marks that callers rely on.
      return Result.success(fn(this.value as T), this.meta);
    }
    return this as unknown as Result<U>;
  }

  /** flatMap: call `fn(value)` on success, pass the failure through untouched. */
  andThen<U>(fn: (value: T) => Result<U>): Result<U> {
    if (this.ok) {
      return fn(this.value as T);
    }
    return this as unknown as Result<U>;
  }

  /** The value on success, `fallback` on failure. */
  orElse<U>(fallback: U): T | U {
    return this.ok ? (this.value as T) : fallback;
  }

  /**
   * The value on success; throws on failure.
   *
   * RULEBOOK §2 (exceptions): the source raises `RuntimeError`. TS has no
   * equivalent named type, so this throws a plain `Error` carrying the same
   * message. Callers that branch on the error type would need a dedicated
   * class; a scan found exactly one call site and it only reads the message.
   */
  unwrapOrRaise(): T {
    if (!this.ok) {
      throw new Error(`Result.unwrap failed: ${this.error}`);
    }
    return this.value as T;
  }

  /**
   * DIVERGENCE(port): Python's `__bool__` made `if result:` mean `if result.ok`.
   * TypeScript has no truthiness hook — an object is always truthy — so this
   * behaviour is NOT reproducible.
   *
   * Measured before dropping it: `.ok` appears 686 times across the backend and
   * no call site tests a Result for truthiness directly (the `if not r:` sites
   * in storage.ts are sqlite rows, not Results). So the gap is real but unused
   * today. If a later port introduces `if (result)`, that is a silent behaviour
   * change and must be caught in review — it will always take the true branch.
   */
  // __bool__ has no TS equivalent; see DIVERGENCE(port) above.

  /** The source's `__repr__`. TS has no repr hook, so this is an explicit call. */
  repr(): string {
    if (this.ok) {
      return `Result(ok=True, value=${jsRepr(this.value)})`;
    }
    return `Result(ok=False, error=${jsRepr(this.error)})`;
  }
}

/**
 * Python's `repr()` for the values this module actually carries.
 *
 * RULEBOOK §2 (float formatting): the source's `!r` is Python's repr, which
 * prints floats at full precision. JSON.stringify is close for strings but
 * turns NaN and Infinity into null, so each case is reproduced explicitly.
 */
function jsRepr(v: unknown): string {
  if (typeof v === "string") return pyStrRepr(v);
  if (v === null) return "None";
  if (v === undefined) return "None";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
  }
  if (typeof v === "boolean") return v ? "True" : "False";
  try {
    return JSON.stringify(v) ?? "None";
  } catch {
    return "<unrepresentable>";
  }
}

/**
 * CPython's `repr()` for a `str`: the quote is `'` unless the text holds a `'`
 * and no `"`, in which case it is `"`. Only the winning quote is escaped (plus
 * `\\`, `\n`, `\r`, `\t`); the other one stays bare. The obvious JS one-liner
 * always emits `'…\'…'`, so `Result(ok=False, error="don't")` prints differently
 * from the source.
 */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch === quote ? `\\${quote}` : ch;
  }
  return `${quote}${out}${quote}`;
}

/**
 * Wrap a function that may throw into a Result.
 *
 * RULEBOOK §2 (broad swallow): the `catch` here is the module's *purpose*, not
 * a swallowed defect — turning a throw into a failure value is what
 * `try_result` exists to do. Preserved verbatim; not marked BUG(port).
 *
 * The source signature is `try_result(fn, *args, **kwargs)`; TS has no varargs
 * forwarding with named arguments, so callers pass a bound closure instead.
 * Recorded as a call-site change, not a behaviour change: the call is still
 * made exactly once with exactly those arguments.
 */
export function tryResult<T>(fn: () => T): Result<T> {
  try {
    return Result.success(fn());
  } catch (e) {
    return Result.failure(e instanceof Error ? e.message : String(e));
  }
}
