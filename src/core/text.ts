/**
 * Collapse all whitespace runs (including newlines, tabs, and non-breaking spaces)
 * to one space and trim. Returns null for missing or blank input so callers never
 * store empty strings as if they were data.
 */
export function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}
