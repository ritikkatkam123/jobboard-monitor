import { chromium, type Browser, type BrowserContext } from 'playwright';

/** Resource types a job board does not need for us to read its listings. */
const SKIPPED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/**
 * A fresh, cookie-less context per run. We keep Playwright's default user agent
 * on purpose: the tool does not disguise itself as a regular browser.
 */
export async function createScanContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    javaScriptEnabled: true,
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  await blockHeavyResources(context);
  return context;
}

/** Skip images, fonts, and media to reduce load on the target site. */
export async function blockHeavyResources(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) =>
    SKIPPED_RESOURCE_TYPES.has(route.request().resourceType()) ? route.abort() : route.fallback(),
  );
}
