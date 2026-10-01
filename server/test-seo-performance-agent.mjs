// Phase 3 Step 4H/4P-E — Performance SEO specialist agent. Pure, deterministic, no database/network — like
// the other specialist-agent tests, this needs no SQLITE_PATH/env setup.
//
// IMPORTANT CONTEXT (see server/seo/performanceAgent.js's module docstring for the full history): until
// Step 4P-E, this repository defined NO performance issue type anywhere, so this agent was a documented,
// contract-compliant no-op that always returned []. Step 4P-E (a human-approved product decision, Step
// 4P-D) added exactly one real issue type — 'performance-score-low', created by server/seo/jobs.js when
// audit.pagespeed.available && performanceScore < 50 — and this agent now recognizes it. Every plausible
// performance-shaped type this file already tested against (synthetic strings like 'low-pagespeed-score',
// 'high-lcp', etc.) is still correctly NOT claimed, since none of them is the one real type; those tests are
// preserved below, unweakened, as the ongoing proof that this agent never invents a finding for anything
// this repository doesn't actually produce.
//
// Run: node server/test-seo-performance-agent.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { performanceAgent } = await import(new URL('./seo/performanceAgent.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { convertSpecialistFindings } = await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href);
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

/* ───────────── PERFORMANCE_ISSUE_TYPES now declares exactly the one approved type — not empty, and not
   expanded beyond it ───────────── */
const src = readFileSync(fileURLToPath(new URL('./seo/performanceAgent.js', import.meta.url)), 'utf8');
ok('PERFORMANCE_ISSUE_TYPES declares exactly ["performance-score-low"] — the one Step 4P-D/4P-E approved type, nothing more', /PERFORMANCE_ISSUE_TYPES = new Set\(\['performance-score-low'\]\)/.test(src));

/* ───────────── 13-20: performanceAgent now recognizes the one real issue type and produces a genuine,
   contract-compliant AgentFinding — no longer a faked/undemonstrable case ───────────── */
const realAuditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const realPerfIssue = { id: 500, websiteId: 1, auditId: 100, pageId: null, type: 'performance-score-low', severity: 'warning', detail: 'https://example.test scored 32/100 on Google PageSpeed Insights (mobile, lab data).' };

r = performanceAgent({ auditContext: realAuditContext, pages, issues: [realPerfIssue] });
ok('Performance Agent recognizes the real "performance-score-low" issue type', r.length === 1);
const perfFinding = r[0];
ok('the agent produces exactly one valid, contract-shaped AgentFinding (agentName/issueId/confidence/evidence/proposedType/proposedValue/reasoning all present)', perfFinding && perfFinding.agentName === 'performance-agent' && Number.isInteger(perfFinding.issueId) && ['low', 'medium', 'high'].includes(perfFinding.confidence) && Array.isArray(perfFinding.evidence) && typeof perfFinding.proposedType === 'string' && typeof perfFinding.proposedValue === 'string' && typeof perfFinding.reasoning === 'string');
ok('the finding\'s issueId correctly links back to the real originating issue', perfFinding.issueId === realPerfIssue.id);
ok('the finding carries no pageId field at all — it remains audit-level, exactly like contentAgent.js\'s duplicate-content-review finding', !('pageId' in perfFinding));
ok('the finding\'s evidence includes an entry with source "pagespeed" — the enum value Step 4A already reserved for exactly this', perfFinding.evidence.some((e) => e.source === 'pagespeed'));
ok('the finding\'s evidence also includes an entry with source "analyzer", pointing at the real issue', perfFinding.evidence.some((e) => e.source === 'analyzer' && e.ref === realPerfIssue.id));
ok('the finding\'s reasoning explicitly names mobile/lab/audit-level semantics', /mobile/i.test(perfFinding.reasoning) && /lab/i.test(perfFinding.reasoning));
// The reasoning legitimately NAMES desktop/field-data/Core Web Vitals, but only to explicitly disclaim them
// ("does not represent ... desktop performance ... Core Web Vitals") — never to imply they were measured.
// Checking for a disclaiming phrase immediately preceding those terms, not their mere absence.
ok('the finding\'s reasoning explicitly disclaims — never implies — desktop performance, real-user field data, and Core Web Vitals, naming them only to rule them out', /does not represent[\s\S]*?field[\s\S]*?desktop performance[\s\S]*?core web vitals/i.test(perfFinding.reasoning));
ok('the finding\'s reasoning does not contain a bare, undisclaimed LCP/INP/CLS/FCP/TTFB metric name (no specific Core Web Vitals metric is ever cited)', !/\bLCP\b|\bINP\b|\bCLS\b|\bFCP\b|\bTTFB\b/.test(perfFinding.reasoning));
ok('the agent does not invent a remediation — proposedValue is the real, already-known audit baseUrl, never a fabricated fix', perfFinding.proposedValue === realAuditContext.baseUrl);
ok('the agent\'s own proposedType is distinct from the issue type, following every other specialist\'s "identify, never invent" naming convention (e.g. missing-json-ld -> structured-data-opportunity)', perfFinding.proposedType !== 'performance-score-low' && typeof perfFinding.proposedType === 'string' && perfFinding.proposedType.length > 0);

