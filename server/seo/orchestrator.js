/**
 * PHASE 3 STEP 4B — SEO ORCHESTRATOR FOUNDATION.
 *
 * A coordination boundary for a future "Agentic SEO Team" (see the Phase 3 Step 3 architecture audit and
 * server/seo/agentContracts.js), NOT the agents themselves — there are no specialist agents yet, and this
 * module does not invent placeholder ones. It never crawls, never re-analyzes a page, never touches the
 * database, never calls apply.js, and never queues or runs a scan: it is a pure function over data its
 * caller already has.
 *
 * Pipeline this module sits in (unchanged by this step):
 *   Website -> Crawler -> pageAnalyzer -> seo_issues -> [SEO Orchestrator] -> Agent Findings ->
 *   Recommendation creation -> Human Approval -> Existing Safe Apply -> Re-scan -> Existing Verification
 *
 * SCOPE OF THIS STEP: runOrchestrator() collects AgentFinding[] from registered agent functions, discards
 * anything malformed or referencing an issue it wasn't given, and merges/flags conflicts by issueId. It
 * deliberately STOPS before creating any Recommendation. store.createRecommendation() (server/db.js) also
 * requires aiProvider/aiModel, which the AgentFinding contract (server/seo/agentContracts.js) does not
 * carry — inventing values for those fields would be exactly the kind of fabrication the safety invariants
 * forbid. Recommendation creation is left for a later step, once a real specialist agent can supply that
 * information honestly. This module is also NOT wired into server/seo/jobs.js's executeScan() — it is
 * isolated on purpose; production scan integration is a deliberately deferred, separate step (see the
 * module-level note in server/seo/jobs.js this step does not add).
 *
 * With agents: [] (today's only real caller shape), runOrchestrator() is a no-op: no findings, no merges,
 * no conflicts, no recommendations, no content changes, no scan recursion.
 */

const REQUIRED_FINDING_FIELDS = ['agentName', 'issueId', 'confidence', 'evidence', 'proposedType', 'proposedValue', 'reasoning'];
const VALID_CONFIDENCE = new Set(['low', 'medium', 'high']);

/** Never trust an agent's return value — validate every AgentFinding field against the shared contract
 *  (server/seo/agentContracts.js) before it is allowed anywhere near a merge or a future recommendation. */
function isWellFormedFinding(f) {
  if (!f || typeof f !== 'object') return false;
  for (const key of REQUIRED_FINDING_FIELDS) if (!(key in f)) return false;
  if (typeof f.agentName !== 'string' || !f.agentName.trim()) return false;
  if (!Number.isInteger(f.issueId)) return false;
  if (!VALID_CONFIDENCE.has(f.confidence)) return false;
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) return false;
  if (typeof f.proposedType !== 'string' || !f.proposedType.trim()) return false;
  if (typeof f.proposedValue !== 'string' || !f.proposedValue.trim()) return false;
  if (typeof f.reasoning !== 'string' || !f.reasoning.trim()) return false;
  return true;
}

/** Never logs the raw error object (which could carry a stack trace, request body, or worse) — only a
 *  short, truncated message, the same convention server/seo/llm.js already uses for provider errors. */
function safeErrorMessage(err) {
  return String(err?.message ?? err ?? 'unknown error').slice(0, 300);
}

/** Only these fields ever leave one AgentFinding for a merged result — extra fields an agent returns
 *  (accidentally or otherwise) never propagate anywhere, so an agent cannot smuggle instructions or data
 *  through unrecognized keys. */
