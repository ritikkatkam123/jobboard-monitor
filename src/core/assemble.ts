import type { JobListing, RawJobListing } from '../schemas/job.js';
import type { RejectedListing } from '../schemas/result.js';
import { dedupeListings } from './dedupe.js';
import { normalizeListing, type NormalizeContext } from './normalize.js';

export interface ExtractionFacts {
  raw: RawJobListing[];
  /** Count reported by the board itself, if any. */
  expectedCount: number | null;
  /** False if pagination stopped early (page limit, empty later page, etc.). */
  traversalFinished: boolean;
  /**
   * The board shows its entire list on a single page (e.g. Lever), so there is no
   * pagination to get wrong and no count to check against.
   */
  singlePageList?: boolean;
}

export interface AssembledListings {
  listings: JobListing[];
  rejected: RejectedListing[];
  duplicateCount: number;
  complete: boolean;
  warnings: string[];
}

/**
 * Turn raw extracted rows into validated listings and decide whether the scan
 * can be trusted as complete. Pure function — no browser involved — so the
 * completeness rules are easy to unit test.
 */
export function assembleListings(facts: ExtractionFacts, ctx: NormalizeContext): AssembledListings {
  const warnings: string[] = [];
  const valid: JobListing[] = [];
  const rejected: RejectedListing[] = [];

  for (const raw of facts.raw) {
    const outcome = normalizeListing(raw, ctx);
    if (outcome.ok) valid.push(outcome.listing);
    else rejected.push({ reason: outcome.reason, raw: outcome.raw });
  }

  const { listings, duplicateCount, conflictingIds } = dedupeListings(valid);

  if (rejected.length > 0) {
    warnings.push(`${rejected.length} of ${facts.raw.length} extracted rows failed validation`);
  }
  if (facts.raw.length > 0 && rejected.length * 2 > facts.raw.length) {
    warnings.push('More than half of the rows were rejected; the page structure may have changed');
  }
  if (duplicateCount > 0) warnings.push(`${duplicateCount} duplicate rows removed`);
  for (const id of conflictingIds) {
    warnings.push(`Duplicate ID ${id} appeared with different details; kept the first`);
  }
  if (facts.expectedCount === null && facts.singlePageList !== true) {
    warnings.push('Board did not report a job count; completeness cannot be verified');
  } else if (facts.expectedCount !== null && facts.raw.length !== facts.expectedCount) {
    warnings.push(
      `Extracted ${facts.raw.length} rows but the board reports ${facts.expectedCount} jobs`,
    );
  }
  if (!facts.traversalFinished) warnings.push('Pagination stopped before the last page');

  const countOk =
    facts.expectedCount !== null
      ? facts.raw.length === facts.expectedCount
      : facts.singlePageList === true;
  const complete = facts.traversalFinished && countOk && rejected.length === 0;

  return { listings, rejected, duplicateCount, complete, warnings };
}
