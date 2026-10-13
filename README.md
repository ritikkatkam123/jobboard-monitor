# JobBoard Monitor

> **Status: Phase 2 of 7 (work in progress).** This README documents only what is
> implemented today. CSV/HTML reports, retries, a Lever adapter, and CI are planned —
> see [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md).

A TypeScript command-line tool that uses Playwright to collect **public** job postings
from company career boards, normalize them into one validated format, and track which
jobs are new, updated, or removed between runs.

Currently supported: **Greenhouse hosted boards** (`job-boards.greenhouse.io/<token>`).

## Requirements

- Node.js 22+
- npm

## Setup

```bash
npm ci
npx playwright install chromium
```

## Configuration

`config/companies.json`:

```json
{
  "settings": {
    "requestDelayMs": 1000,
    "navigationTimeoutMs": 30000,
    "maxPagesPerBoard": 40,
    "outputDir": "output",
    "stateDir": "state",
    "removedRetentionDays": 90
  },
  "companies": [
    { "id": "gitlab", "name": "GitLab", "provider": "greenhouse", "boardToken": "gitlab" }
  ]
}
```

- `boardToken` is the part after `job-boards.greenhouse.io/`. URLs are never accepted
  in config; the tool builds them itself.
- `enabled` (default `true`) controls whether a company is included in a plain `scan`.
- Companies whose Greenhouse board redirects to their own careers site are not supported
  and fail with `UNEXPECTED_REDIRECT`.

## Commands

```bash
npm run monitor -- validate-config
npm run monitor -- scan
npm run monitor -- scan --company gitlab
npm run monitor -- scan --keyword "software engineer" --keyword sdet
npm run monitor -- scan --location "Texas"
npm run monitor -- scan --dry-run
npm run monitor -- --help
```

| Option                | Meaning                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| `-c, --config <path>` | Config file (default `config/companies.json`)                                |
| `--log-level <level>` | `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, `silent`       |
| `--company <id>`      | Scan only this company; repeatable; runs even if `enabled: false`            |
| `--keyword <text>`    | Keep titles containing the text (case-insensitive); repeatable, any match    |
| `--location <text>`   | Keep locations containing the text (case-insensitive); repeatable, any match |
| `--output-dir <dir>`  | Override `settings.outputDir` (run results, diagnostics)                     |
| `--state-dir <dir>`   | Override `settings.stateDir` (snapshots)                                     |
| `--dry-run`           | Detect changes but do not save snapshots                                     |

Filters change only what is reported, never what is collected. Listings without a
location never match `--location`.

`scan` prints a summary to stdout, JSON logs to stderr, and writes the full result to
`output/runs/<runId>.json`. Failure screenshots and HTML go to
`output/diagnostics/<runId>/`. Snapshots are saved to `state/snapshots/<companyId>.json`.

## Snapshots and change tracking

After each company is scanned, its result is compared with that company's last snapshot:

| Change             | Meaning                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `NEW`              | Job ID not seen before (or seen before but confirmed removed — flagged `reappeared`)                            |
| `UPDATED`          | A tracked field changed: title, URL, location, department, employment type, workplace type, or description hash |
| `POSSIBLY_REMOVED` | Missing from one complete scan                                                                                  |
| `REMOVED`          | Missing from **two consecutive complete scans** (reported once)                                                 |

Safety rules:

- **Failed or blocked scans** (timeouts, HTTP errors, redirects, suspicious empty pages) report
  no changes and never modify the snapshot.
- **Incomplete scans** report `NEW`/`UPDATED` for what was visible but do not evaluate
  removals and do not save the snapshot, so those changes are re-checked on the next run.
  Failed and incomplete scans neither count toward removal nor reset the counter.
- A job that reappears before removal is confirmed simply becomes active again.
- Observation timestamps (`firstSeenAt`, `lastSeenAt`) and provider dates never count as an update.
- The first complete scan of a company is a **baseline**: every job is `NEW`, and the console
  summary shows a count instead of listing them.
- An unreadable snapshot is **never overwritten**. That company reports `snapshot: ERROR` and the
  run exits 1 until the file is fixed or moved away (which starts a new baseline).
- Snapshots are written atomically (temp file + rename), one company at a time.
- Confirmed-removed jobs are pruned after `removedRetentionDays`.
- A warning is shown when one complete scan makes at least half of a board's active jobs (10+)
  disappear.
- Two runs at the same time against the same `state/` folder are not coordinated yet; don't do that.

Filters (`--keyword`, `--location`) only narrow what is printed; snapshots always store the
full unfiltered board.

### Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Every attempted company succeeded                                                   |
| 1    | Run finished, but at least one company failed, was blocked, or had a snapshot error |
| 2    | Invalid arguments or configuration (nothing scraped)                                |
| 3    | Unexpected internal error                                                           |

A company that succeeds but is **incomplete** (row count does not match the board's own
count, or rows were rejected) still exits 0 and is flagged `WARN` in the summary.

## Testing

```bash
npm run test:unit          # Vitest: pure logic
npm run test:integration   # Playwright: adapter vs. local fixtures, network blocked
npm test                   # both
npm run test:live          # OPT-IN: real Greenhouse board (network required)
npm run check              # lint + format + typecheck + unit + integration
```

## Responsible use

Public boards only. No login, CAPTCHA solving, anti-bot evasion, or job applications.
HTTP 401/403/429 are recorded as `BLOCKED` and not retried. Requests are sequential with
a delay between pages, and images/fonts/media are not downloaded.

## License

MIT
