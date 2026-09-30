/**
 * PHASE 3 STEP 4E — INTERNAL LINK SEO SPECIALIST AGENT.
 *
 * A deterministic, read-only agent matching the shared contract in server/seo/agentContracts.js:
 * agent({auditContext, pages, issues, previousRecommendations}) => AgentFinding[]. Like
 * server/seo/onPageAgent.js and server/seo/technicalAgent.js (Steps 4C/4D), it does not crawl, analyze,
 * write, apply, call an LLM, or make any network call — it only reads the Issue/PageContext data an
 * existing scan already produced.
 *
 * NOT wired into server/seo/jobs.js or the orchestrator's agent list — this step only makes the agent
 * itself exist and be individually testable (see server/test-seo-internal-link-agent.mjs).
 *
 * OWNERSHIP: 'orphan-page', 'broken-internal-link', 'link-to-redirect' — the three internal-link-graph
 * issue types server/seo/pageAnalyzer.js's analyzePages() actually produces (copied verbatim, confirmed by
 * inspection, not guessed). 'orphan-page' also happens to appear in recommendations.js's
 * RECOMMENDATION_TYPE_BY_ISSUE (mapped to 'internal-link'), but that map only exists for the LLM
 * recommendation route and does not cover 'broken-internal-link'/'link-to-redirect' at all — its own
 * comment names 'broken-internal-link' as exactly the kind of issue it deliberately excludes. So, like
 * technicalAgent.js, this agent declares its own small explicit ownership set rather than reusing that map.
 *
 * *** IMPORTANT LIMITATION DISCOVERED DURING INSPECTION (Step 3/Step 9 of the Step 4E spec) ***
 * The persisted link GRAPH itself (source page -> destination page, anchor text) is not readable through
 * any existing structure this agent is given:
 *   - server/db.js defines a `page_links` table with from_page_id/to_page_id/anchor_text, written by
 *     createLinks(), but NO store method ever reads it back (its own row-shaping helper, pageLink(), is
 *     defined and never called anywhere in that file) — confirmed by inspection.
 *   - The `Issue` contract (server/seo/agentContracts.js, mirroring seo_issues) carries only ONE `pageId`.
 *     For 'orphan-page' that id is the orphaned page itself. For 'broken-internal-link' and
 *     'link-to-redirect', pageAnalyzer.js sets it to the LINK'S SOURCE page (`l.fromUrl`) — the destination
 *     URL and (for a redirect) its final URL exist only inside the issue's free-text `detail` string.
 * Parsing that free text would mean silently depending on pageAnalyzer.js's exact wording — not a
 * structured signal, and exactly the kind of fragile, second-guessing logic Step 1 warns against. So this
 * agent never does that. Per Step 7/8/9 of the spec, when a concrete destination/anchor cannot be
 * deterministically known, this agent identifies the one page it CAN name for certain (from PageContext,
 * already-known, never invented) and explains in `reasoning` why no destination/anchor is proposed, rather
 * than inventing one or fabricating a fake "fix".
 */

const AGENT_NAME = 'internal-link-agent';
const INTERNAL_LINK_ISSUE_TYPES = new Set(['orphan-page', 'broken-internal-link', 'link-to-redirect']);

function makeFinding({ issueId, pageId, confidence, proposedType, proposedValue, reasoning }) {
  return {
    agentName: AGENT_NAME,
    issueId,
    confidence,
    evidence: [
      { source: 'analyzer', ref: issueId },   // the flagged issue itself — server/seo/pageAnalyzer.js
      { source: 'crawl', ref: pageId },        // the one real page this finding could deterministically identify — server/seo/crawler.js
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
export function internalLinkAgent({ auditContext, pages, issues, previousRecommendations } = {}) {
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
    // websiteId/auditId over whatever the input array happens to hold, same as the other specialists.
    if (issue.websiteId != null && ctxWebsiteId != null && issue.websiteId !== ctxWebsiteId) continue;
    if (issue.auditId != null && ctxAuditId != null && issue.auditId !== ctxAuditId) continue;

    if (!INTERNAL_LINK_ISSUE_TYPES.has(issue.type)) continue;   // not this agent's responsibility

    const page = issue.pageId != null ? pageById.get(issue.pageId) : undefined;
    // Every branch below needs at least the one real page this issue is tied to — with no PageContext for
    // it, there is nothing this agent can safely name, so it reports nothing rather than guess.
    if (!page || typeof page.url !== 'string' || !page.url) continue;

    if (issue.type === 'orphan-page') {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'internal-link-target', proposedValue: page.url,
        reasoning: 'This page has no known inbound internal links from the pages that were crawled. It is identified here as the page that needs at least one inbound link — no source page or anchor text is proposed, since the crawl data does not establish which existing page would be a relevant, safe place to add one.',
      }));
      continue;
    }

    if (issue.type === 'broken-internal-link') {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'broken-link-review', proposedValue: page.url,
        reasoning: "This page contains at least one internal link to a broken destination. The specific broken link and its target are not exposed to this agent in a structured, reusable form, so no replacement destination is proposed — this page is identified for a human to review its outbound links directly.",
      }));
      continue;
    }

    if (issue.type === 'link-to-redirect') {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'link-to-redirect-review', proposedValue: page.url,
        reasoning: 'This page contains at least one internal link to a URL that redirects elsewhere. The specific final redirect destination is not exposed to this agent in a structured, reusable form, so no replacement link target is proposed — this page is identified for a human to review and update the link directly.',
      }));
      continue;
    }
  }
  return findings;
}
