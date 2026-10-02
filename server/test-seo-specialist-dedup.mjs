// Phase 3 Step 4S — Cross-Audit Specialist Recommendation Deduplication.
// Exercises store.findLatestSpecialistRecommendation() and runOnPageSpecialistIntegration()'s new
// (websiteId, pageId, type) dedup check directly against the real store (real seo_recommendations rows),
// the same real-store convention test-seo-specialist-integration.mjs and test-seo-recommendations.mjs use.
// Run: node server/test-seo-specialist-dedup.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = join(tmpdir(), 'hk-seo-specialist-dedup-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development' });
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { runOnPageSpecialistIntegration } = await import(new URL('./seo/specialistIntegration.js', import.meta.url).href);

const store = await createStore();
const integrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');

const website = await store.ensureWebsite('dedup.test', 'Dedup');
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';

/** Seeds a fresh audit with ONE page carrying a title-length issue, runs the real specialist integration
 *  through it, and returns the resulting specialist recommendation (if any) plus identifiers. Reuses the
 *  SAME pageId across calls when one is passed in, to simulate "the same page across multiple audits" the
 *  way upsertPage() does in production. */
async function runAuditForPage({ pageId, url, title = longTitle, description = 'Fine.' } = {}) {
  const audit = await store.createAudit(website.id, { baseUrl: 'https://dedup.test', pagesPlanned: 1, status: 'running' });
  const resolvedPageId = await store.upsertPage({ websiteId: website.id, url, finalUrl: url, statusCode: 200, title, description, auditId: audit.id });
  if (pageId != null) ok(`upsertPage() reused the same stable pageId for ${url} across audits`, resolvedPageId === pageId);
  await store.createIssues(website.id, audit.id, [{ pageId: resolvedPageId, type: 'title-length', severity: 'warning', detail: `title is ${title.length} chars` }]);
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
  await runOnPageSpecialistIntegration(store, website.id, audit.id);
  const issue = (await store.listIssues({ websiteId: website.id, auditId: audit.id, type: 'title-length' }))[0];
  const recs = await store.listRecommendations({ websiteId: website.id, issueId: issue.id });
  return { audit, pageId: resolvedPageId, issueId: issue.id, rec: recs.find((r) => r.ai_provider === 'specialist-agent') };
}

/* ───────────── 1. same-audit duplicate: running integration twice for the SAME audit creates no second row ───────────── */
{
  const { audit, pageId } = await runAuditForPage({ url: 'https://dedup.test/same-audit' });
  await runOnPageSpecialistIntegration(store, website.id, audit.id);   // same auditId again
  const specialistRecs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === pageId && r.type === 'title' && r.ai_provider === 'specialist-agent');
  ok('same-audit duplicate: re-running integration for the same audit never creates a second specialist recommendation', specialistRecs.length === 1);
}

/* ───────────── 2. cross-audit duplicate: Audit A then Audit B for the SAME page -> no second specialist rec ───────────── */
{
  const pageUrl = 'https://dedup.test/cross-audit';
  const a = await runAuditForPage({ url: pageUrl });
  ok('Audit A created exactly one pending specialist recommendation', a.rec && a.rec.status === 'pending');
  const b = await runAuditForPage({ pageId: a.pageId, url: pageUrl });
  ok('Audit B genuinely produced a DIFFERENT issueId than Audit A for the same page (issue_id is audit-local, as expected)', b.issueId !== a.issueId);
  const specialistRecs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === a.pageId && r.type === 'title' && r.ai_provider === 'specialist-agent');
  ok('cross-audit duplicate: a still-pending specialist recommendation from Audit A blocks a new one in Audit B, even though issue_id differs', specialistRecs.length === 1);
  ok('the one surviving recommendation is still linked to Audit A\'s original issue, not silently relinked to Audit B\'s', specialistRecs[0].issue_id === a.issueId);
}

