import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvCell, JOBS_CSV_HEADER, renderJobsCsv } from '../../src/reporting/csv.js';
import { escapeHtml, renderHtmlReport, safeLink } from '../../src/reporting/html.js';
import {
  readLatestRun,
  ReportNotFoundError,
  RUN_RESULT_SCHEMA_VERSION,
  writeReports,
} from '../../src/reporting/write.js';
import type { JobChange } from '../../src/schemas/snapshot.js';
import { failedScan, job, makeRun, scan, tracked } from './helpers.js';

function change(kind: JobChange['kind'], id: string, extra: Partial<JobChange> = {}): JobChange {
  const listing = job(id);
  return {
    kind,
    jobId: listing.id,
    companyId: 'acme',
    listing,
    fieldChanges: [],
    reappeared: false,
    ...extra,
  };
}

/** A hostile listing: every field tries to break out of CSV cells or HTML. */
const hostile = job('666', {
  title: '<script>alert("x")</script> & <b>bold</b>',
  location: '"><img src=x onerror=alert(1)>',
  department: 'O\'Reilly, "Ops"\nTeam',
  url: 'https://job-boards.greenhouse.io/acme/jobs/666?a=1&b="2"',
});

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line1\nline2', '"line1\nline2"'],
    ['cr\rhere', '"cr\rhere"'],
    ['Zürich — 東京', 'Zürich — 東京'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+SUM(A1)', "'+SUM(A1)"],
    ['-2+3', "'-2+3"],
    ['@cmd', "'@cmd"],
    ['\tTAB', "'\tTAB"],
    ['=HYPERLINK("https://e.com","x")', `"'=HYPERLINK(""https://e.com"",""x"")"`],
  ])('neutralizes formula-like text %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves numbers and nulls alone', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});

describe('renderJobsCsv', () => {
  const rows = (csv: string) => csv.replace(/^\uFEFF/u, '').split('\r\n');

  it('starts with a BOM and header, uses CRLF, and tags changes', () => {
    const run = makeRun([
      tracked(scan([job('1'), job('2')]), [
        change('NEW', '2'),
        change('POSSIBLY_REMOVED', '9'),
        change('UPDATED', '1', {
          fieldChanges: [{ field: 'title', before: 'Old', after: 'Job 1' }],
        }),
      ]),
    ]);
    const csv = renderJobsCsv(run);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = rows(csv);
    expect(lines[0]).toBe(JOBS_CSV_HEADER.join(','));
    expect(lines[1]?.startsWith('UPDATED,Acme,Job 1,')).toBe(true);
    expect(lines[1]?.endsWith(',title')).toBe(true);
    expect(lines[2]?.startsWith('NEW,Acme,Job 2,')).toBe(true);
    expect(lines[3]?.startsWith('POSSIBLY_REMOVED,Acme,Job 9,')).toBe(true);
    expect(lines.at(-1)).toBe(''); // trailing CRLF
  });

  it('keeps hostile text inside its cells', () => {
    const csv = renderJobsCsv(makeRun([tracked(scan([hostile]))]));
    expect(csv).toContain('"O\'Reilly, ""Ops""\nTeam"');
    expect(csv).toContain('"https://job-boards.greenhouse.io/acme/jobs/666?a=1&b=""2"""');
  });

  it('an empty but valid run produces just the header', () => {
    const csv = renderJobsCsv(makeRun([tracked(scan([], { expectedCount: 0 }))]));
    expect(rows(csv)).toEqual([JOBS_CSV_HEADER.join(','), '']);
  });
});

describe('escapeHtml / safeLink', () => {
  it('escapes all five special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    expect(escapeHtml(null)).toBe('');
  });

  it('only links https URLs', () => {
    expect(safeLink('javascript:alert(1)', 'x')).toBe('x');
    expect(safeLink('data:text/html,hi', 'x')).toBe('x');
    expect(safeLink('not a url', 'x')).toBe('x');
    expect(safeLink('https://e.com/?a=1&b=2', '<t>')).toBe(
      '<a href="https://e.com/?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">&lt;t&gt;</a>',
    );
  });
});

