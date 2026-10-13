import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { leverAdapter } from '../../src/adapters/lever/adapter.js';
import { silentLogger } from '../../src/logging/logger.js';
import { runScan } from '../../src/scan/run-scan.js';
import type { AppConfig, LeverCompany } from '../../src/schemas/config.js';
import { acme, BOARD, fixture, runOptions, serveRoutes, testSettings } from './helpers.js';

const LEVER = 'https://jobs.lever.co/initrode';
const U = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

function leverFixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', 'lever', name), 'utf8');
}

const initrode: LeverCompany = {
  id: 'initrode',
  name: 'Initrode',
  provider: 'lever',
  site: 'initrode',
  enabled: true,
};

test.describe('Lever adapter against local fixtures', () => {
  test('collects a single-page board and fills Lever-specific fields', async ({ context }) => {
    const net = await serveRoutes(context, { [LEVER]: { html: leverFixture('board.html') } });
    const result = await leverAdapter.collect(initrode, runOptions(context));

    expect(result.error).toBeNull();
    expect(result).toMatchObject({
      status: 'SUCCESS',
      complete: true,
      expectedCount: null, // Lever shows no count; completeness comes from the single-page list
      pagesVisited: 1,
      duplicateCount: 0,
    });
    expect(result.warnings).toEqual([]);
    expect(result.rejected).toEqual([]);
    // One request for the whole board; Apply links are never followed.
    expect(net.requested).toEqual([LEVER]);
    expect(net.unexpected).toEqual([]);

    expect(result.listings.map((j) => j.id)).toEqual(U.map((u) => `lever:initrode:${u}`));
    const [sdet, backend, qa, sales] = result.listings;
    expect(sdet).toMatchObject({
      title: 'Senior SDET, Platform',
      // lever-origin / lever-source tracking params removed
      url: `https://jobs.lever.co/initrode/${U[0] ?? ''}`,
      location: 'Austin, TX',
      department: 'Engineering / Platform',
      employmentType: 'Full-time',
      workplaceType: 'Hybrid', // "Hybrid&nbsp;—&nbsp;" cleaned up
      providerPostingId: U[0],
      sourceAdapter: 'lever',
    });
    expect(backend?.title).toBe('Backend Engineer & API Owner');
    expect(backend?.url).toBe(`https://jobs.lever.co/initrode/${U[1] ?? ''}`); // trailing slash removed
    // A group without its own header inherits the department from the group above it.
    expect(qa?.department).toBe('Engineering / QA');
    expect(qa?.employmentType).toBeNull(); // missing commitment stays null
    // Department and team with the same name are not repeated; Unicode kept; URL case normalized.
    expect(sales).toMatchObject({
      department: 'Sales',
      location: 'Zürich',
      workplaceType: 'On-site',
      url: `https://jobs.lever.co/initrode/${U[3] ?? ''}`,
    });
  });

  test('a board with Lever\'s "no postings" message is a valid, complete empty result', async ({
    context,
  }) => {
    await serveRoutes(context, { [LEVER]: { html: leverFixture('empty.html') } });
    const result = await leverAdapter.collect(initrode, runOptions(context));
    expect(result).toMatchObject({ status: 'SUCCESS', complete: true, listings: [] });
    expect(result.warnings).toEqual([]);
  });

  test('an empty list without the message is SUSPICIOUS_EMPTY, not "no jobs"', async ({
    context,
  }) => {
    await serveRoutes(context, { [LEVER]: { html: leverFixture('empty-without-message.html') } });
    const result = await leverAdapter.collect(initrode, runOptions(context));
    expect(result.status).toBe('FAILED');
    expect(result.complete).toBe(false);
    expect(result.error?.category).toBe('SUSPICIOUS_EMPTY');
  });

  test('a page without the postings list is STRUCTURE_CHANGED', async ({ context }) => {
    await serveRoutes(context, { [LEVER]: { html: leverFixture('structure-changed.html') } });
    const result = await leverAdapter.collect(
      initrode,
      runOptions(context, { settings: testSettings({ navigationTimeoutMs: 1000 }) }),
    );
    expect(result.status).toBe('FAILED');
    expect(result.error?.category).toBe('STRUCTURE_CHANGED');
    expect(result.retries).toEqual([]); // a page structure problem is never retried
  });

  test('apply links, offsite links, other boards, and duplicates are rejected or removed', async ({
    context,
  }) => {
    await serveRoutes(context, { [LEVER]: { html: leverFixture('malformed.html') } });
    const result = await leverAdapter.collect(initrode, runOptions(context));
    expect(result.status).toBe('SUCCESS');
    expect(result.complete).toBe(false); // rejected rows block completeness
    expect(result.listings.map((j) => j.title)).toEqual(['Valid Job']);
    expect(result.duplicateCount).toBe(1);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'URL is not a Lever job posting path',
      'host "jobs.example.com" is not a supported Lever host',
      'job belongs to a different board "other-company"',
      'missing title',
    ]);
  });

  test('HTTP 404 is NOT_FOUND after one request', async ({ context }) => {
    const net = await serveRoutes(context, { [LEVER]: { status: 404, html: 'Not found' } });
    const result = await leverAdapter.collect(initrode, runOptions(context));
    expect(result.error).toMatchObject({ category: 'NOT_FOUND', httpStatus: 404 });
    expect(net.requested).toEqual([LEVER]);
  });

  test('HTTP 403 is BLOCKED and never retried', async ({ context }) => {
    const net = await serveRoutes(context, { [LEVER]: { status: 403, html: 'Forbidden' } });
    const result = await leverAdapter.collect(initrode, runOptions(context));
    expect(result.status).toBe('BLOCKED');
    expect(result.retries).toEqual([]);
    expect(net.requested).toEqual([LEVER]);
  });

  test('a transient 503 is retried and the scan completes', async ({ context }) => {
    await serveRoutes(context, {
      [LEVER]: [{ status: 503, html: 'busy' }, { html: leverFixture('board.html') }],
    });
    const result = await leverAdapter.collect(initrode, runOptions(context));
    expect(result).toMatchObject({ status: 'SUCCESS', complete: true });
    expect(result.retries.map((r) => r.httpStatus)).toEqual([503]);
  });

  test('a redirect away from the board fails without extracting anything', async ({ context }) => {
    await serveRoutes(context, {
      [LEVER]: { status: 302, headers: { location: 'https://careers.initrode.invalid/' } },
    });
    const result = await leverAdapter.collect(initrode, runOptions(context));
    expect(result.error?.category).toBe('UNEXPECTED_REDIRECT');
    expect(result.listings).toEqual([]);
  });
});

