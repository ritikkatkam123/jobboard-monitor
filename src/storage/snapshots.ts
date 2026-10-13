import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotSchema, type Snapshot } from '../schemas/snapshot.js';
import { writeJsonAtomic } from './atomic.js';

export type SnapshotRead =
  | { kind: 'missing'; path: string }
  | { kind: 'ok'; path: string; snapshot: Snapshot }
  /** Present but unusable. Callers must leave the file alone rather than overwrite it. */
  | { kind: 'corrupt'; path: string; reason: string };

export function snapshotPath(stateDir: string, companyId: string): string {
  return join(stateDir, 'snapshots', `${companyId}.json`);
}

export async function readSnapshot(stateDir: string, companyId: string): Promise<SnapshotRead> {
  const path = snapshotPath(stateDir, companyId);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', path };
    return { kind: 'corrupt', path, reason: `cannot read file: ${(err as Error).message}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: 'corrupt', path, reason: 'file is not valid JSON' };
  }

  const parsed = snapshotSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return {
      kind: 'corrupt',
      path,
      reason: `invalid snapshot at ${where}: ${issue?.message ?? ''}`,
    };
  }
  if (parsed.data.companyId !== companyId) {
    return {
      kind: 'corrupt',
      path,
      reason: `snapshot belongs to company "${parsed.data.companyId}", expected "${companyId}"`,
    };
  }
  return { kind: 'ok', path, snapshot: parsed.data };
}

export async function writeSnapshot(stateDir: string, snapshot: Snapshot): Promise<string> {
  const path = snapshotPath(stateDir, snapshot.companyId);
  await writeJsonAtomic(path, snapshot);
  return path;
}
