import { onPageAgent } from './onPageAgent.js';
import { technicalAgent } from './technicalAgent.js';
import { internalLinkAgent } from './internalLinkAgent.js';
import { schemaAgent } from './schemaAgent.js';
import { contentAgent } from './contentAgent.js';
import { performanceAgent } from './performanceAgent.js';
import { runOrchestrator } from './orchestrator.js';
import { convertSpecialistFindings } from './specialistRecommendationConverter.js';
import { crawlLimits } from './limits.js';

/**
 * PHASE 3 STEP 4K/4L/4M/4N/4O/4P-G — LIVE SPECIALIST INTEGRATION (ON-PAGE + TECHNICAL + INTERNAL LINK +
 * SCHEMA + CONTENT + PERFORMANCE).
 *
 * The one new link between the existing, completed audit pipeline and the Step 4A-4J specialist layer:
 *   real persisted audit/pages/issues -> [ADAPTER] -> AuditContext/PageContext[]/Issue[] ->
 *   runOrchestrator({agents:[onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent,
 *   performanceAgent]}) -> merged findings -> convertSpecialistFindings() -> store.createRecommendation()
 *   (same table, same 'pending' status, same approve/apply/verify flow as every existing LLM-sourced
 *   recommendation).
 *
 * Step 4K wired in onPageAgent only. Step 4L added technicalAgent. Step 4M added internalLinkAgent. Step 4N
 * added schemaAgent. Step 4O added contentAgent. Step 4P-G adds performanceAgent to the SAME orchestrator
 * call, proving six deterministic specialists can safely coexist. performanceAgent only recognizes one real
 * issue type ('performance-score-low', created by server/seo/jobs.js — see Step 4P-D/4P-E) and was proven
 * read-only/converter-safe by the Step 4P-F integration audit before this step added it here.
 *
 * TECHNICAL/INTERNAL LINK/SCHEMA/CONTENT/PERFORMANCE AGENTS AT THE CONVERTER BOUNDARY: technicalAgent's
 * actionable proposedType values ('sitemap-inclusion', 'redirect-target', 'https-upgrade', 'canonical'),
 * internalLinkAgent's ('internal-link-target', 'broken-link-review', 'link-to-redirect-review'),
 * schemaAgent's ('structured-data-opportunity', 'structured-data-review'), contentAgent's
 * ('thin-content-review', 'duplicate-content-review'), and performanceAgent's ('performance-score-review')
 * are NOT in specialistRecommendationConverter.js's SUPPORTED_RECOMMENDATION_TYPES ('title', 'description'
 * only — see that module, frozen since Step 4J). This is expected, not a bug: a Technical, Internal Link,
 * Schema, Content, or Performance finding runs the full Agent -> Orchestrator -> Merge -> Conflict-detection
 * -> Converter path exactly like an On-Page finding, but the converter safely skips it ('unsupported-type')
 * rather than inventing Safe Apply support that server/seo/apply.js does not have. No recommendation row is
 * ever created for a technical, internal link, schema, content, or performance finding today; that is
 * intentional and unchanged by this step — see the Step 4D/4E/4F/4G/4H agents' own "identify, never invent"
 * (and, for contentAgent, "identify, never generate") reasoning and the Step 4I audit's Safe Apply Matrix
 * finding.
 *
 * This module does not call apply.js, does not change a recommendation's status past 'pending' (the same
 * starting status every existing recommendation gets), and does not touch content, approval, safe-apply, or
 * verification in any way — createRecommendation() is the exact same existing store method the LLM path
 * (server/seo/recommendations.js + routes.js) already uses, called with the same required fields.
 *
 * STEP 4P-B — AuditContext.pagespeed: the one real performance signal that already existed in this
 * repository (seo_audits.pagespeed, the single audit-level PageSpeed result — see server/seo/pagespeed.js
 * and the Step 4P readiness audit) was persisted but never reachable from AuditContext. This step forwarded
 * the already-loaded `audit.pagespeed` value through unchanged — same shape, same null-when-absent semantics
 * server/db.js's own row-shaper already produces (`r.pagespeed ? JSON.parse(r.pagespeed) : null`), no new
 * metric, threshold, or transformation invented. Note: performanceAgent itself still never reads this field
 * directly (see its own module docstring) — it only consumes the already-decided 'performance-score-low'
 * Issue row; AuditContext.pagespeed remains unread by every live agent (each only destructures the specific
 * fields it already used), including performanceAgent, which Step 4P-G integrated below without this field
 * ever becoming load-bearing for it.
 *
 * ADAPTER NOTE: server/seo/agentContracts.js (Step 4A) documents AuditContext/PageContext/Issue in
 * camelCase, but the real rows server/db.js returns are snake_case (pages.title, not pages.pageId; etc.) —
 * a gap every specialist-agent step since 4A flagged but explicitly left for a future integration step to
 * resolve, rather than touching the frozen contract or any specialist agent. This is that step. The two
 * small mapping functions below (toPageContext/toIssue) are that adapter, kept local to this file and nowhere
 * else — onPageAgent.js, orchestrator.js, and specialistRecommendationConverter.js are completely unmodified.
 *
 * DUPLICATE PROTECTION — PHASE 3 STEP 4S (cross-audit): issue_id is audit-local (a fresh seo_issues row
 * every scan — see server/db.js's createIssues()), so matching on it (the original Step 4K-4P-G mechanism)
 * only ever caught a duplicate within the SAME audit run; a still-unresolved issue re-detected on a LATER
 * audit got a brand-new issue_id and therefore a brand-new, unbounded recommendation row every time. The
 * Step 4R audit identified page_id as the one value that IS stable across audits for the same page (pages
 * are upserted in place — see upsertPage()), and confirmed this converter (see
 * specialistRecommendationConverter.js's `if (issue.pageId == null) ... skip('missing-page')`) guarantees
 * every recommendation it emits today (type 'title' or 'description', the only two converter-supported
 * types) always carries a real, non-null pageId. So (websiteId, pageId, type) is used below as the stable
 * cross-audit identity for "the same logical specialist recommendation target" — never issueId, and never
 * proposedValue (a changed wording for the same target is still the same target, not a new one).
 *
 * This identity is deliberately NOT generalized to sitewide (null-pageId) recommendation types — none exist
 * among the converter's current output, and none is invented here (see shouldSkipDuplicateSpecialistRecommendation()
 * below, and the Step 4R audit's explicit deferral of the unrelated duplicate-content null-pageId case).
 *
 * The lookup (store.findLatestSpecialistRecommendation()) is scoped to ai_provider = 'specialist-agent' only
 * — the one literal only this converter's output ever carries (server/seo/recommendations.js's LLM path
 * always sets a real provider name instead, e.g. 'anthropic'). An existing LLM recommendation for the same
 * page/type is therefore structurally invisible to this check: it is never read, never counted as a
 * duplicate, never modified, and never deleted by it.
 *
 * State policy (shouldSkipDuplicateSpecialistRecommendation()): pending/approved -> skip (a human hasn't
 * acted, or already approved; don't pile on another ask). applied, unresolved by verification (verified_status
 * is null/'unknown'/'still-present') -> skip (never an endless duplicate queue while the prior fix is
 * unconfirmed or didn't hold). applied AND verified resolved -> allow (the issue legitimately returned after
 * being fixed; a new recommendation is correct, not a duplicate). rejected -> allow (a past rejection of one
 * specific proposal does not permanently suppress a later, independently re-detected recurrence). No matching
 * row at all -> allow. Historical recommendation rows are never mutated or deleted by this check — a "new"
 * recommendation is always a genuinely new INSERT, exactly like every recommendation before this step.
 *
 * Verification (verified_status/verified_at/verified_audit_id) remains entirely owned by
 * verifyAppliedRecommendations() in server/seo/jobs.js, unmodified by this step — this check only READS
 * verified_status to decide whether to skip; it never writes it.
 */

