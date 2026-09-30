// Phase 3 Step 4G — Content SEO specialist agent. Pure, deterministic, no database/network — like the other
// specialist-agent tests, this needs no SQLITE_PATH/env setup.
// Run: node server/test-seo-content-agent.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { contentAgent } = await import(new URL('./seo/contentAgent.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);
const { technicalAgent } = await import(new URL('./seo/technicalAgent.js', import.meta.url).href);
const { internalLinkAgent } = await import(new URL('./seo/internalLinkAgent.js', import.meta.url).href);
const { schemaAgent } = await import(new URL('./seo/schemaAgent.js', import.meta.url).href);

/* ───────────── fixtures ───────────── */
const auditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const pages = [
  { pageId: 1, websiteId: 1, url: 'https://example.test/thin', finalUrl: 'https://example.test/thin', statusCode: 200, title: 'Thin Page', wordCount: 20 },
  { pageId: 2, websiteId: 1, url: 'https://example.test/no-h1', finalUrl: 'https://example.test/no-h1', statusCode: 200, title: 'On-Page Cross Check' },
  { pageId: 3, websiteId: 1, url: 'http://example.test/insecure', finalUrl: 'http://example.test/insecure', statusCode: 200, title: 'Technical Cross Check' },
  { pageId: 4, websiteId: 1, url: 'https://example.test/orphaned', finalUrl: 'https://example.test/orphaned', statusCode: 200, title: 'Internal-Link Cross Check' },
  { pageId: 5, websiteId: 1, url: 'https://example.test/no-schema', finalUrl: 'https://example.test/no-schema', statusCode: 200, title: 'Schema Cross Check', jsonLdPresent: false },
  { pageId: 6, websiteId: 1, url: 'https://example.test/healthy', finalUrl: 'https://example.test/healthy', statusCode: 200, title: 'Healthy Page', wordCount: 500 },
];

/* ───────────── 14,15,16,17,18,19. issues outside content ownership are ignored ───────────── */
let r = contentAgent({
  auditContext, pages,
  issues: [
    { id: 20, websiteId: 1, auditId: 100, pageId: 2, type: 'title-length', severity: 'warning', detail: 'on-page' },
    { id: 21, websiteId: 1, auditId: 100, pageId: 3, type: 'not-https', severity: 'critical', detail: 'technical' },
    { id: 22, websiteId: 1, auditId: 100, pageId: 4, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 23, websiteId: 1, auditId: 100, pageId: 5, type: 'missing-json-ld', severity: 'info', detail: 'schema' },
    { id: 24, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'synthetic performance issue type' },
    { id: 25, websiteId: 1, auditId: 100, pageId: 1, type: 'some-unknown-future-issue-type', severity: 'info', detail: 'unknown' },
  ],
});
ok('an On-Page issue (title-length) is ignored', !r.some((f) => f.issueId === 20));
ok('a Technical SEO issue (not-https) is ignored', !r.some((f) => f.issueId === 21));
ok('an Internal-Link issue (orphan-page) is ignored', !r.some((f) => f.issueId === 22));
ok('a Schema issue (missing-json-ld) is ignored', !r.some((f) => f.issueId === 23));
ok('an unmapped/performance-shaped issue type is ignored, not guessed at', !r.some((f) => f.issueId === 24));
ok('a genuinely unknown issue type is ignored', !r.some((f) => f.issueId === 25));
ok('none of the out-of-scope issues produced ANY finding', r.length === 0);

/* ───────────── 1,3-8. thin-content produces a correct finding ───────────── */
r = contentAgent({
  auditContext, pages,
  issues: [{ id: 30, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'https://example.test/thin has only about 20 words of visible text.' }],
});
ok('a valid thin-content issue produces exactly one AgentFinding', r.length === 1);
const f1 = r[0];
ok('agentName is correct', f1.agentName === 'content-agent');
ok('issueId is correct', f1.issueId === 30);
ok('confidence is a valid Confidence value', ['low', 'medium', 'high'].includes(f1.confidence));
ok('evidence cites the analyzer-flagged issue and the crawled page it was derived from', Array.isArray(f1.evidence) && f1.evidence.some((e) => e.source === 'analyzer' && e.ref === 30) && f1.evidence.some((e) => e.source === 'crawl' && e.ref === 1));
ok('proposedType is correct for a thin-content finding', f1.proposedType === 'thin-content-review');
ok('proposedValue is the affected page\'s own real URL, never invented content', f1.proposedValue === 'https://example.test/thin');
ok('reasoning cites the real word count and is meaningful', /20/.test(f1.reasoning) && f1.reasoning.length > 20);
ok('no priority field is present — Priority remains an orchestrator responsibility', !('priority' in f1));

