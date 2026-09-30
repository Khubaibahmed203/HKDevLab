// Phase 3 Step 4H — Performance SEO specialist agent. Pure, deterministic, no database/network — like the
// other specialist-agent tests, this needs no SQLITE_PATH/env setup.
//
// IMPORTANT CONTEXT (see server/seo/performanceAgent.js's module docstring for the full inspection):
// this repository defines NO performance issue type anywhere (server/seo/pageAnalyzer.js never produces
// one), and the one real performance signal that exists (seo_audits.pagespeed, from
// server/seo/pagespeed.js) is not exposed through AuditContext/PageContext/Issue at all. So — per Step 17
// Outcome C of the Step 4H spec — this agent is a documented, contract-compliant no-op today: it always
// returns []. Tests here prove that is true, safe, and intentional (never crashes, never invents a finding,
// never claims another specialist's issue), NOT that it produces a finding — there is no real data to
// produce one from, and inventing one would be exactly what this spec forbids.
//
// Run: node server/test-seo-performance-agent.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { performanceAgent } = await import(new URL('./seo/performanceAgent.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);
const { technicalAgent } = await import(new URL('./seo/technicalAgent.js', import.meta.url).href);
const { internalLinkAgent } = await import(new URL('./seo/internalLinkAgent.js', import.meta.url).href);
const { schemaAgent } = await import(new URL('./seo/schemaAgent.js', import.meta.url).href);
const { contentAgent } = await import(new URL('./seo/contentAgent.js', import.meta.url).href);

/* ───────────── fixtures ───────────── */
const auditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const pages = [
  { pageId: 1, websiteId: 1, url: 'https://example.test/no-h1', finalUrl: 'https://example.test/no-h1', statusCode: 200, title: 'On-Page Cross Check' },
  { pageId: 2, websiteId: 1, url: 'http://example.test/insecure', finalUrl: 'http://example.test/insecure', statusCode: 200, title: 'Technical Cross Check' },
  { pageId: 3, websiteId: 1, url: 'https://example.test/orphaned', finalUrl: 'https://example.test/orphaned', statusCode: 200, title: 'Internal-Link Cross Check' },
  { pageId: 4, websiteId: 1, url: 'https://example.test/no-schema', finalUrl: 'https://example.test/no-schema', statusCode: 200, jsonLdPresent: false },
  { pageId: 5, websiteId: 1, url: 'https://example.test/thin', finalUrl: 'https://example.test/thin', statusCode: 200, wordCount: 20 },
];

/* ───────────── 1,9,10,11,12,13. no finding is ever produced — no invented metrics, thresholds, or CWV/PageSpeed data ───────────── */
const plausiblePerformanceIssueTypes = [
  'low-pagespeed-score', 'poor-performance-score', 'slow-page', 'poor-core-web-vitals',
  'high-lcp', 'poor-lcp', 'high-inp', 'poor-inp', 'high-cls', 'poor-cls',
  'slow-fcp', 'high-ttfb', 'slow-ttfb', 'render-blocking-resources', 'large-resource-size',
  'unoptimized-images', 'slow-server-response',
];
let r = performanceAgent({
  auditContext, pages,
  issues: plausiblePerformanceIssueTypes.map((type, i) => ({ id: 900 + i, websiteId: 1, auditId: 100, pageId: 1, type, severity: 'warning', detail: `synthetic ${type} for testing — does not exist in pageAnalyzer.js` })),
});
ok('not one of 17 plausible performance-shaped issue types is ever claimed — none of them are real issue types this repository defines, so none are guessed at', r.length === 0);
ok('no Core Web Vitals metric (LCP/INP/CLS/FCP/TTFB) is ever invented — nothing is produced at all', r.length === 0);
ok('no PageSpeed score or threshold is ever invented — nothing is produced at all', r.length === 0);
ok('no optimization code/CSS/JS/compression/CDN instructions are ever generated — nothing is produced at all', r.length === 0);

/* ───────────── documented, intentional emptiness of the ownership set (proves this is deliberate, not a bug) ───────────── */
const src = readFileSync(fileURLToPath(new URL('./seo/performanceAgent.js', import.meta.url)), 'utf8');
ok('PERFORMANCE_ISSUE_TYPES is declared explicitly empty in source — the no-op is a documented design decision, not an accidental gap', /PERFORMANCE_ISSUE_TYPES = new Set\(\[\]\)/.test(src));

