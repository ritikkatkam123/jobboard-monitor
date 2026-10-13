import type { Page } from 'playwright';
import { navigate, type NavigateOptions, type NavigationOutcome } from './navigate.js';
import { decideRetry, parseRetryAfter, type RetryPolicy } from './retry-policy.js';
import type { HostThrottle } from './throttle.js';
import type { RetryRecord } from '../schemas/result.js';

export interface RetryingNavigateOptions extends NavigateOptions {
  policy: RetryPolicy;
  throttle: HostThrottle;
  sleep: (ms: number) => Promise<void>;
  /** Called before each retry wait, e.g. to log and record it. */
  onRetry: (record: Omit<RetryRecord, 'page'>) => void;
}

/**
 * Navigate with per-host spacing and bounded retries for transient failures.
 * Permanent failures (403, 404, redirects, ...) return immediately after one attempt.
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  options: RetryingNavigateOptions,
): Promise<NavigationOutcome & { attempts: number }> {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    await options.throttle.wait(host);
    const outcome = await navigate(page, url, options);
    if (outcome.ok) return { ...outcome, attempts: attempt };

    const decision = decideRetry(
      outcome.error,
      parseRetryAfter(outcome.retryAfter),
      attempt,
      options.policy,
    );
    if (!decision.retry) return { ...outcome, attempts: attempt };

    options.onRetry({
      attempt,
      category: outcome.error.category,
      httpStatus: outcome.error.httpStatus,
      delayMs: decision.delayMs,
      reason: decision.reason,
    });
    // A timed-out navigation can leave its request pending, which would abort the
    // retry (net::ERR_ABORTED). Loading about:blank cancels it so each attempt is clean.
    await page.goto('about:blank').catch(() => undefined);
    await options.sleep(decision.delayMs);
  }
}
