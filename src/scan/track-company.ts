import { computeTracking } from '../core/changes.js';
import type { Logger } from '../logging/logger.js';
import type { CompanyScanResult } from '../schemas/result.js';
import type { JobChange } from '../schemas/snapshot.js';
import { readSnapshot, writeSnapshot } from '../storage/snapshots.js';

/**
 * CREATED       – first snapshot written for this company (baseline).
 * ADVANCED      – existing snapshot replaced with the new state.
 * NOT_ADVANCED  – snapshot intentionally left as it was (failed/incomplete scan, or dry run).
 * ERROR         – the snapshot could not be read or written; it was not modified.
 */
export type SnapshotAction = 'CREATED' | 'ADVANCED' | 'NOT_ADVANCED' | 'ERROR';

export interface ChangeCounts {
  new: number;
  updated: number;
  possiblyRemoved: number;
  removed: number;
}

export interface CompanyTracking {
  snapshotAction: SnapshotAction;
  snapshotPath: string;
  /** Explanation when the action is NOT_ADVANCED or ERROR. */
  reason: string | null;
  baseline: boolean;
  removalsEvaluated: boolean;
  changes: JobChange[];
  counts: ChangeCounts;
  warnings: string[];
}

export interface TrackOptions {
  stateDir: string;
  runId: string;
  scanAt: string;
  removedRetentionDays: number;
  dryRun: boolean;
  logger: Logger;
}

export function countChanges(changes: readonly JobChange[]): ChangeCounts {
  return {
    new: changes.filter((c) => c.kind === 'NEW').length,
    updated: changes.filter((c) => c.kind === 'UPDATED').length,
    possiblyRemoved: changes.filter((c) => c.kind === 'POSSIBLY_REMOVED').length,
    removed: changes.filter((c) => c.kind === 'REMOVED').length,
  };
}

const NO_CHANGES: ChangeCounts = { new: 0, updated: 0, possiblyRemoved: 0, removed: 0 };

/**
 * Read the company's snapshot, classify changes, and persist the new snapshot when
 * the scan is trustworthy. Returns the scan with `firstSeenAt` restored from history.
 */
export async function trackCompany(
  scan: CompanyScanResult,
  options: TrackOptions,
): Promise<{ scan: CompanyScanResult; tracking: CompanyTracking }> {
  const log = options.logger.child({ companyId: scan.companyId, step: 'tracking' });
  const read = await readSnapshot(options.stateDir, scan.companyId);

  if (read.kind === 'corrupt') {
    const reason = `existing snapshot is unusable (${read.reason}); it was left untouched — fix or move it to start a new baseline`;
    log.error({ path: read.path }, reason);
    return {
      scan,
      tracking: {
        snapshotAction: 'ERROR',
        snapshotPath: read.path,
        reason,
        baseline: false,
        removalsEvaluated: false,
        changes: [],
        counts: NO_CHANGES,
        warnings: [],
      },
    };
  }

  const previous = read.kind === 'ok' ? read.snapshot : null;
  const decision = computeTracking(previous, scan, {
    runId: options.runId,
    scanAt: options.scanAt,
    removedRetentionDays: options.removedRetentionDays,
  });
  const base = {
    snapshotPath: read.path,
    baseline: decision.baseline,
    removalsEvaluated: decision.removalsEvaluated,
    changes: decision.changes,
    counts: countChanges(decision.changes),
    warnings: decision.warnings,
  };
  const trackedScan = { ...scan, listings: decision.listings };

  if (decision.next === null || options.dryRun) {
    const reason = decision.notAdvancedReason ?? 'dry run';
    log.info({ reason, counts: base.counts }, 'snapshot not advanced');
    return { scan: trackedScan, tracking: { ...base, snapshotAction: 'NOT_ADVANCED', reason } };
  }

  try {
    await writeSnapshot(options.stateDir, decision.next);
  } catch (err) {
    const reason = `could not write snapshot: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ path: read.path }, reason);
    return { scan: trackedScan, tracking: { ...base, snapshotAction: 'ERROR', reason } };
  }

  const snapshotAction = previous === null ? 'CREATED' : 'ADVANCED';
  log.info({ snapshotAction, counts: base.counts, path: read.path }, 'snapshot saved');
  return { scan: trackedScan, tracking: { ...base, snapshotAction, reason: null } };
}
