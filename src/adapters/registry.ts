import type { CompanyConfig } from '../schemas/config.js';
import type { CompanyScanResult } from '../schemas/result.js';
import { greenhouseAdapter } from './greenhouse/adapter.js';
import { leverAdapter } from './lever/adapter.js';
import type { AdapterRunOptions, CareerSiteAdapter } from './types.js';

type Provider = CompanyConfig['provider'];
type CompanyFor<P extends Provider> = Extract<CompanyConfig, { provider: P }>;

/**
 * One adapter per provider. The mapped type makes the compiler fail if a provider
 * is added to the config schema without a matching adapter here.
 */
const ADAPTERS: { [P in Provider]: CareerSiteAdapter<CompanyFor<P>> } = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
};

function adapterFor<C extends CompanyConfig>(company: C): CareerSiteAdapter<C> {
  // TypeScript cannot connect `company.provider` to the matching map entry, so this cast
  // is needed; the mapped type above guarantees every provider has the right adapter.
  return ADAPTERS[company.provider] as unknown as CareerSiteAdapter<C>;
}

export function collectCompany(
  company: CompanyConfig,
  options: AdapterRunOptions,
): Promise<CompanyScanResult> {
  return adapterFor(company).collect(company, options);
}

export function sourceUrlFor(company: CompanyConfig): string {
  return adapterFor(company).sourceUrl(company);
}