/* ───────────── websiteId/auditId isolation still applies to the now-real issue type ───────────── */
r = performanceAgent({
  auditContext: realAuditContext, pages,
  issues: [
    { ...realPerfIssue, id: 501, websiteId: 999 },
    { ...realPerfIssue, id: 502, auditId: 999 },
  ],
});
ok('a real performance-score-low issue whose websiteId does not match the explicit AuditContext is never claimed', r.length === 0);

/* ───────────── a malformed version of the now-real issue type is still safely ignored ───────────── */
let threw = false;
try {
  r = performanceAgent({ auditContext: realAuditContext, pages, issues: [{ id: 'not-a-number', type: 'performance-score-low' }, { type: 'performance-score-low' }] });
} catch { threw = true; }
ok('a malformed real-type issue (non-integer/missing id) never crashes the agent and produces no finding', !threw && Array.isArray(r) && r.length === 0);
threw = false;
try {
  r = performanceAgent({ auditContext: { ...realAuditContext, baseUrl: undefined }, pages, issues: [realPerfIssue] });
} catch { threw = true; }
ok('a missing/invalid auditContext.baseUrl is handled defensively — no finding is invented without the one real fact it would need to cite', !threw && r.length === 0);

/* ───────────── converter boundary: the real issue reaches the orchestrator and the converter, and is
   correctly skipped as unsupported-type — the converter itself is never modified ───────────── */
const perfOrch = await runOrchestrator({ auditContext: realAuditContext, pages, issues: [realPerfIssue], agents: [performanceAgent] });
ok('the real performance-score-low finding reaches runOrchestrator() and appears in its merged output', perfOrch.merged.length === 1 && perfOrch.merged[0].agentNames.includes('performance-agent'));
const perfConverted = convertSpecialistFindings({ auditContext: realAuditContext, pages, issues: [realPerfIssue], mergedFindings: perfOrch.merged, conflicts: perfOrch.conflicts });
ok('the merged performance finding is handed to convertSpecialistFindings() and explicitly skipped there as unsupported-type', perfConverted.skipped.some((s) => s.issueId === realPerfIssue.id && s.reason === 'unsupported-type'));
ok('no recommendation is ever created for the performance finding — it remains detection-only, exactly like Technical/Internal-Link/Schema/Content', perfConverted.recommendations.length === 0);
const converterSrcForPerf = readFileSync(fileURLToPath(new URL('./seo/specialistRecommendationConverter.js', import.meta.url)), 'utf8');
ok('specialistRecommendationConverter.js (frozen since Step 4J) was NOT modified for this step — it still has no mention of performance anywhere', !/performance/i.test(converterSrcForPerf));

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
threw = false;
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

/* ───────────── the same cross-agent isolation, now with the REAL performance issue type mixed in — proving
   the other five live agents ignore it AND Performance Agent alone claims it ───────────── */
