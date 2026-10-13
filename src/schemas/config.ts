import { z } from 'zod';

/** Company IDs become file names later (snapshots), so keep them filesystem-safe. */
const companyId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be lowercase letters, digits, or hyphens (max 63)');

/**
 * Greenhouse board token as it appears in `job-boards.greenhouse.io/<token>`.
 * We store the token, not a URL, so a config file can never point the browser
 * at an arbitrary or private-network host.
 */
const greenhouseBoardToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/, 'must contain only letters, digits, "_" or "-"');

const companyBase = {
  id: companyId,
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
};

export const greenhouseCompanySchema = z.strictObject({
  ...companyBase,
  provider: z.literal('greenhouse'),
  boardToken: greenhouseBoardToken,
});

export const SUPPORTED_PROVIDERS = ['greenhouse'] as const;

export const companySchema = z.discriminatedUnion('provider', [greenhouseCompanySchema], {
  error: (issue) =>
    typeof issue.input === 'object' && issue.input !== null
      ? `unsupported provider; supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`
      : 'each company must be an object',
});

export const settingsSchema = z.strictObject({
  /** Pause between page navigations on the same board. */
  requestDelayMs: z.number().int().min(250).max(60_000).default(1000),
  navigationTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  /** Upper bound on pages per board, so a pagination bug cannot loop forever. */
  maxPagesPerBoard: z.number().int().min(1).max(200).default(40),
  outputDir: z.string().min(1).default('output'),
  /** Snapshots (tracking state). Kept apart from reports so it can be persisted separately. */
  stateDir: z.string().min(1).default('state'),
  /** How long a confirmed-REMOVED job stays in the snapshot before it is pruned. */
  removedRetentionDays: z.number().int().min(1).max(3650).default(90),
});

export const configSchema = z
  .strictObject({
    settings: settingsSchema.prefault({}),
    companies: z.array(companySchema).min(1, 'at least one company is required'),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.companies.forEach((c, i) => {
      if (seen.has(c.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['companies', i, 'id'],
          message: `duplicate company id "${c.id}"`,
        });
      }
      seen.add(c.id);
    });
  });

export type GreenhouseCompany = z.infer<typeof greenhouseCompanySchema>;
export type CompanyConfig = z.infer<typeof companySchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type AppConfig = z.infer<typeof configSchema>;
