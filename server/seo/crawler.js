import { normalizeUrl, sameSite } from './url.js';
import { fetchWithTimeout, CRAWLER_USER_AGENT } from './http.js';
import { fetchRobots, isAllowed } from './robots.js';
import { discoverSitemaps } from './sitemap.js';
import { extractPage } from './extract.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The real (network) crawler — the WEBSITE → REAL CRAWLER → PAGE DISCOVERY → HTML EXTRACTION stages of the
 * Phase 2 pipeline. Breadth-first from `startUrl`, never leaves that URL's host, and is bounded on every
 * axis that could otherwise make a scan run away: page count, link depth, per-request timeout, and total
 * queued work. It produces structured facts only — no analysis, no opinions, nothing written anywhere.
 */
export async function crawlWebsite(startUrl, { maxPages = 100, maxDepth = 5, requestTimeoutMs = 10_000, crawlDelayMs = 250, userAgent = CRAWLER_USER_AGENT } = {}) {
  const normalizedStart = normalizeUrl(startUrl, startUrl);
  if (!normalizedStart) throw new Error(`Not a valid http(s) URL: ${startUrl}`);
  const origin = new URL(normalizedStart).origin;
  const allowedHost = new URL(normalizedStart).host;

  const robots = await fetchRobots(origin, { timeoutMs: requestTimeoutMs, userAgent });
  const sitemaps = await discoverSitemaps(origin, robots.sitemaps, { timeoutMs: requestTimeoutMs, userAgent, allowedHost });

  const queue = [{ url: normalizedStart, depth: 0 }];
  const seen = new Set([normalizedStart]);
  const pages = [];
  const links = [];   // { fromUrl, toUrl, anchorText, isInternal }
  const errors = [];

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift();

    if (!isAllowed(new URL(url).pathname, robots)) {
      pages.push({ url, finalUrl: url, depth, statusCode: null, contentType: null, responseTimeMs: 0, htmlSize: 0, disallowedByRobots: true });
      errors.push({ url, error: 'disallowed by robots.txt' });
      continue;
    }

    const t0 = Date.now();
    let res, fetchError = null;
    try { res = await fetchWithTimeout(url, { timeoutMs: requestTimeoutMs, userAgent }); }
    catch (err) { fetchError = err.name === 'AbortError' ? `timed out after ${requestTimeoutMs}ms` : (err.message || 'fetch failed'); }
    const responseTimeMs = Date.now() - t0;

    if (fetchError) {
      pages.push({ url, finalUrl: url, depth, statusCode: null, contentType: null, responseTimeMs, htmlSize: 0, error: fetchError });
      errors.push({ url, error: fetchError });
      if (crawlDelayMs) await sleep(crawlDelayMs);
      continue;
    }

    const finalUrl = res.url || url;
    const contentType = res.headers.get('content-type') || '';
    const isHtml = /text\/html/i.test(contentType);
    const body = isHtml ? await res.text() : '';
    const htmlSize = isHtml ? Buffer.byteLength(body, 'utf8') : Number(res.headers.get('content-length') || 0);

    const page = { url, finalUrl, depth, statusCode: res.status, contentType, responseTimeMs, htmlSize, redirected: finalUrl !== url, error: null };

    if (isHtml && res.ok) {
      Object.assign(page, extractPage(body));
      for (const link of page.links) {
        const target = normalizeUrl(link.href, finalUrl);
        if (!target) continue;
        const internal = sameSite(target, allowedHost);
        links.push({ fromUrl: url, toUrl: target, anchorText: link.text, isInternal: internal });
        if (internal && depth < maxDepth && !seen.has(target) && pages.length + queue.length < maxPages) {
          seen.add(target);
          queue.push({ url: target, depth: depth + 1 });
        }
      }
    }
    pages.push(page);
    if (crawlDelayMs) await sleep(crawlDelayMs);
  }

  return { origin, allowedHost, robots, sitemaps, pages, links, errors, truncated: queue.length > 0 };
}
