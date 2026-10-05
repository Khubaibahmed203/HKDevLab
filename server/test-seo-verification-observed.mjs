// Phase 4 Hardening #5 — a recommendation is only verified against a page the verifying audit actually OBSERVED.
// Before this step verifyAppliedRecommendations() said "resolved" whenever the recommendation's original issue was absent from
// the new audit — but the analyzer reports nothing for a page that was never fetched, timed out, answered with an error, was
// excluded by robots.txt, was no longer linked, or was cut off by the page limit. So an outage, a WAF block or a truncated crawl
// produced a false "Verified fixed".
// Now a verdict (resolved / still-present) is written only when the target page was fetched successfully, as HTML, BY THAT
// AUDIT (pages.last_audit_id === the audit, status_code 2xx, content_type text/html). Otherwise NOTHING is written: no verdict,
// no verified_audit_id, not even 'unknown' (which is final) — so a later audit that does observe the page can still verify it.
//
// Part 1 drives the real executeScan() (real crawl of a local site -> real upsertPage() -> real verification). Part 2 covers the
// store-level edge cases directly. Both run on SQLite and on the PostgreSQL adapter (pg-mem — which proves the SQL/data-access
// is identical across the supported test stores, NOT real PostgreSQL behavior). Everything is loopback; nothing hits the internet.
// Run: node server/test-seo-verification-observed.mjs
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + extra}`); };
setTimeout(() => { console.log('FAIL  watchdog: the whole suite exceeded 4 minutes'); process.exit(2); }, 240_000).unref();
for (const k of ['SEO_MAX_PAGES', 'SEO_MAX_DEPTH', 'SEO_HTML_MAX_BYTES', 'SEO_STALE_AUDIT_MS', 'PAGESPEED_API_KEY', 'DATABASE_URL']) delete process.env[k];
Object.assign(process.env, { SEO_CRAWL_DELAY_MS: '1', SEO_REQUEST_TIMEOUT_MS: '700', SMTP_HOST: '', NODE_ENV: 'development' });

const { createStore } = await import(new URL('./db.js', import.meta.url).href);
const { executeScan, verifyAppliedRecommendations } = await import(new URL('./seo/jobs.js', import.meta.url).href);
const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (fn, ms) => Promise.race([Promise.resolve().then(fn).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })), new Promise((r) => setTimeout(() => r({ hung: true }), ms))]);
const withEnv = async (vars, fn) => { const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; } try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };

/* ───────────── backends ───────────── */
const dbFiles = [], opened = [];
let storeN = 0;
async function makeSqlite() {
  const f = join(tmpdir(), `hk-verification-observed-${++storeN}.db`);
  for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true });
  dbFiles.push(f); process.env.SQLITE_PATH = f;
  const store = await createStore(); opened.push(store); return store;
}
async function makePgMem() { const { Pool } = newDb().adapters.createPg(); const store = await createStore({ pool: new Pool() }); opened.push(store); return store; }
const unverified = (r) => r != null && r.verified_status == null && r.verified_audit_id == null && r.verified_at == null;
const lifecycleIntact = (now, before) => now.status === 'applied' && now.applied_at === before.applied_at && now.reviewed_by === before.reviewed_by && now.reviewed_at === before.reviewed_at && now.proposed_value === before.proposed_value;

/* ═════════ Part 1: end to end — the real executeScan() over a local site whose target page changes between audits ═════════ */
async function endToEnd(label, store) {
  const T = (n) => `[${label}] ${n}`;
  await store.saveContent({ marker: 'content that verification must never touch' }, 'seed@x.test', 'seed');
  const contentBefore = JSON.stringify(await store.getContent());
  const sockets = new Set(), servers = [];

  async function makeWorld(name) {
    const st = { pTitle: 'Short', pMode: 'ok', homeLinksP: true, robotsDisallowP: false };
    const server = http.createServer((req, res) => {
      if (req.url === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(st.robotsDisallowP ? 'User-agent: *\nDisallow: /p\n' : 'User-agent: *\nAllow: /\n'); }
      if (req.url === '/sitemap.xml') { res.writeHead(404); return res.end(); }
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><html lang="en"><head><title>A perfectly good home page title</title><meta name="description" content="A home page description that is comfortably long enough to pass the length checks."></head><body><h1>Home</h1>${st.homeLinksP ? '<a href="/p">p</a>' : ''}</body></html>`); }
      if (req.url === '/p') {
        if (st.pMode === 'ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><html lang="en"><head><title>${st.pTitle}</title><meta name="description" content="A page description that is comfortably long enough to pass the length checks."></head><body><h1>P</h1></body></html>`); }
        if (st.pMode === '503') { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('maintenance'); }
        if (st.pMode === '403') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<html><body>Forbidden</body></html>'); }
        if (st.pMode === '404') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<html><body>Not found</body></html>'); }
        if (st.pMode === 'hang') return;   // never answers
      }
      res.writeHead(404); res.end();
    });
    server.on('connection', (s) => sockets.add(s));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const host = `127.0.0.1:${server.address().port}`;
    return { st, host, base: `http://${host}/`, site: await store.ensureWebsite(host, `${name}-${label}`) };
  }
  async function crawlAudit(w, { base = w.base, env = {} } = {}) {
    const audit = await store.createAuditIfNoneActive(w.site.id, { baseUrl: base, pagesPlanned: 100 });
    const run = await safe(() => withEnv(env, () => executeScan(store, w.site.id, audit.id, base)), 20000);
    return { audit: await store.getAudit(audit.id), run };
  }
  async function seedApplied(w) {
    const first = await crawlAudit(w);                                   // healthy: /p has a too-short title -> a title-length issue on it
    const page = (await store.listPages(w.site.id)).find((p) => p.url === `${w.base}p`);
    const issue = (await store.listIssues({ websiteId: w.site.id, auditId: first.audit.id })).find((i) => i.type === 'title-length' && i.page_id === page.id);
    const rec = await store.createRecommendation({ websiteId: w.site.id, issueId: issue.id, pageId: page.id, type: 'title', currentValue: 'Short', proposedValue: 'A Much Better Title For This Page', reasoning: 'r', aiProvider: 'anthropic', aiModel: 'm' });
    await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'a@x.test' });
    const applied = await store.setRecommendationStatus(rec.id, 'applied', { applied: true });
    await sleep(20);                                                      // the next audit must start strictly AFTER the fix was applied
    return { page, rec: applied, first };
  }
  const closedBase = async () => { const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise((r) => s.close(r)); return `http://127.0.0.1:${port}/`; };

  const SCENARIOS = [
    { name: 'CONTROL genuinely fixed', change: (st) => { st.pTitle = 'A Properly Sized Page Title Now'; }, expect: 'resolved' },
    { name: 'CONTROL still broken', change: () => {}, expect: 'still-present' },
    { name: '503 (text/plain)', change: (st) => { st.pMode = '503'; }, shape: 'current-nonsuccess', later: 'resolved' },
    { name: '403 (HTML, blocked)', change: (st) => { st.pMode = '403'; }, shape: 'current-nonsuccess', later: 'resolved' },
    { name: '404 (HTML)', change: (st) => { st.pMode = '404'; }, shape: 'current-nonsuccess', later: 'resolved' },
    { name: 'timeout / failed fetch', change: (st) => { st.pMode = 'hang'; }, shape: 'current-nonsuccess', later: 'resolved' },
    { name: 'robots.txt excludes the page', change: (st) => { st.robotsDisallowP = true; }, shape: 'older', later: 'resolved' },
    { name: 'no longer reachable through the crawl', change: (st) => { st.homeLinksP = false; }, shape: 'older', later: 'resolved' },
    { name: 'crawl page limit stops short of it', change: () => {}, env: { SEO_MAX_PAGES: '1' }, shape: 'older', later: 'resolved' },
    { name: 'entire site unreachable', change: () => {}, unreachable: true, shape: 'older', later: 'resolved' },
    { name: '503, then a later audit finds it still broken', change: (st) => { st.pMode = '503'; }, shape: 'current-nonsuccess', later: 'still-present', fixLater: false },
  ];

  for (const sc of SCENARIOS) {
    const w = await makeWorld('scn'), seeded = await seedApplied(w);
    ok(T(`${sc.name}: setup — the first (healthy) audit observed the page and the recommendation is applied and unverified`), seeded.page.last_audit_id === seeded.first.audit.id && seeded.page.status_code === 200 && seeded.rec.status === 'applied' && unverified(seeded.rec), JSON.stringify([seeded.page.last_audit_id, seeded.first.audit.id, seeded.rec.status]));
    sc.change(w.st);
    const v = await crawlAudit(w, { base: sc.unreachable ? await closedBase() : w.base, env: sc.env || {} });
    const rec = await store.getRecommendation(seeded.rec.id), pageNow = (await store.listPages(w.site.id)).find((p) => p.id === seeded.page.id);
    ok(T(`${sc.name}: the verifying audit itself completes normally and returns (verification can never break a scan)`), !v.run.hung && v.run.ok && v.audit.status === 'complete', JSON.stringify({ hung: v.run.hung, status: v.audit.status }));
    if (sc.expect) {
      ok(T(`${sc.name}: the page WAS observed (200, text/html, by this audit) -> verdict "${sc.expect}"`), pageNow.last_audit_id === v.audit.id && pageNow.status_code === 200 && rec.verified_status === sc.expect && rec.verified_audit_id === v.audit.id && rec.verified_at != null, JSON.stringify({ page: [pageNow.last_audit_id, pageNow.status_code], rec: [rec.verified_status, rec.verified_audit_id] }));
      ok(T(`${sc.name}: lifecycle and content untouched`), lifecycleIntact(rec, seeded.rec) && JSON.stringify(await store.getContent()) === contentBefore);
      continue;
    }
    const shapeOk = sc.shape === 'older' ? pageNow.last_audit_id === seeded.first.audit.id : (pageNow.last_audit_id === v.audit.id && !(pageNow.status_code >= 200 && pageNow.status_code < 300));
    ok(T(`${sc.name}: setup — the page's data really is "${sc.shape === 'older' ? 'last crawled by an OLDER audit' : 'recorded by THIS audit but not as a successful response'}" (status ${pageNow.status_code})`), shapeOk, JSON.stringify({ last_audit_id: pageNow.last_audit_id, status_code: pageNow.status_code, thisAudit: v.audit.id, firstAudit: seeded.first.audit.id }));
    ok(T(`${sc.name}: NO verification state is written — no verdict, no "unknown", no verified_audit_id, no verified_at`), unverified(rec), JSON.stringify([rec.verified_status, rec.verified_audit_id, rec.verified_at]));
    ok(T(`${sc.name}: the recommendation's lifecycle is unchanged (still applied, same applied_at/reviewer) and no content was touched`), lifecycleIntact(rec, seeded.rec) && JSON.stringify(await store.getContent()) === contentBefore);

    // the site recovers: a later audit that really observes the page can still verify it honestly
    w.st.pMode = 'ok'; w.st.robotsDisallowP = false; w.st.homeLinksP = true;
    if (sc.fixLater !== false) w.st.pTitle = 'A Properly Sized Page Title Now';
    await sleep(5);
    const later = await crawlAudit(w);
    const recLater = await store.getRecommendation(seeded.rec.id);
    ok(T(`${sc.name}: a LATER audit that observes the page verifies it — "${sc.later}", with that later audit's id`), recLater.verified_status === sc.later && recLater.verified_audit_id === later.audit.id && recLater.verified_at != null && lifecycleIntact(recLater, seeded.rec), JSON.stringify([recLater.verified_status, recLater.verified_audit_id, later.audit.id]));
  }
  for (const s of sockets) s.destroy(); for (const s of servers) s.close();
}

