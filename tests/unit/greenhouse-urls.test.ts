import { describe, expect, it } from 'vitest';
import {
  boardUrl,
  greenhouseUrlRules,
  isBoardPage,
  parseJobCount,
} from '../../src/adapters/greenhouse/urls.js';
import { normalizeListing, type NormalizeContext } from '../../src/core/normalize.js';

const rules = greenhouseUrlRules('acme');

describe('boardUrl', () => {
  it('builds page 1 without a page param and later pages with one', () => {
    expect(boardUrl('acme')).toBe('https://job-boards.greenhouse.io/acme');
    expect(boardUrl('acme', 3)).toBe('https://job-boards.greenhouse.io/acme?page=3');
  });
});

describe('isBoardPage', () => {
  it.each([
    ['https://job-boards.greenhouse.io/acme', true],
    ['https://job-boards.greenhouse.io/ACME?page=2', true],
    ['https://job-boards.greenhouse.io/other', false],
    ['https://www.acme.com/careers', false],
    ['http://job-boards.greenhouse.io/acme', false],
  ])('%s -> %s', (url, expected) => {
    expect(isBoardPage(new URL(url), 'acme')).toBe(expected);
  });
});

describe('greenhouseUrlRules', () => {
  it('accepts job URLs on current and legacy hosts for this board', () => {
    expect(rules.rejectJobUrl(new URL('https://job-boards.greenhouse.io/acme/jobs/12'))).toBeNull();
    expect(rules.rejectJobUrl(new URL('https://boards.greenhouse.io/acme/jobs/12'))).toBeNull();
  });

  it.each([
    ['https://evil.example/acme/jobs/1', 'host "evil.example" is not a supported Greenhouse host'],
    ['https://job-boards.greenhouse.io/acme', 'URL is not a Greenhouse job posting path'],
    ['https://job-boards.greenhouse.io/acme/jobs/abc', 'URL is not a Greenhouse job posting path'],
    ['https://job-boards.greenhouse.io/other/jobs/1', 'job belongs to a different board "other"'],
  ])('rejects %s', (url, reason) => {
    expect(rules.rejectJobUrl(new URL(url))).toBe(reason);
  });

  it('extracts the numeric posting ID from the path', () => {
    expect(
      rules.extractPostingId(new URL('https://job-boards.greenhouse.io/acme/jobs/8565469002')),
    ).toBe('8565469002');
  });
});

describe('parseJobCount', () => {
  it.each([
    ['221 jobs', 221],
    ['1 job', 1],
    ['0 jobs', 0],
    [' 1,234 Jobs ', 1234],
    ['Jobs', null],
    ['about 20 jobs', null],
    [null, null],
  ])('%j -> %j', (text, expected) => {
    expect(parseJobCount(text)).toBe(expected);
  });
});

describe('stable IDs for equivalent URLs', () => {
  const ctx: NormalizeContext = {
    companyId: 'acme',
    companyName: 'Acme',
    sourceAdapter: 'greenhouse',
    boardKey: 'acme',
    baseUrl: 'https://job-boards.greenhouse.io/acme',
    observedAt: '2026-10-12T00:00:00.000Z',
    rules,
  };
  const idFor = (url: string) => {
    const r = normalizeListing(
      { title: 'QA Engineer', url, location: null, department: null },
      ctx,
    );
    if (!r.ok) throw new Error(r.reason);
    return { id: r.listing.id, url: r.listing.url };
  };

  it('maps host, tracking, fragment, slash, and relative variants to one identity', () => {
    const variants = [
      'https://job-boards.greenhouse.io/acme/jobs/42',
      'https://boards.greenhouse.io/acme/jobs/42',
      'https://job-boards.greenhouse.io/acme/jobs/42/?gh_src=abc&utm_source=x',
      'https://job-boards.greenhouse.io/acme/jobs/42#app',
      '/acme/jobs/42',
    ];
    const results = variants.map(idFor);
    for (const r of results) {
      expect(r).toEqual({
        id: 'greenhouse:acme:42',
        url: 'https://job-boards.greenhouse.io/acme/jobs/42',
      });
    }
  });

  it('gives different postings different IDs even with identical titles', () => {
    expect(idFor('https://job-boards.greenhouse.io/acme/jobs/1').id).not.toBe(
      idFor('https://job-boards.greenhouse.io/acme/jobs/2').id,
    );
  });
});
