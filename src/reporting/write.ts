import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunResult } from '../scan/run-scan.js';
import { writeFileAtomic, writeJsonAtomic } from '../storage/atomic.js';
import { renderJobsCsv } from './csv.js';
import { renderHtmlReport } from './html.js';

/** Bumped from 1 when reports moved into a folder per run (Phase 4). */
export const RUN_RESULT_SCHEMA_VERSION = 2;

export interface ReportPaths {
  dir: string;
  json: string;
  csv: string;
  html: string;
}

export function runDir(outputDir: string, runId: string): string {
  return join(outputDir, 'runs', runId);
}

const latestPointerSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  dir: z.string().min(1),
  dataSource: z.enum(['live', 'demo']),
  finishedAt: z.string(),
});
export type LatestPointer = z.infer<typeof latestPointerSchema>;

/**
 * Write `run.json`, `jobs.csv`, and `report.html` into `<outputDir>/runs/<runId>/`.
 * The `latest.json` pointer is written last, so it never points at a half-written run.
 */
export async function writeReports(
  outputDir: string,
  run: RunResult,
  options: { updateLatest: boolean } = { updateLatest: true },
): Promise<ReportPaths> {
  const dir = runDir(outputDir, run.runId);
  const paths: ReportPaths = {
    dir,
    json: join(dir, 'run.json'),
    csv: join(dir, 'jobs.csv'),
    html: join(dir, 'report.html'),
  };
  await writeJsonAtomic(paths.json, { schemaVersion: RUN_RESULT_SCHEMA_VERSION, ...run });
  await writeFileAtomic(paths.csv, renderJobsCsv(run));
  await writeFileAtomic(paths.html, renderHtmlReport(run));
  if (options.updateLatest) {
    const pointer: LatestPointer = {
      schemaVersion: 1,
      runId: run.runId,
      dir,
      dataSource: run.dataSource,
      finishedAt: run.finishedAt,
    };
    await writeJsonAtomic(join(outputDir, 'latest.json'), pointer);
  }
  return paths;
}

export class ReportNotFoundError extends Error {}

/** Minimal shape check for a stored run; the file is our own output, but it may be old or edited. */
const storedRunSchema = z.looseObject({
  schemaVersion: z.literal(RUN_RESULT_SCHEMA_VERSION),
  runId: z.string(),
  dataSource: z.enum(['live', 'demo']),
  summary: z.looseObject({}),
  companies: z.array(z.looseObject({})),
  matchedListings: z.array(z.unknown()),
  matchedChanges: z.array(z.unknown()),
  filters: z.looseObject({ keywords: z.array(z.string()), locations: z.array(z.string()) }),
});

async function readJson(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ReportNotFoundError(`${what} not found: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReportNotFoundError(`${what} is not valid JSON: ${path}`);
  }
}

export async function readLatestRun(
  outputDir: string,
): Promise<{ pointer: LatestPointer; run: RunResult; paths: ReportPaths }> {
  const pointerPath = join(outputDir, 'latest.json');
  const pointerData = await readJson(pointerPath, 'No completed scan found; latest-run pointer');
  const pointer = latestPointerSchema.safeParse(pointerData);
  if (!pointer.success)
    throw new ReportNotFoundError(`Latest-run pointer is invalid: ${pointerPath}`);

  const dir = pointer.data.dir;
  const paths: ReportPaths = {
    dir,
    json: join(dir, 'run.json'),
    csv: join(dir, 'jobs.csv'),
    html: join(dir, 'report.html'),
  };
  const runData = storedRunSchema.safeParse(await readJson(paths.json, 'Run result'));
  if (!runData.success) {
    throw new ReportNotFoundError(
      `Run result has an unexpected format (written by a different version?): ${paths.json}`,
    );
  }
  // The shape check above covers what the summary formatter reads; the rest is our own output.
  return { pointer: pointer.data, run: runData.data as unknown as RunResult, paths };
}
