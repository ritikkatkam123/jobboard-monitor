import { expect, test } from '@playwright/test';
import { greenhouseAdapter } from '../../src/adapters/greenhouse/adapter.js';
import { silentLogger } from '../../src/logging/logger.js';
import { runScan } from '../../src/scan/run-scan.js';
import type { AppConfig, GreenhouseCompany } from '../../src/schemas/config.js';
import {
  acme,
  BOARD,
  fakeClock,
  fixture,
  runOptions,
  serveRoutes,
  testSettings,
} from './helpers.js';

const page1 = { html: fixture('acme-page1.html') };
const page2 = { html: fixture('acme-page2.html') };

test.describe('retries and rate limits', () => {
  test('a transient 503 is retried with backoff and the scan completes', async ({ context }) => {
    const net = await serveRoutes(context, {
      [BOARD]: [{ status: 503, html: 'busy' }, page1],
      [`${BOARD}?page=2`]: page2,
    });
    const clock = fakeClock();
    const result = await greenhouseAdapter.collect(acme, runOptions(context, {}, clock));

    expect(result).toMatchObject({ status: 'SUCCESS', complete: true, error: null });
    expect(result.listings).toHaveLength(5);
    expect(result.retries).toEqual([
      {
        page: 1,
        attempt: 1,
        category: 'HTTP_ERROR',
        httpStatus: 503,
        delayMs: 1000,
        reason: 'exponential backoff',
      },
    ]);
    expect(net.requested).toEqual([BOARD, BOARD, `${BOARD}?page=2`]);
    // 1000 ms backoff before the retry (which also satisfies the 250 ms spacing),
    // then the normal 250 ms spacing before page 2.
    expect(clock.sleeps).toEqual([1000, 250]);
  });

  test('a failure on page 2 is retried without restarting from page 1', async ({ context }) => {
    const net = await serveRoutes(context, {
      [BOARD]: page1,
      [`${BOARD}?page=2`]: [{ status: 502, html: 'bad gateway' }, page2],
    });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result).toMatchObject({ status: 'SUCCESS', complete: true });
    expect(result.retries.map((r) => r.page)).toEqual([2]);
    expect(net.requested).toEqual([BOARD, `${BOARD}?page=2`, `${BOARD}?page=2`]);
  });

  test('backoff doubles and retries stop at maxRetries', async ({ context }) => {
    const net = await serveRoutes(context, { [BOARD]: { status: 500, html: 'down' } });
    const result = await greenhouseAdapter.collect(
      acme,
      runOptions(context, { settings: testSettings({ maxRetries: 3 }) }),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatchObject({ category: 'HTTP_ERROR', httpStatus: 500 });
    expect(result.retries.map((r) => r.delayMs)).toEqual([1000, 2000, 4000]);
    expect(net.requested).toHaveLength(4); // 1 attempt + 3 retries
  });

  test('maxRetries 0 disables retrying', async ({ context }) => {
    const net = await serveRoutes(context, { [BOARD]: { status: 500, html: 'down' } });
    const result = await greenhouseAdapter.collect(
      acme,
      runOptions(context, { settings: testSettings({ maxRetries: 0 }) }),
    );
    expect(result.retries).toEqual([]);
    expect(net.requested).toHaveLength(1);
  });

  test('429 with a short Retry-After waits exactly that long, then succeeds', async ({
    context,
  }) => {
    await serveRoutes(context, {
      [BOARD]: [{ status: 429, html: 'slow down', headers: { 'retry-after': '7' } }, page1],
      [`${BOARD}?page=2`]: page2,
    });
    const clock = fakeClock();
    const result = await greenhouseAdapter.collect(acme, runOptions(context, {}, clock));
    expect(result).toMatchObject({ status: 'SUCCESS', complete: true });
    expect(result.retries).toEqual([
      {
        page: 1,
        attempt: 1,
        category: 'RATE_LIMITED',
        httpStatus: 429,
        delayMs: 7000,
        reason: 'honoring Retry-After',
      },
    ]);
    expect(clock.sleeps[0]).toBe(7000);
  });

  test('429 asking us to wait too long is BLOCKED after one request', async ({ context }) => {
    const net = await serveRoutes(context, {
      [BOARD]: { status: 429, html: 'go away', headers: { 'retry-after': '3600' } },
    });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('BLOCKED');
    expect(result.error?.category).toBe('RATE_LIMITED');
    expect(result.retries).toEqual([]);
    expect(net.requested).toHaveLength(1);
  });

  test('a second 429 after waiting stops instead of retrying again', async ({ context }) => {
    const net = await serveRoutes(context, {
      [BOARD]: { status: 429, html: 'still no', headers: { 'retry-after': '1' } },
    });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('BLOCKED');
    expect(net.requested).toHaveLength(2);
  });

  for (const [status, category] of [
    [401, 'ACCESS_DENIED'],
    [403, 'ACCESS_DENIED'],
    [404, 'NOT_FOUND'],
  ] as const) {
    test(`HTTP ${status} is permanent: one request, no retries`, async ({ context }) => {
      const net = await serveRoutes(context, { [BOARD]: { status, html: 'no' } });
      const result = await greenhouseAdapter.collect(acme, runOptions(context));
      expect(result.error?.category).toBe(category);
      expect(result.retries).toEqual([]);
      expect(net.requested).toEqual([BOARD]);
    });
  }

  test('changed page structure is not retried', async ({ context }) => {
    const net = await serveRoutes(context, {
      [BOARD]: { html: fixture('structure-changed.html') },
    });
    const result = await greenhouseAdapter.collect(
      acme,
      runOptions(context, { settings: testSettings({ navigationTimeoutMs: 1000 }) }),
    );
    expect(result.error?.category).toBe('STRUCTURE_CHANGED');
    expect(net.requested).toHaveLength(1);
  });
});

test('requests to the same host are spaced across companies', async ({ context }, testInfo) => {
  const beta: GreenhouseCompany = { ...acme, id: 'beta', name: 'Beta', boardToken: 'beta' };
  await serveRoutes(context, {
    [BOARD]: page1,
    [`${BOARD}?page=2`]: page2,
    'https://job-boards.greenhouse.io/beta': { html: fixture('empty-board.html') },
  });
  const config: AppConfig = {
    settings: testSettings({
      requestDelayMs: 5000,
      outputDir: testInfo.outputPath('output'),
      stateDir: testInfo.outputPath('state'),
    }),
    companies: [acme, beta],
  };
  // Virtual clock: navigation time does not count, so each wait is exactly the 5 s spacing.
  // (With the real clock this test failed on a heavily loaded machine: a slow request
  // correctly shortened the remaining wait to 3.8 s.)
  const clock = fakeClock();
  const run = await runScan({
    config,
    companies: config.companies,
    filter: { keywords: [], locations: [] },
    runId: 'spacing',
    logger: silentLogger(),
    openContext: () => Promise.resolve({ context, close: () => Promise.resolve() }),
    sleep: clock.sleep,
    throttle: clock.throttle(5000),
  });
  expect(run.summary.companiesSucceeded).toBe(2);
  // acme page 1 -> page 2, then acme page 2 -> beta page 1: both spaced by exactly 5 s.
  expect(clock.sleeps).toEqual([5000, 5000]);
});
