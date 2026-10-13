import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createScanContext, launchBrowser } from '../browser/browser.js';
import { createRunId, type Logger } from '../logging/logger.js';
import { writeReports, type ReportPaths } from '../reporting/write.js';
import { runScan, type RunResult } from '../scan/run-scan.js';
import { configSchema } from '../schemas/config.js';
import { DEMO_COMPANIES, demoDays, type DemoResponse } from './fixtures.js';

const DAY_MS = 86_400_000;

/**
 * Run the real pipeline (Chromium, adapter, change tracking, reports) offline
 * against fictional fixture pages, twice: "yesterday" builds a baseline and
 * "today" shows changes. No request leaves the machine: anything not served from
 * the fixtures is aborted.
 *
 * Demo output and state live in `<outputDir>/demo/` and never touch real snapshots
 * or the `report --latest` pointer.
 */
export async function runDemo(options: {
  outputDir: string;
  logger: Logger;
}): Promise<{ run: RunResult; paths: ReportPaths }> {
  const demoDir = join(options.outputDir, 'demo');
  const stateDir = join(demoDir, 'state');
  await rm(stateDir, { recursive: true, force: true }); // every demo starts from scratch

  const config = configSchema.parse({
    settings: { outputDir: demoDir, stateDir, requestDelayMs: 250 },
    companies: DEMO_COMPANIES,
  });

  const [day1, day2] = demoDays();
  let responses: Record<string, DemoResponse> = day1;

  const browser = await launchBrowser();
  try {
    const context = await createScanContext(browser);
    await context.route('**/*', (route) => {
      const response = responses[route.request().url()];
      return response === undefined
        ? route.abort('blockedbyclient')
        : route.fulfill({
            status: response.status,
            contentType: 'text/html; charset=utf-8',
            body: response.body,
          });
    });

    const common = {
      config,
      companies: config.companies,
      filter: { keywords: [], locations: [] },
      logger: options.logger,
      dataSource: 'demo' as const,
      openContext: () => Promise.resolve({ context, close: () => Promise.resolve() }),
      sleep: () => Promise.resolve(),
    };
    const today = new Date();
    const yesterday = new Date(today.getTime() - DAY_MS);

    await runScan({ ...common, runId: createRunId(yesterday), now: () => yesterday });
    responses = day2;
    const run = await runScan({ ...common, runId: createRunId(today), now: () => today });

    const paths = await writeReports(demoDir, run, { updateLatest: false });
    return { run, paths };
  } finally {
    await browser.close();
  }
}
