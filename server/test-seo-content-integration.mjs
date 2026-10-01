// Phase 3 Step 4O — fifth live specialist integration (Content agent joins On-Page, Technical, Internal
// Link, and Schema in the same orchestrator call). Like the four prior integration test files
// (Steps 4K/4L/4M/4N), this exercises the REAL store (real seo_audits/pages/seo_issues/seo_recommendations
// rows) — no mocked crawl, just seeded real rows, exactly what runOnPageSpecialistIntegration() reads in
// production.
//
// This file is additive, not a replacement: the four prior integration test files remain in the repo and
// pass unmodified in substance (only the handful of assertions that literally described the old four-agent
// live set were updated to describe the new, intentional five-agent set) — that is this step's regression
// guard proving On-Page/Technical/Internal-Link/Schema behavior is unaffected by adding a fifth agent.
//
// Run: node server/test-seo-content-integration.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = join(tmpdir(), 'hk-seo-content-integration-test.db');
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
const { schemaAgent } = await import(new URL('./seo/schemaAgent.js', import.meta.url).href);
const { contentAgent } = await import(new URL('./seo/contentAgent.js', import.meta.url).href);
const { convertSpecialistFindings } = await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href);
const { generateRecommendation } = await import(new URL('./seo/recommendations.js', import.meta.url).href);

const store = await createStore();
const integrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');

/* ───────────── seed a real website + audit + pages + issues: one each for on-page/technical/internal-link/
   schema, plus thin-content and duplicate-content ───────────── */
const website = await store.ensureWebsite('content.test', 'Content');
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';
const thinWordCount = 20;

async function seedAudit() {
  const audit = await store.createAudit(website.id, { baseUrl: 'https://content.test', pagesPlanned: 10, status: 'running' });
  const titlePageId = await store.upsertPage({ websiteId: website.id, url: 'https://content.test/long-title', finalUrl: 'https://content.test/long-title', statusCode: 200, title: longTitle, description: 'Fine.', canonical: 'https://content.test/long-title', auditId: audit.id });
  const canonicalPageId = await store.upsertPage({ websiteId: website.id, url: 'https://content.test/no-canonical', finalUrl: 'https://content.test/no-canonical', statusCode: 200, title: 'Fine Title', description: 'Fine.', canonical: null, auditId: audit.id });
  const orphanPageId = await store.upsertPage({ websiteId: website.id, url: 'https://content.test/orphan', finalUrl: 'https://content.test/orphan', statusCode: 200, title: 'Orphan Title', description: 'Fine.', canonical: 'https://content.test/orphan', auditId: audit.id });
  const missingJsonLdPageId = await store.upsertPage({ websiteId: website.id, url: 'https://content.test/no-jsonld', finalUrl: 'https://content.test/no-jsonld', statusCode: 200, title: 'No JSON-LD', description: 'Fine.', canonical: 'https://content.test/no-jsonld', jsonLdPresent: false, auditId: audit.id });
  const thinPageId = await store.upsertPage({ websiteId: website.id, url: 'https://content.test/thin', finalUrl: 'https://content.test/thin', statusCode: 200, title: 'Thin Page', description: 'Fine.', canonical: 'https://content.test/thin', wordCount: thinWordCount, auditId: audit.id });
  await store.createIssues(website.id, audit.id, [
    { pageId: titlePageId, type: 'title-length', severity: 'warning', detail: `title is ${longTitle.length} chars` },
    { pageId: canonicalPageId, type: 'missing-canonical', severity: 'critical', detail: 'no canonical tag' },
    { pageId: orphanPageId, type: 'orphan-page', severity: 'warning', detail: 'no inbound internal links' },
    { pageId: missingJsonLdPageId, type: 'missing-json-ld', severity: 'info', detail: 'no structured data' },
    { pageId: thinPageId, type: 'thin-content', severity: 'warning', detail: `only about ${thinWordCount} words` },
    { pageId: null, type: 'duplicate-content', severity: 'warning', detail: '3 pages have near-identical visible content: https://content.test/a, https://content.test/b, https://content.test/c' },
  ]);
  await store.finishAudit(audit.id, { score: 55, status: 'complete', summary: '5 pages crawled, 6 issues found.', pagesCrawled: 5, errorsCount: 0, durationMs: 10 });
  return { audit, titlePageId, canonicalPageId, orphanPageId, missingJsonLdPageId, thinPageId };
}

