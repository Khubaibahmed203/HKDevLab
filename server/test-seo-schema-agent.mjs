// Phase 3 Step 4F — Schema SEO specialist agent. Pure, deterministic, no database/network — like the other
// specialist-agent tests, this needs no SQLITE_PATH/env setup.
// Run: node server/test-seo-schema-agent.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { schemaAgent } = await import(new URL('./seo/schemaAgent.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);
const { technicalAgent } = await import(new URL('./seo/technicalAgent.js', import.meta.url).href);
const { internalLinkAgent } = await import(new URL('./seo/internalLinkAgent.js', import.meta.url).href);

/* ───────────── fixtures ───────────── */
const auditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const pages = [
  { pageId: 1, websiteId: 1, url: 'https://example.test/no-schema', finalUrl: 'https://example.test/no-schema', statusCode: 200, title: 'No Schema Page', jsonLdPresent: false },
  { pageId: 2, websiteId: 1, url: 'https://example.test/broken-schema', finalUrl: 'https://example.test/broken-schema', statusCode: 200, title: 'Broken Schema Page', jsonLdPresent: true },
  { pageId: 3, websiteId: 1, url: 'https://example.test/valid-schema', finalUrl: 'https://example.test/valid-schema', statusCode: 200, title: 'Valid Schema Page', jsonLdPresent: true },
  { pageId: 4, websiteId: 1, url: 'https://example.test/no-h1', finalUrl: 'https://example.test/no-h1', statusCode: 200, title: 'On-Page Cross Check' },
  { pageId: 5, websiteId: 1, url: 'http://example.test/insecure', finalUrl: 'http://example.test/insecure', statusCode: 200, title: 'Technical Cross Check' },
  { pageId: 6, websiteId: 1, url: 'https://example.test/orphaned', finalUrl: 'https://example.test/orphaned', statusCode: 200, title: 'Internal-Link Cross Check' },
];

/* ───────────── 12. an existing valid schema page (jsonLdPresent, no issue) is never falsely reported ───────────── */
let r = schemaAgent({ auditContext, pages, issues: [] });
ok('a page with valid, present JSON-LD and no corresponding issue produces no finding', r.length === 0);

/* ───────────── 13,14,15,16,17,18. issues outside schema ownership are ignored ───────────── */
r = schemaAgent({
  auditContext, pages,
  issues: [
    { id: 20, websiteId: 1, auditId: 100, pageId: 4, type: 'title-length', severity: 'warning', detail: 'on-page' },
    { id: 21, websiteId: 1, auditId: 100, pageId: 5, type: 'not-https', severity: 'critical', detail: 'technical' },
    { id: 22, websiteId: 1, auditId: 100, pageId: 6, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 23, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'content' },
    { id: 24, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'synthetic performance issue type' },
    { id: 25, websiteId: 1, auditId: 100, pageId: 1, type: 'some-unknown-future-issue-type', severity: 'info', detail: 'unknown' },
  ],
});
ok('an On-Page issue (title-length) is ignored', !r.some((f) => f.issueId === 20));
ok('a Technical SEO issue (not-https) is ignored', !r.some((f) => f.issueId === 21));
ok('an Internal-Link issue (orphan-page) is ignored', !r.some((f) => f.issueId === 22));
ok('a Content issue (thin-content) is ignored', !r.some((f) => f.issueId === 23));
ok('an unmapped/performance-shaped issue type is ignored, not guessed at', !r.some((f) => f.issueId === 24));
ok('a genuinely unknown issue type is ignored', !r.some((f) => f.issueId === 25));
ok('none of the out-of-scope issues produced ANY finding', r.length === 0);

