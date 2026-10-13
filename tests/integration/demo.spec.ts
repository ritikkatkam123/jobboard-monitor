import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { runDemo } from '../../src/demo/run-demo.js';
import { silentLogger } from '../../src/logging/logger.js';

// Playwright requires a destructuring pattern as the first argument; no fixtures are needed here.
// eslint-disable-next-line no-empty-pattern
test('the offline demo runs the real pipeline and labels everything as demo data', async ({}, testInfo) => {
  const outputDir = testInfo.outputPath('output');
  const { run, paths } = await runDemo({ outputDir, logger: silentLogger() });

  expect(run.dataSource).toBe('demo');
  expect(run.companies.map((c) => [c.companyId, c.status, c.tracking.snapshotAction])).toEqual([
    ['acme', 'SUCCESS', 'ADVANCED'],
    ['globex', 'SUCCESS', 'ADVANCED'],
    ['initech', 'BLOCKED', 'NOT_ADVANCED'],
  ]);
  expect(run.matchedChanges.map((c) => `${c.kind} ${c.listing.title}`)).toEqual([
    'NEW SDET II, Test Infrastructure',
    'UPDATED Staff Software Engineer, Platform',
    'POSSIBLY_REMOVED Warehouse Lead',
  ]);

  // Reports exist, are labeled, and are protected.
  const html = readFileSync(paths.html, 'utf8');
  expect(html).toContain('DEMO DATA');
  expect(html).not.toMatch(/<script/iu);
  expect(readFileSync(paths.csv, 'utf8')).toContain(`"'=HYPERLINK(`);

  // Demo output is isolated: its own folder, and the real "latest" pointer is untouched.
  expect(paths.dir.startsWith(join(outputDir, 'demo'))).toBe(true);
  expect(existsSync(join(outputDir, 'latest.json'))).toBe(false);
  expect(existsSync(join(outputDir, 'demo', 'latest.json'))).toBe(false);
});
