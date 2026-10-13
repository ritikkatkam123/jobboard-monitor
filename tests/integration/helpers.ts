import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
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
 * can never reach the real internet. Returns the list of URLs requested.
 */
export async function serveRoutes(
  context: BrowserContext,
  routes: Record<string, FakeResponse>,
): Promise<{ requested: string[]; unexpected: string[] }> {
  const requested: string[] = [];
  const unexpected: string[] = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const response = routes[url];
    if (response === undefined) {
      unexpected.push(url);
      await route.abort('blockedbyclient');
      return;
    }
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
  return settingsSchema.parse({ requestDelayMs: 250, navigationTimeoutMs: 5000, ...overrides });
}

export const OBSERVED_AT = '2026-10-12T12:00:00.000Z';

export function runOptions(
  context: BrowserContext,
  overrides: Partial<AdapterRunOptions> = {},
): AdapterRunOptions {
  return {
    context,
    settings: testSettings(),
    observedAt: OBSERVED_AT,
    diagnosticsDir: null,
    logger: silentLogger(),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}
