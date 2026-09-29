import { recommendationTypeForIssue } from './recommendations.js';

/**
 * PHASE 3 STEP 4C — ON-PAGE SEO SPECIALIST AGENT.
 *
 * A deterministic, read-only agent matching the shared contract in server/seo/agentContracts.js:
 * agent({auditContext, pages, issues, previousRecommendations}) => AgentFinding[]. It does not crawl,
 * analyze, write, apply, call an LLM, or make any network call — it only reads the Issue/PageContext data
 * an existing scan already produced and, conservatively, proposes a title/description/heading fix where one
 * can be derived WITHOUT inventing content.
 *
 * NOT wired into server/seo/jobs.js or the orchestrator's agent list — this step only makes the agent
 * itself exist and be individually testable, per the Step 4C spec ("make the agent compatible with the
 * existing orchestrator interface" / "do NOT integrate ... yet").
 *
 * OWNERSHIP: reuses server/seo/recommendations.js's recommendationTypeForIssue() — the project's one
 * existing source of truth for "which issue types have a defined recommendation type, and which" — rather
 * than inventing a second, competing mapping. This agent only claims the subset of that map that is
 * genuinely on-page (title, description, heading). 'internal-link' (orphan-page) and 'schema'
 * (missing-json-ld) are in that same map but belong to other future specialists, so they are left alone
 * here. Every issue type recommendationTypeForIssue() returns null for (all the technical/crawlability
 * issues pageAnalyzer.js produces — missing-robots-txt, broken-page, not-https, missing-canonical, …) is
 * likewise never this agent's concern.
 *
 * CONSERVATISM: even within its own on-page types, this agent only emits a finding when a safe
 * proposedValue can be derived from data that already exists — trimming an over-length title/description to
 * the existing recommendations.js schema bounds (using only the page's own real text), or reusing an
 * existing <title> as a missing <h1> (a standard, well-established on-page practice, not new copy). For
 * every other on-page-owned issue (missing-title, missing-description, duplicate-title,
 * duplicate-description, multiple-h1, heading-hierarchy-skip, a too-short title/description, or a page this
 * agent has no PageContext for) it deliberately produces no finding at all, rather than fabricate text no
 * one wrote — see Step 5 of the spec this module implements.
 */

const AGENT_NAME = 'on-page-agent';
const ON_PAGE_RECOMMENDATION_TYPES = new Set(['title', 'description', 'heading']);
const TITLE_MAX = 60;       // matches recommendations.js's SCHEMAS.title.proposedValue.maxLength
const DESCRIPTION_MAX = 160; // matches recommendations.js's SCHEMAS.description.proposedValue.maxLength

/** Shortens existing real text to at most maxLen characters, backing off to the last whole word so nothing
 *  is invented — only ever a prefix of text that was already there. */
function truncateAtWordBoundary(text, maxLen) {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

function makeFinding({ issueId, pageId, confidence, proposedType, proposedValue, reasoning }) {
  return {
    agentName: AGENT_NAME,
    issueId,
    confidence,
    evidence: [
      { source: 'analyzer', ref: issueId },   // the flagged issue itself — server/seo/pageAnalyzer.js
      { source: 'crawl', ref: pageId },        // the real page text this proposal was derived from — server/seo/crawler.js
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
export function onPageAgent({ auditContext, pages, issues, previousRecommendations } = {}) {
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

    // Never claim an issue that isn't explicitly this audit's own — even if one somehow ended up in the
    // list, honoring auditContext's explicit websiteId/auditId over whatever the input array happens to hold.
    if (issue.websiteId != null && ctxWebsiteId != null && issue.websiteId !== ctxWebsiteId) continue;
    if (issue.auditId != null && ctxAuditId != null && issue.auditId !== ctxAuditId) continue;

    const recType = recommendationTypeForIssue(issue.type);
    if (!recType || !ON_PAGE_RECOMMENDATION_TYPES.has(recType)) continue;   // not this agent's responsibility

    const page = issue.pageId != null ? pageById.get(issue.pageId) : undefined;

    if (issue.type === 'title-length' && page && typeof page.title === 'string' && page.title.trim().length > TITLE_MAX) {
      const proposedValue = truncateAtWordBoundary(page.title, TITLE_MAX);
      if (proposedValue) {
        findings.push(makeFinding({
          issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'title', proposedValue,
          reasoning: `The existing <title> is ${page.title.trim().length} characters, over the recommended ~${TITLE_MAX}. Trimmed to the nearest whole word within the limit, using only the page's own existing title text — nothing new was written.`,
        }));
      }
      continue;
    }

    if (issue.type === 'description-length' && page && typeof page.description === 'string' && page.description.trim().length > DESCRIPTION_MAX) {
      const proposedValue = truncateAtWordBoundary(page.description, DESCRIPTION_MAX);
      if (proposedValue) {
        findings.push(makeFinding({
          issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'description', proposedValue,
          reasoning: `The existing meta description is ${page.description.trim().length} characters, over the recommended ~${DESCRIPTION_MAX}. Trimmed to the nearest whole word within the limit, using only the page's own existing description text — nothing new was written.`,
        }));
      }
      continue;
    }

    if (issue.type === 'missing-h1' && page && typeof page.title === 'string' && page.title.trim()) {
      findings.push(makeFinding({
        issueId: issue.id, pageId: page.pageId, confidence: 'medium', proposedType: 'heading', proposedValue: page.title.trim(),
        reasoning: 'This page has no <h1>. Its existing <title> can serve as the H1 text, a standard on-page SEO practice — no new copy is invented.',
      }));
      continue;
    }

    // Recognized as on-page (title/description/heading) but no safe proposedValue can be derived here
    // without inventing content this agent never had (e.g. missing-title, missing-description,
    // duplicate-title, duplicate-description, multiple-h1, heading-hierarchy-skip, a too-short
    // title/description, or a page this agent has no PageContext for) — so, per Step 5, no finding.
  }
  return findings;
}
