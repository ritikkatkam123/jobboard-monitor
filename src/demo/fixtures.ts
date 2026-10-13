/**
 * FICTIONAL demo data. Companies, jobs, and boards here do not exist.
 * The markup mirrors the Greenhouse board structure observed on 2026-10-12, so the
 * real adapter can parse it; see docs/PROJECT_PLAN.md section 3.
 */

export interface DemoJob {
  id: number;
  title: string;
  location: string | null;
  department: string;
  isNew?: boolean;
}

const BOARD_HOST = 'https://job-boards.greenhouse.io';

function escapeText(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function row(token: string, job: DemoJob): string {
  const badge = job.isNew
    ? '<span class="tag-container"><span class="ellipse"><span class="tag-text">New</span></span></span>'
    : '';
  const location =
    job.location === null
      ? ''
      : `<p class="body body__secondary body--metadata">${escapeText(job.location)}</p>`;
  return `<tr class="job-post"><td class="cell"><a href="${BOARD_HOST}/${token}/jobs/${job.id}"><p class="body body--medium">${escapeText(job.title)}${badge}</p>${location}</a></td></tr>`;
}

/** Render one board page. `pageSize` controls pagination; returns all pages. */
export function boardPages(
  company: string,
  token: string,
  jobs: DemoJob[],
  pageSize = 4,
): string[] {
  const pages: DemoJob[][] = [];
  for (let i = 0; i < jobs.length; i += pageSize) pages.push(jobs.slice(i, i + pageSize));
  if (pages.length === 0) pages.push([]);

  return pages.map((pageJobs, index) => {
    const byDept = new Map<string, DemoJob[]>();
    for (const job of pageJobs)
      byDept.set(job.department, [...(byDept.get(job.department) ?? []), job]);
    const groups = [...byDept]
      .map(
        ([dept, list]) =>
          `<div class="job-posts--table--department"><h3 class="section-header">${escapeText(dept)}</h3><table><tbody>${list.map((j) => row(token, j)).join('')}</tbody></table></div>`,
      )
      .join('');
    const isLast = index === pages.length - 1;
    const pagination =
      pages.length > 1
        ? `<nav aria-label="Pagination"><button aria-label="Next page" aria-disabled="${String(isLast)}" type="button">&gt;</button></nav>`
        : '';
    const count = `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Jobs at ${escapeText(company)} (DEMO)</title></head><body><h1>Current openings at ${escapeText(company)}</h1><h2 data-testid="job-count-header">${count}</h2><div class="job-posts">${groups}</div>${pagination}</body></html>`;
  });
}

const acmeDay1: DemoJob[] = [
  {
    id: 1001,
    title: 'Senior Software Engineer, Platform',
    location: 'Austin, Texas, United States',
    department: 'Engineering',
    isNew: true,
  },
  {
    id: 1002,
    title: 'QA Automation Engineer (Playwright)',
    location: 'Remote, United States',
    department: 'Engineering',
  },
  {
    id: 1003,
    title: 'Data Engineer, R&D "Insights" team',
    location: 'Zürich, Switzerland',
    department: 'Engineering',
  },
  { id: 1004, title: 'Account Executive, Enterprise', location: null, department: 'Sales' },
  { id: 1005, title: 'Warehouse Lead', location: 'Dallas, TX', department: 'Operations' },
  {
    id: 1007,
    // A scraped title that looks like a spreadsheet formula: the CSV report must neutralize it.
    title: '=HYPERLINK("https://example.com","Click me")',
    location: 'Remote',
    department: 'Quality',
  },
];

/** Day 2: one job retitled, one taken down, one added. */
const acmeDay2: DemoJob[] = [
  {
    id: 1001,
    title: 'Staff Software Engineer, Platform',
    location: 'Austin, Texas, United States',
    department: 'Engineering',
  },
  {
    id: 1002,
    title: 'QA Automation Engineer (Playwright)',
    location: 'Remote, United States',
    department: 'Engineering',
  },
  {
    id: 1003,
    title: 'Data Engineer, R&D "Insights" team',
    location: 'Zürich, Switzerland',
    department: 'Engineering',
  },
  { id: 1004, title: 'Account Executive, Enterprise', location: null, department: 'Sales' },
  {
    id: 1006,
    title: 'SDET II, Test Infrastructure',
    location: 'Remote, United States',
    department: 'Engineering',
    isNew: true,
  },
  {
    id: 1007,
    // A scraped title that looks like a spreadsheet formula: the CSV report must neutralize it.
    title: '=HYPERLINK("https://example.com","Click me")',
    location: 'Remote',
    department: 'Quality',
  },
];

const initechJobs: DemoJob[] = [
  {
    id: 2001,
    title: 'Software Developer in Test',
    location: 'Houston, Texas',
    department: 'Quality',
  },
];

export interface DemoResponse {
  status: number;
  body: string;
}

function pageMap(token: string, pages: string[]): Record<string, DemoResponse> {
  const map: Record<string, DemoResponse> = {};
  pages.forEach((body, i) => {
    map[`${BOARD_HOST}/${token}${i === 0 ? '' : `?page=${i + 1}`}`] = { status: 200, body };
  });
  return map;
}

export const DEMO_COMPANIES = [
  {
    id: 'acme',
    name: 'Acme Robotics (demo)',
    provider: 'greenhouse',
    boardToken: 'acme-demo',
    enabled: true,
  },
  {
    id: 'globex',
    name: 'Globex (demo)',
    provider: 'greenhouse',
    boardToken: 'globex-demo',
    enabled: true,
  },
  {
    id: 'initech',
    name: 'Initech (demo)',
    provider: 'greenhouse',
    boardToken: 'initech-demo',
    enabled: true,
  },
] as const;

/** Responses for each simulated day, keyed by exact URL. */
export function demoDays(): [Record<string, DemoResponse>, Record<string, DemoResponse>] {
  const day1 = {
    ...pageMap('acme-demo', boardPages('Acme Robotics', 'acme-demo', acmeDay1)),
    ...pageMap('globex-demo', boardPages('Globex', 'globex-demo', [])),
    ...pageMap('initech-demo', boardPages('Initech', 'initech-demo', initechJobs)),
  };
  const day2 = {
    ...pageMap('acme-demo', boardPages('Acme Robotics', 'acme-demo', acmeDay2)),
    ...pageMap('globex-demo', boardPages('Globex', 'globex-demo', [])),
    // Day 2: Initech refuses access. The tool must stop, not retry, and keep yesterday's snapshot.
    [`${BOARD_HOST}/initech-demo`]: { status: 403, body: '<h1>Forbidden</h1>' },
  };
  return [day1, day2];
}
