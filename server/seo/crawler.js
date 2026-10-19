import { normalizeUrl, sameSite } from './url.js';
import { fetchBounded, htmlMaxBytes, CRAWLER_USER_AGENT } from './http.js';
import { fetchRobots, isAllowed } from './robots.js';
import { discoverSitemaps } from './sitemap.js';
import { extractPage } from './extract.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The real (network) crawler — the WEBSITE → REAL CRAWLER → PAGE DISCOVERY → HTML EXTRACTION stages of the
 * Phase 2 pipeline. Breadth-first from `startUrl`, follows LINKS only within that URL's host (external links are
 * recorded, never fetched), and is bounded on every axis that could otherwise make a scan run away: page count,
 * link depth, per-request timeout, and total queued work. A REDIRECT is a different matter: the fetch helper in
 * http.js follows redirects itself, so a page may legitimately land on another host (the analyzer reports that as an
 * external redirect), but only on a public one — a hop to a loopback, private, link-local or otherwise non-public
 * destination is refused before any request is made. It produces structured facts only — no analysis, no opinions,
 * nothing written anywhere.
 */
export async function crawlWebsite(startUrl, { maxPages = 100, maxDepth = 5, requestTimeoutMs = 10_000, crawlDelayMs = 250, userAgent = CRAWLER_USER_AGENT, deadlineAt = null } = {}) {
  const normalizedStart = normalizeUrl(startUrl, startUrl);
  if (!normalizedStart) throw new Error(`Not a valid http(s) URL: ${startUrl}`);
  const origin = new URL(normalizedStart).origin;
  const allowedHost = new URL(normalizedStart).host;

  // An optional deadline (epoch ms), from the caller's scan budget: no request here runs past it, no new page is started once almost nothing is left, and the
  // crawl then reports `timedOut` — what it saw is a fragment, so the caller must not treat it as a finished crawl. It bounds the network work done in this
  // function only; it cannot reach the caller's database writes or analysis. With no deadline (null) every line below behaves exactly as it always did.
  const left = () => (deadlineAt == null ? Infinity : deadlineAt - Date.now());
  const MIN_STEP_MS = 250;
  const within = (ms) => Math.max(1, Math.min(ms, left()));
  const pause = () => (crawlDelayMs ? sleep(Math.min(crawlDelayMs, Math.max(0, left()))) : null);
  let timedOut = false;

  const robots = await fetchRobots(origin, { timeoutMs: within(requestTimeoutMs), userAgent });
  const sitemaps = await discoverSitemaps(origin, robots.sitemaps, { timeoutMs: within(requestTimeoutMs), userAgent, allowedHost, deadlineAt });

  const queue = [{ url: normalizedStart, depth: 0 }];
  const seen = new Set([normalizedStart]);
  const pages = [];
  const links = [];   // { fromUrl, toUrl, anchorText, isInternal }
  const errors = [];

  while (queue.length && pages.length < maxPages) {
    if (left() < MIN_STEP_MS) { timedOut = true; break; }
    const { url, depth } = queue.shift();

    if (!isAllowed(new URL(url).pathname, robots)) {
      pages.push({ url, finalUrl: url, depth, statusCode: null, contentType: null, responseTimeMs: 0, htmlSize: 0, disallowedByRobots: true });
      errors.push({ url, error: 'disallowed by robots.txt' });
      continue;
    }

    // One bounded request: the deadline and the HTML size cap cover the headers AND the body, so a page that stalls or
    // streams without end becomes an ordinary page error below instead of hanging the scan. The body is only read for HTML.
    const t0 = Date.now();
    let res, fetchError = null;
    const allowed = within(requestTimeoutMs);     // the usual per-request timeout, shortened only when the deadline is nearer
    try { res = await fetchBounded(url, { timeoutMs: allowed, userAgent, maxBytes: htmlMaxBytes(), readBody: (r) => /text\/html/i.test(r.headers.get('content-type') || '') }); }
    catch (err) {
      fetchError = err.code === 'REQUEST_TIMEOUT' ? `timed out after ${allowed}ms` : (err.message || 'fetch failed');
      if (err.code === 'REQUEST_TIMEOUT' && allowed < requestTimeoutMs) timedOut = true;   // cut short by the deadline, not by the page being slow: not a page error
    }
    const responseTimeMs = fetchError ? Date.now() - t0 : res.ttfbMs;   // as before: how long the server took to answer, not how long the body took to arrive

    if (fetchError) {
      pages.push({ url, finalUrl: url, depth, statusCode: null, contentType: null, responseTimeMs, htmlSize: 0, error: fetchError });
      errors.push({ url, error: fetchError });
      await pause();
      continue;
    }

    const finalUrl = res.url || url;
    const contentType = res.headers.get('content-type') || '';
    const isHtml = /text\/html/i.test(contentType);
    const body = isHtml ? res.text : '';
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
    await pause();
  }

  return { origin, allowedHost, robots, sitemaps, pages, links, errors, truncated: queue.length > 0, timedOut };
}
