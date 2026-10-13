import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { greenhouseAdapter } from '../../src/adapters/greenhouse/adapter.js';
import {
  acme,
  BOARD,
  fakeClock,
  fixture,
  OBSERVED_AT,
  runOptions,
  serveRoutes,
  testSettings,
} from './helpers.js';

test.describe('Greenhouse adapter against local fixtures', () => {
  test('collects every page of a complete board and normalizes rows', async ({ context }) => {
    const net = await serveRoutes(context, {
      [BOARD]: { html: fixture('acme-page1.html') },
      [`${BOARD}?page=2`]: { html: fixture('acme-page2.html') },
    });
    const clock = fakeClock();

    const result = await greenhouseAdapter.collect(acme, runOptions(context, {}, clock));

    expect(result.error).toBeNull();
    expect(result.status).toBe('SUCCESS');
    expect(result.complete).toBe(true);
    expect(result.expectedCount).toBe(5);
    expect(result.pagesVisited).toBe(2);
    expect(result.rejected).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(net.requested).toEqual([BOARD, `${BOARD}?page=2`]);
    expect(net.unexpected).toEqual([]);
    // Polite spacing between page navigations.
    expect(clock.sleeps).toEqual([250]);
    expect(result.retries).toEqual([]);

    expect(result.listings.map((j) => j.id)).toEqual([
      'greenhouse:acme:1001',
      'greenhouse:acme:1002',
      'greenhouse:acme:1003',
      'greenhouse:acme:1004',
      'greenhouse:acme:1005',
    ]);

    const [badge, unicode, noLocation, relative, legacy] = result.listings;
    // "New" badge is not part of the title.
    expect(badge?.title).toBe('Senior Software Engineer, Platform');
    expect(badge?.department).toBe('Engineering');
    expect(badge?.firstSeenAt).toBe(OBSERVED_AT);
    // Unicode preserved; tracking params removed.
    expect(unicode?.title).toBe('Ingénieur logiciel — Robotique');
    expect(unicode?.location).toBe('Zürich, Switzerland');
    expect(unicode?.url).toBe('https://job-boards.greenhouse.io/acme/jobs/1002');
    // Whitespace collapsed; missing location stays null rather than "".
    expect(noLocation?.title).toBe('Account Executive (Enterprise)');
    expect(noLocation?.location).toBeNull();
    // Relative href resolved; legacy host and fragment canonicalized.
    expect(relative?.url).toBe('https://job-boards.greenhouse.io/acme/jobs/1004');
    expect(legacy?.url).toBe('https://job-boards.greenhouse.io/acme/jobs/1005');
    // Fields the list page does not provide are null, never invented.
    expect(legacy?.workplaceType).toBeNull();
    expect(legacy?.providerPublishedAt).toBeNull();
  });

  test('a board that reports "0 jobs" is a valid, complete empty result', async ({ context }) => {
    await serveRoutes(context, { [BOARD]: { html: fixture('empty-board.html') } });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('SUCCESS');
    expect(result.complete).toBe(true);
    expect(result.listings).toEqual([]);
    expect(result.expectedCount).toBe(0);
  });

  test('a non-zero count with no rows is SUSPICIOUS_EMPTY, not an empty success', async ({
    context,
  }) => {
    await serveRoutes(context, { [BOARD]: { html: fixture('count-without-rows.html') } });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('FAILED');
    expect(result.complete).toBe(false);
    expect(result.error?.category).toBe('SUSPICIOUS_EMPTY');
  });

  test('changed page structure fails with diagnostics', async ({ context }, testInfo) => {
    await serveRoutes(context, { [BOARD]: { html: fixture('structure-changed.html') } });
    const result = await greenhouseAdapter.collect(
      acme,
      runOptions(context, {
        settings: testSettings({ navigationTimeoutMs: 1000 }),
        diagnosticsDir: testInfo.outputPath('diagnostics'),
      }),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.category).toBe('STRUCTURE_CHANGED');
    expect(result.listings).toEqual([]);
    expect(result.diagnostics.map((p) => p.split('/').pop())).toEqual([
      'acme-page1.png',
      'acme-page1.html',
    ]);
    for (const path of result.diagnostics) expect(existsSync(path)).toBe(true);
  });

  test('row count below the board count is marked incomplete', async ({ context }) => {
    await serveRoutes(context, { [BOARD]: { html: fixture('count-mismatch.html') } });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('SUCCESS');
    expect(result.complete).toBe(false);
    expect(result.listings).toHaveLength(2);
    expect(result.warnings).toContain('Extracted 2 rows but the board reports 4 jobs');
  });

  test('invalid, offsite, and duplicate rows are rejected or removed', async ({ context }) => {
    await serveRoutes(context, { [BOARD]: { html: fixture('malformed-rows.html') } });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('SUCCESS');
    expect(result.complete).toBe(false); // rejected rows block completeness
    expect(result.listings.map((j) => j.id)).toEqual(['greenhouse:acme:3001']);
    expect(result.duplicateCount).toBe(1);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'missing title',
      'unsupported URL scheme "javascript:"',
      'host "jobs.example.com" is not a supported Greenhouse host',
      'job belongs to a different board "someone-else"',
    ]);
    expect(result.warnings).toContain(
      'More than half of the rows were rejected; the page structure may have changed',
    );
  });

  test('HTTP 404 is NOT_FOUND', async ({ context }) => {
    await serveRoutes(context, { [BOARD]: { status: 404, html: '<h1>Page not found</h1>' } });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatchObject({ category: 'NOT_FOUND', httpStatus: 404 });
  });

  test('HTTP 403 is BLOCKED and is requested exactly once', async ({ context }) => {
    const net = await serveRoutes(context, { [BOARD]: { status: 403, html: 'Forbidden' } });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('BLOCKED');
    expect(result.error).toMatchObject({ category: 'ACCESS_DENIED', httpStatus: 403 });
    expect(net.requested).toEqual([BOARD]);
  });

  test('HTTP 429 is BLOCKED as RATE_LIMITED', async ({ context }) => {
    await serveRoutes(context, {
      [BOARD]: { status: 429, html: 'Too Many Requests', headers: { 'retry-after': '120' } },
    });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('BLOCKED');
    expect(result.error?.category).toBe('RATE_LIMITED');
  });

  test('HTTP 500 is a FAILED HTTP_ERROR', async ({ context }) => {
    await serveRoutes(context, { [BOARD]: { status: 500, html: 'oops' } });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('FAILED');
    expect(result.error).toMatchObject({ category: 'HTTP_ERROR', httpStatus: 500 });
  });

  test('a hung server becomes NAVIGATION_TIMEOUT', async ({ context }) => {
    await serveRoutes(context, { [BOARD]: 'hang' });
    const result = await greenhouseAdapter.collect(
      acme,
      runOptions(context, { settings: testSettings({ navigationTimeoutMs: 1000 }) }),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.category).toBe('NAVIGATION_TIMEOUT');
    // Each retry is a clean timeout, not an abort caused by the previous pending request.
    expect(result.retries.map((r) => r.category)).toEqual([
      'NAVIGATION_TIMEOUT',
      'NAVIGATION_TIMEOUT',
    ]);
  });

  test('a redirect to an off-board host fails without extracting anything', async ({ context }) => {
    // `.invalid` never resolves (RFC 2606), so the follow-up request cannot reach the internet.
    await serveRoutes(context, {
      [BOARD]: { status: 302, headers: { location: 'https://careers.acme.invalid/jobs' } },
    });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('FAILED');
    expect(result.error?.category).toBe('UNEXPECTED_REDIRECT');
    expect(result.error?.message).toContain('careers.acme.invalid');
    expect(result.listings).toEqual([]);
  });

  test('a failure on a later page makes the scan FAILED and incomplete', async ({ context }) => {
    await serveRoutes(context, {
      [BOARD]: { html: fixture('acme-page1.html') },
      [`${BOARD}?page=2`]: { status: 503, html: 'unavailable' },
    });
    const result = await greenhouseAdapter.collect(acme, runOptions(context));
    expect(result.status).toBe('FAILED');
    expect(result.complete).toBe(false);
    expect(result.error).toMatchObject({ category: 'HTTP_ERROR', httpStatus: 503 });
    // Rows from page 1 are kept for visibility, but the scan is not trusted as complete.
    expect(result.listings).toHaveLength(3);
  });
});