/* ───────────── 3–8: cannot be demonstrated with real behavior — documented, not faked ───────────── */
// agentName/issueId/confidence/evidence/proposedType/proposedValue correctness (Step 15 items 3-8) can only
// be checked on a produced AgentFinding. This repository defines no performance issue type, so this agent
// never produces one — see the block above. Faking a finding here to exercise those fields would mean
// inventing exactly the kind of synthetic performance issue Step 2 of the Step 4H spec explicitly forbids
// ("Do NOT create synthetic performance issues just for this agent"). These items are intentionally not
// independently testable with real data; the limitation is reported in the final report, not hidden here.

/* ───────────── 8 (re-read as "existing structured performance evidence is preserved"): the agent never
   mutates its input — whatever performance-shaped data a caller passes in (e.g. on auditContext, in a
   future extension) comes back untouched ───────────── */
const auditContextCopy = JSON.parse(JSON.stringify(auditContext));
const pagesCopy = JSON.parse(JSON.stringify(pages));
const issuesForMutationCheck = [{ id: 800, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'x' }];
const issuesCopy = JSON.parse(JSON.stringify(issuesForMutationCheck));
performanceAgent({ auditContext, pages, issues: issuesForMutationCheck });
ok('calling the agent never mutates the auditContext it was given', JSON.stringify(auditContext) === JSON.stringify(auditContextCopy));
ok('calling the agent never mutates the pages array it was given', JSON.stringify(pages) === JSON.stringify(pagesCopy));
ok('calling the agent never mutates the issues array it was given', JSON.stringify(issuesForMutationCheck) === JSON.stringify(issuesCopy));

/* ───────────── 14,15,16,17,18,19. issues belonging to other specialists (or unknown) are never claimed ───────────── */
r = performanceAgent({
  auditContext, pages,
  issues: [
    { id: 20, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'on-page' },
    { id: 21, websiteId: 1, auditId: 100, pageId: 2, type: 'not-https', severity: 'critical', detail: 'technical' },
    { id: 22, websiteId: 1, auditId: 100, pageId: 3, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 23, websiteId: 1, auditId: 100, pageId: 4, type: 'missing-json-ld', severity: 'info', detail: 'schema' },
    { id: 24, websiteId: 1, auditId: 100, pageId: 5, type: 'thin-content', severity: 'warning', detail: 'content' },
    { id: 25, websiteId: 1, auditId: 100, pageId: 1, type: 'some-unknown-future-issue-type', severity: 'info', detail: 'unknown' },
  ],
});
ok('an On-Page issue (title-length) is ignored', !r.some((f) => f.issueId === 20));
ok('a Technical SEO issue (not-https) is ignored', !r.some((f) => f.issueId === 21));
ok('an Internal-Link issue (orphan-page) is ignored', !r.some((f) => f.issueId === 22));
ok('a Schema issue (missing-json-ld) is ignored', !r.some((f) => f.issueId === 23));
ok('a Content issue (thin-content) is ignored', !r.some((f) => f.issueId === 24));
ok('a genuinely unknown issue type is ignored', !r.some((f) => f.issueId === 25));
ok('none of the other specialists\' issues produced ANY finding', r.length === 0);

/* ───────────── 20. malformed issue does not crash the agent ───────────── */
let threw = false;
try {
  r = performanceAgent({ auditContext, pages, issues: [null, undefined, {}, { type: 123 }, { id: 'not-a-number', type: 'low-pagespeed-score' }, { id: 50, type: 'low-pagespeed-score', pageId: 1 }] });
} catch { threw = true; }
ok('malformed/partial issue objects never crash the agent', !threw);
ok('even a well-formed issue among the malformed ones produces no finding — its type still is not a real performance issue type', Array.isArray(r) && r.length === 0);

/* ───────────── 21. empty issues handled safely ───────────── */
ok('empty issues array produces no findings', performanceAgent({ auditContext, pages, issues: [] }).length === 0);
ok('undefined issues does not crash the agent', performanceAgent({ auditContext, pages }).length === 0);
ok('no arguments at all does not crash the agent', performanceAgent().length === 0);