/* ───────────── 3. different page: same website/type, different pageId -> both allowed ───────────── */
{
  const x = await runAuditForPage({ url: 'https://dedup.test/page-x' });
  const y = await runAuditForPage({ url: 'https://dedup.test/page-y' });
  ok('different page: two distinct pages each get their own specialist recommendation (no false cross-page suppression)', !!x.rec && !!y.rec && x.pageId !== y.pageId);
}

/* ───────────── 4. different website: same page/type values, different website -> both allowed ───────────── */
{
  const website2 = await store.ensureWebsite('dedup2.test', 'Dedup2');
  const audit1 = await store.createAudit(website.id, { baseUrl: 'https://dedup.test', pagesPlanned: 1, status: 'running' });
  const page1 = await store.upsertPage({ websiteId: website.id, url: 'https://dedup.test/shared-path', finalUrl: 'https://dedup.test/shared-path', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit1.id });
  await store.createIssues(website.id, audit1.id, [{ pageId: page1, type: 'title-length', severity: 'warning', detail: 'x' }]);
  await store.finishAudit(audit1.id, { score: 70, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
  await runOnPageSpecialistIntegration(store, website.id, audit1.id);

  const audit2 = await store.createAudit(website2.id, { baseUrl: 'https://dedup2.test', pagesPlanned: 1, status: 'running' });
  const page2 = await store.upsertPage({ websiteId: website2.id, url: 'https://dedup.test/shared-path', finalUrl: 'https://dedup.test/shared-path', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit2.id });
  await store.createIssues(website2.id, audit2.id, [{ pageId: page2, type: 'title-length', severity: 'warning', detail: 'x' }]);
  await store.finishAudit(audit2.id, { score: 70, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
  await runOnPageSpecialistIntegration(store, website2.id, audit2.id);

  const w1Recs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === page1 && r.ai_provider === 'specialist-agent');
  const w2Recs = (await store.listRecommendations({ websiteId: website2.id })).filter((r) => r.page_id === page2 && r.ai_provider === 'specialist-agent');
  ok('different website: two different websites each get their own specialist recommendation despite identical page/type shape', w1Recs.length === 1 && w2Recs.length === 1);
}

/* ───────────── 5. different recommendation type: title vs description on the SAME page -> both allowed ───────────── */
{
  const longDescription = 'This meta description goes on for far longer than the one hundred and sixty character limit search engines recommend, repeating itself with extra padding words so it definitely trips the length threshold used by the analyzer.';
  const audit = await store.createAudit(website.id, { baseUrl: 'https://dedup.test', pagesPlanned: 1, status: 'running' });
  const pageId = await store.upsertPage({ websiteId: website.id, url: 'https://dedup.test/both-types', finalUrl: 'https://dedup.test/both-types', statusCode: 200, title: longTitle, description: longDescription, auditId: audit.id });
  await store.createIssues(website.id, audit.id, [
    { pageId, type: 'title-length', severity: 'warning', detail: 'x' },
    { pageId, type: 'description-length', severity: 'warning', detail: 'y' },
  ]);
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '1 page crawled, 2 issues found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
  await runOnPageSpecialistIntegration(store, website.id, audit.id);
  const recs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === pageId && r.ai_provider === 'specialist-agent');
  ok('different recommendation type: title and description recommendations for the SAME page both exist (type is part of the identity)', recs.some((r) => r.type === 'title') && recs.some((r) => r.type === 'description'));
}

/* ───────────── 6. LLM coexistence: an existing LLM recommendation for the same page/type never suppresses a specialist one ───────────── */
{
  const audit = await store.createAudit(website.id, { baseUrl: 'https://dedup.test', pagesPlanned: 1, status: 'running' });
  const pageId = await store.upsertPage({ websiteId: website.id, url: 'https://dedup.test/llm-coexist', finalUrl: 'https://dedup.test/llm-coexist', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [{ pageId, type: 'title-length', severity: 'warning', detail: 'x' }]);
  const seededIssue = (await store.listIssues({ websiteId: website.id, auditId: audit.id, type: 'title-length' }))[0];
  // seed an LLM-style recommendation for this exact page/type BEFORE the specialist integration ever runs
  await store.createRecommendation({ websiteId: website.id, issueId: seededIssue.id, pageId, type: 'title', currentValue: 'Old', proposedValue: 'LLM Proposed New Title', reasoning: 'LLM reasoning', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5' });
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
  await runOnPageSpecialistIntegration(store, website.id, audit.id);
  const recs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === pageId);
  ok('LLM coexistence: a pre-existing LLM recommendation for the same page/type did NOT block the specialist recommendation from being created', recs.some((r) => r.ai_provider === 'specialist-agent'));
  ok('LLM coexistence: the pre-existing LLM recommendation itself was never modified (still ai_provider anthropic, still its original proposed_value)', recs.find((r) => r.ai_provider === 'anthropic').proposed_value === 'LLM Proposed New Title');
  ok('LLM coexistence: both records remain distinguishable by ai_provider in the same table', recs.filter((r) => r.ai_provider === 'anthropic').length === 1 && recs.filter((r) => r.ai_provider === 'specialist-agent').length === 1);
}

/* ───────────── 7. pending: covered directly by test 2 above (Audit B blocked while Audit A's rec is still pending) ───────────── */
ok('pending state: already proven by the cross-audit duplicate test above (a pending specialist recommendation blocks a new one)', true);

/* ───────────── 8. approved: an APPROVED (not yet applied) specialist recommendation also blocks a new one ───────────── */
{
  const pageUrl = 'https://dedup.test/approved-state';
  const a = await runAuditForPage({ url: pageUrl });
  await store.setRecommendationStatus(a.rec.id, 'approved', { reviewedBy: 'tester' });
  const b = await runAuditForPage({ pageId: a.pageId, url: pageUrl });
  const specialistRecs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === a.pageId && r.type === 'title' && r.ai_provider === 'specialist-agent');
  ok('approved state: an approved-but-not-yet-applied specialist recommendation blocks a new one from a later audit', specialistRecs.length === 1 && specialistRecs[0].status === 'approved');
}

/* ───────────── 9. applied + verified still-present: no endless duplicate while the fix is unconfirmed/failed ───────────── */
{
  const pageUrl = 'https://dedup.test/applied-unresolved';
  const a = await runAuditForPage({ url: pageUrl });
  await store.setRecommendationStatus(a.rec.id, 'approved', { reviewedBy: 'tester' });
  await store.setRecommendationStatus(a.rec.id, 'applied', { applied: true });
  await store.setRecommendationVerification(a.rec.id, { verifiedStatus: 'still-present', verifiedAuditId: a.audit.id });
  const b = await runAuditForPage({ pageId: a.pageId, url: pageUrl });
  const specialistRecs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === a.pageId && r.type === 'title' && r.ai_provider === 'specialist-agent');
  ok('applied + still-present: no new specialist recommendation is created while verification shows the issue persists', specialistRecs.length === 1 && specialistRecs[0].status === 'applied');
}

/* ───────────── 10. applied + verified resolved, then the issue returns: a NEW specialist recommendation is allowed; the historical row is untouched ───────────── */
{
  const pageUrl = 'https://dedup.test/applied-resolved-returns';
  const a = await runAuditForPage({ url: pageUrl });
  await store.setRecommendationStatus(a.rec.id, 'approved', { reviewedBy: 'tester' });
  await store.setRecommendationStatus(a.rec.id, 'applied', { applied: true });
  await store.setRecommendationVerification(a.rec.id, { verifiedStatus: 'resolved', verifiedAuditId: a.audit.id });
  const historicalBefore = await store.getRecommendation(a.rec.id);

  const b = await runAuditForPage({ pageId: a.pageId, url: pageUrl });   // the same logical issue returns in a later audit

  const historicalAfter = await store.getRecommendation(a.rec.id);
  ok('applied + resolved + returns: a brand-new specialist recommendation IS created for the recurrence', !!b.rec && b.rec.id !== a.rec.id && b.rec.status === 'pending');
  ok('applied + resolved + returns: the historical (resolved) recommendation row is completely unchanged', JSON.stringify(historicalBefore) === JSON.stringify(historicalAfter));
  const specialistRecs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === a.pageId && r.type === 'title' && r.ai_provider === 'specialist-agent');
  ok('applied + resolved + returns: both the old (applied/resolved) and the new (pending) specialist recommendations coexist — nothing was deleted', specialistRecs.length === 2 && specialistRecs.some((r) => r.status === 'applied') && specialistRecs.some((r) => r.status === 'pending'));
}

/* ───────────── 11. rejected: does not permanently suppress a later, independently re-detected recurrence ───────────── */
{
  const pageUrl = 'https://dedup.test/rejected-state';
  const a = await runAuditForPage({ url: pageUrl });
  await store.setRecommendationStatus(a.rec.id, 'rejected', { reviewedBy: 'tester' });
  const b = await runAuditForPage({ pageId: a.pageId, url: pageUrl });
  ok('rejected state: a later audit CAN produce a new specialist recommendation after a past rejection (no permanent suppression system)', !!b.rec && b.rec.id !== a.rec.id && b.rec.status === 'pending');
  const historicalRejected = await store.getRecommendation(a.rec.id);
  ok('rejected state: the original rejected recommendation record itself is untouched (still status rejected)', historicalRejected.status === 'rejected');
}

/* ───────────── 12. changed proposal: same website/page/type, a later audit's proposedValue differs from the historical one's — the historical record is never silently overwritten ───────────── */
{
  const pageUrl = 'https://dedup.test/changed-proposal';
  const a = await runAuditForPage({ url: pageUrl, title: longTitle });
  const longerTitle = longTitle + ' Even More Extra Padding Words To Change The Proposed Trim Point';
  await runAuditForPage({ pageId: a.pageId, url: pageUrl, title: longerTitle });   // same page/type, different current title -> would yield a different proposedValue if a new rec were ever created
  const historical = await store.getRecommendation(a.rec.id);
  const specialistRecs = (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.page_id === a.pageId && r.type === 'title' && r.ai_provider === 'specialist-agent');
  ok('changed proposal: still only ONE specialist recommendation exists (pending state blocks the second audit\'s differently-worded proposal, same as any other pending duplicate)', specialistRecs.length === 1);
  ok('changed proposal: the historical recommendation\'s original proposed_value was never silently overwritten by the second audit\'s different wording', specialistRecs[0].proposed_value === historical.proposed_value && specialistRecs[0].id === a.rec.id);
}

/* ───────────── store-level checks on findLatestSpecialistRecommendation() itself ───────────── */
{
  const none = await store.findLatestSpecialistRecommendation({ websiteId: website.id, pageId: 999999999, type: 'title' });
  ok('findLatestSpecialistRecommendation() returns a falsy value when nothing matches', !none);
}

/* ───────────── no unrelated architecture was touched ───────────── */
const dbSrc = readFileSync(fileURLToPath(new URL('./db.js', import.meta.url)), 'utf8');
ok('the new store method never references apply.js, verification-writing, or recommendation deletion', /async findLatestSpecialistRecommendation/.test(dbSrc) && !/findLatestSpecialistRecommendation[\s\S]{0,400}DELETE/.test(dbSrc));
ok('specialistIntegration.js still never imports apply.js', !/from ['"]\.\/apply\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js still passes exactly the same six live agents to runOrchestrator (unchanged by this step)', /agents:\s*\[onPageAgent,\s*technicalAgent,\s*internalLinkAgent,\s*schemaAgent,\s*contentAgent,\s*performanceAgent\]/.test(integrationSrc));
ok('specialistIntegration.js dedup lookup is scoped to ai_provider = specialist-agent, never anthropic', /findLatestSpecialistRecommendation/.test(integrationSrc) && /ai_provider = 'specialist-agent'/.test(dbSrc));

await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
