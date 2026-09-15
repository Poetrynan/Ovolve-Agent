/**
 * Retry logic with exponential backoff for LLM requests.
 *
 * Backoff schedule: [1, 2, 4, 8, 16] seconds with optional jitter.
 * Failover triggers after 3 consecutive failures on a single provider.
 */

import type { LlmEvent } from './types.js';

export interface RetryConfig {
  /** Maximum number of retry attempts (default 5). */
  maxRetries: number;
  /** Base delay in ms (default 1000). */
  baseDelayMs: number;
  /** Maximum delay in ms (default 30_000). */
  maxDelayMs: number;
  /** Multiplier for exponential backoff (default 2). */
  multiplier: number;
  /** Add random jitter up to 25% of computed delay (default true). */
  jitter: boolean;
  /** Consecutive failures before triggering failover (default 3). */
  failoverThreshold: number;
  /** Custom predicate to decide if an error is retryable. */
  isRetryable?: (error: Error) => boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true,
  failoverThreshold: 3,
};

/** Errors that are generally safe to retry. */
const RETRYABLE_ERRORS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
];

/** HTTP status codes that warrant a retry. */
const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

export function isRetryableError(error: Error): boolean {
  // Check for known retryable error codes.
  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_ERRORS.includes(code)) return true;

  // Check for rate-limit / timeout messages.
  const msg = error.message.toLowerCase();
  if (
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('too many requests') ||
    msg.includes('server error') ||
    msg.includes('service unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('capacity')
  ) {
    return true;
  }

  // Check for embedded status code.
  const statusMatch = error.message.match(/\b(408|429|5\d{2})\b/);
  if (statusMatch) {
    const status = parseInt(statusMatch[1], 10);
    if (RETRYABLE_STATUS_CODES.includes(status)) return true;
  }

  return false;
}

/**
 * Compute the delay for a given retry attempt using exponential backoff.
 */
export function computeDelay(attempt: number, config: RetryConfig): number {
  const exponential = config.baseDelayMs * Math.pow(config.multiplier, attempt);
  const capped = Math.min(exponential, config.maxDelayMs);

  if (!config.jitter) return capped;

  // Full jitter: random value between 0 and capped delay.
  const jitterAmount = capped * 0.25 * Math.random();
  return Math.min(capped + jitterAmount, config.maxDelayMs);
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute an async function with retry logic.
 * Returns the result of `fn` or throws the last error.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  signal?: AbortSignal,
  onEvent?: (event: LlmEvent) => void,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry if aborted.
      if (signal?.aborted) throw lastError;

      // Check if error is retryable.
      const retryable = config.isRetryable
        ? config.isRetryable(lastError)
        : isRetryableError(lastError);

      if (!retryable || attempt === config.maxRetries) {
        throw lastError;
      }

      const delay = computeDelay(attempt, config);

      onEvent?.({
        type: 'llm:retry',
        providerId: '',
        model: '',
        timestamp: Date.now(),
        data: { attempt, delay, error: lastError.message },
        error: lastError,
      });

      await sleep(delay, signal);
    }
  }

  // Unreachable, but TypeScript needs it.
  throw lastError ?? new Error('Retry exhausted');
}
