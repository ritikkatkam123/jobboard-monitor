import { describe, expect, it } from 'vitest';
import {
  normalizeListing,
  stableJobId,
  validateTitle,
  type NormalizeContext,
  type ProviderUrlRules,
} from '../../src/core/normalize.js';
import { jobListingSchema, type RawJobListing } from '../../src/schemas/job.js';

/** Minimal provider rules: accept example.com links, no provider ID. */
const permissiveRules: ProviderUrlRules = {
  rejectJobUrl: (url) => (url.hostname === 'jobs.example.com' ? null : 'unsupported host'),
  canonicalize: (url) => url,
  extractPostingId: (url) => /\/jobs\/(\d+)$/u.exec(url.pathname)?.[1] ?? null,
};

const ctx: NormalizeContext = {
  companyId: 'acme',
  companyName: 'Acme',
  sourceAdapter: 'test',
  boardKey: 'Acme',
  baseUrl: 'https://jobs.example.com/acme',
  observedAt: '2026-10-12T00:00:00.000Z',
  rules: permissiveRules,
};

const raw = (overrides: Partial<RawJobListing> = {}): RawJobListing => ({
  title: 'QA Automation Engineer',
  url: 'https://jobs.example.com/acme/jobs/7',
  location: 'Austin, TX',
  department: 'Quality',
  ...overrides,
});

describe('normalizeListing', () => {
  it('produces a schema-valid listing with a provider-based stable ID', () => {
    const r = normalizeListing(raw(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(jobListingSchema.parse(r.listing)).toEqual(r.listing);
    expect(r.listing).toMatchObject({
      id: 'test:acme:7',
      title: 'QA Automation Engineer',
      url: 'https://jobs.example.com/acme/jobs/7',
      location: 'Austin, TX',
      department: 'Quality',
      providerPostingId: '7',
      firstSeenAt: ctx.observedAt,
      lastSeenAt: ctx.observedAt,
    });
  });

  it('keeps missing optional fields as null', () => {
    const r = normalizeListing(raw({ location: null, department: '   ' }), ctx);
    expect(r.ok && [r.listing.location, r.listing.department]).toEqual([null, null]);
    expect(
      r.ok && [r.listing.employmentType, r.listing.workplaceType, r.listing.descriptionHash],
    ).toEqual([null, null, null]);
  });

  it('falls back to a URL hash when no provider ID can be read', () => {
    const r = normalizeListing(
      raw({ url: 'https://jobs.example.com/acme/careers/qa-engineer' }),
      ctx,
    );
    expect(r.ok && r.listing.id).toMatch(/^url:[a-f0-9]{16}$/u);
    expect(r.ok && r.listing.providerPostingId).toBeNull();
  });

  it.each([
    [{ title: null }, 'missing title'],
    [{ title: '  ' }, 'missing title'],
    [{ title: 'Q' }, 'title too short'],
    [{ title: '— — —' }, 'title has no letters or digits'],
    [{ title: 'x'.repeat(301) }, 'title too long'],
    [{ url: null }, 'missing URL'],
    [{ url: 'javascript:void(0)' }, 'unsupported URL scheme "javascript:"'],
    [{ url: 'https://evil.example/jobs/1' }, 'unsupported host'],
  ])('rejects %j', (override, reason) => {
    const r = normalizeListing(raw(override), ctx);
    expect(r).toEqual({ ok: false, reason, raw: raw(override) });
  });
});

describe('validateTitle', () => {
  it('accepts non-Latin titles', () => {
    expect(validateTitle('ソフトウェアエンジニア')).toBeNull();
  });
});

describe('stableJobId', () => {
  it('lowercases the board key so config casing does not change identity', () => {
    const url = new URL('https://jobs.example.com/x');
    expect(stableJobId('greenhouse', 'ACME', '1', url)).toBe(
      stableJobId('greenhouse', 'acme', '1', url),
    );
  });
});
