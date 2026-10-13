import type { CompanyConfig } from '../schemas/config.js';
import type { CompanyScanResult } from '../schemas/result.js';
import { greenhouseAdapter } from './greenhouse/adapter.js';
import type { AdapterRunOptions, CareerSiteAdapter } from './types.js';

type Provider = CompanyConfig['provider'];
type CompanyFor<P extends Provider> = Extract<CompanyConfig, { provider: P }>;

/**
 * One adapter per provider. The mapped type makes the compiler fail if a provider
 * is added to the config schema without a matching adapter here.
 */
const ADAPTERS: { [P in Provider]: CareerSiteAdapter<CompanyFor<P>> } = {
  greenhouse: greenhouseAdapter,
};

// With more than one provider, TypeScript will need a cast here because it cannot
// correlate `company.provider` with the matching map entry.
const adapterFor = (company: CompanyConfig) => ADAPTERS[company.provider];

export function collectCompany(
  company: CompanyConfig,
  options: AdapterRunOptions,
): Promise<CompanyScanResult> {
  return adapterFor(company).collect(company, options);
}

export function sourceUrlFor(company: CompanyConfig): string {
  return adapterFor(company).sourceUrl(company);
}