describe('renderHtmlReport', () => {
  it('never emits scraped text as markup', () => {
    const html = renderHtmlReport(
      makeRun([tracked(scan([hostile]), [change('NEW', '666', { listing: hostile })])], {
        filters: { keywords: ['<i>qa</i>'], locations: [] },
      }),
    );
    expect(html).not.toMatch(/<script/iu);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('<i>qa</i>');
    expect(html).toContain(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;',
    );
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;i&gt;qa&lt;/i&gt;');
  });

  it('forbids scripts with a Content-Security-Policy and loads nothing external', () => {
    const html = renderHtmlReport(makeRun([tracked(scan([job('1')]))]));
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'`);
    expect(html).not.toMatch(/<(script|link|img|iframe)\b/iu);
  });

  it('labels live and demo data differently', () => {
    const live = renderHtmlReport(makeRun([tracked(scan([job('1')]))]));
    const demo = renderHtmlReport(makeRun([tracked(scan([job('1')]))], { dataSource: 'demo' }));
    expect(live).toContain('LIVE DATA');
    expect(live).not.toContain('fictional');
    expect(demo).toContain('DEMO DATA');
    expect(demo).toContain('fictional fixture pages');
  });

  it('renders an empty but valid run, and failed companies with their reason', () => {
    const html = renderHtmlReport(
      makeRun([
        tracked(scan([], { expectedCount: 0 })),
        tracked({ ...failedScan('ACCESS_DENIED'), companyId: 'blocked-co' }),
      ]),
    );
    expect(html).toContain('No changes since the previous complete scan.');
    expect(html).toContain('No listings.');
    expect(html).toContain('BLOCKED');
    expect(html).toContain('ACCESS_DENIED');
  });

  it('does not repeat baseline jobs as changes', () => {
    const html = renderHtmlReport(makeRun([tracked(scan([job('1')]), [change('NEW', '1')], true)]));
    expect(html).toContain('First scan (baseline) for: acme');
    expect(html).toContain('No changes since the previous complete scan.');
  });
});

describe('writeReports / readLatestRun', () => {
  async function tmp() {
    return mkdtemp(join(tmpdir(), 'jbm-reports-'));
  }

  it('writes all three reports and a latest pointer, and reads them back', async () => {
    const out = await tmp();
    const run = makeRun([tracked(scan([job('1')]))]);
    const paths = await writeReports(out, run);
    expect(paths.dir).toBe(join(out, 'runs', run.runId));
    const json = JSON.parse(await readFile(paths.json, 'utf8')) as { schemaVersion: number };
    expect(json.schemaVersion).toBe(RUN_RESULT_SCHEMA_VERSION);
    expect(await readFile(paths.csv, 'utf8')).toContain('Job 1');
    expect(await readFile(paths.html, 'utf8')).toContain('<!doctype html>');

    const latest = await readLatestRun(out);
    expect(latest.pointer.runId).toBe(run.runId);
    expect(latest.run.summary).toEqual(run.summary);
    expect(latest.paths).toEqual(paths);
  });

  it('demo-style writes leave the latest pointer alone', async () => {
    const out = await tmp();
    await writeReports(out, makeRun([tracked(scan([]))]), { updateLatest: false });
    await expect(readLatestRun(out)).rejects.toThrow(/No completed scan found/u);
  });

  it('reports a clear error for a missing or unreadable run', async () => {
    const out = await tmp();
    await expect(readLatestRun(out)).rejects.toBeInstanceOf(ReportNotFoundError);
    const paths = await writeReports(out, makeRun([tracked(scan([]))]));
    await writeFile(paths.json, '{"schemaVersion": 1}');
    await expect(readLatestRun(out)).rejects.toThrow(/unexpected format/u);
  });
});
