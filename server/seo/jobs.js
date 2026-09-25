import { DEFAULT_CONTENT, withDefaults } from '../content.js';
import { crawlHomepage } from './crawl.js';
import { analyzeHomepage, scoreFromIssues } from './analyzers.js';

async function loadContent(store) {
  const row = await store.getContent();
  return row ? withDefaults(row.data) : DEFAULT_CONTENT;
}

/**
 * Orchestrates one SCAN → ANALYZE pass for a website's homepage and persists the result (SEOAudit + its
 * SEOIssues). Synchronous today — the "crawl" is a local render plus two file reads, done in milliseconds —
 * so it runs to completion before the HTTP response, the same lesson the contact-form mailer already learned
 * for this codebase's serverless deployment (a Vercel function is frozen the instant it responds, so
 * "background" work after that point never happens). Phase 2 turns this into a genuinely long-running job
 * once a real network crawler is involved; the seo_audits.status column and the polling GET /scans/:id route
 * already have the right shape for that, so nothing about the API contract needs to change then.
 */
export async function runScan(store, website, { origin } = {}) {
  const audit = await store.createAudit(website.id);
  try {
    const content = await loadContent(store);
    const { html, robotsTxt, sitemapExists } = crawlHomepage(content, origin);
    const issues = analyzeHomepage(html, { robotsTxt, sitemapExists, origin });

    await store.upsertPage({ websiteId: website.id, url: `${origin}/`, title: content.seo.title, description: content.seo.description, statusCode: 200 });
    if (issues.length) await store.createIssues(website.id, audit.id, issues);

    const score = scoreFromIssues(issues);
    await store.finishAudit(audit.id, { score, status: 'complete', summary: `${issues.length} issue(s) found.` });
    return { ...(await store.getAudit(audit.id)), issueCount: issues.length };
  } catch (err) {
    await store.finishAudit(audit.id, { score: null, status: 'failed', summary: String(err.message || err) });
    throw err;
  }
}
