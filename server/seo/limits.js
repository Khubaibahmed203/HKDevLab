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