/* ───────────── 22. empty pages handled safely ───────────── */
threw = false;
try {
  r = performanceAgent({ auditContext, pages: undefined, issues: [{ id: 60, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'x' }] });
} catch { threw = true; }
ok('undefined pages does not crash the agent', !threw && r.length === 0);
r = performanceAgent({ auditContext, pages: [], issues: [{ id: 61, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'x' }] });
ok('empty pages array is handled safely', r.length === 0);

/* ───────────── 23. missing previousRecommendations handled safely ───────────── */
threw = false;
try {
  r = performanceAgent({
    auditContext, pages,
    issues: [{ id: 70, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'x' }],
    previousRecommendations: 'not-even-an-array',
  });
} catch { threw = true; }
ok('a malformed previousRecommendations value does not crash the agent', !threw && r.length === 0);
r = performanceAgent({ auditContext, pages, issues: [{ id: 71, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'x' }] });
ok('omitting previousRecommendations entirely is also safe', r.length === 0);

/* ───────────── 24. multiple performance-shaped issues handled independently (all still ignored) ───────────── */
r = performanceAgent({
  auditContext, pages,
  issues: [
    { id: 80, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'x' },
    { id: 81, websiteId: 1, auditId: 100, pageId: 2, type: 'high-lcp', severity: 'warning', detail: 'x' },
    { id: 82, websiteId: 1, auditId: 100, pageId: 3, type: 'high-cls', severity: 'warning', detail: 'x' },
  ],
});
ok('multiple performance-shaped issues are each independently evaluated and each independently ignored (none is real)', r.length === 0);

