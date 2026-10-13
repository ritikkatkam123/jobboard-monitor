import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig } from '../config/load.js';
import { createLogger, createRunId, LOG_LEVELS, type LogLevel } from '../logging/logger.js';
import { formatRunSummary } from '../reporting/console.js';
import { writeRunJson } from '../reporting/json.js';
import {
  runScan as defaultRunScan,
  type RunScanOptions,
  type RunResult,
} from '../scan/run-scan.js';
import type { AppConfig, CompanyConfig } from '../schemas/config.js';

export const EXIT = {
  /** Every attempted company scanned successfully. */
  OK: 0,
  /** The run finished but at least one company failed, was blocked, or had a snapshot error. */
  RUN_UNSUCCESSFUL: 1,
  /** Bad arguments or invalid configuration. Nothing was scraped. */
  USAGE: 2,
  /** Unexpected internal error. */
  FATAL: 3,
} as const;

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliDeps {
  io: CliIo;
  runScan?: (options: RunScanOptions) => Promise<RunResult>;
}

class UsageError extends Error {}

interface GlobalOpts {
  config: string;
  logLevel: LogLevel;
}

interface ScanOpts {
  company: string[];
  keyword: string[];
  location: string[];
  outputDir?: string;
  stateDir?: string;
  dryRun?: boolean;
}

const collect = (value: string, previous: string[]) => [...previous, value];

function nonEmpty(label: string) {
  return (value: string, previous: string[]) => {
    if (value.trim() === '') throw new InvalidArgumentError(`${label} must not be empty.`);
    return collect(value, previous);
  };
}

export function selectCompanies(config: AppConfig, requested: string[]): CompanyConfig[] {
  if (requested.length === 0) {
    const enabled = config.companies.filter((c) => c.enabled);
    if (enabled.length === 0) throw new UsageError('No enabled companies in the configuration');
    return enabled;
  }
  const unique = [...new Set(requested)];
  const unknown = unique.filter((id) => !config.companies.some((c) => c.id === id));
  if (unknown.length > 0) {
    const known = config.companies.map((c) => c.id).join(', ');
    throw new UsageError(`Unknown company id: ${unknown.join(', ')}. Configured: ${known}`);
  }
  // Explicitly requested companies run even when disabled in config.
  return unique.map((id) => config.companies.find((c) => c.id === id)).filter((c) => c != null);
}

export function buildProgram(deps: CliDeps, setExitCode: (code: number) => void): Command {
  const { io } = deps;
  const program = new Command()
    .name('monitor')
    .description('Monitor public company career boards with Playwright.')
    .option('-c, --config <path>', 'path to the companies config file', DEFAULT_CONFIG_PATH)
    .addOption(
      new Option('--log-level <level>', 'log verbosity (logs go to stderr)')
        .choices(LOG_LEVELS)
        .default('info'),
    )
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  program
    .command('validate-config')
    .description('Validate the configuration file without contacting any website')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const config = await loadConfig(g.config);
      const enabled = config.companies.filter((c) => c.enabled).length;
      io.out(
        `Configuration OK: ${config.companies.length} companies (${enabled} enabled) in ${g.config}\n`,
      );
      setExitCode(EXIT.OK);
    });

  program
    .command('scan')
    .description('Scan configured career boards and write a run result')
    .option('--company <id>', 'scan only this company (repeatable)', nonEmpty('--company'), [])
    .option(
      '--keyword <text>',
      'keep listings whose title contains this text, case-insensitive (repeatable; any match)',
      nonEmpty('--keyword'),
      [],
    )
    .option(
      '--location <text>',
      'keep listings whose location contains this text, case-insensitive (repeatable; any match)',
      nonEmpty('--location'),
      [],
    )
    .option('--output-dir <dir>', 'override settings.outputDir from the config')
    .option('--state-dir <dir>', 'override settings.stateDir (snapshot location) from the config')
    .option('--dry-run', 'detect changes but do not save snapshots')
    .action(async (_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOpts & ScanOpts>();
      const config = await loadConfig(opts.config);
      if (opts.outputDir !== undefined) config.settings.outputDir = opts.outputDir;
      if (opts.stateDir !== undefined) config.settings.stateDir = opts.stateDir;
      const companies = selectCompanies(config, opts.company);
      const runId = createRunId();
      const run = await (deps.runScan ?? defaultRunScan)({
        config,
        companies,
        filter: { keywords: opts.keyword, locations: opts.location },
        runId,
        logger: createLogger(opts.logLevel),
        dryRun: opts.dryRun === true,
      });
      const jsonPath = await writeRunJson(config.settings.outputDir, run);
      io.out(formatRunSummary(run, jsonPath));
      // A snapshot that could not be read or written means tracking failed for that company.
      const allOk = run.companies.every(
        (c) => c.status === 'SUCCESS' && c.tracking.snapshotAction !== 'ERROR',
      );
      setExitCode(allOk ? EXIT.OK : EXIT.RUN_UNSUCCESSFUL);
    });

  return program;
}

/** Parse arguments, run the command, and return the process exit code. Never calls process.exit. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let exitCode: number = EXIT.OK;
  const program = buildProgram(deps, (code) => {
    exitCode = code;
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version are "errors" in exitOverride mode but exit 0.
      return err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    }
    if (err instanceof ConfigError) {
      deps.io.err(`Error: ${err.message}\n`);
      for (const issue of err.issues) deps.io.err(`  - ${issue}\n`);
      return EXIT.USAGE;
    }
    if (err instanceof UsageError) {
      deps.io.err(`Error: ${err.message}\n`);
      return EXIT.USAGE;
    }
    deps.io.err(
      `Fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return EXIT.FATAL;
  }
}
