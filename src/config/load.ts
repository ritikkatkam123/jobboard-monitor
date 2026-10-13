import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema, type AppConfig } from '../schemas/config.js';

export const DEFAULT_CONFIG_PATH = 'config/companies.json';

/** A configuration problem the user can fix. The CLI maps this to exit code 2. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

export function parseConfig(data: unknown): AppConfig {
  const result = configSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError('Configuration is invalid', formatIssues(result.error));
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(
      code === 'ENOENT' ? `Config file not found: ${path}` : `Cannot read config file: ${path}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file is not valid JSON: ${path}`, [(err as Error).message]);
  }
  return parseConfig(data);
}
