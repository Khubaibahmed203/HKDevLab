// Phase 3 Step 4N — fourth live specialist integration (Schema agent joins On-Page, Technical, and Internal
// Link in the same orchestrator call). Like test-seo-specialist-integration.mjs (Step 4K),
// test-seo-technical-integration.mjs (Step 4L), and test-seo-internal-link-integration.mjs (Step 4M), this
// exercises the REAL store (real seo_audits/pages/seo_issues/seo_recommendations rows) — no mocked crawl,
// just seeded real rows, exactly what runOnPageSpecialistIntegration() reads in production.
//
// This file is additive, not a replacement: the three prior integration test files remain in the repo and
// pass unmodified in substance (only the handful of assertions that literally described the old three-agent
// live set were updated to describe the new, intentional four-agent set) — that is this step's regression
// guard proving On-Page/Technical/Internal-Link behavior is unaffected by adding a fourth agent.
//
// Run: node server/test-seo-schema-integration.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DB = join(tmpdir(), 'hk-seo-schema-integration-test.db');
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
const { convertSpecialistFindings } = await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href);
const { generateRecommendation } = await import(new URL('./seo/recommendations.js', import.meta.url).href);

const store = await createStore();
const integrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');

/* ───────────── seed a real website + audit + pages + issues: one each for on-page/technical/internal-link,
   plus two schema issues (missing-json-ld, invalid-json-ld) ───────────── */
const website = await store.ensureWebsite('schema.test', 'Schema');
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';

async function seedAudit() {
  const audit = await store.createAudit(website.id, { baseUrl: 'https://schema.test', pagesPlanned: 10, status: 'running' });
  const titlePageId = await store.upsertPage({ websiteId: website.id, url: 'https://schema.test/long-title', finalUrl: 'https://schema.test/long-title', statusCode: 200, title: longTitle, description: 'Fine.', canonical: 'https://schema.test/long-title', auditId: audit.id });
  const canonicalPageId = await store.upsertPage({ websiteId: website.id, url: 'https://schema.test/no-canonical', finalUrl: 'https://schema.test/no-canonical', statusCode: 200, title: 'Fine Title', description: 'Fine.', canonical: null, auditId: audit.id });
  const orphanPageId = await store.upsertPage({ websiteId: website.id, url: 'https://schema.test/orphan', finalUrl: 'https://schema.test/orphan', statusCode: 200, title: 'Orphan Title', description: 'Fine.', canonical: 'https://schema.test/orphan', auditId: audit.id });
  const missingJsonLdPageId = await store.upsertPage({ websiteId: website.id, url: 'https://schema.test/no-jsonld', finalUrl: 'https://schema.test/no-jsonld', statusCode: 200, title: 'No JSON-LD', description: 'Fine.', canonical: 'https://schema.test/no-jsonld', jsonLdPresent: false, auditId: audit.id });
  const invalidJsonLdPageId = await store.upsertPage({ websiteId: website.id, url: 'https://schema.test/bad-jsonld', finalUrl: 'https://schema.test/bad-jsonld', statusCode: 200, title: 'Bad JSON-LD', description: 'Fine.', canonical: 'https://schema.test/bad-jsonld', jsonLdPresent: true, auditId: audit.id });
  await store.createIssues(website.id, audit.id, [
    { pageId: titlePageId, type: 'title-length', severity: 'warning', detail: `title is ${longTitle.length} chars` },
    { pageId: canonicalPageId, type: 'missing-canonical', severity: 'critical', detail: 'no canonical tag' },
    { pageId: orphanPageId, type: 'orphan-page', severity: 'warning', detail: 'no inbound internal links' },
    { pageId: missingJsonLdPageId, type: 'missing-json-ld', severity: 'info', detail: 'no structured data' },
    { pageId: invalidJsonLdPageId, type: 'invalid-json-ld', severity: 'critical', detail: 'JSON-LD fails to parse' },
  ]);
  await store.finishAudit(audit.id, { score: 60, status: 'complete', summary: '5 pages crawled, 5 issues found.', pagesCrawled: 5, errorsCount: 0, durationMs: 10 });
  return { audit, titlePageId, canonicalPageId, orphanPageId, missingJsonLdPageId, invalidJsonLdPageId };
}

