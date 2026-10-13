import type { JobListing } from '../../src/schemas/job.js';
import type { CompanyScanResult } from '../../src/schemas/result.js';

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
