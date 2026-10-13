# CLAUDE.md — JobBoard Monitor

TypeScript CLI that collects public job postings with Playwright. No web server,
no database, no frontend. See `docs/PROJECT_PLAN.md` for architecture and phases.

## Commands

```bash
npm ci                         # install from lockfile
npx playwright install chromium
npm run lint                   # ESLint
npm run format:check           # Prettier (npm run format to fix)
npm run typecheck              # tsc --noEmit
npm run test:unit              # Vitest, tests/unit
npm run test:integration       # Playwright Test, tests/integration (no network)
npm test                       # unit + integration
npm run test:live              # OPT-IN real-site smoke test (network)
npm run check                  # lint + format:check + typecheck + all deterministic tests
npm run monitor -- --help      # CLI
```

## Conventions

- ESM + `module: NodeNext`: relative imports use the `.js` suffix.
- Strict TypeScript. No `any`; use `unknown` and Zod to narrow external data.
- Site-specific code stays in `src/adapters/<provider>/`. `src/core/` must never
  import Playwright.
- Optional data is `null`, never an invented value or empty string.
- Scrape timestamps (`firstSeenAt`, `lastSeenAt`) are never part of change comparison.
- Logs go to stderr as JSON (Pino); human summaries go to stdout.
- Atomic file writes only (`src/storage/atomic.ts`).
- `output/` (reports, diagnostics) and `state/` (snapshots) are gitignored. Tests must point
  `outputDir`/`stateDir` at `testInfo.outputPath()` or a temp dir — never the project folders.
- Change-detection rules live in `src/core/changes.ts` (pure); file I/O in
  `src/storage/snapshots.ts`; wiring in `src/scan/track-company.ts`.

## Testing rules

- The default suite must not touch the network. Integration tests serve fixtures via
  `context.route` and abort everything else.
- Fixtures are fictional data in the observed page structure. Never commit real
  scraped listings.
- No automatic retries in Playwright config — a flaky test is a bug to fix.
- Never treat an extraction failure as an empty result in code or tests.
- Do not claim tests pass without running them; do not invent selectors — inspect
  the real page first and record what was observed in `docs/PROJECT_PLAN.md`.

## Responsible use

Public boards only. No login, no CAPTCHA solving, no anti-bot evasion, no
application submission. On 401/403, record `ACCESS_DENIED` and stop.

## Git

Do not commit, push, or publish on the user's behalf.
