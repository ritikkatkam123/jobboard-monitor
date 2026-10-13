import type { JobListing } from '../schemas/job.js';
import { cleanText } from './text.js';

export interface ListingFilter {
  /** A listing matches if its title contains ANY of these (case-insensitive). */
  keywords: string[];
  /** A listing matches if its location contains ANY of these (case-insensitive). */
  locations: string[];
}

function normalizeTerms(terms: readonly string[]): string[] {
  return terms.map((t) => cleanText(t)?.toLocaleLowerCase()).filter((t) => t != null);
}

function containsAny(haystack: string | null, needles: string[]): boolean {
  if (haystack == null) return false;
  const lower = haystack.toLocaleLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Filters only decide what is *reported*. They never change what was collected.
 * A listing with no location never matches a location filter: we do not guess.
 */
export function filterListings(listings: readonly JobListing[], filter: ListingFilter) {
  const keywords = normalizeTerms(filter.keywords);
  const locations = normalizeTerms(filter.locations);

  const matched = listings.filter(
    (job) =>
      (keywords.length === 0 || containsAny(job.title, keywords)) &&
      (locations.length === 0 || containsAny(job.location, locations)),
  );
  return { matched, excludedCount: listings.length - matched.length };
}
