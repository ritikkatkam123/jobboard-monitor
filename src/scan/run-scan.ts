import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { collectCompany, sourceUrlFor } from '../adapters/registry.js';
import { createScanContext, launchBrowser } from '../browser/browser.js';
import { HostThrottle } from '../browser/throttle.js';
import { filterListings, type ListingFilter } from '../core/filter.js';
import type { Logger } from '../logging/logger.js';
import type { AppConfig, CompanyConfig } from '../schemas/config.js';
import type { JobListing } from '../schemas/job.js';
import type { CompanyScanResult } from '../schemas/result.js';
import type { JobChange } from '../schemas/snapshot.js';
import { trackCompany, type CompanyTracking } from './track-company.js';

export interface RunSummary {
  companiesAttempted: number;
  companiesSucceeded: number;
  companiesComplete: number;
  companiesFailed: number;
  companiesBlocked: number;
  listingsExtracted: number;
  listingsRejected: number;
  duplicatesRemoved: number;
  listingsMatched: number;
  listingsExcludedByFilter: number;
  newJobs: number;
  updatedJobs: number;
  possiblyRemovedJobs: number;
  removedJobs: number;
  snapshotsSaved: number;
  snapshotErrors: number;
}

export interface CompanyRunResult extends CompanyScanResult {
  tracking: CompanyTracking;
}

export type DataSource = 'live' | 'demo';

export interface RunResult {
  runId: string;
  /** `live` = collected from real sites; `demo` = bundled fictional fixture pages. */
  dataSource: DataSource;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  filters: ListingFilter;
  summary: RunSummary;
  /** True when snapshots were deliberately not written (`--dry-run`). */
  dryRun: boolean;
  companies: CompanyRunResult[];
  /** Listings from all companies that pass the filters. */
  matchedListings: JobListing[];
  /** Changes from all companies whose listing passes the filters. */
  matchedChanges: JobChange[];
}

export interface RunScanOptions {
  config: AppConfig;
  companies: CompanyConfig[];
  filter: ListingFilter;
  runId: string;
  logger: Logger;
  /** Compute changes but never write snapshots. */
  dryRun?: boolean;
  /** Defaults to `live`. Only the offline demo sets `demo`. */
  dataSource?: DataSource;
  /** Record a Playwright trace per company and keep it when that company fails. */
  trace?: boolean;
  /** Override for tests; defaults to launching Chromium. */
  openContext?: () => Promise<{ context: BrowserContext; close: () => Promise<void> }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
}

async function defaultOpenContext() {
  const browser = await launchBrowser();
  const context = await createScanContext(browser);
  return { context, close: () => browser.close() };
}

function crashResult(company: CompanyConfig, err: unknown, durationMs: number): CompanyScanResult {
  return {
    companyId: company.id,
    companyName: company.name,
    adapter: company.provider,
    sourceUrl: sourceUrlFor(company),
    status: 'FAILED',
    complete: false,
    expectedCount: null,
    rawCount: 0,
    pagesVisited: 0,
    duplicateCount: 0,
    durationMs,
    retries: [],
    listings: [],
    rejected: [],
    warnings: [],
    error: {
      category: 'UNKNOWN',
      message: err instanceof Error ? err.message : String(err),
      httpStatus: null,
    },
    diagnostics: [],
  };
}

/** Keep the trace only for companies that did not succeed; discard it otherwise. */
async function finishTraceChunk(
  context: BrowserContext,
  scan: CompanyScanResult,
  diagnosticsDir: string,
  log: Logger,
): Promise<CompanyScanResult> {
  const keep = scan.status !== 'SUCCESS';
  const path = join(diagnosticsDir, `${scan.companyId}-trace.zip`);
  try {
    await context.tracing.stopChunk(keep ? { path } : {});
  } catch (err) {
    log.warn({ companyId: scan.companyId, err }, 'could not save trace');
    return scan;
  }
  return keep ? { ...scan, diagnostics: [...scan.diagnostics, path] } : scan;
}

