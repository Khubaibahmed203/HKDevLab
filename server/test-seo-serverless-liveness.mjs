// Phase 5 D4.1 — scan liveness on Vercel / serverless.
// On Vercel a function can be frozen the moment it has answered, so (1) a scan must never depend on detached work there, (2) the poll that runs a queued scan must
// stay inside the function's time limit (an execution budget: a scan that cannot finish inside it FAILS honestly, it never completes partly), (3) an audit whose
// worker is gone must reach a terminal status without waiting for the next POST /scan, and (4) an ordinary read-only overview request must never start a crawl.
// Everything here runs on a temporary SQLite database against small servers on 127.0.0.1 — no real crawling, no external service. The "Vercel" behaviour is switched
// on with the VERCEL environment variable. What this CANNOT show: what Vercel itself does (freezing, its real time limit), or real PostgreSQL concurrency.
// Run: node server/test-seo-serverless-liveness.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const DB = join(tmpdir(), 'hk-seo-serverless-liveness-test.db');
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
Object.assign(process.env, { SQLITE_PATH: DB, SMTP_HOST: '', SETUP_TOKEN: '', GOOGLE_CLIENT_ID: '', NODE_ENV: 'development', CONTENT_TTL_MS: '100', SEO_CRAWL_DELAY_MS: '1' });
for (const k of ['DATABASE_URL', 'PAGESPEED_API_KEY', 'VERCEL', 'VERCEL_ENV', 'SEO_STALE_AUDIT_MS', 'SEO_SCAN_BUDGET_MS', 'SEO_MAX_PAGES', 'SEO_MAX_DEPTH', 'SEO_REQUEST_TIMEOUT_MS', 'PUBLIC_URL']) delete process.env[k];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

/** Sets environment variables (undefined deletes one) for the duration of fn, then puts them back. */
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const VERCEL = { VERCEL: '1' };

// the application logs recoveries and failures with console.error; keep them out of the output but available to assert on
const logs = []; const realError = console.error; console.error = (...a) => { logs.push(a.join(' ')); };

// detached scheduling is observed, not assumed: count the setImmediate calls that carry a scan (the only ones whose source mentions executeScan)
const realSetImmediate = globalThis.setImmediate; let detached = 0;
globalThis.setImmediate = (fn, ...rest) => { if (String(fn).includes('executeScan')) detached++; return realSetImmediate(fn, ...rest); };

