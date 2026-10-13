import { join } from 'node:path';
import type { RunResult } from '../scan/run-scan.js';
import { writeJsonAtomic } from '../storage/atomic.js';

export const RUN_RESULT_SCHEMA_VERSION = 1;

/** Write the full machine-readable run result to `<outputDir>/runs/<runId>.json`. */
export async function writeRunJson(outputDir: string, run: RunResult): Promise<string> {
  const path = join(outputDir, 'runs', `${run.runId}.json`);
  await writeJsonAtomic(path, { schemaVersion: RUN_RESULT_SCHEMA_VERSION, ...run });
  return path;
}
