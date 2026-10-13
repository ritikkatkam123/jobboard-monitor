import type { CompanyRunResult, RunResult } from '../scan/run-scan.js';
import type { ReportPaths } from './write.js';
import type { JobChange } from '../schemas/snapshot.js';

const MAX_PRINTED_CHANGES = 25;

function trackingLine(c: CompanyRunResult): string {
  const t = c.tracking;
  const counts =
    `${t.counts.new} new, ${t.counts.updated} updated, ` +
    `${t.counts.possiblyRemoved} possibly removed, ${t.counts.removed} removed`;
  switch (t.snapshotAction) {
    case 'CREATED':
      return `snapshot: CREATED (baseline, ${t.counts.new} jobs recorded)`;
    case 'ADVANCED':
      return `snapshot: ADVANCED - ${counts}`;
    case 'NOT_ADVANCED':
      return (
        `snapshot: NOT_ADVANCED (${t.reason ?? 'unknown'})` +
        (t.changes.length > 0 ? ` - ${counts}` : '')
      );
    case 'ERROR':
      return `snapshot: ERROR - ${t.reason ?? 'unknown'}`;
  }
}

function describeChange(change: JobChange): string[] {
  const job = change.listing;
  const label = change.reappeared ? 'NEW (reappeared)' : change.kind;
  const lines = [
    `  ${label.padEnd(16)} ${job.title} | ${job.location ?? 'location n/a'} | ${job.companyName}`,
    `  ${''.padEnd(16)} ${job.url}`,
  ];
  for (const f of change.fieldChanges) {
    lines.push(`  ${''.padEnd(16)} ${f.field}: ${f.before ?? '(none)'} -> ${f.after ?? '(none)'}`);
  }
  return lines;
}

/** Plain-text summary for the terminal. Logs (JSON) go to stderr separately. */
export function formatRunSummary(run: RunResult, paths: ReportPaths): string {
  const lines: string[] = [];
  lines.push(
    `Run ${run.runId} (${run.dataSource === 'demo' ? 'DEMO data: fictional, not real jobs' : 'live data'}` +
      `${run.dryRun ? ', dry run: snapshots not saved' : ''}) ` +
      `finished in ${run.durationMs} ms`,
  );
  lines.push('');
  for (const c of run.companies) {
    const mark = c.status === 'SUCCESS' ? (c.complete ? 'OK  ' : 'WARN') : 'FAIL';
    const detail =
      c.status === 'SUCCESS'
        ? `${c.listings.length} listings, ${c.complete ? 'complete' : 'INCOMPLETE'}` +
          (c.expectedCount !== null ? ` (board reports ${c.expectedCount})` : '')
        : `${c.status}: ${c.error?.category ?? 'UNKNOWN'} - ${c.error?.message ?? ''}`;
    lines.push(`[${mark}] ${c.companyId.padEnd(20)} ${detail}`);
    lines.push(`         ${trackingLine(c)}`);
    for (const r of c.retries) {
      lines.push(
        `         retried page ${r.page} after ${r.category}` +
          (r.httpStatus !== null ? ` (HTTP ${r.httpStatus})` : '') +
          `, waited ${r.delayMs} ms (${r.reason})`,
      );
    }
    for (const w of [...c.warnings, ...c.tracking.warnings]) lines.push(`         warning: ${w}`);
    for (const d of c.diagnostics) lines.push(`         diagnostic: ${d}`);
  }

  const s = run.summary;
  const filtered = run.filters.keywords.length > 0 || run.filters.locations.length > 0;
  lines.push('');
  lines.push(
    `Companies: ${s.companiesAttempted} attempted, ${s.companiesSucceeded} succeeded, ` +
      `${s.companiesFailed} failed, ${s.companiesBlocked} blocked`,
  );
  lines.push(
    `Listings: ${s.listingsExtracted} extracted, ${s.listingsRejected} rejected, ` +
      `${s.duplicatesRemoved} duplicates removed` +
      (filtered ? `, ${s.listingsMatched} matched filters` : ''),
  );
  lines.push(
    `Changes: ${s.newJobs} new, ${s.updatedJobs} updated, ${s.possiblyRemovedJobs} possibly removed, ` +
      `${s.removedJobs} removed`,
  );

  // A baseline marks every job NEW; listing hundreds of them is noise, so skip those.
  const baselineCompanies = new Set(
    run.companies.filter((c) => c.tracking.baseline).map((c) => c.companyId),
  );
  const printable = run.matchedChanges.filter((c) => !baselineCompanies.has(c.companyId));
  if (printable.length > 0) {
    lines.push('');
    lines.push(filtered ? 'Changes matching filters:' : 'Changes:');
    for (const change of printable.slice(0, MAX_PRINTED_CHANGES))
      lines.push(...describeChange(change));
    if (printable.length > MAX_PRINTED_CHANGES) {
      lines.push(`  ... ${printable.length - MAX_PRINTED_CHANGES} more in the JSON output`);
    }
  }

  if (filtered) {
    lines.push('');
    lines.push('Current listings matching filters:');
    if (run.matchedListings.length === 0) lines.push('  (none)');
    for (const job of run.matchedListings.slice(0, MAX_PRINTED_CHANGES)) {
      lines.push(`  - ${job.title} | ${job.location ?? 'location n/a'} | ${job.companyName}`);
      lines.push(`    ${job.url}`);
    }
    if (run.matchedListings.length > MAX_PRINTED_CHANGES) {
      lines.push(
        `  ... ${run.matchedListings.length - MAX_PRINTED_CHANGES} more in the JSON output`,
      );
    }
  }
  lines.push('');
  lines.push('Reports:');
  lines.push(`  HTML: ${paths.html}`);
  lines.push(`  CSV:  ${paths.csv}`);
  lines.push(`  JSON: ${paths.json}`);
  return `${lines.join('\n')}\n`;
}