test('Greenhouse and Lever companies run side by side with change tracking', async ({
  context,
}, testInfo) => {
  const config: AppConfig = {
    settings: testSettings({
      outputDir: testInfo.outputPath('output'),
      stateDir: testInfo.outputPath('state'),
    }),
    companies: [acme, initrode],
  };
  const scanWith = async (leverHtml: string, runId: string, iso: string) => {
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await serveRoutes(context, {
      [BOARD]: { html: fixture('acme-page1.html') },
      [`${BOARD}?page=2`]: { html: fixture('acme-page2.html') },
      [LEVER]: { html: leverHtml },
    });
    return runScan({
      config,
      companies: config.companies,
      filter: { keywords: [], locations: [] },
      runId,
      logger: silentLogger(),
      openContext: () => Promise.resolve({ context, close: () => Promise.resolve() }),
      sleep: () => Promise.resolve(),
      now: () => new Date(iso),
    });
  };

  const board = leverFixture('board.html');
  // The QA posting is taken down on day 2.
  const withoutQa = board.replace(
    /<div class="postings-group"><div class="posting-category-title large-category-label">QA<\/div>.*?<\/a><\/div><\/div>/su,
    '',
  );
  expect(withoutQa).not.toBe(board);

  const day1 = await scanWith(board, 'run-1', '2026-10-13T00:00:00.000Z');
  expect(day1.companies.map((c) => [c.adapter, c.status, c.tracking.snapshotAction])).toEqual([
    ['greenhouse', 'SUCCESS', 'CREATED'],
    ['lever', 'SUCCESS', 'CREATED'],
  ]);

  const day2 = await scanWith(withoutQa, 'run-2', '2026-10-14T00:00:00.000Z');
  const lever = day2.companies[1];
  expect(lever?.tracking.counts).toEqual({ new: 0, updated: 0, possiblyRemoved: 1, removed: 0 });
  expect(lever?.tracking.changes[0]?.listing.title).toBe('QA Automation Engineer');
  expect(day2.companies[0]?.tracking.counts).toEqual({
    new: 0,
    updated: 0,
    possiblyRemoved: 0,
    removed: 0,
  });
});
