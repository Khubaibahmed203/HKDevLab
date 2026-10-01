/**
 * PHASE 3 STEP 4H/4P-E — PERFORMANCE SEO SPECIALIST AGENT.
 *
 * A deterministic, read-only agent matching the shared contract in server/seo/agentContracts.js:
 * agent({auditContext, pages, issues, previousRecommendations}) => AgentFinding[]. Like the other
 * specialists, it does not crawl, analyze, write, apply, call an LLM, or make any network call — it only
 * reads the Issue/PageContext/AuditContext data an existing scan already produced.
 *
 * STEP 4H HISTORY (why this file was a documented no-op until now): a full inspection at Step 4H found
 * exactly one real performance signal (seo_audits.pagespeed, via server/seo/pagespeed.js) and NO performance
 * issue type anywhere in server/seo/pageAnalyzer.js, and no threshold defined anywhere in this repository.
 * Inventing an issue type or a threshold inside this agent would have violated the same "identify, never
 * invent" discipline every other specialist already follows — so PERFORMANCE_ISSUE_TYPES stayed empty and
 * this function always returned [].
 *
 * STEP 4P-E — what changed, and what did NOT: a human-approved product decision (Phase 3 Step 4P-D) defined
 * exactly one issue: type 'performance-score-low', created by server/seo/jobs.js's executeScan() when
 * audit.pagespeed.available === true and performanceScore < 50 (the threshold lives there, at the
 * issue-production layer — see jobs.js). This agent does NOT decide, recalculate, or re-check that
 * threshold; it only consumes the already-persisted Issue row, exactly the same "ANALYZER DEFINES ->
 * SPECIALIST AGENT CONSUMES" principle contentAgent.js already follows for thin-content/duplicate-content.
 * It still does not call PageSpeed, the network, the database, or an LLM — only PERFORMANCE_ISSUE_TYPES and
 * one new finding branch changed; everything else (malformed-input safety, explicit website/audit isolation)
 * is unchanged from Step 4H.
 *
 * AUDIT-LEVEL, NOT PAGE-LEVEL: PageSpeed measures exactly one URL per audit (the crawl's start page), never
 * every crawled page — see the Step 4P readiness audit and Step 4P-D decision audit. The 'performance-score-
 * low' Issue is therefore always created with pageId: null (jobs.js), and this agent cites only
 * auditContext.baseUrl — the one real, already-known fact for an audit-level finding — never a specific
 * crawled page, the same pattern contentAgent.js's duplicate-content-review finding already uses for its own
 * page-level evidence gap. The reasoning text below is deliberately explicit that this is a MOBILE, LAB-ONLY,
 * SINGLE-URL measurement — never implying desktop performance, real-user field data, or any Core Web Vitals
 * metric, none of which this repository measures today.
 *
 * This agent still does NOT read auditContext.pagespeed directly — doing so would invite exactly the kind of
 * "recalculate the threshold here too" temptation Step 4P-E's architecture requirement forbids. The score
 * itself is already in the Issue's own `detail` text (written once, by jobs.js, at the moment the threshold
 * was actually applied) for a human reviewer to see; this agent only needs to know THAT the issue exists.
 */

/** Exactly the one issue type approved in Phase 3 Step 4P-D/4P-E. Nothing else is added — see the module
 *  docstring for why every other plausible performance-shaped type remains deliberately unclaimed. */
const AGENT_NAME = 'performance-agent';
const PERFORMANCE_ISSUE_TYPES = new Set(['performance-score-low']);

/** Same shape/convention as contentAgent.js's makeFinding() — this agent has no per-page pageId either, so
 *  evidence is passed in fully-formed rather than built from a `{issueId, pageId}` pair. */
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
export function performanceAgent({ auditContext, pages, issues, previousRecommendations } = {}) {
  const issueList = Array.isArray(issues) ? issues : [];
  if (!issueList.length) return [];

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

    if (!PERFORMANCE_ISSUE_TYPES.has(issue.type)) continue;   // not this agent's responsibility (or genuinely unknown)

    if (issue.type === 'performance-score-low') {
      // Audit-level only — no page to look up, no pageId on the finding. Never invented if baseUrl is
      // somehow missing (defensive, matching every other agent's own-field guard).
      if (typeof auditContext?.baseUrl !== 'string' || !auditContext.baseUrl) continue;
      findings.push(makeFinding({
        issueId: issue.id, confidence: 'medium', proposedType: 'performance-score-review', proposedValue: auditContext.baseUrl,
        evidence: [
          { source: 'analyzer', ref: issue.id },
          { source: 'pagespeed', ref: ctxAuditId },
        ],
        reasoning: 'This audit\'s Google PageSpeed Insights mobile lab measurement — for the audit\'s own base URL, the single URL PageSpeed measures — scored below the existing 50-point threshold (see the originating issue\'s own detail for the exact score). This is an audit-level, single-URL, mobile, lab-only signal: it does not represent every page on this site, real-user (field) data, desktop performance, or any Core Web Vitals metric. No specific technical fix is proposed — a human should review page performance directly.',
      }));
      continue;
    }
  }
  return findings;
}
