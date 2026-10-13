import type { ScanError } from '../schemas/result.js';

export interface RetryPolicy {
  /** Retries after the first attempt. 0 disables retrying. */
  maxRetries: number;
  /** Backoff for attempt n (1-based) is baseDelayMs * 2^(n-1), plus jitter. */
  baseDelayMs: number;
  /** Longest Retry-After we are willing to wait; longer means "blocked". */
  maxRetryAfterMs: number;
  /** Returns [0, 1). Injectable so tests are deterministic. */
  random: () => number;
}

export const MAX_BACKOFF_MS = 30_000;
const JITTER_RATIO = 0.25;

export type RetryDecision =
  { retry: false; reason: string } | { retry: true; delayMs: number; reason: string };

/**
 * Parse an HTTP Retry-After value: either delay-seconds ("120") or an HTTP date.
 * Returns milliseconds to wait, or null when absent or unusable.
 */
export function parseRetryAfter(value: string | null, now: Date = new Date()): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date) || !/[a-z]/iu.test(trimmed)) return null;
  return Math.max(0, date - now.getTime());
}

export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = Math.min(MAX_BACKOFF_MS, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential + exponential * JITTER_RATIO * policy.random());
}

/** Failures that may succeed if we simply try again later. */
export function isTransient(error: ScanError): boolean {
  switch (error.category) {
    case 'NAVIGATION_TIMEOUT':
    case 'NETWORK_ERROR':
      return true;
    case 'HTTP_ERROR':
      return error.httpStatus === 408 || (error.httpStatus !== null && error.httpStatus >= 500);
    default:
      return false;
  }
}

/**
 * Decide whether a failed navigation should be retried.
 *
 * - Transient failures (timeouts, network errors, 408, 5xx) retry with exponential backoff.
 *   A 5xx Retry-After longer than the backoff is honored when within the cap.
 * - 429 retries at most once, only when Retry-After is given and within the cap.
 *   Otherwise the site is asking us to stop, so we stop (BLOCKED).
 * - Everything else (403, 404, redirects, changed structure, ...) is permanent: never retried.
 *
 * `attempt` is the 1-based number of the attempt that just failed.
 */
export function decideRetry(
  error: ScanError,
  retryAfterMs: number | null,
  attempt: number,
  policy: RetryPolicy,
): RetryDecision {
  if (attempt > policy.maxRetries) {
    return { retry: false, reason: `gave up after ${attempt} attempts` };
  }

  if (error.category === 'RATE_LIMITED') {
    if (attempt > 1) return { retry: false, reason: 'rate limited again after waiting' };
    if (retryAfterMs === null) return { retry: false, reason: 'rate limited without Retry-After' };
    if (retryAfterMs > policy.maxRetryAfterMs) {
      return { retry: false, reason: `Retry-After of ${retryAfterMs} ms exceeds the limit` };
    }
    return { retry: true, delayMs: retryAfterMs, reason: 'honoring Retry-After' };
  }

  if (!isTransient(error)) return { retry: false, reason: `${error.category} is not transient` };

  const backoff = backoffDelay(attempt, policy);
  if (retryAfterMs !== null && retryAfterMs > backoff && retryAfterMs <= policy.maxRetryAfterMs) {
    return { retry: true, delayMs: retryAfterMs, reason: 'honoring Retry-After' };
  }
  return { retry: true, delayMs: backoff, reason: 'exponential backoff' };
}
