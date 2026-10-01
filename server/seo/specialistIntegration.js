import { onPageAgent } from './onPageAgent.js';
import { technicalAgent } from './technicalAgent.js';
import { internalLinkAgent } from './internalLinkAgent.js';
import { schemaAgent } from './schemaAgent.js';
import { contentAgent } from './contentAgent.js';
import { runOrchestrator } from './orchestrator.js';
import { convertSpecialistFindings } from './specialistRecommendationConverter.js';
import { crawlLimits } from './limits.js';

/**
 * PHASE 3 STEP 4K/4L/4M/4N/4O — LIVE SPECIALIST INTEGRATION (ON-PAGE + TECHNICAL + INTERNAL LINK + SCHEMA +
 * CONTENT).
 *
 * The one new link between the existing, completed audit pipeline and the Step 4A-4J specialist layer:
 *   real persisted audit/pages/issues -> [ADAPTER] -> AuditContext/PageContext[]/Issue[] ->
 *   runOrchestrator({agents:[onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent]}) ->
 *   merged findings -> convertSpecialistFindings() -> store.createRecommendation() (same table, same
 *   'pending' status, same approve/apply/verify flow as every existing LLM-sourced recommendation).
 *
 * Step 4K wired in onPageAgent only. Step 4L added technicalAgent. Step 4M added internalLinkAgent. Step 4N
 * added schemaAgent. Step 4O adds contentAgent to the SAME orchestrator call, proving five deterministic
 * specialists can safely coexist. performanceAgent exists and is fully built (Step 4H) but is deliberately
 * NOT imported or referenced below — it stays isolated until its own, separate integration step.
 *
 * TECHNICAL/INTERNAL LINK/SCHEMA/CONTENT AGENTS AT THE CONVERTER BOUNDARY: technicalAgent's actionable
 * proposedType values ('sitemap-inclusion', 'redirect-target', 'https-upgrade', 'canonical'),
 * internalLinkAgent's ('internal-link-target', 'broken-link-review', 'link-to-redirect-review'),
 * schemaAgent's ('structured-data-opportunity', 'structured-data-review'), and contentAgent's
 * ('thin-content-review', 'duplicate-content-review') are NOT in specialistRecommendationConverter.js's
 * SUPPORTED_RECOMMENDATION_TYPES ('title', 'description' only — see that module, frozen since Step 4J). This
 * is expected, not a bug: a Technical, Internal Link, Schema, or Content finding runs the full
 * Agent -> Orchestrator -> Merge -> Conflict-detection -> Converter path exactly like an On-Page finding,
 * but the converter safely skips it ('unsupported-type') rather than inventing Safe Apply support that
 * server/seo/apply.js does not have. No recommendation row is ever created for a technical, internal link,
 * schema, or content finding today; that is intentional and unchanged by this step — see the
 * Step 4D/4E/4F/4G agents' own "identify, never invent" (and, for contentAgent, "identify, never generate")
 * reasoning and the Step 4I audit's Safe Apply Matrix finding.
 *
 * This module does not call apply.js, does not change a recommendation's status past 'pending' (the same
 * starting status every existing recommendation gets), and does not touch content, approval, safe-apply, or
 * verification in any way — createRecommendation() is the exact same existing store method the LLM path
 * (server/seo/recommendations.js + routes.js) already uses, called with the same required fields.
 *
 * ADAPTER NOTE: server/seo/agentContracts.js (Step 4A) documents AuditContext/PageContext/Issue in
 * camelCase, but the real rows server/db.js returns are snake_case (pages.title, not pages.pageId; etc.) —
 * a gap every specialist-agent step since 4A flagged but explicitly left for a future integration step to
 * resolve, rather than touching the frozen contract or any specialist agent. This is that step. The two
 * small mapping functions below (toPageContext/toIssue) are that adapter, kept local to this file and nowhere
 * else — onPageAgent.js, orchestrator.js, and specialistRecommendationConverter.js are completely unmodified.
 *
 * DUPLICATE PROTECTION: see this module's own final integration report for the full reasoning. In short —
 * the exact (websiteId, auditId, issueId, type) 4-tuple the Step 4K spec names cannot be duplicated: (a) this
 * function only ever runs once per auditId (it is invoked from the same already-claimed, run-once completion
 * path as verifyAppliedRecommendations() in server/seo/jobs.js), (b) convertSpecialistFindings() already
 * refuses to emit two recommendation objects for the same issueId in one call, and (c) a defensive check
 * against store.listRecommendations({issueId}) below refuses to insert again even if this were ever invoked
 * twice for the same issue. No new duplicate-protection mechanism, schema change, or uniqueness redesign was
 * introduced anywhere. Broader cross-audit accumulation (a still-unresolved issue getting one new
 * recommendation row per future re-scan) is a pre-existing characteristic of the whole recommendation system
 * — the existing manual LLM path has exactly the same property today (nothing stops a human from clicking
 * "recommend" again on a freshly re-surfaced issue after a re-scan) — not a new defect this step introduces.
 * This is flagged explicitly rather than silently papered over with invented logic.
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

function toIssue(row) {
  return {
    id: Number(row.id), websiteId: Number(row.website_id), auditId: Number(row.audit_id),
    pageId: row.page_id == null ? null : Number(row.page_id), type: row.type, severity: row.severity,
    status: row.status, detail: row.detail, recommendation: row.recommendation,
  };
}

/**
 * Runs the On-Page, Technical, Internal Link, Schema, and Content specialists (Steps 4K/4L/4M/4N/4O) through
 * the real, already-persisted facts of one completed audit, and creates 'pending' recommendations for
 * whatever safely converts. Never throws — any failure is caught and logged, exactly like
 * verifyAppliedRecommendations(), so a specialist-layer problem can never affect an otherwise-successful
 * audit. Safe to no-op (creates nothing) if there is nothing to do.
 *
 * Name note: this export kept its Step 4K name ("...OnPageSpecialistIntegration") as Step 4L/4M/4N/4O added
 * technicalAgent/internalLinkAgent/schemaAgent/contentAgent to the same call, to avoid an unforced rename
 * rippling into server/seo/jobs.js's import — the single call site already reads "the specialist
 * integration," and this docstring is the source of truth for exactly which agents currently run here.
 */
