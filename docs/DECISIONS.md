# Design decisions

Each entry records **what** was decided, **why**, and the **trade-off** accepted. Decisions
were made phase by phase between 2026-10-12 and 2026-10-13; the phase is noted in brackets.
Facts about real sites (selectors, counts, sizes) were observed on those dates and are listed
in [PROJECT_PLAN.md §3](PROJECT_PLAN.md#3-provider-research-real-pages-not-assumptions).

## Safety and scope

**D1. Config holds board names, not URLs.** [Phase 1]
Companies are configured with a Greenhouse `boardToken` or a Lever `site`; the tool builds the
URL itself. _Why:_ a config file can never point the browser at an arbitrary host or a
private-network address (no SSRF by construction). _Trade-off:_ career sites that are not on a
supported provider cannot be added by URL; they need a new adapter.

**D5. Off-site redirects fail.** [Phase 1]
If a board redirects anywhere outside its own board path (e.g. Figma's board redirects to
figma.com), the company fails with `UNEXPECTED_REDIRECT` and nothing is extracted.
_Why:_ we only parse pages whose structure we have inspected. _Trade-off:_ Playwright's route
interception does not see redirect follow-ups, so the redirected page is loaded once before
being rejected; it is detected from the main-frame 3xx responses instead.

**D6. Polite by default.** [Phase 1, extended in Phase 3 as D16]
Companies are scanned one at a time, requests to a host are spaced (1 s default, matching
Lever's `Crawl-delay: 1`), and images, fonts, and media are not downloaded. The browser keeps
Playwright's default user agent: the tool does not disguise itself. _Trade-off:_ large
configurations take longer to scan.

**D15. A 429 is waited out at most once.** [Phase 3]
Only when `Retry-After` is present and at most 60 s; anything else (no header, a longer wait,
a second 429) marks the company `BLOCKED`. 401/403 are never retried. _Why:_ the spec forbids
working around access restrictions; a site asking us to stop is respected.

**D27. Scheduled monitoring is opt-in.** [Phase 6]
The monitoring workflow is manual-only until the user uncomments the schedule. CI has
read-only permissions; the monitor job has `contents: write` only to push snapshots.

## Data correctness

**D2. Stable identity from the provider's posting ID.** [Phase 1]
`greenhouse:<token>:<numeric id>` or `lever:<site>:<uuid>`, read from the canonical job URL;
otherwise a hash of the canonical URL. Never the title. _Why:_ titles change and repeat;
equivalent URLs (legacy host, tracking parameters, fragment, trailing slash, relative link,
letter case) must map to one job.

**D3. Completeness is explicit.** [Phase 1]
A scan is `complete` only when every page was traversed, the row count equals the board's own
count, and no row was rejected. _Why:_ only complete scans may be used to decide that a job
disappeared. _Trade-off:_ one persistently malformed row keeps a board "incomplete" (visible as
a warning) and blocks removal detection for it.

**D4. Empty is not success by default.** [Phase 1]
Zero rows is a valid result only when the board itself says so (Greenhouse "0 jobs", Lever's
"No job postings" message). Otherwise it is `SUSPICIOUS_EMPTY` or `STRUCTURE_CHANGED`.
_Note:_ the Greenhouse "0 jobs" wording is an assumption — no real empty Greenhouse board was
found to verify it. Lever's empty state was observed on real boards.

**D7. Filters never change what is collected.** [Phase 1]
`--keyword` and `--location` only narrow what is reported; snapshots store the full board.
Listings without a location never match a location filter.

**D8. Test fixtures are fictional.** [Phase 1]
They copy the observed page _structure_ with invented companies and jobs. No scraped listings
are committed.

**D23. Lever completeness without a count.** [Phase 5]
Lever shows every posting on one page and no count. A Lever scan is complete when the postings
container is present, it contains postings or Lever's explicit empty message, and no row is
rejected. _Why:_ on two real boards the page's posting IDs matched Lever's official feed
exactly (83/83, 311/311).

**D25. Provider-specific fields stay honest.** [Phase 5]
Lever exposes workplace type and commitment, so those fill `workplaceType` and
`employmentType`. Greenhouse's list page does not, so they stay `null` — "Remote, US" in a
location is never turned into a workplace type.

## Change tracking

**D9. One snapshot file per company.** [Phase 2]
`state/snapshots/<id>.json`, validated with Zod when read. _Why:_ one company's failure or
corrupt file cannot affect another's.

**D10. Only complete successful scans advance a snapshot.** [Phase 2]
Incomplete scans still report the `NEW`/`UPDATED` jobs they saw, but are not saved.
_Trade-off:_ those changes may be reported again on the next run — a duplicate alert is
preferred over corrupted history.

**D11. Removal requires two consecutive complete absences.** [Phase 2]
The first absence is `POSSIBLY_REMOVED`, the second `REMOVED`. Failed and incomplete scans
neither increment nor reset the counter. Observation timestamps never count as an update.

**D12. Corrupt state is never overwritten.** [Phase 2]
An unreadable snapshot makes that company report `ERROR` and the run exit 1. _Why:_ the user,
not the tool, decides whether to repair the file or start a new baseline.

**D13. `state/` is separate from `output/`.** [Phase 2]
So snapshots can be persisted on their own (D26) while reports stay disposable.

## Reliability

**D14. Retries are per page and only for transient failures.** [Phase 3]
Timeouts, network errors, HTTP 408 and 5xx: up to 2 retries with exponential backoff and
jitter. Everything else is permanent. A failure on page 3 does not restart from page 1.

**D16. One host throttle per run.** [Phase 3]
Spacing applies across companies on the same host (before Phase 3 there was no gap when
moving to the next company). Concurrency stays at 1; parallelism was not needed at this scale.

**D17. Reset the tab before each retry.** [Phase 3]
Found by a test: a timed-out navigation left its request pending, and the retry failed with
`net::ERR_ABORTED`. Loading `about:blank` first makes every attempt clean.

**D18. Traces are opt-in.** [Phase 3]
`--trace` records a Playwright trace per company (trace chunks) and keeps it only for
companies that fail or are blocked.

## Reports

**D19. One folder per run.** [Phase 4]
`output/runs/<runId>/` holds `run.json`, `jobs.csv`, and `report.html`. `output/latest.json`
is written last, so `report --latest` never sees a half-written run.

**D20. One CSV table.** [Phase 4]
Current listings with a change column, followed by removed jobs — the easiest shape to filter
in a spreadsheet.

**D21. Hand-written escaping, no template library.** [Phase 4]
One `escapeHtml` for every value, links only for `https:` URLs, no scripts, and a
Content-Security-Policy as a second layer. CSV cells that could run as spreadsheet formulas
get a leading `'`. Both are tested with deliberately hostile input.

**D22. An offline demo is the source of all documentation examples.** [Phase 4]
`npm run monitor -- demo` runs the real pipeline against fictional pages, so every example in
the README is real output and nothing in the docs is invented. Demo output is isolated in
`output/demo/` and labeled `DEMO DATA`.

## Code structure

**D24. Shared result-building across adapters.** [Phase 5]
`finishScan` was extracted when the second adapter arrived (not before), so validation, status,
and completeness rules cannot drift between providers.

## Operations

**D26. Snapshots persist on an orphan `monitor-state` branch.** [Phase 6]
GitHub runners are wiped after each job and caches can be evicted, so neither is durable
history. Only `state/` is committed to that branch; reports are uploaded as artifacts. The
branch shares no history with `main`. Tested locally across three simulated runners against a
bare repository before the first GitHub run.

**D28. License: PolyForm Noncommercial 1.0.0.** [Phase 6]
Changed from MIT at the owner's request: free noncommercial use and modification, no selling
or other commercial use. This makes the project source-available rather than OSI open source.
The MIT-licensed commits that were public briefly before the change remain MIT for anyone who
obtained them then.

## Deliberately not done

- **No database, server, or frontend.** JSON files are enough for this scale (spec).
- **Lever's official feed is not used on every scan.** It includes full descriptions (5.8 MB for
  one board); it is used only by the opt-in live test as an independent check.
- **No parallel scanning.** Sequential scanning keeps load on job boards low.
- **No login, CAPTCHA solving, or anti-bot evasion** — ever.
