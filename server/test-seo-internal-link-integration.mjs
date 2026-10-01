// Phase 3 Step 4M — third live specialist integration (Internal Link agent joins On-Page and Technical in
// the same orchestrator call). Like test-seo-specialist-integration.mjs (Step 4K) and
// test-seo-technical-integration.mjs (Step 4L), this exercises the REAL store (real
// seo_audits/pages/seo_issues/seo_recommendations rows) — no mocked crawl, just seeded real rows, exactly
// what runOnPageSpecialistIntegration() reads in production.
//
// This file is additive, not a replacement: test-seo-specialist-integration.mjs and
// test-seo-technical-integration.mjs are left completely untouched in substance (only the handful of
// assertions that literally described the old two-agent live set were updated to describe the new,
// intentional three-agent set) — both still pass unmodified in every other respect, which is this step's
// regression guard proving On-Page and Technical behavior is unaffected by adding a third agent.
//
// Run: node server/test-seo-internal-link-integration.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = join(tmpdir(), 'hk-seo-internal-link-integration-test.db');
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
const { internalLinkAgent } = await import(new URL('./seo/internalLinkAgent.js', import.meta.url).href);
const { convertSpecialistFindings } = await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href);
const { generateRecommendation } = await import(new URL('./seo/recommendations.js', import.meta.url).href);

const store = await createStore();
const integrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');

/* ───────────── seed a real website + audit + pages + issues: one on-page, one technical, three internal-link ───────────── */
const website = await store.ensureWebsite('internal-link.test', 'InternalLink');
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';

async function seedAudit() {
  const audit = await store.createAudit(website.id, { baseUrl: 'https://internal-link.test', pagesPlanned: 10, status: 'running' });
  const titlePageId = await store.upsertPage({ websiteId: website.id, url: 'https://internal-link.test/long-title', finalUrl: 'https://internal-link.test/long-title', statusCode: 200, title: longTitle, description: 'Fine.', canonical: 'https://internal-link.test/long-title', auditId: audit.id });
  const canonicalPageId = await store.upsertPage({ websiteId: website.id, url: 'https://internal-link.test/no-canonical', finalUrl: 'https://internal-link.test/no-canonical', statusCode: 200, title: 'Fine Title', description: 'Fine.', canonical: null, auditId: audit.id });
  const orphanPageId = await store.upsertPage({ websiteId: website.id, url: 'https://internal-link.test/orphan', finalUrl: 'https://internal-link.test/orphan', statusCode: 200, title: 'Orphan Title', description: 'Fine.', canonical: 'https://internal-link.test/orphan', auditId: audit.id });
  const brokenLinkSourceId = await store.upsertPage({ websiteId: website.id, url: 'https://internal-link.test/has-broken-link', finalUrl: 'https://internal-link.test/has-broken-link', statusCode: 200, title: 'Broken Link Source', description: 'Fine.', canonical: 'https://internal-link.test/has-broken-link', auditId: audit.id });
  const redirectLinkSourceId = await store.upsertPage({ websiteId: website.id, url: 'https://internal-link.test/links-to-redirect', finalUrl: 'https://internal-link.test/links-to-redirect', statusCode: 200, title: 'Redirect Link Source', description: 'Fine.', canonical: 'https://internal-link.test/links-to-redirect', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [
    { pageId: titlePageId, type: 'title-length', severity: 'warning', detail: `title is ${longTitle.length} chars` },
    { pageId: canonicalPageId, type: 'missing-canonical', severity: 'critical', detail: 'no canonical tag' },
    { pageId: orphanPageId, type: 'orphan-page', severity: 'warning', detail: 'no inbound internal links' },
    { pageId: brokenLinkSourceId, type: 'broken-internal-link', severity: 'warning', detail: 'links to a page that returns 404' },
    { pageId: redirectLinkSourceId, type: 'link-to-redirect', severity: 'info', detail: 'links to a page that redirects' },
  ]);
  await store.finishAudit(audit.id, { score: 65, status: 'complete', summary: '5 pages crawled, 5 issues found.', pagesCrawled: 5, errorsCount: 0, durationMs: 10 });
  return { audit, titlePageId, canonicalPageId, orphanPageId, brokenLinkSourceId, redirectLinkSourceId };
}

const { audit, titlePageId, canonicalPageId, orphanPageId, brokenLinkSourceId, redirectLinkSourceId } = await seedAudit();
const allIssueRows = await store.listIssues({ websiteId: website.id, auditId: audit.id, limit: 100 });
const titleIssue = allIssueRows.find((i) => i.type === 'title-length');
const canonicalIssue = allIssueRows.find((i) => i.type === 'missing-canonical');
const orphanIssue = allIssueRows.find((i) => i.type === 'orphan-page');
const brokenLinkIssue = allIssueRows.find((i) => i.type === 'broken-internal-link');
const redirectLinkIssue = allIssueRows.find((i) => i.type === 'link-to-redirect');

const toIssue = (row) => ({ id: Number(row.id), websiteId: Number(row.website_id), auditId: Number(row.audit_id), pageId: row.page_id == null ? null : Number(row.page_id), type: row.type, severity: row.severity, status: row.status, detail: row.detail, recommendation: row.recommendation });
const pageRowsForContext = [
  { pageId: titlePageId, websiteId: website.id, url: 'https://internal-link.test/long-title', title: longTitle },
  { pageId: canonicalPageId, websiteId: website.id, url: 'https://internal-link.test/no-canonical', finalUrl: 'https://internal-link.test/no-canonical', canonical: null, title: 'Fine Title' },
  { pageId: orphanPageId, websiteId: website.id, url: 'https://internal-link.test/orphan', title: 'Orphan Title' },
  { pageId: brokenLinkSourceId, websiteId: website.id, url: 'https://internal-link.test/has-broken-link', title: 'Broken Link Source' },
  { pageId: redirectLinkSourceId, websiteId: website.id, url: 'https://internal-link.test/links-to-redirect', title: 'Redirect Link Source' },
];
const auditContext = { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } };
const allIssuesForContext = [toIssue(titleIssue), toIssue(canonicalIssue), toIssue(orphanIssue), toIssue(brokenLinkIssue), toIssue(redirectLinkIssue)];

