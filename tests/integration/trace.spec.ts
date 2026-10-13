import { statSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { silentLogger } from '../../src/logging/logger.js';
import { runScan } from '../../src/scan/run-scan.js';
import type { AppConfig, GreenhouseCompany } from '../../src/schemas/config.js';
import { acme, BOARD, fixture, serveRoutes, testSettings } from './helpers.js';

// The runner's own tracing must be off in this file: it would collide with the trace under test.
test.use({ trace: 'off' });

test('--trace keeps a Playwright trace only for companies that fail', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const broken: GreenhouseCompany = { ...acme, id: 'broken', boardToken: 'broken' };
  await serveRoutes(context, {
    'https://job-boards.greenhouse.io/broken': { status: 404, html: 'missing' },
    [BOARD]: { html: fixture('acme-page1.html') },
    [`${BOARD}?page=2`]: { html: fixture('acme-page2.html') },
  });
  const config: AppConfig = {
    settings: testSettings({
      outputDir: testInfo.outputPath('output'),
      stateDir: testInfo.outputPath('state'),
    }),
    companies: [broken, acme],
  };
  const run = await runScan({
    config,
    companies: config.companies,
    filter: { keywords: [], locations: [] },
    runId: 'traced',
    logger: silentLogger(),
    openContext: () => Promise.resolve({ context, close: () => context.close() }),
    sleep: () => Promise.resolve(),
    trace: true,
  });
  const [failed, ok] = run.companies;
  const trace = failed?.diagnostics.find((p) => p.endsWith('broken-trace.zip'));
  expect(trace).toBeDefined();
  expect(statSync(trace ?? '').size).toBeGreaterThan(0);
  expect(ok?.status).toBe('SUCCESS');
  expect(ok?.diagnostics).toEqual([]);
});
