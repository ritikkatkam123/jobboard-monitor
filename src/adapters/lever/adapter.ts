import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import { navigateWithRetry } from '../../browser/navigate-with-retry.js';
import type { LeverCompany } from '../../schemas/config.js';
import type { RawJobListing } from '../../schemas/job.js';
import type { RetryRecord, ScanError } from '../../schemas/result.js';
import { captureDiagnostics } from '../diagnostics.js';
import { finishScan, retryPolicyFrom } from '../finish.js';
import type { CareerSiteAdapter } from '../types.js';
import {
  cleanWorkplaceType,
  combineDepartment,
  isLeverBoardPage,
  leverBoardUrl,
  leverUrlRules,
} from './urls.js';

/**
 * Selectors observed on jobs.lever.co (spotify, palantir, and the empty "lever" and
 * "demo" boards) on 2026-10-13. If Lever changes its markup, update only these.
 */
export const LEVER_SELECTORS = {
  /** Present on both populated and empty boards. */
  container: '.postings-wrapper',
  /** Lever's own "No job postings currently open" message. */
  emptyMessage: '.no-postings-message',
  row: '.posting',
  rowLink: 'a.posting-title',
  rowTitle: '[data-qa="posting-name"]',
  rowLocation: '.posting-categories .location',
  rowCommitment: '.posting-categories .commitment',
  rowWorkplace: '.posting-categories .workplaceTypes',
  group: '.postings-group',
  /** Shown only on the first group of each department; later groups inherit it. */
  departmentHeader: '.large-category-header',
  teamLabel: '.posting-category-title',
} as const;

const ADAPTER_NAME = 'lever';

interface LeverRow {
  title: string | null;
  url: string | null;
  location: string | null;
  commitment: string | null;
  workplace: string | null;
  department: string | null;
  team: string | null;
}

/**
 * Runs inside the browser. No named inner functions: the TS toolchain (esbuild via tsx)
 * wraps them in a `__name` helper that does not exist in the page.
 */
function extractRows(page: Page): Promise<LeverRow[]> {
  return page.locator(LEVER_SELECTORS.row).evaluateAll(
    (rows, s) =>
      rows.map((row) => {
        const link = row.querySelector(s.rowLink);
        const group = row.closest(s.group);
        // The department header appears once; walk back to the nearest group that has one.
        let department: string | null = null;
        for (let g: Element | null = group; g !== null; g = g.previousElementSibling) {
          const header = g.querySelector(s.departmentHeader);
          if (header) {
            department = header.textContent;
            break;
          }
        }
        return {
          title: link?.querySelector(s.rowTitle)?.textContent ?? null,
          url: link?.getAttribute('href') ?? null,
          location: row.querySelector(s.rowLocation)?.textContent ?? null,
          commitment: row.querySelector(s.rowCommitment)?.textContent ?? null,
          workplace: row.querySelector(s.rowWorkplace)?.textContent ?? null,
          department,
          team: group?.querySelector(s.teamLabel)?.textContent ?? null,
        };
      }),
    LEVER_SELECTORS,
  );
}

function toRaw(row: LeverRow): RawJobListing {
  return {
    title: row.title,
    url: row.url,
    location: row.location,
    department: combineDepartment(row.department, row.team),
    employmentType: row.commitment,
    workplaceType: cleanWorkplaceType(row.workplace),
  };
}

export const leverAdapter: CareerSiteAdapter<LeverCompany> = {
  name: ADAPTER_NAME,

  sourceUrl: (company) => leverBoardUrl(company.site),

  async collect(company, options) {
    const { context, settings, logger } = options;
    const sleep = options.sleep ?? ((ms: number) => delay(ms));
    const log = logger.child({ companyId: company.id, adapter: ADAPTER_NAME });
    const started = Date.now();
    const url = leverBoardUrl(company.site);
    const page = await context.newPage();
    page.setDefaultTimeout(settings.navigationTimeoutMs);

    let raw: RawJobListing[] = [];
    let pagesVisited = 0;
    let traversalFinished = false;
    let error: ScanError | null = null;
    let diagnostics: string[] = [];
    const extraWarnings: string[] = [];
    const retries: RetryRecord[] = [];

    const stop = async (e: ScanError): Promise<ScanError> => {
      log.warn({ category: e.category, httpStatus: e.httpStatus }, e.message);
      diagnostics = await captureDiagnostics(page, options.diagnosticsDir, `${company.id}-page1`);
      return e;
    };

    try {
      log.debug({ url }, 'navigating');
      const nav = await navigateWithRetry(page, url, {
        timeoutMs: settings.navigationTimeoutMs,
        isAllowedUrl: (u) => isLeverBoardPage(u, company.site),
        policy: retryPolicyFrom(settings, options.random),
        throttle: options.throttle,
        sleep,
        onRetry: (record) => {
          retries.push({ page: 1, ...record });
          log.warn({ page: 1, ...record }, 'retrying navigation');
        },
      });

      if (!nav.ok) {
        error = await stop(nav.error);
      } else {
        try {
          // Wait for real content: the list container exists on empty and populated boards.
          await page
            .locator(LEVER_SELECTORS.container)
            .first()
            .waitFor({ state: 'attached', timeout: settings.navigationTimeoutMs });
        } catch {
          error = await stop({
            category: 'STRUCTURE_CHANGED',
            message: 'Page loaded but the Lever postings list never appeared',
            httpStatus: nav.response.status(),
          });
        }

        if (error === null) {
          pagesVisited = 1;
          const rows = await extractRows(page);
          const saysEmpty = (await page.locator(LEVER_SELECTORS.emptyMessage).count()) > 0;
          log.debug({ rows: rows.length, saysEmpty }, 'extracted rows');
          raw = rows.map(toRaw);

          if (rows.length === 0 && !saysEmpty) {
            error = await stop({
              category: 'SUSPICIOUS_EMPTY',
              message: 'No postings and no "no postings" message on the Lever board',
              httpStatus: nav.response.status(),
            });
          } else if (rows.length > 0 && saysEmpty) {
            extraWarnings.push('Board shows postings and a "no postings" message at the same time');
          } else {
            // Lever renders the whole list on one page; nothing more to traverse.
            traversalFinished = true;
          }
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
        sourceUrl: url,
        startedAt: started,
        raw,
        expectedCount: null,
        traversalFinished,
        singlePageList: true,
        pagesVisited,
        error,
        extraWarnings,
        retries,
        diagnostics,
        normalize: {
          companyId: company.id,
          companyName: company.name,
          sourceAdapter: ADAPTER_NAME,
          boardKey: company.site,
          baseUrl: url,
          observedAt: options.observedAt,
          rules: leverUrlRules(company.site),
        },
      },
      log,
    );
  },
};