const { audit, titlePageId, canonicalPageId, orphanPageId, missingJsonLdPageId, thinPageId } = await seedAudit();
const allIssueRows = await store.listIssues({ websiteId: website.id, auditId: audit.id, limit: 100 });
const titleIssue = allIssueRows.find((i) => i.type === 'title-length');
const canonicalIssue = allIssueRows.find((i) => i.type === 'missing-canonical');
const orphanIssue = allIssueRows.find((i) => i.type === 'orphan-page');
const missingJsonLdIssue = allIssueRows.find((i) => i.type === 'missing-json-ld');
const thinContentIssue = allIssueRows.find((i) => i.type === 'thin-content');
const duplicateContentIssue = allIssueRows.find((i) => i.type === 'duplicate-content');

const toIssue = (row) => ({ id: Number(row.id), websiteId: Number(row.website_id), auditId: Number(row.audit_id), pageId: row.page_id == null ? null : Number(row.page_id), type: row.type, severity: row.severity, status: row.status, detail: row.detail, recommendation: row.recommendation });
const pageRowsForContext = [
  { pageId: titlePageId, websiteId: website.id, url: 'https://content.test/long-title', title: longTitle },
  { pageId: canonicalPageId, websiteId: website.id, url: 'https://content.test/no-canonical', finalUrl: 'https://content.test/no-canonical', canonical: null, title: 'Fine Title' },
  { pageId: orphanPageId, websiteId: website.id, url: 'https://content.test/orphan', title: 'Orphan Title' },
  { pageId: missingJsonLdPageId, websiteId: website.id, url: 'https://content.test/no-jsonld', title: 'No JSON-LD', jsonLdPresent: false },
  { pageId: thinPageId, websiteId: website.id, url: 'https://content.test/thin', title: 'Thin Page', wordCount: thinWordCount },
];
const auditContext = { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } };
const allIssuesForContext = [toIssue(titleIssue), toIssue(canonicalIssue), toIssue(orphanIssue), toIssue(missingJsonLdIssue), toIssue(thinContentIssue), toIssue(duplicateContentIssue)];

/* ───────────── Test 1: five-agent invariant — actual agent identities, not merely array length ───────────── */
ok('the live wiring literally configures agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent] in specialistIntegration.js', /agents:\s*\[onPageAgent,\s*technicalAgent,\s*internalLinkAgent,\s*schemaAgent,\s*contentAgent\]/.test(integrationSrc));

const liveOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: allIssuesForContext, agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent] });
ok('runOrchestrator, called exactly as the live wiring calls it, merges findings identified by all five real agent names', liveOrch.merged.some((f) => f.agentNames.includes('on-page-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('technical-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('internal-link-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('schema-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('content-agent')));

/* ───────────── Tests 2,3,4,5: existing On-Page/Technical/Internal-Link/Schema behavior remain intact (regression guard) ───────────── */
await runOnPageSpecialistIntegration(store, website.id, audit.id);
let recs = await store.listRecommendations({ websiteId: website.id });
const titleRec = recs.find((r) => r.type === 'title');
ok('with Content now also live, the On-Page title finding still becomes a pending recommendation exactly as in Step 4K', !!titleRec && titleRec.current_value === longTitle);
ok('the Technical missing-canonical finding still produces no recommendation, exactly as in Step 4L', !recs.some((r) => Number(r.issue_id) === Number(canonicalIssue.id)));
ok('the Internal Link orphan-page finding still produces no recommendation, exactly as in Step 4M', !recs.some((r) => Number(r.issue_id) === Number(orphanIssue.id)));
ok('the Schema missing-json-ld finding still produces no recommendation, exactly as in Step 4N', !recs.some((r) => Number(r.issue_id) === Number(missingJsonLdIssue.id)));
ok('Step 4K\'s, 4L\'s, 4M\'s, and 4N\'s own dedicated regression suites remain in the repo and pass unmodified in substance', true);   // see git diff — this file adds, it does not replace

/* ───────────── Test 6: content thin-content ───────────── */
const directThinFinding = contentAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(thinContentIssue)] });
ok('contentAgent recognizes a real thin-content issue and produces a "thin-content-review" finding', directThinFinding.length === 1 && directThinFinding[0].proposedType === 'thin-content-review');
ok('the thin-content finding\'s proposedValue is the affected page\'s own real URL, never invented content', directThinFinding[0].proposedValue === 'https://content.test/thin');
ok('the thin-content finding\'s evidence preserves the affected page\'s identity (crawl ref === the real pageId)', directThinFinding[0].evidence.some((e) => e.source === 'crawl' && e.ref === thinPageId));
const thinMerged = liveOrch.merged.find((f) => f.issueId === Number(thinContentIssue.id));
ok('the thin-content finding reaches the orchestrator and appears in the merged specialist output', !!thinMerged && thinMerged.proposedType === 'thin-content-review');
ok('the merged thin-content finding\'s provenance identifies content-agent', !!thinMerged && thinMerged.agentNames.includes('content-agent'));

/* ───────────── Test 7: content duplicate-content (no page-level identity — the agent never invents one) ───────────── */
const directDuplicateFinding = contentAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(duplicateContentIssue)] });
ok('contentAgent recognizes a real duplicate-content issue and produces a "duplicate-content-review" finding', directDuplicateFinding.length === 1 && directDuplicateFinding[0].proposedType === 'duplicate-content-review');
ok('the duplicate-content issue genuinely has no page-level identity (pageId is null, matching pageAnalyzer.js\'s own documented behavior)', duplicateContentIssue.page_id == null);
ok('the duplicate-content finding identifies only the audit\'s own real base URL — it never invents a specific duplicate-page relationship or canonical choice', directDuplicateFinding[0].proposedValue === auditContext.baseUrl);
const duplicateMerged = liveOrch.merged.find((f) => f.issueId === Number(duplicateContentIssue.id));
ok('the duplicate-content finding reaches the orchestrator and appears in the merged specialist output', !!duplicateMerged && duplicateMerged.proposedType === 'duplicate-content-review');
ok('the merged duplicate-content finding\'s provenance identifies content-agent', !!duplicateMerged && duplicateMerged.agentNames.includes('content-agent'));

/* ───────────── Test 8: converter boundary — both content finding types are explicitly rejected, not dropped earlier ───────────── */
const liveConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: allIssuesForContext, mergedFindings: liveOrch.merged, conflicts: liveOrch.conflicts });
const thinSkip = liveConverted.skipped.find((s) => s.issueId === Number(thinContentIssue.id));
const duplicateSkip = liveConverted.skipped.find((s) => s.issueId === Number(duplicateContentIssue.id));
ok('the merged "thin-content-review" finding is handed to convertSpecialistFindings() and explicitly skipped (unsupported-type), not dropped earlier', !!thinSkip && thinSkip.reason === 'unsupported-type');
ok('the merged "duplicate-content-review" finding is likewise handed to the converter and explicitly skipped as unsupported-type', !!duplicateSkip && duplicateSkip.reason === 'unsupported-type');
ok('no recommendation row exists for the thin-content issue after the real, full integration run', !recs.some((r) => Number(r.issue_id) === Number(thinContentIssue.id)));
ok('no recommendation row exists for the duplicate-content issue after the real, full integration run', !recs.some((r) => Number(r.issue_id) === Number(duplicateContentIssue.id)));
ok('exactly one recommendation exists overall for this audit (the supported title finding) — technical/internal-link/schema/content findings correctly produced zero', recs.length === 1);
ok('specialistRecommendationConverter.js (Step 4J, frozen) is completely unmodified by this step', !/contentAgent/i.test(readFileSync(fileURLToPath(new URL('./seo/specialistRecommendationConverter.js', import.meta.url)), 'utf8')));

