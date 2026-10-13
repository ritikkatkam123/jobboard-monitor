import { z } from 'zod';
import { jobListingSchema, type JobListing } from './job.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;
const isoDateTime = z.iso.datetime({ offset: true });

/**
 * ACTIVE            – seen in the latest complete scan.
 * POSSIBLY_REMOVED  – missing from exactly one complete scan so far.
 * REMOVED           – missing from REMOVAL_CONFIRMATION_SCANS consecutive complete scans.
 */
export const trackedJobStateSchema = z.enum(['ACTIVE', 'POSSIBLY_REMOVED', 'REMOVED']);
export type TrackedJobState = z.infer<typeof trackedJobStateSchema>;

export const trackedJobSchema = z.strictObject({
  listing: jobListingSchema,
  state: trackedJobStateSchema,
  /** Consecutive complete scans this job has been absent from. Reset to 0 when seen. */
  missedCompleteScans: z.number().int().min(0),
  removedAt: isoDateTime.nullable(),
});
export type TrackedJob = z.infer<typeof trackedJobSchema>;

export const completeScanEntrySchema = z.strictObject({
  runId: z.string().min(1),
  scanAt: isoDateTime,
  listingCount: z.number().int().min(0),
});

export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  companyId: z.string().min(1),
  adapter: z.string().min(1),
  sourceUrl: z.string().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  lastRunId: z.string().min(1),
  /** Sorted by job ID so successive snapshot files diff cleanly. */
  jobs: z.array(trackedJobSchema),
  /** Most recent complete scans, newest last (bounded). */
  completeScans: z.array(completeScanEntrySchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export type ChangeKind = 'NEW' | 'UPDATED' | 'POSSIBLY_REMOVED' | 'REMOVED';

/** Business fields compared between scans. Observation timestamps are deliberately absent. */
export const TRACKED_FIELDS = [
  'title',
  'url',
  'location',
  'department',
  'employmentType',
  'workplaceType',
  'descriptionHash',
] as const satisfies readonly (keyof JobListing)[];
export type TrackedField = (typeof TRACKED_FIELDS)[number];

export interface FieldChange {
  field: TrackedField;
  before: string | null;
  after: string | null;
}

export interface JobChange {
  kind: ChangeKind;
  jobId: string;
  companyId: string;
  /** Current listing, or the last-known listing for removals. */
  listing: JobListing;
  fieldChanges: FieldChange[];
  /** True when a job previously confirmed REMOVED shows up again. */
  reappeared: boolean;
}
