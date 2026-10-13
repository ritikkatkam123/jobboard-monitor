import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { navigateWithRetry } from '../../browser/navigate-with-retry.js';
import { cleanText } from '../../core/text.js';
import type { GreenhouseCompany } from '../../schemas/config.js';
import type { RawJobListing } from '../../schemas/job.js';
import type { RetryRecord, ScanError } from '../../schemas/result.js';
import { captureDiagnostics } from '../diagnostics.js';
import { finishScan, retryPolicyFrom } from '../finish.js';
import type { CareerSiteAdapter } from '../types.js';
import { boardUrl, greenhouseUrlRules, isBoardPage, parseJobCount } from './urls.js';

/**
 * Selectors observed on job-boards.greenhouse.io on 2026-10-12.
 * If Greenhouse changes its markup, these are the only lines that should need updating.
 */
export const SELECTORS = {
  countHeader: '[data-testid="job-count-header"]',
  row: 'tr.job-post',
  rowLink: 'a[href]',
  rowTitle: 'p.body--medium',
  /** "New" badge rendered inside the title element; not part of the job title. */
  rowTitleBadge: '.tag-container',
  rowLocation: 'p.body--metadata',
  departmentGroup: '.job-posts--table--department',
  departmentName: 'h3',
  nextPageButtonName: 'Next page',
} as const;

const ADAPTER_NAME = 'greenhouse';

/**
 * Runs inside the browser. Avoid named inner functions here: the TS toolchain
 * (esbuild via tsx) wraps them in a `__name` helper that does not exist in the page.
 */
function extractRows(page: Page): Promise<RawJobListing[]> {
  return page.locator(SELECTORS.row).evaluateAll(
    (rows, s) =>
      rows.map((row) => {
        const link = row.querySelector(s.rowLink);
        return {
          title: (() => {
            const titleEl = link?.querySelector(s.rowTitle);
            if (!titleEl) return null;
            const copy = titleEl.cloneNode(true) as Element;
            copy.querySelectorAll(s.rowTitleBadge).forEach((badge) => {
              badge.remove();
            });
            return copy.textContent;
          })(),
          url: link?.getAttribute('href') ?? null,
          location: link?.querySelector(s.rowLocation)?.textContent ?? null,
          department:
            row.closest(s.departmentGroup)?.querySelector(s.departmentName)?.textContent ?? null,
        };
      }),
    SELECTORS,
  );
}

async function hasNextPage(page: Page): Promise<boolean> {
  const next = page.getByRole('button', { name: SELECTORS.nextPageButtonName, exact: true });
  if ((await next.count()) === 0) return false;
  return (await next.first().getAttribute('aria-disabled')) !== 'true';
}

export const greenhouseAdapter: CareerSiteAdapter<GreenhouseCompany> = {
  name: ADAPTER_NAME,

  sourceUrl: (company) => boardUrl(company.boardToken),

  async collect(company, options) {
    const { context, settings, logger } = options;
    const sleep = options.sleep ?? ((ms: number) => delay(ms));
    const log = logger.child({ companyId: company.id, adapter: ADAPTER_NAME });
    const started = Date.now();
    const page = await context.newPage();
    page.setDefaultTimeout(settings.navigationTimeoutMs);

    const raw: RawJobListing[] = [];
    let expectedCount: number | null = null;
    let pagesVisited = 0;
    let currentPage = 1;
    let traversalFinished = false;
    let error: ScanError | null = null;
    let diagnostics: string[] = [];
    const extraWarnings: string[] = [];
    const retries: RetryRecord[] = [];
    const policy = retryPolicyFrom(settings, options.random);

    const stop = async (e: ScanError): Promise<ScanError> => {
      log.warn({ category: e.category, httpStatus: e.httpStatus }, e.message);
      diagnostics = await captureDiagnostics(
        page,
        options.diagnosticsDir,
        `${company.id}-page${currentPage}`,
      );
      return e;
    };

    try {
      for (let n = 1; n <= settings.maxPagesPerBoard; n++) {
        currentPage = n;
        const url = boardUrl(company.boardToken, n);
        log.debug({ url, page: n }, 'navigating');

        // The shared throttle spaces requests to the host (also across companies);
        // transient failures are retried with backoff, permanent ones are not.
        const nav = await navigateWithRetry(page, url, {
          timeoutMs: settings.navigationTimeoutMs,
          isAllowedUrl: (u) => isBoardPage(u, company.boardToken),
          policy,
          throttle: options.throttle,
          sleep,
          onRetry: (record) => {
            retries.push({ page: n, ...record });
            log.warn({ page: n, ...record }, 'retrying navigation');
          },
        });
        if (!nav.ok) {
          error = await stop(nav.error);
          break;
        }

        // Wait for real content instead of sleeping: either the count header or a row.
        try {
          await page
            .locator(`${SELECTORS.countHeader}, ${SELECTORS.row}`)
            .first()
            .waitFor({ state: 'attached', timeout: settings.navigationTimeoutMs });
        } catch {
          error = await stop({
            category: 'STRUCTURE_CHANGED',
            message: 'Page loaded but neither the job count header nor any job rows appeared',
            httpStatus: nav.response.status(),
          });
          break;
        }
        pagesVisited = n;

        if (n === 1) {
          const header = page.locator(SELECTORS.countHeader);
          const headerText = (await header.count()) > 0 ? await header.first().textContent() : null;
          expectedCount = parseJobCount(headerText);
          if (headerText !== null && expectedCount === null) {
            extraWarnings.push(`Unrecognized job count header: "${cleanText(headerText) ?? ''}"`);
          }
        }

        const rows = await extractRows(page);
        log.debug({ page: n, rows: rows.length }, 'extracted rows');

        if (rows.length === 0) {
          if (n === 1 && expectedCount === 0) {
            traversalFinished = true; // the board itself says it has no openings
          } else if (n === 1) {
            error = await stop({
              category: expectedCount === null ? 'STRUCTURE_CHANGED' : 'SUSPICIOUS_EMPTY',
              message:
                expectedCount === null
                  ? 'No job rows and no recognizable job count on the board page'
                  : `Board reports ${expectedCount} jobs but no job rows were found`,
              httpStatus: nav.response.status(),
            });
          } else {
            extraWarnings.push(`Page ${n} contained no job rows`);
          }
          break;
        }

        raw.push(...rows);
        if (expectedCount !== null && raw.length >= expectedCount) {
          traversalFinished = true;
          break;
        }
        if (!(await hasNextPage(page))) {
          traversalFinished = true;
          break;
        }
        if (n === settings.maxPagesPerBoard) {
          extraWarnings.push(`Stopped at the configured limit of ${n} pages`);
        }
      }
    } catch (err) {
      error = await stop({
        category: 'UNKNOWN',
        message: err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err),
        httpStatus: null,
      });
    } finally {
      await page.close().catch(() => undefined);
    }

    return finishScan(
      {
        companyId: company.id,
        companyName: company.name,
        adapter: ADAPTER_NAME,
        sourceUrl: boardUrl(company.boardToken),
        startedAt: started,
        raw,
        expectedCount,
        traversalFinished,
        pagesVisited,
        error,
        extraWarnings,
        retries,
        diagnostics,
        normalize: {
          companyId: company.id,
          companyName: company.name,
          sourceAdapter: ADAPTER_NAME,
          boardKey: company.boardToken,
          baseUrl: boardUrl(company.boardToken),
          observedAt: options.observedAt,
          rules: greenhouseUrlRules(company.boardToken),
        },
      },
      log,
    );
  },
};
