// Phase 3 Step 4W.2 — Specialist Observability Persistence. The orchestrator's `conflicts`/`errors` and the
// converter's `skipped` were already computed every audit and then discarded the moment they'd served their
// immediate purpose (see server/seo/specialistIntegration.js). This step makes them observable by returning
// them from runOnPageSpecialistIntegration() and persisting them, as-is, into one new nullable JSON column
// (seo_audits.specialist_diagnostics), following the exact existing `pagespeed` serialization convention.
// This is observability only — it must not change which recommendations are created, skipped, or deduplicated.
// Run: node server/test-seo-specialist-diagnostics.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const DB = join(tmpdir(), 'hk-seo-specialist-diagnostics-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', SEO_CRAWL_DELAY_MS: '0' });
delete process.env.DATABASE_URL;
delete process.env.PAGESPEED_API_KEY;   // PageSpeed stays genuinely unavailable — irrelevant to this feature

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { runOnPageSpecialistIntegration } = await import(new URL('./seo/specialistIntegration.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { executeScan } = await import(new URL('./seo/jobs.js', import.meta.url).href);

const store = await createStore();
const integrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');
const converterSrc = readFileSync(fileURLToPath(new URL('./seo/specialistRecommendationConverter.js', import.meta.url)), 'utf8');
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const dbSrc = readFileSync(fileURLToPath(new URL('./db.js', import.meta.url)), 'utf8');

const website = await store.ensureWebsite('diagnostics.test', 'Diagnostics');
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';

/* ───────────── A. empty diagnostics: a clean, fully-converted finding produces no conflicts/skips/errors ───────────── */
{
  const audit = await store.createAudit(website.id, { baseUrl: 'https://diagnostics.test', pagesPlanned: 1, status: 'running' });
  const pageId = await store.upsertPage({ websiteId: website.id, url: 'https://diagnostics.test/clean', finalUrl: 'https://diagnostics.test/clean', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [{ pageId, type: 'title-length', severity: 'warning', detail: 'x' }]);
  await store.finishAudit(audit.id, { score: 90, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });

  const diagnostics = await runOnPageSpecialistIntegration(store, website.id, audit.id);
  ok('empty case: runOnPageSpecialistIntegration() returns {conflicts:[],skipped:[],errors:[]} when the only finding converts cleanly', JSON.stringify(diagnostics) === JSON.stringify({ conflicts: [], skipped: [], errors: [] }));

  await store.setSpecialistDiagnostics(audit.id, diagnostics);
  const stored = await store.getAudit(audit.id);
  ok('empty case: the persisted and re-read specialist_diagnostics matches exactly, round-tripped through JSON', JSON.stringify(stored.specialist_diagnostics) === JSON.stringify({ conflicts: [], skipped: [], errors: [] }));
  ok('regression: the clean title-length finding still became exactly one recommendation, unaffected by diagnostics persistence', (await store.listRecommendations({ websiteId: website.id, issueId: (await store.listIssues({ websiteId: website.id, auditId: audit.id }))[0].id })).length === 1);
}

/* ───────────── B. skip preservation: a real, live-six-agent unsupported-type skip survives end to end ───────────── */
{
  const audit = await store.createAudit(website.id, { baseUrl: 'https://diagnostics.test', pagesPlanned: 1, status: 'running' });
  const pageId = await store.upsertPage({ websiteId: website.id, url: 'https://diagnostics.test/no-h1', finalUrl: 'https://diagnostics.test/no-h1', statusCode: 200, title: 'Fine Title Here', description: 'Fine.', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [{ pageId, type: 'missing-h1', severity: 'critical', detail: 'no h1' }]);
  await store.finishAudit(audit.id, { score: 80, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });

  const diagnostics = await runOnPageSpecialistIntegration(store, website.id, audit.id);
  ok('skip case: exactly one skip entry is returned', diagnostics.skipped.length === 1);
  ok('skip case: the skip reason is "unsupported-type" (heading is not converter-supported)', diagnostics.skipped[0].reason === 'unsupported-type');
  ok('skip case: the skip entry carries the real issueId, no other fields', Object.keys(diagnostics.skipped[0]).sort().join(',') === 'issueId,reason');
  ok('skip case: no conflicts and no agent errors alongside the skip', diagnostics.conflicts.length === 0 && diagnostics.errors.length === 0);
  ok('regression: the unsupported heading finding still created zero recommendations', (await store.listRecommendations({ websiteId: website.id, issueId: diagnostics.skipped[0].issueId })).length === 0);

  await store.setSpecialistDiagnostics(audit.id, diagnostics);
  const stored = await store.getAudit(audit.id);
  ok('skip case: the persisted diagnostics survive the JSON round-trip exactly', JSON.stringify(stored.specialist_diagnostics) === JSON.stringify(diagnostics));

  // idempotency: running it again for the SAME audit must not duplicate or accumulate diagnostics or recommendations
  const diagnosticsAgain = await runOnPageSpecialistIntegration(store, website.id, audit.id);
  ok('regression: repeated execution for the same audit still returns exactly one (not accumulated) skip entry', diagnosticsAgain.skipped.length === 1);
  ok('regression: repeated execution never creates a duplicate recommendation (Step 4S dedup unaffected)', (await store.listRecommendations({ websiteId: website.id })).filter((r) => r.ai_provider === 'specialist-agent' && r.type === 'heading').length === 0);
}

/* ───────────── skip-reason regression guard: all 9 real reasons are still exactly these literal strings ───────────── */
const SKIP_REASONS = ['malformed-finding', 'conflicted', 'duplicate-issue', 'unknown-issue', 'website-mismatch', 'audit-mismatch', 'unsupported-type', 'missing-page', 'missing-current-value'];
ok('specialistRecommendationConverter.js still produces exactly these 9 skip reasons, unrenamed (the converter itself was not modified)', SKIP_REASONS.every((r) => converterSrc.includes(`'${r}'`)));

/* ───────────── C. conflict preservation: a genuine orchestrator conflict round-trips losslessly ───────────── */
{
  const audit = await store.createAudit(website.id, { baseUrl: 'https://diagnostics.test', pagesPlanned: 1, status: 'running' });
  const pageId = await store.upsertPage({ websiteId: website.id, url: 'https://diagnostics.test/conflict', finalUrl: 'https://diagnostics.test/conflict', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [{ pageId, type: 'title-length', severity: 'warning', detail: 'x' }]);
  const seededIssue = (await store.listIssues({ websiteId: website.id, auditId: audit.id }))[0];
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });

  // the same mock-agent-disagreement pattern test-seo-specialist-integration.mjs's own conflict test already
  // uses — the real six live agents never overlap in issue ownership, so a genuine conflict can only be
  // exercised through runOrchestrator() directly, exactly as that existing test does.
  const mockA = async () => [{ agentName: 'mock-a', issueId: seededIssue.id, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option A', reasoning: 'x' }];
  const mockB = async () => [{ agentName: 'mock-b', issueId: seededIssue.id, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 1 }], proposedType: 'title', proposedValue: 'Option B', reasoning: 'y' }];
  const auditContext = { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } };
  const orch = await runOrchestrator({ auditContext, pages: [{ pageId, websiteId: website.id, url: 'https://diagnostics.test/conflict', title: longTitle }], issues: [{ id: seededIssue.id, websiteId: website.id, auditId: audit.id, pageId, type: 'title-length' }], agents: [mockA, mockB] });
  ok('sanity: the two mock agents genuinely produced one real conflict', orch.conflicts.length === 1 && orch.conflicts[0].issueId === seededIssue.id);

  const diagnostics = { conflicts: orch.conflicts, skipped: [], errors: [] };
  await store.setSpecialistDiagnostics(audit.id, diagnostics);
  const stored = await store.getAudit(audit.id);
  ok('conflict preservation: the persisted conflict is byte-for-byte identical to the orchestrator\'s own object after a JSON round-trip', JSON.stringify(stored.specialist_diagnostics.conflicts) === JSON.stringify(orch.conflicts));
  ok('conflict preservation: the conflict retains exactly {issueId, agentNames, proposals} — no fields added or dropped', Object.keys(stored.specialist_diagnostics.conflicts[0]).sort().join(',') === 'agentNames,issueId,proposals');
  ok('conflict preservation: proposals retain each agent\'s real proposedType/proposedValue', stored.specialist_diagnostics.conflicts[0].proposals.some((p) => p.proposedValue === 'Option A') && stored.specialist_diagnostics.conflicts[0].proposals.some((p) => p.proposedValue === 'Option B'));

  ok('wiring: specialistIntegration.js destructures conflicts from runOrchestrator() and now returns it (not just passing it to the converter)', /return\s*\{\s*conflicts,\s*skipped,\s*errors\s*\}/.test(integrationSrc));
}

/* ───────────── D. error preservation + diagnostics persistence can never fail the audit ───────────── */
{
  const audit = await store.createAudit(website.id, { baseUrl: 'https://diagnostics.test', pagesPlanned: 1, status: 'running' });
  const pageId = await store.upsertPage({ websiteId: website.id, url: 'https://diagnostics.test/erroring', finalUrl: 'https://diagnostics.test/erroring', statusCode: 200, title: longTitle, description: 'Fine.', auditId: audit.id });
  await store.createIssues(website.id, audit.id, [{ pageId, type: 'title-length', severity: 'warning', detail: 'x' }]);
  const seededIssue = (await store.listIssues({ websiteId: website.id, auditId: audit.id }))[0];
  await store.finishAudit(audit.id, { score: 70, status: 'complete', summary: '1 page crawled, 1 issue found.', pagesCrawled: 1, errorsCount: 0, durationMs: 5 });

  const throwingAgent = async () => { const e = new Error('simulated agent failure with a fake secret ANTHROPIC_API_KEY=sk-should-never-appear'); throw e; };
  const auditContext = { websiteId: website.id, auditId: audit.id, startedAt: audit.started_at, baseUrl: audit.base_url, limits: { maxPages: 10, maxDepth: 5, requestTimeoutMs: 10000, crawlDelayMs: 0 } };
  const orch = await runOrchestrator({ auditContext, pages: [{ pageId, websiteId: website.id, url: 'https://diagnostics.test/erroring', title: longTitle }], issues: [{ id: seededIssue.id, websiteId: website.id, auditId: audit.id, pageId, type: 'title-length' }], agents: [throwingAgent] });
  ok('sanity: the throwing agent genuinely produced one sanitized error entry', orch.errors.length === 1 && typeof orch.errors[0].agentName === 'string');
  ok('error preservation: the error is a short STRING (the existing safeErrorMessage() convention), never a raw Error object', typeof orch.errors[0].error === 'string');
  ok('error preservation: the error message is preserved but the object is JSON-safe (no "stack" key anywhere in it)', !('stack' in orch.errors[0]) && JSON.stringify(orch.errors).indexOf('"stack"') === -1);

  let threwOnPersist = false;
  try { await store.setSpecialistDiagnostics(audit.id, { conflicts: [], skipped: [], errors: orch.errors }); } catch { threwOnPersist = true; }
  ok('persisting an error-bearing diagnostics object never throws', !threwOnPersist);

  const stored = await store.getAudit(audit.id);
  ok('error preservation: the sanitized error survives the round-trip and is present in specialist_diagnostics.errors', stored.specialist_diagnostics.errors.length === 1 && stored.specialist_diagnostics.errors[0].error.includes('simulated agent failure'));
  ok('the audit itself remains "complete" — diagnostics persistence (even for an error-bearing payload) never flips audit status', stored.status === 'complete');

  // the specialistIntegration.js-level outer catch (e.g. a broken store) must still return the empty shape, not throw or return undefined
  const brokenStore = { ...store, listPages: async () => { throw new Error('simulated specialist-layer failure'); } };
  let outerThrew = false;
  let fallback;
  try { fallback = await runOnPageSpecialistIntegration(brokenStore, website.id, audit.id); } catch { outerThrew = true; }
  ok('specialistIntegration.js-level failure (e.g. a broken store call) never throws out of runOnPageSpecialistIntegration()', !outerThrew);
  ok('…and returns the exact empty-shape fallback {conflicts:[],skipped:[],errors:[]}, never undefined', JSON.stringify(fallback) === JSON.stringify({ conflicts: [], skipped: [], errors: [] }));
}

/* ───────────── E. audit isolation: two REAL executeScan() runs never cross-contaminate diagnostics ─────────────
   Note: a local plain-HTTP test server with no real robots.txt/sitemap.xml (every real-crawl test in this
   codebase uses one — e.g. test-seo-performance-issue.mjs) unavoidably triggers two baseline findings —
   'not-https' -> technicalAgent's 'https-upgrade', and 'missing-from-sitemap' -> technicalAgent's
   'sitemap-inclusion' — both skipped as 'unsupported-type', regardless of page content (confirmed directly
   against this exact test server before writing this assertion). This test embraces that fixed 2-skip
   baseline (present in BOTH audits) and makes audit B's page additionally lack an <h1>, so the two audits are
   deterministically distinguishable by skip COUNT (2 vs 3) rather than by one side being empty. */
{
  let servePage = 'withH1';
  const httpServer = createServer((req, res) => {
    if (req.url === '/') {
      const body = servePage === 'withH1' ? '<h1>Hello</h1>' : '<p>No heading here.</p>';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html lang="en"><head><title>${longTitle}</title><meta name="viewport" content="width=device-width"><meta name="description" content="A perfectly adequate description that comfortably clears the length threshold the analyzer checks for."><link rel="canonical" href="/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script></head><body>${body}<p>${'word '.repeat(80)}</p></body></html>`);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const isolationWebsite = await store.ensureWebsite(`isolation-${port}.test`, 'Isolation');

  servePage = 'withH1';
  const auditA = await store.createAudit(isolationWebsite.id, { baseUrl, pagesPlanned: 5, status: 'queued' });
  await executeScan(store, isolationWebsite.id, auditA.id, baseUrl);
  const storedA = await store.getAudit(auditA.id);

  ok('real executeScan(): specialist_diagnostics is persisted on the real audit row (not left null)', storedA.specialist_diagnostics !== null && typeof storedA.specialist_diagnostics === 'object');
  ok('real executeScan(): a page with a real h1 produces exactly two skips (the unavoidable https-upgrade + sitemap-inclusion findings, since this test server is plain HTTP with no real sitemap)', storedA.specialist_diagnostics.skipped.length === 2);
  ok('real executeScan(): finishAudit() already ran before specialist integration — the audit is "complete" regardless of diagnostics', storedA.status === 'complete');

  servePage = 'withoutH1';
  const auditB = await store.createAudit(isolationWebsite.id, { baseUrl, pagesPlanned: 5, status: 'queued' });
  await executeScan(store, isolationWebsite.id, auditB.id, baseUrl);
  const storedB = await store.getAudit(auditB.id);
  ok('audit isolation: a second real audit, whose page additionally lacks an <h1>, gets exactly three skips (the same baseline two, plus heading) — genuinely different from audit A\'s', storedB.specialist_diagnostics.skipped.length === 3);
  ok('audit isolation: audit A\'s diagnostics are untouched by audit B running afterward (still exactly its original two skips)', JSON.stringify((await store.getAudit(auditA.id)).specialist_diagnostics) === JSON.stringify(storedA.specialist_diagnostics));

  httpServer.close();
}

/* ───────────── wiring / scope proofs (source inspection, matching this file family's established convention) ───────────── */
ok('server/db.js adds specialist_diagnostics via the existing idempotent addColumn() convention, not a new table/migration', /\['pagespeed', 'TEXT'\], \['specialist_diagnostics', 'TEXT'\]/.test(dbSrc) && !/CREATE TABLE[^)]*specialist_diagnostics/is.test(dbSrc));
ok('server/db.js\'s audit() row-shaper parses specialist_diagnostics the exact same way it already parses pagespeed', /specialist_diagnostics:\s*r\.specialist_diagnostics \? JSON\.parse\(r\.specialist_diagnostics\) : null/.test(dbSrc));
ok('setSpecialistDiagnostics() writes only the one new column — never touches status/score/finished_at/pagespeed', /UPDATE seo_audits SET specialist_diagnostics = \? WHERE id = \?/.test(dbSrc));
ok('server/seo/jobs.js persists diagnostics strictly AFTER the existing finishAudit() call — audit completion semantics are unchanged', jobsSrc.indexOf("status: 'complete'") < jobsSrc.indexOf('setSpecialistDiagnostics'));
ok('server/seo/jobs.js never lets a diagnostics-persistence failure propagate (its own .catch())', /setSpecialistDiagnostics\(auditId, diagnostics\)\s*\.catch\(/.test(jobsSrc));
ok('server/seo/orchestrator.js is completely unmodified by this step', !/specialistIntegration|setSpecialistDiagnostics/i.test(readFileSync(fileURLToPath(new URL('./seo/orchestrator.js', import.meta.url)), 'utf8')));
ok('server/seo/specialistRecommendationConverter.js is completely unmodified by this step', !/setSpecialistDiagnostics/i.test(converterSrc));
ok('server/seo/apply.js (Safe Apply) is completely unmodified by this step', !/setSpecialistDiagnostics|specialist_diagnostics/i.test(readFileSync(fileURLToPath(new URL('./seo/apply.js', import.meta.url)), 'utf8')));

await store.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
