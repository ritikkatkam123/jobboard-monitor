import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT, runCli } from '../../src/cli/program.js';
import {
  summarize,
  type CompanyRunResult,
  type RunResult,
  type RunScanOptions,
} from '../../src/scan/run-scan.js';
import type { SnapshotAction } from '../../src/scan/track-company.js';

type FakeOutcome = CompanyRunResult['status'] | 'SNAPSHOT_ERROR';

let dir: string;
let configPath: string;
let out: string;
let err: string;
const io = {
  out: (t: string) => {
    out += t;
  },
  err: (t: string) => {
    err += t;
  },
};

function company(id: string, outcome: FakeOutcome): CompanyRunResult {
  const status = outcome === 'SNAPSHOT_ERROR' ? 'SUCCESS' : outcome;
  const snapshotAction: SnapshotAction =
    outcome === 'SNAPSHOT_ERROR' ? 'ERROR' : status === 'SUCCESS' ? 'ADVANCED' : 'NOT_ADVANCED';
  return {
    companyId: id,
    companyName: id,
    adapter: 'greenhouse',
    sourceUrl: `https://job-boards.greenhouse.io/${id}`,
    status,
    complete: status === 'SUCCESS',
    expectedCount: 0,
    rawCount: 0,
    pagesVisited: 1,
    duplicateCount: 0,
    durationMs: 1,
    listings: [],
    rejected: [],
    warnings: [],
    error:
      status === 'SUCCESS'
        ? null
        : { category: 'HTTP_ERROR', message: 'HTTP 500', httpStatus: 500 },
    diagnostics: [],
    tracking: {
      snapshotAction,
      snapshotPath: `state/snapshots/${id}.json`,
      reason: snapshotAction === 'ADVANCED' ? null : 'test',
      baseline: false,
      removalsEvaluated: status === 'SUCCESS',
      changes: [],
      counts: { new: 0, updated: 0, possiblyRemoved: 0, removed: 0 },
      warnings: [],
    },
  };
}

function fakeRunScan(statuses: Record<string, FakeOutcome> = {}) {
  return vi.fn((opts: RunScanOptions): Promise<RunResult> => {
    const companies = opts.companies.map((c) => company(c.id, statuses[c.id] ?? 'SUCCESS'));
    return Promise.resolve({
      runId: opts.runId,
      dataSource: 'live',
      startedAt: '2026-10-12T00:00:00.000Z',
      finishedAt: '2026-10-12T00:00:01.000Z',
      durationMs: 1000,
      filters: opts.filter,
      summary: summarize(companies, 0, 0),
      dryRun: opts.dryRun ?? false,
      companies,
      matchedListings: [],
      matchedChanges: [],
    });
  });
}

beforeEach(async () => {
  out = '';
  err = '';
  dir = await mkdtemp(join(tmpdir(), 'jbm-cli-'));
  configPath = join(dir, 'companies.json');
  await writeFile(
    configPath,
    JSON.stringify({
      settings: { outputDir: join(dir, 'output') },
      companies: [
        { id: 'acme', name: 'Acme', provider: 'greenhouse', boardToken: 'acme' },
        { id: 'beta', name: 'Beta', provider: 'greenhouse', boardToken: 'beta' },
        { id: 'off', name: 'Off', provider: 'greenhouse', boardToken: 'off', enabled: false },
      ],
    }),
  );
});

describe('argument validation', () => {
  it('--help exits 0', async () => {
    expect(await runCli(['--help'], { io })).toBe(EXIT.OK);
    expect(out).toContain('validate-config');
    expect(out).toContain('scan');
  });

  it.each([
    [['bogus-command']],
    [['scan', '--not-an-option']],
    [['scan', '--keyword']],
    [['scan', '--keyword', '   ']],
    [['--log-level', 'loud', 'validate-config']],
  ])('%j is a usage error (exit 2) and never scans', async (argv) => {
    const runScan = fakeRunScan();
    expect(await runCli(['-c', configPath, ...argv], { io, runScan })).toBe(EXIT.USAGE);
    expect(runScan).not.toHaveBeenCalled();
    expect(err).not.toBe('');
  });

  it('an unknown --company lists the configured IDs', async () => {
    const runScan = fakeRunScan();
    expect(await runCli(['-c', configPath, 'scan', '--company', 'nope'], { io, runScan })).toBe(
      EXIT.USAGE,
    );
    expect(err).toContain('Unknown company id: nope. Configured: acme, beta, off');
    expect(runScan).not.toHaveBeenCalled();
  });
});