export async function runOnPageSpecialistIntegration(store, websiteId, auditId) {
  try {
    const audit = await store.getAudit(auditId);
    if (!audit || !audit.started_at) return;   // nothing to build a trustworthy AuditContext from

    const [pageRows, issueRows] = await Promise.all([
      store.listPages(websiteId),
      store.listIssues({ websiteId, auditId, limit: 5000 }),
    ]);

    const auditContext = { websiteId, auditId, startedAt: audit.started_at, baseUrl: audit.base_url, limits: crawlLimits() };
    const pages = pageRows.map(toPageContext);
    const issues = issueRows.map(toIssue);

    // Step 4K+4L+4M+4N+4O: On-Page, Technical, Internal Link, Schema, and Content all execute here — see the
    // module docstring. The orchestrator isolates each agent's failures from the others
    // (server/seo/orchestrator.js's per-agent try/catch), so any one specialist's problem can never silently
    // drop another's findings.
    const { merged, conflicts, errors } = await runOrchestrator({ auditContext, pages, issues, agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent] });
    for (const err of errors) console.error('[seo] specialist finding rejected during merge:', err.agentName, err.error);

    const { recommendations } = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: merged, conflicts });

    for (const rec of recommendations) {
      // Defensive, reusing the existing read method — refuses to insert a second recommendation for an
      // issueId that somehow already has one (see the module docstring's Duplicate Protection note).
      const existing = await store.listRecommendations({ websiteId, issueId: rec.issueId, limit: 1 });
      if (existing.length) continue;
      await store.createRecommendation(rec);   // starts 'pending' — identical state machine to every existing recommendation
    }
  } catch (err) {
    console.error('[seo] specialist integration failed — the audit itself is unaffected:', err.message);
  }
}
