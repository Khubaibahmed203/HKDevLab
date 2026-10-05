import { fetchBounded, sitemapMaxBytes } from './http.js';

const decodeXmlEntities = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Regex-based, not a full XML parser — sitemaps are simple, well-structured documents and this avoids a
 *  new dependency for something this constrained (see content/seo.js's own precedent of not parsing/writing
 *  HTML with a library where a couple of targeted patterns do the job). */
export function parseSitemapXml(xml) {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const blockRe = isIndex ? /<sitemap\b[\s\S]*?<\/sitemap>/gi : /<url\b[\s\S]*?<\/url>/gi;
  const entries = [];
  for (const block of xml.match(blockRe) || []) {
    const loc = (block.match(/<loc>([\s\S]*?)<\/loc>/i) || [])[1];
    const lastmod = (block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i) || [])[1];
    if (loc) entries.push({ loc: decodeXmlEntities(loc.trim()), lastmod: lastmod ? decodeXmlEntities(lastmod.trim()) : null });
  }
  return { isIndex, entries };
}

/**
 * Fetches origin/sitemap.xml plus any Sitemap: lines from robots.txt, following at most one level of
 * sitemap-index nesting. Every fetch is checked against the crawl's own domain first — a misconfigured or
 * hostile sitemap can list URLs on other domains, but we only ever read sitemaps on our own site, and cap
 * the total number fetched so a huge or malicious index can't turn one scan into an unbounded fetch spree.
 */
export async function discoverSitemaps(origin, robotsSitemaps, { timeoutMs, userAgent, allowedHost } = {}) {
  const MAX_SITEMAPS = 15;
  const seen = new Set();
  const results = [];
  const candidates = [`${origin}/sitemap.xml`, ...(robotsSitemaps || [])].filter((u, i, arr) => arr.indexOf(u) === i);

  async function fetchOne(url) {
    if (seen.has(url) || seen.size >= MAX_SITEMAPS) return null;
    seen.add(url);
    let host;
    try { host = new URL(url).host.toLowerCase(); } catch { return { url, error: 'not a valid URL', entries: [] }; }
    if (host !== String(allowedHost).toLowerCase()) return { url, error: 'outside the configured domain — not fetched', entries: [] };
    try {
      const res = await fetchBounded(url, { timeoutMs, userAgent, maxBytes: sitemapMaxBytes(), readBody: (r) => r.ok });
      if (!res.ok) return { url, error: `HTTP ${res.status}`, entries: [] };
      const { isIndex, entries } = parseSitemapXml(res.text);
      return { url, isIndex, entries, error: null };
    } catch (err) {
      return { url, error: err.message || 'fetch failed', entries: [] };
    }
  }

  for (const url of candidates) {
    const r = await fetchOne(url);
    if (!r) continue;
    results.push(r);
    if (r.isIndex) {
      for (const sub of r.entries) {
        const subR = await fetchOne(sub.loc);
        if (subR) results.push(subR);
      }
    }
  }
  return results;
}
