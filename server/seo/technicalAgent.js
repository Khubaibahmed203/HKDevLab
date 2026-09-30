/**
 * PHASE 3 STEP 4D — TECHNICAL SEO SPECIALIST AGENT.
 *
 * A deterministic, read-only agent matching the shared contract in server/seo/agentContracts.js:
 * agent({auditContext, pages, issues, previousRecommendations}) => AgentFinding[]. Like
 * server/seo/onPageAgent.js (Phase 3 Step 4C), it does not crawl, analyze, write, apply, call an LLM, or
 * make any network call — it only reads the Issue/PageContext data an existing scan already produced.
 *
 * NOT wired into server/seo/jobs.js or the orchestrator's agent list — this step only makes the agent
 * itself exist and be individually testable (see server/test-seo-technical-agent.mjs), matching the
 * On-Page Agent's precedent from Step 4C.
 *
 * OWNERSHIP: unlike onPageAgent.js, this agent cannot reuse recommendations.js's
 * RECOMMENDATION_TYPE_BY_ISSUE as its ownership boundary — that map exists solely for the existing
 * AI-recommendation-generation route (POST /issues/:id/recommend) and only covers content-field types
 * ('title', 'description', 'heading', 'content', 'internal-link', 'schema'); it does not include a single
 * technical/crawlability issue type. There is no other existing type→specialist grouping in the repository
 * to reuse, so TECHNICAL_ISSUE_TYPES below is a small, explicit allowlist, copied verbatim from the literal
 * issue type strings server/seo/pageAnalyzer.js's analyzePages() actually produces — not guessed, not a
 * second analyzer.
 *
 * CONSERVATISM: of the 13 technical issue types this agent recognizes as its own, only 4 produce an actual
 * AgentFinding — the ones where a safe proposedValue can be derived from data this project already crawled,
 * never invented (see the reasoning attached to each). The other 9 are still positively recognized as
 * technical-SEO-owned in the code below, but deliberately produce no finding, per Step 6 of the spec this
 * module implements ("if a safe proposed value cannot be derived from existing evidence, do not invent
 * one").
 */

const AGENT_NAME = 'technical-agent';

/** Every issue type below is copied verbatim from server/seo/pageAnalyzer.js. Deliberately excludes:
 *  'orphan-page', 'broken-internal-link', 'link-to-redirect' — these come from pageAnalyzer.js's internal
 *  link GRAPH section and are about the site's linking structure, not one page's own crawl response; that
 *  is the Internal Linking specialist's territory (see Step 5 of the Step 4D spec). Also excludes
 *  'missing-json-ld'/'invalid-json-ld' (Schema specialist), every on-page content type already owned by
 *  onPageAgent.js, and 'duplicate-ids'/'missing-lang'/'missing-viewport' — markup/accessibility hygiene
 *  signals that are not squarely a crawlability/indexability/response concern; left unclaimed by any
 *  specialist for now rather than guessed at (see the Step 4D final report's noted limitation). */
const TECHNICAL_ISSUE_TYPES = new Set([
  'missing-robots-txt', 'robots-disallow',
  'missing-sitemap', 'sitemap-error', 'sitemap-external-url', 'missing-from-sitemap',
  'broken-page', 'redirect', 'redirects-external', 'not-https',
  'missing-canonical', 'canonical-cross-domain', 'noindex',
]);

/** Mechanically swaps only the scheme of a real, already-crawled URL — never touches the rest of it. */
function toHttps(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : null;
}

function makeFinding({ issueId, pageId, confidence, proposedType, proposedValue, reasoning }) {
  return {
    agentName: AGENT_NAME,
    issueId,
    confidence,
    evidence: [
      { source: 'analyzer', ref: issueId },   // the flagged issue itself — server/seo/pageAnalyzer.js
      { source: 'crawl', ref: pageId },        // the real crawl facts this proposal was derived from — server/seo/crawler.js
    ],
    proposedType,
    proposedValue,
    reasoning,
  };
}

/**
 * @param {{auditContext: import('./agentContracts.js').AuditContext, pages: import('./agentContracts.js').PageContext[], issues: import('./agentContracts.js').Issue[], previousRecommendations: import('./agentContracts.js').Recommendation[]}} input
 * @returns {import('./agentContracts.js').AgentFinding[]}
 */
export function technicalAgent({ auditContext, pages, issues, previousRecommendations } = {}) {
  const issueList = Array.isArray(issues) ? issues : [];
  const pageList = Array.isArray(pages) ? pages : [];
  if (!issueList.length) return [];

  const pageById = new Map(pageList.filter((p) => p && Number.isInteger(p.pageId)).map((p) => [p.pageId, p]));
  const ctxWebsiteId = auditContext?.websiteId;
  const ctxAuditId = auditContext?.auditId;

  const findings = [];
  for (const issue of issueList) {
    // Malformed input is untrusted, same as any other agent's own output — skip rather than crash.
    if (!issue || typeof issue.type !== 'string' || !Number.isInteger(issue.id)) continue;

    // Never claim an issue that isn't explicitly this audit's own — honoring auditContext's explicit
    // websiteId/auditId over whatever the input array happens to hold, same as onPageAgent.js.
    if (issue.websiteId != null && ctxWebsiteId != null && issue.websiteId !== ctxWebsiteId) continue;
    if (issue.auditId != null && ctxAuditId != null && issue.auditId !== ctxAuditId) continue;

    if (!TECHNICAL_ISSUE_TYPES.has(issue.type)) continue;   // not this agent's responsibility

    const page = issue.pageId != null ? pageById.get(issue.pageId) : undefined;

    if (issue.type === 'missing-from-sitemap' && page && typeof page.url === 'string' && page.url) {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'sitemap-inclusion', proposedValue: page.url,
        reasoning: 'This page was crawled successfully but is not listed in the sitemap. Its own crawled URL is what should be added — no new URL was invented.',
      }));
      continue;
    }

    if (issue.type === 'redirect' && page && page.statusCode >= 300 && page.statusCode < 400 && typeof page.finalUrl === 'string' && page.finalUrl && page.finalUrl !== page.url) {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'redirect-target', proposedValue: page.finalUrl,
        reasoning: `This URL redirects to ${page.finalUrl}. Internal references should point directly at that final destination to avoid an unnecessary redirect hop — the destination is the page's own already-known finalUrl, not a guess.`,
      }));
      continue;
    }

    if (issue.type === 'not-https' && page && typeof page.finalUrl === 'string' && /^http:\/\//i.test(page.finalUrl)) {
      const httpsUrl = toHttps(page.finalUrl);
      if (httpsUrl) {
        findings.push(makeFinding({
          issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'https-upgrade', proposedValue: httpsUrl,
          reasoning: 'This page is served over HTTP. The same URL, served over HTTPS, is the proposed fix — only the scheme changes, nothing else.',
        }));
      }
      continue;
    }

    if (issue.type === 'missing-canonical' && page && !page.canonical && typeof page.finalUrl === 'string' && page.finalUrl) {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'canonical', proposedValue: page.finalUrl,
        reasoning: "No canonical tag is present. The safest default is a self-referencing canonical pointing at this page's own URL.",
      }));
      continue;
    }

    // Recognized as technical SEO ownership (robots.txt/sitemap existence, broken pages, cross-domain
    // redirects/canonicals, noindex, sitemap-error/-external-url) but no safe proposedValue can be derived
    // here without inventing content this agent never had — e.g. actual robots.txt/sitemap.xml text, or a
    // second-guess about a deliberate noindex/cross-domain canonical/redirect that might be intentional.
    // Per Step 6, no finding is produced rather than fabricating one.
  }
  return findings;
}
