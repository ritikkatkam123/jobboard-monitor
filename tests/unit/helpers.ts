import type { JobListing } from '../../src/schemas/job.js';
import type { CompanyRunResult, RunResult } from '../../src/scan/run-scan.js';
import type { CompanyScanResult } from '../../src/schemas/result.js';
import type { JobChange } from '../../src/schemas/snapshot.js';

export const T0 = '2026-10-12T00:00:00.000Z';

export function job(id: string, overrides: Partial<JobListing> = {}): JobListing {
  return {
    id: `greenhouse:acme:${id}`,
    companyId: 'acme',
    companyName: 'Acme',
    title: `Job ${id}`,
    url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: 'Austin, Texas',
    department: 'Engineering',
    employmentType: null,
    workplaceType: null,
    descriptionHash: null,
    sourceAdapter: 'greenhouse',
    providerPostingId: id,
    providerPublishedAt: null,
    providerUpdatedAt: null,
    firstSeenAt: T0,
    lastSeenAt: T0,
    ...overrides,
  };
}

export function scan(
  listings: JobListing[],
  overrides: Partial<CompanyScanResult> = {},
): CompanyScanResult {
  return {
    companyId: 'acme',
    companyName: 'Acme',
    adapter: 'greenhouse',
    sourceUrl: 'https://job-boards.greenhouse.io/acme',
    status: 'SUCCESS',
    complete: true,
    expectedCount: listings.length,
    rawCount: listings.length,
    pagesVisited: 1,
    duplicateCount: 0,
    durationMs: 1,
    retries: [],
    listings,
    rejected: [],
    warnings: [],
    error: null,
    diagnostics: [],
    ...overrides,
  };
}

export const failedScan = (category: 'NAVIGATION_TIMEOUT' | 'ACCESS_DENIED' | 'SUSPICIOUS_EMPTY') =>
  scan([], {
    status: category === 'ACCESS_DENIED' ? 'BLOCKED' : 'FAILED',
    complete: false,
    expectedCount: null,
    error: { category, message: category, httpStatus: null },
  });

/** A complete RunResult built from company results, for report and CLI tests. */
export function makeRun(
  companies: CompanyRunResult[],
  overrides: Partial<RunResult> = {},
): RunResult {
  const listings = companies.flatMap((c) => c.listings);
  const changes = companies.flatMap((c) => c.tracking.changes);
  return {
    runId: '20261013T000000Z-abc123',
    dataSource: 'live',
    startedAt: T0,
    finishedAt: T0,
    durationMs: 1234,
    filters: { keywords: [], locations: [] },
    summary: {
      companiesAttempted: companies.length,
      companiesSucceeded: companies.filter((c) => c.status === 'SUCCESS').length,
      companiesComplete: companies.filter((c) => c.complete).length,
      companiesFailed: companies.filter((c) => c.status === 'FAILED').length,
      companiesBlocked: companies.filter((c) => c.status === 'BLOCKED').length,
      listingsExtracted: listings.length,
      listingsRejected: 0,
      duplicatesRemoved: 0,
      listingsMatched: listings.length,
      listingsExcludedByFilter: 0,
      newJobs: changes.filter((c) => c.kind === 'NEW').length,
      updatedJobs: changes.filter((c) => c.kind === 'UPDATED').length,
      possiblyRemovedJobs: changes.filter((c) => c.kind === 'POSSIBLY_REMOVED').length,
      removedJobs: changes.filter((c) => c.kind === 'REMOVED').length,
      snapshotsSaved: 0,
      snapshotErrors: 0,
    },
    dryRun: false,
    companies,
    matchedListings: listings,
    matchedChanges: changes,
    ...overrides,
  };
}

/** Wrap a scan result with tracking info, as runScan does. */
export function tracked(
  s: CompanyScanResult,
  changes: JobChange[] = [],
  baseline = false,
): CompanyRunResult {
  return {
    ...s,
    tracking: {
      snapshotAction: s.status === 'SUCCESS' ? (baseline ? 'CREATED' : 'ADVANCED') : 'NOT_ADVANCED',
      snapshotPath: `state/snapshots/${s.companyId}.json`,
      reason: s.status === 'SUCCESS' ? null : 'scan failed',
      baseline,
      removalsEvaluated: s.complete,
      changes,
      counts: {
        new: changes.filter((c) => c.kind === 'NEW').length,
        updated: changes.filter((c) => c.kind === 'UPDATED').length,
        possiblyRemoved: changes.filter((c) => c.kind === 'POSSIBLY_REMOVED').length,
        removed: changes.filter((c) => c.kind === 'REMOVED').length,
      },
      warnings: [],
    },
  };
}
