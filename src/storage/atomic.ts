import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

/**
 * Write to a temporary file in the same directory, then rename over the target.
 * A rename within one filesystem is atomic, so readers see either the old file
 * or the complete new file — never a half-written one.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  return writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