/* ═════════ Part 2: store-level cases (hand-built audits and page rows) ═════════ */
async function storeLevel(label, store) {
  const T = (n) => `[${label}] ${n}`;
  await store.saveContent({ marker: 'content that verification must never touch' }, 'seed@x.test', 'seed');
  const contentBefore = JSON.stringify(await store.getContent());
  let n = 0;
  const html = { statusCode: 200, contentType: 'text/html' };

  /** A website with one applied recommendation about page /<suffix>, whose issue (title-length) was found by an earlier audit. */
  async function fixture({ name = `unit-${label}-${++n}`, suffix = 'page', pageless = false, recPageId, apply = true } = {}) {
    const site = await store.ensureWebsite(`${name}.test`, name);
    const url = `https://${name}.test/${suffix}`;
    const a1 = await store.createAudit(site.id, { baseUrl: `https://${name}.test/` });
    const pageId = pageless ? null : await store.upsertPage({ websiteId: site.id, url, finalUrl: url, ...html, title: 'Old', auditId: a1.id });
    await store.createIssues(site.id, a1.id, [{ pageId, type: 'title-length', severity: 'warning', detail: 'x' }]);
    await store.finishAudit(a1.id, { score: 80, status: 'complete', summary: 'first', pagesCrawled: 1, errorsCount: 0, durationMs: 1 });
    const issue = (await store.listIssues({ websiteId: site.id, auditId: a1.id }))[0];
    let rec = await store.createRecommendation({ websiteId: site.id, issueId: issue.id, pageId: recPageId === undefined ? pageId : recPageId, type: 'title', currentValue: 'Old', proposedValue: 'New', reasoning: 'r', aiProvider: 'anthropic', aiModel: 'm' });
    if (apply) { await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'a@x.test' }); rec = await store.setRecommendationStatus(rec.id, 'applied', { applied: true }); await sleep(5); }
    return { site, url, pageId, issue, rec, a1, name };
  }
  /** A new complete audit; `observe` (status/content type) is what that audit recorded for the page, `issues` what it found. */
  async function audit2(f, { observe, issues = [], extraPage } = {}) {
    const a = await store.createAudit(f.site.id, { baseUrl: `https://${f.name}.test/` });
    if (observe) await store.upsertPage({ websiteId: f.site.id, url: f.url, finalUrl: f.url, auditId: a.id, ...observe });
    if (extraPage) await store.upsertPage({ websiteId: f.site.id, url: `https://${f.name}.test/other`, finalUrl: `https://${f.name}.test/other`, ...html, auditId: a.id });
    if (issues.length) await store.createIssues(f.site.id, a.id, issues);
    await store.finishAudit(a.id, { score: 90, status: 'complete', summary: 'second', pagesCrawled: 1, errorsCount: 0, durationMs: 1 });
    return a;
  }
  const verify = async (f, a, rec = f.rec) => { await verifyAppliedRecommendations(store, f.site.id, a.id); return store.getRecommendation(rec.id); };
  const stillThere = (f) => [{ pageId: f.pageId, type: 'title-length', severity: 'warning', detail: 'x' }];

  /* positive controls */
  for (const ct of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML']) {
    const f = await fixture(); const a = await audit2(f, { observe: { statusCode: 200, contentType: ct } }); const now = await verify(f, a);
    ok(T(`observed (200, "${ct}") and the issue is gone -> resolved, recording the verifying audit`), now.verified_status === 'resolved' && now.verified_audit_id === a.id && now.verified_at != null && lifecycleIntact(now, f.rec));
  }
  { const f = await fixture(); const a = await audit2(f, { observe: html, issues: stillThere(f) }); const now = await verify(f, a);
    ok(T('observed and the issue is still there -> still-present, recording the verifying audit'), now.verified_status === 'still-present' && now.verified_audit_id === a.id && now.verified_at != null); }
  { const bad = [];
    for (const sc of [200, 299]) { const f = await fixture(); const a = await audit2(f, { observe: { statusCode: sc, contentType: 'text/html' } }); if ((await verify(f, a)).verified_status !== 'resolved') bad.push(sc); }
    ok(T('the success range is exactly 2xx: both ends (200 and 299) count as observed'), bad.length === 0, bad.join()); }

  /* 11. an older observation */
  { const f = await fixture(); const a = await audit2(f, {});                              // the page row still says last_audit_id = the FIRST audit
    const page = await store.getPage(f.pageId); const now = await verify(f, a);
    ok(T('page exists but its last_audit_id belongs to an OLDER audit -> not observed: nothing written'), page.last_audit_id === f.a1.id && page.status_code === 200 && unverified(now) && lifecycleIntact(now, f.rec), JSON.stringify([page.last_audit_id, now.verified_status])); }

  /* 12. the current audit id but a non-successful or non-HTML response */
  { const offenders = [];
    for (const sc of [null, 100, 199, 300, 301, 304, 400, 403, 404, 410, 500, 503]) {
      const f = await fixture(); const a = await audit2(f, { observe: { statusCode: sc, contentType: 'text/html' } }); const page = await store.getPage(f.pageId); const now = await verify(f, a);
      if (!(page.last_audit_id === a.id && unverified(now))) offenders.push(`status ${sc}`);
    }
    ok(T('page recorded by THIS audit but with a non-2xx status (null/failed fetch, 1xx, 3xx, 4xx, 5xx) -> not observed: nothing written'), offenders.length === 0, offenders.join(', '));
    const nonHtml = [];
    for (const ct of ['application/pdf', 'text/plain', 'application/json', 'image/png', null, '']) {
      const f = await fixture(); const a = await audit2(f, { observe: { statusCode: 200, contentType: ct } }); const now = await verify(f, a);
      if (!unverified(now)) nonHtml.push(JSON.stringify(ct));
    }
    ok(T('a 200 that is not an HTML page (pdf, plain text, json, image, no content type) -> not observed: nothing written'), nonHtml.length === 0, nonHtml.join(', ')); }

  /* 13. no page / wrong page */
  { const f = await fixture({ pageless: true }); const a = await audit2(f, { extraPage: true }); const now = await verify(f, a);
    ok(T('null page_id: no page is invented — even though the audit observed another page successfully, nothing is verified'), f.rec.page_id === null && unverified(now) && lifecycleIntact(now, f.rec)); }
  { const f = await fixture({ recPageId: 999999 }); const a = await audit2(f, { observe: html }); const now = await verify(f, a);
    ok(T('a page_id that points at no page -> not observed: nothing written'), unverified(now)); }
  { const other = await store.ensureWebsite(`foreign-${label}.test`, 'foreign');
    const foreignUrl = `https://foreign-${label}.test/page`;
    const foreignPage = await store.upsertPage({ websiteId: other.id, url: foreignUrl, finalUrl: foreignUrl, ...html, auditId: 0 });
    const f = await fixture({ recPageId: foreignPage }); const a = await audit2(f, { observe: html });
    await store.upsertPage({ websiteId: other.id, url: foreignUrl, finalUrl: foreignUrl, ...html, auditId: a.id });   // the OTHER website's page carries this very audit id
    const now = await verify(f, a);
    ok(T('a page that belongs to a different website is never accepted as the observation'), unverified(now)); }

  /* existing behavior that must not change */
  { const f = await fixture({ pageless: true, apply: false });                            // an unresolvable source issue (and no page): the existing "unknown"
    const rec = await store.createRecommendation({ websiteId: f.site.id, issueId: 999999, pageId: null, type: 'title', currentValue: 'x', proposedValue: 'y', reasoning: 'z', aiProvider: 'anthropic', aiModel: 'm' });
    await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'a@x.test' }); await store.setRecommendationStatus(rec.id, 'applied', { applied: true }); await sleep(5);
    const a = await audit2(f, {}); const now = await verify(f, a, rec);
    ok(T('existing behavior kept: a source issue that cannot be resolved is still "unknown" (recorded with the audit id)'), now.verified_status === 'unknown' && now.verified_audit_id === a.id); }
  { const f = await fixture(); const rec = await store.createRecommendation({ websiteId: f.site.id, issueId: 999998, pageId: f.pageId, type: 'title', currentValue: 'x', proposedValue: 'y', reasoning: 'z', aiProvider: 'anthropic', aiModel: 'm' });
    await store.setRecommendationStatus(rec.id, 'approved', { reviewedBy: 'a@x.test' }); await store.setRecommendationStatus(rec.id, 'applied', { applied: true }); await sleep(5);
    const a = await audit2(f, {}); const now = await verify(f, a, rec);
    ok(T('…and that "unknown" comes from the unresolvable issue, not from the page: it is recorded even though the page was not observed'), now.verified_status === 'unknown'); }
  { const f = await fixture({ apply: false }); const a = await audit2(f, { observe: html });   // the verifying audit finished BEFORE the fix was applied
    await sleep(5); await store.setRecommendationStatus(f.rec.id, 'approved', { reviewedBy: 'a@x.test' }); const applied = await store.setRecommendationStatus(f.rec.id, 'applied', { applied: true });
    const now = await verify(f, a, applied);
    ok(T('existing behavior kept: an audit that started before the fix was applied never verifies it, even though it observed the page'), unverified(now)); }
  { const f = await fixture(); const a = await audit2(f, { observe: html }); const real = store.getIssue; store.getIssue = async () => { throw new Error('simulated verification failure'); };
    let threw = false; try { await verifyAppliedRecommendations(store, f.site.id, a.id); } catch { threw = true; } store.getIssue = real;
    const now = await store.getRecommendation(f.rec.id);
    ok(T('existing behavior kept: an unexpected error while verifying is swallowed and the recommendation is safely "unknown"'), !threw && now.verified_status === 'unknown'); }
  { const f = await fixture(); const a = await audit2(f, { observe: html }); const real = store.getPage; store.getPage = async () => { throw new Error('simulated page read failure'); };
    let threw = false; try { await verifyAppliedRecommendations(store, f.site.id, a.id); } catch { threw = true; } store.getPage = real;
    const now = await store.getRecommendation(f.rec.id);
    ok(T('a failure while reading the target page is treated as "not observed": nothing is thrown and NOTHING is written (not even "unknown")'), !threw && unverified(now)); }

  /* later audits, repeats, mixes */
  { const f = await fixture(); const a2 = await audit2(f, { observe: { statusCode: 503, contentType: 'text/plain' } }); const first = await verify(f, a2);
    await sleep(5); const a3 = await audit2(f, { observe: html }); const second = await verify(f, a3);
    ok(T('an unobserved audit leaves the recommendation open; the next audit that observes the page verifies it (with that audit\'s id)'), unverified(first) && second.verified_status === 'resolved' && second.verified_audit_id === a3.id); }
  { const f = await fixture(); const a2 = await audit2(f, { observe: html }); const one = await verify(f, a2);
    await sleep(5); const a3 = await audit2(f, { observe: html, issues: stillThere(f) }); const two = await verify(f, a3);
    ok(T('repeated verification never overwrites an already-recorded verdict (write-once is unchanged)'), one.verified_status === 'resolved' && two.verified_status === 'resolved' && two.verified_audit_id === a2.id && two.verified_at === one.verified_at); }
  { const f = await fixture(); const a2 = await audit2(f, {}); await verify(f, a2); await verify(f, a2); const now = await verify(f, a2);
    ok(T('repeated verification of an unobserved page keeps it untouched'), unverified(now)); }
  { const f1 = await fixture({ name: `mix-${label}`, suffix: 'one' }), f2 = await fixture({ name: `mix-${label}`, suffix: 'two' });
    const a = await audit2(f1, { observe: html });                                          // only page one is observed by this audit
    await verifyAppliedRecommendations(store, f1.site.id, a.id);
    const r1 = await store.getRecommendation(f1.rec.id), r2 = await store.getRecommendation(f2.rec.id);
    ok(T('one verification pass handles each recommendation on its own evidence: the observed page resolves, the unobserved one stays open'), r1.verified_status === 'resolved' && r1.verified_audit_id === a.id && unverified(r2)); }
  ok(T('none of the store-level verification touched site content'), JSON.stringify(await store.getContent()) === contentBefore);
}

