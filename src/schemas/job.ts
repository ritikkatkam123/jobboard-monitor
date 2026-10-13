import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });
const optionalText = z.string().min(1).nullable();

/**
 * The normalized shape every adapter must produce.
 * Optional business fields are `null` when the source does not provide them —
 * we never guess (for example, "Remote, US" is NOT turned into workplaceType=remote).
 */
export const jobListingSchema = z.strictObject({
  /** Stable identity: `<adapter>:<board>:<providerPostingId>` or `url:<hash>`. */
  id: z.string().min(1),
  companyId: z.string().min(1),
  companyName: z.string().min(1),
  title: z.string().min(2).max(300),
  url: z.url({ protocol: /^https$/ }),
  location: optionalText,
  department: optionalText,
  employmentType: optionalText,
  workplaceType: optionalText,
  /** SHA-256 of normalized description text; only when descriptions are enabled. */
  descriptionHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  sourceAdapter: z.string().min(1),
  providerPostingId: optionalText,
  providerPublishedAt: isoDateTime.nullable(),
  providerUpdatedAt: isoDateTime.nullable(),
  // Observation timestamps. Never used when deciding whether a job changed.
  firstSeenAt: isoDateTime,
  lastSeenAt: isoDateTime,
});

export type JobListing = z.infer<typeof jobListingSchema>;

/** What an adapter pulls out of the page before any cleaning. Every field may be missing. */
export interface RawJobListing {
  title: string | null;
  url: string | null;
  location: string | null;
  department: string | null;
  /** Only some providers expose these on the list page (Lever does, Greenhouse does not). */
  employmentType?: string | null;
  workplaceType?: string | null;
}
