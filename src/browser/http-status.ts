import type { ErrorCategory } from '../schemas/result.js';

/** Map an HTTP status to an error category, or null when the response is usable. */
export function categorizeHttpStatus(status: number): ErrorCategory | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return 'ACCESS_DENIED';
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'HTTP_ERROR';
}

/** Categories where the site is refusing us. We record them and stop — never work around them. */
export function isBlockingCategory(category: ErrorCategory): boolean {
  return category === 'ACCESS_DENIED' || category === 'RATE_LIMITED';
}
