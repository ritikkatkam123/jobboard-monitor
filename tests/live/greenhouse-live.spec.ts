import { expect, test } from '@playwright/test';
import { greenhouseAdapter } from '../../src/adapters/greenhouse/adapter.js';
import { blockHeavyResources } from '../../src/browser/browser.js';
import { silentLogger } from '../../src/logging/logger.js';
import { settingsSchema } from '../../src/schemas/config.js';

/**
 * OPT-IN smoke test against a real public Greenhouse board (needs network).
 * Not part of `npm test`. Run with `npm run test:live`.
 * Override the board with LIVE_GREENHOUSE_BOARD=<token>.
 *
 * It asserts structure and consistency, not specific jobs, because live
 * listings change constantly.
 */
const token = process.env.LIVE_GREENHOUSE_BOARD ?? 'gitlab';

test(`live Greenhouse board "${token}" scans completely`, async ({ context }, testInfo) => {
  await blockHeavyResources(context);
  const result = await greenhouseAdapter.collect(
    {
      id: token.toLowerCase(),
      name: token,
      provider: 'greenhouse',
      boardToken: token,
      enabled: true,
    },
    {
      context,
      settings: settingsSchema.parse({}),
      observedAt: new Date().toISOString(),
      diagnosticsDir: testInfo.outputPath('diagnostics'),
      logger: silentLogger(),
    },
  );

  await testInfo.attach('summary', {
    body: JSON.stringify(
      { ...result, listings: result.listings.length, rejected: result.rejected.length },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  expect(result.error).toBeNull();
  expect(result.status).toBe('SUCCESS');
  expect(result.rejected).toEqual([]);
  expect(result.complete).toBe(true);
  expect(result.listings.length).toBe(result.expectedCount);
  for (const job of result.listings) {
    expect(job.id).toMatch(new RegExp(`^greenhouse:${token.toLowerCase()}:\\d+$`, 'u'));
    expect(job.title).not.toMatch(/New$/u); // badge must not leak into titles
  }
});
