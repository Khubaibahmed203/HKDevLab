// Phase 3 Step 4D — Technical SEO specialist agent. Pure, deterministic, no database/network — like the
// On-Page Agent test, this needs no SQLITE_PATH/env setup.
// Run: node server/test-seo-technical-agent.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { technicalAgent } = await import(new URL('./seo/technicalAgent.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);

/* ───────────── fixtures ───────────── */
const auditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const pages = [
  { pageId: 1, websiteId: 1, url: 'https://example.test/orphaned-from-sitemap', finalUrl: 'https://example.test/orphaned-from-sitemap', statusCode: 200, canonical: 'https://example.test/orphaned-from-sitemap' },
  { pageId: 2, websiteId: 1, url: 'https://example.test/old-path', finalUrl: 'https://example.test/new-path', statusCode: 301, canonical: null },
  { pageId: 3, websiteId: 1, url: 'http://example.test/insecure', finalUrl: 'http://example.test/insecure', statusCode: 200, canonical: null },
  { pageId: 4, websiteId: 1, url: 'https://example.test/no-canonical', finalUrl: 'https://example.test/no-canonical', statusCode: 200, canonical: '' },
  { pageId: 5, websiteId: 1, url: 'https://example.test/broken', finalUrl: 'https://example.test/broken', statusCode: 404, canonical: null },
  { pageId: 6, websiteId: 1, url: 'https://example.test/deliberately-noindexed', finalUrl: 'https://example.test/deliberately-noindexed', statusCode: 200, robotsMeta: 'noindex' },
  { pageId: 7, websiteId: 1, url: 'https://example.test/external-redirect', finalUrl: 'https://partner.example/', statusCode: 302, canonical: null },
  { pageId: 8, websiteId: 1, url: 'https://example.test/cross-domain-canonical', finalUrl: 'https://example.test/cross-domain-canonical', statusCode: 200, canonical: 'https://other-domain.test/original' },
];

/* ───────────── 9,10,11,12,13. issues outside technical ownership are ignored ───────────── */
let r = technicalAgent({
  auditContext, pages,
  issues: [
    { id: 20, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'on-page' },
    { id: 21, websiteId: 1, auditId: 100, pageId: 1, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 22, websiteId: 1, auditId: 100, pageId: 1, type: 'broken-internal-link', severity: 'warning', detail: 'internal-link' },
    { id: 23, websiteId: 1, auditId: 100, pageId: 1, type: 'link-to-redirect', severity: 'info', detail: 'internal-link' },
    { id: 24, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'schema' },
    { id: 25, websiteId: 1, auditId: 100, pageId: 1, type: 'invalid-json-ld', severity: 'critical', detail: 'schema' },
    { id: 26, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'synthetic performance issue type' },
    { id: 27, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'content' },
    { id: 28, websiteId: 1, auditId: 100, pageId: 1, type: 'duplicate-content', severity: 'warning', detail: 'content' },
  ],
});
ok('an On-Page issue (title-length) is ignored', !r.some((f) => f.issueId === 20));
ok('an Internal-Link issue (orphan-page) is ignored', !r.some((f) => f.issueId === 21));
ok('an Internal-Link issue (broken-internal-link) is ignored', !r.some((f) => f.issueId === 22));
ok('an Internal-Link issue (link-to-redirect) is ignored', !r.some((f) => f.issueId === 23));
ok('a Schema issue (missing-json-ld) is ignored', !r.some((f) => f.issueId === 24));
ok('a Schema issue (invalid-json-ld) is ignored', !r.some((f) => f.issueId === 25));
ok('an unmapped/performance-shaped issue type is ignored, not guessed at', !r.some((f) => f.issueId === 26));
ok('a Content issue (thin-content) is ignored', !r.some((f) => f.issueId === 27));
ok('a Content issue (duplicate-content) is ignored', !r.some((f) => f.issueId === 28));
ok('none of the out-of-scope issues produced ANY finding', r.length === 0);