for (const [label, make] of [['sqlite', makeSqlite], ['pg-mem', makePgMem]]) {
  const store = await make();
  if (label === 'pg-mem') ok('the second backend really is the PostgreSQL adapter (pg-mem)', store.kind === 'postgres');
  await endToEnd(label, store);
  await storeLevel(label, store);
}

/* ═════════ Part 3: scope and wiring proofs (source inspection, this repository's established convention) ═════════ */
{
  const strip = (code) => code.replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, '$1').replace(/(^|[ \t;{}])\/\/.*$/gm, '$1');
  const jobs = strip(src('./seo/jobs.js'));
  const body = jobs.slice(jobs.indexOf('export async function verifyAppliedRecommendations'));
  ok('S. the observation predicate demands ALL of: the page exists, it belongs to this website, last_audit_id is THIS audit, an integer 2xx status, and an HTML content type', /const observedByAudit = \(page, websiteId, auditId\) => !!page\s*&& page\.website_id === websiteId\s*&& page\.last_audit_id === auditId\s*&& Number\.isInteger\(page\.status_code\) && page\.status_code >= 200 && page\.status_code < 300\s*&& \/text\\\/html\/i\.test\(page\.content_type \|\| ''\);/.test(jobs));
  ok('S. a missing page_id never reaches a page lookup, and the guard is a plain skip (continue) — no write sits between the guard and the continue', /if \(rec\.page_id != null\) \{\s*try \{ target = await store\.getPage\(rec\.page_id\); \}/.test(body) && /if \(!observedByAudit\(target, websiteId, auditId\)\) continue;/.test(body));
  ok('S. the guard comes AFTER the existing unresolvable-issue "unknown" and BEFORE any verdict is computed or written', body.indexOf("verifiedStatus: 'unknown'") < body.indexOf('observedByAudit(target') && body.indexOf('observedByAudit(target') < body.indexOf('const stillPresent'));
  ok('S. there are still exactly three verification writes — unresolvable issue ("unknown"), the verdict, and the error fallback ("unknown") — none for an unobserved page', (body.match(/setRecommendationVerification\(/g) || []).length === 3);
  ok('S. no schema change: the verification columns are unchanged and nothing "observed" was added to db.js', /\['verified_status', 'TEXT'\], \['verified_at', 'TEXT'\], \['verified_audit_id', 'BIGINT'\]/.test(src('./db.js')) && !/observ/i.test(strip(src('./db.js'))));
  ok('S. out-of-scope code is untouched: the crawler, the analyzer, apply, routes, auth and the redirect/SSRF layer do not reference the observation rule', ['./seo/crawler.js', './seo/pageAnalyzer.js', './seo/analyzers.js', './seo/apply.js', './seo/routes.js', './seo/http.js', './seo/specialistIntegration.js', './auth.js'].every((f) => !/observedByAudit/.test(src(f))));
}

for (const s of opened) await s.close?.();
for (const f of dbFiles) for (const s of ['', '-wal', '-shm']) { try { rmSync(f + s, { force: true }); } catch { /* best effort */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