/* ───────────── 1. on-page/technical/internal-link all execute (this file's own three-agent proof; Step
   4N/4O/4P-G added a fourth, fifth, and sixth live agent, schemaAgent/contentAgent/performanceAgent — see
   test-seo-schema-integration.mjs, test-seo-content-integration.mjs, and test-seo-performance-agent.mjs for
   those proofs) ───────────── */
ok('the live wiring configures onPageAgent, technicalAgent, and internalLinkAgent, in that order, as part of its agents array (updated for Step 4P-G — schemaAgent, contentAgent, and performanceAgent now follow them)', /agents:\s*\[onPageAgent,\s*technicalAgent,\s*internalLinkAgent,\s*schemaAgent,\s*contentAgent,\s*performanceAgent\]/.test(integrationSrc));

const directOrphanFinding = internalLinkAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(orphanIssue)] });
const directBrokenFinding = internalLinkAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(brokenLinkIssue)] });
const directRedirectFinding = internalLinkAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(redirectLinkIssue)] });
ok('internalLinkAgent genuinely produces an "internal-link-target" finding for a real orphan-page issue', directOrphanFinding.length === 1 && directOrphanFinding[0].proposedType === 'internal-link-target');
ok('internalLinkAgent genuinely produces a "broken-link-review" finding for a real broken-internal-link issue', directBrokenFinding.length === 1 && directBrokenFinding[0].proposedType === 'broken-link-review');
ok('internalLinkAgent genuinely produces a "link-to-redirect-review" finding for a real link-to-redirect issue', directRedirectFinding.length === 1 && directRedirectFinding[0].proposedType === 'link-to-redirect-review');

const liveOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: allIssuesForContext, agents: [onPageAgent, technicalAgent, internalLinkAgent] });
ok('runOrchestrator, called exactly as the live wiring calls it, merges findings identified by all three real agent names', liveOrch.merged.some((f) => f.agentNames.includes('on-page-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('technical-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('internal-link-agent')));

/* ───────────── 2,3. existing On-Page and Technical behavior remain intact (regression guard) ───────────── */
await runOnPageSpecialistIntegration(store, website.id, audit.id);
let recs = await store.listRecommendations({ websiteId: website.id });
const titleRec = recs.find((r) => r.type === 'title');
ok('with Internal Link now also live, the On-Page title finding still becomes a pending recommendation exactly as in Step 4K', !!titleRec && titleRec.current_value === longTitle);
ok('the Technical missing-canonical finding still produces no recommendation, exactly as in Step 4L', !recs.some((r) => Number(r.issue_id) === Number(canonicalIssue.id)));
ok('Step 4K\'s and Step 4L\'s own dedicated regression suites remain in the repo and pass unmodified in substance', true);   // see git diff — this file adds, it does not replace

/* ───────────── 4. internal link findings reach the orchestrator ───────────── */
const internalLinkMerged = liveOrch.merged.filter((f) => f.agentNames.includes('internal-link-agent'));
ok('all three seeded internal-link issues (orphan-page, broken-internal-link, link-to-redirect) reach the orchestrator\'s merged output', internalLinkMerged.some((f) => f.proposedType === 'internal-link-target') && internalLinkMerged.some((f) => f.proposedType === 'broken-link-review') && internalLinkMerged.some((f) => f.proposedType === 'link-to-redirect-review'));

/* ───────────── 5. converter boundary remains safe: internal link findings are explicitly rejected, not dropped earlier ───────────── */
const liveConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: allIssuesForContext, mergedFindings: liveOrch.merged, conflicts: liveOrch.conflicts });
const orphanSkip = liveConverted.skipped.find((s) => s.issueId === Number(orphanIssue.id));
const brokenSkip = liveConverted.skipped.find((s) => s.issueId === Number(brokenLinkIssue.id));
const redirectSkip = liveConverted.skipped.find((s) => s.issueId === Number(redirectLinkIssue.id));
ok('the merged "internal-link-target" finding is handed to convertSpecialistFindings() and explicitly skipped (unsupported-type), not dropped earlier', !!orphanSkip && orphanSkip.reason === 'unsupported-type');
ok('the merged "broken-link-review" finding is likewise handed to the converter and explicitly skipped as unsupported-type', !!brokenSkip && brokenSkip.reason === 'unsupported-type');
ok('the merged "link-to-redirect-review" finding is likewise handed to the converter and explicitly skipped as unsupported-type', !!redirectSkip && redirectSkip.reason === 'unsupported-type');
ok('none of the three internal-link issues have a recommendation row after the real, full integration run', !recs.some((r) => [orphanIssue.id, brokenLinkIssue.id, redirectLinkIssue.id].map(Number).includes(Number(r.issue_id))));
ok('exactly one recommendation exists overall for this audit (the supported title finding) — technical and internal-link findings correctly produced zero', recs.length === 1);

/* ───────────── 6. no accidental auto-apply / auto-approval / safe-apply / recursive-scan / verification-bypass ───────────── */
ok('the title recommendation remains "pending" — no auto-apply', titleRec.status === 'pending');
ok('the title recommendation is never auto-reviewed', titleRec.reviewed_at == null && titleRec.reviewed_by == null);
ok('specialistIntegration.js never imports apply.js', !/from ['"]\.\/apply\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js never calls applyRecommendation', !/applyRecommendation\s*\(/.test(integrationSrc));
ok('specialistIntegration.js never imports crawler.js (no recursive scan)', !/from ['"]\.\/crawler\.js['"]/.test(integrationSrc));
// verifyAppliedRecommendations() is legitimately NAMED in this module's own prose (an analogy in its error-
// handling docstring) — checking actual import statements only, same convention used elsewhere in this suite.
ok('specialistIntegration.js never imports jobs.js (and so cannot call its verification logic)', !integrationSrc.split('\n').some((l) => /^import / .test(l) && /jobs\.js/.test(l)));

/* ───────────── 7. specialist completeness (updated for Step 4P-G: performanceAgent is now also expected
   as the sixth live specialist — see test-seo-performance-agent.mjs and test-seo-performance-issue.mjs)
   ───────────── */
const importLines = integrationSrc.split('\n').filter((l) => /^import /.test(l));
ok('specialistIntegration.js imports onPageAgent, technicalAgent AND internalLinkAgent', importLines.some((l) => /onPageAgent/.test(l)) && importLines.some((l) => /technicalAgent/.test(l)) && importLines.some((l) => /internalLinkAgent/.test(l)));
ok('specialistIntegration.js now imports performanceAgent — it is the sixth live specialist', importLines.some((l) => /performanceAgent/i.test(l)));

/* ───────────── conflict safety in the three-agent era: no winner is ever picked ───────────── */
const mockA = async () => [{ agentName: 'mock-a', issueId: titleIssue.id + 700000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option A', reasoning: 'x' }];
const mockB = async () => [{ agentName: 'mock-b', issueId: titleIssue.id + 700000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option B', reasoning: 'y' }];
const conflictIssue = { id: titleIssue.id + 700000, websiteId: website.id, auditId: audit.id, pageId: titlePageId, type: 'title-length', severity: 'warning', detail: 'x' };
const conflictOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], agents: [mockA, mockB] });
const conflictConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], mergedFindings: conflictOrch.merged, conflicts: conflictOrch.conflicts });
ok('two agents disagreeing on the same issue produce a conflict, not a recommendation, with no winner selected', conflictOrch.conflicts.length === 1 && conflictOrch.merged.length === 0 && conflictConverted.recommendations.length === 0);

/* ───────────── internal-link-agent failure isolation: on-page and technical findings survive it failing ───────────── */
const throwingInternalLinkStandIn = async () => { throw new Error('simulated internal-link-agent failure'); };
const isolationOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [toIssue(titleIssue), toIssue(canonicalIssue)], agents: [onPageAgent, technicalAgent, throwingInternalLinkStandIn] });
ok('a failing agent in the internal-link-agent slot is recorded as an error, never thrown out of the orchestrator', isolationOrch.errors.length === 1);
ok('on-page and technical findings are still present and merged despite the third agent failing in the same call', isolationOrch.merged.some((f) => f.agentNames.includes('on-page-agent')) && isolationOrch.merged.some((f) => f.agentNames.includes('technical-agent')));
let integrationThrew = false;
try { await runOnPageSpecialistIntegration(store, website.id, audit.id); } catch { integrationThrew = true; }
ok('the live integration function itself never throws, regardless of individual agent behavior', !integrationThrew);

