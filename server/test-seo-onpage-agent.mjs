// Phase 3 Step 4C — On-Page SEO specialist agent. Pure, deterministic, no database/network — like the
// orchestrator foundation test, this needs no SQLITE_PATH/env setup.
// Run: node server/test-seo-onpage-agent.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);

/* ───────────── fixtures ───────────── */
const auditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const longTitle = 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot';
const longDescription = 'This meta description goes on for far longer than the one hundred and sixty character limit search engines recommend, repeating itself with extra padding words so it definitely trips the length threshold used by the analyzer.';
const pages = [
  { pageId: 1, websiteId: 1, url: 'https://example.test/long-title', title: longTitle, description: 'A perfectly fine description.' },
  { pageId: 2, websiteId: 1, url: 'https://example.test/long-desc', title: 'A Fine Title', description: longDescription },
  { pageId: 3, websiteId: 1, url: 'https://example.test/no-h1', title: 'Reusable Page Title', description: 'Fine.' },
  { pageId: 4, websiteId: 1, url: 'https://example.test/short-title', title: 'Short', description: 'Fine.' },
  { pageId: 5, websiteId: 1, url: 'https://example.test/no-title', title: null, description: null },
];

/* ───────────── 9,10,11,12. issues outside on-page ownership are ignored ───────────── */
let r = onPageAgent({
  auditContext, pages,
  issues: [
    { id: 20, websiteId: 1, auditId: 100, pageId: 1, type: 'not-https', severity: 'critical', detail: 'not https' },
    { id: 21, websiteId: 1, auditId: 100, pageId: null, type: 'missing-robots-txt', severity: 'critical', detail: 'no robots.txt' },
    { id: 22, websiteId: 1, auditId: 100, pageId: 3, type: 'orphan-page', severity: 'warning', detail: 'no internal links' },
    { id: 23, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-json-ld', severity: 'info', detail: 'no structured data' },
    { id: 24, websiteId: 1, auditId: 100, pageId: 2, type: 'invalid-json-ld', severity: 'critical', detail: 'bad json-ld' },
    { id: 25, websiteId: 1, auditId: 100, pageId: 1, type: 'low-pagespeed-score', severity: 'warning', detail: 'synthetic performance issue type' },
  ],
});
ok('an unrelated technical issue (not-https) is ignored', r.length === 0 || !r.some((f) => f.issueId === 20));
ok('a sitewide technical issue (missing-robots-txt) is ignored', !r.some((f) => f.issueId === 21));
ok('an internal-link issue (orphan-page) is ignored — that is another specialist\'s territory', !r.some((f) => f.issueId === 22));
ok('a schema issue (missing-json-ld) is ignored — that is another specialist\'s territory', !r.some((f) => f.issueId === 23));
ok('a schema issue (invalid-json-ld) is ignored', !r.some((f) => f.issueId === 24));
ok('an unmapped/performance-shaped issue type is ignored, not guessed at', !r.some((f) => f.issueId === 25));
ok('none of the out-of-scope issues produced ANY finding', r.length === 0);

/* ───────────── 1–8. a valid on-page issue (title-length, too long) produces a correct finding ───────────── */
r = onPageAgent({
  auditContext, pages,
  issues: [{ id: 30, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: `title is ${longTitle.length} chars` }],
});
ok('a valid on-page issue produces exactly one AgentFinding', r.length === 1);
const f1 = r[0];
ok('agentName is correct', f1.agentName === 'on-page-agent');
ok('issueId is correct', f1.issueId === 30);
ok('confidence is a valid Confidence value', ['low', 'medium', 'high'].includes(f1.confidence));
ok('evidence cites the analyzer-flagged issue and the crawled page it was derived from', Array.isArray(f1.evidence) && f1.evidence.some((e) => e.source === 'analyzer' && e.ref === 30) && f1.evidence.some((e) => e.source === 'crawl' && e.ref === 1));
ok('proposedType matches recommendations.js\'s existing type vocabulary for this issue', f1.proposedType === 'title');
ok('proposedValue is a real prefix of the existing title, never invented text', longTitle.startsWith(f1.proposedValue) && f1.proposedValue.length <= 60);
ok('proposedValue actually fits the recommended length bound', f1.proposedValue.length <= 60);
ok('reasoning is a meaningful, non-empty explanation', typeof f1.reasoning === 'string' && f1.reasoning.length > 20);
ok('no priority field is present — Priority remains an orchestrator responsibility', !('priority' in f1));

/* ───────────── description-length (too long) ───────────── */
r = onPageAgent({
  auditContext, pages,
  issues: [{ id: 31, websiteId: 1, auditId: 100, pageId: 2, type: 'description-length', severity: 'warning', detail: `description is ${longDescription.length} chars` }],
});
ok('an over-length description produces one finding with proposedType "description"', r.length === 1 && r[0].proposedType === 'description');
ok('the trimmed description is a real prefix of the existing one, fits the bound', longDescription.startsWith(r[0].proposedValue) && r[0].proposedValue.length <= 160);

/* ───────────── missing-h1 (title exists → reused as H1) ───────────── */
r = onPageAgent({
  auditContext, pages,
  issues: [{ id: 32, websiteId: 1, auditId: 100, pageId: 3, type: 'missing-h1', severity: 'critical', detail: 'no h1' }],
});
ok('missing-h1 with an existing title produces a "heading" finding reusing that exact title', r.length === 1 && r[0].proposedType === 'heading' && r[0].proposedValue === 'Reusable Page Title');

/* ───────────── conservative: on-page-owned but no safe proposedValue → no finding ───────────── */
r = onPageAgent({
  auditContext, pages,
  issues: [
    { id: 40, websiteId: 1, auditId: 100, pageId: 5, type: 'missing-title', severity: 'critical', detail: 'no title' },
    { id: 41, websiteId: 1, auditId: 100, pageId: 5, type: 'missing-description', severity: 'critical', detail: 'no description' },
    { id: 42, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-title', severity: 'warning', detail: 'shared title' },
    { id: 43, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-description', severity: 'warning', detail: 'shared description' },
    { id: 44, websiteId: 1, auditId: 100, pageId: 3, type: 'multiple-h1', severity: 'warning', detail: 'two h1s' },
    { id: 45, websiteId: 1, auditId: 100, pageId: 3, type: 'heading-hierarchy-skip', severity: 'info', detail: 'skips a level' },
    { id: 46, websiteId: 1, auditId: 100, pageId: 4, type: 'title-length', severity: 'warning', detail: 'title is 5 chars' },   // too SHORT, not too long
    { id: 47, websiteId: 1, auditId: 100, pageId: 5, type: 'missing-h1', severity: 'critical', detail: 'no h1, and no title either' },
  ],
});
ok('missing-title is recognized as on-page but produces NO finding rather than inventing a title', r.length === 0);
ok('duplicate-title/duplicate-description/multiple-h1/heading-hierarchy-skip/too-short-title/no-title-no-h1 all produce no finding either', r.length === 0);

/* ───────────── 13. malformed issue does not crash the agent ───────────── */
let threw = false;
try {
  r = onPageAgent({ auditContext, pages, issues: [null, undefined, {}, { type: 123 }, { id: 'not-a-number', type: 'title-length' }, { id: 50, type: 'title-length', pageId: 1 }] });
} catch { threw = true; }
ok('malformed/partial issue objects never crash the agent', !threw);
ok('only the one well-formed issue among the malformed ones produces a finding, correctly', Array.isArray(r) && r.length === 1 && r[0].issueId === 50);

/* ───────────── 14. missing/empty pages is handled safely ───────────── */
threw = false;
try {
  r = onPageAgent({ auditContext, pages: undefined, issues: [{ id: 60, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' }] });
} catch { threw = true; }
ok('undefined pages does not crash the agent', !threw && r.length === 0);

r = onPageAgent({ auditContext, pages: [], issues: [{ id: 61, websiteId: 1, auditId: 100, pageId: 1, type: 'missing-h1', severity: 'critical', detail: 'x' }] });
ok('empty pages array produces no finding for an issue needing page data (nothing to derive from)', r.length === 0);

/* ───────────── 15. empty issues is handled safely ───────────── */
ok('empty issues array produces no findings', onPageAgent({ auditContext, pages, issues: [] }).length === 0);
ok('undefined issues does not crash the agent', onPageAgent({ auditContext, pages }).length === 0);
ok('no arguments at all does not crash the agent', onPageAgent().length === 0);

/* ───────────── 16. previousRecommendations do not cause unsafe behavior ───────────── */
threw = false;
try {
  r = onPageAgent({
    auditContext, pages,
    issues: [{ id: 70, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' }],
    previousRecommendations: 'not-even-an-array',
  });
} catch { threw = true; }
ok('a malformed previousRecommendations value does not crash or change the outcome', !threw && r.length === 1);

/* ───────────── 17. explicit websiteId/auditId from AuditContext are preserved ───────────── */
r = onPageAgent({
  auditContext, pages,
  issues: [
    { id: 80, websiteId: 999, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'wrong website' },
    { id: 81, websiteId: 1, auditId: 999, pageId: 1, type: 'title-length', severity: 'warning', detail: 'wrong audit' },
    { id: 82, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'matches context' },
  ],
});
ok('an issue whose websiteId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 80));
ok('an issue whose auditId does not match the explicit AuditContext is never claimed', !r.some((f) => f.issueId === 81));
ok('an issue that matches the explicit AuditContext is claimed normally', r.some((f) => f.issueId === 82));

/* ───────────── 20. multiple valid on-page issues are handled independently ───────────── */
r = onPageAgent({
  auditContext, pages,
  issues: [
    { id: 90, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' },
    { id: 91, websiteId: 1, auditId: 100, pageId: 2, type: 'description-length', severity: 'warning', detail: 'x' },
    { id: 92, websiteId: 1, auditId: 100, pageId: 3, type: 'missing-h1', severity: 'critical', detail: 'x' },
  ],
});
ok('three independent valid on-page issues each produce their own finding', r.length === 3);
ok('each finding keeps its own correct issueId and proposedType', new Set(r.map((f) => f.issueId)).size === 3 && r.find((f) => f.issueId === 90).proposedType === 'title' && r.find((f) => f.issueId === 91).proposedType === 'description' && r.find((f) => f.issueId === 92).proposedType === 'heading');

/* ───────────── 18. agent performs no writes / 19. agent does not invoke LLM (source-level proof) ───────────── */
const src = readFileSync(fileURLToPath(new URL('./seo/onPageAgent.js', import.meta.url)), 'utf8');
ok('onPageAgent.js never imports the database layer', !/from ['"]\.\.\/db\.js['"]/.test(src));
ok('onPageAgent.js never imports apply.js (the only module allowed to change production content)', !/from ['"]\.\/apply\.js['"]/.test(src));
ok('onPageAgent.js never imports llm.js — no LLM call is made', !/from ['"]\.\/llm\.js['"]/.test(src));
ok('onPageAgent.js never imports the crawler', !/from ['"]\.\/crawler\.js['"]/.test(src));
ok('onPageAgent.js never imports the job queue', !/from ['"]\.\/jobs\.js['"]/.test(src));
ok('onPageAgent.js contains no fetch() call of its own', !/\bfetch\s*\(/.test(src));
ok('onPageAgent.js contains no filesystem write call', !/writeFileSync|createWriteStream|fs\.write/.test(src));
ok('the only import onPageAgent.js has is the existing recommendation-type mapping (reused, not duplicated)', /^import \{ recommendationTypeForIssue \} from '\.\/recommendations\.js';$/m.test(src));

/* ───────────── compatible with the existing orchestrator interface (not wired into it, just compatible) ───────────── */
r = await runOrchestrator({
  auditContext, pages,
  issues: [
    { id: 100, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' },
    { id: 101, websiteId: 1, auditId: 100, pageId: 2, type: 'description-length', severity: 'warning', detail: 'x' },
  ],
  agents: [onPageAgent],
});
ok('onPageAgent can be passed directly into runOrchestrator\'s agents list and works end to end', r.errors.length === 0 && r.findings.length === 2 && r.merged.length === 2);
ok('the orchestrator run still creates no recommendations — this step stops at AgentFinding[]', r.recommendationsCreated.length === 0);

/* ───────────── the existing manual recommendation route and scan pipeline remain untouched by this step ───────────── */
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
ok('server/seo/routes.js does not reference the on-page agent — nothing was wired into a live route', !/onPageAgent|on-page-agent/i.test(routesSrc));
ok('server/seo/jobs.js does not reference the on-page agent — the live scan pipeline is unchanged', !/onPageAgent|on-page-agent/i.test(jobsSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