function pickFinding({ agentName, issueId, confidence, evidence, proposedType, proposedValue, reasoning }) {
  return { agentName, issueId, confidence, evidence, proposedType, proposedValue, reasoning };
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
const direction = (f) => `${f.proposedType}::${f.proposedValue.trim().toLowerCase()}`;

/** Same issue, same proposed direction from every agent that weighed in — safe to fold into one merged
 *  result. Keeps the strongest confidence's proposedValue/reasoning; combines evidence from every agent
 *  that agreed, so the merged result stays traceable to all of them, not just one. */
function mergeGroup(issueId, group) {
  const strongest = group.reduce((best, f) => (CONFIDENCE_RANK[f.confidence] > CONFIDENCE_RANK[best.confidence] ? f : best), group[0]);
  return {
    issueId,
    agentNames: [...new Set(group.map((f) => f.agentName))],
    confidence: strongest.confidence,
    proposedType: strongest.proposedType,
    proposedValue: strongest.proposedValue,
    reasoning: strongest.reasoning,
    evidence: group.flatMap((f) => f.evidence),
  };
}

/**
 * Coordinates registered agent functions over one audit's already-collected context. Never crawls,
 * analyzes, writes, applies, or scans — see the module docstring above and AGENT_SAFETY_INVARIANTS in
 * server/seo/agentContracts.js.
 *
 * @param {Object} input
 * @param {import('./agentContracts.js').AuditContext} input.auditContext - MUST carry explicit websiteId + auditId; never defaulted here
 * @param {import('./agentContracts.js').PageContext[]} [input.pages] - already-crawled pages for this website, read-only
 * @param {import('./agentContracts.js').Issue[]} [input.issues] - this audit's already-persisted issues, read-only
 * @param {import('./agentContracts.js').Recommendation[]} [input.previousRecommendations] - prior recommendation history, read-only
 * @param {Array<(ctx: {auditContext, pages, issues, previousRecommendations}) => (Promise<import('./agentContracts.js').AgentFinding[]>|import('./agentContracts.js').AgentFinding[])>} [input.agents] - registered specialist agent functions; [] today
 * @returns {Promise<{websiteId: number, auditId: number, findings: object[], merged: object[], conflicts: object[], errors: {agentName: string, error: string}[], recommendationsCreated: []}>}
 */
export async function runOrchestrator({ auditContext, pages = [], issues = [], previousRecommendations = [], agents = [] } = {}) {
  // Explicit context is non-negotiable — see AGENT_SAFETY_INVARIANTS.websiteIdMustBeExplicit. No fallback to
  // a "default" or "home" website is ever attempted here, unlike server/seo/routes.js's admin convenience.
  if (!auditContext || !Number.isInteger(auditContext.websiteId) || !Number.isInteger(auditContext.auditId)) {
    throw new Error('runOrchestrator requires an explicit AuditContext with numeric websiteId and auditId.');
  }
  const agentList = Array.isArray(agents) ? agents : [];
  const issueById = new Map((Array.isArray(issues) ? issues : []).map((i) => [i.id, i]));

  const findings = [];
  const errors = [];

  for (const agent of agentList) {
    const agentLabel = typeof agent?.agentName === 'string' && agent.agentName ? agent.agentName : (agent?.name || 'unnamed-agent');
    let result;
    try {
      // Agents are treated as pure functions over the context they're given — no store, no db, no fetch
      // client is ever handed to them here, so there is nothing for a misbehaving agent to write through.
      result = await agent({ auditContext, pages, issues, previousRecommendations });
    } catch (err) {
      // One agent's failure never stops another, and never fails the orchestrator or the audit that called it.
      errors.push({ agentName: agentLabel, error: safeErrorMessage(err) });
      continue;
    }
    if (!Array.isArray(result)) {
      errors.push({ agentName: agentLabel, error: 'agent did not return an AgentFinding[] array — ignored' });
      continue;
    }
    for (const raw of result) {
      if (!isWellFormedFinding(raw)) {
        errors.push({ agentName: agentLabel, error: 'malformed AgentFinding — discarded' });
        continue;
      }
      if (!issueById.has(raw.issueId)) {
        errors.push({ agentName: agentLabel, error: `AgentFinding referenced an issueId (${raw.issueId}) not present in this audit's issues — discarded` });
        continue;
      }
      findings.push(pickFinding(raw));
    }
  }

  const byIssue = new Map();
  for (const f of findings) {
    if (!byIssue.has(f.issueId)) byIssue.set(f.issueId, []);
    byIssue.get(f.issueId).push(f);
  }

  const merged = [];
  const conflicts = [];
  for (const [issueId, group] of byIssue) {
    const directions = new Set(group.map(direction));
    if (directions.size === 1) {
      merged.push(mergeGroup(issueId, group));
    } else {
      // Contradictory findings for the same issue are never auto-resolved — no winner is picked here, and
      // no recommendation is produced for this issue from this run. A human (or a later, smarter
      // orchestrator step) has to look at it.
      conflicts.push({
        issueId,
        agentNames: group.map((f) => f.agentName),
        proposals: group.map((f) => ({ agentName: f.agentName, proposedType: f.proposedType, proposedValue: f.proposedValue })),
      });
    }
  }

  // Deliberately always empty in this foundation step — see the module docstring for why recommendation
  // creation is deferred rather than faked.
  const recommendationsCreated = [];

  return { websiteId: auditContext.websiteId, auditId: auditContext.auditId, findings, merged, conflicts, errors, recommendationsCreated };
}
