import { setTimeout as delay } from 'node:timers/promises';

/**
 * Enforces a minimum gap between navigations to the same host, across every
 * company in a run. Companies are scanned one at a time, so per-host
 * concurrency is 1; this adds spacing on top of that.
 */
export class HostThrottle {
  private readonly lastRequestAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms: number) => delay(ms),
  ) {}

  /** Wait until `host` may be contacted again, then record the request. */
  async wait(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host);
    if (last !== undefined) {
      const remaining = last + this.minIntervalMs - this.now();
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastRequestAt.set(host, this.now());
  }
}
