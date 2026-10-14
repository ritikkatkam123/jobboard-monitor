# JobBoard Monitor — Project Plan

## 1. Purpose

JobBoard Monitor is a TypeScript command-line tool that uses Playwright to collect
**publicly visible** job postings from supported company career boards, normalizes
them into one validated shape, and (from Phase 2) tracks how they change between runs.

It is deliberately a CLI: no web server, no database, no frontend. State lives in
JSON files.

## 2. Environment observed at project start (2026-10-12)

| Item       | Observed                                                |
| ---------- | ------------------------------------------------------- |
| Node.js    | v22.14.0                                                |
| npm        | 10.9.2                                                  |
| git        | 2.15.0 (project folder is **not** a git repository yet) |
| Network    | Available; public career boards reachable               |
| Playwright | 1.64.0, Chromium headless shell installed               |

## 3. Provider research (real pages, not assumptions)

### Greenhouse hosted boards — inspected 2026-10-12 on `job-boards.greenhouse.io/gitlab`

- `https://boards.greenhouse.io/<token>` returns **301** to `https://job-boards.greenhouse.io/<token>`.
- Rows are **server-rendered** (present in raw HTML without JavaScript).
- Each posting is `tr.job-post > td.cell > a[href]` containing
  `p.body--medium` (title) and `p.body--metadata` (location).
- Postings are grouped by `.job-posts--table--department` with an `h3` department name.
- `[data-testid="job-count-header"]` shows the total, e.g. `221 jobs`.
- 50 rows per page. `?page=N` loads page N directly. The `Next page` button has
  `aria-disabled="true"` on the last page. 50×4 + 21 = 221, which matched the
  official Job Board API count for the same board (independent verification).
- Some titles contain a "New" badge rendered **inside** the title element
  (`p.body--medium > span.tag-container`). Found during the first live scan, when a
  title came out as `"...(AMER)New"`; the adapter now strips that element.
- An unknown board returns HTTP **404**.
- Some boards (e.g. `figma`, `airbnb`) return **302** to the company's own careers
  site. Those are **unsupported** by this adapter and must fail clearly, not be
  scraped.
- `robots.txt` on `job-boards.greenhouse.io` has no `Disallow` rules.
- Not observed: what a board with zero openings looks like. The adapter assumes the
  count header would read `0 jobs`; this is **unverified** and called out below.

### Lever hosted boards — inspected 2026-10-13 on `jobs.lever.co/{spotify,palantir,zoox,lever,demo}`

- `robots.txt` allows crawling with `Crawl-delay: 1` (our default spacing is 1 s).
- **No pagination:** every posting is on one server-rendered page (311 on Palantir).
- **No count header.** The page posting IDs matched Lever's documented postings feed
  exactly on two boards (83/83, 311/311), so the single page is the whole list.
- The feed was **not** adopted for every scan: it includes full descriptions (775 KB for
  Spotify, 5.8 MB for Palantir). It is used only by the opt-in live smoke test as an
  independent check.
- Posting: `.posting[data-qa-posting-id]` > `a.posting-title[href]` > `h5[data-qa="posting-name"]`;
  `.posting-categories` spans `.workplaceTypes` ("Hybrid&nbsp;—&nbsp;"), `.commitment`, `.location`.
  Each posting also has an Apply link (`/<site>/<id>/apply`), which is never followed.
- Groups: `.postings-group` with `.posting-category-title` (team); `.large-category-header`
  (department) appears only on the first group of each department. Lever's feed confirms
  these are `categories.department` and `categories.team`.