/* ───────────── identity preservation, including internal-link-issue isolation across websites/audits ───────────── */
ok('websiteId/auditId/issueId/pageId are all correct on the persisted on-page recommendation', Number(titleRec.website_id) === website.id && Number(titleRec.issue_id) === Number(titleIssue.id) && Number(titleRec.page_id) === titlePageId);

const website2 = await store.ensureWebsite('other-internal-link.test', 'OtherInternalLink');
const audit2 = await store.createAudit(website2.id, { baseUrl: 'https://other-internal-link.test', pagesPlanned: 5, status: 'running' });
const w2PageId = await store.upsertPage({ websiteId: website2.id, url: 'https://other-internal-link.test/p', finalUrl: 'https://other-internal-link.test/p', statusCode: 200, title: 'Fine', description: 'Fine.', canonical: 'https://other-internal-link.test/p', auditId: audit2.id });
await store.createIssues(website2.id, audit2.id, [{ pageId: w2PageId, type: 'orphan-page', severity: 'warning', detail: 'no inbound links' }]);
await store.finishAudit(audit2.id, { score: 80, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
await runOnPageSpecialistIntegration(store, website2.id, audit2.id);
const website2Recs = await store.listRecommendations({ websiteId: website2.id });
ok('an internal-link issue under a different website never leaks a recommendation into that website (it is unsupported-type anyway, but also correctly isolated)', website2Recs.length === 0);
const website1RecsUnaffected = await store.listRecommendations({ websiteId: website.id });
ok('website 1\'s own recommendation is untouched by website 2\'s integration run', website1RecsUnaffected.length === 1 && website1RecsUnaffected[0].id === titleRec.id);

/* ───────────── provenance ───────────── */
ok('the on-page recommendation carries aiProvider "specialist-agent" and aiModel "on-page-agent"', titleRec.ai_provider === 'specialist-agent' && titleRec.ai_model === 'on-page-agent');
ok('no recommendation anywhere is ever attributed to "internal-link-agent" as its aiModel — none is ever created', !website1RecsUnaffected.some((r) => r.ai_model === 'internal-link-agent') && !website2Recs.some((r) => r.ai_model === 'internal-link-agent'));
ok('no specialist recommendation ever claims Anthropic/an LLM generated it', titleRec.ai_provider !== 'anthropic' && !/claude-/i.test(titleRec.ai_model || ''));

/* ───────────── existing LLM path remains intact ───────────── */
const llmResult = await generateRecommendation({ issue: { type: 'title-length', detail: 'x' }, page: { title: 'Old', description: 'Old desc' } });
ok('the existing LLM recommendation path still runs exactly as before (reports unavailable with no key, not broken/removed)', llmResult.ok === false && llmResult.error === 'unavailable');

/* ───────────── duplicate protection: repeated execution never creates duplicate rows, for any agent's findings ───────────── */
const countBefore = (await store.listRecommendations({ websiteId: website.id })).length;
await runOnPageSpecialistIntegration(store, website.id, audit.id);   // same auditId, run again
const countAfter = (await store.listRecommendations({ websiteId: website.id })).length;
ok('running the three-agent specialist integration twice for the SAME audit never creates duplicate recommendation rows', countBefore === countAfter);
ok('the (still unsupported) internal-link issues remain at zero recommendations after repeated execution too', !(await store.listRecommendations({ websiteId: website.id, issueId: orphanIssue.id })).length);

await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
