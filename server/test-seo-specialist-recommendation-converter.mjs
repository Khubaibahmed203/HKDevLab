// Phase 3 Step 4J — specialist finding -> recommendation converter. Pure, deterministic, no
// database/network — like the specialist-agent tests, this needs no SQLITE_PATH/env setup.
// Run: node server/test-seo-specialist-recommendation-converter.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };

const { convertSpecialistFindings } = await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href);
const { runOrchestrator } = await import(new URL('./seo/orchestrator.js', import.meta.url).href);
const { onPageAgent } = await import(new URL('./seo/onPageAgent.js', import.meta.url).href);

/* ───────────── fixtures ───────────── */
const auditContext = { websiteId: 1, auditId: 100, startedAt: '2026-01-01T00:00:00.000Z', baseUrl: 'https://example.test', limits: { maxPages: 100, maxDepth: 5, requestTimeoutMs: 10_000, crawlDelayMs: 250 } };
const pages = [
  { pageId: 1, websiteId: 1, url: 'https://example.test/long-title', finalUrl: 'https://example.test/long-title', title: 'This Is An Extremely Long And Overly Descriptive Page Title That Definitely Exceeds Sixty Characters By Quite A Lot', description: 'A fine description.' },
  { pageId: 2, websiteId: 1, url: 'https://example.test/long-desc', finalUrl: 'https://example.test/long-desc', title: 'A Fine Title', description: 'This meta description goes on for far longer than the one hundred and sixty character limit search engines recommend, repeating itself with extra padding words so it definitely trips the length threshold used by the analyzer.' },
  { pageId: 3, websiteId: 1, url: 'https://example.test/no-title', finalUrl: 'https://example.test/no-title', title: null, description: 'Fine.' },
  { pageId: 4, websiteId: 1, url: 'https://example.test/no-desc', finalUrl: 'https://example.test/no-desc', title: 'Fine Title', description: null },
  { pageId: 5, websiteId: 1, url: 'https://example.test/no-h1', finalUrl: 'https://example.test/no-h1', title: 'Reusable Title' },
];

const merged = (overrides = {}) => ({
  issueId: 1, agentNames: ['on-page-agent'], confidence: 'medium',
  evidence: [{ source: 'analyzer', ref: 1 }, { source: 'crawl', ref: 1 }],
  proposedType: 'title', proposedValue: 'A Better Title', reasoning: 'Shorter and clearer.',
  ...overrides,
});

const issues = [
  { id: 10, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' },
  { id: 11, websiteId: 1, auditId: 100, pageId: 2, type: 'description-length', severity: 'warning', detail: 'x' },
  { id: 12, websiteId: 1, auditId: 100, pageId: 3, type: 'title-length', severity: 'warning', detail: 'x' },   // page 3 has no title
  { id: 13, websiteId: 1, auditId: 100, pageId: 4, type: 'description-length', severity: 'warning', detail: 'x' },  // page 4 has no description
  { id: 14, websiteId: 1, auditId: 100, pageId: 999, type: 'title-length', severity: 'warning', detail: 'x' },  // no matching page
  { id: 15, websiteId: 999, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' },  // wrong website
  { id: 16, websiteId: 1, auditId: 999, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' },    // wrong audit
  { id: 17, websiteId: 1, auditId: 100, pageId: 5, type: 'missing-h1', severity: 'critical', detail: 'x' },     // maps to unsupported 'heading'
  { id: 18, websiteId: 1, auditId: 100, pageId: null, type: 'duplicate-title', severity: 'warning', detail: 'x' },  // sitewide, no page
];

/* ───────────── 1. valid title recommendation ───────────── */
let r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 10, proposedType: 'title', proposedValue: 'A Better Title', reasoning: 'Shorter.' })] });
ok('a valid title finding produces exactly one recommendation', r.recommendations.length === 1 && r.skipped.length === 0);
let rec = r.recommendations[0];
ok('websiteId preserved from AuditContext', rec.websiteId === 1);
ok('auditId preserved from AuditContext', rec.auditId === 100);
ok('issueId preserved', rec.issueId === 10);
ok('pageId preserved (resolved via issue.pageId)', rec.pageId === 1);
ok('currentValue comes from PageContext.title, not the finding', rec.currentValue === pages[0].title);
ok('proposedValue preserved exactly', rec.proposedValue === 'A Better Title');
ok('reasoning preserved exactly', rec.reasoning === 'Shorter.');
ok('type is "title"', rec.type === 'title');

