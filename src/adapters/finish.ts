import { isBlockingCategory } from '../browser/http-status.js';
import type { RetryPolicy } from '../browser/retry-policy.js';
import { assembleListings } from '../core/assemble.js';
import type { NormalizeContext } from '../core/normalize.js';
import type { Logger } from '../logging/logger.js';
import type { Settings } from '../schemas/config.js';
import type { RawJobListing } from '../schemas/job.js';
import type { CompanyScanResult, RetryRecord, ScanError } from '../schemas/result.js';

export function retryPolicyFrom(settings: Settings, random?: () => number): RetryPolicy {
  return {
    maxRetries: settings.maxRetries,
    baseDelayMs: settings.retryBaseDelayMs,
    maxRetryAfterMs: settings.maxRetryAfterMs,
    random: random ?? Math.random,
  };
}

/** Everything an adapter learned while scanning one company. */
export interface ScanFacts {
  companyId: string;
  companyName: string;
  adapter: string;
  sourceUrl: string;
  startedAt: number;
  raw: RawJobListing[];
  expectedCount: number | null;
  traversalFinished: boolean;
  /** The board shows its whole list on one page, so completeness does not need a count. */
  singlePageList?: boolean;
  pagesVisited: number;
  error: ScanError | null;
  extraWarnings: string[];
  retries: RetryRecord[];
  diagnostics: string[];
  normalize: NormalizeContext;
}

/**
 * Shared by all adapters: validate and dedupe rows, decide status and completeness,
 * and build the result. Keeps the safety rules identical across providers.
 */
export function finishScan(facts: ScanFacts, log: Logger): CompanyScanResult {
  const assembled = assembleListings(
    {
      raw: facts.raw,
      expectedCount: facts.expectedCount,
      traversalFinished: facts.traversalFinished && facts.error === null,
      ...(facts.singlePageList ? { singlePageList: true } : {}),
    },
    facts.normalize,
  );

  // Rows existed but none survived validation: treat as a structure problem, not "no jobs".
  const finalError: ScanError | null =
    facts.error ??
    (facts.raw.length > 0 && assembled.listings.length === 0
      ? {
          category: 'STRUCTURE_CHANGED',
          message: 'Rows were found but none could be validated',
          httpStatus: null,
        }
      : null);

  const status: CompanyScanResult['status'] =
    finalError === null
      ? 'SUCCESS'
      : isBlockingCategory(finalError.category)
        ? 'BLOCKED'
        : 'FAILED';

  const result: CompanyScanResult = {
    companyId: facts.companyId,
    companyName: facts.companyName,
    adapter: facts.adapter,
    sourceUrl: facts.sourceUrl,
    status,
    complete: status === 'SUCCESS' && assembled.complete,
    expectedCount: facts.expectedCount,
    rawCount: facts.raw.length,
    pagesVisited: facts.pagesVisited,
    duplicateCount: assembled.duplicateCount,
    durationMs: Date.now() - facts.startedAt,
    retries: facts.retries,
    listings: assembled.listings,
    rejected: assembled.rejected,
    warnings:
      facts.error === null ? [...facts.extraWarnings, ...assembled.warnings] : facts.extraWarnings,
    error: finalError,
    diagnostics: facts.diagnostics,
  };
  log.info(
    {
      status: result.status,
      complete: result.complete,
      listings: result.listings.length,
      rejected: result.rejected.length,
      pages: facts.pagesVisited,
      durationMs: result.durationMs,
    },
    'company scan finished',
  );
  return result;
}
