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
 * project already produces: server/db.js (seo_audits/pages/seo_issues/seo_recommendations rows),
 * server/seo/crawler.js (crawlWebsite() output) and server/seo/limits.js (crawlLimits()),
 * server/seo/pageAnalyzer.js (analyzePages()'s issue() shape), server/seo/recommendations.js (the existing
 * recommendation type vocabulary), and server/seo/jobs.js (the audit lifecycle, issueKey()).
 * AgentFinding, Evidence, Confidence and Priority describe no table that exists today — they are the
 * anticipated shape a specialist agent would hand to an orchestrator, upstream of the existing
 * Issue -> AgentFinding -> Orchestrator -> Recommendation -> Human Approval -> Apply pipeline.
 */

/**
 * The context one audit run provides to any agent working over it — assembled from a seo_audits row
 * (server/db.js) plus the crawl facts that produced it (server/seo/crawler.js's crawlWebsite() result and
 * server/seo/limits.js's crawlLimits()).
 *
 * websiteId is an EXISTING persisted value (seo_audits.website_id) and MUST remain explicit on every
 * AuditContext an agent is given. Agents must never silently fall back to a global/default website — see
 * AGENT_SAFETY_INVARIANTS.websiteIdMustBeExplicit.
 *
 * @typedef {Object} AuditContext
 * @property {number} websiteId - seo_audits.website_id — existing persisted value; MUST remain explicit, never defaulted or inferred
 * @property {number} auditId - seo_audits.id — identifies the current audit an agent is working within
 * @property {string} startedAt - seo_audits.started_at (ISO-8601) — existing persisted value
 * @property {string} baseUrl - seo_audits.base_url — existing persisted value, the crawl's starting URL
 * @property {{maxPages: number, maxDepth: number, requestTimeoutMs: number, crawlDelayMs: number}} limits - runtime context, not a persisted column: the crawlLimits() bounds (server/seo/limits.js) the crawl that produced this audit ran under (seo_audits.pages_planned is the persisted snapshot of limits.maxPages captured at queue time)
 * @property {({available: true, performanceScore: number, fetchedAt: string} | {available: false, reason: string} | null)} [pagespeed] - seo_audits.pagespeed — existing persisted value, exactly as server/seo/pagespeed.js's fetchPageSpeed() returned it for the audit's single start/base URL (never per-page, never re-derived); `null` when no PageSpeed result was ever stored for this audit (the same absence server/db.js's own row-shaper already produces). Added in Step 4P-B purely as data exposure — no issue type, threshold, or specialist agent currently reads this field
 */

/**
 * The current known facts for one crawlable URL — a pages row (server/db.js), always reflecting that
 * page's MOST RECENT crawl (per-audit history instead lives in seo_issues/page_links via audit_id).
 *
 * Agents receive this EXISTING, already-crawled data. They do not independently crawl the website — only
 * server/seo/crawler.js does that, and only as part of an audit job (server/seo/jobs.js).
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
 * @property {string|null} recommendation - a short, deterministic remediation hint (not an AI Recommendation — see below)
 */

/**
 * How sure an agent is about one AgentFinding, expressed as a coarse label rather than a bare number —
 * consistent with this project's existing string-enum style (Issue.severity, Recommendation.status).
 *
 * Confidence is informational only. It must never, by itself or at any level, bypass human approval — every
 * AgentFinding still flows through Orchestrator -> Recommendation -> Human Approval like any other proposal.
 *
 * @typedef {'low'|'medium'|'high'} Confidence
 */

/**
 * How urgently a Recommendation should be surfaced to a human reviewer. Priority is an ORCHESTRATOR-DERIVED
 * concept, not something any individual agent decides: the future orchestrator derives it from the existing
 * Issue.severity plus the relevant AgentFinding's Confidence. Agents must not set or propose their own
 * Priority — note that AgentFinding, below, intentionally has no priority field.
 *
 * @typedef {'critical'|'warning'|'info'} Priority
 */

/**
 * One reference back to data the system has already collected — never a new artifact an agent invents.
 * Keeps agent reasoning traceable: every AgentFinding must be able to point at where its evidence came
 * from, using data an existing subsystem already produced for this audit.
 *
 * @typedef {Object} Evidence
 * @property {'crawl'|'analyzer'|'pagespeed'} source - which existing subsystem produced the referenced fact: server/seo/crawler.js, server/seo/pageAnalyzer.js, or server/seo/pagespeed.js
 * @property {string|number} ref - a pointer into that subsystem's already-collected output (e.g. a pageId, an Issue id, or a specific field name) — never new data the agent asserts on its own authority
 */