/* ───────────── 2. valid description recommendation ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 11, proposedType: 'description', proposedValue: 'A new, trimmed description.', reasoning: 'Trimmed.' })] });
ok('a valid description finding produces exactly one recommendation', r.recommendations.length === 1);
rec = r.recommendations[0];
ok('description: websiteId/auditId/issueId/pageId all preserved', rec.websiteId === 1 && rec.auditId === 100 && rec.issueId === 11 && rec.pageId === 2);
ok('description: currentValue comes from PageContext.description, not the finding', rec.currentValue === pages[1].description);
ok('description: proposedValue and reasoning preserved exactly', rec.proposedValue === 'A new, trimmed description.' && rec.reasoning === 'Trimmed.');
ok('type is "description"', rec.type === 'description');

/* ───────────── 3. current value comes from page data, not the finding (deliberately conflicting values) ───────────── */
r = convertSpecialistFindings({
  auditContext, pages, issues,
  mergedFindings: [merged({ issueId: 10, proposedType: 'title', proposedValue: pages[2].url /* an unrelated string, deliberately NOT page 1's title */, reasoning: 'x' })],
});
ok('currentValue is the PageContext value, never the finding\'s proposedValue, even when they deliberately differ', r.recommendations[0].currentValue === pages[0].title && r.recommendations[0].currentValue !== r.recommendations[0].proposedValue);

/* ───────────── 4. missing title -> no recommendation ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 12, proposedType: 'title', proposedValue: 'x', reasoning: 'x' })] });
ok('a page with no trustworthy title produces NO recommendation', r.recommendations.length === 0);
ok('…and is recorded with reason "missing-current-value", not silently dropped', r.skipped.some((s) => s.issueId === 12 && s.reason === 'missing-current-value'));

/* ───────────── 5. missing description -> no recommendation ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 13, proposedType: 'description', proposedValue: 'x', reasoning: 'x' })] });
ok('a page with no trustworthy description produces NO recommendation', r.recommendations.length === 0);
ok('…and is recorded with reason "missing-current-value"', r.skipped.some((s) => s.issueId === 13 && s.reason === 'missing-current-value'));

/* ───────────── 6. missing page -> no recommendation, no crash ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 14, proposedType: 'title', proposedValue: 'x', reasoning: 'x' })] });
ok('a finding whose issue references a page that does not exist produces NO recommendation', r.recommendations.length === 0);
ok('…and never fabricates a substitute page ("missing-page" reason)', r.skipped.some((s) => s.issueId === 14 && s.reason === 'missing-page'));

r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 18, proposedType: 'title', proposedValue: 'x', reasoning: 'x' })] });
ok('a sitewide issue with no pageId at all also produces NO recommendation (never falls back to a default page)', r.recommendations.length === 0 && r.skipped.some((s) => s.issueId === 18 && s.reason === 'missing-page'));

/* ───────────── 7. unknown issue -> no recommendation ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 99999, proposedType: 'title', proposedValue: 'x', reasoning: 'x' })] });
ok('a finding referencing an issueId that does not exist produces NO recommendation', r.recommendations.length === 0 && r.skipped.some((s) => s.issueId === 99999 && s.reason === 'unknown-issue'));

/* ───────────── 8. website mismatch -> no recommendation ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 15, proposedType: 'title', proposedValue: 'x', reasoning: 'x' })] });
ok('an issue whose websiteId does not match the trusted AuditContext produces NO recommendation', r.recommendations.length === 0 && r.skipped.some((s) => s.issueId === 15 && s.reason === 'website-mismatch'));

/* ───────────── 9. audit mismatch -> no recommendation ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 16, proposedType: 'title', proposedValue: 'x', reasoning: 'x' })] });
ok('an issue whose auditId does not match the trusted AuditContext produces NO recommendation', r.recommendations.length === 0 && r.skipped.some((s) => s.issueId === 16 && s.reason === 'audit-mismatch'));

/* ───────────── 10. unsupported recommendation type -> no recommendation, never invented support ───────────── */
for (const [issueId, proposedType] of [[17, 'heading'], [10, 'canonical'], [10, 'structured-data-review'], [10, 'thin-content-review']]) {
  r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId, proposedType, proposedValue: 'x', reasoning: 'x' })] });
  ok(`an unsupported proposedType ("${proposedType}") produces NO recommendation`, r.recommendations.length === 0 && r.skipped.some((s) => s.issueId === issueId && s.reason === 'unsupported-type'));
}

/* ───────────── 11. conflict -> no recommendation, even if also present in mergedFindings ───────────── */
r = convertSpecialistFindings({
  auditContext, pages, issues,
  mergedFindings: [merged({ issueId: 10, proposedType: 'title', proposedValue: 'x', reasoning: 'x' })],
  conflicts: [{ issueId: 10, agentNames: ['on-page-agent', 'another-agent'], proposals: [] }],
});
ok('a conflicted issue NEVER produces a recommendation, even if a (malformed) merged entry for it is also present', r.recommendations.length === 0 && r.skipped.some((s) => s.issueId === 10 && s.reason === 'conflicted'));

