import { describe, expect, it } from 'vitest';
import { assembleListings } from '../../src/core/assemble.js';
import { dedupeListings } from '../../src/core/dedupe.js';
import { filterListings } from '../../src/core/filter.js';
import type { NormalizeContext } from '../../src/core/normalize.js';
import { greenhouseUrlRules } from '../../src/adapters/greenhouse/urls.js';
import type { JobListing, RawJobListing } from '../../src/schemas/job.js';

function job(overrides: Partial<JobListing>): JobListing {
  return {
    id: 'greenhouse:acme:1',
    companyId: 'acme',
    companyName: 'Acme',
    title: 'Software Engineer',
    url: 'https://job-boards.greenhouse.io/acme/jobs/1',
    location: 'Austin, Texas',
    department: null,
    employmentType: null,
    workplaceType: null,
    descriptionHash: null,
    sourceAdapter: 'greenhouse',
    providerPostingId: '1',
    providerPublishedAt: null,
    providerUpdatedAt: null,
    firstSeenAt: '2026-10-12T00:00:00.000Z',
    lastSeenAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('dedupeListings', () => {
  it('keeps the first occurrence of each ID in page order', () => {
    const a = job({ id: 'a' });
    const b = job({ id: 'b' });
    const r = dedupeListings([a, b, a]);
    expect(r.listings).toEqual([a, b]);
    expect(r.duplicateCount).toBe(1);
    expect(r.conflictingIds).toEqual([]);
  });

  it('reports duplicates whose business fields disagree', () => {
    const r = dedupeListings([job({ id: 'a' }), job({ id: 'a', title: 'Different' })]);
    expect(r.conflictingIds).toEqual(['a']);
  });

  it('ignores observation timestamps when comparing duplicates', () => {
    const r = dedupeListings([
      job({ id: 'a' }),
      job({ id: 'a', lastSeenAt: '2027-01-01T00:00:00.000Z' }),
    ]);
    expect(r.conflictingIds).toEqual([]);
  });
});

describe('filterListings', () => {
  const jobs = [
    job({ id: '1', title: 'Senior Software Engineer', location: 'Austin, Texas' }),
    job({ id: '2', title: 'SOFTWARE ENGINEER II', location: 'Remote, US' }),
    job({ id: '3', title: 'Account Executive', location: 'Dallas, TEXAS' }),
    job({ id: '4', title: 'Software Engineer', location: null }),
  ];
  const ids = (r: { matched: JobListing[] }) => r.matched.map((j) => j.id);

  it('returns everything when no filters are given', () => {
    expect(ids(filterListings(jobs, { keywords: [], locations: [] }))).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('matches keywords case-insensitively as phrases in the title', () => {
    const r = filterListings(jobs, { keywords: ['software engineer'], locations: [] });
    expect(ids(r)).toEqual(['1', '2', '4']);
    expect(r.excludedCount).toBe(1);
  });

  it('treats multiple keywords as OR', () => {
    expect(ids(filterListings(jobs, { keywords: ['account', 'senior'], locations: [] }))).toEqual([
      '1',
      '3',
    ]);
  });

  it('matches location case-insensitively and never matches a missing location', () => {
    expect(ids(filterListings(jobs, { keywords: [], locations: ['texas'] }))).toEqual(['1', '3']);
  });

  it('combines keyword and location filters with AND', () => {
    expect(
      ids(filterListings(jobs, { keywords: ['Software Engineer'], locations: ['  Texas '] })),
    ).toEqual(['1']);
  });
});

describe('assembleListings completeness rules', () => {
  const ctx: NormalizeContext = {
    companyId: 'acme',
    companyName: 'Acme',
    sourceAdapter: 'greenhouse',
    boardKey: 'acme',
    baseUrl: 'https://job-boards.greenhouse.io/acme',
    observedAt: '2026-10-12T00:00:00.000Z',
    rules: greenhouseUrlRules('acme'),
  };
  const row = (id: number, title = `Job ${id}`): RawJobListing => ({
    title,
    url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    location: null,
    department: null,
  });

  it('is complete when all rows validate and match the board count', () => {
    const r = assembleListings(
      { raw: [row(1), row(2)], expectedCount: 2, traversalFinished: true },
      ctx,
    );
    expect(r.complete).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('is incomplete when the board reports no count', () => {
    const r = assembleListings(
      { raw: [row(1)], expectedCount: null, traversalFinished: true },
      ctx,
    );
    expect(r.complete).toBe(false);
    expect(r.warnings).toContain(
      'Board did not report a job count; completeness cannot be verified',
    );
  });

  it('is incomplete when pagination stopped early', () => {
    const r = assembleListings({ raw: [row(1)], expectedCount: 1, traversalFinished: false }, ctx);
    expect(r.complete).toBe(false);
  });

  it('is incomplete when any row is rejected, even if counts match', () => {
    const r = assembleListings(
      { raw: [row(1), row(2, '')], expectedCount: 2, traversalFinished: true },
      ctx,
    );
    expect(r.complete).toBe(false);
    expect(r.rejected).toHaveLength(1);
  });

  it('a valid empty board is complete with no warnings', () => {
    const r = assembleListings({ raw: [], expectedCount: 0, traversalFinished: true }, ctx);
    expect(r).toMatchObject({ complete: true, listings: [], warnings: [] });
  });
});
