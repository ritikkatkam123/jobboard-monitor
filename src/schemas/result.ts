import type { JobListing, RawJobListing } from './job.js';

export const ERROR_CATEGORIES = [
  'NAVIGATION_TIMEOUT',
  'NETWORK_ERROR',
  'HTTP_ERROR',
  'NOT_FOUND',
  'ACCESS_DENIED',
  'RATE_LIMITED',
  'UNEXPECTED_REDIRECT',
  'STRUCTURE_CHANGED',
  'SUSPICIOUS_EMPTY',
  'UNKNOWN',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * SUCCESS  – page(s) loaded and extraction finished (may still be incomplete; see `complete`).
 * BLOCKED  – the site refused access (401/403/429). We stop; we never try to get around it.
 * FAILED   – anything else that prevented a trustworthy result.
 */
export type ScanStatus = 'SUCCESS' | 'BLOCKED' | 'FAILED';

export interface ScanError {
  category: ErrorCategory;
  message: string;
  httpStatus: number | null;
}

export interface RejectedListing {
  reason: string;
  raw: RawJobListing;
}

export interface CompanyScanResult {
  companyId: string;
  companyName: string;
  adapter: string;
  sourceUrl: string;
  status: ScanStatus;
  /**
   * True only when every page was traversed, the extracted row count matched the
   * board's own count, and no row was rejected. Later phases only trust complete
   * scans for removal decisions.
   */
  complete: boolean;
  /** Count the board itself reports, when it reports one. */
  expectedCount: number | null;
  rawCount: number;
  pagesVisited: number;
  duplicateCount: number;
  durationMs: number;
  listings: JobListing[];
  rejected: RejectedListing[];
  warnings: string[];
  error: ScanError | null;
  diagnostics: string[];
}