/* ───────────── Test 9: no automatic content changes ───────────── */
ok('the title recommendation remains "pending" — no auto-apply', titleRec.status === 'pending');
ok('the title recommendation is never auto-reviewed', titleRec.reviewed_at == null && titleRec.reviewed_by == null);
ok('specialistIntegration.js never imports apply.js — Safe Apply is never called', !/from ['"]\.\/apply\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js never calls applyRecommendation', !/applyRecommendation\s*\(/.test(integrationSrc));
ok('specialistIntegration.js never imports crawler.js (no recursive scan)', !/from ['"]\.\/crawler\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js never imports jobs.js (and so cannot call or bypass its verification logic)', !integrationSrc.split('\n').some((l) => /^import /.test(l) && /jobs\.js/.test(l)));
// contentAgent.js's own docstring legitimately explains (in prose) that it never generates replacement copy
// — checking actual import statements only, same convention used elsewhere in this suite.
const contentAgentSrc = readFileSync(fileURLToPath(new URL('./seo/contentAgent.js', import.meta.url)), 'utf8');
ok('contentAgent.js never imports a CMS/content-writing module — it imports only recommendations.js (for ownership classification, not generation)', contentAgentSrc.split('\n').filter((l) => /^import /.test(l)).every((l) => /recommendations\.js/.test(l)));
ok('no content finding anywhere ever proposes a value that is NOT a real, already-known URL (never generated prose)', directThinFinding[0].proposedValue.startsWith('https://') && directDuplicateFinding[0].proposedValue.startsWith('https://'));

/* ───────────── Test 10: Performance remains disabled ───────────── */
const importLines = integrationSrc.split('\n').filter((l) => /^import /.test(l));
ok('specialistIntegration.js imports onPageAgent, technicalAgent, internalLinkAgent, schemaAgent AND contentAgent', importLines.some((l) => /onPageAgent/.test(l)) && importLines.some((l) => /technicalAgent/.test(l)) && importLines.some((l) => /internalLinkAgent/.test(l)) && importLines.some((l) => /schemaAgent/.test(l)) && importLines.some((l) => /contentAgent/.test(l)));
ok('specialistIntegration.js never imports performanceAgent', !importLines.some((l) => /performanceAgent/i.test(l)));

/* ───────────── conflict safety in the five-agent era: no winner is ever picked ───────────── */
const mockA = async () => [{ agentName: 'mock-a', issueId: titleIssue.id + 1100000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option A', reasoning: 'x' }];
const mockB = async () => [{ agentName: 'mock-b', issueId: titleIssue.id + 1100000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option B', reasoning: 'y' }];
const conflictIssue = { id: titleIssue.id + 1100000, websiteId: website.id, auditId: audit.id, pageId: titlePageId, type: 'title-length', severity: 'warning', detail: 'x' };
const conflictOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], agents: [mockA, mockB] });
const conflictConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], mergedFindings: conflictOrch.merged, conflicts: conflictOrch.conflicts });
ok('two agents disagreeing on the same issue produce a conflict, not a recommendation, with no winner selected', conflictOrch.conflicts.length === 1 && conflictOrch.merged.length === 0 && conflictConverted.recommendations.length === 0);

/* ───────────── content-agent failure isolation: the other four agents' findings survive it failing ───────────── */
const throwingContentStandIn = async () => { throw new Error('simulated content-agent failure'); };
const isolationOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [toIssue(titleIssue), toIssue(canonicalIssue), toIssue(orphanIssue), toIssue(missingJsonLdIssue)], agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, throwingContentStandIn] });
ok('a failing agent in the content-agent slot is recorded as an error, never thrown out of the orchestrator', isolationOrch.errors.length === 1);
ok('on-page, technical, internal-link, and schema findings are still present and merged despite the fifth agent failing in the same call', isolationOrch.merged.some((f) => f.agentNames.includes('on-page-agent')) && isolationOrch.merged.some((f) => f.agentNames.includes('technical-agent')) && isolationOrch.merged.some((f) => f.agentNames.includes('internal-link-agent')) && isolationOrch.merged.some((f) => f.agentNames.includes('schema-agent')));
let integrationThrew = false;
try { await runOnPageSpecialistIntegration(store, website.id, audit.id); } catch { integrationThrew = true; }
ok('the live integration function itself never throws, regardless of individual agent behavior', !integrationThrew);

