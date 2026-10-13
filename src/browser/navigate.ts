import { errors, type Page, type Response } from 'playwright';
import type { ScanError } from '../schemas/result.js';
import { categorizeHttpStatus } from './http-status.js';

export interface NavigateOptions {
  timeoutMs: number;
  /** Every URL in the redirect chain and the final URL must pass this check. */
  isAllowedUrl: (url: URL) => boolean;
}

export type NavigationOutcome =
  { ok: true; response: Response; finalUrl: string } | { ok: false; error: ScanError };

function fail(
  category: ScanError['category'],
  message: string,
  httpStatus: number | null = null,
): NavigationOutcome {
  return { ok: false, error: { category, message, httpStatus } };
}

function allowed(href: string, base: string, isAllowedUrl: (u: URL) => boolean): boolean {
  try {
    return isAllowedUrl(new URL(href, base));
  } catch {
    return false;
  }
}

/**
 * Navigate and turn every outcome into either a usable response or a categorized error.
 *
 * Redirects are checked by watching main-frame 3xx responses: Playwright's route()
 * handlers are not called for redirect follow-ups, so interception cannot do this.
 */
export async function navigate(
  page: Page,
  url: string,
  options: NavigateOptions,
): Promise<NavigationOutcome> {
  const redirectTargets: string[] = [];
  const onResponse = (res: Response) => {
    const status = res.status();
    if (status < 300 || status >= 400) return;
    try {
      if (res.frame() !== page.mainFrame() || !res.request().isNavigationRequest()) return;
    } catch {
      return; // e.g. service-worker responses have no frame
    }
    redirectTargets.push(new URL(res.headers()['location'] ?? '', res.url()).toString());
  };

  page.on('response', onResponse);
  let response: Response | null = null;
  let navigationError: unknown = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  } catch (err) {
    navigationError = err;
  } finally {
    page.off('response', onResponse);
  }

  const offsite = redirectTargets.find((t) => !allowed(t, url, options.isAllowedUrl));
  if (offsite !== undefined) {
    return fail('UNEXPECTED_REDIRECT', `Redirected to an unsupported location: ${offsite}`);
  }

  if (navigationError !== null) {
    if (navigationError instanceof errors.TimeoutError) {
      return fail('NAVIGATION_TIMEOUT', `Navigation timed out after ${options.timeoutMs} ms`);
    }
    const message = navigationError instanceof Error ? navigationError.message : 'unknown error';
    return fail('NETWORK_ERROR', message.split('\n')[0] ?? message);
  }
  if (response === null) return fail('UNKNOWN', 'Navigation returned no response');

  const finalUrl = page.url();
  if (!allowed(finalUrl, url, options.isAllowedUrl)) {
    return fail('UNEXPECTED_REDIRECT', `Ended on an unsupported location: ${finalUrl}`);
  }

  const status = response.status();
  const category = categorizeHttpStatus(status);
  if (category !== null) return fail(category, `HTTP ${status} for ${finalUrl}`, status);

  return { ok: true, response, finalUrl };
}
