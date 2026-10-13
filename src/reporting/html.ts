import type { CompanyRunResult, RunResult } from '../scan/run-scan.js';
import type { JobListing } from '../schemas/job.js';
import type { JobChange } from '../schemas/snapshot.js';

/**
 * Escape text for HTML element content AND quoted attribute values.
 * Every piece of scraped or user-supplied text goes through this; nothing
 * external is ever inserted as markup.
 */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** Only https links become clickable; anything else (javascript:, data:, ...) is shown as text. */
export function safeLink(url: string, label: string): string {
  let ok: boolean;
  try {
    ok = new URL(url).protocol === 'https:';
  } catch {
    ok = false;
  }
  return ok
    ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

const CSS = `
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b6470;--line:#d8dee4;--card:#f6f8fa;
--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--new:#0969da;--demo:#8250df}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;
--line:#30363d;--card:#161b22;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--new:#4493f8;--demo:#ab7df8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}
.meta{color:var(--muted);margin:0}.badge{display:inline-block;padding:2px 8px;border-radius:999px;
font-size:12px;font-weight:600;border:1px solid currentColor;vertical-align:middle}
.live{color:var(--ok)}.demo{color:var(--demo)}.banner{margin:16px 0;padding:12px 16px;border-radius:8px;
border:1px solid var(--demo);color:var(--demo)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.card b{display:block;font-size:22px}.card span{color:var(--muted);font-size:12px}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
.SUCCESS{color:var(--ok)}.FAILED,.REMOVED,.ERROR{color:var(--bad)}.BLOCKED,.POSSIBLY_REMOVED,.WARN{color:var(--warn)}
.NEW{color:var(--new)}.UPDATED{color:var(--warn)}.small{font-size:12px;color:var(--muted)}
a{color:var(--new)}code{font-size:12px;word-break:break-all}ul{margin:0;padding-left:18px}
`;

function cards(run: RunResult): string {
  const s = run.summary;
  const items: [number, string][] = [
    [s.companiesAttempted, 'companies attempted'],
    [s.companiesSucceeded, 'succeeded'],
    [s.companiesFailed, 'failed'],
    [s.companiesBlocked, 'blocked'],
    [s.listingsExtracted, 'listings extracted'],
    [
      s.listingsMatched,
      run.filters.keywords.length > 0 || run.filters.locations.length > 0
        ? 'matched filters'
        : 'listed (no filters)',
    ],
    [s.listingsRejected, 'rejected rows'],
    [s.duplicatesRemoved, 'duplicates removed'],
    [s.newJobs, 'new'],
    [s.updatedJobs, 'updated'],
    [s.possiblyRemovedJobs, 'possibly removed'],
    [s.removedJobs, 'removed'],
  ];
  return `<div class="cards">${items
    .map(
      ([n, label]) =>
        `<div class="card"><b>${escapeHtml(n)}</b><span>${escapeHtml(label)}</span></div>`,
    )
    .join('')}</div>`;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '' : `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
}

function companyRow(c: CompanyRunResult): string {
  const status = c.status === 'SUCCESS' && !c.complete ? 'WARN' : c.status;
  const detail =
    c.status === 'SUCCESS'
      ? `${c.listings.length} listings, ${c.complete ? 'complete' : 'INCOMPLETE'}` +
        (c.expectedCount !== null ? ` (board reports ${c.expectedCount})` : '')
      : `${c.error?.category ?? 'UNKNOWN'}: ${c.error?.message ?? ''}`;
  const notes = [
    ...c.warnings.map((w) => `warning: ${escapeHtml(w)}`),
    ...c.tracking.warnings.map((w) => `warning: ${escapeHtml(w)}`),
    ...c.retries.map(
      (r) =>
        `retried page ${escapeHtml(r.page)} after ${escapeHtml(r.category)}` +
        (r.httpStatus !== null ? ` (HTTP ${escapeHtml(r.httpStatus)})` : '') +
        `, waited ${escapeHtml(r.delayMs)} ms`,
    ),
    ...c.diagnostics.map((d) => `diagnostic: <code>${escapeHtml(d)}</code>`),
  ];
  const tracking =
    escapeHtml(c.tracking.snapshotAction) +
    (c.tracking.baseline && c.tracking.snapshotAction === 'CREATED' ? ' (baseline)' : '') +
    (c.tracking.reason ? `<div class="small">${escapeHtml(c.tracking.reason)}</div>` : '');
  return `<tr><td>${safeLink(c.sourceUrl, c.companyName)}<div class="small">${escapeHtml(c.companyId)}</div></td>
<td class="${escapeHtml(status)}">${escapeHtml(status)}</td><td>${escapeHtml(detail)}${list(notes)}</td>
<td>${tracking}</td><td>${escapeHtml(c.durationMs)} ms</td></tr>`;
}

function changeRow(change: JobChange): string {
  const job = change.listing;
  const label = change.reappeared ? 'NEW (reappeared)' : change.kind;
  const fields = list(
    change.fieldChanges.map(
      (f) =>
        `${escapeHtml(f.field)}: ${escapeHtml(f.before ?? '(none)')} &rarr; ${escapeHtml(f.after ?? '(none)')}`,
    ),
  );
  return `<tr><td class="${escapeHtml(change.kind)}">${escapeHtml(label)}</td><td>${safeLink(job.url, job.title)}${fields}</td>
<td>${escapeHtml(job.location ?? '—')}</td><td>${escapeHtml(job.companyName)}</td></tr>`;
}

function listingRow(job: JobListing): string {
  return `<tr><td>${safeLink(job.url, job.title)}</td><td>${escapeHtml(job.location ?? '—')}</td>
<td>${escapeHtml(job.department ?? '—')}</td><td>${escapeHtml(job.companyName)}</td>
<td class="small">${escapeHtml(job.firstSeenAt.slice(0, 10))}</td></tr>`;
}

function table(headers: readonly string[], rows: readonly string[], empty: string): string {
  if (rows.length === 0) return `<p class="small">${escapeHtml(empty)}</p>`;
  return `<div class="scroll"><table><thead><tr>${headers
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/**
 * A single self-contained HTML file: inline CSS, no scripts, no external requests.
 * The Content-Security-Policy forbids scripts entirely, as a second line of defense
 * behind escaping.
 */
export function renderHtmlReport(run: RunResult): string {
  const filtered = run.filters.keywords.length > 0 || run.filters.locations.length > 0;
  const filterText = filtered
    ? `Filters — keywords: ${run.filters.keywords.join(', ') || 'any'}; locations: ${run.filters.locations.join(', ') || 'any'}`
    : 'No filters: all collected listings are shown.';
  const baselineIds = new Set(
    run.companies.filter((c) => c.tracking.baseline).map((c) => c.companyId),
  );
  const changes = run.matchedChanges.filter((c) => !baselineIds.has(c.companyId));
  const baselineNote =
    baselineIds.size > 0
      ? `<p class="small">First scan (baseline) for: ${escapeHtml([...baselineIds].join(', '))}. Their jobs are all NEW by definition and are not repeated here.</p>`
      : '';
  const isDemo = run.dataSource === 'demo';
  const title = `JobBoard Monitor report ${run.runId}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main>
<h1>JobBoard Monitor <span class="badge ${isDemo ? 'demo' : 'live'}">${isDemo ? 'DEMO DATA' : 'LIVE DATA'}</span></h1>
<p class="meta">Run <code>${escapeHtml(run.runId)}</code> · started ${escapeHtml(run.startedAt)} · ${escapeHtml(run.durationMs)} ms${run.dryRun ? ' · dry run (snapshots not saved)' : ''}</p>
${isDemo ? '<div class="banner">This report was generated from bundled, fictional fixture pages. It contains no real job listings.</div>' : ''}
<p class="meta">${escapeHtml(filterText)}</p>
${cards(run)}
<h2>Companies</h2>
${table(['Company', 'Status', 'Result', 'Snapshot', 'Time'], run.companies.map(companyRow), 'No companies were scanned.')}
<h2>Changes${filtered ? ' matching filters' : ''}</h2>
${baselineNote}
${table(['Change', 'Job', 'Location', 'Company'], changes.map(changeRow), 'No changes since the previous complete scan.')}
<h2>Current listings${filtered ? ' matching filters' : ''} (${escapeHtml(run.matchedListings.length)})</h2>
${table(['Title', 'Location', 'Department', 'Company', 'First seen'], run.matchedListings.map(listingRow), 'No listings.')}
<p class="small">Generated by JobBoard Monitor. Listings link to the employer's public posting.</p>
</main></body></html>
`;
}
