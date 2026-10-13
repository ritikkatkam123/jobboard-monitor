import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../../src/config/load.js';
import { categorizeHttpStatus, isBlockingCategory } from '../../src/browser/http-status.js';

const company = { id: 'acme', name: 'Acme', provider: 'greenhouse', boardToken: 'acme' };

function issuesOf(data: unknown): string[] {
  try {
    parseConfig(data);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected config to be invalid');
}

describe('parseConfig', () => {
  it('applies defaults for settings and enabled', () => {
    const cfg = parseConfig({ companies: [company] });
    expect(cfg.settings).toEqual({
      requestDelayMs: 1000,
      navigationTimeoutMs: 30000,
      maxPagesPerBoard: 40,
      outputDir: 'output',
      stateDir: 'state',
      removedRetentionDays: 90,
    });
    expect(cfg.companies[0]?.enabled).toBe(true);
  });

  it('explains unsupported providers', () => {
    expect(issuesOf({ companies: [{ ...company, provider: 'workday' }] })).toEqual([
      'companies.0.provider: unsupported provider; supported providers: greenhouse',
    ]);
  });

  it('does not blame the provider when a company entry is not an object', () => {
    expect(issuesOf({ companies: ['acme', null] })).toEqual([
      'companies.0: each company must be an object',
      'companies.1: each company must be an object',
    ]);
  });

  it('rejects board tokens that could change the target URL', () => {
    for (const boardToken of ['../admin', 'https://evil.example', 'a/b', 'acme?x=1', '']) {
      expect(issuesOf({ companies: [{ ...company, boardToken }] })[0]).toMatch(
        /^companies\.0\.boardToken:/u,
      );
    }
  });

  it('rejects raw URLs and unknown keys instead of silently ignoring them', () => {
    expect(issuesOf({ companies: [{ ...company, url: 'http://127.0.0.1/' }] })[0]).toMatch(
      /Unrecognized key.*url/u,
    );
  });

  it('rejects duplicate company IDs and unsafe IDs', () => {
    expect(issuesOf({ companies: [company, company] })).toEqual([
      'companies.1.id: duplicate company id "acme"',
    ]);
    expect(issuesOf({ companies: [{ ...company, id: 'Acme Corp' }] })[0]).toMatch(
      /^companies\.0\.id:/u,
    );
  });

  it('requires at least one company and sane settings', () => {
    expect(issuesOf({ companies: [] })).toEqual(['companies: at least one company is required']);
    expect(issuesOf({ settings: { requestDelayMs: 0 }, companies: [company] })[0]).toMatch(
      /^settings\.requestDelayMs:/u,
    );
  });
});

describe('loadConfig', () => {
  async function tempFile(contents: string) {
    const dir = await mkdtemp(join(tmpdir(), 'jbm-config-'));
    const path = join(dir, 'companies.json');
    await writeFile(path, contents);
    return path;
  }

  it('reports a missing file clearly', async () => {
    await expect(loadConfig('/nonexistent/companies.json')).rejects.toThrow(
      'Config file not found: /nonexistent/companies.json',
    );
  });

  it('reports malformed JSON clearly', async () => {
    const path = await tempFile('{ "companies": [ ');
    await expect(loadConfig(path)).rejects.toThrow(`Config file is not valid JSON: ${path}`);
  });

  it('loads the committed example config', async () => {
    const cfg = await loadConfig('config/companies.json');
    expect(cfg.companies.map((c) => c.id)).toContain('gitlab');
  });
});

describe('categorizeHttpStatus', () => {
  it.each([
    [200, null],
    [204, null],
    [401, 'ACCESS_DENIED'],
    [403, 'ACCESS_DENIED'],
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'HTTP_ERROR'],
    [503, 'HTTP_ERROR'],
  ])('%i -> %s', (status, category) => {
    expect(categorizeHttpStatus(status)).toBe(category);
  });

  it('only access-denied and rate-limited count as blocking', () => {
    expect(isBlockingCategory('ACCESS_DENIED')).toBe(true);
    expect(isBlockingCategory('RATE_LIMITED')).toBe(true);
    expect(isBlockingCategory('HTTP_ERROR')).toBe(false);
  });
});
