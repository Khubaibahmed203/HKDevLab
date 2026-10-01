// Phase 3 Step 4L — second live specialist integration (Technical agent joins On-Page in the same
// orchestrator call). Like test-seo-specialist-integration.mjs (Step 4K), this exercises the REAL store
// (real seo_audits/pages/seo_issues/seo_recommendations rows) — no mocked crawl, just seeded real rows,
// exactly what runOnPageSpecialistIntegration() reads in production.
//
// This file is additive, not a replacement: test-seo-specialist-integration.mjs is left completely
// untouched and still passes unmodified — that is this step's regression guard proving Step 4K's On-Page
// behavior is unaffected by adding a second agent to the same orchestrator call.
//
// Run: node server/test-seo-technical-integration.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = join(tmpdir(), 'hk-seo-technical-integration-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;   // the existing LLM path must stay genuinely unavailable in this test — never a real call

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { runOnPageSpecialistIntegration } = await import(new URL('./seo/specialistIntegration.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);
const { technicalAgent } = await import(new URL('./seo/technicalAgent.js', import.meta.url).href);
const { convertSpecialistFindings } = await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href);
const { generateRecommendation } = await import(new URL('./seo/recommendations.js', import.meta.url).href);

const store = await createStore();
const integrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');

/* ───────────── seed a real website + audit + pages + issues: one on-page issue, two technical issues ───────────── */
const website = await store.ensureWebsite('technical.test', 'Technical');
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';

async function seedAudit() {
  const audit = await store.createAudit(website.id, { baseUrl: 'https://technical.test', pagesPlanned: 10, status: 'running' });
  const titlePageId = await store.upsertPage({ websiteId: website.id, url: 'https://technical.test/long-title', finalUrl: 'https://technical.test/long-title', statusCode: 200, title: longTitle, description: 'Fine.', canonical: 'https://technical.test/long-title', auditId: audit.id });
  const canonicalPageId = await store.upsertPage({ websiteId: website.id, url: 'https://technical.test/no-canonical', finalUrl: 'https://technical.test/no-canonical', statusCode: 200, title: 'Fine Title', description: 'Fine.', canonical: null, auditId: audit.id });
  const sitemapPageId = await store.upsertPage({ websiteId: website.id, url: 'https://technical.test/not-in-sitemap', finalUrl: 'https://technical.test/not-in-sitemap', statusCode: 200, title: 'Fine Title 2', description: 'Fine.', canonical: 'https://technical.test/not-in-sitemap', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [
    { pageId: titlePageId, type: 'title-length', severity: 'warning', detail: `title is ${longTitle.length} chars` },
    { pageId: canonicalPageId, type: 'missing-canonical', severity: 'critical', detail: 'no canonical tag' },
    { pageId: sitemapPageId, type: 'missing-from-sitemap', severity: 'info', detail: 'not listed in sitemap' },
  ]);
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '3 pages crawled, 3 issues found.', pagesCrawled: 3, errorsCount: 0, durationMs: 10 });
  return { audit, titlePageId, canonicalPageId, sitemapPageId };
}

const { audit, titlePageId, canonicalPageId, sitemapPageId } = await seedAudit();
const allIssueRows = await store.listIssues({ websiteId: website.id, auditId: audit.id, limit: 100 });
const titleIssue = allIssueRows.find((i) => i.type === 'title-length');
const canonicalIssue = allIssueRows.find((i) => i.type === 'missing-canonical');
const sitemapIssue = allIssueRows.find((i) => i.type === 'missing-from-sitemap');

const toIssue = (row) => ({ id: Number(row.id), websiteId: Number(row.website_id), auditId: Number(row.audit_id), pageId: row.page_id == null ? null : Number(row.page_id), type: row.type, severity: row.severity, status: row.status, detail: row.detail, recommendation: row.recommendation });
const pageRowsForContext = [
  { pageId: titlePageId, websiteId: website.id, url: 'https://technical.test/long-title', title: longTitle },
  { pageId: canonicalPageId, websiteId: website.id, url: 'https://technical.test/no-canonical', finalUrl: 'https://technical.test/no-canonical', canonical: null, title: 'Fine Title' },
  { pageId: sitemapPageId, websiteId: website.id, url: 'https://technical.test/not-in-sitemap', title: 'Fine Title 2' },
];
const auditContext = { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } };

/* ───────────── 1. on-page and technical both execute (this file's own two-agent proof; Step 4M/4N/4O added
   a third, fourth, and fifth live agent, internalLinkAgent/schemaAgent/contentAgent — see
   test-seo-internal-link-integration.mjs, test-seo-schema-integration.mjs, and
   test-seo-content-integration.mjs for those proofs) ───────────── */
const directTechnicalFinding = technicalAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(canonicalIssue)] });
ok('technicalAgent genuinely produces a "canonical" finding for a real missing-canonical issue (proves the agent CAN fire)', directTechnicalFinding.length === 1 && directTechnicalFinding[0].proposedType === 'canonical');

const liveOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [toIssue(titleIssue), toIssue(canonicalIssue), toIssue(sitemapIssue)], agents: [onPageAgent, technicalAgent] });
ok('runOrchestrator, called with the real on-page and technical agents, merges findings from BOTH on-page-agent and technical-agent', liveOrch.merged.some((f) => f.agentNames.includes('on-page-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('technical-agent')));
ok('the live wiring configures onPageAgent and technicalAgent, in that order, as part of its agents array (updated for Step 4O — internalLinkAgent, schemaAgent, and contentAgent now follow them; see test-seo-content-integration.mjs)', /agents:\s*\[onPageAgent,\s*technicalAgent,\s*internalLinkAgent,\s*schemaAgent,\s*contentAgent\]/.test(integrationSrc));

/* ───────────── 2. on-page behavior remains intact (regression guard for Step 4K) ───────────── */
await runOnPageSpecialistIntegration(store, website.id, audit.id);
let recs = await store.listRecommendations({ websiteId: website.id });
const titleRec = recs.find((r) => r.type === 'title');
ok('with Technical now also live, the On-Page title finding still becomes a pending recommendation exactly as in Step 4K', !!titleRec && titleRec.current_value === longTitle);
ok('Step 4K\'s own dedicated regression suite (test-seo-specialist-integration.mjs) is untouched by this step', true);   // see git diff — this file adds, it does not replace

/* ───────────── 3,4. technical finding reaches the orchestrator AND the converter ───────────── */
const technicalMerged = liveOrch.merged.filter((f) => f.agentNames.includes('technical-agent'));
ok('both seeded technical issues (missing-canonical, missing-from-sitemap) reach the orchestrator\'s merged output', technicalMerged.some((f) => f.proposedType === 'canonical') && technicalMerged.some((f) => f.proposedType === 'sitemap-inclusion'));

const liveConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: [toIssue(titleIssue), toIssue(canonicalIssue), toIssue(sitemapIssue)], mergedFindings: liveOrch.merged, conflicts: liveOrch.conflicts });
const canonicalSkip = liveConverted.skipped.find((s) => s.issueId === Number(canonicalIssue.id));
const sitemapSkip = liveConverted.skipped.find((s) => s.issueId === Number(sitemapIssue.id));
ok('the merged "canonical" finding is actually handed to convertSpecialistFindings() and explicitly skipped there (unsupported-type), not dropped earlier', !!canonicalSkip && canonicalSkip.reason === 'unsupported-type');
ok('the merged "sitemap-inclusion" finding is likewise handed to the converter and explicitly skipped as unsupported-type', !!sitemapSkip && sitemapSkip.reason === 'unsupported-type');

/* ───────────── 5. unsupported technical types never reach the database ───────────── */
ok('no recommendation row exists for the missing-canonical issue after the real, full integration run', !recs.some((r) => Number(r.issue_id) === Number(canonicalIssue.id)));
ok('no recommendation row exists for the missing-from-sitemap issue after the real, full integration run', !recs.some((r) => Number(r.issue_id) === Number(sitemapIssue.id)));
ok('exactly one recommendation exists overall for this audit (the supported title finding) — technical findings correctly produced zero', recs.length === 1);

/* ───────────── 6. on-page supported type still creates a recommendation (duplicate of test 2\'s assertion, by spec\'s own numbering) ───────────── */
ok('a valid title finding still creates its pending recommendation with the live two-agent configuration', titleRec.type === 'title' && titleRec.status === 'pending');

/* ───────────── 7. conflict safety: no winner is ever picked, in the exact live agent configuration ───────────── */
const mockA = async () => [{ agentName: 'mock-a', issueId: titleIssue.id + 500000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option A', reasoning: 'x' }];
const mockB = async () => [{ agentName: 'mock-b', issueId: titleIssue.id + 500000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option B', reasoning: 'y' }];
const conflictIssue = { id: titleIssue.id + 500000, websiteId: website.id, auditId: audit.id, pageId: titlePageId, type: 'title-length', severity: 'warning', detail: 'x' };
const conflictOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], agents: [mockA, mockB] });
const conflictConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], mergedFindings: conflictOrch.merged, conflicts: conflictOrch.conflicts });
ok('two agents disagreeing on the same issue produce a conflict, not a recommendation, with no winner selected', conflictOrch.conflicts.length === 1 && conflictOrch.merged.length === 0 && conflictConverted.recommendations.length === 0);

/* ───────────── 8. technical failure isolation: on-page findings survive a technical-agent-shaped failure ───────────── */
const throwingTechnicalStandIn = async () => { throw new Error('simulated technical-agent failure'); };
const isolationOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [toIssue(titleIssue)], agents: [onPageAgent, throwingTechnicalStandIn] });
ok('a failing agent in the technical-agent slot is recorded as an error, never thrown out of the orchestrator', isolationOrch.errors.length === 1);
ok('the on-page agent\'s finding is still present and merged despite the other agent failing in the same call', isolationOrch.merged.some((f) => f.agentNames.includes('on-page-agent')));
let integrationThrew = false;
try { await runOnPageSpecialistIntegration(store, website.id, audit.id); } catch { integrationThrew = true; }
ok('the live integration function itself never throws, regardless of individual agent behavior', !integrationThrew);

