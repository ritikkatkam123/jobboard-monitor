/**
 * Query parameters that only track where a click came from. They do not change
 * which job a URL points to, so they are removed before computing identity.
 */
const TRACKING_PARAMS = new Set([
  'gh_src',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmkt',
  'lever-source',
  'lever-origin',
  'ref',
  'source',
]);

export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Parse an href found on a page into an absolute URL and apply generic safety
 * rules. Site-specific host rules are applied by the adapter on top of this.
 */
export function parseSafeHttpsUrl(href: string | null, base: string): UrlCheck {
  if (href == null || href.trim() === '') return { ok: false, reason: 'missing URL' };
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return { ok: false, reason: 'unparseable URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported URL scheme "${url.protocol}"` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URL must not contain credentials' };
  }
  return { ok: true, url };
}

/**
 * Canonical form used for identity and comparison:
 * lowercase host, no default port, no fragment, no tracking params,
 * remaining params sorted, no trailing slash (except the root path).
 */
export function canonicalizeUrl(input: URL): URL {
  const url = new URL(input.toString());
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  if (url.port === '443') url.port = '';

  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  url.search = '';
  for (const [name, value] of kept) url.searchParams.append(name, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/u, '');
  }
  return url;
}
