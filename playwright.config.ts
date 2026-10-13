import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Never auto-retry: a failing business assertion must stay visible.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'integration', testDir: 'tests/integration' },
    // Opt-in only: hits real public boards. Run with `npm run test:live`.
    { name: 'live', testDir: 'tests/live', timeout: 120_000 },
  ],
});
