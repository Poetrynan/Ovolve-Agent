/**
 * evolution_pressure.ts — Context-pressure triggered self-evolution probe.
 *
 * Ported from `app/backend/evolution_pressure.py` (95 lines, sha256_16
 * ab6574feb262c3d6, strictly read-only).
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖。
 *   §2  `import context_compactor` / `from evolution_bridge import
 *       notify_context_pressure`：两者均为未移植单元 → computed-specifier
 *       动态 import。源的 ImportError 链降级（fallback 估计器 + no-op
 *       notify）在此对应为动态 import 缺席时的 else 分支，语义逐字等价。
 *       两个依赖都是纯函数调用面，无状态漂移风险。
 *   §2  estimate_tokens_multi 缺席时的字符数//3 粗估、except → (False, 0.0)
 *       的 fail-open 全部逐字保留。
 *   §4  naming: evolution_pressure.py → evolution_pressure.ts
 *
 * CPython-EVIDENCED CORRECTIONS (tmp/evolu_STATE.md, shadow run
 * 2026-09-27, tmp/evolu_cmp.txt FAILURES=17 evidence lines):
 *   E1 str(None) face: len(str(m.get("content",""))) counts "None"=4 chars
 *      (A07: py 0.01 vs old port 0) → pyStrFaceLen().
 *   E2 Python len(str) counts CODE POINTS, JS .length counts UTF-16 units
 *      (H07: py 0.3 vs old port 0.6; H08: py 0.4/False vs old 0.8/True).
 *   E3 round(x, 4) is banker's rounding over the EXACT double value
 *      (D01 1/32: py 0.0312 vs Math.round 0.0313) → pyRound4() exact
 *      BigInt half-to-even; oracle tmp/evolu_oracle_py.json round_faces.
 *   E4 a raising notify_context_pressure must reach probe_context_pressure's
 *      fail-open (False, 0.0, None) — the source only swallows IMPORT errors
 *      (E8a: py [false,0,null] vs old port [true,0.8,null]) → the bridge seam
 *      splits import-failure (no-op) from call-failure (propagates).
 *
 * PORT STATUS: confidence=high todos=0
 */

interface CompactorLike {
  estimate_tokens_multi?: (messages: unknown[]) => number;
}

type BridgeLike = {
  notify_context_pressure: (sid: string, tid: string, r: number) => string | null;
};

async function _try_compactor(): Promise<CompactorLike | null> {
  try {
    const spec = "./context_compactor" + ".js";
    return (await import(/* @vite-ignore */ spec)) as CompactorLike;
  } catch {
    return null; // ImportError: context_compactor = None
  }
}

/**
 * Mirrors the source's import chain EXACTLY: only the ImportError collapses
 * into the no-op `def notify_context_pressure(...): return None`; once the
 * dependency is bound, calling it is unprotected and its exceptions reach
 * probe_context_pressure's fail-open (evidence E4).
 */
async function _load_bridge(): Promise<BridgeLike | null> {
  try {
    const spec = "./evolution_bridge" + ".js";
    return (await import(/* @vite-ignore */ spec)) as unknown as BridgeLike;
  } catch {
    return null; // ImportError: fallback no-op returns None
  }
}

/**
 * len(str(v)) for the CPython str() faces the fallback estimator prints on
 * the documented content domain (missing | null | bool | safe int | str).
 * Python str(None)="None" (4), str(True)="True" (5), str(False)="False" (5);
 * str() counts CODE POINTS, not UTF-16 units (evidence E1/E2).
 */
function pyStrFaceLen(v: unknown): number {
  if (v === undefined) return 0; // m.get("content", "") -> ""
  if (v === null) return 4; //     str(None)   -> "None"
  if (v === true) return 5; //     str(True)   -> "True"
  if (v === false) return 5; //    str(False)  -> "False"
  if (typeof v === "number") return String(v).length; // str(int) digits
  if (typeof v === "string") {
    let n = 0;
    for (const _ch of v) n += 1; // string for-of iterates code points
    return n;
  }
  return String(v).length; // out-of-contract faces (documented exclusion)
}

/**
 * CPython round(x, 4): half-to-even over the EXACT binary value of the
 * double, returned as the nearest double to that decimal (evidence E3).
 * Implemented exactly via the float64 bit decomposition: x = m * 2^e,
 * q = x * 10^4 = (m*10^4) * 2^e as an exact fraction, then the tie-to-even
 * integer rounding of q and a single IEEE division back.
 */
function pyRound4(x: number): number {
  if (!Number.isFinite(x) || x < 0) {
    // round(inf, 4) = inf, round(nan, 4) = nan; negative ratios are outside
    // the guard domain (tokens > 0, max > 0) - the plain path keeps faces
    // identical for those impossible-by-contract inputs.
    if (!Number.isFinite(x)) return x;
    return Math.round(x * 10000) / 10000;
  }
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  let m: bigint;
  let e: number;
  if (biased === 0) {
    m = frac;
    e = -1074;
  } else {
    m = frac | (1n << 52n);
    e = biased - 1075;
  }
  const num = m * 10000n;
  let k: bigint;
  if (e >= 0) {
    k = num << BigInt(e);
  } else {
    const den = 1n << BigInt(-e);
    const a = num / den;
    const twice = (num - a * den) * 2n;
    if (twice > den) k = a + 1n;
    else if (twice < den) k = a;
    else k = a % 2n === 0n ? a : a + 1n;
  }
  return Number(k) / 10000;
}

/** Pure evaluation function checking if context tokens breach pressure threshold.
 * Returns (should_trigger, current_ratio). */
export async function should_trigger_pressure_evolution(
  messages: Record<string, unknown>[],
  max_context_tokens: number,
  threshold = 0.8
): Promise<[boolean, number]> {
  if (!messages || messages.length === 0 || max_context_tokens <= 0) {
    return [false, 0.0];
  }

  let current_tokens: number;
  try {
    const compactor = await _try_compactor();
    if (compactor !== null && typeof compactor.estimate_tokens_multi === "function") {
      current_tokens = compactor.estimate_tokens_multi(messages);
    } else {
      current_tokens = messages.reduce(
        (acc, m) =>
          acc +
          (m !== null && typeof m === "object"
            ? Math.floor(pyStrFaceLen((m as Record<string, unknown>)["content"]) / 3)
            : 0),
        0
      );
    }
  } catch {
    return [false, 0.0];
  }

  if (current_tokens <= 0) {
    return [false, 0.0];
  }

  const ratio = pyRound4(current_tokens / max_context_tokens);
  if (ratio >= threshold) {
    return [true, ratio];
  }

  return [false, ratio];
}

/** Probe context pressure and dispatch evolution signal if threshold is exceeded.
 * Fail-open: never raises an exception to callers.
 * Returns (triggered, ratio, signal_id). */
export async function probe_context_pressure(
  messages: Record<string, unknown>[],
  max_context_tokens: number,
  threshold = 0.8,
  session_id = "",
  turn_id = ""
): Promise<[boolean, number, string | null]> {
  try {
    const [triggered, ratio] = await should_trigger_pressure_evolution(
      messages,
      max_context_tokens,
      threshold
    );
    if (!triggered) {
      return [false, ratio, null];
    }

    let sig_id: string | null = null;
    if (session_id) {
      const bridge = await _load_bridge();
      if (bridge !== null) {
        sig_id = await bridge.notify_context_pressure(session_id, turn_id, ratio);
      }
    }
    return [true, ratio, sig_id];
  } catch {
    // Fail-open: evolution monitoring must never disrupt runtime
    return [false, 0.0, null];
  }
}