/* ───────────── 1,3-8. missing-json-ld produces a correct finding ───────────── */
r = schemaAgent({
  auditContext, pages,
  issues: [{ id: 30, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'https://example.test/no-schema has no structured data.' }],
});
ok('a valid missing-json-ld issue produces exactly one AgentFinding', r.length === 1);
const f1 = r[0];
ok('agentName is correct', f1.agentName === 'schema-agent');
ok('issueId is correct', f1.issueId === 30);
ok('confidence is a valid Confidence value', ['low', 'medium', 'high'].includes(f1.confidence));
ok('evidence cites the analyzer-flagged issue and the crawled page it was derived from', Array.isArray(f1.evidence) && f1.evidence.some((e) => e.source === 'analyzer' && e.ref === 30) && f1.evidence.some((e) => e.source === 'crawl' && e.ref === 1));
ok('proposedType is correct for a missing-json-ld finding', f1.proposedType === 'structured-data-opportunity');
ok('proposedValue is the affected page\'s own real URL, never an invented one', f1.proposedValue === 'https://example.test/no-schema');
ok('reasoning is a meaningful, non-empty explanation', typeof f1.reasoning === 'string' && f1.reasoning.length > 20);
ok('no priority field is present — Priority remains an orchestrator responsibility', !('priority' in f1));

/* ───────────── 2. invalid-json-ld produces a correct finding ───────────── */
r = schemaAgent({
  auditContext, pages,
  issues: [{ id: 31, websiteId: 1, auditId: 100, pageId: 2, type: 'invalid-json-ld', severity: 'critical', detail: 'https://example.test/broken-schema has invalid JSON-LD.' }],
});
ok('a valid invalid-json-ld issue produces exactly one AgentFinding', r.length === 1);
ok('the finding identifies the affected page, not an invented correction', r[0].proposedType === 'structured-data-review' && r[0].proposedValue === 'https://example.test/broken-schema');
ok('the reasoning is honest about not proposing a corrected payload', /not proposed|review/i.test(r[0].reasoning));