export function summarize(
  companies: CompanyRunResult[],
  matched: number,
  excluded: number,
): RunSummary {
  const sum = (pick: (c: CompanyRunResult) => number) => companies.reduce((n, c) => n + pick(c), 0);
  return {
    companiesAttempted: companies.length,
    companiesSucceeded: companies.filter((c) => c.status === 'SUCCESS').length,
    companiesComplete: companies.filter((c) => c.complete).length,
    companiesFailed: companies.filter((c) => c.status === 'FAILED').length,
    companiesBlocked: companies.filter((c) => c.status === 'BLOCKED').length,
    listingsExtracted: companies.reduce((n, c) => n + c.listings.length, 0),
    listingsRejected: companies.reduce((n, c) => n + c.rejected.length, 0),
    duplicatesRemoved: companies.reduce((n, c) => n + c.duplicateCount, 0),
    listingsMatched: matched,
    listingsExcludedByFilter: excluded,
    newJobs: sum((c) => c.tracking.counts.new),
    updatedJobs: sum((c) => c.tracking.counts.updated),
    possiblyRemovedJobs: sum((c) => c.tracking.counts.possiblyRemoved),
    removedJobs: sum((c) => c.tracking.counts.removed),
    snapshotsSaved: companies.filter((c) =>
      ['CREATED', 'ADVANCED'].includes(c.tracking.snapshotAction),
    ).length,
    snapshotErrors: companies.filter((c) => c.tracking.snapshotAction === 'ERROR').length,
  };
}

/**
 * Scan companies one at a time. Each company is isolated: an unexpected crash in
 * one adapter becomes a FAILED result for that company and the run continues, and
 * each company's snapshot is read and written independently right after its scan.
 */
export async function runScan(options: RunScanOptions): Promise<RunResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  // Timestamps come from `now` (injectable); duration always uses a real monotonic timer.
  const timerStart = performance.now();
  const observedAt = started.toISOString();
  const log = options.logger.child({ runId: options.runId });
  const diagnosticsDir = join(options.config.settings.outputDir, 'diagnostics', options.runId);

  log.info({ companies: options.companies.map((c) => c.id) }, 'scan started');
  const { context, close } = await (options.openContext ?? defaultOpenContext)();
  const { settings } = options.config;
  // One throttle for the whole run: spacing also applies between companies on the same host.
  const throttle = new HostThrottle(settings.requestDelayMs, () => Date.now(), options.sleep);
  const tracing = options.trace === true;
  const results: CompanyRunResult[] = [];
  try {
    if (tracing) await context.tracing.start({ screenshots: true, snapshots: true });
    for (const company of options.companies) {
      const t0 = Date.now();
      if (tracing) await context.tracing.startChunk({ title: company.id });
      let scan: CompanyScanResult;
      try {
        scan = await collectCompany(company, {
          context,
          settings,
          observedAt,
          diagnosticsDir,
          logger: log,
          throttle,
          ...(options.sleep ? { sleep: options.sleep } : {}),
          ...(options.random ? { random: options.random } : {}),
        });
      } catch (err) {
        log.error({ companyId: company.id, err }, 'adapter crashed');
        scan = crashResult(company, err, Date.now() - t0);
      }
      if (tracing) scan = await finishTraceChunk(context, scan, diagnosticsDir, log);
      const tracked = await trackCompany(scan, {
        stateDir: settings.stateDir,
        runId: options.runId,
        scanAt: observedAt,
        removedRetentionDays: settings.removedRetentionDays,
        dryRun: options.dryRun ?? false,
        logger: log,
      });
      results.push({ ...tracked.scan, tracking: tracked.tracking });
    }
  } finally {
    if (tracing) await context.tracing.stop().catch(() => undefined);
    await close();
  }

  const all = results.flatMap((r) => r.listings);
  const { matched, excludedCount } = filterListings(all, options.filter);
  const allChanges = results.flatMap((r) => r.tracking.changes);
  const matchedIds = new Set(
    filterListings(
      allChanges.map((c) => c.listing),
      options.filter,
    ).matched.map((l) => l.id),
  );
  const finished = now();
  const result: RunResult = {
    runId: options.runId,
    dataSource: options.dataSource ?? 'live',
    startedAt: observedAt,
    finishedAt: finished.toISOString(),
    durationMs: Math.round(performance.now() - timerStart),
    filters: options.filter,
    summary: summarize(results, matched.length, excludedCount),
    dryRun: options.dryRun ?? false,
    companies: results,
    matchedListings: matched,
    matchedChanges: allChanges.filter((c) => matchedIds.has(c.jobId)),
  };
  log.info({ summary: result.summary, durationMs: result.durationMs }, 'scan finished');
  return result;
}