/* ───────────── fixtures ───────────── */
const servers = [];
const serve = (handler) => new Promise((resolve) => {
  const s = createServer(handler); servers.push(s);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); resolve({ port, host: `127.0.0.1:${port}`, base: `http://127.0.0.1:${port}` }); });
});
const PAGE = '<!doctype html><html lang="en"><head><title>Liveness fixture</title><meta name="description" content="A tiny page used by the serverless liveness test."></head><body><h1>Fixture</h1><a href="/other">other page</a></body></html>';
/** A two-page site. `delay` slows the home page; `sitemaps` are declared in robots.txt, each answering after `sitemapDelay`. */
async function fixture({ delay = 0, sitemaps = [], sitemapDelay = 0 } = {}) {
  const hits = [];
  const s = await serve((req, res) => {
    hits.push(req.url);
    if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\n${sitemaps.map((p) => `Sitemap: http://${req.headers.host}${p}\n`).join('')}`); }
    if (sitemaps.includes(req.url)) { return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<urlset></urlset>'); }, sitemapDelay); }
    if (req.url === '/' || req.url === '/other') { return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); }, req.url === '/' ? delay : 0); }
    res.writeHead(404); res.end();
  });
  return { ...s, hits, home: () => hits.filter((u) => u === '/').length };
}

/* ───────────── the real app, on SQLite, with an admin ───────────── */
const { createApp } = await import(new URL('./app.js', import.meta.url).href);
const { app, store } = await createApp();
const appServer = await new Promise((r) => { const s = app.listen(8851, () => r(s)); });
const base = 'http://localhost:8851';
const raw = new DatabaseSync(DB); raw.exec('PRAGMA busy_timeout = 5000');
let cookie = '';
async function call(method, path, json) {
  const h = { 'X-Requested-With': 'hk-admin' }; if (json !== undefined) h['Content-Type'] = 'application/json'; if (cookie) h.Cookie = cookie;
  const res = await fetch(base + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); cookie = v === '' ? '' : `${k}=${v}`; }
  let data = {}; try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
}
let r = await call('POST', '/api/auth/setup', { name: 'Liveness Admin', email: 'liveness-test@example.com', password: 'a-long-test-password-1' });
ok('setup: test admin created', r.status === 201, JSON.stringify(r.data));

const jobs = await import(new URL('./seo/jobs.js', import.meta.url).href);
const { queueScan, executeScan, ensureProgressing, refreshAudit, STALE_AUDIT_SUMMARY } = jobs;
const L = await import(new URL('./seo/limits.js', import.meta.url).href);
const { crawlWebsite } = await import(new URL('./seo/crawler.js', import.meta.url).href);
const { discoverSitemaps } = await import(new URL('./seo/sitemap.js', import.meta.url).href);

let n = 0;
/** A website row of its own (one active audit per website), scanning `target` — queueScan() takes any base URL, only the route pins it to the home site. */
const newSite = (label) => store.ensureWebsite(`${label}-${++n}.liveness.test`, `liveness ${label}`);
/** An audit in `status` that started `ageMs` ago — as if its worker had been stopped that long ago. */
async function active(site, target, status, ageMs) {
  const a = await store.createAudit(site.id, { baseUrl: target, status });
  raw.prepare('UPDATE seo_audits SET started_at = ? WHERE id = ?').run(new Date(Date.now() - ageMs).toISOString(), a.id);
  return store.getAudit(a.id);                          // as the poll routes see it: with the backdated start
}
const waitFor = async (fn, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(25)) if (await fn()) return true; return false; };

/* ═══ A. the execution budget and the recovery threshold ═══ */
{
  ok('A1. off Vercel nothing changes: no scan budget, and a stale audit is one older than staleAuditMs()', L.onServerless() === false && L.scanBudgetMs() === null && L.recoveryThresholdMs() === L.staleAuditMs());
  await withEnv(VERCEL, async () => {
    ok('A2. on Vercel (VERCEL is set) a scan has a 20-second budget, kept 5 s short for the database writes', L.onServerless() === true && L.scanBudgetMs() === 20_000 && L.crawlDeadlineReserveMs(20_000) === 5_000);
    ok('A3. …and an audit still queued/running after 60 s counts as abandoned (three budgets, never under the 60 s minimum)', L.recoveryThresholdMs() === 60_000 && L.recoveryThresholdMs() < L.staleAuditMs());
    await withEnv({ SEO_SCAN_BUDGET_MS: '100000' }, async () => ok('A4. a larger budget scales the threshold with it (3 x 100 s), and never beyond staleAuditMs()', L.scanBudgetMs() === 100_000 && L.recoveryThresholdMs() === Math.min(300_000, L.staleAuditMs())));
    await withEnv({ SEO_SCAN_BUDGET_MS: '99999999' }, async () => ok('A5. a huge budget cannot push the threshold past staleAuditMs()', L.recoveryThresholdMs() === L.staleAuditMs()));
    await withEnv({ SEO_STALE_AUDIT_MS: '300000' }, async () => ok('A6. an explicit SEO_STALE_AUDIT_MS always wins over the derived threshold', L.recoveryThresholdMs() === 300_000));
  });
  await withEnv({ SEO_SCAN_BUDGET_MS: '30000' }, async () => ok('A7. SEO_SCAN_BUDGET_MS sets a budget off Vercel too (opt-in), and that budget has a matching threshold', L.scanBudgetMs() === 30_000 && L.recoveryThresholdMs() === Math.min(90_000, L.staleAuditMs())));
  for (const v of ['200', '1']) await withEnv({ SEO_SCAN_BUDGET_MS: v }, async () => ok(`A8. a budget below 1 second (${v} ms) is raised to 1 second`, L.scanBudgetMs() === 1_000));
  for (const v of ['abc', '0', '-5', '']) await withEnv({ SEO_SCAN_BUDGET_MS: v }, async () => ok(`A9. an unusable SEO_SCAN_BUDGET_MS (${JSON.stringify(v)}) falls back to the default (none off Vercel)`, L.scanBudgetMs() === null));
  ok('A10. the four original crawl limits are untouched (the budget is not one of them)', Object.keys(L.crawlLimits()).sort().join() === 'crawlDelayMs,maxDepth,maxPages,requestTimeoutMs');
}

/* ═══ B. detached scheduling: kept where the process lives on, gone on Vercel ═══ */
{
  const fx = await fixture();
  const site = await newSite('detached');
  const before = detached;
  const a = await queueScan(store, site, { baseUrl: `${fx.base}/` });
  ok('B1. off Vercel queueScan() still schedules the detached worker (exactly as before)', !!a && a.status === 'queued' && detached === before + 1);
  ok('B2. …and that worker finishes the scan on its own, with nobody polling', await waitFor(async () => (await store.getAudit(a.id)).status === 'complete') && fx.home() >= 1);

  const fx2 = await fixture();
  const site2 = await newSite('vercel-queue');
  const b = await withEnv(VERCEL, () => queueScan(store, site2, { baseUrl: `${fx2.base}/` }));
  await sleep(500);
  ok('B3. on Vercel queueScan() schedules NO detached scan work', !!b && b.status === 'queued' && detached === before + 1);
  ok('B4. …so the audit is never claimed without a live request: still queued, nothing crawled', (await store.getAudit(b.id)).status === 'queued' && fx2.hits.length === 0, JSON.stringify([(await store.getAudit(b.id)).status, fx2.hits]));
  const done = await withEnv(VERCEL, () => ensureProgressing(store, b));
  ok('B5. a poll (ensureProgressing) runs it inline, inside that request, and the audit reaches complete', done.status === 'complete' && typeof done.score === 'number' && fx2.home() === 1 && detached === before + 1, JSON.stringify(done));
}

/* ═══ C. duplicate claims ═══ */
{
  const fx = await fixture();
  const site = await newSite('dup');
  const a = await withEnv(VERCEL, () => queueScan(store, site, { baseUrl: `${fx.base}/` }));
  const both = await withEnv(VERCEL, () => Promise.all([ensureProgressing(store, a), ensureProgressing(store, a)]));
  const final = await store.getAudit(a.id);
  ok('C1. two polls racing on one queued audit crawl it exactly once (the claim is a compare-and-swap)', fx.home() === 1 && final.status === 'complete' && both.every((x) => x.id === a.id), JSON.stringify([fx.home(), final.status]));
  ok('C2. a third claim is refused, and running executeScan again does nothing at all', (await store.claimAudit(a.id)) === false && (await executeScan(store, site.id, a.id, `${fx.base}/`)) === undefined && fx.home() === 1);
}

/* ═══ D. an audit whose worker is gone reaches an honest terminal state — and a live one is left alone ═══ */
{
  const fx = await fixture();
  // D1: a RUNNING audit older than the threshold (its function was stopped) is failed by a poll — no new scan needed
  const s1 = await newSite('orphan-running');
  const orphan = await active(s1, `${fx.base}/`, 'running', 61_000);
  logs.length = 0;
  const healed = await withEnv(VERCEL, () => ensureProgressing(store, orphan));
  ok('D1. on Vercel a running audit older than 60 s is failed by the poll: terminal, honest summary, a finish time', healed.status === 'failed' && healed.summary === STALE_AUDIT_SUMMARY && healed.finished_at != null && healed.score === null, JSON.stringify(healed));
  ok('D1. …it was NOT re-run (nothing crawled), and the recovery was logged', fx.hits.length === 0 && logs.some((l) => /recovered 1 stale audit/.test(l)));
  const fresh = await withEnv(VERCEL, () => queueScan(store, s1, { baseUrl: `${fx.base}/` }));
  ok('D2. …and the website is free again: a new scan is accepted, and it is the only active audit', !!fresh && fresh.id > orphan.id && (await store.activeAudit(s1.id)).id === fresh.id && (await store.listAudits(s1.id)).filter((x) => x.status === 'queued' || x.status === 'running').length === 1);

  // D3: a FRESH running audit — a live worker may be on it — is never falsely failed
  const s2 = await newSite('fresh-running');
  const live = await active(s2, `${fx.base}/`, 'running', 20_000);
  const kept = await withEnv(VERCEL, async () => [await ensureProgressing(store, live), await refreshAudit(store, live)]);
  ok('D3. a running audit younger than the threshold is left exactly as it is (running, no summary, nothing crawled)', kept.every((x) => x.status === 'running' && x.summary == null && x.finished_at == null) && fx.hits.length === 0);

  // D4: a queued audit nobody polled for over a minute was abandoned; a fresh one is still driven
  const s3 = await newSite('orphan-queued');
  const abandoned = await active(s3, `${fx.base}/`, 'queued', 61_000);
  const gone = await withEnv(VERCEL, () => ensureProgressing(store, abandoned));
  ok('D4. a queued audit older than 60 s is failed, not suddenly crawled', gone.status === 'failed' && gone.summary === STALE_AUDIT_SUMMARY && fx.hits.length === 0);
  const s4 = await newSite('fresh-queued');
  const young = await active(s4, `${fx.base}/`, 'queued', 5_000);
  const ran = await withEnv(VERCEL, () => ensureProgressing(store, young));
  ok('D5. a queued audit of a few seconds is still run by the poll', ran.status === 'complete' && fx.home() === 1);

  // D6: off Vercel the threshold is the old one
  const s5 = await newSite('node-running');
  const long = await active(s5, `${fx.base}/`, 'running', 5 * 60_000);
  const kept5 = await refreshAudit(store, long);
  ok('D6. off Vercel a running audit of five minutes is NOT stale (the long-running-server threshold is unchanged)', kept5.status === 'running');
  raw.prepare('UPDATE seo_audits SET started_at = ? WHERE id = ?').run(new Date(Date.now() - L.staleAuditMs() - 60_000).toISOString(), long.id);
  const failed5 = await refreshAudit(store, await store.getAudit(long.id));      // re-read, as a poll route would, so it sees the older start
  ok('D7. …and one older than staleAuditMs() is failed', failed5.status === 'failed' && failed5.summary === STALE_AUDIT_SUMMARY);

  // D8: an explicit SEO_STALE_AUDIT_MS wins on Vercel as well
  const s6 = await newSite('explicit');
  const mid = await active(s6, `${fx.base}/`, 'running', 120_000);
  await withEnv({ ...VERCEL, SEO_STALE_AUDIT_MS: '300000' }, async () => {
    ok('D8. with SEO_STALE_AUDIT_MS=300000 a 120 s old running audit is still alive', (await refreshAudit(store, mid)).status === 'running');
    raw.prepare('UPDATE seo_audits SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 301_000).toISOString(), mid.id);
    ok('D9. …and a 301 s old one is failed', (await refreshAudit(store, await store.getAudit(mid.id))).status === 'failed');
  });
  ok('D10. refreshAudit() never touches a finished audit, or nothing at all', (await refreshAudit(store, healed)).id === healed.id && (await refreshAudit(store, null)) === null && (await refreshAudit(store, undefined)) === undefined);
}

/* ═══ E. a recovered audit can neither be revived nor write: zombie protection survives the new recovery path ═══ */
{
  const fx = await fixture();
  const site = await newSite('zombie');
  const old = await active(site, `${fx.base}/`, 'running', 61_000);
  await withEnv(VERCEL, () => ensureProgressing(store, old));                       // recovered by a poll
  const next = await withEnv(VERCEL, () => queueScan(store, site, { baseUrl: `${fx.base}/` }));
  await withEnv(VERCEL, () => ensureProgressing(store, next));                      // the newer audit completes
  const hitsBefore = fx.hits.length;
  const late = await executeScan(store, site.id, old.id, `${fx.base}/`);          // the old worker, thawed much later
  const oldNow = await store.getAudit(old.id), nextNow = await store.getAudit(next.id);
  ok('E1. a thawed worker of a recovered audit does nothing: not claimed, nothing crawled, both audits keep their state', late === undefined && fx.hits.length === hitsBefore && oldNow.status === 'failed' && oldNow.summary === STALE_AUDIT_SUMMARY && nextNow.status === 'complete', JSON.stringify([oldNow.status, nextNow.status]));
  ok('E2. …and it can no longer finish the failed audit (finishAudit refuses a terminal audit)', (await store.finishAudit(old.id, { status: 'complete', score: 100, summary: 'zombie' })) === false && (await store.getAudit(old.id)).status === 'failed');

  // a worker that was ALREADY crawling when its audit got recovered writes nothing (the ownership check after the crawl)
  const slow = await fixture({ delay: 1200 });
  const site2 = await newSite('zombie-midflight');
  const mine = await store.createAuditIfNoneActive(site2.id, { baseUrl: `${slow.base}/`, pagesPlanned: 5 });
  const running = executeScan(store, site2.id, mine.id, `${slow.base}/`);
  await sleep(400);
  const recovered = await store.failStaleAudits(site2.id, { cutoff: new Date(Date.now() + 60_000).toISOString(), summary: STALE_AUDIT_SUMMARY });
  await running;
  const after = await store.getAudit(mine.id);
  ok('E3. a worker recovered while it crawls records nothing: the audit stays failed, no page and no issue was written', recovered === 1 && after.status === 'failed' && after.summary === STALE_AUDIT_SUMMARY && (await store.listPages(site2.id)).length === 0 && (await store.listIssues({ websiteId: site2.id, auditId: mine.id, limit: 10 })).length === 0, JSON.stringify(after));
}

/* ═══ F. the execution budget: enforced where this code controls the clock ═══ */
{
  // the crawler
  const slow = await fixture({ delay: 2500 });
  let t0 = Date.now();
  const cut = await crawlWebsite(`${slow.base}/`, { maxPages: 5, maxDepth: 1, requestTimeoutMs: 10_000, crawlDelayMs: 1, deadlineAt: Date.now() + 800 });
  ok('F1. with a deadline a slow page is cut off at it — the crawl returns in about the deadline, not after the 2.5 s the page needs — and reports timedOut', Date.now() - t0 < 1800 && cut.timedOut === true, `${Date.now() - t0} ms, timedOut ${cut.timedOut}`);
  t0 = Date.now();
  const past = await crawlWebsite(`${slow.base}/`, { maxPages: 5, maxDepth: 1, requestTimeoutMs: 10_000, crawlDelayMs: 1, deadlineAt: Date.now() - 1 });
  ok('F2. a deadline that has already passed starts no page request at all and returns quickly, timedOut', Date.now() - t0 < 1000 && past.timedOut === true && past.pages.length === 0 && !slow.hits.includes('/other'), `${Date.now() - t0} ms, pages ${past.pages.length}`);
  const fast = await fixture();
  const full = await crawlWebsite(`${fast.base}/`, { maxPages: 5, maxDepth: 1, requestTimeoutMs: 5_000, crawlDelayMs: 1, deadlineAt: Date.now() + 15_000 });
  ok('F3. a crawl that finishes inside its deadline is a normal, complete crawl (not timedOut, both pages)', full.timedOut === false && full.pages.length === 2 && full.pages.every((p) => p.statusCode === 200));
  const plain = await crawlWebsite(`${fast.base}/`, { maxPages: 5, maxDepth: 1, requestTimeoutMs: 5_000, crawlDelayMs: 1 });
  ok('F4. with no deadline the crawl is exactly as before: not timedOut, same pages, the original result fields all present', plain.timedOut === false && plain.pages.length === 2 && ['origin', 'allowedHost', 'robots', 'sitemaps', 'pages', 'links', 'errors', 'truncated'].every((k) => k in plain));

  // sitemap discovery
  const sm = await fixture({ sitemaps: ['/s1.xml', '/s2.xml', '/s3.xml'], sitemapDelay: 1500 });
  t0 = Date.now();
  const found = await discoverSitemaps(sm.base, ['/s1.xml', '/s2.xml', '/s3.xml'].map((p) => sm.base + p), { timeoutMs: 10_000, userAgent: 'test', allowedHost: sm.host, deadlineAt: Date.now() + 600 });
  ok('F5. sitemap discovery honours the deadline: three 1.5 s sitemaps, 0.6 s left — it returns in about a second, and the sitemaps it had no time for are reported as skipped', Date.now() - t0 < 1900 && found.some((x) => /time budget/.test(x.error || '')), `${Date.now() - t0} ms ${JSON.stringify(found.map((x) => x.error))}`);

  // executeScan under a budget
  const site = await newSite('budget-fail');
  const hugeSlow = await fixture({ delay: 4000 });
  const audit = await store.createAuditIfNoneActive(site.id, { baseUrl: `${hugeSlow.base}/`, pagesPlanned: 5 });
  t0 = Date.now();
  await withEnv({ SEO_SCAN_BUDGET_MS: '1500' }, () => executeScan(store, site.id, audit.id, `${hugeSlow.base}/`));
  const failedAudit = await store.getAudit(audit.id);
  ok('F6. a scan that cannot finish inside its budget ends in about the budget (not after the 4 s the page needs) …', Date.now() - t0 < 2800, `${Date.now() - t0} ms`);
  ok('F7. …as FAILED — never complete — with an honest summary and no score', failedAudit.status === 'failed' && failedAudit.score === null && /time budget/.test(failedAudit.summary || '') && failedAudit.finished_at != null, JSON.stringify(failedAudit));
  ok('F8. …and it recorded nothing from the cut-off crawl: no page, no issue, no link', (await store.listPages(site.id)).length === 0 && (await store.listIssues({ websiteId: site.id, auditId: audit.id, limit: 10 })).length === 0);

  const site2 = await newSite('budget-ok');
  const okFx = await fixture();
  const audit2 = await store.createAuditIfNoneActive(site2.id, { baseUrl: `${okFx.base}/`, pagesPlanned: 5 });
  await withEnv({ SEO_SCAN_BUDGET_MS: '20000' }, () => executeScan(store, site2.id, audit2.id, `${okFx.base}/`));
  const doneAudit = await store.getAudit(audit2.id);
  ok('F9. a scan that fits its budget completes normally: score, both pages, the usual summary', doneAudit.status === 'complete' && typeof doneAudit.score === 'number' && doneAudit.pages_crawled === 2 && /2 page\(s\) crawled/.test(doneAudit.summary), JSON.stringify(doneAudit));

  const site3 = await newSite('no-budget');
  const midFx = await fixture({ delay: 1500 });
  const audit3 = await store.createAuditIfNoneActive(site3.id, { baseUrl: `${midFx.base}/`, pagesPlanned: 5 });
  await executeScan(store, site3.id, audit3.id, `${midFx.base}/`);
  ok('F10. off Vercel with no budget set there is no deadline: a slow (1.5 s) page is crawled and the audit completes, as always', (await store.getAudit(audit3.id)).status === 'complete' && midFx.home() === 1);

  // PageSpeed may only use what is left of the budget
  const realFetch = globalThis.fetch; const psi = [];
  globalThis.fetch = (input, init) => {
    const u = String(input?.href ?? input);
    if (!u.includes('googleapis.com')) return realFetch(input, init);
    psi.push(u.replace(/key=[^&]*/, 'key=…'));
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));   // PageSpeed that never answers
  };
  try {
    const site4 = await newSite('psi');
    const psiFx = await fixture({ delay: 1200 });
    const audit4 = await store.createAuditIfNoneActive(site4.id, { baseUrl: `${psiFx.base}/`, pagesPlanned: 5 });
    t0 = Date.now();
    await withEnv({ SEO_SCAN_BUDGET_MS: '4000', PAGESPEED_API_KEY: 'test-key-not-real' }, () => executeScan(store, site4.id, audit4.id, `${psiFx.base}/`));
    const a4 = await store.getAudit(audit4.id);
    ok('F11. PageSpeed that never answers cannot carry a scan past its budget (the unbudgeted timeout would be 15 s): the scan ends inside it', Date.now() - t0 < 4600, `${Date.now() - t0} ms`);
    ok('F12. …and that is not a failure: the audit still completes, with PageSpeed reported unavailable, and at most one PageSpeed call was made', a4.status === 'complete' && a4.pagespeed?.available === false && psi.length <= 1, JSON.stringify([a4.status, a4.pagespeed, psi.length]));
  } finally { globalThis.fetch = realFetch; }
}

/* ═══ G. the routes: contracts the admin relies on, and no scan started by a read ═══ */
{
  const fx = await fixture();
  process.env.PUBLIC_URL = fx.base;                       // the home website IS the fixture, so the real route resolves and crawls it
  await withEnv(VERCEL, async () => {
    r = await call('POST', '/api/admin/seo/scan');
    const id = r.data.audit?.id;
    ok('G1. POST /scan answers 202 with the queued audit — the same contract the admin reads (id, status, base_url, started_at …)', r.status === 202 && r.data.ok === true && r.data.audit.status === 'queued' && ['id', 'website_id', 'started_at', 'status', 'base_url', 'pages_planned'].every((k) => k in r.data.audit), JSON.stringify(r.data));
    await sleep(400);
    ok('G2. on Vercel nothing runs after that answer: still queued, the site was not touched', (await store.getAudit(id)).status === 'queued' && fx.hits.length === 0);

    r = await call('GET', '/api/admin/seo/scans/latest');
    ok('G3. GET /scans/latest (the overview) reports the queued audit and starts NO crawl', r.status === 200 && r.data.audit.id === id && r.data.audit.status === 'queued' && fx.hits.length === 0, JSON.stringify(r.data));

    r = await call('POST', '/api/admin/seo/scan');
    ok('G4. a second POST /scan while one is queued is still a 409 naming that audit', r.status === 409 && r.data.audit?.id === id, JSON.stringify(r.data));

    r = await call('GET', `/api/admin/seo/scans/${id}`);
    const done = r.data.audit;
    ok('G5. GET /scans/:id (the poll the admin runs) does the work and answers with the completed audit', r.status === 200 && done.status === 'complete' && typeof done.score === 'number' && fx.home() === 1, JSON.stringify(r.data));
    ok('G6. …in the exact shape the admin reads: score, summary, pages, errors, duration, PageSpeed, diagnostics, issueCount and comparison', ['score', 'summary', 'pages_crawled', 'pages_planned', 'errors_count', 'duration_ms', 'pagespeed', 'specialist_diagnostics', 'started_at', 'finished_at', 'issueCount', 'comparison'].every((k) => k in done) && typeof done.issueCount === 'number', Object.keys(done).join());
    r = await call('GET', '/api/admin/seo/scans/latest');
    ok('G7. once complete, GET /scans/latest returns it with the same extras', r.data.audit.id === id && r.data.audit.status === 'complete' && typeof r.data.audit.issueCount === 'number' && 'comparison' in r.data.audit);

    // an orphan: a scan nobody can be working on any more
    r = await call('POST', '/api/admin/seo/scan');
    const orphanId = r.data.audit.id;
    raw.prepare('UPDATE seo_audits SET started_at = ?, status = ? WHERE id = ?').run(new Date(Date.now() - 120_000).toISOString(), 'running', orphanId);
    const hitsBefore = fx.hits.length;
    r = await call('GET', '/api/admin/seo/scans/latest');
    ok('G8. the overview ends an orphaned running audit honestly: failed, with the recovery summary — still without starting any crawl', r.status === 200 && r.data.audit.id === orphanId && r.data.audit.status === 'failed' && r.data.audit.summary === STALE_AUDIT_SUMMARY && fx.hits.length === hitsBefore, JSON.stringify(r.data));
    r = await call('POST', '/api/admin/seo/scan');
    ok('G9. …and the next POST /scan is accepted again (202), not blocked by a 409', r.status === 202 && r.data.audit.status === 'queued' && r.data.audit.id > orphanId, JSON.stringify(r.data));
    r = await call('GET', `/api/admin/seo/scans/${r.data.audit.id}`);
    ok('G10. a fresh scan after the recovery runs and completes through the poll', r.data.audit.status === 'complete');
    r = await call('GET', '/api/admin/seo/scans/999999');
    ok('G11. an unknown audit id is still a 404', r.status === 404);
  });

  // off Vercel the detached worker still finishes the scan with nobody polling, and a read still does not start one
  const fx2 = await fixture();
  process.env.PUBLIC_URL = fx2.base;
  r = await call('POST', '/api/admin/seo/scan');
  const nid = r.data.audit?.id;
  ok('G12. off Vercel POST /scan still answers 202 queued', r.status === 202 && r.data.audit?.status === 'queued', JSON.stringify(r.data));
  ok('G13. …and the detached worker completes it with no poll at all (long-running behaviour preserved)', await waitFor(async () => (await store.getAudit(nid)).status === 'complete') && fx2.home() === 1);
  r = await call('GET', '/api/admin/seo/scans/latest');
  ok('G14. GET /scans/latest shows the completed audit', r.data.audit.id === nid && r.data.audit.status === 'complete' && typeof r.data.audit.issueCount === 'number');
}

/* ═══ H. wiring, from source (this repository's established convention) ═══ */
{
  const jobsCode = strip(src('./seo/jobs.js')), routesCode = strip(src('./seo/routes.js'));
  const latest = routesCode.slice(routesCode.indexOf("router.get('/scans/latest'"), routesCode.indexOf("router.get('/scans/:id'"));
  const byId = routesCode.slice(routesCode.indexOf("router.get('/scans/:id'"), routesCode.indexOf("router.get('/pages'"));
  ok('H1. routes.js: /scans/latest only refreshes (never ensureProgressing); /scans/:id is the one that runs a scan', /refreshAudit\(store, await store\.latestAudit\(website\.id\)\)/.test(latest) && !/ensureProgressing/.test(latest) && /ensureProgressing\(store, found\)/.test(byId) && (routesCode.match(/ensureProgressing\(/g) || []).length === 1);
  ok('H2. jobs.js: the only setImmediate is inside `if (!onServerless())`', (jobsCode.match(/setImmediate\(/g) || []).length === 1 && /if \(!onServerless\(\)\) \{\s*setImmediate\(/.test(jobsCode));
  ok('H3. jobs.js: finishAudit is still called exactly twice and the only statuses written are still complete and failed (a timed-out scan goes through the existing failure path)', (jobsCode.match(/store\.finishAudit\(/g) || []).length === 2 && (jobsCode.match(/status: '[a-z]+'/g) || []).sort().join() === "status: 'complete',status: 'failed'" && /if \(crawl\.timedOut\) \{\s*throw Object\.assign\(/.test(jobsCode));
  ok('H4. jobs.js: the time-out check comes right after the ownership check and before the start-page decision and any write', jobsCode.indexOf('owned.status') < jobsCode.indexOf('crawl.timedOut') && jobsCode.indexOf('crawl.timedOut') < jobsCode.indexOf('startPageProblem(crawl)') && jobsCode.indexOf('crawl.timedOut') < jobsCode.indexOf('store.upsertPage('));
  ok('H5. no recovery code in the crawler, the sitemap reader or the routes (recovery stays in jobs.js)', ['./seo/crawler.js', './seo/sitemap.js', './seo/routes.js'].every((f) => !/failStaleAudits|recoveryThresholdMs|staleAuditMs|recoverStaleAudits|STALE_AUDIT/.test(src(f))));
  ok('H6. the admin and the database layer are untouched by this change (no new column, no new status, no claim time)', !/refreshAudit|scanBudget|timedOut/.test(src('./admin/admin.js')) && !/\bclaimed_at\b|\bheartbeat\b|\blease\b/i.test(src('./db.js')) && /UPDATE seo_audits SET status = 'running' WHERE id = \? AND status = 'queued'/.test(src('./db.js')));
}

appServer.close(); for (const s of servers) s.close();
raw.close(); await store.close();
globalThis.setImmediate = realSetImmediate; console.error = realError;
console.log(`\n${pass} passed, ${fail} failed`);
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { rmSync(DB + s, { force: true }); } catch { /* temp file, harmless */ } } });
setTimeout(() => process.exit(fail ? 1 : 0), 300);
