/**
 * PHASE 3 STEP 4F — SCHEMA SEO SPECIALIST AGENT.
 *
 * A deterministic, read-only agent matching the shared contract in server/seo/agentContracts.js:
 * agent({auditContext, pages, issues, previousRecommendations}) => AgentFinding[]. Like the other
 * specialists (Steps 4C/4D/4E), it does not crawl, analyze, write, apply, call an LLM, or make any network
 * call — it only reads the Issue/PageContext data an existing scan already produced.
 *
 * NOT wired into server/seo/jobs.js or the orchestrator's agent list — this step only makes the agent
 * itself exist and be individually testable (see server/test-seo-schema-agent.mjs).
 *
 * OWNERSHIP: 'missing-json-ld', 'invalid-json-ld' — the only two structured-data issue types
 * server/seo/pageAnalyzer.js's analyzePages() produces (copied verbatim, confirmed by inspection):
 *   `if (!p.jsonLdPresent) issue('missing-json-ld', ...); else if (!p.jsonLdValid) issue('invalid-json-ld', ...);`
 * 'missing-json-ld' also appears in recommendations.js's RECOMMENDATION_TYPE_BY_ISSUE (mapped to 'schema'),
 * but that map only exists for the LLM recommendation route and does not cover 'invalid-json-ld' at all —
 * so, like technicalAgent.js/internalLinkAgent.js, this agent declares its own small explicit ownership set.
 *
 * EXISTING SITE SCHEMA (Step 7 of the Step 4F spec): the site's one page already gets real, CMS-driven
 * JSON-LD injected server-side by content/seo.js's buildJsonLd() (a 'ProfessionalService' object built from
 * name/url/description/email/serviceType — explicitly never inventing reviews, ratings, address or prices,
 * per that file's own comment) and injectSeo(). This agent does not import, call, or change that — it has
 * no access to the CMS `content` document buildJsonLd() needs (AuditContext/PageContext carry crawled
 * facts, never the raw CMS document), so it could not safely reconstruct or validate that payload even if
 * it wanted to. Confirmed by inspection, not assumed.
 *
 * *** IMPORTANT LIMITATION DISCOVERED DURING INSPECTION (Step 3/6 of the Step 4F spec) ***
 * server/seo/extract.js computes `jsonLdValid` (whether every <script type="application/ld+json"> block on
 * the page parses) but that fact is NEVER persisted: server/db.js's `pages` table only stores
 * `json_ld_present` — there is no `json_ld_valid` column, and PageContext (server/seo/agentContracts.js)
 * only documents `jsonLdPresent`. So once a scan finishes, the only lasting evidence that JSON-LD was
 * invalid is the existence of the 'invalid-json-ld' Issue row itself (and its free-text `detail`, e.g.
 * "https://example.com/ has invalid JSON-LD.") — never the raw JSON-LD text or the specific parse error.
 * This agent never invents a corrected payload to fill that gap. For both 'missing-json-ld' and
 * 'invalid-json-ld', it identifies the one real, already-known fact it safely can — which page is affected
 * (from PageContext.url) — and explains in `reasoning` why no schema payload or correction is proposed,
 * rather than fabricating one. See also onPageAgent.js/technicalAgent.js/internalLinkAgent.js, which use
 * the identical "identify the known subject, never invent the fix" pattern wherever the underlying data
 * doesn't support a concrete proposed correction.
 */

const AGENT_NAME = 'schema-agent';
const SCHEMA_ISSUE_TYPES = new Set(['missing-json-ld', 'invalid-json-ld']);

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
export function schemaAgent({ auditContext, pages, issues, previousRecommendations } = {}) {
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

    if (!SCHEMA_ISSUE_TYPES.has(issue.type)) continue;   // not this agent's responsibility — e.g. an
    // On-Page/Technical/Internal-Link/Content/Performance issue, or anything genuinely unknown

    const page = issue.pageId != null ? pageById.get(issue.pageId) : undefined;
    // Every branch below needs the one real page this issue is tied to — with no PageContext for it, there
    // is nothing this agent can safely name, so it reports nothing rather than guess.
    if (!page || typeof page.url !== 'string' || !page.url) continue;

    if (issue.type === 'missing-json-ld') {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'structured-data-opportunity', proposedValue: page.url,
        reasoning: "This page has no structured data (JSON-LD). It is identified here as a structured-data opportunity — no schema payload is proposed, since this agent has no access to the business/content data (organization details, services, contact info, etc.) a real JSON-LD object would need, and inventing one would risk publishing false structured data.",
      }));
      continue;
    }

    if (issue.type === 'invalid-json-ld') {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'structured-data-review', proposedValue: page.url,
        reasoning: "This page's JSON-LD is present but fails to parse. It is identified here for a human to review and fix directly — no corrected payload is proposed, since the specific parse error and the raw invalid JSON-LD text are not exposed to this agent in a structured, reusable form (only an aggregate 'present' flag is persisted past the scan itself).",
      }));
      continue;
    }
  }
  return findings;
}