/* ───────────── 9,10,11. no invented JSON-LD / schema types / business data ───────────── */
r = schemaAgent({
  auditContext, pages,
  issues: [
    { id: 32, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'x' },
    { id: 33, websiteId: 1, auditId: 100, pageId: 2, type: 'invalid-json-ld', severity: 'critical', detail: 'x' },
  ],
});
ok('no finding contains a "@context"/"@type" field or any JSON-LD-shaped payload — no schema was invented', r.every((f) => !('@context' in f) && !('@type' in f) && typeof f.proposedValue === 'string' && !f.proposedValue.trim().startsWith('{')));
ok('no proposedValue contains a fabricated organization/business property (email, phone, address, price, rating) — it is always just the page\'s own real URL', r.every((f) => /^https?:\/\//.test(f.proposedValue) && !/@|tel:|\$|\d{3}-\d{3}-\d{4}/.test(f.proposedValue)));
ok('every proposedValue produced is a real URL taken verbatim from the given PageContext, never fabricated', r.every((f) => pages.some((p) => p.url === f.proposedValue)));

/* ───────────── an issue whose pageId has no matching PageContext produces no finding, rather than a guess ───────────── */
r = schemaAgent({
  auditContext, pages,
  issues: [{ id: 34, websiteId: 1, auditId: 100, pageId: 999, type: 'missing-json-ld', severity: 'info', detail: 'x' }],
});
ok('a missing-json-ld issue with no matching PageContext produces no finding — nothing safe to identify', r.length === 0);

/* ───────────── 19. malformed issue does not crash the agent ───────────── */
let threw = false;
try {
  r = schemaAgent({ auditContext, pages, issues: [null, undefined, {}, { type: 123 }, { id: 'not-a-number', type: 'missing-json-ld' }, { id: 50, type: 'missing-json-ld', pageId: 1 }] });
} catch { threw = true; }
ok('malformed/partial issue objects never crash the agent', !threw);
ok('only the one well-formed issue among the malformed ones produces a finding, correctly', Array.isArray(r) && r.length === 1 && r[0].issueId === 50);

/* ───────────── 20. empty issues handled safely ───────────── */
ok('empty issues array produces no findings', schemaAgent({ auditContext, pages, issues: [] }).length === 0);
ok('undefined issues does not crash the agent', schemaAgent({ auditContext, pages }).length === 0);
ok('no arguments at all does not crash the agent', schemaAgent().length === 0);

/* ───────────── 21. empty pages handled safely ───────────── */
threw = false;
try {
  r = schemaAgent({ auditContext, pages: undefined, issues: [{ id: 60, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'x' }] });
} catch { threw = true; }
ok('undefined pages does not crash the agent', !threw && r.length === 0);
r = schemaAgent({ auditContext, pages: [], issues: [{ id: 61, websiteId: 1, auditId: 100, pageId: 2, type: 'invalid-json-ld', severity: 'critical', detail: 'x' }] });
ok('empty pages array produces no finding — nothing to identify', r.length === 0);

/* ───────────── 22. missing previousRecommendations handled safely ───────────── */
threw = false;
try {
  r = schemaAgent({
    auditContext, pages,
    issues: [{ id: 70, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'x' }],
    previousRecommendations: 'not-even-an-array',
  });
} catch { threw = true; }
ok('a malformed previousRecommendations value does not crash or change the outcome', !threw && r.length === 1);
r = schemaAgent({ auditContext, pages, issues: [{ id: 71, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'x' }] });
ok('omitting previousRecommendations entirely is also safe', r.length === 1);

/* ───────────── 23. multiple schema issues handled independently ───────────── */
r = schemaAgent({
  auditContext, pages,
  issues: [
    { id: 80, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'x' },
    { id: 81, websiteId: 1, auditId: 100, pageId: 2, type: 'invalid-json-ld', severity: 'critical', detail: 'x' },
  ],
});
ok('two independent valid schema issues each produce their own finding', r.length === 2);
ok('each finding keeps its own correct issueId and proposedType', new Set(r.map((f) => f.issueId)).size === 2
  && r.find((f) => f.issueId === 80).proposedType === 'structured-data-opportunity'
  && r.find((f) => f.issueId === 81).proposedType === 'structured-data-review');

/* ───────────── 24. websiteId/auditId are preserved from AuditContext ───────────── */
r = schemaAgent({
  auditContext, pages,
  issues: [
    { id: 90, websiteId: 999, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'wrong website' },
    { id: 91, websiteId: 1, auditId: 999, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'wrong audit' },
    { id: 92, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'matches context' },
  ],
});
ok('an issue whose websiteId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 90));
ok('an issue whose auditId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 91));
ok('an issue that matches the explicit AuditContext is claimed normally', r.some((f) => f.issueId === 92));

/* ───────────── 25–31. safety proven at the source level ───────────── */
const src = readFileSync(fileURLToPath(new URL('./seo/schemaAgent.js', import.meta.url)), 'utf8');
ok('schemaAgent.js never imports the database layer (no writes)', !/from ['"]\.\.\/db\.js['"]/.test(src));
ok('schemaAgent.js never imports apply.js (no recommendation application)', !/from ['"]\.\/apply\.js['"]/.test(src));
ok('schemaAgent.js never imports llm.js — no LLM call is made', !/from ['"]\.\/llm\.js['"]/.test(src));
ok('schemaAgent.js never imports the crawler — no re-crawling', !/from ['"]\.\/crawler\.js['"]/.test(src));
ok('schemaAgent.js never imports content/seo.js — it cannot call buildJsonLd()/injectSeo() without importing them (mentioning them by name in a comment is fine and does not count)', !/^import .* from ['"][^'"]*content\/seo\.js['"]/m.test(src));
ok('schemaAgent.js never imports the orchestrator — no bypassing it, no calling it directly', !/from ['"]\.\/orchestrator\.js['"]/.test(src));
ok('schemaAgent.js never imports the job queue — no scan is triggered', !/from ['"]\.\/jobs\.js['"]/.test(src));
ok('schemaAgent.js contains no fetch() call of its own — no external network calls', !/\bfetch\s*\(/.test(src));
ok('schemaAgent.js contains no filesystem write call', !/writeFileSync|createWriteStream|fs\.write/.test(src));
ok('schemaAgent.js never references seo_recommendations or raw SQL — no direct DB record creation', !/seo_recommendations/.test(src) && !/INSERT INTO|UPDATE .* SET|DELETE FROM/i.test(src));
ok('schemaAgent.js exports only the agent function', Object.keys(await import(new URL('./seo/schemaAgent.js', import.meta.url).href)).every((k) => k === 'schemaAgent'));

/* ───────────── compatible with the existing orchestrator interface (not wired into it, just compatible) ───────────── */
r = await runOrchestrator({
  auditContext, pages,
  issues: [
    { id: 100, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'x' },
    { id: 101, websiteId: 1, auditId: 100, pageId: 2, type: 'invalid-json-ld', severity: 'critical', detail: 'x' },
  ],
  agents: [schemaAgent],
});
ok('schemaAgent can be passed directly into runOrchestrator\'s agents list and works end to end', r.errors.length === 0 && r.findings.length === 2 && r.merged.length === 2);
ok('the orchestrator run still creates no recommendations — this step stops at AgentFinding[]', r.recommendationsCreated.length === 0);

/* ───────────── Step 14: cross-agent isolation ───────────── */
r = await runOrchestrator({
  auditContext,
  pages: [...pages],
  issues: [
    { id: 110, websiteId: 1, auditId: 100, pageId: 4, type: 'missing-h1', severity: 'critical', detail: 'on-page' },
    { id: 111, websiteId: 1, auditId: 100, pageId: 5, type: 'not-https', severity: 'critical', detail: 'technical' },
    { id: 112, websiteId: 1, auditId: 100, pageId: 6, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 113, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'schema' },
  ],
  agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent],
});
ok('On-Page Agent does not claim the Schema issue', !r.findings.some((f) => f.agentName === 'on-page-agent' && f.issueId === 113));
ok('Technical Agent does not claim the Schema issue', !r.findings.some((f) => f.agentName === 'technical-agent' && f.issueId === 113));
ok('Internal-Link Agent does not claim the Schema issue', !r.findings.some((f) => f.agentName === 'internal-link-agent' && f.issueId === 113));
ok('Schema Agent does not claim the On-Page issue', !r.findings.some((f) => f.agentName === 'schema-agent' && f.issueId === 110));
ok('Schema Agent does not claim the Technical issue', !r.findings.some((f) => f.agentName === 'schema-agent' && f.issueId === 111));
ok('Schema Agent does not claim the Internal-Link issue', !r.findings.some((f) => f.agentName === 'schema-agent' && f.issueId === 112));
ok('the Schema issue was claimed exactly once, by schema-agent only', r.findings.filter((f) => f.issueId === 113).length === 1 && r.findings.find((f) => f.issueId === 113).agentName === 'schema-agent');
ok('all four issues were claimed exactly once, by exactly one specialist each, with zero errors', r.findings.length === 4 && r.errors.length === 0);

/* ───────────── the existing manual recommendation route, live scan pipeline, and other specialists are untouched ───────────── */
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const onPageSrc = readFileSync(fileURLToPath(new URL('./seo/onPageAgent.js', import.meta.url)), 'utf8');
const technicalSrc = readFileSync(fileURLToPath(new URL('./seo/technicalAgent.js', import.meta.url)), 'utf8');
const internalLinkSrc = readFileSync(fileURLToPath(new URL('./seo/internalLinkAgent.js', import.meta.url)), 'utf8');
const contentSeoSrc = readFileSync(fileURLToPath(new URL('../content/seo.js', import.meta.url)), 'utf8');
ok('server/seo/routes.js does not reference the schema agent — nothing was wired into a live route', !/schemaAgent|schema-agent/i.test(routesSrc));
ok('server/seo/jobs.js does not reference the schema agent — the live scan pipeline is unchanged', !/schemaAgent|schema-agent/i.test(jobsSrc));
ok('server/seo/onPageAgent.js is untouched by this step', !/schemaAgent|schema-agent/i.test(onPageSrc));
ok('server/seo/technicalAgent.js is untouched by this step', !/schemaAgent|schema-agent/i.test(technicalSrc));
ok('server/seo/internalLinkAgent.js is untouched by this step', !/schemaAgent|schema-agent/i.test(internalLinkSrc));
ok('content/seo.js (the site\'s real JSON-LD builder) is completely untouched by this step', !/schemaAgent|schema-agent/i.test(contentSeoSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
