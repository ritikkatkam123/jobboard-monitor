import type { RunResult } from '../scan/run-scan.js';
import type { JobListing } from '../schemas/job.js';
import type { JobChange } from '../schemas/snapshot.js';

/**
 * Characters that make spreadsheet apps treat a cell as a formula
 * (CSV/formula injection). Scraped text is untrusted, so any cell starting with
 * one of these is prefixed with an apostrophe, which spreadsheets display as text.
 */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Escape one cell per RFC 4180 and neutralize formula injection. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && text.length > 0 && FORMULA_TRIGGERS.has(text.charAt(0))) {
    text = `'${text}`;
  }
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function csvRow(values: readonly (string | number | null)[]): string {
  return values.map(csvCell).join(',');
}

export const JOBS_CSV_HEADER = [
  'change',
  'company',
  'title',
  'location',
  'department',
  'url',
  'job_id',
  'first_seen',
  'last_seen',
  'changed_fields',
] as const;

function row(listing: JobListing, change: JobChange | undefined): string {
  return csvRow([
    change ? (change.reappeared ? 'NEW (reappeared)' : change.kind) : '',
    listing.companyName,
    listing.title,
    listing.location,
    listing.department,
    listing.url,
    listing.id,
    listing.firstSeenAt,
    listing.lastSeenAt,
    change && change.fieldChanges.length > 0
      ? change.fieldChanges.map((f) => f.field).join('; ')
      : null,
  ]);
}

/**
 * One spreadsheet-friendly table: every current listing matching the filters,
 * tagged with its change (blank = unchanged), followed by matching jobs that are
 * possibly removed or removed (shown with their last-known details).
 *
 * Lines end with CRLF as RFC 4180 specifies; a UTF-8 BOM helps Excel read Unicode.
 */
export function renderJobsCsv(run: RunResult): string {
  const changeById = new Map(run.matchedChanges.map((c) => [c.jobId, c]));
  const lines = [csvRow(JOBS_CSV_HEADER)];
  for (const listing of run.matchedListings) lines.push(row(listing, changeById.get(listing.id)));
  for (const change of run.matchedChanges) {
    if (change.kind === 'POSSIBLY_REMOVED' || change.kind === 'REMOVED') {
      lines.push(row(change.listing, change));
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