/**
 * What one specialist agent hands to an orchestrator about one EXISTING Issue — a transient, in-memory
 * concept that exists only during orchestration. It is NOT persisted in a new table, and an agent never
 * writes one anywhere itself.
 *
 * Agents do NOT write recommendations directly, do NOT approve or apply recommendations, and do NOT modify
 * website content. The future orchestrator alone decides whether an AgentFinding becomes a Recommendation,
 * created through the existing mechanism (store.createRecommendation() in server/db.js) — see
 * AGENT_SAFETY_INVARIANTS.
 *
 * @typedef {Object} AgentFinding
 * @property {string} agentName - the specialist agent's identifier, e.g. 'content-agent', 'technical-agent'
 * @property {number} issueId - seo_issues.id — the EXISTING issue this finding concerns; an agent works against already-detected issues, it does not invent new issue types
 * @property {Confidence} confidence - how sure the agent is — see Confidence
 * @property {Evidence[]} evidence - the already-collected facts this finding is grounded in — never empty
 * @property {string} proposedType - mirrors the existing recommendation type vocabulary (server/seo/recommendations.js's RECOMMENDATION_TYPE_BY_ISSUE: 'title' | 'description' | 'heading' | 'content' | 'internal-link' | 'schema')
 * @property {string} proposedValue - the agent's proposed replacement value, in the same shape Recommendation.proposedValue already takes for that type
 * @property {string} reasoning - a plain-language justification, in the same spirit as the existing Recommendation.reasoning field
 */

/**
 * The EXISTING, already-implemented outcome of the pipeline — a seo_recommendations row (server/db.js).
 * Documented here only so future agent/orchestrator code has one shared name for it; this typedef changes
 * nothing about how recommendations are created, reviewed, applied, or verified (server/seo/apply.js,
 * server/seo/jobs.js's verifyAppliedRecommendations()). Only the orchestrator — never an individual agent —
 * may cause one of these to be created, and only through the existing store.createRecommendation()
 * mechanism.
 *
 * @typedef {Object} Recommendation
 * @property {number} id - seo_recommendations.id
 * @property {number} websiteId - seo_recommendations.website_id
 * @property {number} issueId - seo_recommendations.issue_id — the reliable link back to the originating Issue (NOT NULL)
 * @property {number|null} pageId - seo_recommendations.page_id
 * @property {string} type - seo_recommendations.type — 'title' | 'description' | 'heading' | 'content' | 'internal-link' | 'schema'
 * @property {string|null} currentValue - seo_recommendations.current_value
 * @property {string|null} proposedValue - seo_recommendations.proposed_value
 * @property {string|null} reasoning - seo_recommendations.reasoning
 * @property {string|null} aiProvider - seo_recommendations.ai_provider
 * @property {string|null} aiModel - seo_recommendations.ai_model
 * @property {'pending'|'approved'|'rejected'|'applied'|'failed'} status - seo_recommendations.status
 * @property {string} createdAt - seo_recommendations.created_at (ISO-8601)
 * @property {string|null} reviewedAt - seo_recommendations.reviewed_at (ISO-8601)
 * @property {string|null} reviewedBy - seo_recommendations.reviewed_by
 * @property {string|null} appliedAt - seo_recommendations.applied_at (ISO-8601)
 * @property {'resolved'|'still-present'|'unknown'|null} verifiedStatus - seo_recommendations.verified_status
 * @property {string|null} verifiedAt - seo_recommendations.verified_at (ISO-8601)
 * @property {number|null} verifiedAuditId - seo_recommendations.verified_audit_id
 */

/**
 * Safety invariants for any future agent built against these contracts. Restates, without changing, the
 * safety boundary established across Phase 2–3 and the Phase 3 Step 3 architecture audit. This constant is
 * documentation an implementer can import and read — it enforces nothing by itself; the actual enforcement
 * remains the existing human-approval gate in server/seo/routes.js and the existing safe-apply allowlist in
 * server/seo/apply.js.
 */
export const AGENT_SAFETY_INVARIANTS = Object.freeze({
  pipeline: Object.freeze([
    'Agent', 'AgentFinding', 'Orchestrator', 'Recommendation', 'Human Approval',
    'Existing Safe Apply', 'Re-scan', 'Existing Verification',
  ]),
  websiteIdMustBeExplicit: 'websiteId MUST remain explicit on every AuditContext, PageContext, and Issue an agent reads. Agents must never silently fall back to a global or default website.',
  confidenceNeverBypassesApproval: 'Confidence is informational only. It must never, by itself or at any level, bypass human approval.',
  priorityIsOrchestratorDerived: 'Priority is derived by the orchestrator from the existing Issue.severity plus Confidence. Individual agents do not decide the final Priority.',
  agentsMay: Object.freeze([
    'Read crawl context (AuditContext).',
    'Read page context (PageContext).',
    'Read existing issues (Issue).',
    'Read relevant recommendation/history context (Recommendation).',
    'Produce transient findings (AgentFinding).',
  ]),
  agentsMustNot: Object.freeze([
    'Crawl.',
    'Re-crawl.',
    'Modify content.',
    'Directly create recommendations.',
    'Approve recommendations.',
    'Apply recommendations.',
    'Trigger recursive scans.',
    'Bypass human approval.',
  ]),
  orchestratorResponsibility: Object.freeze([
    'Provide shared context.',
    'Select applicable agents.',
    'Collect findings.',
    'Deduplicate findings.',
    'Detect conflicts.',
    'Create the final recommendation through the existing recommendation mechanism.',
  ]),
});
