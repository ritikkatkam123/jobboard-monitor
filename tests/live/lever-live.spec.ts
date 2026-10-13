import { expect, test } from '@playwright/test';
import { leverAdapter } from '../../src/adapters/lever/adapter.js';
import { blockHeavyResources } from '../../src/browser/browser.js';
import { HostThrottle } from '../../src/browser/throttle.js';
import { silentLogger } from '../../src/logging/logger.js';
import { settingsSchema } from '../../src/schemas/config.js';

/**
 * OPT-IN smoke test against a real public Lever board (needs network).
 * Not part of `npm test`. Run with `npm run test:live`.
 * Override the board with LIVE_LEVER_SITE=<site>.
 *
 * As an independent check, it compares the posting IDs the browser found with
 * Lever's documented public postings feed (https://github.com/lever/postings-api).
 * The feed is not used by the tool itself: it includes full descriptions and can
 * be several MB per board, too heavy to download on every scan.
 */
const site = process.env.LIVE_LEVER_SITE ?? 'spotify';
const settings = settingsSchema.parse({});

test(`live Lever board "${site}" matches the official feed`, async ({
  context,
  request,
}, testInfo) => {
  await blockHeavyResources(context);
  const result = await leverAdapter.collect(
    { id: site.toLowerCase(), name: site, provider: 'lever', site, enabled: true },
    {
      context,
      settings,
      observedAt: new Date().toISOString(),
      diagnosticsDir: testInfo.outputPath('diagnostics'),
      logger: silentLogger(),
      throttle: new HostThrottle(settings.requestDelayMs),
    },
  );

  expect(result.error).toBeNull();
  expect(result.status).toBe('SUCCESS');
  expect(result.rejected).toEqual([]);
  expect(result.complete).toBe(true);
  expect(result.listings.length).toBeGreaterThan(0);

  const feed = await request.get(`https://api.lever.co/v0/postings/${site}?mode=json`);
  expect(feed.ok()).toBe(true);
  const feedIds = ((await feed.json()) as { id: string }[]).map((p) => p.id.toLowerCase()).sort();
  const pageIds = result.listings.map((j) => j.providerPostingId ?? '').sort();
  expect(pageIds).toEqual(feedIds);

  for (const job of result.listings) {
    expect(job.url).toBe(
      `https://jobs.lever.co/${site.toLowerCase()}/${job.providerPostingId ?? ''}`,
    );
    expect(job.workplaceType ?? '').not.toMatch(/—/u); // label cleanup worked
  }
  await testInfo.attach('summary', {
    body: JSON.stringify(
      { listings: result.listings.length, sample: result.listings.slice(0, 3) },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
