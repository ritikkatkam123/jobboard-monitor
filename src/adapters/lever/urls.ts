import type { ProviderUrlRules } from '../../core/normalize.js';

/** Lever hosted job board host (observed 2026-10-13). */
export const LEVER_BOARD_HOST = 'jobs.lever.co';

export function leverBoardUrl(site: string): string {
  return `https://${LEVER_BOARD_HOST}/${encodeURIComponent(site)}`;
}

/** True for this exact board's list page (or paths under it) on the Lever host. */
export function isLeverBoardPage(url: URL, site: string): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === LEVER_BOARD_HOST &&
    (url.pathname.split('/')[1] ?? '').toLowerCase() === site.toLowerCase()
  );
}

/** Lever posting IDs are UUIDs, e.g. 2517cbbf-5640-4467-a3ae-08577e76bead. */
const POSTING_PATH =
  /^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

export function leverUrlRules(site: string): ProviderUrlRules {
  const board = site.toLowerCase();
  return {
    rejectJobUrl(url) {
      if (url.hostname.toLowerCase() !== LEVER_BOARD_HOST) {
        return `host "${url.hostname}" is not a supported Lever host`;
      }
      // Application pages (/<site>/<id>/apply) do not match and are rejected on purpose.
      const match = POSTING_PATH.exec(url.pathname.replace(/\/+$/u, ''));
      if (match === null) return 'URL is not a Lever job posting path';
      if (match[1]?.toLowerCase() !== board) {
        return `job belongs to a different board "${match[1] ?? ''}"`;
      }
      return null;
    },
    canonicalize(url) {
      const out = new URL(url.toString());
      out.search = ''; // the UUID fully identifies a posting; drops lever-origin etc.
      out.pathname = out.pathname.toLowerCase();
      return out;
    },
    extractPostingId(url) {
      return POSTING_PATH.exec(url.pathname)?.[2]?.toLowerCase() ?? null;
    },
  };
}

/** "Hybrid — " (with non-breaking spaces, as observed) -> "Hybrid". */
export function cleanWorkplaceType(text: string | null): string | null {
  if (text == null) return null;
  const cleaned = text.replace(/[\s\u00a0]*[—–-][\s\u00a0]*$/u, '').trim();
  return cleaned === '' ? null : cleaned;
}

/** Department and team as "Engineering / Experience", or whichever one exists. */
export function combineDepartment(department: string | null, team: string | null): string | null {
  const d = department?.trim() ?? '';
  const t = team?.trim() ?? '';
  if (d !== '' && t !== '') return d.toLowerCase() === t.toLowerCase() ? d : `${d} / ${t}`;
  return d !== '' ? d : t !== '' ? t : null;
}
