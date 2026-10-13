import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';

/**
 * Save a screenshot and the page HTML so a failure can be investigated later.
 * Diagnostics must never turn a categorized failure into a crash, so errors here
 * are swallowed and simply produce fewer artifacts.
 */
export async function captureDiagnostics(
  page: Page,
  dir: string | null,
  label: string,
): Promise<string[]> {
  if (dir === null || page.isClosed()) return [];
  const saved: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
    const png = join(dir, `${label}.png`);
    await page.screenshot({ path: png, fullPage: true, timeout: 10_000 });
    saved.push(png);
    const html = join(dir, `${label}.html`);
    await writeFile(html, await page.content(), 'utf8');
    saved.push(html);
  } catch {
    // Best effort only.
  }
  return saved;
}
