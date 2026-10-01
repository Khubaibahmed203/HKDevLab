/**
 * PHASE 3 STEP 4J — SPECIALIST FINDING -> RECOMMENDATION CONVERTER.
 *
 * Pipeline position (this module is the newest link, nothing downstream of it exists yet):
 *   Specialist Agent -> AgentFinding -> runOrchestrator() validation/merge/conflict-detection ->
 *   [THIS MODULE] -> recommendation-compatible objects -> (future step) store.createRecommendation() ->
 *   Human Approval -> Existing Safe Apply -> Re-scan -> Existing Verification.
 *
 * This module is a pure, synchronous, read-only preparation layer. It NEVER calls
 * store.createRecommendation() (no import of server/db.js at all), never applies anything (no import of
 * apply.js), never crawls, never calls an LLM, and is not imported by server/seo/jobs.js,
 * server/seo/routes.js, or server/seo/orchestrator.js — wiring this in is explicitly a later step.
 *
 * INPUT TRUST BOUNDARY: this converter only accepts the orchestrator's VALIDATED, MERGED output (the
 * `merged` array from runOrchestrator()'s return value — see server/seo/orchestrator.js's mergeGroup()),
 * never a raw AgentFinding[]. A raw AgentFinding has a singular `agentName` string and no `agentNames`
 * array; a genuine merged finding always has a non-empty `agentNames` array (mergeGroup() always sets it).
 * isWellFormedMergedFinding() below checks for exactly this shape, so a caller that mistakenly hands this
 * converter raw agent output (missing `agentNames`) gets every item safely rejected rather than silently
 * trusted. It also independently re-excludes anything present in an explicit `conflicts` collection, as a
 * second, defense-in-depth guard beyond trusting that the caller already separated `merged` from
 * `conflicts` correctly.
 *
 * CURRENT VALUE: this step's sharpest safety rule. The existing store.createRecommendation() /
 * recommendations.js (the LLM path) derive `currentValue` from the actual PageContext field being
 * replaced — `page.title` for a 'title' recommendation, `page.description` for a 'description' one (see
 * recommendations.js's generateRecommendation(): `currentValue = recType === 'title' ? (page?.title || '')
 * : recType === 'description' ? (page?.description || '') : ''`). This converter follows the SAME
 * field-derivation rule, but is DELIBERATELY STRICTER than that existing fallback: where the LLM path
 * defaults a missing value to an empty string, this converter treats a missing/empty current value as a
 * reason to produce NO recommendation at all, per this step's explicit instruction never to invent an
 * empty value merely to satisfy the database shape.
 *
 * SUPPORTED TYPES: only 'title' and 'description' — the only two of the 14 proposedType values the six
 * specialist agents can produce that server/seo/apply.js can actually execute today (confirmed by the
 * Step 4I audit's Safe Apply Matrix). Every other proposedType ('heading', 'canonical',
 * 'sitemap-inclusion', 'redirect-target', 'https-upgrade', 'internal-link-target', 'broken-link-review',
 * 'link-to-redirect-review', 'structured-data-opportunity', 'structured-data-review',
 * 'thin-content-review', 'duplicate-content-review', and anything else) is safely skipped, never converted,
 * never thrown — this module does not invent apply support that does not exist.
 *
 * PROVENANCE: a specialist-sourced recommendation must never claim an external LLM produced it.
 * seo_recommendations.ai_provider/ai_model are free-text columns (no DB-level enum), and are the one
 * existing, repository-compatible place to record non-LLM provenance without adding a new field or
 * touching the schema — see server/db.js's createRecommendation(). This converter sets
 * aiProvider: 'specialist-agent' and aiModel to the contributing agent name(s), joined — never 'anthropic',
 * never a real model id, and never left ambiguous between "no provenance recorded" (null, as the existing
 * LLM path uses when unavailable) and "a human should know this was NOT an LLM".
 */

const SUPPORTED_RECOMMENDATION_TYPES = new Set(['title', 'description']);
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

/** A genuine merged finding from runOrchestrator()'s `merged` array — never a raw AgentFinding (which has
 *  `agentName` singular, not `agentNames`). Mirrors the same defensive validation style every specialist
 *  agent already uses for its own untrusted input. */
function isWellFormedMergedFinding(f) {
  if (!f || typeof f !== 'object') return false;
  if (!Number.isInteger(f.issueId)) return false;
  if (!VALID_CONFIDENCE.has(f.confidence)) return false;
  if (!Array.isArray(f.agentNames) || !f.agentNames.length || !f.agentNames.every((n) => typeof n === 'string' && n)) return false;
  if (!Array.isArray(f.evidence) || !f.evidence.length) return false;
  if (typeof f.proposedType !== 'string' || !f.proposedType) return false;
  if (typeof f.proposedValue !== 'string' || !f.proposedValue.trim()) return false;
  if (typeof f.reasoning !== 'string' || !f.reasoning.trim()) return false;
  return true;
}

/** Only ever reads page.title / page.description — the exact fields the existing LLM recommendation path
 *  (recommendations.js) already treats as the source of truth for 'title'/'description' current values.
 *  Returns null (never '') when no trustworthy value exists, so the caller can refuse to invent one. */