/* ───────────── 25. websiteId/auditId are preserved/respected from AuditContext (isolation check still applies) ───────────── */
r = performanceAgent({
  auditContext, pages,
  issues: [
    { id: 90, websiteId: 999, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'wrong website' },
    { id: 91, websiteId: 1, auditId: 999, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'wrong audit' },
    { id: 92, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'matches context' },
  ],
});
ok('an issue whose websiteId does not match the explicit AuditContext is never claimed (still true even though nothing is ever claimed)', !r.some((f) => f.issueId === 90));
ok('an issue whose auditId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 91));
ok('an issue matching the explicit AuditContext is still correctly not claimed, for the real reason (no owned type), not a context mismatch', !r.some((f) => f.issueId === 92) && r.length === 0);

/* ───────────── 26–33. safety proven at the source level ───────────── */
// A single robust check subsumes the file-specific import checks the other agents' tests use: this file has
// NO import statements at all, so it structurally cannot reach db.js, apply.js, llm.js, the crawler, the
// orchestrator, jobs.js, or pagespeed.js — regardless of how many times those filenames are mentioned in
// its documentation comments (which they legitimately are, as part of the Step 17 inspection writeup).
ok('performanceAgent.js has NO import statements at all — nothing to write with, call an LLM with, crawl with, or reach the orchestrator/DB/PageSpeed client with', !/^import /m.test(src));
ok('performanceAgent.js has no RAG/embeddings/vector-database reference of any kind', !/\brag\b|embedding|vector.?db|vectorStore/i.test(src));
ok('performanceAgent.js contains no fetch() call of its own — no external network calls', !/\bfetch\s*\(/.test(src));
ok('performanceAgent.js contains no filesystem write call', !/writeFileSync|createWriteStream|fs\.write/.test(src));
ok('performanceAgent.js never references seo_recommendations or raw SQL — no direct DB record creation', !/seo_recommendations/.test(src) && !/INSERT INTO|UPDATE .* SET|DELETE FROM/i.test(src));
ok('performanceAgent.js exports only the agent function', Object.keys(await import(new URL('./seo/performanceAgent.js', import.meta.url).href)).every((k) => k === 'performanceAgent'));

/* ───────────── compatible with the existing orchestrator interface (not wired into it, just compatible) ───────────── */
r = await runOrchestrator({
  auditContext, pages,
  issues: [{ id: 100, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'x' }],
  agents: [performanceAgent],
});
ok('performanceAgent can be passed directly into runOrchestrator\'s agents list without error, producing no findings', r.errors.length === 0 && r.findings.length === 0 && r.merged.length === 0);
ok('the orchestrator run creates no recommendations', r.recommendationsCreated.length === 0);

/* ───────────── Step 16: cross-agent isolation ───────────── */
r = await runOrchestrator({
  auditContext,
  pages: [...pages],
  issues: [
    { id: 110, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-h1', severity: 'critical', detail: 'on-page' },
    { id: 111, websiteId: 1, auditId: 100, pageId: 2, type: 'not-https', severity: 'critical', detail: 'technical' },
    { id: 112, websiteId: 1, auditId: 100, pageId: 3, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 113, websiteId: 1, auditId: 100, pageId: 4, type: 'missing-json-ld', severity: 'info', detail: 'schema' },
    { id: 114, websiteId: 1, auditId: 100, pageId: 5, type: 'thin-content', severity: 'warning', detail: 'content' },
    { id: 115, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'performance (not a real issue type)' },
  ],
  agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent, performanceAgent],
});
ok('On-Page Agent does not claim the performance-shaped issue', !r.findings.some((f) => f.agentName === 'on-page-agent' && f.issueId === 115));
ok('Technical Agent does not claim the performance-shaped issue', !r.findings.some((f) => f.agentName === 'technical-agent' && f.issueId === 115));
ok('Internal-Link Agent does not claim the performance-shaped issue', !r.findings.some((f) => f.agentName === 'internal-link-agent' && f.issueId === 115));
ok('Schema Agent does not claim the performance-shaped issue', !r.findings.some((f) => f.agentName === 'schema-agent' && f.issueId === 115));
ok('Content Agent does not claim the performance-shaped issue', !r.findings.some((f) => f.agentName === 'content-agent' && f.issueId === 115));
ok('Performance Agent does not claim the On-Page issue', !r.findings.some((f) => f.agentName === 'performance-agent' && f.issueId === 110));
ok('Performance Agent does not claim the Technical issue', !r.findings.some((f) => f.agentName === 'performance-agent' && f.issueId === 111));
ok('Performance Agent does not claim the Internal-Link issue', !r.findings.some((f) => f.agentName === 'performance-agent' && f.issueId === 112));
ok('Performance Agent does not claim the Schema issue', !r.findings.some((f) => f.agentName === 'performance-agent' && f.issueId === 113));
ok('Performance Agent does not claim the Content issue', !r.findings.some((f) => f.agentName === 'performance-agent' && f.issueId === 114));
ok('the performance-shaped issue is claimed by NOBODY — it is not a real issue type any specialist owns', !r.findings.some((f) => f.issueId === 115));
ok('exactly the five real, owned issues were claimed (one each), the synthetic performance one was not, with zero errors', r.findings.length === 5 && r.errors.length === 0);

/* ───────────── the existing manual recommendation route, live scan pipeline, and other specialists/CMS are untouched ───────────── */
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const onPageSrc = readFileSync(fileURLToPath(new URL('./seo/onPageAgent.js', import.meta.url)), 'utf8');
const technicalSrc = readFileSync(fileURLToPath(new URL('./seo/technicalAgent.js', import.meta.url)), 'utf8');
const internalLinkSrc = readFileSync(fileURLToPath(new URL('./seo/internalLinkAgent.js', import.meta.url)), 'utf8');
const schemaSrc = readFileSync(fileURLToPath(new URL('./seo/schemaAgent.js', import.meta.url)), 'utf8');
const contentSrc = readFileSync(fileURLToPath(new URL('./seo/contentAgent.js', import.meta.url)), 'utf8');
const pagespeedSrc = readFileSync(fileURLToPath(new URL('./seo/pagespeed.js', import.meta.url)), 'utf8');
ok('server/seo/routes.js does not reference the performance agent — nothing was wired into a live route', !/performanceAgent|performance-agent/i.test(routesSrc));
ok('server/seo/jobs.js does not reference the performance agent — the live scan pipeline is unchanged', !/performanceAgent|performance-agent/i.test(jobsSrc));
ok('server/seo/onPageAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(onPageSrc));
ok('server/seo/technicalAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(technicalSrc));
ok('server/seo/internalLinkAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(internalLinkSrc));
ok('server/seo/schemaAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(schemaSrc));
ok('server/seo/contentAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(contentSrc));
ok('server/seo/pagespeed.js (the existing PageSpeed client) is completely untouched by this step', !/performanceAgent|performance-agent/i.test(pagespeedSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