- **Empty board:** `.postings-wrapper` contains `p.no-postings-message` ("No job postings
  currently open."). Observed on the real `lever` and `demo` boards.
- Unknown board: HTTP **404**.

### Playwright behavior that shaped the design

Verified experimentally: `route()` handlers are **not** called for redirect
follow-up requests. Redirects are therefore detected by observing main-frame 3xx
responses and the final URL, not by route interception.

## 4. Architecture

```
src/
  cli/        Commander program, option parsing, exit codes
  config/     load + validate config file (Zod)
  schemas/    Zod schemas and domain types (JobListing, results, config)
  browser/    Chromium lifecycle, context defaults, navigation guard
  adapters/   provider collectors (greenhouse first); return raw rows + status
  core/       URL canonicalization, normalization, identity, dedup, filtering
  storage/    atomic JSON writes; snapshots (Phase 2)
  reporting/  JSON (Phase 1), CSV + HTML (Phase 4)
  logging/    Pino logger + run context
tests/
  unit/         Vitest — pure logic
  integration/  Playwright Test — adapters against local fixtures (no network)
  live/         opt-in smoke tests against real boards (never in default suite)
  fixtures/     hand-built HTML mirroring observed structure (fictional data)
```

**Key boundary:** adapters know about HTML and HTTP; `core/` knows nothing about
browsers. Adapters call `core` normalization before returning, so every adapter
returns the same validated `JobListing` shape.

### Data flow (Phase 1)

```
config file ─▶ validate (Zod) ─▶ for each company (sequential)
   ─▶ adapter: navigate page 1..N, check status/redirects, wait for content,
      extract raw rows, verify count ─▶ normalize + validate + dedupe
   ─▶ CompanyScanResult ─▶ filter (keyword/location) ─▶ run JSON + console summary
```

## 5. Phases

**Status:** Phases 0–6 complete (2026-10-13). CI passed on its first GitHub run. Phase 7 (final docs) is next.

| Phase | Scope                                                                                                                                             | Exit criteria                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **0** | Tooling: TS strict, ESLint, Prettier, Vitest, Playwright Test, scripts, `.gitignore`, plan, `CLAUDE.md`                                           | `lint`, `format:check`, `typecheck`, empty test runs succeed       |
| **1** | Vertical slice: config → Greenhouse Playwright adapter → normalization/identity/dedup/filter → JSON run output → `scan` and `validate-config` CLI | Unit + mocked integration tests pass; real scan of one board works |
| **2** | Snapshots + change detection (`NEW`, `UPDATED`, `POSSIBLY_REMOVED`, `REMOVED`), history, atomic writes, partial-failure isolation                 | Tests 7–12, 16, 17, 23                                             |
| **3** | Reliability: bounded retries/backoff for transient errors, 429 + `Retry-After`, per-host spacing/concurrency, traces on failure                   | Tests 14, 15                                                       |
| **4** | Reports: CSV (formula-injection safe), HTML (escaped), `report --latest`, demo-vs-live labelling                                                  | Tests 18, 19, 25                                                   |
| **5** | Lever adapter (after inspecting real pages)                                                                                                       | Mocked integration tests                                           |
| **6** | GitHub Actions CI + optional monitoring workflow with state branch                                                                                | CI green on PR                                                     |
| 7     | README, ARCHITECTURE, TEST_STRATEGY, DECISIONS, badges                                                                                            | Docs match real commands                                           |

## 6. Design decisions (summary — full log in `DECISIONS.md` from Phase 7)

1. **Config holds board tokens, not URLs.** The adapter builds
   `https://job-boards.greenhouse.io/<token>` itself. This removes arbitrary-URL and
   private-network (SSRF) risk at the source.
2. **Identity:** `greenhouse:<token>:<jobId>` using the numeric ID in the job URL
   path; fallback to a hash of the canonical URL. Never title-based.
3. **Completeness is explicit.** A scan is `complete` only when every page was
   traversed, the row count equals the board's own count header, and no row was
   rejected. Phase 2 will only use complete scans for removal decisions.
4. **Empty is not success by default.** Zero rows is valid only when the count
   header itself reports zero. Zero rows with a missing header or a non-zero header
   is `STRUCTURE_CHANGED` / `SUSPICIOUS_EMPTY`.
5. **Off-site redirects fail.** If the board redirects outside allowed hosts, the
   result is `UNEXPECTED_REDIRECT` and nothing is extracted.
6. **Polite by default.** Sequential companies, configurable delay between pages
   (default 1000 ms), images/fonts/media blocked.
7. **Filters never change what is collected** — they only change what is reported.
   (Phase 2 snapshots will store the unfiltered set.)
8. **Fixtures are fictional.** They copy the observed _structure_ only; no live
   listings are committed.
9. **One snapshot file per company** (`state/snapshots/<id>.json`), validated with Zod on
   read, so one company's failure or corruption cannot affect another's.
10. **Only complete successful scans advance a snapshot.** Incomplete scans still report
    visible NEW/UPDATED but are not saved, so they may be re-reported next run — a
    duplicate alert is preferred over corrupted history.
11. **Removal = two consecutive complete absences.** Failed/incomplete scans neither
    increment nor reset the count.
12. **Corrupt state is never overwritten.** The run reports ERROR and exits 1; the user
    decides whether to repair or rebaseline.
13. **`state/` is separate from `output/`** so the scheduled workflow (Phase 6) can persist
    state on its own branch without committing reports.
14. **Retries are per page and only for transient failures** (timeouts, network errors, 408,
    5xx). 401/403/404, redirects and structure changes are never retried.
15. **429 is waited out at most once**, and only when `Retry-After` is present and ≤ 60 s.
    Anything else means the site wants us to stop, so the company is `BLOCKED`.
16. **One `HostThrottle` per run** enforces spacing per host across companies. Concurrency
    stays at 1 (sequential companies); parallelism was not needed for the target scale.
17. **Tab reset before retry.** Found by test: a timed-out navigation left its request
    pending and the retry failed with `net::ERR_ABORTED`; loading `about:blank` first fixes it.
18. **Traces are opt-in (`--trace`)** and kept only for failed companies, via trace chunks.
19. **One folder per run** (`output/runs/<runId>/`) with `run.json`, `jobs.csv`, and
    `report.html`; `output/latest.json` is written last so `report --latest` never sees a
    half-written run. Run JSON `schemaVersion` went from 1 to 2.
20. **One CSV table** (listings + change column, then removals) rather than several files:
    easiest to filter in a spreadsheet.
21. **HTML is hand-escaped with no template library**: one `escapeHtml` for all text, https-only
    links, no scripts, and a CSP as a second layer. Tested with hostile input.
22. **An offline `demo` command** runs the real pipeline against fictional pages. It gives
    interviewers a no-network way to try the tool and is the source of every README example,
    so no output in the docs is invented. Demo state/output is isolated in `output/demo/`.
23. **Lever completeness without a count:** a scan is complete when the postings container
    is present, either postings or Lever's explicit empty message is found, and no row is
    rejected. Empty without the message is `SUSPICIOUS_EMPTY`.
24. **Shared `finishScan`** extracted once there were two adapters, so validation, status,
    and completeness rules cannot drift between providers.
25. **Lever-only fields** (workplace type, commitment) fill `workplaceType`/`employmentType`;
    Greenhouse leaves them `null` because its list page does not show them.
26. **Snapshots persist on an orphan `monitor-state` branch**, not in runner storage or caches
    (neither is durable). Only `state/` is committed there; reports are artifacts. Tested
    locally across three simulated runners against a bare repository.
27. **Monitoring is manual-only until the user opts in** to a schedule, per the spec; CI has
    read-only permissions and the monitor job has `contents: write` only to push state.
28. **License: PolyForm Noncommercial 1.0.0** (changed from MIT on 2026-10-13 at the owner's
    request): free noncommercial use and modification, no selling or other commercial use.
    The MIT-licensed commits published briefly before the change remain MIT for anyone who
    obtained them then.

## 7. Risks

| Risk                                        | Mitigation                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Greenhouse changes markup                   | Count-header cross-check, `STRUCTURE_CHANGED` category, screenshot + HTML diagnostics, live smoke test                                  |
| Zero-openings page format unverified        | Treat as assumption; documented; revisit when a real empty board is found                                                               |
| Tests silently using the network            | Integration tests abort every request not served by a fixture                                                                           |
| Mass false "removed" alerts                 | Completeness gate + two consecutive complete scans (Phase 2)                                                                            |
| Being rate-limited/blocked                  | Delay between pages; 401/403 → `ACCESS_DENIED`, no retries; 429 handling in Phase 3                                                     |
| Redirected page loads once before rejection | Documented limitation of Playwright routing; no data extracted from it                                                                  |
| Two runs writing the same snapshot at once  | Not handled yet (no lock file). Atomic writes prevent torn files, but the later run wins. Phase 6 workflow will use a concurrency group |

## 8. Acceptance criteria (whole project)

See the completion criteria in the specification; each phase above lists its own.
Nothing is reported as passing unless it was run and observed.