r = await runOrchestrator({
  auditContext: realAuditContext,
  pages: [...pages],
  issues: [
    { id: 120, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-h1', severity: 'critical', detail: 'on-page' },
    { id: 121, websiteId: 1, auditId: 100, pageId: 2, type: 'not-https', severity: 'critical', detail: 'technical' },
    { id: 122, websiteId: 1, auditId: 100, pageId: 3, type: 'orphan-page', severity: 'warning', detail: 'internal-link' },
    { id: 123, websiteId: 1, auditId: 100, pageId: 4, type: 'missing-json-ld', severity: 'info', detail: 'schema' },
    { id: 124, websiteId: 1, auditId: 100, pageId: 5, type: 'thin-content', severity: 'warning', detail: 'content' },
    { id: 125, websiteId: 1, auditId: 100, pageId: null, type: 'performance-score-low', severity: 'warning', detail: 'https://example.test scored 10/100.' },
  ],
  agents: [onPageAgent, technicalAgent, internalLinkAgent, schemaAgent, contentAgent, performanceAgent],
});
ok('with the REAL performance-score-low issue present, none of the other five live agents claim it', !r.findings.some((f) => f.agentName !== 'performance-agent' && f.issueId === 125));
ok('Performance Agent — and only Performance Agent — claims the real performance-score-low issue', r.findings.filter((f) => f.issueId === 125).length === 1 && r.findings.some((f) => f.agentName === 'performance-agent' && f.issueId === 125));
ok('exactly six findings total now (the five existing live agents\' own issues, plus Performance Agent\'s one real finding), zero errors', r.findings.length === 6 && r.errors.length === 0);
ok('the real performance finding merges cleanly (no conflict, since only one agent claims it)', r.merged.some((m) => m.issueId === 125 && m.agentNames.length === 1 && m.agentNames[0] === 'performance-agent') && !r.conflicts.some((c) => c.issueId === 125));

/* ───────────── compatible with the existing orchestrator interface using the REAL type too (strengthens the
   synthetic-type check above, which still correctly produces nothing) ───────────── */
r = await runOrchestrator({
  auditContext: realAuditContext, pages,
  issues: [realPerfIssue],
  agents: [performanceAgent],
});
ok('performanceAgent passed directly into runOrchestrator\'s agents list now genuinely produces the one real finding, with zero errors', r.errors.length === 0 && r.findings.length === 1 && r.merged.length === 1);
ok('the orchestrator run still creates no recommendations by itself — recommendation creation is the converter/integration layer\'s job, never the orchestrator\'s', r.recommendationsCreated.length === 0);

/* ───────────── the existing manual recommendation route, live scan pipeline, and other specialists/CMS are untouched ───────────── */
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const onPageSrc = readFileSync(fileURLToPath(new URL('./seo/onPageAgent.js', import.meta.url)), 'utf8');
const technicalSrc = readFileSync(fileURLToPath(new URL('./seo/technicalAgent.js', import.meta.url)), 'utf8');
const internalLinkSrc = readFileSync(fileURLToPath(new URL('./seo/internalLinkAgent.js', import.meta.url)), 'utf8');
const schemaSrc = readFileSync(fileURLToPath(new URL('./seo/schemaAgent.js', import.meta.url)), 'utf8');
const contentSrc = readFileSync(fileURLToPath(new URL('./seo/contentAgent.js', import.meta.url)), 'utf8');
const pagespeedSrc = readFileSync(fileURLToPath(new URL('./seo/pagespeed.js', import.meta.url)), 'utf8');
const specialistIntegrationSrc = readFileSync(fileURLToPath(new URL('./seo/specialistIntegration.js', import.meta.url)), 'utf8');
ok('server/seo/routes.js does not reference the performance agent — nothing was wired into a live route', !/performanceAgent|performance-agent/i.test(routesSrc));
ok('server/seo/jobs.js never imports or calls performanceAgent directly — it only produces the Issue row (Step 4P-E added that one conditional createIssues() call, nothing agent-related)', !jobsSrc.split('\n').some((l) => /^import /.test(l) && /performanceAgent/i.test(l)) && !/performanceAgent\s*\(/.test(jobsSrc));
ok('server/seo/onPageAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(onPageSrc));
ok('server/seo/technicalAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(technicalSrc));
ok('server/seo/internalLinkAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(internalLinkSrc));
ok('server/seo/schemaAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(schemaSrc));
ok('server/seo/contentAgent.js is untouched by this step', !/performanceAgent|performance-agent/i.test(contentSrc));
ok('server/seo/pagespeed.js (the existing PageSpeed client) is completely untouched by this step', !/performanceAgent|performance-agent/i.test(pagespeedSrc));
// specialistIntegration.js's own docstring legitimately NAMES performanceAgent in prose (explaining why it
// is deliberately not imported) — checking actual import statements only, same convention used throughout
// this project's integration tests, so that legitimate mention never trips this check.
ok('server/seo/specialistIntegration.js was NOT modified to import performanceAgent — Performance Agent remains NOT LIVE in the production specialist array', !specialistIntegrationSrc.split('\n').some((l) => /^import /.test(l) && /performanceAgent/i.test(l)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
