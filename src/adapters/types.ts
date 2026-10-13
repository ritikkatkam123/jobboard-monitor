import type { BrowserContext } from 'playwright';
import type { HostThrottle } from '../browser/throttle.js';
import type { Logger } from '../logging/logger.js';
import type { CompanyConfig, Settings } from '../schemas/config.js';
import type { CompanyScanResult } from '../schemas/result.js';

export interface AdapterRunOptions {
  context: BrowserContext;
  settings: Settings;
  /** ISO timestamp shared by every listing observed in this run. */
  observedAt: string;
  /** Where to save screenshots/HTML on failure; null disables diagnostics. */
  diagnosticsDir: string | null;
  logger: Logger;
  /** Shared across the run so spacing applies between companies on the same host too. */
  throttle: HostThrottle;
  /** Injectable so tests do not have to wait for real delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source for retry backoff; injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Every provider implements this and returns the same normalized result shape.
 * Adapters must never throw for expected site problems — they return a result
 * with a categorized error instead.
 */
export interface CareerSiteAdapter<C extends CompanyConfig = CompanyConfig> {
  readonly name: string;
  sourceUrl(company: C): string;
  collect(company: C, options: AdapterRunOptions): Promise<CompanyScanResult>;
}
