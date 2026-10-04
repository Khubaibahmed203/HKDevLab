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

/** Default: 1.5 × the worst-case header-wait budget of one scan (robots.txt + every sitemap fetch + every page at
 *  full timeout + PageSpeed) — 30 minutes with today's defaults. Body reads and DB writes have no configured cap,
 *  which is what the margin is for. SEO_STALE_AUDIT_MS overrides it, clamped to at least 60 seconds. */
export function staleAuditMs() {
  const { maxPages, requestTimeoutMs, crawlDelayMs } = crawlLimits();
  const budgetMs = (1 + SITEMAP_FETCH_CAP) * requestTimeoutMs
    + maxPages * (requestTimeoutMs + crawlDelayMs)
    + requestTimeoutMs * PAGESPEED_TIMEOUT_FACTOR;
  return Math.max(MIN_STALE_AUDIT_MS, int(process.env.SEO_STALE_AUDIT_MS, Math.round(budgetMs * STALE_BUDGET_MARGIN)));
}
