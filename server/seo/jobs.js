import { crawlWebsite } from './crawler.js';
import { analyzePages } from './pageAnalyzer.js';
import { scoreFromIssues } from './analyzers.js';   // Phase 1's pure severity-weighted scorer — unchanged, reused as-is
import { crawlLimits } from './limits.js';
import { fetchPageSpeed } from './pagespeed.js';

/**
 * WEBSITE → REAL CRAWLER → PAGE DISCOVERY → HTML EXTRACTION → TECHNICAL/ON-PAGE/LINK ANALYSIS → SEO ISSUES.
 * Runs to completion before the HTTP response returns — a bounded crawl (SEO_MAX_PAGES/SEO_MAX_DEPTH, a
 * per-request timeout) is slower than Phase 1's local-only pass but still fits one request/response cycle,
 * and this codebase's serverless deployment can't run work after it responds anyway (see the contact-form
 * mailer's own comment in server/app.js). seo_audits.status already has the 'running'/'complete'/'failed'
 * shape a future background worker would need; only the "when" of finishAudit() would change then, not the
 * table or the API contract.
 */
export async function runScan(store, website, { baseUrl } = {}) {
  const limits = crawlLimits();
  const startedAt = Date.now();
  const audit = await store.createAudit(website.id, { baseUrl, pagesPlanned: limits.maxPages });

  try {
    const crawl = await crawlWebsite(baseUrl, limits);
    const issues = analyzePages(crawl);

    const urlToPageId = new Map();
    for (const p of crawl.pages) {
      if (p.disallowedByRobots) continue;
      const id = await store.upsertPage({
        websiteId: website.id, url: p.url, finalUrl: p.finalUrl, statusCode: p.statusCode, contentType: p.contentType,
        title: p.title, description: p.description, canonical: p.canonical, robots: p.robotsMeta,
        h1Count: p.h1Count, h2Count: p.h2Count, wordCount: p.wordCount, htmlSize: p.htmlSize, responseTimeMs: p.responseTimeMs,
        depth: p.depth, imageCount: p.images?.length, imagesMissingAlt: p.missingAltCount, lang: p.lang,
        ogTitle: p.ogTitle, ogDescription: p.ogDescription, ogImage: p.ogImage, twitterCard: p.twitterCard,
        jsonLdPresent: p.jsonLdPresent, auditId: audit.id,
      });
      urlToPageId.set(p.url, id);
    }

    const links = crawl.links.map((l) => ({ ...l, fromPageId: urlToPageId.get(l.fromUrl), toPageId: urlToPageId.get(l.toUrl) })).filter((l) => l.fromPageId);
    if (links.length) await store.createLinks(website.id, audit.id, links);

    const issuesWithPageIds = issues.map((it) => ({ ...it, pageId: it.pageUrl ? urlToPageId.get(it.pageUrl) ?? null : null }));
    if (issuesWithPageIds.length) await store.createIssues(website.id, audit.id, issuesWithPageIds);

    // best-effort, never blocks or fails the scan — see server/seo/pagespeed.js
    const pagespeed = await fetchPageSpeed(crawl.pages[0]?.finalUrl || baseUrl, { timeoutMs: limits.requestTimeoutMs * 1.5 }).catch(() => ({ available: false, reason: 'request failed' }));

    const score = scoreFromIssues(issues);
    const comparison = await compareToPreviousAudit(store, website.id, audit.id);
    await store.finishAudit(audit.id, {
      score, status: 'complete', summary: `${crawl.pages.length} page(s) crawled, ${issues.length} issue(s) found.`,
      pagesCrawled: crawl.pages.length, errorsCount: crawl.errors.length, durationMs: Date.now() - startedAt, pagespeed,
    });
    return { ...(await store.getAudit(audit.id)), issueCount: issues.length, comparison };
  } catch (err) {
    await store.finishAudit(audit.id, { score: null, status: 'failed', summary: String(err.message || err), durationMs: Date.now() - startedAt });
    throw err;
  }
}

/** BEFORE vs AFTER: buckets the previous complete audit's issues against this one's by (type, page), so a
 *  re-scan can honestly report resolved/introduced/unchanged counts — never a claimed improvement that
 *  isn't backed by the analyzer actually finding fewer issues. */
async function compareToPreviousAudit(store, websiteId, currentAuditId) {
  const previous = await store.previousCompleteAudit(websiteId, currentAuditId);
  if (!previous) return null;
  const [prevIssues, currIssues] = await Promise.all([
    store.listIssues({ websiteId, auditId: previous.id, limit: 2000 }),
    store.listIssues({ websiteId, auditId: currentAuditId, limit: 2000 }),
  ]);
  const key = (i) => `${i.type}:${i.page_id ?? ''}`;
  const prevKeys = new Set(prevIssues.map(key));
  const currKeys = new Set(currIssues.map(key));
  return {
    previousAuditId: previous.id,
    resolvedCount: [...prevKeys].filter((k) => !currKeys.has(k)).length,
    introducedCount: [...currKeys].filter((k) => !prevKeys.has(k)).length,
    unchangedCount: [...currKeys].filter((k) => prevKeys.has(k)).length,
  };
}
