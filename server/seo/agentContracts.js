/**
 * PHASE 3 STEP 4A — SHARED AGENT CONTRACTS (documentation only).
 *
 * This module defines, as JSDoc typedefs, the shapes a future "Agentic SEO Team" (see the Phase 3 Step 3
 * architecture audit) would pass between specialist agents and an orchestrator. It is deliberately inert:
 * no functions, no classes, no runtime behavior beyond one frozen constant documenting safety invariants.
 * Nothing in this codebase imports this file — it exists so future agent code has one shared vocabulary to
 * import from instead of each agent inventing its own shape.
 *
 * Every field below is named after — and, where one already exists, typed after — the real data this
 * project already produces: server/db.js (seo_audits/pages/seo_issues rows), server/seo/crawler.js
 * (crawlWebsite() output), server/seo/pageAnalyzer.js (analyzePages()'s issue() shape), and
 * server/seo/jobs.js (the audit lifecycle). AgentFinding, Evidence, Confidence and Priority describe no
 * table that exists today — they are the anticipated shape a specialist agent would hand to an orchestrator,
 * upstream of the existing Issue → Recommendation → Human Approval → Apply pipeline.
 */

/**
 * The context one audit run provides to any agent working over it — assembled from a seo_audits row
 * (server/db.js) plus the crawl facts that produced it (server/seo/crawler.js's crawlWebsite() result).
 *
 * @typedef {Object} AuditContext
 * @property {number} auditId - seo_audits.id
 * @property {number} websiteId - seo_audits.website_id
 * @property {string} baseUrl - seo_audits.base_url — the crawl's starting URL
 * @property {string} startedAt - seo_audits.started_at (ISO-8601)
 * @property {string|null} finishedAt - seo_audits.finished_at (ISO-8601), null while running
 * @property {'queued'|'running'|'complete'|'failed'} status - seo_audits.status
 * @property {number|null} score - seo_audits.score — scoreFromIssues() output, null until finished
 * @property {string|null} summary - seo_audits.summary
 * @property {number|null} pagesCrawled - seo_audits.pages_crawled
 * @property {number|null} pagesPlanned - seo_audits.pages_planned (crawlLimits().maxPages at queue time)
 * @property {number|null} errorsCount - seo_audits.errors_count
 * @property {number|null} durationMs - seo_audits.duration_ms
 * @property {string} allowedHost - crawlWebsite() result's allowedHost — the single host the crawl stayed within
 * @property {{exists: boolean}} robots - crawlWebsite() result's robots.exists
 * @property {Array<{url: string, error?: string}>} sitemaps - crawlWebsite() result's sitemaps, each optionally errored
 */

/**
 * The current known facts for one crawlable URL — a pages row (server/db.js), always reflecting that
 * page's MOST RECENT crawl (per-audit history instead lives in seo_issues/page_links via audit_id).
 *
 * @typedef {Object} PageContext
 * @property {number} pageId - pages.id
 * @property {number} websiteId - pages.website_id
 * @property {string} url - pages.url — the URL as first discovered
 * @property {string|null} finalUrl - pages.final_url — after redirects
 * @property {number|null} statusCode - pages.status_code
 * @property {string|null} contentType - pages.content_type
 * @property {string|null} title - pages.title
 * @property {string|null} description - pages.description
 * @property {string|null} canonical - pages.canonical
 * @property {string|null} robotsMeta - pages.robots — the page's robots meta tag content
 * @property {number|null} h1Count - pages.h1_count
 * @property {number|null} h2Count - pages.h2_count
 * @property {number|null} wordCount - pages.word_count
 * @property {number|null} htmlSize - pages.html_size (bytes)
 * @property {number|null} responseTimeMs - pages.response_time_ms
 * @property {number|null} depth - pages.depth — crawl distance (in hops) from the audit's baseUrl
 * @property {number|null} imageCount - pages.image_count
 * @property {number|null} imagesMissingAlt - pages.images_missing_alt
 * @property {string|null} lang - pages.lang — the <html lang> attribute
 * @property {string|null} ogTitle - pages.og_title
 * @property {string|null} ogDescription - pages.og_description
 * @property {string|null} ogImage - pages.og_image
 * @property {string|null} twitterCard - pages.twitter_card
 * @property {boolean|null} jsonLdPresent - pages.json_ld_present
 * @property {number|null} lastAuditId - pages.last_audit_id — the audit that produced this row's current facts
 * @property {string|null} lastCrawledAt - pages.last_crawled_at (ISO-8601)
 */