function toPageContext(row) {
  return {
    pageId: Number(row.id), websiteId: Number(row.website_id), url: row.url, finalUrl: row.final_url,
    statusCode: row.status_code, contentType: row.content_type, title: row.title, description: row.description,
    canonical: row.canonical, robotsMeta: row.robots, h1Count: row.h1_count, h2Count: row.h2_count,
    wordCount: row.word_count, htmlSize: row.html_size, responseTimeMs: row.response_time_ms, depth: row.depth,
    imageCount: row.image_count, imagesMissingAlt: row.images_missing_alt, lang: row.lang,
    ogTitle: row.og_title, ogDescription: row.og_description, ogImage: row.og_image, twitterCard: row.twitter_card,
    jsonLdPresent: row.json_ld_present, lastAuditId: row.last_audit_id == null ? null : Number(row.last_audit_id),
    lastCrawledAt: row.last_crawled_at,
  };
}

/** Phase 3 Step 4S — decides whether an existing specialist recommendation (the latest row matching the
 *  new recommendation's (websiteId, pageId, type) target, or undefined if none exists) should block
 *  creating a new one. See the module docstring's "DUPLICATE PROTECTION" section for the full reasoning
 *  behind each branch. Pure and synchronous — never queries or mutates anything itself. */
function shouldSkipDuplicateSpecialistRecommendation(existing) {
  if (!existing) return false;
  if (existing.status === 'pending' || existing.status === 'approved') return true;
  if (existing.status === 'applied') {
    // Only a confirmed 'resolved' verification allows a new recommendation for a legitimate recurrence.
    // null (not yet verified) and 'unknown' (inconclusive) are both treated the same as 'still-present' —
    // never confirmed fixed, so never duplicate while that stands.
    return existing.verified_status !== 'resolved';
  }
  // status === 'rejected' (or any other non-blocking status): a past rejection of one specific proposal
  // does not permanently suppress a later, independently re-detected recurrence of the same logical issue.
  return false;
}

