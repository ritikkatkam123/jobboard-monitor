import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { HostThrottle } from '../../src/browser/throttle.js';
import { silentLogger } from '../../src/logging/logger.js';
import type { AdapterRunOptions } from '../../src/adapters/types.js';
import { settingsSchema, type GreenhouseCompany, type Settings } from '../../src/schemas/config.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'greenhouse');

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export type FakeResponse =
  | { status?: number; html: string; headers?: Record<string, string> }
  | { status: number; html?: undefined; headers?: Record<string, string> }
  /** Never respond: simulates a hung server. */
  | 'hang';

/**
 * Serve fixture responses for exact URLs and abort every other request, so a test
 * can never reach the real internet. A list of responses is served in order, and
 * the last one repeats. Returns the URLs requested.
 */
export async function serveRoutes(
  context: BrowserContext,
  routes: Record<string, FakeResponse | FakeResponse[]>,
): Promise<{ requested: string[]; unexpected: string[] }> {
  const requested: string[] = [];
  const unexpected: string[] = [];
  const served = new Map<string, number>();
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const entry = routes[url];
    if (entry === undefined) {
      unexpected.push(url);
      await route.abort('blockedbyclient');
      return;
    }
    const list = Array.isArray(entry) ? entry : [entry];
    const count = served.get(url) ?? 0;
    served.set(url, count + 1);
    const response = list[Math.min(count, list.length - 1)];
    if (response === undefined) throw new Error(`empty response list for ${url}`);
    requested.push(url);
    if (response === 'hang') return; // leave the request pending
    await route.fulfill({
      status: response.status ?? 200,
      contentType: 'text/html; charset=utf-8',
      ...(response.headers ? { headers: response.headers } : {}),
      body: response.html ?? '',
    });
  });
  return { requested, unexpected };
}

export const BOARD = 'https://job-boards.greenhouse.io/acme';

export const acme: GreenhouseCompany = {
  id: 'acme',
  name: 'Acme Robotics',
  provider: 'greenhouse',
  boardToken: 'acme',
  enabled: true,
};

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return settingsSchema.parse({
    requestDelayMs: 250,
    navigationTimeoutMs: 5000,
    retryBaseDelayMs: 1000,
    ...overrides,
  });
}

export const OBSERVED_AT = '2026-10-12T12:00:00.000Z';

/**
 * Virtual time: `sleep` returns immediately but advances `now` and records the
 * requested delay, so tests can assert exact waits without actually waiting.
 */
export function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  const now = () => t;
  const sleep = (ms: number) => {
    sleeps.push(ms);
    t += ms;
    return Promise.resolve();
  };
  return { now, sleep, sleeps, throttle: (ms: number) => new HostThrottle(ms, now, sleep) };
}

export function runOptions(
  context: BrowserContext,
  overrides: Partial<AdapterRunOptions> = {},
  clock = fakeClock(),
): AdapterRunOptions {
  const settings = overrides.settings ?? testSettings();
  return {
    context,
    settings,
    observedAt: OBSERVED_AT,
    diagnosticsDir: null,
    logger: silentLogger(),
    throttle: clock.throttle(settings.requestDelayMs),
    sleep: clock.sleep,
    random: () => 0,
    ...overrides,
  };
}