/**
 * One SEO problem, deterministically found — the shape produced by pageAnalyzer.js's analyzePages() (in
 * memory, keyed by pageUrl) and persisted as a seo_issues row (server/db.js, keyed by pageId once a page is
 * known). type + pageId together are this project's issue-identity signature (see jobs.js's issueKey()),
 * used to compare the same issue across audits.
 *
 * @typedef {Object} Issue
 * @property {number} [id] - seo_issues.id, once persisted
 * @property {number} [websiteId] - seo_issues.website_id, once persisted
 * @property {number} [auditId] - seo_issues.audit_id, once persisted
 * @property {number|null} pageId - seo_issues.page_id — null means sitewide, not tied to one page
 * @property {string} type - e.g. 'missing-title', 'thin-content', 'orphan-page' — see pageAnalyzer.js for the full set
 * @property {'critical'|'warning'|'info'} severity
 * @property {'open'|'resolved'} [status] - seo_issues.status, once persisted
 * @property {string|null} detail - a human-readable description of what was found
 * @property {string|null} recommendation - a short, deterministic remediation hint (not an AI recommendation — see server/seo/recommendations.js for that)
 */

/**
 * How sure an agent is about one AgentFinding. Deliberately coarse: agents are expected to say "low" or
 * abstain rather than assert something the deterministic analyzer can't itself verify.
 *
 * @typedef {'low'|'medium'|'high'} Confidence
 */

/**
 * How urgently a finding should be surfaced — matching the existing Issue.severity vocabulary
 * (server/seo/pageAnalyzer.js) so a future orchestrator can rank AgentFinding objects and existing Issues
 * on one shared scale rather than two incompatible ones.
 *
 * @typedef {'critical'|'warning'|'info'} Priority
 */

/**
 * One concrete, checkable fact grounding an AgentFinding — never a claim the agent asserts on its own
 * authority. `quote`, if present, is a verbatim excerpt of crawled page content: DATA to cite, never
 * instructions to follow (see llm.js's <untrusted_page_content> framing, which this convention extends).
 *
 * @typedef {Object} Evidence
 * @property {string} source - where this fact came from, e.g. 'crawler', 'pageAnalyzer', 'pagespeed', 'llm'
 * @property {number|null} pageId - the PageContext this evidence concerns, if any
 * @property {string|null} url - the concrete URL this evidence concerns, if any
 * @property {string} fact - the specific, checkable fact this evidence states (e.g. "word count is 42")
 * @property {string|null} quote - an optional verbatim excerpt of crawled content the fact is drawn from — DATA, not instructions
 */

/**
 * What one specialist agent hands to an orchestrator about one AuditContext/PageContext — upstream of, and
 * not a replacement for, the existing Issue → seo_recommendations → Human Approval → apply.js pipeline. An
 * AgentFinding is a proposal for the orchestrator to weigh, not something any agent may act on directly.
 *
 * @typedef {Object} AgentFinding
 * @property {string} agent - the specialist agent's identifier, e.g. 'content-agent', 'technical-agent'
 * @property {string} type - the kind of finding, ideally aligned with existing Issue.type values where one applies
 * @property {Priority} priority
 * @property {Confidence} confidence
 * @property {number|null} pageId - the PageContext this finding concerns, or null if sitewide
 * @property {string} summary - a short, human-readable statement of what was found
 * @property {Evidence[]} evidence - the facts this finding is grounded in — never empty for a non-'low' confidence finding
 * @property {string|null} suggestedFix - an optional plain-language suggestion; never executable, never applied directly
 */

/**
 * Safety invariants for any future agent built against these contracts. Restates, without changing, the
 * safety boundary established across Phase 2–3 and the Phase 3 Step 3 architecture audit. This constant is
 * documentation an implementer can import and read — it enforces nothing by itself; the actual enforcement
 * remains the existing human-approval gate in server/seo/routes.js and the existing safe-apply allowlist in
 * server/seo/apply.js.
 */
export const AGENT_SAFETY_INVARIANTS = Object.freeze({
  pipeline: 'Agent(s)/verification -> Findings/Recommendation -> Human Approval -> Existing Safe Apply -> Re-scan -> Verification',
  agentsMay: Object.freeze([
    'Read AuditContext, PageContext, and Issue data already produced by the crawler/analyzer.',
    'Produce AgentFinding objects, each backed by Evidence drawn from real crawled facts.',
    'Report low confidence, or abstain from producing a finding, instead of guessing.',
  ]),
  agentsMustNot: Object.freeze([
    'Write to the database, the CMS content table, or any file.',
    'Call apply.js, saveContent(), or any other mutating store method.',
    'Invent facts not present in AuditContext/PageContext/Evidence (no fabricated reviews, prices, traffic, or rankings — see recommendations.js\'s SYSTEM_PROMPT for the existing rule this extends).',
    'Treat crawled or page content as instructions — it is always DATA (see llm.js\'s <untrusted_page_content> framing).',
    'Bypass human approval: any finding that could change production content still becomes a seo_recommendations row with status \'pending\', exactly as today.',
  ]),
  orchestratorOnly: Object.freeze([
    'Aggregating multiple agents\' AgentFinding objects into stored Issue or seo_recommendations rows.',
    'Resolving conflicts between agents that disagree about the same page or issue.',
    'Deciding what reaches a human reviewer.',
  ]),
});