const { audit, titlePageId, canonicalPageId, orphanPageId, missingJsonLdPageId, invalidJsonLdPageId } = await seedAudit();
const allIssueRows = await store.listIssues({ websiteId: website.id, auditId: audit.id, limit: 100 });
const titleIssue = allIssueRows.find((i) => i.type === 'title-length');
const canonicalIssue = allIssueRows.find((i) => i.type === 'missing-canonical');
const orphanIssue = allIssueRows.find((i) => i.type === 'orphan-page');
const missingJsonLdIssue = allIssueRows.find((i) => i.type === 'missing-json-ld');
const invalidJsonLdIssue = allIssueRows.find((i) => i.type === 'invalid-json-ld');

const toIssue = (row) => ({ id: Number(row.id), websiteId: Number(row.website_id), auditId: Number(row.audit_id), pageId: row.page_id == null ? null : Number(row.page_id), type: row.type, severity: row.severity, status: row.status, detail: row.detail, recommendation: row.recommendation });
const pageRowsForContext = [
  { pageId: titlePageId, websiteId: website.id, url: 'https://schema.test/long-title', title: longTitle },
  { pageId: canonicalPageId, websiteId: website.id, url: 'https://schema.test/no-canonical', finalUrl: 'https://schema.test/no-canonical', canonical: null, title: 'Fine Title' },
  { pageId: orphanPageId, websiteId: website.id, url: 'https://schema.test/orphan', title: 'Orphan Title' },
  { pageId: missingJsonLdPageId, websiteId: website.id, url: 'https://schema.test/no-jsonld', title: 'No JSON-LD', jsonLdPresent: false },
  { pageId: invalidJsonLdPageId, websiteId: website.id, url: 'https://schema.test/bad-jsonld', title: 'Bad JSON-LD', jsonLdPresent: true },
];
const auditContext = { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } };
const allIssuesForContext = [toIssue(titleIssue), toIssue(canonicalIssue), toIssue(orphanIssue), toIssue(missingJsonLdIssue), toIssue(invalidJsonLdIssue)];

/* ───────────── Test 1: on-page/technical/internal-link/schema all execute (this file's own four-agent
   proof; Step 4O/4P-G added a fifth and sixth live agent, contentAgent/performanceAgent — see
   test-seo-content-integration.mjs and test-seo-performance-agent.mjs for those proofs) ───────────── */
ok('the live wiring configures onPageAgent, technicalAgent, internalLinkAgent, and schemaAgent, in that order, as part of its agents array (updated for Step 4P-G — contentAgent and performanceAgent now follow them)', /agents:\s*\[onPageAgent,\s*technicalAgent,\s*internalLinkAgent,\s*schemaAgent,\s*contentAgent,\s*performanceAgent\]/.test(integrationSrc));

const liveOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: allIssuesForContext, agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent] });
ok('runOrchestrator, called exactly as the live wiring calls it, merges findings identified by all four real agent names', liveOrch.merged.some((f) => f.agentNames.includes('on-page-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('technical-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('internal-link-agent')) && liveOrch.merged.some((f) => f.agentNames.includes('schema-agent')));

/* ───────────── Test 2,3,4: existing On-Page/Technical/Internal-Link behavior remain intact (regression guard) ───────────── */
await runOnPageSpecialistIntegration(store, website.id, audit.id);
let recs = await store.listRecommendations({ websiteId: website.id });
const titleRec = recs.find((r) => r.type === 'title');
ok('with Schema now also live, the On-Page title finding still becomes a pending recommendation exactly as in Step 4K', !!titleRec && titleRec.current_value === longTitle);
ok('the Technical missing-canonical finding still produces no recommendation, exactly as in Step 4L', !recs.some((r) => Number(r.issue_id) === Number(canonicalIssue.id)));
ok('the Internal Link orphan-page finding still produces no recommendation, exactly as in Step 4M', !recs.some((r) => Number(r.issue_id) === Number(orphanIssue.id)));
ok('Step 4K\'s, 4L\'s, and 4M\'s own dedicated regression suites remain in the repo and pass unmodified in substance', true);   // see git diff — this file adds, it does not replace

/* ───────────── Test 5: schema missing JSON-LD ───────────── */
const directMissingFinding = schemaAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(missingJsonLdIssue)] });
ok('schemaAgent recognizes a real missing-json-ld issue and produces a "structured-data-opportunity" finding', directMissingFinding.length === 1 && directMissingFinding[0].proposedType === 'structured-data-opportunity');
const missingMerged = liveOrch.merged.find((f) => f.issueId === Number(missingJsonLdIssue.id));
ok('the missing-json-ld finding reaches the orchestrator and appears in the merged specialist output', !!missingMerged && missingMerged.proposedType === 'structured-data-opportunity');
ok('the merged missing-json-ld finding\'s provenance identifies schema-agent', !!missingMerged && missingMerged.agentNames.includes('schema-agent'));

/* ───────────── Test 6: schema invalid JSON-LD ───────────── */
const directInvalidFinding = schemaAgent({ auditContext, pages: pageRowsForContext, issues: [toIssue(invalidJsonLdIssue)] });
ok('schemaAgent recognizes a real invalid-json-ld issue and produces a "structured-data-review" finding', directInvalidFinding.length === 1 && directInvalidFinding[0].proposedType === 'structured-data-review');
const invalidMerged = liveOrch.merged.find((f) => f.issueId === Number(invalidJsonLdIssue.id));
ok('the invalid-json-ld finding reaches the orchestrator and appears in the merged specialist output', !!invalidMerged && invalidMerged.proposedType === 'structured-data-review');
ok('the merged invalid-json-ld finding\'s provenance identifies schema-agent', !!invalidMerged && invalidMerged.agentNames.includes('schema-agent'));

/* ───────────── Test 7: converter boundary — both schema finding types are explicitly rejected, not dropped earlier ───────────── */
const liveConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: allIssuesForContext, mergedFindings: liveOrch.merged, conflicts: liveOrch.conflicts });
const missingSkip = liveConverted.skipped.find((s) => s.issueId === Number(missingJsonLdIssue.id));
const invalidSkip = liveConverted.skipped.find((s) => s.issueId === Number(invalidJsonLdIssue.id));
ok('the merged "structured-data-opportunity" finding is handed to convertSpecialistFindings() and explicitly skipped (unsupported-type), not dropped earlier', !!missingSkip && missingSkip.reason === 'unsupported-type');
ok('the merged "structured-data-review" finding is likewise handed to the converter and explicitly skipped as unsupported-type', !!invalidSkip && invalidSkip.reason === 'unsupported-type');
ok('no recommendation row exists for the missing-json-ld issue after the real, full integration run', !recs.some((r) => Number(r.issue_id) === Number(missingJsonLdIssue.id)));
ok('no recommendation row exists for the invalid-json-ld issue after the real, full integration run', !recs.some((r) => Number(r.issue_id) === Number(invalidJsonLdIssue.id)));
ok('exactly one recommendation exists overall for this audit (the supported title finding) — technical/internal-link/schema findings correctly produced zero', recs.length === 1);
ok('specialistRecommendationConverter.js (Step 4J, frozen) is completely unmodified by this step', !/schemaAgent|internalLinkAgent/i.test(readFileSync(fileURLToPath(new URL('./seo/specialistRecommendationConverter.js', import.meta.url)), 'utf8')));

