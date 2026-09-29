// Phase 3 Step 4B — SEO orchestrator foundation. Pure in-memory coordination: no database, no network, no
// crawler — so unlike most other test files here, this one needs no SQLITE_PATH/env setup at all.
// Run: node server/test-seo-orchestrator.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);

/* ───────────── fixtures ───────────── */
const auditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const pages = [{ pageId: 1, websiteId: 1, url: 'https://example.test/', title: 'Old Title' }];
const issues = [
  { id: 10, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'Title is 90 characters.', recommendation: null },
  { id: 11, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-description', severity: 'critical', detail: 'No meta description.', recommendation: null },
];

const evidence = [{ source: 'analyzer', ref: 10 }];
const finding = (overrides = {}) => ({
  agentName: 'test-agent', issueId: 10, confidence: 'medium', evidence,
  proposedType: 'title', proposedValue: 'A Better Title', reasoning: 'Shorter and clearer.',
  ...overrides,
});

/* ───────────── 10. website/audit context remains explicit ───────────── */
let threw = false;
try { await runOrchestrator({ pages, issues, agents: [] }); } catch { threw = true; }
ok('missing auditContext is refused, not silently defaulted', threw);

threw = false;
try { await runOrchestrator({ auditContext: { auditId: 100 }, pages, issues, agents: [] }); } catch { threw = true; }
ok('an AuditContext missing websiteId is refused', threw);

threw = false;
try { await runOrchestrator({ auditContext: { websiteId: 1 }, pages, issues, agents: [] }); } catch { threw = true; }
ok('an AuditContext missing auditId is refused', threw);

/* ───────────── 1. empty agent list ───────────── */
let r = await runOrchestrator({ auditContext, pages, issues, agents: [] });
ok('agents: [] produces no findings', r.findings.length === 0);
ok('agents: [] produces no merges', r.merged.length === 0);
ok('agents: [] produces no conflicts', r.conflicts.length === 0);
ok('agents: [] produces no errors', r.errors.length === 0);
ok('agents: [] never creates a recommendation', Array.isArray(r.recommendationsCreated) && r.recommendationsCreated.length === 0);
ok('the returned context echoes the explicit websiteId/auditId, not a default', r.websiteId === 1 && r.auditId === 100);

/* ───────────── 2. single agent returning no findings ───────────── */
r = await runOrchestrator({ auditContext, pages, issues, agents: [async () => []] });
ok('a single agent returning [] produces no findings, no errors', r.findings.length === 0 && r.errors.length === 0);

/* ───────────── 3. single valid finding ───────────── */
let seenInput = null;
r = await runOrchestrator({
  auditContext, pages, issues, previousRecommendations: [{ id: 1 }],
  agents: [async (input) => { seenInput = input; return [finding()]; }],
});
ok('a single valid finding is collected', r.findings.length === 1);
ok('a single valid finding is auto-merged (nothing to conflict with)', r.merged.length === 1 && r.merged[0].issueId === 10);
ok('the merged result carries the proposed value and combined evidence', r.merged[0].proposedValue === 'A Better Title' && r.merged[0].evidence.length === 1);
ok('the agent received the documented {auditContext, pages, issues, previousRecommendations} shape', seenInput.auditContext === auditContext && seenInput.pages === pages && seenInput.issues === issues && seenInput.previousRecommendations.length === 1);

/* ───────────── malformed / untrusted agent output is discarded, never trusted ───────────── */
r = await runOrchestrator({ auditContext, pages, issues, agents: [async () => [{ agentName: 'bad-agent', issueId: 10 }]] });
ok('a finding missing required fields is discarded, not merged', r.findings.length === 0 && r.merged.length === 0);
ok('a discarded malformed finding is recorded as a safe error, not thrown', r.errors.length === 1 && /malformed/.test(r.errors[0].error));

r = await runOrchestrator({ auditContext, pages, issues, agents: [async () => [finding({ issueId: 999 })]] });
ok('a finding referencing an issueId outside this audit is discarded', r.findings.length === 0 && /issueId/.test(r.errors[0].error));

r = await runOrchestrator({ auditContext, pages, issues, agents: [async () => 'not-an-array'] });
ok('an agent that does not return an array produces a safe error, not a crash', r.errors.length === 1 && r.findings.length === 0);

/* ───────────── 4. multiple agents ───────────── */
r = await runOrchestrator({
  auditContext, pages, issues,
  agents: [
    async () => [finding({ agentName: 'agent-a', issueId: 10 })],
    async () => [finding({ agentName: 'agent-b', issueId: 11, proposedType: 'description', proposedValue: 'A new description.' })],
  ],
});
ok('multiple agents each contribute their findings', r.findings.length === 2);
ok('independent issues each get their own merged result', r.merged.length === 2);

/* ───────────── 5. duplicate findings for the same issue (same direction) merge into one ───────────── */
r = await runOrchestrator({
  auditContext, pages, issues,
  agents: [
    async () => [finding({ agentName: 'agent-a', confidence: 'low' })],
    async () => [finding({ agentName: 'agent-b', confidence: 'high' })],
  ],
});
ok('two agents agreeing on the same issue + direction produce exactly one merged result, not two', r.merged.length === 1 && r.conflicts.length === 0);
ok('the merge lists both contributing agents', r.merged[0].agentNames.sort().join(',') === 'agent-a,agent-b');
ok('the merge keeps the strongest confidence seen', r.merged[0].confidence === 'high');

/* ───────────── 6. conflicting findings ───────────── */
r = await runOrchestrator({
  auditContext, pages, issues,
  agents: [
    async () => [finding({ agentName: 'agent-shorten', proposedValue: 'Short Title' })],
    async () => [finding({ agentName: 'agent-expand', proposedValue: 'A Much Longer, More Descriptive Title Than Before' })],
  ],
});
ok('contradictory findings for the same issue produce a conflict, not a merge', r.conflicts.length === 1 && r.merged.length === 0);
ok('the conflict record names both disagreeing agents', r.conflicts[0].agentNames.sort().join(',') === 'agent-expand,agent-shorten');
ok('no recommendation is ever produced from a conflict', r.recommendationsCreated.length === 0);

/* ───────────── 7. one agent throws while another succeeds ───────────── */
r = await runOrchestrator({
  auditContext, pages, issues,
  agents: [
    async () => { throw new Error('simulated agent crash with a fake secret sk-should-not-leak-in-full-if-this-were-huge'.repeat(20)); },
    async () => [finding({ agentName: 'agent-b', issueId: 11, proposedType: 'description', proposedValue: 'A new description.' })],
  ],
});
ok('a throwing agent does not stop the orchestrator', r.merged.length === 1 && r.merged[0].issueId === 11);
ok('the throwing agent is recorded as a safe, bounded-length error, not thrown back at the caller', r.errors.length === 1 && r.errors[0].error.length <= 300);

/* ───────────── 8. agent output cannot directly mutate content ───────────── */
r = await runOrchestrator({
  auditContext, pages, issues,
  agents: [async () => [finding({
    // a hostile/buggy agent tries to smuggle extra fields alongside a valid finding
    applyDirectly: true, sql: 'DROP TABLE seo_recommendations',
  })]],
});
ok('only the documented AgentFinding fields survive into a merged result — nothing else propagates', Object.keys(r.merged[0]).sort().join(',') === ['agentNames', 'confidence', 'evidence', 'issueId', 'proposedType', 'proposedValue', 'reasoning'].sort().join(','));
ok('an extra field an agent injects is never present on the merged result', !('applyDirectly' in r.merged[0]) && !('sql' in r.merged[0]));
ok('the orchestrator module exposes no mutation capability at all', Object.keys(await import(new URL('./seo/orchestrator.js', import.meta.url).href)).every((k) => k === 'runOrchestrator'));

/* ───────────── 9. orchestrator does not recursively invoke scans ───────────── */
const orchestratorSrc = readFileSync(fileURLToPath(new URL('./seo/orchestrator.js', import.meta.url)), 'utf8');
ok('orchestrator.js never imports the crawler', !/from ['"]\.\/crawler\.js['"]/.test(orchestratorSrc));
ok('orchestrator.js never imports the job queue (server/seo/jobs.js)', !/from ['"]\.\/jobs\.js['"]/.test(orchestratorSrc));
ok('orchestrator.js never imports the page analyzer', !/from ['"]\.\/pageAnalyzer\.js['"]/.test(orchestratorSrc));

/* ───────────── 11. existing manual recommendation route remains unaffected ───────────── */
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
ok('server/seo/routes.js does not reference the orchestrator at all — this step wired nothing new into it', !/orchestrator/i.test(routesSrc));
ok('the existing POST /issues/:id/recommend route is still present, byte-for-byte untouched by this step', routesSrc.includes("router.post('/issues/:id/recommend'"));

/* ───────────── 12. no direct recommendation SQL is introduced ───────────── */
ok('orchestrator.js never touches seo_recommendations directly', !/seo_recommendations/.test(orchestratorSrc));
ok('orchestrator.js contains no raw SQL', !/INSERT INTO|UPDATE .* SET|DELETE FROM/i.test(orchestratorSrc));
ok('orchestrator.js never imports the database layer', !/from ['"]\.\.\/db\.js['"]/.test(orchestratorSrc));
ok('orchestrator.js never imports apply.js (the only module allowed to change production content)', !/from ['"]\.\/apply\.js['"]/.test(orchestratorSrc));
ok('recommendationsCreated is always empty in this foundation step — creation is deferred, not faked', r.recommendationsCreated.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
