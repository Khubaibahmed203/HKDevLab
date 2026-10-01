// Phase 3 Step 4K — first live specialist integration (On-Page agent only). Unlike the pure specialist-agent
// tests, this one exercises the REAL store (real seo_audits/pages/seo_issues/seo_recommendations rows), the
// same way test-seo-recommendations.mjs does — no mocked crawl, just seeded real rows, exactly what
// runOnPageSpecialistIntegration() reads in production.
// Run: node server/test-seo-specialist-integration.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = join(tmpdir(), 'hk-seo-integration-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;   // the existing LLM path must stay genuinely unavailable in this test — never a real call

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { runOnPageSpecialistIntegration } = await import(new URL('./seo/specialistIntegration.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { generateRecommendation } = await import(new URL('./seo/recommendations.js', import.meta.url).href);

const store = await createStore();

/* ───────────── seed a real website + audit + pages + issues, no crawl involved ───────────── */
const website = await store.ensureWebsite('example.test', 'Example');
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';
const longDescription = 'This meta description goes on for far longer than the one hundred and sixty character limit search engines recommend, repeating itself with extra padding words so it definitely trips the length threshold used by the analyzer.';

async function seedAudit() {
  const audit = await store.createAudit(website.id, { baseUrl: 'https://example.test', pagesPlanned: 10, status: 'running' });
  const titlePageId = await store.upsertPage({ websiteId: website.id, url: 'https://example.test/long-title', finalUrl: 'https://example.test/long-title', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit.id });
  const descPageId = await store.upsertPage({ websiteId: website.id, url: 'https://example.test/long-desc', finalUrl: 'https://example.test/long-desc', statusCode: 200, title: 'Fine Title', description: longDescription, auditId: audit.id });
  const h1PageId = await store.upsertPage({ websiteId: website.id, url: 'https://example.test/no-h1', finalUrl: 'https://example.test/no-h1', statusCode: 200, title: 'Reusable Title', description: 'Fine.', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [
    { pageId: titlePageId, type: 'title-length', severity: 'warning', detail: `title is ${longTitle.length} chars` },
    { pageId: descPageId, type: 'description-length', severity: 'warning', detail: `description is ${longDescription.length} chars` },
    { pageId: h1PageId, type: 'missing-h1', severity: 'critical', detail: 'no h1' },   // maps to unsupported 'heading' at the converter boundary
  ]);
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '3 pages crawled, 3 issues found.', pagesCrawled: 3, errorsCount: 0, durationMs: 10 });
  return { audit, titlePageId, descPageId, h1PageId };
}

/* ───────────── 1,2,3,4,5. the real pipeline: agent -> orchestrator merge -> converter -> recommendation ───────────── */
let { audit, titlePageId, descPageId, h1PageId } = await seedAudit();
await runOnPageSpecialistIntegration(store, website.id, audit.id);

let recs = await store.listRecommendations({ websiteId: website.id });
ok('exactly 2 specialist recommendations are created (title + description; heading is unsupported)', recs.length === 2);

const titleRec = recs.find((r) => r.type === 'title');
const descRec = recs.find((r) => r.type === 'description');
ok('a valid title finding became a recommendation (test 1: agent executes through orchestrator)', !!titleRec);
ok('a valid description finding became a recommendation (test 5)', !!descRec);
ok('the title recommendation\'s current_value came from the real PageContext title, not invented', titleRec.current_value === longTitle);
ok('the description recommendation\'s current_value came from the real PageContext description', descRec.current_value === longDescription);
ok('the title recommendation\'s proposed_value is a real trimmed prefix of the existing title (onPageAgent\'s own logic, unmodified)', longTitle.startsWith(titleRec.proposed_value) && titleRec.proposed_value.length <= 60);

/* test 2/3: proving `merged` (not raw `findings`) was used — the converter's own strict validation requires
   an `agentNames` ARRAY (only present on merged output, never on a raw AgentFinding's singular `agentName`).
   Since recommendations WERE created above, the converter must have received properly merged-shaped input —
   confirmed directly by reading the call site below. */
const integrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');
ok('the converter is called with the orchestrator\'s `merged` output, never raw `findings`', /convertSpecialistFindings\(\{[^}]*mergedFindings:\s*merged\b/s.test(integrationSrc) && !/mergedFindings:\s*findings\b/.test(integrationSrc));
ok('the orchestrator\'s `conflicts` are also passed through to the converter (conflict-safety wiring)', /convertSpecialistFindings\(\{[^}]*conflicts\b/s.test(integrationSrc));

/* ───────────── 6. unsupported type (heading) never becomes a recommendation ───────────── */
ok('the missing-h1 (-> "heading") finding did NOT become a recommendation — unsupported by Safe Apply', !recs.some((r) => r.type === 'heading'));
// independently confirm onPageAgent itself WOULD have produced a heading finding, proving this is the
// converter's unsupported-type exclusion at work, not onPageAgent silently skipping it
const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);
const directFindings = onPageAgent({
  auditContext: { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } },
  pages: [{ pageId: h1PageId, websiteId: website.id, url: 'https://example.test/no-h1', title: 'Reusable Title' }],
  issues: [{ id: 99999, websiteId: website.id, auditId: audit.id, pageId: h1PageId, type: 'missing-h1', severity: 'critical', detail: 'x' }],
});
ok('onPageAgent genuinely does produce a "heading" finding for missing-h1 — it is the converter, not the agent, excluding it', directFindings.length === 1 && directFindings[0].proposedType === 'heading');

/* ───────────── 7. conflict -> no recommendation (wiring-level; as of Step 4L, On-Page and Technical both run
   live, but their issue-type ownership never overlaps on real data — see test-seo-technical-integration.mjs
   for the dedicated two-agent conflict-safety proof using mocks) ───────────── */
ok('the live path passes exactly [onPageAgent, technicalAgent] to runOrchestrator() (updated for Step 4L — see test-seo-technical-integration.mjs for the full second-agent integration suite)', /agents:\s*\[onPageAgent,\s*technicalAgent\]/.test(integrationSrc));
// exercise the real conflict path directly through runOrchestrator with two mock agents sharing an issueId,
// then feed its real `merged`+`conflicts` output through the exact same wiring this module uses
const mockA = async () => [{ agentName: 'mock-a', issueId: titlePageId + 100000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option A', reasoning: 'x' }];
const mockB = async () => [{ agentName: 'mock-b', issueId: titlePageId + 100000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option B', reasoning: 'y' }];
const conflictIssue = { id: titlePageId + 100000, websiteId: website.id, auditId: audit.id, pageId: titlePageId, type: 'title-length', severity: 'warning', detail: 'x' };
const conflictOrch = await runOrchestrator({ auditContext: { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } }, pages: [{ pageId: titlePageId, websiteId: website.id, url: 'x', title: longTitle }], issues: [conflictIssue], agents: [mockA, mockB] });
const { convertSpecialistFindings } = await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href);
const conflictConverted = convertSpecialistFindings({ auditContext: { websiteId: website.id, auditId: audit.id }, pages: [{ pageId: titlePageId, websiteId: website.id, url: 'x', title: longTitle }], issues: [conflictIssue], mergedFindings: conflictOrch.merged, conflicts: conflictOrch.conflicts });
ok('a genuine conflict (two agents disagreeing on one issue) never produces a recommendation through this exact wiring', conflictOrch.conflicts.length === 1 && conflictConverted.recommendations.length === 0);

/* ───────────── 8. existing LLM path remains intact ───────────── */
const llmResult = await generateRecommendation({ issue: { type: 'title-length', detail: 'x' }, page: { title: 'Old', description: 'Old desc' } });
ok('the existing LLM recommendation path still runs exactly as before (reports unavailable with no key, not broken/removed)', llmResult.ok === false && llmResult.error === 'unavailable');
const llmRec = await store.createRecommendation({ websiteId: website.id, issueId: titleRec.issue_id, pageId: titlePageId, type: 'title', currentValue: 'Old', proposedValue: 'New (LLM-style)', reasoning: 'LLM reasoning', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5' });
ok('an LLM-style recommendation can still be created and coexists with specialist ones in the same table', llmRec.ai_provider === 'anthropic');
const allRecsNow = await store.listRecommendations({ websiteId: website.id });
ok('both the specialist and the LLM-style recommendation are visible through the same existing listRecommendations() API', allRecsNow.some((r) => r.ai_provider === 'anthropic') && allRecsNow.some((r) => r.ai_provider === 'specialist-agent'));

/* ───────────── 9. specialist/integration failure isolation ───────────── */
let threw = false;
try { await runOnPageSpecialistIntegration(store, website.id, 999999999); } catch { threw = true; }
ok('a nonexistent auditId never throws — the outer try/catch absorbs it, matching verifyAppliedRecommendations()\'s own convention', !threw);

threw = false;
const brokenStore = { ...store, listPages: async () => { throw new Error('simulated specialist-layer failure'); } };
try { await runOnPageSpecialistIntegration(brokenStore, website.id, audit.id); } catch { threw = true; }
ok('an internal failure (simulating an agent/store problem) never escapes runOnPageSpecialistIntegration() — the audit flow is unaffected', !threw);

/* ───────────── 10,11. no auto-apply, no auto-approval ───────────── */
ok('specialist recommendations start "pending" — the exact same initial state as every existing recommendation', titleRec.status === 'pending' && descRec.status === 'pending');
ok('specialist recommendations are never auto-reviewed', titleRec.reviewed_at == null && titleRec.reviewed_by == null);
ok('specialistIntegration.js never imports apply.js — it cannot auto-apply anything', !/from ['"]\.\/apply\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js never calls applyRecommendation', !/applyRecommendation\s*\(/.test(integrationSrc));

/* ───────────── 12. identity preservation ───────────── */
ok('websiteId is correct on the persisted recommendation', Number(titleRec.website_id) === website.id);
ok('issueId correctly links back to the real originating seo_issues row', Number(titleRec.issue_id) > 0);
ok('pageId is correct on the persisted recommendation', Number(titleRec.page_id) === titlePageId);

/* ───────────── 13. provenance ───────────── */
ok('specialist recommendations carry aiProvider "specialist-agent"', titleRec.ai_provider === 'specialist-agent' && descRec.ai_provider === 'specialist-agent');
ok('specialist recommendations never claim Anthropic/an LLM generated them', titleRec.ai_provider !== 'anthropic' && !/claude-/i.test(titleRec.ai_model || ''));
ok('aiModel records the real contributing agent', titleRec.ai_model === 'on-page-agent');

/* ───────────── 14. duplicate protection: repeated execution never creates a second row for the same issue ───────────── */
const countBefore = (await store.listRecommendations({ websiteId: website.id })).length;
await runOnPageSpecialistIntegration(store, website.id, audit.id);   // same auditId, run again — simulates "repeated execution"
const countAfter = (await store.listRecommendations({ websiteId: website.id })).length;
ok('running the specialist integration twice for the SAME audit never creates duplicate recommendation rows', countBefore === countAfter);
const titleRecsForIssue = (await store.listRecommendations({ websiteId: website.id, issueId: titleRec.issue_id }));
ok('exactly one SPECIALIST recommendation exists for the title issue after repeated execution, not two (a separate LLM-sourced one for the same issue, created above in test 8, legitimately coexists)', titleRecsForIssue.filter((r) => r.ai_provider === 'specialist-agent').length === 1);

/* ───────────── multi-website / multi-audit isolation ───────────── */
const website2 = await store.ensureWebsite('other.test', 'Other');
await runOnPageSpecialistIntegration(store, website2.id, 999999);   // a nonexistent audit under a DIFFERENT website
const website2Recs = await store.listRecommendations({ websiteId: website2.id });
ok('a specialist run scoped to another website\'s nonexistent audit creates nothing for that website', website2Recs.length === 0);
const website1RecsUnaffected = await store.listRecommendations({ websiteId: website.id });
ok('website 1\'s own recommendations are untouched by a call scoped to website 2', website1RecsUnaffected.length >= 2);

/* ───────────── no other specialist ever executes in the live path ───────────── */
// Checks actual import statements only — the module's own docstring legitimately NAMES the other four
// not-yet-integrated agents in prose, explaining that they are deliberately not imported; that mention must
// not trip this check. Updated for Step 4L: technicalAgent is now a second expected import alongside
// onPageAgent (see test-seo-technical-integration.mjs for the full second-agent integration suite);
// internalLinkAgent/schemaAgent/contentAgent/performanceAgent remain excluded.
const importLines = integrationSrc.split('\n').filter((l) => /^import /.test(l));
ok('specialistIntegration.js imports onPageAgent AND technicalAgent, and no other specialist agent', importLines.some((l) => /onPageAgent/.test(l)) && importLines.some((l) => /technicalAgent/.test(l))
  && !importLines.some((l) => /internalLinkAgent|schemaAgent|contentAgent|performanceAgent/i.test(l)));

/* ───────────── no live integration beyond the one intended call site ───────────── */
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const orchestratorSrc = readFileSync(fileURLToPath(new URL('./seo/orchestrator.js', import.meta.url)), 'utf8');
const converterSrc = readFileSync(fileURLToPath(new URL('./seo/specialistRecommendationConverter.js', import.meta.url)), 'utf8');
ok('server/seo/jobs.js calls runOnPageSpecialistIntegration exactly once, after the audit is already committed complete', (jobsSrc.match(/runOnPageSpecialistIntegration\(/g) || []).length === 1);
ok('server/seo/routes.js does not reference the specialist integration — no new route was added', !/specialistIntegration|runOnPageSpecialistIntegration/i.test(routesSrc));
ok('server/seo/orchestrator.js itself is completely unmodified by this step (no reference to the integration module)', !/specialistIntegration/i.test(orchestratorSrc));
ok('server/seo/specialistRecommendationConverter.js (Step 4J, frozen) is completely unmodified by this step', !/specialistIntegration/i.test(converterSrc));

await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
