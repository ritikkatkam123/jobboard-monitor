import { describe, expect, it } from 'vitest';
import {
  COMPLETE_SCAN_HISTORY_LIMIT,
  computeTracking,
  diffFields,
  type TrackingContext,
} from '../../src/core/changes.js';
import { snapshotSchema, type Snapshot } from '../../src/schemas/snapshot.js';
import type { CompanyScanResult } from '../../src/schemas/result.js';
import { failedScan, job, scan } from './helpers.js';

/** Fail loudly instead of using a non-null assertion. */
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

let runCounter = 0;
function ctxAt(day: number): TrackingContext {
  runCounter += 1;
  return {
    runId: `run-${runCounter}`,
    scanAt: new Date(Date.UTC(2026, 9, 12 + day)).toISOString(),
    removedRetentionDays: 90,
  };
}

/** Apply a sequence of scans, threading the snapshot through like real runs do. */
function runSequence(scans: CompanyScanResult[], start: Snapshot | null = null) {
  let snapshot = start;
  return scans.map((s, day) => {
    const decision = computeTracking(snapshot, s, ctxAt(day));
    if (decision.next) snapshot = snapshotSchema.parse(decision.next); // must stay schema-valid
    return { decision, snapshot };
  });
}

const kinds = (d: { changes: { kind: string; jobId: string }[] }) =>
  d.changes.map((c) => `${c.kind} ${c.jobId.split(':').pop() ?? ''}`);

const stateOf = (snapshot: Snapshot | null, id: string) =>
  snapshot?.jobs.find((j) => j.listing.id === `greenhouse:acme:${id}`);

describe('NEW detection', () => {
  it('the first complete scan is a baseline where every job is NEW', () => {
    const [first] = runSequence([scan([job('1'), job('2')])]);
    expect(first?.decision.baseline).toBe(true);
    expect(kinds(must(first).decision)).toEqual(['NEW 1', 'NEW 2']);
    expect(first?.snapshot?.jobs).toHaveLength(2);
  });

  it('a posting that appears later is NEW and keeps its own firstSeenAt', () => {
    const [, second] = runSequence([scan([job('1')]), scan([job('1'), job('2')])]);
    expect(second?.decision.baseline).toBe(false);
    expect(kinds(must(second).decision)).toEqual(['NEW 2']);
    const first = second?.decision.listings.find((l) => l.id.endsWith(':1'));
    const added = second?.decision.listings.find((l) => l.id.endsWith(':2'));
    expect(first?.firstSeenAt).toBe('2026-10-12T00:00:00.000Z'); // restored from snapshot
    expect(added?.firstSeenAt).toBe(added?.lastSeenAt);
  });
});

describe('UPDATED detection', () => {
  it('reports exactly which tracked fields changed', () => {
    const [, second] = runSequence([
      scan([job('1')]),
      scan([job('1', { title: 'Senior Job 1', location: null })]),
    ]);
    expect(kinds(must(second).decision)).toEqual(['UPDATED 1']);
    expect(second?.decision.changes[0]?.fieldChanges).toEqual([
      { field: 'title', before: 'Job 1', after: 'Senior Job 1' },
      { field: 'location', before: 'Austin, Texas', after: null },
    ]);
    expect(stateOf(must(second).snapshot, '1')?.listing.title).toBe('Senior Job 1');
  });

  it('unchanged listings produce no changes, even though observation timestamps differ', () => {
    const later = '2026-10-20T00:00:00.000Z';
    const [, second] = runSequence([
      scan([job('1')]),
      scan([job('1', { firstSeenAt: later, lastSeenAt: later })]),
    ]);
    expect(second?.decision.changes).toEqual([]);
  });

  it('ignores provider dates and a description hash appearing or disappearing', () => {
    const hash = 'a'.repeat(64);
    expect(
      diffFields(
        job('1'),
        job('1', { descriptionHash: hash, providerUpdatedAt: '2026-10-13T00:00:00.000Z' }),
      ),
    ).toEqual([]);
    expect(
      diffFields(
        job('1', { descriptionHash: hash }),
        job('1', { descriptionHash: 'b'.repeat(64) }),
      ),
    ).toEqual([{ field: 'descriptionHash', before: hash, after: 'b'.repeat(64) }]);
  });
});

