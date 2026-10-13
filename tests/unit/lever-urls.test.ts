import { describe, expect, it } from 'vitest';
import {
  cleanWorkplaceType,
  combineDepartment,
  isLeverBoardPage,
  leverBoardUrl,
  leverUrlRules,
} from '../../src/adapters/lever/urls.js';
import { ConfigError, parseConfig } from '../../src/config/load.js';
import { normalizeListing } from '../../src/core/normalize.js';

const ID = '2517cbbf-5640-4467-a3ae-08577e76bead';
const rules = leverUrlRules('initrode');

describe('leverBoardUrl / isLeverBoardPage', () => {
  it('builds the board URL from the site name', () => {
    expect(leverBoardUrl('initrode')).toBe('https://jobs.lever.co/initrode');
  });

  it.each([
    ['https://jobs.lever.co/initrode', true],
    ['https://jobs.lever.co/INITRODE', true],
    ['https://jobs.lever.co/other', false],
    ['https://jobs.eu.lever.co/initrode', false],
    ['http://jobs.lever.co/initrode', false],
    ['https://careers.initrode.com/', false],
  ])('%s -> %s', (url, expected) => {
    expect(isLeverBoardPage(new URL(url), 'initrode')).toBe(expected);
  });
});

describe('leverUrlRules', () => {
  it('accepts a posting URL on this board', () => {
    expect(rules.rejectJobUrl(new URL(`https://jobs.lever.co/initrode/${ID}`))).toBeNull();
  });

  it.each([
    [`https://jobs.lever.co/initrode/${ID}/apply`, 'URL is not a Lever job posting path'],
    ['https://jobs.lever.co/initrode/not-a-uuid', 'URL is not a Lever job posting path'],
    [`https://jobs.lever.co/other/${ID}`, 'job belongs to a different board "other"'],
    [`https://evil.example/initrode/${ID}`, 'host "evil.example" is not a supported Lever host'],
  ])('rejects %s', (url, reason) => {
    expect(rules.rejectJobUrl(new URL(url))).toBe(reason);
  });

  it('maps equivalent URLs to one stable ID', () => {
    const ctx = {
      companyId: 'initrode',
      companyName: 'Initrode',
      sourceAdapter: 'lever',
      boardKey: 'initrode',
      baseUrl: 'https://jobs.lever.co/initrode',
      observedAt: '2026-10-13T00:00:00.000Z',
      rules,
    };
    const variants = [
      `https://jobs.lever.co/initrode/${ID}`,
      `https://jobs.lever.co/initrode/${ID}/`,
      `https://jobs.lever.co/initrode/${ID}?lever-origin=applied&lever-source%5B%5D=LinkedIn`,
      `https://jobs.lever.co/Initrode/${ID.toUpperCase()}#top`,
      `/initrode/${ID}`,
    ];
    for (const url of variants) {
      const r = normalizeListing(
        { title: 'QA Engineer', url, location: null, department: null },
        ctx,
      );
      expect(r.ok && [r.listing.id, r.listing.url]).toEqual([
        `lever:initrode:${ID}`,
        `https://jobs.lever.co/initrode/${ID}`,
      ]);
    }
  });
});

describe('Lever field cleanup', () => {
  it.each([
    ['Hybrid\u00a0—\u00a0', 'Hybrid'],
    ['Remote — ', 'Remote'],
    ['On-site\u00a0—\u00a0', 'On-site'], // the hyphen inside "On-site" must survive
    ['Remote', 'Remote'],
    ['\u00a0—\u00a0', null],
    [null, null],
  ])('workplace %j -> %j', (input, expected) => {
    expect(cleanWorkplaceType(input)).toBe(expected);
  });

  it.each([
    ['Engineering', 'Experience', 'Engineering / Experience'],
    ['Sales', 'sales', 'Sales'],
    [null, 'QA', 'QA'],
    ['Engineering', null, 'Engineering'],
    ['  ', '  ', null],
    [null, null, null],
  ])('department %j + team %j -> %j', (department, team, expected) => {
    expect(combineDepartment(department, team)).toBe(expected);
  });
});

describe('Lever config', () => {
  const lever = { id: 'initrode', name: 'Initrode', provider: 'lever', site: 'initrode' };

  it('accepts a Lever company alongside Greenhouse', () => {
    const cfg = parseConfig({
      companies: [lever, { id: 'gl', name: 'GL', provider: 'greenhouse', boardToken: 'gitlab' }],
    });
    expect(cfg.companies.map((c) => c.provider)).toEqual(['lever', 'greenhouse']);
  });

  it.each([
    [{ ...lever, site: '../admin' }, /site/u],
    [{ ...lever, site: 'jobs.lever.co/x' }, /site/u],
    [{ id: 'x', name: 'X', provider: 'lever', boardToken: 'x' }, /Unrecognized key|site/u],
    [
      { ...lever, provider: 'workday' },
      /unsupported provider; supported providers: greenhouse, lever/u,
    ],
  ])('rejects %j', (company, message) => {
    let issues: string[] = [];
    try {
      parseConfig({ companies: [company] });
    } catch (err) {
      if (err instanceof ConfigError) issues = err.issues;
    }
    expect(issues.join('\n')).toMatch(message);
  });
});
