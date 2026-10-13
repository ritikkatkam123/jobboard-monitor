import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type TestInfo } from '@playwright/test';
import { silentLogger } from '../../src/logging/logger.js';
import { runScan, type RunResult } from '../../src/scan/run-scan.js';
import type { AppConfig, GreenhouseCompany } from '../../src/schemas/config.js';
import { snapshotPath } from '../../src/storage/snapshots.js';
import { acme, BOARD, fixture, serveRoutes, testSettings, type FakeResponse } from './helpers.js';

const broken: GreenhouseCompany = {
  id: 'broken',
  name: 'Broken Co',
  provider: 'greenhouse',
  boardToken: 'broken',
  enabled: true,
};
const BROKEN_BOARD = 'https://job-boards.greenhouse.io/broken';

function config(testInfo: TestInfo): AppConfig {
  return {
    // Keep diagnostics and snapshots out of the project's real folders.
    settings: testSettings({
      outputDir: testInfo.outputPath('output'),
      stateDir: testInfo.outputPath('state'),
    }),
    companies: [broken, acme],
  };
}

async function scanOnce(
  context: BrowserContext,
  testInfo: TestInfo,
  routes: Record<string, FakeResponse>,
  runId: string,
  isoTime: string,
): Promise<RunResult> {
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  const net = await serveRoutes(context, routes);
  const cfg = config(testInfo);
  const run = await runScan({
    config: cfg,
    companies: cfg.companies,
    filter: { keywords: ['engineer'], locations: [] },
    runId,
    logger: silentLogger(),
    openContext: () => Promise.resolve({ context, close: () => Promise.resolve() }),
    sleep: () => Promise.resolve(),
    now: () => new Date(isoTime),
  });
  expect(net.unexpected).toEqual([]);
  return run;
}

const acmeOriginal = {
  [BOARD]: { html: fixture('acme-page1.html') },
  [`${BOARD}?page=2`]: { html: fixture('acme-page2.html') },
};

/** Same board, but job 1001 was retitled and job 1005 was taken down. */
const acmeChanged = {
  [BOARD]: {
    html: fixture('acme-page1.html')
      .replace('5 jobs', '4 jobs')
      .replace('Senior Software Engineer, Platform', 'Staff Software Engineer, Platform'),
  },
  [`${BOARD}?page=2`]: {
    html: fixture('acme-page2.html')
      .replace('5 jobs', '4 jobs')
      .replace(/<tr class="job-post">(?:(?!<\/tr>).)*\/acme\/jobs\/1005.*?<\/tr>/su, ''),
  },
};

const summaryOf = (run: RunResult, id: string) => {
  const c = run.companies.find((x) => x.companyId === id);
  return { status: c?.status, action: c?.tracking.snapshotAction, counts: c?.tracking.counts };
};

test('one company failing does not affect another company in the same run', async ({
  context,
}, testInfo) => {
  const run = await scanOnce(
    context,
    testInfo,
    { [BROKEN_BOARD]: { status: 500, html: 'down' }, ...acmeOriginal },
    'run-1',
    '2026-10-12T00:00:00.000Z',
  );

  const [first, second] = run.companies;
  expect(first).toMatchObject({ companyId: 'broken', status: 'FAILED', complete: false });
  expect(first?.tracking).toMatchObject({ snapshotAction: 'NOT_ADVANCED', changes: [] });
  expect(second).toMatchObject({ companyId: 'acme', status: 'SUCCESS', complete: true });
  expect(second?.tracking).toMatchObject({ snapshotAction: 'CREATED', baseline: true });
  expect(second?.listings).toHaveLength(5);
  expect(run.summary).toMatchObject({
    companiesAttempted: 2,
    companiesSucceeded: 1,
    companiesFailed: 1,
    companiesBlocked: 0,
    listingsExtracted: 5,
    listingsMatched: 2,
    listingsExcludedByFilter: 3,
    newJobs: 5,
    snapshotsSaved: 1,
    snapshotErrors: 0,
  });
  expect(run.matchedListings.map((j) => j.title)).toEqual([
    'Senior Software Engineer, Platform',
    'QA Automation Engineer',
  ]);
});

test('changes are tracked across runs and failed scans never touch prior state', async ({
  context,
}, testInfo) => {
  const brokenSnapshot = snapshotPath(config(testInfo).settings.stateDir, 'broken');

  // Run 1: both boards healthy. "broken" genuinely has no openings.
  const run1 = await scanOnce(
    context,
    testInfo,
    { [BROKEN_BOARD]: { html: fixture('empty-board.html') }, ...acmeOriginal },
    'run-1',
    '2026-10-12T00:00:00.000Z',
  );
  expect(summaryOf(run1, 'broken')).toMatchObject({ status: 'SUCCESS', action: 'CREATED' });
  expect(summaryOf(run1, 'acme')).toMatchObject({ action: 'CREATED', counts: { new: 5 } });
  const brokenBefore = await readFile(brokenSnapshot, 'utf8');

  // Run 2: "broken" times out with a 503; acme retitled one job and removed another.
  const run2 = await scanOnce(
    context,
    testInfo,
    { [BROKEN_BOARD]: { status: 503, html: 'unavailable' }, ...acmeChanged },
    'run-2',
    '2026-10-13T00:00:00.000Z',
  );
  expect(summaryOf(run2, 'broken')).toEqual({
    status: 'FAILED',
    action: 'NOT_ADVANCED',
    counts: { new: 0, updated: 0, possiblyRemoved: 0, removed: 0 },
  });
  expect(await readFile(brokenSnapshot, 'utf8')).toBe(brokenBefore);
  expect(summaryOf(run2, 'acme')).toEqual({
    status: 'SUCCESS',
    action: 'ADVANCED',
    counts: { new: 0, updated: 1, possiblyRemoved: 1, removed: 0 },
  });
  const updated = run2.companies[1]?.tracking.changes.find((c) => c.kind === 'UPDATED');
  expect(updated?.fieldChanges).toEqual([
    {
      field: 'title',
      before: 'Senior Software Engineer, Platform',
      after: 'Staff Software Engineer, Platform',
    },
  ]);
  // firstSeenAt survives across runs; lastSeenAt moves forward.
  expect(updated?.listing.firstSeenAt).toBe('2026-10-12T00:00:00.000Z');
  expect(updated?.listing.lastSeenAt).toBe('2026-10-13T00:00:00.000Z');
  // Only the engineering change matches the keyword filter; the warehouse removal does not.
  expect(run2.matchedChanges.map((c) => `${c.kind} ${c.listing.title}`)).toEqual([
    'UPDATED Staff Software Engineer, Platform',
  ]);

  // Run 3: still gone after a second complete scan -> confirmed REMOVED.
  const run3 = await scanOnce(
    context,
    testInfo,
    { [BROKEN_BOARD]: { status: 503, html: 'unavailable' }, ...acmeChanged },
    'run-3',
    '2026-10-14T00:00:00.000Z',
  );
  expect(summaryOf(run3, 'acme').counts).toEqual({
    new: 0,
    updated: 0,
    possiblyRemoved: 0,
    removed: 1,
  });
  expect(run3.companies[1]?.tracking.changes[0]?.listing.title).toBe('Warehouse Lead');
  expect(await readFile(brokenSnapshot, 'utf8')).toBe(brokenBefore);
});
