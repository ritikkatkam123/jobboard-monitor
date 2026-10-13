import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeTracking } from '../../src/core/changes.js';
import { silentLogger } from '../../src/logging/logger.js';
import { trackCompany, type TrackOptions } from '../../src/scan/track-company.js';
import { readSnapshot, snapshotPath, writeSnapshot } from '../../src/storage/snapshots.js';
import { failedScan, job, scan, T0 } from './helpers.js';

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'jbm-state-'));
});

function baselineSnapshot() {
  const next = computeTracking(null, scan([job('1'), job('2')]), {
    runId: 'run-1',
    scanAt: T0,
    removedRetentionDays: 90,
  }).next;
  if (next === null) throw new Error('expected a snapshot');
  return next;
}

async function writeRaw(contents: string) {
  const path = snapshotPath(stateDir, 'acme');
  await mkdir(join(stateDir, 'snapshots'), { recursive: true });
  await writeFile(path, contents);
  return path;
}

describe('readSnapshot / writeSnapshot', () => {
  it('round-trips a snapshot', async () => {
    const snapshot = baselineSnapshot();
    await writeSnapshot(stateDir, snapshot);
    expect(await readSnapshot(stateDir, 'acme')).toEqual({
      kind: 'ok',
      path: snapshotPath(stateDir, 'acme'),
      snapshot,
    });
  });

  it('reports a missing snapshot as missing, not as an error', async () => {
    expect((await readSnapshot(stateDir, 'acme')).kind).toBe('missing');
  });

  it.each([
    ['truncated JSON', '{"schemaVersion": 1, "jobs": [', 'file is not valid JSON'],
    ['wrong shape', '{"hello": "world"}', 'invalid snapshot at schemaVersion'],
    [
      'future schema version',
      JSON.stringify({ ...baselineSnapshot(), schemaVersion: 2 }),
      'invalid snapshot at schemaVersion',
    ],
    [
      'invalid job inside',
      JSON.stringify({ ...baselineSnapshot(), jobs: [{ listing: { id: 'x' }, state: 'ACTIVE' }] }),
      'invalid snapshot at jobs.0',
    ],
    [
      'another company',
      JSON.stringify({ ...baselineSnapshot(), companyId: 'other' }),
      'belongs to company "other"',
    ],
  ])('flags %s as corrupt', async (_label, contents, reason) => {
    await writeRaw(contents);
    const read = await readSnapshot(stateDir, 'acme');
    expect(read.kind).toBe('corrupt');
    expect(read.kind === 'corrupt' && read.reason).toContain(reason);
  });
});

describe('trackCompany', () => {
  const options = (overrides: Partial<TrackOptions> = {}): TrackOptions => ({
    stateDir,
    runId: 'run-2',
    scanAt: '2026-10-13T00:00:00.000Z',
    removedRetentionDays: 90,
    dryRun: false,
    logger: silentLogger(),
    ...overrides,
  });

  it('creates a baseline snapshot on the first complete scan', async () => {
    const { tracking } = await trackCompany(scan([job('1')]), options());
    expect(tracking).toMatchObject({ snapshotAction: 'CREATED', baseline: true, reason: null });
    expect((await readSnapshot(stateDir, 'acme')).kind).toBe('ok');
  });

  it('advances an existing snapshot and restores firstSeenAt on returned listings', async () => {
    await writeSnapshot(stateDir, baselineSnapshot());
    const { scan: tracked, tracking } = await trackCompany(
      scan([job('1', { firstSeenAt: '2026-10-13T00:00:00.000Z' })]),
      options(),
    );
    expect(tracking.snapshotAction).toBe('ADVANCED');
    expect(tracking.counts).toEqual({ new: 0, updated: 0, possiblyRemoved: 1, removed: 0 });
    expect(tracked.listings[0]?.firstSeenAt).toBe(T0);
  });

  it('leaves the snapshot file byte-for-byte unchanged after a failed scan', async () => {
    const path = snapshotPath(stateDir, 'acme');
    await writeSnapshot(stateDir, baselineSnapshot());
    const before = await readFile(path, 'utf8');
    const { tracking } = await trackCompany(failedScan('NAVIGATION_TIMEOUT'), options());
    expect(tracking).toMatchObject({ snapshotAction: 'NOT_ADVANCED', changes: [] });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('never overwrites a corrupt snapshot, and reports an ERROR', async () => {
    const path = await writeRaw('{ not json');
    const { tracking } = await trackCompany(scan([job('1')]), options());
    expect(tracking.snapshotAction).toBe('ERROR');
    expect(tracking.reason).toContain('left untouched');
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });

  it('dry run computes changes without writing', async () => {
    const { tracking } = await trackCompany(scan([job('1')]), options({ dryRun: true }));
    expect(tracking).toMatchObject({ snapshotAction: 'NOT_ADVANCED', reason: 'dry run' });
    expect(tracking.counts.new).toBe(1);
    expect((await readSnapshot(stateDir, 'acme')).kind).toBe('missing');
  });

  it('a write failure is an ERROR and keeps the previous snapshot', async () => {
    const path = snapshotPath(stateDir, 'acme');
    await writeSnapshot(stateDir, baselineSnapshot());
    const before = await readFile(path, 'utf8');
    await chmod(join(stateDir, 'snapshots'), 0o500); // read-only directory
    try {
      const { tracking } = await trackCompany(scan([job('3')]), options());
      expect(tracking.snapshotAction).toBe('ERROR');
      expect(tracking.reason).toMatch(/^could not write snapshot/u);
    } finally {
      await chmod(join(stateDir, 'snapshots'), 0o700);
    }
    expect(await readFile(path, 'utf8')).toBe(before);
  });
});