describe('removal policy', () => {
  it('a job missing from one complete scan is only POSSIBLY_REMOVED', () => {
    const [, second] = runSequence([scan([job('1'), job('2')]), scan([job('1')])]);
    expect(kinds(must(second).decision)).toEqual(['POSSIBLY_REMOVED 2']);
    expect(stateOf(must(second).snapshot, '2')).toMatchObject({
      state: 'POSSIBLY_REMOVED',
      missedCompleteScans: 1,
      removedAt: null,
    });
  });

  it('a job missing from two consecutive complete scans is REMOVED', () => {
    const results = runSequence([scan([job('1'), job('2')]), scan([job('1')]), scan([job('1')])]);
    const third = must(results[2]);
    expect(kinds(third.decision)).toEqual(['REMOVED 2']);
    expect(stateOf(third.snapshot, '2')).toMatchObject({
      state: 'REMOVED',
      missedCompleteScans: 2,
    });
    expect(stateOf(third.snapshot, '2')?.removedAt).toBe(third.snapshot?.updatedAt);
  });

  it('REMOVED is reported once, not on every later scan', () => {
    const results = runSequence([
      scan([job('1'), job('2')]),
      scan([job('1')]),
      scan([job('1')]),
      scan([job('1')]),
    ]);
    expect(results[3]?.decision.changes).toEqual([]);
  });

  it('absences must be consecutive: reappearing resets the counter', () => {
    const results = runSequence([
      scan([job('1'), job('2')]),
      scan([job('1')]), // missed once
      scan([job('1'), job('2')]), // back: becomes ACTIVE again, no change event
      scan([job('1')]), // missed once again, not twice
    ]);
    expect(results[2]?.decision.changes).toEqual([]);
    expect(stateOf(must(results[2]).snapshot, '2')?.state).toBe('ACTIVE');
    expect(kinds(must(results[3]).decision)).toEqual(['POSSIBLY_REMOVED 2']);
  });

  it('a REMOVED job that comes back is NEW with reappeared=true and keeps firstSeenAt', () => {
    const results = runSequence([
      scan([job('1'), job('2')]),
      scan([job('1')]),
      scan([job('1')]),
      scan([job('1'), job('2')]),
    ]);
    const back = must(results[3]).decision.changes[0];
    expect(back).toMatchObject({ kind: 'NEW', reappeared: true });
    expect(back?.listing.firstSeenAt).toBe('2026-10-12T00:00:00.000Z');
    expect(stateOf(must(results[3]).snapshot, '2')).toMatchObject({
      state: 'ACTIVE',
      missedCompleteScans: 0,
    });
  });

  it('prunes REMOVED jobs after the retention period', () => {
    const [, , removed] = runSequence([
      scan([job('1'), job('2')]),
      scan([job('1')]),
      scan([job('1')]),
    ]);
    const later = computeTracking(must(removed).snapshot, scan([job('1')]), {
      runId: 'later',
      scanAt: '2027-03-01T00:00:00.000Z',
      removedRetentionDays: 90,
    });
    expect(later.next?.jobs.map((j) => j.listing.id)).toEqual(['greenhouse:acme:1']);
    expect(later.changes).toEqual([]);
  });

  it('warns when a complete scan makes most active jobs disappear', () => {
    const many = Array.from({ length: 12 }, (_, i) => job(String(i + 1)));
    const [, second] = runSequence([scan(many), scan(many.slice(0, 3))]);
    expect(second?.decision.warnings).toEqual([
      '9 of 12 previously active jobs are missing from this scan; verify the board before trusting removals',
    ]);
  });
});

describe('untrustworthy scans never modify history', () => {
  it.each(['NAVIGATION_TIMEOUT', 'ACCESS_DENIED', 'SUSPICIOUS_EMPTY'] as const)(
    'a %s scan yields no changes and no snapshot to write',
    (category) => {
      const [first, second] = runSequence([scan([job('1'), job('2')]), failedScan(category)]);
      expect(second?.decision.changes).toEqual([]);
      expect(second?.decision.next).toBeNull();
      expect(second?.decision.notAdvancedReason).toMatch(new RegExp(category, 'u'));
      expect(second?.snapshot).toBe(first?.snapshot); // unchanged object
    },
  );

  it('failed scans do not count toward removal', () => {
    const results = runSequence([
      scan([job('1'), job('2')]),
      scan([job('1')]), // complete miss #1
      failedScan('NAVIGATION_TIMEOUT'),
      failedScan('NAVIGATION_TIMEOUT'),
    ]);
    expect(stateOf(must(results[3]).snapshot, '2')).toMatchObject({
      state: 'POSSIBLY_REMOVED',
      missedCompleteScans: 1,
    });
  });

  it('an incomplete scan reports visible NEW/UPDATED but no removals, and does not advance', () => {
    const [, second] = runSequence([
      scan([job('1'), job('2')]),
      scan([job('1', { title: 'Renamed' }), job('3')], { complete: false }),
    ]);
    expect(kinds(must(second).decision)).toEqual(['NEW 3', 'UPDATED 1']);
    expect(second?.decision.removalsEvaluated).toBe(false);
    expect(second?.decision.next).toBeNull();
    expect(second?.decision.notAdvancedReason).toBe('scan incomplete; removals not evaluated');
  });

  it('an empty but complete scan (board says 0 jobs) is trusted, with removal still needing two scans', () => {
    const [, second] = runSequence([scan([job('1')]), scan([], { expectedCount: 0 })]);
    expect(kinds(must(second).decision)).toEqual(['POSSIBLY_REMOVED 1']);
  });
});

describe('snapshot bookkeeping', () => {
  it('keeps a bounded history of complete scans and sorted jobs', () => {
    const scans = Array.from({ length: COMPLETE_SCAN_HISTORY_LIMIT + 5 }, () =>
      scan([job('2'), job('1')]),
    );
    const results = runSequence(scans);
    const last = must(must(results.at(-1)).snapshot);
    expect(last.completeScans).toHaveLength(COMPLETE_SCAN_HISTORY_LIMIT);
    expect(last.jobs.map((j) => j.listing.id)).toEqual(['greenhouse:acme:1', 'greenhouse:acme:2']);
    expect(last.createdAt).toBe(must(must(results[0]).snapshot).createdAt);
  });
});
