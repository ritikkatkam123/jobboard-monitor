import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, isTrackingParam, parseSafeHttpsUrl } from '../../src/core/url.js';
import { cleanText } from '../../src/core/text.js';

const BASE = 'https://job-boards.greenhouse.io/acme';

describe('cleanText', () => {
  it('collapses whitespace including newlines, tabs and non-breaking spaces', () => {
    expect(cleanText('  Senior\n\tQA  Engineer  ')).toBe('Senior QA Engineer');
  });
  it('returns null for missing or blank values', () => {
    expect(cleanText(null)).toBeNull();
    expect(cleanText(undefined)).toBeNull();
    expect(cleanText(' \n ')).toBeNull();
  });
});

describe('isTrackingParam', () => {
  it.each(['utm_source', 'UTM_Campaign', 'gh_src', 'gclid', 'lever-source'])(
    '%s is tracking',
    (p) => {
      expect(isTrackingParam(p)).toBe(true);
    },
  );
  it.each(['gh_jid', 'page', 'id'])('%s is not tracking', (p) => {
    expect(isTrackingParam(p)).toBe(false);
  });
});

describe('parseSafeHttpsUrl', () => {
  it('resolves relative links against the page URL', () => {
    const r = parseSafeHttpsUrl('/acme/jobs/1', BASE);
    expect(r.ok && r.url.toString()).toBe('https://job-boards.greenhouse.io/acme/jobs/1');
  });

  it.each([
    [null, 'missing URL'],
    ['   ', 'missing URL'],
    ['javascript:alert(1)', 'unsupported URL scheme "javascript:"'],
    ['data:text/html,hi', 'unsupported URL scheme "data:"'],
    ['http://job-boards.greenhouse.io/acme/jobs/1', 'unsupported URL scheme "http:"'],
    ['https://user:pw@job-boards.greenhouse.io/acme/jobs/1', 'URL must not contain credentials'],
    ['https://exa mple.com/', 'unparseable URL'],
  ])('rejects %j', (href, reason) => {
    expect(parseSafeHttpsUrl(href, BASE)).toEqual({ ok: false, reason });
  });
});

describe('canonicalizeUrl', () => {
  const canon = (s: string) => canonicalizeUrl(new URL(s)).toString();

  it('removes tracking params, fragments, default port, and trailing slashes', () => {
    expect(
      canon('https://Job-Boards.Greenhouse.io:443/acme/jobs/1/?utm_source=x&gh_src=y#apply'),
    ).toBe('https://job-boards.greenhouse.io/acme/jobs/1');
  });

  it('keeps meaningful params and sorts them so order does not matter', () => {
    expect(canon('https://example.com/j?b=2&utm_medium=m&a=1')).toBe(
      'https://example.com/j?a=1&b=2',
    );
    expect(canon('https://example.com/j?a=1&b=2')).toBe(canon('https://example.com/j?b=2&a=1'));
  });

  it('keeps the root path slash', () => {
    expect(canon('https://example.com/')).toBe('https://example.com/');
  });
});