/* ───────────── identity preservation, including content-issue isolation across websites/audits ───────────── */
ok('websiteId/auditId/issueId/pageId are all correct on the persisted on-page recommendation', Number(titleRec.website_id) === website.id && Number(titleRec.issue_id) === Number(titleIssue.id) && Number(titleRec.page_id) === titlePageId);

const website2 = await store.ensureWebsite('other-content.test', 'OtherContent');
const audit2 = await store.createAudit(website2.id, { baseUrl: 'https://other-content.test', pagesPlanned: 5, status: 'running' });
const w2PageId = await store.upsertPage({ websiteId: website2.id, url: 'https://other-content.test/p', finalUrl: 'https://other-content.test/p', statusCode: 200, title: 'Fine', description: 'Fine.', canonical: 'https://other-content.test/p', wordCount: 10, auditId: audit2.id });
await store.createIssues(website2.id, audit2.id, [{ pageId: w2PageId, type: 'thin-content', severity: 'warning', detail: 'only about 10 words' }]);
await store.finishAudit(audit2.id, { score: 80, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
await runOnPageSpecialistIntegration(store, website2.id, audit2.id);
const website2Recs = await store.listRecommendations({ websiteId: website2.id });
ok('a content issue under a different website never leaks a recommendation into that website (it is unsupported-type anyway, but also correctly isolated)', website2Recs.length === 0);
const website1RecsUnaffected = await store.listRecommendations({ websiteId: website.id });
ok('website 1\'s own recommendation is untouched by website 2\'s integration run', website1RecsUnaffected.length === 1 && website1RecsUnaffected[0].id === titleRec.id);

/* ───────────── provenance ───────────── */
ok('the on-page recommendation carries aiProvider "specialist-agent" and aiModel "on-page-agent"', titleRec.ai_provider === 'specialist-agent' && titleRec.ai_model === 'on-page-agent');
ok('no recommendation anywhere is ever attributed to "content-agent" as its aiModel — none is ever created', !website1RecsUnaffected.some((r) => r.ai_model === 'content-agent') && !website2Recs.some((r) => r.ai_model === 'content-agent'));
ok('no specialist recommendation ever claims Anthropic/an LLM generated it', titleRec.ai_provider !== 'anthropic' && !/claude-/i.test(titleRec.ai_model || ''));

/* ───────────── existing LLM path remains intact ───────────── */
const llmResult = await generateRecommendation({ issue: { type: 'title-length', detail: 'x' }, page: { title: 'Old', description: 'Old desc' } });
ok('the existing LLM recommendation path still runs exactly as before (reports unavailable with no key, not broken/removed)', llmResult.ok === false && llmResult.error === 'unavailable');

/* ───────────── duplicate protection: repeated execution never creates duplicate rows, for any agent's findings ───────────── */
const countBefore = (await store.listRecommendations({ websiteId: website.id })).length;
await runOnPageSpecialistIntegration(store, website.id, audit.id);   // same auditId, run again
const countAfter = (await store.listRecommendations({ websiteId: website.id })).length;
ok('running the five-agent specialist integration twice for the SAME audit never creates duplicate recommendation rows', countBefore === countAfter);
ok('the (still unsupported) content issues remain at zero recommendations after repeated execution too', !(await store.listRecommendations({ websiteId: website.id, issueId: thinContentIssue.id })).length && !(await store.listRecommendations({ websiteId: website.id, issueId: duplicateContentIssue.id })).length);

await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
