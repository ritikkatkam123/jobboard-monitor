import type { ProviderUrlRules } from '../../core/normalize.js';

/** Current Greenhouse hosted-board host (observed 2026-10-12). */
export const GREENHOUSE_BOARD_HOST = 'job-boards.greenhouse.io';
/** Legacy host; observed to 301-redirect to GREENHOUSE_BOARD_HOST. */
export const GREENHOUSE_LEGACY_HOST = 'boards.greenhouse.io';

const JOB_HOSTS = new Set([GREENHOUSE_BOARD_HOST, GREENHOUSE_LEGACY_HOST]);

export function boardUrl(token: string, page = 1): string {
  const url = new URL(`https://${GREENHOUSE_BOARD_HOST}/${encodeURIComponent(token)}`);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function firstPathSegment(url: URL): string {
  return (url.pathname.split('/')[1] ?? '').toLowerCase();
}

/** True for pages of this exact board on the Greenhouse board host. */
export function isBoardPage(url: URL, token: string): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === GREENHOUSE_BOARD_HOST &&
    firstPathSegment(url) === token.toLowerCase()
  );
}

const JOB_PATH = /^\/([^/]+)\/jobs\/(\d+)$/u;

export function greenhouseUrlRules(token: string): ProviderUrlRules {
  const board = token.toLowerCase();
  return {
    rejectJobUrl(url) {
      if (!JOB_HOSTS.has(url.hostname.toLowerCase())) {
        return `host "${url.hostname}" is not a supported Greenhouse host`;
      }
      const match = JOB_PATH.exec(url.pathname.replace(/\/+$/u, ''));
      if (match === null) return 'URL is not a Greenhouse job posting path';
      if (match[1]?.toLowerCase() !== board)
        return `job belongs to a different board "${match[1]}"`;
      return null;
    },
    canonicalize(url) {
      const out = new URL(url.toString());
      out.hostname = GREENHOUSE_BOARD_HOST; // legacy and current hosts point at the same job
      out.search = ''; // the numeric path ID fully identifies a posting
      return out;
    },
    extractPostingId(url) {
      return JOB_PATH.exec(url.pathname)?.[2] ?? null;
    },
  };
}

/** Parse the board's own count header, e.g. "221 jobs" or "1 job". */
export function parseJobCount(text: string | null): number | null {
  if (text == null) return null;
  const match = /^\s*([\d,]+)\s+jobs?\s*$/iu.exec(text);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1].replace(/,/gu, ''), 10);
}
