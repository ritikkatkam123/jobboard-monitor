import type { JobListing } from '../schemas/job.js';
import type { CompanyScanResult } from '../schemas/result.js';
import {
  SNAPSHOT_SCHEMA_VERSION,
  TRACKED_FIELDS,
  type ChangeKind,
  type FieldChange,
  type JobChange,
  type Snapshot,
  type TrackedJob,
} from '../schemas/snapshot.js';

/** A job must be absent from this many consecutive complete scans before it is REMOVED. */
export const REMOVAL_CONFIRMATION_SCANS = 2;
/** How many complete-scan entries the snapshot keeps. */
export const COMPLETE_SCAN_HISTORY_LIMIT = 30;
/** Warn when one complete scan makes at least this share of active jobs disappear... */
const LARGE_DROP_RATIO = 0.5;
/** ...but only for boards big enough for the ratio to mean something. */
const LARGE_DROP_MIN_ACTIVE = 10;

export interface TrackingContext {
  runId: string;
  scanAt: string;
  removedRetentionDays: number;
}

export interface TrackingDecision {
  changes: JobChange[];
  /** Snapshot to persist, or null when the existing snapshot must be left untouched. */
  next: Snapshot | null;
  /** The scan's listings with `firstSeenAt` restored from history. */
  listings: JobListing[];
  /** First complete scan for this company: every job is NEW by definition. */
  baseline: boolean;
  /** Whether absences were evaluated (only for complete scans). */
  removalsEvaluated: boolean;
  /** Why the snapshot was not advanced, when it was not. */
  notAdvancedReason: string | null;
  warnings: string[];
}

export function diffFields(before: JobListing, after: JobListing): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of TRACKED_FIELDS) {
    const a = before[field];
    const b = after[field];
    // Descriptions are optional per run; a hash appearing or disappearing because the
    // feature was toggled is not a change to the job itself.
    if (field === 'descriptionHash' && (a === null || b === null)) continue;
    if (a !== b) changes.push({ field, before: a, after: b });
  }
  return changes;
}

const KIND_ORDER: Record<ChangeKind, number> = {
  NEW: 0,
  UPDATED: 1,
  POSSIBLY_REMOVED: 2,
  REMOVED: 3,
};

function sortChanges(changes: JobChange[]): JobChange[] {
  return changes.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.listing.title.localeCompare(b.listing.title) ||
      a.jobId.localeCompare(b.jobId),
  );
}

function change(
  kind: ChangeKind,
  listing: JobListing,
  fieldChanges: FieldChange[] = [],
  reappeared = false,
): JobChange {
  return {
    kind,
    jobId: listing.id,
    companyId: listing.companyId,
    listing,
    fieldChanges,
    reappeared,
  };
}

/**
 * Compare what is currently visible with the previous snapshot.
 * Used for both complete and incomplete scans; only complete scans go on to
 * evaluate absences.
 */
function classifyVisible(
  previousJobs: Map<string, TrackedJob>,
  scan: CompanyScanResult,
  scanAt: string,
) {
  const changes: JobChange[] = [];
  const listings: JobListing[] = [];
  const seen: TrackedJob[] = [];

  for (const current of scan.listings) {
    const prev = previousJobs.get(current.id);
    const merged: JobListing = {
      ...current,
      firstSeenAt: prev?.listing.firstSeenAt ?? scanAt,
      lastSeenAt: scanAt,
    };
    listings.push(merged);
    seen.push({ listing: merged, state: 'ACTIVE', missedCompleteScans: 0, removedAt: null });

    if (prev === undefined) {
      changes.push(change('NEW', merged));
    } else if (prev.state === 'REMOVED') {
      changes.push(change('NEW', merged, diffFields(prev.listing, merged), true));
    } else {
      const fieldChanges = diffFields(prev.listing, merged);
      if (fieldChanges.length > 0) changes.push(change('UPDATED', merged, fieldChanges));
      // A POSSIBLY_REMOVED job that is visible again simply becomes ACTIVE.
    }
  }
  return { changes, listings, seen };
}

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}

