# Test strategy

## Goals

1. **The default suite never depends on a third-party site being up.** It runs offline and
   gives the same answer every time.
2. **Failures stay visible.** Playwright retries are `0`; a flaky test is a bug to fix, not to
   retry away.
3. **Test behavior, not line counts.** Tests assert outcomes a user would care about — "a
   timeout must not mark every job as removed" — rather than chasing a coverage number. No
   coverage percentage is claimed anywhere in this project.

## Three layers

| Layer                    | Tool            | Command                    | Network     | What it proves                                                                                                                                              |
| ------------------------ | --------------- | -------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**                 | Vitest          | `npm run test:unit`        | none        | Pure logic in `src/core/`, schemas, URL rules, retry policy, CSV/HTML escaping, snapshot I/O, CLI argument handling                                         |
| **Integration (mocked)** | Playwright Test | `npm run test:integration` | **blocked** | Real Chromium runs the real adapters against local fixture pages; HTTP failures, timeouts, redirects, retries, tracing, multi-run change tracking, the demo |
| **Live smoke**           | Playwright Test | `npm run test:live`        | real sites  | The adapters still work against real Greenhouse and Lever boards; opt-in, never in CI                                                                       |

`npm test` runs unit + integration. `npm run check` adds lint, formatting, and the type check —
the same steps CI runs.

### How integration tests stay offline

`tests/integration/helpers.ts` installs a route on the browser context that serves fixture HTML
for exact URLs and **aborts every other request**, recording it as `unexpected`. Tests assert
that list is empty. Responses can be a sequence (e.g. `503` then `200`) to exercise retries,
or `'hang'` to simulate a server that never answers.

One subtlety: Playwright's routes do not see redirect follow-ups, so the redirect tests send
the browser to a `.invalid` host (reserved by RFC 2606, never resolves) — it cannot reach the
internet even by accident.

### How time is controlled

Retry backoff, `Retry-After`, and request spacing all take an injectable `sleep` and clock. The
`fakeClock()` helper records each requested wait and advances virtual time instantly, so tests
assert exact delays (`[1000, 2000, 4000]`) without actually waiting. Jitter takes an injectable
random source (`() => 0` in tests).

This was learned the hard way: an early version of the request-spacing test used the real
clock and failed on a heavily loaded machine — the tool correctly shortened its wait after a
slow request, and the test wrongly expected the full wait.

### Fixtures

`tests/fixtures/greenhouse/` and `tests/fixtures/lever/` contain hand-built pages with
**fictional** companies and jobs that copy the **structure** observed on the real sites
(dates and details in [PROJECT_PLAN.md §3](PROJECT_PLAN.md)). They include deliberate problem
cases: pagination, a "New" badge inside a title, tracking parameters, legacy hosts, relative
links, missing fields, Apply links, off-site links, links to other boards, duplicates, an empty
board, an empty board without its empty-state message, a count that does not match, and a
redesigned page.

### Live smoke tests

`tests/live/` checks a real board end to end. They assert structure and consistency — never
specific job titles, which change daily. The Lever test also downloads Lever's documented
public postings feed and requires the scraped posting IDs to match it exactly, an independent
check that the single-page list really is complete. Choose boards with
`LIVE_GREENHOUSE_BOARD=<token>` and `LIVE_LEVER_SITE=<site>` (defaults: `gitlab`, `spotify`).
These variables are only used by these opt-in tests, so the project has no `.env.example`.

### Diagnosing failures

- Playwright keeps a **trace** and a **screenshot** of every failing integration test
  (`trace: 'retain-on-failure'`), viewable with `npx playwright show-trace`.
- CI uploads the HTML report on every run and the traces when a test fails.
- Browser tests have a 60-second timeout so a slow machine or CI runner does not fail them by
  time alone.

### Mutation checks

During development, after each feature, key safety rules were broken on purpose — for example
"remove a job after one absence instead of two", "retry a 403", "skip HTML escaping of `<`",
"let a corrupt snapshot be overwritten" — and the suite was run to confirm it fails. Every
mutation tried was caught. One gap found this way — a completeness rule covered only by the
slower browser tests — got a fast unit test as well. This was done by hand, not with a mutation-testing tool.

## Traceability: required test cases

The 25 cases required by the project specification, and where each is tested.