/* ───────────── 2. duplicate-content produces a correct finding ───────────── */
r = contentAgent({
  auditContext, pages,
  issues: [{ id: 31, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-content', severity: 'warning', detail: '3 pages have near-identical visible content: https://example.test/a, https://example.test/b, https://example.test/c' }],
});
ok('a valid duplicate-content issue produces exactly one AgentFinding', r.length === 1);
const f2 = r[0];
ok('the finding identifies the audit\'s own real base URL, never one of the specific pages named only in free text', f2.proposedType === 'duplicate-content-review' && f2.proposedValue === auditContext.baseUrl);
ok('the finding does NOT contain any of the specific page URLs only mentioned in the issue\'s free-text detail', !f2.proposedValue.includes('/a') && !f2.proposedValue.includes('/b') && !f2.proposedValue.includes('/c'));
ok('evidence for duplicate-content only cites the flagged issue itself — no fabricated page-level "crawl" evidence', f2.evidence.length === 1 && f2.evidence[0].source === 'analyzer' && f2.evidence[0].ref === 31);
ok('the reasoning is honest about not choosing a canonical or duplicate page', /not proposed|review/i.test(f2.reasoning));

/* ───────────── 9,10,11,12,13. no invented content / keywords / duplicate page / canonical / titles ───────────── */
r = contentAgent({
  auditContext, pages,
  issues: [
    { id: 32, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'x' },
    { id: 33, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-content', severity: 'warning', detail: 'x' },
  ],
});
ok('no proposedValue is longer than a URL, or contains sentence-shaped generated prose (no invented content/keywords)', r.every((f) => f.proposedValue.length < 100 && !/\s/.test(f.proposedValue)));
ok('every proposedValue is a real, already-known URL (page or base URL), never fabricated', r.every((f) => f.proposedValue === pages[0].url || f.proposedValue === auditContext.baseUrl));
ok('no finding contains a "canonicalPage"/"duplicateOf"/"title"/"description" field — no canonical choice or generated metadata', r.every((f) => !('canonicalPage' in f) && !('duplicateOf' in f) && !('title' in f) && !('description' in f)));

/* ───────────── an issue whose pageId has no matching PageContext produces no finding, rather than a guess ───────────── */
r = contentAgent({
  auditContext, pages,
  issues: [{ id: 34, websiteId: 1, auditId: 100, pageId: 999, type: 'thin-content', severity: 'warning', detail: 'x' }],
});
ok('a thin-content issue with no matching PageContext produces no finding — nothing safe to identify', r.length === 0);

/* ───────────── a healthy page's word count independently re-verified, never blindly trusting a stale issue ───────────── */
r = contentAgent({
  auditContext, pages,
  issues: [{ id: 35, websiteId: 1, auditId: 100, pageId: 6, type: 'thin-content', severity: 'warning', detail: 'stale issue — page 6 actually has 500 words now' }],
});
ok('a thin-content issue against a page whose current word count is actually healthy produces no finding', r.length === 0);

/* ───────────── 20. malformed issue does not crash the agent ───────────── */
let threw = false;
try {
  r = contentAgent({ auditContext, pages, issues: [null, undefined, {}, { type: 123 }, { id: 'not-a-number', type: 'thin-content' }, { id: 50, type: 'thin-content', pageId: 1 }] });
} catch { threw = true; }
ok('malformed/partial issue objects never crash the agent', !threw);
ok('only the one well-formed issue among the malformed ones produces a finding, correctly', Array.isArray(r) && r.length === 1 && r[0].issueId === 50);

/* ───────────── 21. empty issues handled safely ───────────── */
ok('empty issues array produces no findings', contentAgent({ auditContext, pages, issues: [] }).length === 0);
ok('undefined issues does not crash the agent', contentAgent({ auditContext, pages }).length === 0);
ok('no arguments at all does not crash the agent', contentAgent().length === 0);

/* ───────────── 22. empty pages handled safely ───────────── */
threw = false;
try {
  r = contentAgent({ auditContext, pages: undefined, issues: [{ id: 60, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'x' }] });
} catch { threw = true; }
ok('undefined pages does not crash the agent', !threw && r.length === 0);
r = contentAgent({ auditContext, pages: [], issues: [{ id: 61, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'x' }] });
ok('empty pages array produces no thin-content finding — nothing to identify', r.length === 0);
r = contentAgent({ auditContext, pages: [], issues: [{ id: 62, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-content', severity: 'warning', detail: 'x' }] });
ok('duplicate-content still works with empty pages, since it never needed a PageContext lookup', r.length === 1);

/* ───────────── 23. missing previousRecommendations handled safely ───────────── */
threw = false;
try {
  r = contentAgent({
    auditContext, pages,
    issues: [{ id: 70, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'x' }],
    previousRecommendations: 'not-even-an-array',
  });
} catch { threw = true; }
ok('a malformed previousRecommendations value does not crash or change the outcome', !threw && r.length === 1);
r = contentAgent({ auditContext, pages, issues: [{ id: 71, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'x' }] });
ok('omitting previousRecommendations entirely is also safe', r.length === 1);

/* ───────────── 24. multiple content issues handled independently ───────────── */
r = contentAgent({
  auditContext, pages,
  issues: [
    { id: 80, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'x' },
    { id: 81, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-content', severity: 'warning', detail: 'x' },
  ],
});
ok('two independent valid content issues each produce their own finding', r.length === 2);
ok('each finding keeps its own correct issueId and proposedType', new Set(r.map((f) => f.issueId)).size === 2
  && r.find((f) => f.issueId === 80).proposedType === 'thin-content-review'
  && r.find((f) => f.issueId === 81).proposedType === 'duplicate-content-review');

/* ───────────── 25. websiteId/auditId are preserved from AuditContext ───────────── */
r = contentAgent({
  auditContext, pages,
  issues: [
    { id: 90, websiteId: 999, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'wrong website' },
    { id: 91, websiteId: 1, auditId: 999, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'wrong audit' },
    { id: 92, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'matches context' },
  ],
});
ok('an issue whose websiteId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 90));
ok('an issue whose auditId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 91));
ok('an issue that matches the explicit AuditContext is claimed normally', r.some((f) => f.issueId === 92));

/* ───────────── 26–33. safety proven at the source level ───────────── */
const src = readFileSync(fileURLToPath(new URL('./seo/contentAgent.js', import.meta.url)), 'utf8');
ok('contentAgent.js never imports the database layer (no writes)', !/from ['"]\.\.\/db\.js['"]/.test(src));
ok('contentAgent.js never imports apply.js (no recommendation application)', !/from ['"]\.\/apply\.js['"]/.test(src));
ok('contentAgent.js never imports llm.js — no LLM call is made', !/from ['"]\.\/llm\.js['"]/.test(src));
ok('contentAgent.js has no RAG/embeddings/vector-database reference of any kind', !/\brag\b|embedding|vector.?db|vectorStore/i.test(src));
ok('contentAgent.js never imports the crawler — no re-crawling', !/from ['"]\.\/crawler\.js['"]/.test(src));
ok('contentAgent.js never imports the orchestrator — no bypassing it, no calling it directly', !/from ['"]\.\/orchestrator\.js['"]/.test(src));
ok('contentAgent.js never imports the job queue — no scan is triggered', !/from ['"]\.\/jobs\.js['"]/.test(src));
ok('contentAgent.js contains no fetch() call of its own — no external network calls', !/\bfetch\s*\(/.test(src));
ok('contentAgent.js contains no filesystem write call', !/writeFileSync|createWriteStream|fs\.write/.test(src));
ok('contentAgent.js never references seo_recommendations or raw SQL — no direct DB record creation', !/seo_recommendations/.test(src) && !/INSERT INTO|UPDATE .* SET|DELETE FROM/i.test(src));
ok('contentAgent.js only imports the existing recommendation-type mapping (reused, not duplicated)', /^import \{ recommendationTypeForIssue \} from '\.\/recommendations\.js';$/m.test(src));
ok('contentAgent.js exports only the agent function', Object.keys(await import(new URL('./seo/contentAgent.js', import.meta.url).href)).every((k) => k === 'contentAgent'));

/* ───────────── compatible with the existing orchestrator interface (not wired into it, just compatible) ───────────── */
r = await runOrchestrator({
  auditContext, pages,
  issues: [
    { id: 100, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'x' },
    { id: 101, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-content', severity: 'warning', detail: 'x' },
  ],
  agents: [contentAgent],
});
ok('contentAgent can be passed directly into runOrchestrator\'s agents list and works end to end', r.errors.length === 0 && r.findings.length === 2 && r.merged.length === 2);
ok('the orchestrator run still creates no recommendations — this step stops at AgentFinding[]', r.recommendationsCreated.length === 0);

/* ───────────── Step 16: cross-agent isolation ───────────── */
r = await runOrchestrator({
  auditContext,
  pages: [...pages],
  issues: [
    { id: 110, websiteId: 1, auditId: 100, pageId: 2, type: 'missing-h1', severity: 'critical', detail: 'on-page' },
    { id: 111, websiteId: 1, auditId: 100, pageId: 3, type: 'not-https', severity: 'critical', detail: 'technical' },
    { id: 112, websiteId: 1, auditId: 100, pageId: 4, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 113, websiteId: 1, auditId: 100, pageId: 5, type: 'missing-json-ld', severity: 'info', detail: 'schema' },
    { id: 114, websiteId: 1, auditId: 100, pageId: 1, type: 'thin-content', severity: 'warning', detail: 'content' },
  ],
  agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent],
});
ok('On-Page Agent does not claim the Content issue', !r.findings.some((f) => f.agentName === 'on-page-agent' && f.issueId === 114));
ok('Technical Agent does not claim the Content issue', !r.findings.some((f) => f.agentName === 'technical-agent' && f.issueId === 114));
ok('Internal-Link Agent does not claim the Content issue', !r.findings.some((f) => f.agentName === 'internal-link-agent' && f.issueId === 114));
ok('Schema Agent does not claim the Content issue', !r.findings.some((f) => f.agentName === 'schema-agent' && f.issueId === 114));
ok('Content Agent does not claim the On-Page issue', !r.findings.some((f) => f.agentName === 'content-agent' && f.issueId === 110));
ok('Content Agent does not claim the Technical issue', !r.findings.some((f) => f.agentName === 'content-agent' && f.issueId === 111));
ok('Content Agent does not claim the Internal-Link issue', !r.findings.some((f) => f.agentName === 'content-agent' && f.issueId === 112));
ok('Content Agent does not claim the Schema issue', !r.findings.some((f) => f.agentName === 'content-agent' && f.issueId === 113));
ok('the Content issue was claimed exactly once, by content-agent only', r.findings.filter((f) => f.issueId === 114).length === 1 && r.findings.find((f) => f.issueId === 114).agentName === 'content-agent');
ok('all five issues were claimed exactly once, by exactly one specialist each, with zero errors', r.findings.length === 5 && r.errors.length === 0);

/* ───────────── the existing manual recommendation route, live scan pipeline, and other specialists/CMS are untouched ───────────── */
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const onPageSrc = readFileSync(fileURLToPath(new URL('./seo/onPageAgent.js', import.meta.url)), 'utf8');
const technicalSrc = readFileSync(fileURLToPath(new URL('./seo/technicalAgent.js', import.meta.url)), 'utf8');
const internalLinkSrc = readFileSync(fileURLToPath(new URL('./seo/internalLinkAgent.js', import.meta.url)), 'utf8');
const schemaSrc = readFileSync(fileURLToPath(new URL('./seo/schemaAgent.js', import.meta.url)), 'utf8');
ok('server/seo/routes.js does not reference the content agent — nothing was wired into a live route', !/contentAgent|content-agent/i.test(routesSrc));
ok('server/seo/jobs.js does not reference the content agent — the live scan pipeline is unchanged', !/contentAgent|content-agent/i.test(jobsSrc));
ok('server/seo/onPageAgent.js is untouched by this step', !/contentAgent|content-agent/i.test(onPageSrc));
ok('server/seo/technicalAgent.js is untouched by this step', !/contentAgent|content-agent/i.test(technicalSrc));
ok('server/seo/internalLinkAgent.js is untouched by this step', !/contentAgent|content-agent/i.test(internalLinkSrc));
ok('server/seo/schemaAgent.js is untouched by this step', !/contentAgent|content-agent/i.test(schemaSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
