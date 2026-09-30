import { recommendationTypeForIssue } from './recommendations.js';

/**
 * PHASE 3 STEP 4G — CONTENT SEO SPECIALIST AGENT.
 *
 * A deterministic, read-only ANALYSIS agent matching the shared contract in server/seo/agentContracts.js:
 * agent({auditContext, pages, issues, previousRecommendations}) => AgentFinding[]. Like the other
 * specialists (Steps 4C–4F), it does not crawl, analyze, write, apply, call an LLM, or make any network
 * call — it only reads the Issue/PageContext data an existing scan already produced. It is NOT a content
 * writer: it never generates article copy, paragraphs, titles, meta descriptions, keywords, anchor text, or
 * FAQs — it only identifies content-quality problems the existing deterministic analyzer already found.
 *
 * NOT wired into server/seo/jobs.js or the orchestrator's agent list — this step only makes the agent
 * itself exist and be individually testable (see server/test-seo-content-agent.mjs).
 *
 * OWNERSHIP: 'thin-content' and 'duplicate-content' — the only two content-quality issue types
 * server/seo/pageAnalyzer.js's analyzePages() produces (confirmed by inspection). Unlike
 * technicalAgent.js/internalLinkAgent.js/schemaAgent.js, this agent CAN reuse recommendations.js's
 * RECOMMENDATION_TYPE_BY_ISSUE for ownership — both types are already mapped there, to 'content' — so no
 * separate local ownership map duplicates that classification. Its OUTPUT proposedType is still distinct
 * ('thin-content-review' / 'duplicate-content-review', not the bare 'content' recommendations.js uses) —
 * see the "IDENTIFY, NEVER GENERATE" note below for why.
 *
 * IDENTIFY, NEVER GENERATE: this agent never proposes a proposedValue that IS replacement content — Step 6
 * of the Step 4G spec is explicit that this is an analysis agent, not a writer, and Step 7 explicitly
 * forbids inventing replacement content, a duplicate-page relationship, or a canonical choice. Every
 * finding below only ever identifies a real, already-known page (from PageContext.url) or, when even that
 * is unavailable, the audit's own real base URL — reusing distinct proposedType names
 * ('thin-content-review'/'duplicate-content-review') rather than recommendations.js's plain 'content', so a
 * future orchestrator can never mistake "this page needs review" for "here is the replacement copy".
 *
 * *** IMPORTANT LIMITATION DISCOVERED DURING INSPECTION (Step 3/8 of the Step 4G spec) ***
 * For 'duplicate-content', pageAnalyzer.js calls its `issue()` helper WITHOUT a pageUrl argument
 * (`issue('duplicate-content', 'warning', ..., 'Differentiate the content or canonicalize one page as the
 * source.')` — only 4 args; `pageUrl` defaults to null) — so this Issue's `pageId` is ALWAYS null. The
 * actual duplicate URLs exist only inside the issue's free-text `detail` (e.g. "3 pages have near-identical
 * visible content: <url1>, <url2>, <url3>"), and the underlying `contentHash` signal that detected the
 * duplication (server/seo/extract.js) is never persisted to the `pages` table or exposed via PageContext at
 * all. This agent never parses that free text to invent a page relationship (Step 8 explicitly forbids
 * it) — for 'duplicate-content' it can only identify the audit's own site (auditContext.baseUrl), never a
 * specific duplicate page or a canonical choice, consistent with "report the issue conservatively without
 * inventing the duplicate page."
 */

const AGENT_NAME = 'content-agent';
const THIN_CONTENT_MIN_WORDS = 50;   // matches pageAnalyzer.js's own threshold: `p.wordCount < 50`

function makeFinding({ issueId, confidence, evidence, proposedType, proposedValue, reasoning }) {
  return {
    agentName: AGENT_NAME,
    issueId,
    confidence,
    evidence,
    proposedType,
    proposedValue,
    reasoning,
  };
}

/**
 * @param {{auditContext: import('./agentContracts.js').AuditContext, pages: import('./agentContracts.js').PageContext[], issues: import('./agentContracts.js').Issue[], previousRecommendations: import('./agentContracts.js').Recommendation[]}} input
 * @returns {import('./agentContracts.js').AgentFinding[]}
 */
export function contentAgent({ auditContext, pages, issues, previousRecommendations } = {}) {
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

    // recommendations.js's RECOMMENDATION_TYPE_BY_ISSUE already maps both 'thin-content' and
    // 'duplicate-content' to 'content' — reused here purely as an ownership check (not as this agent's own
    // proposedType — see the "IDENTIFY, NEVER GENERATE" module note above).
    if (recommendationTypeForIssue(issue.type) !== 'content') continue;   // not this agent's responsibility

    if (issue.type === 'thin-content') {
      const page = issue.pageId != null ? pageById.get(issue.pageId) : undefined;
      if (!page || typeof page.url !== 'string' || !page.url) continue;
      if (typeof page.wordCount !== 'number' || page.wordCount >= THIN_CONTENT_MIN_WORDS) continue;   // independent re-check, same threshold pageAnalyzer.js uses
      findings.push(makeFinding({
        issueId: issue.id, confidence: 'medium', proposedType: 'thin-content-review', proposedValue: page.url,
        evidence: [{ source: 'analyzer', ref: issue.id }, { source: 'crawl', ref: page.pageId }],
        reasoning: `This page has only about ${page.wordCount} word(s) of visible text, below the ${THIN_CONTENT_MIN_WORDS}-word threshold. It is identified here as needing additional, genuinely useful content — no replacement text is proposed, since this agent never generates content.`,
      }));
      continue;
    }

    if (issue.type === 'duplicate-content') {
      // No page-level fact exists for this issue type (Issue.pageId is always null here — see the module's
      // limitation note above) — the only real, already-known fact this agent can cite is the audit's own
      // base URL, never a fabricated "duplicate page" or a chosen canonical.
      if (typeof auditContext?.baseUrl !== 'string' || !auditContext.baseUrl) continue;
      findings.push(makeFinding({
        issueId: issue.id, confidence: 'low', proposedType: 'duplicate-content-review', proposedValue: auditContext.baseUrl,
        evidence: [{ source: 'analyzer', ref: issue.id }],
        reasoning: 'The existing analyzer detected multiple pages on this site with near-identical visible content. The specific pages involved and which one (if any) should be canonical are not exposed to this agent in a structured, reusable form, so no duplicate page or canonical choice is proposed — a human should review the flagged pages directly.',
      }));
      continue;
    }
  }
  return findings;
}