/* ───────────── 12. malformed finding -> safely rejected, no crash ───────────── */
let threw = false;
let malformedResult;
try {
  malformedResult = convertSpecialistFindings({
    auditContext, pages, issues,
    mergedFindings: [
      null, undefined, {},
      { issueId: 10, proposedType: 'title', proposedValue: 'x', reasoning: 'x', agentNames: ['on-page-agent'], confidence: 'medium' },   // missing evidence
      { issueId: 10, proposedType: 'title', proposedValue: 'x', agentNames: ['on-page-agent'], confidence: 'medium', evidence: [{ source: 'analyzer', ref: 10 }] },   // missing reasoning
      { issueId: 10, proposedValue: 'x', reasoning: 'x', agentNames: ['on-page-agent'], confidence: 'medium', evidence: [{ source: 'analyzer', ref: 10 }] },   // missing proposedType
      { issueId: 10, proposedType: 'title', reasoning: 'x', agentNames: ['on-page-agent'], confidence: 'medium', evidence: [{ source: 'analyzer', ref: 10 }] },   // missing proposedValue
      { agentName: 'on-page-agent', issueId: 10, confidence: 'medium', evidence: [{ source: 'analyzer', ref: 10 }], proposedType: 'title', proposedValue: 'x', reasoning: 'x' },   // RAW AgentFinding shape (agentName singular, no agentNames) — must be rejected
    ],
  });
} catch { threw = true; }
ok('malformed/partial/raw-shaped findings never crash the converter', !threw);
ok('none of the malformed entries produced a recommendation', malformedResult.recommendations.length === 0);
ok('every malformed entry is recorded with reason "malformed-finding"', malformedResult.skipped.filter((s) => s.reason === 'malformed-finding').length === 8);

/* ───────────── 13. multiple valid findings -> independent recommendations ───────────── */
r = convertSpecialistFindings({
  auditContext, pages, issues,
  mergedFindings: [
    merged({ issueId: 10, proposedType: 'title', proposedValue: 'Title fix', reasoning: 'x' }),
    merged({ issueId: 11, proposedType: 'description', proposedValue: 'Description fix', reasoning: 'y' }),
  ],
});
ok('two independent valid findings produce two independent recommendations', r.recommendations.length === 2);
ok('each recommendation keeps its own correct issueId/pageId/type', r.recommendations.find((x) => x.issueId === 10).pageId === 1 && r.recommendations.find((x) => x.issueId === 11).pageId === 2);

/* ───────────── 14. duplicate input (same issueId twice) -> only one recommendation ───────────── */
r = convertSpecialistFindings({
  auditContext, pages, issues,
  mergedFindings: [
    merged({ issueId: 10, proposedType: 'title', proposedValue: 'First', reasoning: 'x' }),
    merged({ issueId: 10, proposedType: 'title', proposedValue: 'Second', reasoning: 'y' }),   // violates the "one merged entry per issueId" contract
  ],
});
ok('a duplicated issueId in the input never produces two recommendations', r.recommendations.length === 1);
ok('the first occurrence wins; the second is recorded as a safe duplicate rejection, not silently merged again', r.recommendations[0].proposedValue === 'First' && r.skipped.some((s) => s.issueId === 10 && s.reason === 'duplicate-issue'));

/* ───────────── 15. provenance: never claims an external LLM generated a specialist finding ───────────── */
r = convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: [merged({ issueId: 10, agentNames: ['on-page-agent', 'technical-agent'] })] });
ok('aiProvider is a clearly non-LLM, honest label', r.recommendations[0].aiProvider === 'specialist-agent');
ok('aiProvider is never "anthropic" or any real LLM provider name', !/anthropic|openai|claude/i.test(r.recommendations[0].aiProvider));
ok('aiModel records the real contributing agent(s), never a fabricated model id', r.recommendations[0].aiModel === 'on-page-agent,technical-agent' && !/claude-|gpt-/i.test(r.recommendations[0].aiModel));

/* ───────────── 16. immutability ───────────── */
const auditContextCopy = JSON.parse(JSON.stringify(auditContext));
const pagesCopy = JSON.parse(JSON.stringify(pages));
const issuesCopy = JSON.parse(JSON.stringify(issues));
const findingsInput = [merged({ issueId: 10 }), merged({ issueId: 11, proposedType: 'description' })];
const findingsCopy = JSON.parse(JSON.stringify(findingsInput));
convertSpecialistFindings({ auditContext, pages, issues, mergedFindings: findingsInput });
ok('auditContext is never mutated', JSON.stringify(auditContext) === JSON.stringify(auditContextCopy));
ok('pages array is never mutated', JSON.stringify(pages) === JSON.stringify(pagesCopy));
ok('issues array is never mutated', JSON.stringify(issues) === JSON.stringify(issuesCopy));
ok('the mergedFindings input array is never mutated', JSON.stringify(findingsInput) === JSON.stringify(findingsCopy));