/**
 * Decide what changed and what (if anything) to persist. Pure: no file or browser access.
 *
 * Safety rules:
 * - FAILED or BLOCKED scans produce no changes and never touch the snapshot.
 * - Incomplete scans report NEW/UPDATED for what was visible, but do not evaluate
 *   absences and do not advance the snapshot (so those changes are re-evaluated next run).
 * - Only complete scans count toward removal; removal needs
 *   REMOVAL_CONFIRMATION_SCANS consecutive complete absences.
 */
export function computeTracking(
  previous: Snapshot | null,
  scan: CompanyScanResult,
  ctx: TrackingContext,
): TrackingDecision {
  const previousJobs = new Map((previous?.jobs ?? []).map((j) => [j.listing.id, j]));
  const baseline = previous === null;

  if (scan.status !== 'SUCCESS') {
    return {
      changes: [],
      next: null,
      listings: scan.listings,
      baseline,
      removalsEvaluated: false,
      notAdvancedReason: `scan ${scan.status}${scan.error ? ` (${scan.error.category})` : ''}`,
      warnings: [],
    };
  }

  const visible = classifyVisible(previousJobs, scan, ctx.scanAt);

  if (!scan.complete) {
    return {
      changes: sortChanges(visible.changes),
      next: null,
      listings: visible.listings,
      baseline,
      removalsEvaluated: false,
      notAdvancedReason: 'scan incomplete; removals not evaluated',
      warnings: [],
    };
  }

  const changes = [...visible.changes];
  const warnings: string[] = [];
  const seenIds = new Set(visible.seen.map((j) => j.listing.id));
  const carried: TrackedJob[] = [];
  const activeBefore = [...previousJobs.values()].filter((j) => j.state !== 'REMOVED').length;
  let newlyMissing = 0;

  for (const prev of previousJobs.values()) {
    if (seenIds.has(prev.listing.id)) continue;

    if (prev.state === 'REMOVED') {
      const expired =
        prev.removedAt !== null &&
        daysBetween(prev.removedAt, ctx.scanAt) > ctx.removedRetentionDays;
      if (!expired) carried.push(prev);
      continue;
    }

    const missed = prev.missedCompleteScans + 1;
    if (prev.state === 'ACTIVE') newlyMissing += 1;
    if (missed >= REMOVAL_CONFIRMATION_SCANS) {
      carried.push({
        ...prev,
        state: 'REMOVED',
        missedCompleteScans: missed,
        removedAt: ctx.scanAt,
      });
      changes.push(change('REMOVED', prev.listing));
    } else {
      carried.push({ ...prev, state: 'POSSIBLY_REMOVED', missedCompleteScans: missed });
      changes.push(change('POSSIBLY_REMOVED', prev.listing));
    }
  }

  if (activeBefore >= LARGE_DROP_MIN_ACTIVE && newlyMissing / activeBefore >= LARGE_DROP_RATIO) {
    warnings.push(
      `${newlyMissing} of ${activeBefore} previously active jobs are missing from this scan; ` +
        'verify the board before trusting removals',
    );
  }

  const jobs = [...visible.seen, ...carried].sort((a, b) =>
    a.listing.id.localeCompare(b.listing.id),
  );
  const next: Snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    companyId: scan.companyId,
    adapter: scan.adapter,
    sourceUrl: scan.sourceUrl,
    createdAt: previous?.createdAt ?? ctx.scanAt,
    updatedAt: ctx.scanAt,
    lastRunId: ctx.runId,
    jobs,
    completeScans: [
      ...(previous?.completeScans ?? []),
      { runId: ctx.runId, scanAt: ctx.scanAt, listingCount: visible.listings.length },
    ].slice(-COMPLETE_SCAN_HISTORY_LIMIT),
  };

  return {
    changes: sortChanges(changes),
    next,
    listings: visible.listings,
    baseline,
    removalsEvaluated: true,
    notAdvancedReason: null,
    warnings,
  };
}
