import { createHash } from 'node:crypto';
import { jobListingSchema, type JobListing, type RawJobListing } from '../schemas/job.js';
import { cleanText } from './text.js';
import { canonicalizeUrl, parseSafeHttpsUrl } from './url.js';

/**
 * Provider-specific rules an adapter supplies. Keeping them as plain functions
 * lets `core` stay free of any browser or site knowledge.
 */
export interface ProviderUrlRules {
  /** Return a reason string if this URL is not an acceptable job link, else null. */
  rejectJobUrl(url: URL): string | null;
  /** Map equivalent URLs (e.g. legacy hosts) onto one form. Runs after generic canonicalization. */
  canonicalize(url: URL): URL;
  /** Provider's own posting ID, only when it can be read reliably. */
  extractPostingId(url: URL): string | null;
}

export interface NormalizeContext {
  companyId: string;
  companyName: string;
  sourceAdapter: string;
  /** Provider-scoped board key, e.g. a Greenhouse board token. */
  boardKey: string;
  /** Page URL used to resolve relative links. */
  baseUrl: string;
  observedAt: string;
  rules: ProviderUrlRules;
}

export type NormalizeOutcome =
  { ok: true; listing: JobListing } | { ok: false; reason: string; raw: RawJobListing };

const MIN_TITLE = 2;
const MAX_TITLE = 300;

export function validateTitle(title: string | null): string | null {
  if (title == null) return 'missing title';
  if (title.length < MIN_TITLE) return 'title too short';
  if (title.length > MAX_TITLE) return 'title too long';
  if (!/[\p{L}\p{N}]/u.test(title)) return 'title has no letters or digits';
  return null;
}

export function stableJobId(
  adapter: string,
  boardKey: string,
  postingId: string | null,
  canonicalUrl: URL,
): string {
  if (postingId != null) return `${adapter}:${boardKey.toLowerCase()}:${postingId}`;
  const digest = createHash('sha256').update(canonicalUrl.toString()).digest('hex');
  return `url:${digest.slice(0, 16)}`;
}

export function normalizeListing(raw: RawJobListing, ctx: NormalizeContext): NormalizeOutcome {
  const reject = (reason: string): NormalizeOutcome => ({ ok: false, reason, raw });

  const title = cleanText(raw.title);
  const titleProblem = validateTitle(title);
  if (titleProblem != null || title == null) return reject(titleProblem ?? 'missing title');

  const parsed = parseSafeHttpsUrl(raw.url, ctx.baseUrl);
  if (!parsed.ok) return reject(parsed.reason);

  const hostProblem = ctx.rules.rejectJobUrl(parsed.url);
  if (hostProblem != null) return reject(hostProblem);

  const canonical = ctx.rules.canonicalize(canonicalizeUrl(parsed.url));
  const postingId = ctx.rules.extractPostingId(canonical);

  const candidate: JobListing = {
    id: stableJobId(ctx.sourceAdapter, ctx.boardKey, postingId, canonical),
    companyId: ctx.companyId,
    companyName: ctx.companyName,
    title,
    url: canonical.toString(),
    location: cleanText(raw.location),
    department: cleanText(raw.department),
    employmentType: cleanText(raw.employmentType),
    workplaceType: cleanText(raw.workplaceType),
    descriptionHash: null,
    sourceAdapter: ctx.sourceAdapter,
    providerPostingId: postingId,
    providerPublishedAt: null,
    providerUpdatedAt: null,
    firstSeenAt: ctx.observedAt,
    lastSeenAt: ctx.observedAt,
  };

  // Final guard: the schema is the single source of truth for a valid listing.
  const checked = jobListingSchema.safeParse(candidate);
  if (!checked.success) {
    return reject(`schema validation failed: ${checked.error.issues[0]?.message ?? 'unknown'}`);
  }
  return { ok: true, listing: checked.data };
}
