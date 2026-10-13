/**
 * stream_circuit_breaker.ts — 流式 LLM 断路器（deep-dive 防护）
 *
 * Ported from `app/backend/stream_circuit_breaker.py` (78 lines).
 *
 * 连续流式失败（超时/传输错误/HTTP 5xx）达到阈值后熔断，避免 GEPA/会诊式
 * 反思在模型不可用时反复重试烧 token。半开状态允许单次探测恢复。
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖。threading.Lock → 单线程 JS 事件循环下无竞争，状态直接用
 *       模块级变量承载（语义等价：同一时刻只有一个调用进入临界区）。
 *   §2  time.monotonic() → performance.now()/1000（Node 下同为单调时钟）。
 *   §4  naming: stream_circuit_breaker.py → stream_circuit_breaker.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

export const BreakerState = {
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
} as const;
export type BreakerState = (typeof BreakerState)[keyof typeof BreakerState];

const _FAILURE_THRESHOLD = 3;
const _COOLDOWN_S = 60.0;

let _state: BreakerState = BreakerState.CLOSED;
let _failures = 0;
let _opened_at = 0.0;

function _monotonic(): number {
  return performance.now() / 1000;
}

function _trip_codes(): ReadonlySet<string> {
  return new Set(["Timeout", "Transport", "HTTP500", "HTTP502", "HTTP503", "HTTP504"]);
}

/** Return (allowed, reason). Call before starting a stream. */
export function check_allowed(): [boolean, string] {
  if (_state === BreakerState.CLOSED) {
    return [true, ""];
  }
  if (_state === BreakerState.OPEN) {
    if (_monotonic() - _opened_at >= _COOLDOWN_S) {
      _state = BreakerState.HALF_OPEN;
      return [true, ""];
    }
    return [false, `stream circuit open (${_COOLDOWN_S.toFixed(0)}s cooldown)`];
  }
  return [true, ""];
}

export function record_success(): void {
  _failures = 0;
  _state = BreakerState.CLOSED;
}

export function record_failure(code = ""): void {
  if (code && !_trip_codes().has(code) && !code.startsWith("HTTP5")) {
    return;
  }
  if (_state === BreakerState.HALF_OPEN) {
    _state = BreakerState.OPEN;
    _opened_at = _monotonic();
    _failures = _FAILURE_THRESHOLD;
    return;
  }
  _failures += 1;
  if (_failures >= _FAILURE_THRESHOLD) {
    _state = BreakerState.OPEN;
    _opened_at = _monotonic();
  }
}

export function status(): Record<string, unknown> {
  return {
    state: _state,
    failures: _failures,
    cooldown_s: _COOLDOWN_S,
  };
}