/* ───────────── 1–8. a valid technical issue (missing-from-sitemap) produces a correct finding ───────────── */
r = technicalAgent({
  auditContext, pages,
  issues: [{ id: 30, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-from-sitemap', severity: 'info', detail: 'not in sitemap' }],
});
ok('a valid technical issue produces exactly one AgentFinding', r.length === 1);
const f1 = r[0];
ok('agentName is correct', f1.agentName === 'technical-agent');
ok('issueId is correct', f1.issueId === 30);
ok('confidence is a valid Confidence value', ['low', 'medium', 'high'].includes(f1.confidence));
ok('evidence cites the analyzer-flagged issue and the crawled page it was derived from', Array.isArray(f1.evidence) && f1.evidence.some((e) => e.source === 'analyzer' && e.ref === 30) && f1.evidence.some((e) => e.source === 'crawl' && e.ref === 1));
ok('proposedType is correct', f1.proposedType === 'sitemap-inclusion');
ok('proposedValue is the page\'s own real crawled URL, never invented', f1.proposedValue === 'https://example.test/orphaned-from-sitemap');
ok('reasoning is a meaningful, non-empty explanation', typeof f1.reasoning === 'string' && f1.reasoning.length > 20);
ok('no priority field is present — Priority remains an orchestrator responsibility', !('priority' in f1));

/* ───────────── redirect ───────────── */
r = technicalAgent({ auditContext, pages, issues: [{ id: 31, websiteId: 1, auditId: 100, pageId: 2, type: 'redirect', severity: 'info', detail: 'redirects' }] });
ok('a redirect issue produces a "redirect-target" finding pointing at the real finalUrl', r.length === 1 && r[0].proposedType === 'redirect-target' && r[0].proposedValue === 'https://example.test/new-path');

/* ───────────── not-https ───────────── */
r = technicalAgent({ auditContext, pages, issues: [{ id: 32, websiteId: 1, auditId: 100, pageId: 3, type: 'not-https', severity: 'critical', detail: 'not https' }] });
ok('a not-https issue produces an "https-upgrade" finding with only the scheme swapped', r.length === 1 && r[0].proposedType === 'https-upgrade' && r[0].proposedValue === 'https://example.test/insecure');

/* ───────────── missing-canonical ───────────── */
r = technicalAgent({ auditContext, pages, issues: [{ id: 33, websiteId: 1, auditId: 100, pageId: 4, type: 'missing-canonical', severity: 'critical', detail: 'no canonical' }] });
ok('a missing-canonical issue produces a self-referencing canonical proposal', r.length === 1 && r[0].proposedType === 'canonical' && r[0].proposedValue === 'https://example.test/no-canonical');

/* ───────────── conservative: technical-owned but no safe proposedValue → no finding ───────────── */
r = technicalAgent({
  auditContext, pages,
  issues: [
    { id: 40, websiteId: 1, auditId: 100, pageId: null, type: 'missing-robots-txt', severity: 'critical', detail: 'no robots.txt' },
    { id: 41, websiteId: 1, auditId: 100, pageId: 1, type: 'robots-disallow', severity: 'critical', detail: 'blocked by robots.txt' },
    { id: 42, websiteId: 1, auditId: 100, pageId: null, type: 'missing-sitemap', severity: 'critical', detail: 'no sitemap' },
    { id: 43, websiteId: 1, auditId: 100, pageId: null, type: 'sitemap-error', severity: 'warning', detail: 'sitemap error' },
    { id: 44, websiteId: 1, auditId: 100, pageId: null, type: 'sitemap-external-url', severity: 'warning', detail: 'external url in sitemap' },
    { id: 45, websiteId: 1, auditId: 100, pageId: 5, type: 'broken-page', severity: 'critical', detail: 'HTTP 404' },
    { id: 46, websiteId: 1, auditId: 100, pageId: 7, type: 'redirects-external', severity: 'warning', detail: 'redirects to another domain' },
    { id: 47, websiteId: 1, auditId: 100, pageId: 8, type: 'canonical-cross-domain', severity: 'warning', detail: 'canonical points elsewhere' },
    { id: 48, websiteId: 1, auditId: 100, pageId: 6, type: 'noindex', severity: 'warning', detail: 'has noindex' },
  ],
});
ok('all 9 recognized-but-unsafe technical issue types produce no finding, rather than inventing one', r.length === 0);

/* ───────────── 14. malformed issue does not crash the agent ───────────── */
let threw = false;
try {
  r = technicalAgent({ auditContext, pages, issues: [null, undefined, {}, { type: 123 }, { id: 'not-a-number', type: 'not-https' }, { id: 50, type: 'not-https', pageId: 3 }] });
} catch { threw = true; }
ok('malformed/partial issue objects never crash the agent', !threw);
ok('only the one well-formed issue among the malformed ones produces a finding, correctly', Array.isArray(r) && r.length === 1 && r[0].issueId === 50);

/* ───────────── 15. empty issues handled safely ───────────── */
ok('empty issues array produces no findings', technicalAgent({ auditContext, pages, issues: [] }).length === 0);
ok('undefined issues does not crash the agent', technicalAgent({ auditContext, pages }).length === 0);
ok('no arguments at all does not crash the agent', technicalAgent().length === 0);

/* ───────────── 16. empty pages handled safely ───────────── */
threw = false;
try {
  r = technicalAgent({ auditContext, pages: undefined, issues: [{ id: 60, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-from-sitemap', severity: 'info', detail: 'x' }] });
} catch { threw = true; }
ok('undefined pages does not crash the agent', !threw && r.length === 0);
r = technicalAgent({ auditContext, pages: [], issues: [{ id: 61, websiteId: 1, auditId: 100, pageId: 2, type: 'redirect', severity: 'info', detail: 'x' }] });
ok('empty pages array produces no finding for an issue needing page data (nothing to derive from)', r.length === 0);

/* ───────────── 17. missing optional previousRecommendations handled safely ───────────── */
threw = false;
try {
  r = technicalAgent({
    auditContext, pages,
    issues: [{ id: 70, websiteId: 1, auditId: 100, pageId: 3, type: 'not-https', severity: 'critical', detail: 'x' }],
    previousRecommendations: 'not-even-an-array',
  });
} catch { threw = true; }
ok('a malformed previousRecommendations value does not crash or change the outcome', !threw && r.length === 1);
r = technicalAgent({ auditContext, pages, issues: [{ id: 71, websiteId: 1, auditId: 100, pageId: 3, type: 'not-https', severity: 'critical', detail: 'x' }] });
ok('omitting previousRecommendations entirely is also safe', r.length === 1);

/* ───────────── 18. multiple technical issues handled independently ───────────── */
r = technicalAgent({
  auditContext, pages,
  issues: [
    { id: 80, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-from-sitemap', severity: 'info', detail: 'x' },
    { id: 81, websiteId: 1, auditId: 100, pageId: 2, type: 'redirect', severity: 'info', detail: 'x' },
    { id: 82, websiteId: 1, auditId: 100, pageId: 3, type: 'not-https', severity: 'critical', detail: 'x' },
    { id: 83, websiteId: 1, auditId: 100, pageId: 4, type: 'missing-canonical', severity: 'critical', detail: 'x' },
  ],
});
ok('four independent valid technical issues each produce their own finding', r.length === 4);
ok('each finding keeps its own correct issueId and proposedType', new Set(r.map((f) => f.issueId)).size === 4
  && r.find((f) => f.issueId === 80).proposedType === 'sitemap-inclusion'
  && r.find((f) => f.issueId === 81).proposedType === 'redirect-target'
  && r.find((f) => f.issueId === 82).proposedType === 'https-upgrade'
  && r.find((f) => f.issueId === 83).proposedType === 'canonical');

/* ───────────── 19. websiteId/auditId are preserved from AuditContext ───────────── */
r = technicalAgent({
  auditContext, pages,
  issues: [
    { id: 90, websiteId: 999, auditId: 100, pageId: 1, type: 'missing-from-sitemap', severity: 'info', detail: 'wrong website' },
    { id: 91, websiteId: 1, auditId: 999, pageId: 1, type: 'missing-from-sitemap', severity: 'info', detail: 'wrong audit' },
    { id: 92, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-from-sitemap', severity: 'info', detail: 'matches context' },
  ],
});
ok('an issue whose websiteId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 90));
ok('an issue whose auditId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 91));
ok('an issue that matches the explicit AuditContext is claimed normally', r.some((f) => f.issueId === 92));

/* ───────────── 20,21,22,23,24,25. safety proven at the source level ───────────── */
const src = readFileSync(fileURLToPath(new URL('./seo/technicalAgent.js', import.meta.url)), 'utf8');
ok('technicalAgent.js never imports the database layer (no writes)', !/from ['"]\.\.\/db\.js['"]/.test(src));
ok('technicalAgent.js never imports apply.js (no recommendation application)', !/from ['"]\.\/apply\.js['"]/.test(src));
ok('technicalAgent.js never imports llm.js — no LLM call is made', !/from ['"]\.\/llm\.js['"]/.test(src));
ok('technicalAgent.js never imports the crawler — no re-crawling', !/from ['"]\.\/crawler\.js['"]/.test(src));
ok('technicalAgent.js never imports the orchestrator — no bypassing it, no calling it directly', !/from ['"]\.\/orchestrator\.js['"]/.test(src));
ok('technicalAgent.js never imports the job queue — no scan is triggered', !/from ['"]\.\/jobs\.js['"]/.test(src));
ok('technicalAgent.js contains no fetch() call of its own — no external network calls', !/\bfetch\s*\(/.test(src));
ok('technicalAgent.js contains no filesystem write call', !/writeFileSync|createWriteStream|fs\.write/.test(src));
ok('technicalAgent.js never references seo_recommendations or raw SQL — no direct DB record creation', !/seo_recommendations/.test(src) && !/INSERT INTO|UPDATE .* SET|DELETE FROM/i.test(src));
ok('technicalAgent.js exports only the agent function', Object.keys(await import(new URL('./seo/technicalAgent.js', import.meta.url).href)).every((k) => k === 'technicalAgent'));

/* ───────────── compatible with the existing orchestrator interface (not wired into it, just compatible) ───────────── */
r = await runOrchestrator({
  auditContext, pages,
  issues: [
    { id: 100, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-from-sitemap', severity: 'info', detail: 'x' },
    { id: 101, websiteId: 1, auditId: 100, pageId: 2, type: 'redirect', severity: 'info', detail: 'x' },
  ],
  agents: [technicalAgent],
});
ok('technicalAgent can be passed directly into runOrchestrator\'s agents list and works end to end', r.errors.length === 0 && r.findings.length === 2 && r.merged.length === 2);
ok('the orchestrator run still creates no recommendations — this step stops at AgentFinding[]', r.recommendationsCreated.length === 0);

/* ───────────── both specialist agents cooperate without cross-claiming each other's issues ───────────── */
const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);
r = await runOrchestrator({
  auditContext, pages: [...pages, { pageId: 9, websiteId: 1, url: 'https://example.test/mixed', finalUrl: 'https://example.test/mixed', title: 'A Title', statusCode: 200 }],
  issues: [
    { id: 110, websiteId: 1, auditId: 100, pageId: 9, type: 'missing-h1', severity: 'critical', detail: 'no h1' },
    { id: 111, websiteId: 1, auditId: 100, pageId: 3, type: 'not-https', severity: 'critical', detail: 'x' },
  ],
  agents: [onPageAgent, technicalAgent],
});
ok('the On-Page and Technical agents each claim only their own issue, with no overlap', r.findings.length === 2 && r.findings.find((f) => f.issueId === 110).agentName === 'on-page-agent' && r.findings.find((f) => f.issueId === 111).agentName === 'technical-agent');

/* ───────────── the existing manual recommendation route, live scan pipeline, and On-Page Agent are untouched ───────────── */
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const onPageSrc = readFileSync(fileURLToPath(new URL('./seo/onPageAgent.js', import.meta.url)), 'utf8');
ok('server/seo/routes.js does not reference the technical agent — nothing was wired into a live route', !/technicalAgent|technical-agent/i.test(routesSrc));
ok('server/seo/jobs.js does not reference the technical agent — the live scan pipeline is unchanged', !/technicalAgent|technical-agent/i.test(jobsSrc));
ok('server/seo/onPageAgent.js is untouched by this step (no reference to the technical agent)', !/technicalAgent|technical-agent/i.test(onPageSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