/* ───────────── 17. no persistence / 18. no network / LLM — proven at the source level ───────────── */
const src = readFileSync(fileURLToPath(new URL('./seo/specialistRecommendationConverter.js', import.meta.url)), 'utf8');
// A single robust check subsumes the file-specific import checks the other agents' tests use: this file has
// NO import statements at all, so it structurally cannot reach db.js, apply.js, llm.js, or the network —
// regardless of how many times those filenames are mentioned in its documentation comments (which they
// legitimately are, as part of explaining the design, e.g. "no import of server/db.js at all").
ok('the converter has NO import statements at all — nothing to persist with, call an LLM with, or reach the network with (so createRecommendation(), being unimported, cannot be called regardless of how often it is mentioned in comments)', !/^import /m.test(src));
ok('the converter contains no fetch() call of its own', !/\bfetch\s*\(/.test(src));
ok('the converter contains no raw SQL of its own', !/INSERT INTO|UPDATE .* SET|DELETE FROM/i.test(src));
ok('the converter is a synchronous, deterministic function (not async)', /export function convertSpecialistFindings/.test(src) && !/export async function convertSpecialistFindings/.test(src));
ok('the converter exports only convertSpecialistFindings', Object.keys(await import(new URL('./seo/specialistRecommendationConverter.js', import.meta.url).href)).every((k) => k === 'convertSpecialistFindings'));

/* ───────────── end-to-end: real onPageAgent + real runOrchestrator output feeds the converter cleanly ───────────── */
const realPages = [{ pageId: 1, websiteId: 1, url: 'https://example.test/long-title', finalUrl: 'https://example.test/long-title', title: pages[0].title, description: 'Fine.' }];
const realIssues = [{ id: 50, websiteId: 1, auditId: 100, pageId: 1, type: 'title-length', severity: 'warning', detail: 'x' }];
const orch = await runOrchestrator({ auditContext, pages: realPages, issues: realIssues, agents: [onPageAgent] });
ok('a real onPageAgent finding survives runOrchestrator() merge intact', orch.merged.length === 1 && orch.errors.length === 0);
const converted = convertSpecialistFindings({ auditContext, pages: realPages, issues: realIssues, mergedFindings: orch.merged, conflicts: orch.conflicts });
ok('the real orchestrator\'s merged output converts cleanly into one recommendation-compatible object', converted.recommendations.length === 1 && converted.recommendations[0].type === 'title' && converted.recommendations[0].currentValue === realPages[0].title);
ok('the end-to-end object is ready for store.createRecommendation() shape-wise, without this module ever calling it', Object.keys(converted.recommendations[0]).sort().join(',') === ['websiteId', 'auditId', 'issueId', 'pageId', 'type', 'currentValue', 'proposedValue', 'reasoning', 'aiProvider', 'aiModel'].sort().join(','));

/* ───────────── missing/invalid AuditContext is refused outright, same convention as runOrchestrator() ───────────── */
threw = false;
try { convertSpecialistFindings({ pages, issues, mergedFindings: [] }); } catch { threw = true; }
ok('a missing AuditContext is refused, not silently defaulted', threw);
threw = false;
try { convertSpecialistFindings({ auditContext: { auditId: 100 }, pages, issues, mergedFindings: [] }); } catch { threw = true; }
ok('an AuditContext missing websiteId is refused', threw);

/* ───────────── this module is not wired into anything live ───────────── */
const jobsSrc = readFileSync(fileURLToPath(new URL('./seo/jobs.js', import.meta.url)), 'utf8');
const routesSrc = readFileSync(fileURLToPath(new URL('./seo/routes.js', import.meta.url)), 'utf8');
const orchestratorSrc = readFileSync(fileURLToPath(new URL('./seo/orchestrator.js', import.meta.url)), 'utf8');
ok('server/seo/jobs.js does not reference the converter — the live scan pipeline is unchanged', !/specialistRecommendationConverter|convertSpecialistFindings/i.test(jobsSrc));
ok('server/seo/routes.js does not reference the converter — nothing was wired into a live route', !/specialistRecommendationConverter|convertSpecialistFindings/i.test(routesSrc));
ok('server/seo/orchestrator.js does not reference the converter — orchestrator.js itself is untouched by this step', !/specialistRecommendationConverter|convertSpecialistFindings/i.test(orchestratorSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