| #   | Required case                             | Covered by                                                                                                                                                                |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Valid job normalization                   | `unit/normalize` "produces a schema-valid listing…"; `integration/greenhouse-adapter` "collects every page…"; `integration/lever-adapter` "collects a single-page board…" |
| 2   | Missing optional fields                   | `unit/normalize` "keeps missing optional fields as null"; Lever "missing commitment stays null" assertion                                                                 |
| 3   | Invalid titles and URLs                   | `unit/normalize` rejection table (missing/short/long/symbol-only titles, `javascript:`, unsupported hosts); `unit/url` scheme and credential checks                       |
| 4   | Duplicate postings                        | `unit/listings` dedupe tests; adapter "…duplicate rows are rejected or removed" (both providers)                                                                          |
| 5   | Tracking-query normalization              | `unit/url` "removes tracking params…"; `unit/greenhouse-urls` and `unit/lever-urls` equivalent-URL tests                                                                  |
| 6   | Keyword and location filtering            | `unit/listings` filter tests (case-insensitive, OR within a filter, AND across, missing location)                                                                         |
| 7   | New posting detection                     | `unit/changes` "first complete scan is a baseline…", "a posting that appears later is NEW…"                                                                               |
| 8   | Meaningful field changes                  | `unit/changes` "reports exactly which tracked fields changed"; `integration/run-scan` retitled job                                                                        |
| 9   | Unchanged listings                        | `unit/changes` "unchanged listings produce no changes, even though observation timestamps differ"                                                                         |
| 10  | Missing after one successful scan         | `unit/changes` "…missing from one complete scan is only POSSIBLY_REMOVED"                                                                                                 |
| 11  | Missing across required consecutive scans | `unit/changes` "…two consecutive complete scans is REMOVED", "absences must be consecutive…"; `integration/run-scan` three-run scenario                                   |
| 12  | Failed scans don't modify valid state     | `unit/changes` "untrustworthy scans never modify history"; `unit/snapshots` "byte-for-byte unchanged after a failed scan"; `integration/run-scan`                         |
| 13  | Suspicious empty results                  | Greenhouse "a non-zero count with no rows is SUSPICIOUS_EMPTY"; Lever "an empty list without the message is SUSPICIOUS_EMPTY"                                             |
| 14  | Timeouts and transient retries            | `integration/greenhouse-adapter` "a hung server becomes NAVIGATION_TIMEOUT"; `integration/greenhouse-retry`; `unit/retry`                                                 |
| 15  | Permanent access-denied                   | "HTTP 403 is BLOCKED and is requested exactly once"; retry suite "HTTP 401/403/404 is permanent"; Lever 403 test                                                          |
| 16  | One company fails, others succeed         | `integration/run-scan` "one company failing does not affect another…"; mixed-provider test                                                                                |
| 17  | Snapshot read/write and malformed files   | `unit/snapshots` round trip, missing file, corrupt-file table, "never overwrites a corrupt snapshot", write failure                                                       |
| 18  | CSV escaping and formula injection        | `unit/reports` `csvCell` tables, "keeps hostile text inside its cells"; demo checks `'=HYPERLINK(`                                                                        |
| 19  | HTML escaping                             | `unit/reports` "never emits scraped text as markup", "only links https URLs", CSP test                                                                                    |
| 20  | Invalid company configuration             | `unit/config` (unsupported provider, unsafe tokens/sites, raw URLs, duplicates, unknown keys); `unit/lever-urls` Lever config                                             |
| 21  | Unexpected or changed HTML structure      | "changed page structure fails with diagnostics" (Greenhouse); "a page without the postings list is STRUCTURE_CHANGED" (Lever)                                             |
| 22  | Stable IDs for equivalent URLs            | `unit/greenhouse-urls` and `unit/lever-urls` "…map to one stable ID"                                                                                                      |
| 23  | Partial extraction and incomplete scans   | "row count below the board count is marked incomplete"; "a failure on a later page…"; `unit/listings` completeness rules; `unit/changes` incomplete scan                  |
| 24  | CLI argument validation                   | `unit/cli` usage-error table (unknown command/option, empty values, bad log level), unknown `--company`, `report` without `--latest`                                      |
| 25  | Report from an empty but valid run        | `unit/reports` "an empty but valid run produces just the header" (CSV) and "renders an empty but valid run…" (HTML)                                                       |

Additional cases added as the implementation revealed them: the "New" badge inside Greenhouse
titles, Lever department inheritance across groups, tab reset before retries, per-host spacing
across companies, demo output isolation, and redirect detection.
