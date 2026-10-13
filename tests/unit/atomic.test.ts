import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic, writeJsonAtomic } from '../../src/storage/atomic.js';

describe('writeFileAtomic', () => {
  it('creates parent directories, writes, and overwrites without leftover temp files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jbm-atomic-'));
    const path = join(dir, 'nested', 'state.json');
    await writeJsonAtomic(path, { a: 1 });
    await writeJsonAtomic(path, { a: 2 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ a: 2 });
    expect(await readdir(join(dir, 'nested'))).toEqual(['state.json']);
  });

  it('cleans up its temp file when the final rename fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jbm-atomic-'));
    const target = join(dir, 'occupied');
    await mkdir(join(target, 'child'), { recursive: true }); // a non-empty directory cannot be replaced
    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['occupied']);
  });
});