function deriveCurrentValue(type, page) {
  if (type === 'title') return typeof page.title === 'string' && page.title.trim() ? page.title : null;
  if (type === 'description') return typeof page.description === 'string' && page.description.trim() ? page.description : null;
  return null;
}

/**
 * @param {Object} input
 * @param {import('./agentContracts.js').AuditContext} input.auditContext - trusted, authoritative; a finding/issue/page can never override its websiteId/auditId
 * @param {import('./agentContracts.js').PageContext[]} input.pages
 * @param {import('./agentContracts.js').Issue[]} input.issues
 * @param {Object[]} input.mergedFindings - the `merged` array from runOrchestrator()'s return value (never raw AgentFinding[])
 * @param {Object[]} [input.conflicts] - the `conflicts` array from the SAME runOrchestrator() call, if available — a defense-in-depth cross-check
 * @returns {{recommendations: Array<{websiteId:number, auditId:number, issueId:number, pageId:number, type:string, currentValue:string, proposedValue:string, reasoning:string, aiProvider:string, aiModel:string}>, skipped: Array<{issueId:(number|null), reason:string}>}}
 */
export function convertSpecialistFindings({ auditContext, pages, issues, mergedFindings, conflicts } = {}) {
  // Explicit context is non-negotiable — same rule runOrchestrator() itself enforces. No finding/issue may
  // ever override it, and there is no "default website" fallback here.
  if (!auditContext || !Number.isInteger(auditContext.websiteId) || !Number.isInteger(auditContext.auditId)) {
    throw new Error('convertSpecialistFindings requires an explicit AuditContext with numeric websiteId and auditId.');
  }

  const mergedList = Array.isArray(mergedFindings) ? mergedFindings : [];
  const issueList = Array.isArray(issues) ? issues : [];
  const pageList = Array.isArray(pages) ? pages : [];
  const conflictedIssueIds = new Set((Array.isArray(conflicts) ? conflicts : []).map((c) => c?.issueId).filter((id) => Number.isInteger(id)));

  const issueById = new Map(issueList.filter((i) => i && Number.isInteger(i.id)).map((i) => [i.id, i]));
  const pageById = new Map(pageList.filter((p) => p && Number.isInteger(p.pageId)).map((p) => [p.pageId, p]));

  const recommendations = [];
  const skipped = [];
  const seenIssueIds = new Set();
  const skip = (issueId, reason) => skipped.push({ issueId: Number.isInteger(issueId) ? issueId : null, reason });

  for (const finding of mergedList) {
    if (!isWellFormedMergedFinding(finding)) { skip(finding?.issueId, 'malformed-finding'); continue; }
    const { issueId } = finding;

    // Conflicted issues are excluded even if they somehow ended up in `mergedFindings` — never trust that
    // the caller already separated merged from conflicted perfectly; re-check explicitly.
    if (conflictedIssueIds.has(issueId)) { skip(issueId, 'conflicted'); continue; }

    // A second entry for an issueId already converted in this same call violates the orchestrator's own
    // "one merged result per issueId" contract — never silently produce two recommendations for it.
    if (seenIssueIds.has(issueId)) { skip(issueId, 'duplicate-issue'); continue; }

    const issue = issueById.get(issueId);
    if (!issue) { skip(issueId, 'unknown-issue'); continue; }

    // Never let a finding or its issue override the trusted audit context — reject any mismatch rather
    // than silently repairing or ignoring it.
    if (issue.websiteId != null && issue.websiteId !== auditContext.websiteId) { skip(issueId, 'website-mismatch'); continue; }
    if (issue.auditId != null && issue.auditId !== auditContext.auditId) { skip(issueId, 'audit-mismatch'); continue; }

    const type = finding.proposedType;
    if (!SUPPORTED_RECOMMENDATION_TYPES.has(type)) { skip(issueId, 'unsupported-type'); continue; }

    if (issue.pageId == null) { skip(issueId, 'missing-page'); continue; }   // e.g. a sitewide issue — title/description always need one specific page
    const page = pageById.get(issue.pageId);
    if (!page) { skip(issueId, 'missing-page'); continue; }
    if (page.websiteId != null && page.websiteId !== auditContext.websiteId) { skip(issueId, 'website-mismatch'); continue; }

    const currentValue = deriveCurrentValue(type, page);
    if (currentValue == null) { skip(issueId, 'missing-current-value'); continue; }   // never invent '' to satisfy the shape

    seenIssueIds.add(issueId);
    recommendations.push({
      websiteId: auditContext.websiteId,
      auditId: auditContext.auditId,
      issueId,
      pageId: page.pageId,
      type,
      currentValue,                     // from PageContext only — never finding.proposedValue, never issue.detail
      proposedValue: finding.proposedValue,   // preserved exactly as the orchestrator produced it
      reasoning: finding.reasoning,           // preserved exactly — never regenerated
      aiProvider: 'specialist-agent',         // never a real LLM provider name
      aiModel: finding.agentNames.join(','),  // the actual contributing agent(s) — never a real model id
    });
  }

  return { recommendations, skipped };
}