function toIssue(row) {
  return {
    id: Number(row.id), websiteId: Number(row.website_id), auditId: Number(row.audit_id),
    pageId: row.page_id == null ? null : Number(row.page_id), type: row.type, severity: row.severity,
    status: row.status, detail: row.detail, recommendation: row.recommendation,
  };
}

/**
 * Runs the On-Page, Technical, Internal Link, Schema, Content, and Performance specialists (Steps
 * 4K/4L/4M/4N/4O/4P-G) through the real, already-persisted facts of one completed audit, and creates
 * 'pending' recommendations for whatever safely converts. Never throws — any failure is caught and logged,
 * exactly like verifyAppliedRecommendations(), so a specialist-layer problem can never affect an
 * otherwise-successful audit. Safe to no-op (creates nothing) if there is nothing to do.
 *
 * Name note: this export kept its Step 4K name ("...OnPageSpecialistIntegration") as Step 4L/4M/4N/4O/4P-G
 * added technicalAgent/internalLinkAgent/schemaAgent/contentAgent/performanceAgent to the same call, to avoid
 * an unforced rename rippling into server/seo/jobs.js's import — the single call site already reads "the
 * specialist integration," and this docstring is the source of truth for exactly which agents currently run
 * here.
 *
 * Step 4W.2 — RETURN VALUE: always resolves to `{conflicts, skipped, errors}` (never throws, never resolves
 * to undefined) — the exact orchestrator `conflicts`/`errors` and converter `skipped` objects already
 * computed above, for server/seo/jobs.js to persist as observability-only diagnostics (seo_audits.specialist_diagnostics).
 * This is purely additive: before this step the return value was implicitly discarded by every caller, so no
 * existing behavior changes. Returning these objects does not alter which recommendations are created,
 * skipped, or deduplicated.
 */
export async function runOnPageSpecialistIntegration(store, websiteId, auditId) {
  const EMPTY_DIAGNOSTICS = { conflicts: [], skipped: [], errors: [] };
  try {
    const audit = await store.getAudit(auditId);
    if (!audit || !audit.started_at) return EMPTY_DIAGNOSTICS;   // nothing to build a trustworthy AuditContext from

    const [pageRows, issueRows] = await Promise.all([
      store.listPages(websiteId),
      store.listIssues({ websiteId, auditId, limit: 5000 }),
    ]);

    const auditContext = { websiteId, auditId, startedAt: audit.started_at, baseUrl: audit.base_url, limits: crawlLimits(), pagespeed: audit.pagespeed };
    const pages = pageRows.map(toPageContext);
    const issues = issueRows.map(toIssue);

    // Step 4K+4L+4M+4N+4O+4P-G: On-Page, Technical, Internal Link, Schema, Content, and Performance all
    // execute here — see the module docstring. The orchestrator isolates each agent's failures from the
    // others (server/seo/orchestrator.js's per-agent try/catch), so any one specialist's problem can never
    // silently drop another's findings.
    const { merged, conflicts, errors } = await runOrchestrator({ auditContext, pages, issues, agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent, performanceAgent] });
    for (const err of errors) console.error('[seo] specialist finding rejected during merge:', err.agentName, err.error);

    const { recommendations, skipped } = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: merged, conflicts });

    for (const rec of recommendations) {
      // Step 4S — cross-audit duplicate check by (websiteId, pageId, type), not issueId (see the module
      // docstring's Duplicate Protection note). rec.pageId is guaranteed non-null for every type this
      // converter currently supports.
      const existing = await store.findLatestSpecialistRecommendation({ websiteId, pageId: rec.pageId, type: rec.type });
      if (shouldSkipDuplicateSpecialistRecommendation(existing)) continue;
      await store.createRecommendation(rec);   // starts 'pending' — identical state machine to every existing recommendation
    }

    // Step 4W.2 — observability only: these exact objects (see orchestrator.js/specialistRecommendationConverter.js
    // for their shapes) were already computed above and previously discarded once they'd served their
    // immediate purpose here. Returning them changes nothing about what was created/skipped/deduplicated —
    // the caller (server/seo/jobs.js) only persists them for diagnostic visibility.
    return { conflicts, skipped, errors };
  } catch (err) {
    console.error('[seo] specialist integration failed — the audit itself is unaffected:', err.message);
    return EMPTY_DIAGNOSTICS;
  }
}
