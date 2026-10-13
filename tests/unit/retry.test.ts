import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  decideRetry,
  isTransient,
  MAX_BACKOFF_MS,
  parseRetryAfter,
  type RetryPolicy,
} from '../../src/browser/retry-policy.js';
import { HostThrottle } from '../../src/browser/throttle.js';
import type { ErrorCategory, ScanError } from '../../src/schemas/result.js';

const policy: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1000,
  maxRetryAfterMs: 60_000,
  random: () => 0,
};
const err = (category: ErrorCategory, httpStatus: number | null = null): ScanError => ({
  category,
  message: category,
  httpStatus,
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  it.each([
    ['120', 120_000],
    [' 0 ', 0],
    ['Tue, 13 Oct 2026 12:00:30 GMT', 30_000],
    ['Tue, 13 Oct 2026 11:00:00 GMT', 0], // in the past: no wait
    [null, null],
    ['', null],
    ['soon', null],
    ['-5', null],
    ['1.5', null],
  ])('%j -> %j', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe('backoffDelay', () => {
  it('doubles per attempt and is capped', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, policy))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(20, policy)).toBe(MAX_BACKOFF_MS);
  });

  it('adds up to 25% jitter', () => {
    expect(backoffDelay(1, { ...policy, random: () => 0.999 })).toBe(1250);
  });
});

describe('isTransient', () => {
  it.each([
    [err('NAVIGATION_TIMEOUT'), true],
    [err('NETWORK_ERROR'), true],
    [err('HTTP_ERROR', 500), true],
    [err('HTTP_ERROR', 503), true],
    [err('HTTP_ERROR', 408), true],
    [err('HTTP_ERROR', 400), false],
    [err('HTTP_ERROR', 405), false],
    [err('ACCESS_DENIED', 403), false],
    [err('NOT_FOUND', 404), false],
    [err('RATE_LIMITED', 429), false],
    [err('UNEXPECTED_REDIRECT'), false],
    [err('STRUCTURE_CHANGED'), false],
    [err('SUSPICIOUS_EMPTY'), false],
    [err('UNKNOWN'), false],
  ])('%j -> %s', (error, expected) => {
    expect(isTransient(error)).toBe(expected);
  });
});

describe('decideRetry', () => {
  it('retries transient failures with backoff until maxRetries', () => {
    const e = err('HTTP_ERROR', 502);
    expect(decideRetry(e, null, 1, policy)).toEqual({
      retry: true,
      delayMs: 1000,
      reason: 'exponential backoff',
    });
    expect(decideRetry(e, null, 2, policy)).toMatchObject({ retry: true, delayMs: 2000 });
    expect(decideRetry(e, null, 3, policy)).toEqual({
      retry: false,
      reason: 'gave up after 3 attempts',
    });
  });

  it('never retries permanent failures', () => {
    for (const e of [
      err('ACCESS_DENIED', 403),
      err('NOT_FOUND', 404),
      err('UNEXPECTED_REDIRECT'),
    ]) {
      expect(decideRetry(e, null, 1, policy).retry).toBe(false);
    }
  });

  it('honors a longer Retry-After on 5xx, within the cap', () => {
    expect(decideRetry(err('HTTP_ERROR', 503), 9000, 1, policy)).toEqual({
      retry: true,
      delayMs: 9000,
      reason: 'honoring Retry-After',
    });
    // Beyond the cap: fall back to normal backoff rather than waiting minutes.
    expect(decideRetry(err('HTTP_ERROR', 503), 600_000, 1, policy)).toMatchObject({
      delayMs: 1000,
    });
  });

  describe('429 Too Many Requests', () => {
    const e = err('RATE_LIMITED', 429);
    it('waits once for an acceptable Retry-After', () => {
      expect(decideRetry(e, 5000, 1, policy)).toEqual({
        retry: true,
        delayMs: 5000,
        reason: 'honoring Retry-After',
      });
    });
    it('stops without Retry-After, with a too-long Retry-After, or when limited again', () => {
      expect(decideRetry(e, null, 1, policy)).toEqual({
        retry: false,
        reason: 'rate limited without Retry-After',
      });
      expect(decideRetry(e, 120_000, 1, policy).retry).toBe(false);
      expect(decideRetry(e, 5000, 2, policy)).toEqual({
        retry: false,
        reason: 'rate limited again after waiting',
      });
    });
    it('respects maxRetries 0', () => {
      expect(decideRetry(e, 5000, 1, { ...policy, maxRetries: 0 }).retry).toBe(false);
    });
  });
});

describe('HostThrottle', () => {
  function clock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      advance: (ms: number) => (t += ms),
      throttle: new HostThrottle(
        1000,
        () => t,
        (ms) => {
          sleeps.push(ms);
          t += ms;
          return Promise.resolve();
        },
      ),
    };
  }

  it('does not wait for the first request to a host', async () => {
    const c = clock();
    await c.throttle.wait('a.example');
    expect(c.sleeps).toEqual([]);
  });

  it('waits only for the remainder of the interval', async () => {
    const c = clock();
    await c.throttle.wait('a.example');
    c.advance(300);
    await c.throttle.wait('a.example');
    expect(c.sleeps).toEqual([700]);
  });

  it('does not wait when enough time has already passed', async () => {
    const c = clock();
    await c.throttle.wait('a.example');
    c.advance(5000);
    await c.throttle.wait('a.example');
    expect(c.sleeps).toEqual([]);
  });

  it('tracks hosts independently', async () => {
    const c = clock();
    await c.throttle.wait('a.example');
    await c.throttle.wait('b.example');
    expect(c.sleeps).toEqual([]);
  });
});