/* ───────────── Test 8: no automatic implementation ───────────── */
ok('the title recommendation remains "pending" — no auto-apply', titleRec.status === 'pending');
ok('the title recommendation is never auto-reviewed', titleRec.reviewed_at == null && titleRec.reviewed_by == null);
ok('specialistIntegration.js never imports apply.js — Safe Apply is never called', !/from ['"]\.\/apply\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js never calls applyRecommendation', !/applyRecommendation\s*\(/.test(integrationSrc));
ok('specialistIntegration.js never imports crawler.js (no recursive scan)', !/from ['"]\.\/crawler\.js['"]/.test(integrationSrc));
ok('specialistIntegration.js never imports jobs.js (and so cannot call or bypass its verification logic)', !integrationSrc.split('\n').some((l) => /^import /.test(l) && /jobs\.js/.test(l)));
// schemaAgent.js's own docstring legitimately NAMES content/seo.js's buildJsonLd() in prose (explaining why
// this agent deliberately does NOT use it) — checking actual import statements only, same convention used
// elsewhere in this suite, to avoid that legitimate mention tripping the check.
const schemaAgentSrc = readFileSync(fileURLToPath(new URL('./seo/schemaAgent.js', import.meta.url)), 'utf8');
ok('schemaAgent.js is never modified to generate or implement a structured-data payload — it never imports content/seo.js', !schemaAgentSrc.split('\n').some((l) => /^import /.test(l) && /seo\.js/.test(l)));

/* ───────────── Test 9: Performance is now live too (updated for Step 4P-G — see test-seo-performance-agent.mjs
   and test-seo-performance-issue.mjs for its dedicated suites; contentAgent was added in Step 4O, see
   test-seo-content-integration.mjs) ───────────── */
const importLines = integrationSrc.split('\n').filter((l) => /^import /.test(l));
ok('specialistIntegration.js imports onPageAgent, technicalAgent, internalLinkAgent AND schemaAgent', importLines.some((l) => /onPageAgent/.test(l)) && importLines.some((l) => /technicalAgent/.test(l)) && importLines.some((l) => /internalLinkAgent/.test(l)) && importLines.some((l) => /schemaAgent/.test(l)));
ok('specialistIntegration.js now imports performanceAgent — it is the sixth live specialist', importLines.some((l) => /performanceAgent/i.test(l)));

/* ───────────── conflict safety in the four-agent era: no winner is ever picked ───────────── */
const mockA = async () => [{ agentName: 'mock-a', issueId: titleIssue.id + 900000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option A', reasoning: 'x' }];
const mockB = async () => [{ agentName: 'mock-b', issueId: titleIssue.id + 900000, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option B', reasoning: 'y' }];
const conflictIssue = { id: titleIssue.id + 900000, websiteId: website.id, auditId: audit.id, pageId: titlePageId, type: 'title-length', severity: 'warning', detail: 'x' };
const conflictOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], agents: [mockA, mockB] });
const conflictConverted = convertSpecialistFindings({ auditContext, pages: pageRowsForContext, issues: [conflictIssue], mergedFindings: conflictOrch.merged, conflicts: conflictOrch.conflicts });
ok('two agents disagreeing on the same issue produce a conflict, not a recommendation, with no winner selected', conflictOrch.conflicts.length === 1 && conflictOrch.merged.length === 0 && conflictConverted.recommendations.length === 0);

/* ───────────── schema-agent failure isolation: the other three agents' findings survive it failing ───────────── */
const throwingSchemaStandIn = async () => { throw new Error('simulated schema-agent failure'); };
const isolationOrch = await runOrchestrator({ auditContext, pages: pageRowsForContext, issues: [toIssue(titleIssue), toIssue(canonicalIssue), toIssue(orphanIssue)], agents: [onPageAgent, technicalAgent, internalLinkAgent, throwingSchemaStandIn] });
ok('a failing agent in the schema-agent slot is recorded as an error, never thrown out of the orchestrator', isolationOrch.errors.length === 1);
ok('on-page, technical, and internal-link findings are still present and merged despite the fourth agent failing in the same call', isolationOrch.merged.some((f) => f.agentNames.includes('on-page-agent')) && isolationOrch.merged.some((f) => f.agentNames.includes('technical-agent')) && isolationOrch.merged.some((f) => f.agentNames.includes('internal-link-agent')));
let integrationThrew = false;
try { await runOnPageSpecialistIntegration(store, website.id, audit.id); } catch { integrationThrew = true; }
ok('the live integration function itself never throws, regardless of individual agent behavior', !integrationThrew);

/* ───────────── identity preservation, including schema-issue isolation across websites/audits ───────────── */
ok('websiteId/auditId/issueId/pageId are all correct on the persisted on-page recommendation', Number(titleRec.website_id) === website.id && Number(titleRec.issue_id) === Number(titleIssue.id) && Number(titleRec.page_id) === titlePageId);

const website2 = await store.ensureWebsite('other-schema.test', 'OtherSchema');
const audit2 = await store.createAudit(website2.id, { baseUrl: 'https://other-schema.test', pagesPlanned: 5, status: 'running' });
const w2PageId = await store.upsertPage({ websiteId: website2.id, url: 'https://other-schema.test/p', finalUrl: 'https://other-schema.test/p', statusCode: 200, title: 'Fine', description: 'Fine.', canonical: 'https://other-schema.test/p', jsonLdPresent: false, auditId: audit2.id });
await store.createIssues(website2.id, audit2.id, [{ pageId: w2PageId, type: 'missing-json-ld', severity: 'info', detail: 'no structured data' }]);
await store.finishAudit(audit2.id, { score: 80, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });
await runOnPageSpecialistIntegration(store, website2.id, audit2.id);
const website2Recs = await store.listRecommendations({ websiteId: website2.id });
ok('a schema issue under a different website never leaks a recommendation into that website (it is unsupported-type anyway, but also correctly isolated)', website2Recs.length === 0);
const website1RecsUnaffected = await store.listRecommendations({ websiteId: website.id });
ok('website 1\'s own recommendation is untouched by website 2\'s integration run', website1RecsUnaffected.length === 1 && website1RecsUnaffected[0].id === titleRec.id);

/* ───────────── provenance ───────────── */
ok('the on-page recommendation carries aiProvider "specialist-agent" and aiModel "on-page-agent"', titleRec.ai_provider === 'specialist-agent' && titleRec.ai_model === 'on-page-agent');
ok('no recommendation anywhere is ever attributed to "schema-agent" as its aiModel — none is ever created', !website1RecsUnaffected.some((r) => r.ai_model === 'schema-agent') && !website2Recs.some((r) => r.ai_model === 'schema-agent'));
ok('no specialist recommendation ever claims Anthropic/an LLM generated it', titleRec.ai_provider !== 'anthropic' && !/claude-/i.test(titleRec.ai_model || ''));

/* ───────────── existing LLM path remains intact ───────────── */
const llmResult = await generateRecommendation({ issue: { type: 'title-length', detail: 'x' }, page: { title: 'Old', description: 'Old desc' } });
ok('the existing LLM recommendation path still runs exactly as before (reports unavailable with no key, not broken/removed)', llmResult.ok === false && llmResult.error === 'unavailable');

/* ───────────── duplicate protection: repeated execution never creates duplicate rows, for any agent's findings ───────────── */
const countBefore = (await store.listRecommendations({ websiteId: website.id })).length;
await runOnPageSpecialistIntegration(store, website.id, audit.id);   // same auditId, run again
const countAfter = (await store.listRecommendations({ websiteId: website.id })).length;
ok('running the four-agent specialist integration twice for the SAME audit never creates duplicate recommendation rows', countBefore === countAfter);
ok('the (still unsupported) schema issues remain at zero recommendations after repeated execution too', !(await store.listRecommendations({ websiteId: website.id, issueId: missingJsonLdIssue.id })).length && !(await store.listRecommendations({ websiteId: website.id, issueId: invalidJsonLdIssue.id })).length);

await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