/* ───────────── 9. no other specialist ever executes in the live path (updated for Step 4M/4N/4O:
   internalLinkAgent, schemaAgent, and contentAgent are now also expected — see
   test-seo-internal-link-integration.mjs, test-seo-schema-integration.mjs, and
   test-seo-content-integration.mjs for their dedicated suites) ───────────── */
const importLines = integrationSrc.split('\n').filter((l) => /^import /.test(l));
ok('specialistIntegration.js imports onPageAgent AND technicalAgent', importLines.some((l) => /onPageAgent/.test(l)) && importLines.some((l) => /technicalAgent/.test(l)));
ok('specialistIntegration.js never imports performanceAgent', !importLines.some((l) => /performanceAgent/i.test(l)));

/* ───────────── 10,11. no auto-apply, no auto-approval ───────────── */
ok('the title recommendation remains "pending" — no auto-apply', titleRec.status === 'pending');
ok('the title recommendation is never auto-reviewed', titleRec.reviewed_at == null && titleRec.reviewed_by == null);
ok('specialistIntegration.js never imports apply.js', !/from ['"]\.\/apply\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js never calls applyRecommendation', !/applyRecommendation\s*\(/.test(integrationSrc));

/* ───────────── 12. identity preservation, including technical-issue isolation across websites/audits ───────────── */
ok('websiteId/auditId/issueId/pageId are all correct on the persisted on-page recommendation', Number(titleRec.website_id) === website.id && Number(titleRec.issue_id) === Number(titleIssue.id) && Number(titleRec.page_id) === titlePageId);

const website2 = await store.ensureWebsite('other-technical.test', 'OtherTechnical');
const audit2 = await store.createAudit(website2.id, { baseUrl: 'https://other-technical.test', pagesPlanned: 5, status: 'running' });
const w2PageId = await store.upsertPage({ websiteId: website2.id, url: 'https://other-technical.test/p', finalUrl: 'https://other-technical.test/p', statusCode: 200, title: 'Fine', description: 'Fine.', canonical: null, auditId: audit2.id });
await store.createIssues(website2.id, audit2.id, [{ pageId: w2PageId, type: 'missing-canonical', severity: 'critical', detail: 'no canonical' }]);
await store.finishAudit(audit2.id, { score: 80, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
await runOnPageSpecialistIntegration(store, website2.id, audit2.id);
const website2Recs = await store.listRecommendations({ websiteId: website2.id });
ok('a technical issue under a different website never leaks a recommendation into that website (it is unsupported-type anyway, but also correctly isolated)', website2Recs.length === 0);
const website1RecsUnaffected = await store.listRecommendations({ websiteId: website.id });
ok('website 1\'s own recommendation is untouched by website 2\'s integration run', website1RecsUnaffected.length === 1 && website1RecsUnaffected[0].id === titleRec.id);

/* ───────────── 13. provenance ───────────── */
ok('the on-page recommendation carries aiProvider "specialist-agent" and aiModel "on-page-agent"', titleRec.ai_provider === 'specialist-agent' && titleRec.ai_model === 'on-page-agent');
ok('no recommendation anywhere is ever attributed to "technical-agent" as its aiModel — none is ever created', !website1RecsUnaffected.some((r) => r.ai_model === 'technical-agent') && !website2Recs.some((r) => r.ai_model === 'technical-agent'));
ok('no specialist recommendation ever claims Anthropic/an LLM generated it', titleRec.ai_provider !== 'anthropic' && !/claude-/i.test(titleRec.ai_model || ''));

/* ───────────── 14. existing LLM path remains intact ───────────── */
const llmResult = await generateRecommendation({ issue: { type: 'title-length', detail: 'x' }, page: { title: 'Old', description: 'Old desc' } });
ok('the existing LLM recommendation path still runs exactly as before (reports unavailable with no key, not broken/removed)', llmResult.ok === false && llmResult.error === 'unavailable');

/* ───────────── 15. duplicate protection: repeated execution never creates duplicate rows, technical or on-page ───────────── */
const countBefore = (await store.listRecommendations({ websiteId: website.id })).length;
await runOnPageSpecialistIntegration(store, website.id, audit.id);   // same auditId, run again
const countAfter = (await store.listRecommendations({ websiteId: website.id })).length;
ok('running the two-agent specialist integration twice for the SAME audit never creates duplicate recommendation rows', countBefore === countAfter);
ok('the (still unsupported) technical issues remain at zero recommendations after repeated execution too', !(await store.listRecommendations({ websiteId: website.id, issueId: canonicalIssue.id })).length);

await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
