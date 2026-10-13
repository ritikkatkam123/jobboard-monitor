import type { JobListing } from '../schemas/job.js';

export interface DedupeResult {
  listings: JobListing[];
  duplicateCount: number;
  /** IDs that appeared more than once with different business fields. */
  conflictingIds: string[];
}

function sameBusinessFields(a: JobListing, b: JobListing): boolean {
  return (
    a.title === b.title &&
    a.url === b.url &&
    a.location === b.location &&
    a.department === b.department
  );
}

/** Keep the first occurrence of each stable ID, preserving page order. */
export function dedupeListings(listings: readonly JobListing[]): DedupeResult {
  const byId = new Map<string, JobListing>();
  const conflicting = new Set<string>();
  let duplicateCount = 0;

  for (const listing of listings) {
    const existing = byId.get(listing.id);
    if (existing === undefined) {
      byId.set(listing.id, listing);
      continue;
    }
    duplicateCount += 1;
    if (!sameBusinessFields(existing, listing)) conflicting.add(listing.id);
  }

  return { listings: [...byId.values()], duplicateCount, conflictingIds: [...conflicting] };
}
