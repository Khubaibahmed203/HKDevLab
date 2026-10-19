// Read at call time, not at module load — the rest of this codebase's env vars follow the same rule (see
// server/app.js) so a .env file loaded by server/index.js is always visible before these are read.
const int = (v, fallback) => { const n = +v; return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback; };

export function crawlLimits() {
  return {
    maxPages: int(process.env.SEO_MAX_PAGES, 100),
    maxDepth: int(process.env.SEO_MAX_DEPTH, 5),
    requestTimeoutMs: int(process.env.SEO_REQUEST_TIMEOUT_MS, 10_000),
    crawlDelayMs: int(process.env.SEO_CRAWL_DELAY_MS, 250),
  };
}

// Stale-audit recovery threshold — deliberately NOT part of crawlLimits() (that object also feeds the specialist
// context). A recovery safety net, not an execution timeout: nothing is ever cancelled when it elapses.
const MIN_STALE_AUDIT_MS = 60_000;
const SITEMAP_FETCH_CAP = 15;           // MAX_SITEMAPS in sitemap.js — test-seo-stale-audit.mjs fails if the two drift apart
const PAGESPEED_TIMEOUT_FACTOR = 1.5;   // the `requestTimeoutMs * 1.5` PageSpeed timeout in jobs.js — same drift guard
const STALE_BUDGET_MARGIN = 1.5;

/** Default: 1.5 × the worst-case request budget of one scan (robots.txt + every sitemap fetch + every page at
 *  full timeout + PageSpeed) — 30 minutes with today's defaults. Each of those timeouts covers the whole request, body
 *  included (fetchBounded() in http.js; PageSpeed's timer runs until its body is parsed). Database writes and analysis
 *  have no timeout configured in this application's code (a limit set outside it, such as on the database server, is
 *  not visible from here), which is part of what the margin leaves room for. SEO_STALE_AUDIT_MS overrides it, clamped
 *  to at least 60 seconds. */
export function staleAuditMs() {
  const { maxPages, requestTimeoutMs, crawlDelayMs } = crawlLimits();
  const budgetMs = (1 + SITEMAP_FETCH_CAP) * requestTimeoutMs
    + maxPages * (requestTimeoutMs + crawlDelayMs)
    + requestTimeoutMs * PAGESPEED_TIMEOUT_FACTOR;
  return Math.max(MIN_STALE_AUDIT_MS, int(process.env.SEO_STALE_AUDIT_MS, Math.round(budgetMs * STALE_BUDGET_MARGIN)));
}

/* ───────────── serverless (Phase 5 D4.1): an execution budget for one scan, and the recovery threshold that matches it ───────────── */

/** True on Vercel, which sets VERCEL in every function. Read at call time, like every other variable in this file. */
export const onServerless = () => !!process.env.VERCEL;

// vercel.json gives the function 30 s. Request handling, the database writes after the crawl and PageSpeed (itself capped by what is left) need a share
// of that, so a scan gets 20 s from the moment it starts. A scan that cannot finish inside its budget is FAILED honestly — never completed partly.
const SERVERLESS_SCAN_BUDGET_MS = 20_000;
const MIN_SCAN_BUDGET_MS = 1_000;
const WRITE_RESERVE_MS = 5_000;

/** How long ONE scan may take, from its start to its terminal status — or null for no limit (a server that keeps running, which is how it always worked).
 *  The default is 20 s on Vercel and none elsewhere; SEO_SCAN_BUDGET_MS sets it anywhere (at least 1 s). The budget is enforced where this application
 *  controls the clock: every robots.txt, sitemap and page request, and PageSpeed. It cannot interrupt a database write or the analysis that follows the crawl. */
export function scanBudgetMs() {
  const set = int(process.env.SEO_SCAN_BUDGET_MS, 0);
  if (set) return Math.max(MIN_SCAN_BUDGET_MS, set);
  return onServerless() ? SERVERLESS_SCAN_BUDGET_MS : null;
}

/** The part of a budget the crawl deadline leaves for what it cannot interrupt: the database writes (and the analysis) after the crawl. */
export const crawlDeadlineReserveMs = (budgetMs) => Math.min(WRITE_RESERVE_MS, Math.round(budgetMs * 0.25));

/** When a queued or running audit counts as abandoned, for the poll routes as well as POST /scan. Without a scan budget that is staleAuditMs(), as ever:
 *  a worst-case crawl on a server that keeps running. With one, no live worker can still be on the audit long after the budget (the function is stopped by
 *  then), so it is three budgets — never under the 60 s minimum, never above staleAuditMs(). An explicit SEO_STALE_AUDIT_MS always wins. */
export function recoveryThresholdMs() {
  const budgetMs = scanBudgetMs();
  if (!budgetMs || int(process.env.SEO_STALE_AUDIT_MS, 0)) return staleAuditMs();
  return Math.min(staleAuditMs(), Math.max(MIN_STALE_AUDIT_MS, 3 * budgetMs));
}