describe('validate-config', () => {
  it('reports a valid config', async () => {
    expect(await runCli(['-c', configPath, 'validate-config'], { io })).toBe(EXIT.OK);
    expect(out).toContain('Configuration OK: 3 companies (2 enabled)');
  });

  it('lists every problem in an invalid config and exits 2', async () => {
    await writeFile(configPath, JSON.stringify({ companies: [{ id: 'x', provider: 'lever' }] }));
    expect(await runCli(['-c', configPath, 'validate-config'], { io })).toBe(EXIT.USAGE);
    expect(err).toContain('Error: Configuration is invalid');
    expect(err).toContain('companies.0.provider: unsupported provider');
  });
});

describe('scan', () => {
  it('scans enabled companies by default and passes filters through', async () => {
    const runScan = fakeRunScan();
    const code = await runCli(
      [
        '-c',
        configPath,
        '--log-level',
        'silent',
        'scan',
        '--keyword',
        'QA',
        '--keyword',
        'SDET',
        '--location',
        'Texas',
      ],
      { io, runScan },
    );
    expect(code).toBe(EXIT.OK);
    const opts = runScan.mock.calls[0]?.[0];
    expect(opts?.companies.map((c) => c.id)).toEqual(['acme', 'beta']);
    expect(opts?.filter).toEqual({ keywords: ['QA', 'SDET'], locations: ['Texas'] });
  });

  it('--company selects specific companies, including disabled ones, without duplicates', async () => {
    const runScan = fakeRunScan();
    await runCli(
      [
        '-c',
        configPath,
        '--log-level',
        'silent',
        'scan',
        '--company',
        'off',
        '--company',
        'acme',
        '--company',
        'off',
      ],
      { io, runScan },
    );
    expect(runScan.mock.calls[0]?.[0].companies.map((c) => c.id)).toEqual(['off', 'acme']);
  });

  it('writes the run JSON and prints its path', async () => {
    await runCli(['-c', configPath, '--log-level', 'silent', 'scan'], {
      io,
      runScan: fakeRunScan(),
    });
    const files = await readdir(join(dir, 'output', 'runs'));
    expect(files).toHaveLength(1);
    const saved = JSON.parse(
      await readFile(join(dir, 'output', 'runs', files[0] ?? ''), 'utf8'),
    ) as {
      schemaVersion: number;
      companies: unknown[];
    };
    expect(saved.schemaVersion).toBe(1);
    expect(saved.companies).toHaveLength(2);
    expect(out).toContain(`Full results: ${join(dir, 'output', 'runs', files[0] ?? '')}`);
  });

  it('exits 1 when any company fails, while still writing results', async () => {
    const code = await runCli(['-c', configPath, '--log-level', 'silent', 'scan'], {
      io,
      runScan: fakeRunScan({ beta: 'FAILED' }),
    });
    expect(code).toBe(EXIT.RUN_UNSUCCESSFUL);
    expect(out).toContain('[FAIL] beta');
    expect(out).toContain('[OK  ] acme');
  });

  it('exits 1 when a snapshot could not be read or written', async () => {
    const code = await runCli(['-c', configPath, '--log-level', 'silent', 'scan'], {
      io,
      runScan: fakeRunScan({ acme: 'SNAPSHOT_ERROR' }),
    });
    expect(code).toBe(EXIT.RUN_UNSUCCESSFUL);
    expect(out).toContain('snapshot: ERROR');
  });

  it('--dry-run and --state-dir are passed through', async () => {
    const runScan = fakeRunScan();
    await runCli(
      [
        '-c',
        configPath,
        '--log-level',
        'silent',
        'scan',
        '--dry-run',
        '--state-dir',
        join(dir, 's'),
      ],
      { io, runScan },
    );
    const opts = runScan.mock.calls[0]?.[0];
    expect(opts?.dryRun).toBe(true);
    expect(opts?.config.settings.stateDir).toBe(join(dir, 's'));
    expect(out).toContain('dry run: snapshots not saved');
  });

  it('a missing config file is a usage error', async () => {
    expect(await runCli(['-c', join(dir, 'missing.json'), 'scan'], { io })).toBe(EXIT.USAGE);
    expect(err).toContain('Config file not found');
  });
});
