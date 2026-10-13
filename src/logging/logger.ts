import { randomBytes } from 'node:crypto';
import { pino, type Logger } from 'pino';

export type { Logger };

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Structured JSON logs on stderr, so stdout stays free for the human summary.
 * No secrets are needed for public boards; the redact list is a safety net.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  return pino(
    {
      level,
      redact: { paths: ['*.authorization', '*.cookie', '*.password', '*.token'], remove: true },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination(2),
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** Sortable, unique-enough run ID, e.g. `20261012T153000Z-a1b2c3`. */
export function createRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}
