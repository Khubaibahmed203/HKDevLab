/**
 * PHASE 3 STEP 4H — PERFORMANCE SEO SPECIALIST AGENT.
 *
 * A deterministic, read-only agent matching the shared contract in server/seo/agentContracts.js:
 * agent({auditContext, pages, issues, previousRecommendations}) => AgentFinding[]. Like the other
 * specialists (Steps 4C–4G), it does not crawl, analyze, write, apply, call an LLM, or make any network
 * call — it only reads the Issue/PageContext/AuditContext data an existing scan already produced.
 *
 * *** STEP 17 SPECIAL SAFETY CHECK — OUTCOME C: NO USABLE STRUCTURED PERFORMANCE ISSUE DATA EXISTS ***
 * Full inspection of every file the Step 4H spec asked for (server/seo/pageAnalyzer.js,
 * server/seo/pagespeed.js, server/seo/jobs.js, server/db.js, server/seo/recommendations.js,
 * server/seo/agentContracts.js, server/admin/admin.js) found exactly one real performance signal, and no
 * performance issue type anywhere:
 *
 *   1. server/seo/pagespeed.js's fetchPageSpeed() optionally calls the real Google PageSpeed Insights API
 *      (only with PAGESPEED_API_KEY set) and returns { available, performanceScore (0-100), fetchedAt } or
 *      { available: false, reason }. This is the ONLY performance data in the whole codebase.
 *   2. It is fetched exactly ONCE per audit, for a single URL (the crawl's start page), in
 *      server/seo/jobs.js's executeScan() — AFTER analyzePages() has already run and every seo_issues row
 *      for that audit has already been created. It is stored only on the audit itself
 *      (seo_audits.pagespeed, a JSON column read back as AUDIT.pagespeed) — never per-page, never as an
 *      Issue row, and it is not part of PageContext.
 *   3. server/seo/pageAnalyzer.js's analyzePages() — confirmed by inspection — never references pagespeed,
 *      performanceScore, or any performance concept at all. It produces NO performance issue type. There is
 *      no 'low-performance-score'/'poor-cwv'/'slow-page' (or similarly named) issue anywhere in this
 *      repository, structured or otherwise.
 *   4. recommendations.js's RECOMMENDATION_TYPE_BY_ISSUE (the existing issue-type -> recommendation-type
 *      map every prior specialist has cross-checked against) has no performance entry either.
 *   5. AuditContext (server/seo/agentContracts.js, Step 4A) does not carry a pagespeed/performanceScore
 *      field — it was deliberately narrowed to exactly {websiteId, auditId, startedAt, baseUrl, limits} in
 *      the Step 4A correction commit. So even the one real signal that exists is not exposed through any of
 *      the three structures (AuditContext/PageContext/Issue) this agent's contract lets it read.
 *   6. No existing code anywhere defines a performance THRESHOLD or issue semantics (e.g. "a score below X
 *      is a problem") — only server/admin/admin.js reads audit.pagespeed directly, purely to print a
 *      read-only "Performance: N/100" line in the admin UI. Reusing that would mean inventing a threshold
 *      that does not exist today, which Step 6 of the Step 4H spec explicitly forbids ("If the repository
 *      only has a raw performance score with no existing issue semantics: report the limitation rather than
 *      creating a new scoring system").
 *
 * Conclusion: there is nothing here for a specialist AGENT (as opposed to a new measurement system) to
 * safely act on. Per Step 17 Outcome C, this module is a minimal, contract-compliant agent that currently
 * claims nothing and always returns []. It is NOT a bare stub: it keeps the exact same defensive shape as
 * every other specialist (malformed-input safety, explicit website/audit isolation, an explicit ownership
 * set) so that if a future step ever gives pageAnalyzer.js real performance issue semantics AND exposes the
 * pagespeed score through AuditContext, extending this file is a one-line addition to
 * PERFORMANCE_ISSUE_TYPES rather than a rewrite. It is deliberately NOT wired into server/seo/jobs.js or the
 * orchestrator's agent list (see server/test-seo-performance-agent.mjs for the tests proving all of this).
 */

/** Currently, and by design, empty — see the Step 17 Outcome C note above. No issue type in this
 *  repository represents a performance problem today, so nothing is listed here. This is not an oversight:
 *  adding a type here without real analyzer support would mean inventing a finding, which this agent must
 *  never do. */
const PERFORMANCE_ISSUE_TYPES = new Set([]);

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

    if (!PERFORMANCE_ISSUE_TYPES.has(issue.type)) continue;   // always true today — see the module docstring

    // Unreachable with the repository's current data model (PERFORMANCE_ISSUE_TYPES is empty). Left out
    // deliberately rather than writing a finding-construction helper that no real input can ever reach —
    // see server/test-seo-performance-agent.mjs for what this module's behavior actually proves today.
  }
  return findings;
}
